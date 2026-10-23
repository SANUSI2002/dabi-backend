// Labour & delivery and the statutory birth register.
//
// A delivery is recorded per baby. If the mother has an ongoing antenatal enrolment, the delivery is
// linked to it and the pregnancy is closed as DELIVERED in the same transaction; gestational age then
// comes from the enrolment's LMP instead of the form. "Conducted by" must be an active colleague who
// may record deliveries. A wrong delivery is marked entered-in-error (only before its birth is
// notified), which reopens the pregnancy it closed.
//
// Birth register: a live birth is notified once (facility notification number BN-<year>-<000001>
// from a per-tenant counter, so no gaps or duplicates), then registered — recording the civil
// registration number the National Population Commission issued, never inventing one — and finally
// the certificate's issue is recorded. Every step is audited and emits an identifiers-only event.
import { withTenant } from '../core/db.js';
import { afterCursor, page } from '../core/cursor.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { markEnteredInError } from '../core/entries.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { activeMemberWithPermission } from '../core/membership.js';
import { nextSequence } from '../core/sequence.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';
import { weeksSince } from '../antenatal/antenatal.service.js';

const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const withPatient = (row) => (row.patient ? { ...row.patient, dateOfBirth: isoDay(row.patient.dateOfBirth) } : undefined);
export const notificationNumber = (year, value) => `BN-${year}-${String(value).padStart(6, '0')}`;

const DELIVERY_PEOPLE = ['conductedByUserId', 'recordedByUserId', 'erroredByUserId'];
const REGISTRATION_PEOPLE = ['notifiedByUserId', 'registeredByUserId', 'certificateIssuedByUserId'];
const named = (row, fields, name) => Object.fromEntries(fields.map((f) => [f.replace(/UserId$/, 'Name'), name(row[f])]));

function registrationView(r, name) {
  return {
    id: r.id, deliveryId: r.deliveryId, patientId: r.patientId, version: r.version, status: r.status,
    babyName: r.babyName, fatherName: r.fatherName, informantName: r.informantName, informantRelation: r.informantRelation,
    notificationNumber: r.notificationNumber, registrationNumber: r.registrationNumber,
    notifiedAt: r.notifiedAt, registeredAt: r.registeredAt, certificateIssuedAt: r.certificateIssuedAt, ...named(r, REGISTRATION_PEOPLE, name),
  };
}
function deliveryView(d, name) {
  return {
    id: d.id, patientId: d.patientId, pregnancyId: d.pregnancyId, status: d.status, patient: withPatient(d),
    bookingStatus: d.bookingStatus, deliveredAt: d.deliveredAt, gestationalWeeks: d.gestationalWeeks, mode: d.mode,
    motherStatus: d.motherStatus, bloodLossMl: d.bloodLossMl, complications: d.complications, notes: d.notes, nhmisIndicators: d.nhmisIndicators,
    babySex: d.babySex, babyStatus: d.babyStatus, birthWeightKg: Number(d.birthWeightKg), apgar1: d.apgar1, apgar5: d.apgar5,
    breastfedWithinHour: d.breastfedWithinHour, createdAt: d.createdAt, errorReason: d.errorReason, ...named(d, DELIVERY_PEOPLE, name),
    registration: d.registration ? registrationView(d.registration, name) : null,
  };
}

async function presentDeliveries(tx, rows) {
  const names = await userNameMap(tx, rows.flatMap((d) => [...DELIVERY_PEOPLE.map((f) => d[f]), ...(d.registration ? REGISTRATION_PEOPLE.map((f) => d.registration[f]) : [])]));
  const name = (id) => (id ? names.get(id) ?? null : null);
  return rows.map((d) => deliveryView(d, name));
}

const fullDelivery = async (tx, context, id) => {
  const row = await tx.emrDelivery.findFirst({ where: { organizationId: context.organizationId, id }, include: { patient: patientSummary, registration: true } });
  if (!row) throw new EmrError('DELIVERY_NOT_FOUND');
  return (await presentDeliveries(tx, [row]))[0];
};

