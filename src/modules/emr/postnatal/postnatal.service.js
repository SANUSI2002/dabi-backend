// Postnatal care: the WHO four-contact schedule after birth (within 24 h, day 3, days 7–14, 6 weeks).
// A visit is linked to the mother's delivery when there is one here; days postpartum then come from
// the delivery time, and the contact number from days postpartum. Newborn or maternal danger signs
// open an urgent Consultation visit for the mother (unless she already has an open visit), in the same
// transaction. "Due" lists mothers delivered here in the last 45 days whose next contact is not done.
import { withTenant } from '../core/db.js';
import { afterCursor, page } from '../core/cursor.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { markEnteredInError } from '../core/entries.js';
import { EmrError } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';
import { OPEN_STATUSES } from '../encounters/encounters.policy.js';
import { createForEncounter } from '../queue/queue.service.js';

const DAY = 86_400_000;
export const SCHEDULE = [{ contact: 1, day: 1 }, { contact: 2, day: 3 }, { contact: 3, day: 10 }, { contact: 4, day: 42 }];
export const contactFor = (days) => (days <= 2 ? 1 : days <= 5 ? 2 : days <= 20 ? 3 : 4);
const toDate = (iso) => new Date(`${iso}T00:00:00.000Z`);
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const daysBetween = (from, to) => Math.floor((Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) - Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) / DAY);
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };
const withPatient = (p) => (p ? { ...p, dateOfBirth: isoDay(p.dateOfBirth) } : undefined);

async function present(tx, rows) {
  const names = await userNameMap(tx, rows.flatMap((v) => [v.recordedByUserId, v.erroredByUserId]));
  const name = (id) => (id ? names.get(id) ?? null : null);
  return rows.map((v) => ({
    id: v.id, patientId: v.patientId, patient: withPatient(v.patient), deliveryId: v.deliveryId, visitDate: isoDay(v.visitDate),
    daysPostpartum: v.daysPostpartum, contact: v.contact, systolic: v.systolic, diastolic: v.diastolic, uterus: v.uterus, lochia: v.lochia,
    breast: v.breast, breastfeeding: v.breastfeeding, dangerSigns: v.dangerSigns, fpCounselled: v.fpCounselled, notes: v.notes,
    escalatedEncounterId: v.escalatedEncounterId, status: v.status, errorReason: v.errorReason, createdAt: v.createdAt,
    recordedByName: name(v.recordedByUserId), erroredByName: name(v.erroredByUserId),
  }));
}
const fullVisit = async (tx, context, id) =>
  (await present(tx, [await tx.emrPncVisit.findFirst({ where: { organizationId: context.organizationId, id }, include: { patient: patientSummary } })]))[0];

export async function listVisits(context, { patientId, cursor, limit }) {
  const after = afterCursor('visitDate', cursor, 'desc');
  return withTenant(context, async (tx) => {
    const rows = await tx.emrPncVisit.findMany({
      where: { organizationId: context.organizationId, ...(patientId ? { patientId } : {}), ...after },
      include: { patient: patientSummary }, orderBy: [{ visitDate: 'desc' }, { id: 'desc' }], take: limit + 1,
    });
    await recordAudit(tx, context, { action: 'pnc.listed', resourceType: 'pnc_visit' });
    const result = page(rows, limit, 'visitDate');
    return { ...result, items: await present(tx, result.items) };
  });
}

/** Mothers delivered here in the last 45 days (not deceased) whose next WHO contact is not yet done. */
export async function contactsDue(context, now = new Date()) {
  return withTenant(context, async (tx) => {
    const deliveries = await tx.emrDelivery.findMany({
      where: { organizationId: context.organizationId, status: 'ACTIVE', motherStatus: { not: 'DIED' }, deliveredAt: { gte: new Date(now.getTime() - 45 * DAY) } },
      include: { patient: patientSummary }, orderBy: { deliveredAt: 'asc' }, take: 500,
    });
    const visits = deliveries.length ? await tx.emrPncVisit.findMany({
      where: { organizationId: context.organizationId, status: 'ACTIVE', patientId: { in: [...new Set(deliveries.map((d) => d.patientId))] }, visitDate: { gte: new Date(now.getTime() - 50 * DAY) } },
      select: { patientId: true, deliveryId: true, contact: true },
    }) : [];
    await recordAudit(tx, context, { action: 'pnc.due_listed', resourceType: 'pnc_visit' });
    return {
      items: deliveries.flatMap((d) => {
        const done = new Set(visits.filter((v) => v.patientId === d.patientId && (!v.deliveryId || v.deliveryId === d.id)).map((v) => v.contact));
        const next = SCHEDULE.find((s) => !done.has(s.contact));
        if (!next) return [];
        const daysPostpartum = daysBetween(d.deliveredAt, now);
        const overdueDays = daysPostpartum - next.day;
        return [{
          deliveryId: d.id, patientId: d.patientId, patient: withPatient(d.patient), deliveredAt: d.deliveredAt, deliveryMode: d.mode, babyStatus: d.babyStatus,
          daysPostpartum, nextContact: next.contact, overdueDays, status: overdueDays > 3 ? 'OVERDUE' : overdueDays >= -1 ? 'DUE' : 'UPCOMING',
        }];
      }),
    };
  });
}

