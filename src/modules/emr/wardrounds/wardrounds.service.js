// Ward rounds for admitted patients, and the medication decisions taken on them.
//
//   start (one draft per admission; carries the last round's problems forward) ──► edit the draft
//   ──► sign (needs a progress note and a problem or plan item; builds the summary from what was
//   entered — nothing is invented) ──► amend (append-only notes; the signed content never changes,
//   the database refuses it).
//
// Medication changes act on the real prescription lines of the admission's visit:
//   STOPPED  the line is closed (outcome STOPPED); HELD  charting a dose is refused until RESTARTED;
//   a dose, frequency or route change (or a re-prescription) closes the line as REPLACED and raises a
//   new prescription with the same safety checks, which goes to the pharmacy for review;
//   STARTED  a new prescription from the formulary.
// Every decision is kept in emr_medication_changes with its reason and who made it.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { prescribeInTx } from '../pharmacy/prescriptions.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const rid = () => Math.random().toString(36).slice(2, 9);
const audited = (tx, context, action, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType: 'ward_round', resourceId, changedFields });
const notFound = () => new EmrError('NOT_FOUND', { message: 'Ward round not found.' });
const REPLACING = ['DOSE_INCREASED', 'DOSE_DECREASED', 'FREQUENCY_CHANGED', 'ROUTE_CHANGED', 'REPLACED'];
const EMPTY_CHECKLIST = {
  medicationReconciliationReviewed: false, drugAllergiesReviewed: false, antibioticsReviewed: false, anticoagulationReviewed: false, highRiskMedicinesReviewed: false,
  prnMedicinesReviewed: false, ivMedicationReviewed: false, monitoringRequired: false, changesCommunicated: false,
};
const EMPTY_COMMUNICATION = { patientUpdated: null, medicationChangesExplained: null, planDiscussed: null, caregiverUpdated: null, interpreterRequired: null };
const doseText = (dose, unit) => `${Number(dose)} ${unit}`;

async function admissionOf(tx, context, admissionId) {
  const a = await tx.emrAdmission.findFirst({ where: { ...org(context), id: admissionId } });
  if (!a) throw new EmrError('ADMISSION_NOT_FOUND');
  return a;
}
async function roundOf(tx, context, id) {
  const r = await tx.emrWardRound.findFirst({ where: { ...org(context), id } });
  if (!r) throw notFound();
  return r;
}
async function draftOf(tx, context, id) {
  const r = await roundOf(tx, context, id);
  if (r.status !== 'draft') throw new EmrError('INVALID_STATE', { message: 'This ward round has been signed; add an amendment instead.' });
  const a = await admissionOf(tx, context, r.admissionId);
  if (a.status !== 'ADMITTED') throw new EmrError('INVALID_STATE', { message: 'The patient is no longer admitted.' });
  return r;
}

// Summaries are part of the permanent record, so they show the hospital's local time, not UTC.
const TIME_ZONE = 'Africa/Lagos';
const localStamp = (date) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

/** Never invents clinical content: lines only from what the clinician entered. */
export function buildSummary(round, clinicianName) {
  const lines = [`Ward round — ${localStamp(round.roundAt)} — ${clinicianName}`];
  if (round.clinicalProgress) lines.push(`Progress: ${round.clinicalProgress}`);
  if (round.progressNote) lines.push(round.progressNote);
  if (round.problems.length) {
    lines.push('Problems:');
    for (const p of round.problems) lines.push(`- ${p.problem} (${p.status}): ${p.plan}`);
  }
  if (round.tasks.length) {
    lines.push('Plan:');
    for (const t of round.tasks) lines.push(`- [${t.type}] ${t.description}`);
  }
  return lines.join('\n');
}

