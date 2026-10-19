// Referrals. External (OUT) send the patient to another organisation, INTERNAL to a unit here; both are
// tracked REQUESTED → ACCEPTED | DECLINED → SCHEDULED → ATTENDED → COMPLETED, or CANCELLED before they
// are attended. Recording the outcome closes the loop; a back-referral then opens an inbound (IN)
// referral for continued care here. Verified lab tests of the same patient can be attached.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';

export const REFERRAL_REASONS = [
  'Unavailability of Expertise', 'Unavailability of Equipment', 'Unavailability of Blood / Blood Products', 'Unavailability of Drugs',
  'Patient Request', 'Lack of Operating Facility', 'Complicated Cases', 'Other Reasons',
];
export const REFERRAL_OUTCOMES = ['Admitted & managed', 'Treated & discharged', 'Investigations done', 'Patient did not attend', 'Referred onward'];
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };

async function present(tx, context, rows) {
  const names = await userNameMap(tx, rows.map((r) => r.referredByUserId).filter(Boolean));
  const itemIds = [...new Set(rows.flatMap((r) => r.attachedLabItemIds))];
  const items = itemIds.length ? await tx.emrLabOrderItem.findMany({ where: { organizationId: context.organizationId, id: { in: itemIds } }, select: { id: true, testName: true, verifiedAt: true } }) : [];
  return rows.map((r) => ({
    id: r.id, patientId: r.patientId, patient: r.patient ? { ...r.patient, dateOfBirth: isoDay(r.patient.dateOfBirth) } : undefined, version: r.version,
    direction: r.direction, destination: r.destination, diagnosis: r.diagnosis, reason: r.reason, urgency: r.urgency, status: r.status,
    clinicalSummary: r.clinicalSummary, attachments: r.attachedLabItemIds.map((id) => items.find((i) => i.id === id)).filter(Boolean).map((i) => ({ labItemId: i.id, testName: i.testName, verifiedAt: i.verifiedAt })),
    referredByName: r.referredByName ?? (r.referredByUserId ? names.get(r.referredByUserId) ?? null : null), sourceReferralId: r.sourceReferralId,
    receivingClinician: r.receivingClinician, declineReason: r.declineReason, appointmentDate: isoDay(r.appointmentDate), attendedAt: r.attendedAt,
    feedback: r.outcome ? { outcome: r.outcome, note: r.outcomeNote, by: r.outcomeBy, at: r.outcomeAt, backReferral: r.backReferral } : null,
    createdAt: r.createdAt,
  }));
}
const fullReferral = async (tx, context, id) => (await present(tx, context, [await tx.emrReferral.findFirst({ where: { organizationId: context.organizationId, id }, include: { patient: patientSummary } })]))[0];
async function changed(tx, context, referral, action, data = {}) {
  await recordAudit(tx, context, { action: `referral.${action}`, resourceType: 'referral', resourceId: referral.id });
  await enqueueEvent(tx, context, { type: `referral.${action}`, aggregateType: 'patient', aggregateId: referral.patientId, data: { referralId: referral.id, direction: referral.direction, ...data } });
  return fullReferral(tx, context, referral.id);
}

export async function listReferrals(context, { direction, patientId, limit }) {
  return withTenant(context, async (tx) => {
    const rows = await tx.emrReferral.findMany({
      where: { organizationId: context.organizationId, ...(direction ? { direction: { in: direction } } : {}), ...(patientId ? { patientId } : {}) },
      include: { patient: patientSummary }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit,
    });
    await recordAudit(tx, context, { action: 'referral.listed', resourceType: 'referral' });
    return { items: await present(tx, context, rows) };
  });
}