export async function recordVisit(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'pnc.record', body: input }, async () => {
    const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true, sex: true });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
    if (patient.sex !== 'FEMALE') throw new EmrError('VALIDATION_FAILED', { message: 'A postnatal visit is recorded on the mother.' });
    const visitDate = toDate(input.visitDate);
    if (visitDate.getTime() > Date.now()) throw new EmrError('VALIDATION_FAILED', { message: 'The visit date cannot be in the future.' });

    let daysPostpartum = input.daysPostpartum;
    if (input.deliveryId) {
      const delivery = await tx.emrDelivery.findFirst({ where: { organizationId: context.organizationId, id: input.deliveryId, patientId: patient.id, status: 'ACTIVE' } });
      if (!delivery) throw new EmrError('VALIDATION_FAILED', { message: 'That delivery is not on record for this mother.' });
      daysPostpartum = daysBetween(delivery.deliveredAt, visitDate);
      if (daysPostpartum < 0) throw new EmrError('VALIDATION_FAILED', { message: 'The visit is before the delivery.' });
    }
    if (daysPostpartum === undefined) throw new EmrError('VALIDATION_FAILED', { message: 'Give the days since delivery: there is no delivery on record here to work it out from.' });
    if (daysPostpartum > 60) throw new EmrError('VALIDATION_FAILED', { message: `That is ${daysPostpartum} days after delivery — beyond the postnatal period.` });

    // Danger signs send her to Consultation as urgent, unless she is already in an open visit.
    let escalatedEncounterId = null;
    if (input.dangerSigns.length) {
      const open = await tx.emrEncounter.findFirst({ where: { organizationId: context.organizationId, patientId: patient.id, status: { in: OPEN_STATUSES } }, select: { id: true } });
      if (open) escalatedEncounterId = open.id;
      else {
        const reason = `PNC danger signs: ${input.dangerSigns.join(', ')}`.slice(0, 500);
        const encounter = await tx.emrEncounter.create({
          data: { organizationId: context.organizationId, patientId: patient.id, class: 'OUTPATIENT', reason, createdByUserId: context.userId },
          select: { id: true, patientId: true },
        });
        await createForEncounter(tx, context, encounter, { station: 'Consultation', priority: 'URGENT', complaint: reason });
        await recordAudit(tx, context, { action: 'encounter.created', resourceType: 'encounter', resourceId: encounter.id });
        await enqueueEvent(tx, context, { type: 'encounter.created', aggregateType: 'encounter', aggregateId: encounter.id, data: { patientId: patient.id, class: 'OUTPATIENT' } });
        escalatedEncounterId = encounter.id;
      }
    }
    const row = await tx.emrPncVisit.create({
      data: {
        organizationId: context.organizationId, patientId: patient.id, deliveryId: input.deliveryId ?? null, visitDate, daysPostpartum, contact: contactFor(daysPostpartum),
        systolic: input.systolic ?? null, diastolic: input.diastolic ?? null, uterus: input.uterus, lochia: input.lochia, breast: input.breast,
        breastfeeding: input.breastfeeding, dangerSigns: input.dangerSigns, fpCounselled: input.fpCounselled, notes: input.notes ?? null,
        escalatedEncounterId, recordedByUserId: context.userId,
      },
    });
    await recordAudit(tx, context, { action: 'pnc.recorded', resourceType: 'pnc_visit', resourceId: row.id });
    await enqueueEvent(tx, context, { type: 'pnc.recorded', aggregateType: 'patient', aggregateId: patient.id, data: { visitId: row.id, escalatedEncounterId } });
    return { statusCode: 201, body: await fullVisit(tx, context, row.id) };
  }));
}

export async function markVisitEnteredInError(context, visitId, { reason }) {
  return withTenant(context, async (tx) => {
    const row = await markEnteredInError(tx.emrPncVisit, {
      where: { organizationId: context.organizationId, id: visitId }, userId: context.userId, reason, notFoundCode: 'PNC_VISIT_NOT_FOUND', label: 'visit',
    });
    await recordAudit(tx, context, { action: 'pnc.entered_in_error', resourceType: 'pnc_visit', resourceId: row.id });
    await enqueueEvent(tx, context, { type: 'pnc.entered_in_error', aggregateType: 'patient', aggregateId: row.patientId, data: { visitId: row.id } });
    return fullVisit(tx, context, row.id);
  });
}