// ---- reading ----------------------------------------------------------------------------------------
export async function listRounds(context, admissionId) {
  return withTenant(context, async (tx) => {
    const admission = await admissionOf(tx, context, admissionId);
    const [rounds, changes] = await Promise.all([
      tx.emrWardRound.findMany({ where: { ...org(context), admissionId }, orderBy: { roundAt: 'desc' } }),
      tx.emrMedicationChange.findMany({ where: { ...org(context), patientId: admission.patientId }, orderBy: { createdAt: 'desc' } }),
    ]);
    const amendments = rounds.length ? await tx.emrWardRoundAmendment.findMany({ where: { ...org(context), wardRoundId: { in: rounds.map((r) => r.id) } }, orderBy: { createdAt: 'asc' } }) : [];
    const names = await userNameMap(tx, [
      ...rounds.flatMap((r) => [r.clinicianUserId, r.signedByUserId, r.updatedByUserId, r.examinationRecordedByUserId]), ...amendments.map((a) => a.byUserId), ...changes.map((c) => c.clinicianUserId),
    ]);
    const who = (id) => (id ? names.get(id) ?? 'Former member' : undefined);
    await recordAudit(tx, context, { action: 'ward_rounds.viewed', resourceType: 'admission', resourceId: admissionId });
    return {
      rounds: rounds.map((r) => ({
        id: r.id, admissionId: r.admissionId, patientId: r.patientId, encounterId: r.encounterId, roundAt: r.roundAt, clinicianUserId: r.clinicianUserId, clinicianName: who(r.clinicianUserId),
        department: r.department, participants: r.participants, clinicalProgress: r.clinicalProgress ?? '', progressNote: r.progressNote, devices: r.devices, problems: r.problems, tasks: r.tasks,
        safetyChecklist: { ...EMPTY_CHECKLIST, ...r.safetyChecklist }, escalationPlan: r.escalationPlan, dischargeReadiness: { fit: null, barriers: [], ...r.dischargeReadiness },
        communication: { ...EMPTY_COMMUNICATION, ...r.communication },
        examination: r.examination ? { systems: r.examination, recordedBy: who(r.examinationRecordedByUserId), recordedAt: r.examinationRecordedAt } : null,
        summary: r.summary, status: r.status, signedBy: who(r.signedByUserId), signedAt: r.signedAt, updatedBy: who(r.updatedByUserId), updatedAt: r.updatedAt, createdAt: r.createdAt, version: r.version,
        amendments: amendments.filter((a) => a.wardRoundId === r.id).map((a) => ({ id: a.id, note: a.note, by: who(a.byUserId), at: a.createdAt })),
      })),
      medicationChanges: changes.map((c) => ({ ...c, clinicianName: who(c.clinicianUserId) })),
    };
  });
}

// ---- the round itself -------------------------------------------------------------------------------
export async function startRound(context, admissionId, { id } = {}) {
  return withTenant(context, async (tx) => {
    const admission = await admissionOf(tx, context, admissionId);
    if (admission.status !== 'ADMITTED') throw new EmrError('INVALID_STATE', { message: 'Ward rounds are for admitted patients.' });
    const previous = await tx.emrWardRound.findFirst({ where: { ...org(context), admissionId, status: { not: 'draft' } }, orderBy: { roundAt: 'desc' } });
    const [me] = (await userNameMap(tx, [context.userId])).values();
    try {
      const r = await tx.emrWardRound.create({
        data: {
          ...(id ? { id } : {}), ...org(context), admissionId, patientId: admission.patientId, encounterId: admission.encounterId, clinicianUserId: context.userId, department: admission.service ?? null,
          participants: [{ id: `p-${rid()}`, role: 'Consultant', name: me ?? 'Clinician' }],
          // the problems carry forward from the last signed round, to be updated
          problems: previous ? previous.problems.map((p) => ({ ...p, id: `prob-${rid()}` })) : [],
          safetyChecklist: EMPTY_CHECKLIST, dischargeReadiness: { fit: null, barriers: [] }, communication: EMPTY_COMMUNICATION,
        },
      });
      await audited(tx, context, 'ward_round.started', r.id);
      return { id: r.id };
    } catch (error) {
      throw uniqueViolation(error, { draft_key: 'INVALID_STATE' }) ?? error;
    }
  });
}