export async function createReferral(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'referral.create', body: input }, async () => {
    const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
    const attached = [...new Set(input.attachedLabItemIds ?? [])];
    if (attached.length) {
      const verified = await tx.emrLabOrderItem.findMany({ where: { organizationId: context.organizationId, id: { in: attached }, status: 'VERIFIED', order: { patientId: patient.id } }, select: { id: true } });
      if (verified.length !== attached.length) throw new EmrError('VALIDATION_FAILED', { message: "Only this patient's verified lab results can be attached." });
    }
    const row = await tx.emrReferral.create({
      data: {
        organizationId: context.organizationId, patientId: patient.id, direction: input.direction, destination: input.destination, diagnosis: input.diagnosis,
        reason: input.reason, urgency: input.urgency, clinicalSummary: input.clinicalSummary ?? null, attachedLabItemIds: attached,
        referredByUserId: context.userId, updatedByUserId: context.userId,
      },
    });
    return { statusCode: 201, body: await changed(tx, context, row, 'created', { urgency: row.urgency }) };
  }));
}

// action → statuses it may start from, and the change it makes
const STEPS = {
  accept: { from: ['REQUESTED'], data: (input) => ({ status: 'ACCEPTED', ...(input.receivingClinician ? { receivingClinician: input.receivingClinician } : {}) }) },
  decline: { from: ['REQUESTED'], data: (input) => ({ status: 'DECLINED', declineReason: input.reason }) },
  schedule: { from: ['ACCEPTED', 'SCHEDULED'], data: (input) => ({ status: 'SCHEDULED', appointmentDate: new Date(`${input.appointmentDate}T00:00:00.000Z`) }) },
  attend: { from: ['SCHEDULED'], data: () => ({ status: 'ATTENDED', attendedAt: new Date() }) },
  cancel: { from: ['REQUESTED', 'ACCEPTED', 'SCHEDULED'], data: () => ({ status: 'CANCELLED' }) },
  outcome: {
    from: ['REQUESTED', 'ACCEPTED', 'SCHEDULED', 'ATTENDED'],
    data: (input) => ({ status: 'COMPLETED', outcome: input.outcome, outcomeNote: input.note, outcomeBy: input.by, outcomeAt: new Date(), backReferral: input.backReferral }),
  },
};
const PAST = { accept: 'accepted', decline: 'declined', schedule: 'scheduled', attend: 'attended', cancel: 'cancelled', outcome: 'completed' };

export async function advanceReferral(context, referralId, expectedVersion, action, input = {}) {
  const step = STEPS[action];
  return withTenant(context, async (tx) => {
    const referral = await tx.emrReferral.findFirst({ where: { organizationId: context.organizationId, id: referralId } });
    if (!referral) throw new EmrError('REFERRAL_NOT_FOUND');
    if (referral.direction === 'IN') throw new EmrError('INVALID_STATE', { message: 'Inbound referrals are received here; there is nothing to send on.' });
    if (!step.from.includes(referral.status)) throw new EmrError('INVALID_STATE', { message: `A ${referral.status.toLowerCase()} referral cannot be ${PAST[action]}.` });
    await updateVersioned(tx.emrReferral, {
      organizationId: context.organizationId, id: referral.id, expectedVersion, notFoundCode: 'REFERRAL_NOT_FOUND',
      data: { ...step.data(input), updatedByUserId: context.userId, updatedAt: new Date() },
    });
    if (action === 'outcome' && input.backReferral) {
      const back = await tx.emrReferral.create({
        data: {
          organizationId: context.organizationId, patientId: referral.patientId, direction: 'IN', destination: referral.destination, diagnosis: referral.diagnosis,
          reason: 'Other Reasons', urgency: 'ROUTINE', clinicalSummary: input.note, referredByName: input.by, sourceReferralId: referral.id, updatedByUserId: context.userId,
        },
      });
      await recordAudit(tx, context, { action: 'referral.back_referral_received', resourceType: 'referral', resourceId: back.id });
    }
    return changed(tx, context, referral, PAST[action], action === 'outcome' ? { outcome: input.outcome, backReferral: input.backReferral } : {});
  });
}