async function audited(tx, context, { action, resourceType, resourceId, patientId, data }) {
  await recordAudit(tx, context, { action, resourceType, resourceId });
  await enqueueEvent(tx, context, { type: action, aggregateType: 'patient', aggregateId: patientId, data });
}

// ---------------------------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------------------------
export async function listDeliveries(context, { patientId, cursor, limit }) {
  const after = afterCursor('deliveredAt', cursor, 'desc');
  return withTenant(context, async (tx) => {
    const rows = await tx.emrDelivery.findMany({
      where: { organizationId: context.organizationId, ...(patientId ? { patientId } : {}), ...after },
      include: { patient: patientSummary, registration: true },
      orderBy: [{ deliveredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    await recordAudit(tx, context, { action: 'delivery.listed', resourceType: 'delivery' });
    const result = page(rows, limit, 'deliveredAt');
    return { ...result, items: await presentDeliveries(tx, result.items) };
  });
}

export async function recordDelivery(context, input, { idempotencyKey } = {}) {
  if (!(await activeMemberWithPermission(context.organizationId, input.conductedByUserId, 'delivery.record'))) {
    throw new EmrError('VALIDATION_FAILED', { message: 'The person who conducted the delivery must be an active clinician in this organization.' });
  }
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'delivery.record', body: input }, async () => {
    const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true, sex: true });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
    if (patient.sex !== 'FEMALE') throw new EmrError('VALIDATION_FAILED', { message: 'A delivery is recorded on the mother. Check the sex recorded at registration.' });
    const deliveredAt = new Date(input.deliveredAt);
    if (deliveredAt.getTime() > Date.now() + 5 * 60_000) throw new EmrError('VALIDATION_FAILED', { message: 'The delivery time cannot be in the future.' });

    // Her ongoing antenatal enrolment, if any, is closed by this delivery and gives the gestational age.
    const pregnancy = await tx.emrPregnancy.findFirst({ where: { organizationId: context.organizationId, patientId: patient.id, status: 'ACTIVE' } });
    const gestationalWeeks = pregnancy ? weeksSince(pregnancy.lmp, deliveredAt) : input.gestationalWeeks;
    if (gestationalWeeks === undefined) throw new EmrError('VALIDATION_FAILED', { message: 'Give the gestational age: she has no ongoing antenatal enrolment here to work it out from.' });
    if (gestationalWeeks < 20 || gestationalWeeks > 45) {
      throw new EmrError('VALIDATION_FAILED', { message: pregnancy ? `Her antenatal LMP makes this ${gestationalWeeks} weeks. Check the delivery time or the enrolment.` : 'Gestational age must be between 20 and 45 weeks.' });
    }
    const alive = input.babyStatus === 'ALIVE';
    const row = await tx.emrDelivery.create({
      data: {
        organizationId: context.organizationId, patientId: patient.id, pregnancyId: pregnancy?.id ?? null,
        bookingStatus: input.bookingStatus, deliveredAt, gestationalWeeks, mode: input.mode, motherStatus: input.motherStatus,
        bloodLossMl: input.bloodLossMl, complications: input.complications ?? null, notes: input.notes ?? null, nhmisIndicators: input.nhmisIndicators,
        babySex: input.babySex, babyStatus: input.babyStatus, birthWeightKg: input.birthWeightKg,
        apgar1: alive ? input.apgar1 : null, apgar5: alive ? input.apgar5 : null, breastfedWithinHour: alive && input.breastfedWithinHour,
        conductedByUserId: input.conductedByUserId, recordedByUserId: context.userId,
      },
    });
    if (pregnancy) {
      await tx.emrPregnancy.updateMany({
        where: { organizationId: context.organizationId, id: pregnancy.id, status: 'ACTIVE' },
        data: { status: 'DELIVERED', closedAt: new Date(), closedByUserId: context.userId, closureNote: null, version: { increment: 1 } },
      });
      await recordAudit(tx, context, { action: 'pregnancy.closed', resourceType: 'pregnancy', resourceId: pregnancy.id });
    }
    await audited(tx, context, { action: 'delivery.recorded', resourceType: 'delivery', resourceId: row.id, patientId: patient.id, data: { deliveryId: row.id, pregnancyId: pregnancy?.id ?? null } });
    return { statusCode: 201, body: await fullDelivery(tx, context, row.id) };
  }));
}