const DRAFT_FIELDS = ['participants', 'clinicalProgress', 'progressNote', 'devices', 'problems', 'tasks', 'safetyChecklist', 'escalationPlan', 'dischargeReadiness', 'communication'];
export async function updateDraft(context, id, expectedVersion, patch) {
  return withTenant(context, async (tx) => {
    const r = await draftOf(tx, context, id);
    if (r.version !== expectedVersion) throw new EmrError('VERSION_CONFLICT');
    const data = Object.fromEntries(DRAFT_FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]));
    if (patch.clinicalProgress === '') data.clinicalProgress = null;
    await updateVersioned(tx.emrWardRound, { organizationId: context.organizationId, id, expectedVersion, data: { ...data, updatedByUserId: context.userId, updatedAt: new Date() }, notFoundCode: 'NOT_FOUND' });
    await audited(tx, context, 'ward_round.updated', id, Object.keys(data));
    return { id };
  });
}
export async function recordExamination(context, id, { systems }) {
  return withTenant(context, async (tx) => {
    const r = await draftOf(tx, context, id);
    await updateVersioned(tx.emrWardRound, {
      organizationId: context.organizationId, id, expectedVersion: r.version, notFoundCode: 'NOT_FOUND',
      data: { examination: systems, examinationRecordedByUserId: context.userId, examinationRecordedAt: new Date(), updatedByUserId: context.userId, updatedAt: new Date() },
    });
    await audited(tx, context, 'ward_round.examination_recorded', id, [String(systems.length)]);
    return { id };
  });
}
export async function signRound(context, id) {
  return withTenant(context, async (tx) => {
    const r = await draftOf(tx, context, id);
    if (!r.progressNote.trim()) throw new EmrError('VALIDATION_FAILED', { message: 'Clinical progress note is required before signing.' });
    if (!r.problems.length && !r.tasks.length) throw new EmrError('VALIDATION_FAILED', { message: 'Add at least one problem/assessment or plan item before signing.' });
    const names = await userNameMap(tx, [r.clinicianUserId]);
    const summary = buildSummary(r, names.get(r.clinicianUserId) ?? 'Clinician');
    await updateVersioned(tx.emrWardRound, { organizationId: context.organizationId, id, expectedVersion: r.version, notFoundCode: 'NOT_FOUND', data: { status: 'signed', signedByUserId: context.userId, signedAt: new Date(), summary } });
    await audited(tx, context, 'ward_round.signed', id);
    return { id, status: 'signed' };
  });
}
export async function amendRound(context, id, { note }) {
  return withTenant(context, async (tx) => {
    const r = await roundOf(tx, context, id);
    if (r.status === 'draft') throw new EmrError('INVALID_STATE', { message: 'Only a signed ward round can be amended.' });
    await tx.emrWardRoundAmendment.create({ data: { ...org(context), wardRoundId: id, note, byUserId: context.userId } });
    if (r.status !== 'amended') await updateVersioned(tx.emrWardRound, { organizationId: context.organizationId, id, expectedVersion: r.version, notFoundCode: 'NOT_FOUND', data: { status: 'amended' } });
    await audited(tx, context, 'ward_round.amended', id);
    return { id, status: 'amended' };
  });
}

// ---- medication decisions ---------------------------------------------------------------------------
async function itemOf(tx, context, round, itemId) {
  const item = await tx.emrPrescriptionItem.findFirst({ where: { ...org(context), id: itemId }, include: { prescription: { select: { patientId: true, encounterId: true, status: true } } } });
  if (!item || item.prescription.patientId !== round.patientId) throw new EmrError('PRESCRIPTION_ITEM_NOT_FOUND');
  return item;
}
const recordChange = (tx, context, round, fields) => tx.emrMedicationChange.create({ data: { ...org(context), patientId: round.patientId, encounterId: round.encounterId, wardRoundId: round.id, clinicianUserId: context.userId, ...fields } });

export async function changeMedication(context, id, input) {
  return withTenant(context, async (tx) => {
    const round = await draftOf(tx, context, id);
    const item = await itemOf(tx, context, round, input.prescriptionItemId);
    const live = item.status === 'ACTIVE' && !['REJECTED', 'CANCELLED'].includes(item.prescription.status);
    const drug = `${item.drugName} ${item.strength}`.slice(0, 200);
    const base = {
      prescriptionItemId: item.id, drugName: drug, action: input.action, previousDose: doseText(item.dose, item.doseUnit), previousFrequency: item.frequency, previousRoute: item.route,
      reason: input.reason, clinicalNote: input.clinicalNote ?? null, monitoringRequired: input.monitoringRequired ?? null,
    };
    const close = (outcome) => tx.emrPrescriptionItem.updateMany({
      where: { ...org(context), id: item.id, status: 'ACTIVE' },
      data: { status: 'CANCELLED', closeOutcome: outcome, closeReason: input.reason.slice(0, 500), closedByUserId: context.userId, closedAt: new Date(), heldAt: null, heldReason: null, heldByUserId: null, version: { increment: 1 } },
    });
    let replacementPrescriptionId = null;
    if (input.action === 'RESTARTED') {
      if (!item.heldAt || !live) throw new EmrError('INVALID_STATE', { message: `${drug} is not on hold.` });
      await tx.emrPrescriptionItem.updateMany({ where: { ...org(context), id: item.id }, data: { heldAt: null, heldReason: null, heldByUserId: null, version: { increment: 1 } } });
    } else {
      if (!live) throw new EmrError('INVALID_STATE', { message: `${drug} is not an active medicine.` });
      if (input.action === 'HELD') {
        if (item.heldAt) throw new EmrError('INVALID_STATE', { message: `${drug} is already on hold.` });
        await tx.emrPrescriptionItem.updateMany({ where: { ...org(context), id: item.id }, data: { heldAt: new Date(), heldReason: input.reason.slice(0, 1000), heldByUserId: context.userId, version: { increment: 1 } } });
      } else if (input.action === 'STOPPED') {
        await close('STOPPED');
      } else if (REPLACING.includes(input.action)) {
        await close('REPLACED');
        const line = {
          drugCode: item.drugCode, dose: input.newDose ?? Number(item.dose), doseUnit: item.doseUnit, frequency: input.newFrequency ?? item.frequency, route: input.newRoute ?? item.route,
          ...(item.durationDays ? { durationDays: item.durationDays } : {}), ...(item.prn ? { prn: true } : {}), ...(item.prnReason ? { prnReason: item.prnReason } : {}), ...(item.instructions ? { instructions: item.instructions } : {}),
        };
        const rx = await prescribeInTx(tx, context, round.encounterId, { items: [line], notes: `Ward round: ${input.reason}`.slice(0, 1000), ...(input.overrides ? { overrides: input.overrides } : {}) });
        replacementPrescriptionId = rx.id;
        Object.assign(base, { newDose: doseText(line.dose, line.doseUnit), newFrequency: line.frequency, newRoute: line.route });
      } else {
        throw new EmrError('VALIDATION_FAILED', { message: 'Unknown medication change.' });
      }
    }
    const change = await recordChange(tx, context, round, { ...base, replacementPrescriptionId });
    await audited(tx, context, `ward_round.medication_${input.action.toLowerCase()}`, id, [item.drugCode]);
    return { id: change.id, replacementPrescriptionId };
  });
}
export async function startMedication(context, id, input) {
  return withTenant(context, async (tx) => {
    const round = await draftOf(tx, context, id);
    const { overrides, indication, ...line } = input;
    const rx = await prescribeInTx(tx, context, round.encounterId, { items: [line], notes: `Ward round${indication ? `: ${indication}` : ''}`.slice(0, 1000), ...(overrides ? { overrides } : {}) });
    const item = rx.items[0];
    const change = await recordChange(tx, context, round, {
      prescriptionItemId: item.id, replacementPrescriptionId: rx.id, drugName: `${item.drugName} ${item.strength}`.slice(0, 200), action: 'STARTED',
      newDose: doseText(item.dose, item.doseUnit), newFrequency: item.frequency, newRoute: item.route, reason: indication ?? 'New medication started during ward round',
    });
    await audited(tx, context, 'ward_round.medication_started', id, [item.drugCode]);
    return { id: change.id, prescriptionId: rx.id };
  });
}