export async function markDeliveryEnteredInError(context, deliveryId, { reason }) {
  return withTenant(context, async (tx) => {
    const notified = await tx.emrBirthRegistration.findFirst({ where: { organizationId: context.organizationId, deliveryId }, select: { id: true } });
    if (notified) throw new EmrError('INVALID_STATE', { message: 'This birth has been notified. Corrections now go through the birth register, not the delivery record.' });
    const row = await markEnteredInError(tx.emrDelivery, {
      where: { organizationId: context.organizationId, id: deliveryId }, userId: context.userId, reason, notFoundCode: 'DELIVERY_NOT_FOUND', label: 'delivery',
    });
    // Reopen the pregnancy this delivery closed — unless it was closed another way since, or she has another ongoing one.
    if (row.pregnancyId) {
      const otherActive = await tx.emrPregnancy.findFirst({ where: { organizationId: context.organizationId, patientId: row.patientId, status: 'ACTIVE' }, select: { id: true } });
      const stillDelivered = await tx.emrDelivery.findFirst({ where: { organizationId: context.organizationId, pregnancyId: row.pregnancyId, status: 'ACTIVE' }, select: { id: true } });
      if (!otherActive && !stillDelivered) {
        const { count } = await tx.emrPregnancy.updateMany({
          where: { organizationId: context.organizationId, id: row.pregnancyId, status: 'DELIVERED' },
          data: { status: 'ACTIVE', closedAt: null, closedByUserId: null, closureNote: null, version: { increment: 1 } },
        });
        if (count) await recordAudit(tx, context, { action: 'pregnancy.reopened', resourceType: 'pregnancy', resourceId: row.pregnancyId });
      }
    }
    await audited(tx, context, { action: 'delivery.entered_in_error', resourceType: 'delivery', resourceId: row.id, patientId: row.patientId, data: { deliveryId: row.id } });
    return fullDelivery(tx, context, row.id);
  });
}

// ---------------------------------------------------------------------------------------------
// Birth register
// ---------------------------------------------------------------------------------------------
async function presentRegister(tx, rows) {
  const names = await userNameMap(tx, rows.flatMap((r) => REGISTRATION_PEOPLE.map((f) => r[f])));
  const name = (id) => (id ? names.get(id) ?? null : null);
  return rows.map((r) => ({
    ...registrationView(r, name),
    patient: withPatient(r),
    bornAt: r.delivery.deliveredAt, babySex: r.delivery.babySex, birthWeightKg: Number(r.delivery.birthWeightKg), deliveryMode: r.delivery.mode,
  }));
}
const registerInclude = { patient: patientSummary, delivery: { select: { deliveredAt: true, babySex: true, birthWeightKg: true, mode: true } } };
const fullRegistration = async (tx, context, id) =>
  (await presentRegister(tx, [await tx.emrBirthRegistration.findFirst({ where: { organizationId: context.organizationId, id }, include: registerInclude })]))[0];

export async function listBirthRegister(context, { status, cursor, limit }) {
  const after = afterCursor('notifiedAt', cursor, 'desc');
  return withTenant(context, async (tx) => {
    const rows = await tx.emrBirthRegistration.findMany({
      where: { organizationId: context.organizationId, ...(status ? { status: { in: status } } : {}), ...after },
      include: registerInclude,
      orderBy: [{ notifiedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    await recordAudit(tx, context, { action: 'birth_register.listed', resourceType: 'birth_registration' });
    const result = page(rows, limit, 'notifiedAt');
    return { ...result, items: await presentRegister(tx, result.items) };
  });
}

export async function notifyBirth(context, deliveryId, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'birth.notify', body: { deliveryId, ...input } }, async () => {
    const delivery = await tx.emrDelivery.findFirst({ where: { organizationId: context.organizationId, id: deliveryId } });
    if (!delivery) throw new EmrError('DELIVERY_NOT_FOUND');
    if (delivery.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: 'This delivery was entered in error.' });
    if (delivery.babyStatus !== 'ALIVE') throw new EmrError('INVALID_STATE', { message: 'Only a live birth is notified to the birth register.' });
    const year = new Date().getUTCFullYear();
    let row;
    try {
      row = await tx.emrBirthRegistration.create({
        data: {
          organizationId: context.organizationId, deliveryId: delivery.id, patientId: delivery.patientId,
          babyName: input.babyName ?? null, fatherName: input.fatherName ?? null, informantName: input.informantName, informantRelation: input.informantRelation,
          notificationNumber: notificationNumber(year, await nextSequence(tx, context, `birth_notification_${year}`)), notifiedByUserId: context.userId,
        },
      });
    } catch (error) {
      throw uniqueViolation(error, { delivery: 'BIRTH_ALREADY_NOTIFIED' }) ?? error;
    }
    await audited(tx, context, { action: 'birth.notified', resourceType: 'birth_registration', resourceId: row.id, patientId: row.patientId, data: { registrationId: row.id, deliveryId: row.deliveryId } });
    return { statusCode: 201, body: await fullRegistration(tx, context, row.id) };
  }));
}

async function loadRegistration(tx, context, id, status, message) {
  const row = await tx.emrBirthRegistration.findFirst({ where: { organizationId: context.organizationId, id } });
  if (!row) throw new EmrError('BIRTH_REGISTRATION_NOT_FOUND');
  if (row.status !== status) throw new EmrError('INVALID_STATE', { message });
  return row;
}

export async function registerBirth(context, id, expectedVersion, { registrationNumber, babyName }) {
  return withTenant(context, async (tx) => {
    const row = await loadRegistration(tx, context, id, 'NOTIFIED', 'Only a notified birth can be registered.');
    try {
      await updateVersioned(tx.emrBirthRegistration, {
        organizationId: context.organizationId, id, expectedVersion, notFoundCode: 'BIRTH_REGISTRATION_NOT_FOUND',
        data: { status: 'REGISTERED', registrationNumber, registeredByUserId: context.userId, registeredAt: new Date(), ...(babyName ? { babyName } : {}) },
      });
    } catch (error) {
      throw uniqueViolation(error, { registration_number: 'REGISTRATION_NUMBER_IN_USE' }) ?? error;
    }
    await audited(tx, context, { action: 'birth.registered', resourceType: 'birth_registration', resourceId: id, patientId: row.patientId, data: { registrationId: id } });
    return fullRegistration(tx, context, id);
  });
}

export async function recordCertificateIssued(context, id, expectedVersion) {
  return withTenant(context, async (tx) => {
    const row = await loadRegistration(tx, context, id, 'REGISTERED', 'Register the birth before recording its certificate.');
    await updateVersioned(tx.emrBirthRegistration, {
      organizationId: context.organizationId, id, expectedVersion, notFoundCode: 'BIRTH_REGISTRATION_NOT_FOUND',
      data: { status: 'CERTIFICATE_ISSUED', certificateIssuedByUserId: context.userId, certificateIssuedAt: new Date() },
    });
    await audited(tx, context, { action: 'birth.certificate_issued', resourceType: 'birth_registration', resourceId: id, patientId: row.patientId, data: { registrationId: id } });
    return fullRegistration(tx, context, id);
  });
}
