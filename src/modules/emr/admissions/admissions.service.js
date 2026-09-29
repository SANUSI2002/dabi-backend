// Wards, beds and admissions (admit → transfer → discharge, or cancel if entered in error).
//
// Locking: an admission change locks the admission row first, then (discharge) the visit, then
// the bed rows it touches in one statement ordered by id; admit locks visit → beds. Everyone
// takes locks in that order, so concurrent admits, transfers and discharges queue instead of
// deadlocking, and a bed can never be given to two patients — backed by unique indexes (one
// current admission per bed / patient / visit).
import { withTenant } from '../core/db.js';
import { afterCursor, page } from '../core/cursor.js';
import { recordAudit, changedFieldNames } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { etagFor, updateVersioned } from '../core/concurrency.js';
import { activeMemberWithRole } from '../core/membership.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { OPEN_STATUSES } from '../encounters/encounters.policy.js';
import { lockEncounter } from '../encounters/encounters.repository.js';
import { closeForEncounter } from '../queue/queue.service.js';
import * as policy from './admissions.policy.js';

const dateOnly = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };
const toPatient = (patient) => (patient ? { ...patient, dateOfBirth: dateOnly(patient.dateOfBirth) } : patient);
const toAdmission = (row) => ({ ...row, expectedDischargeDate: dateOnly(row.expectedDischargeDate), ...(row.patient ? { patient: toPatient(row.patient) } : {}) });

/** Updates a visit only while it is still open; anything else means the invariant broke. */
async function setEncounterFromOpen(tx, context, encounterId, data) {
  const { count } = await tx.emrEncounter.updateMany({
    where: { organizationId: context.organizationId, id: encounterId, status: { in: OPEN_STATUSES } },
    data: { ...data, updatedByUserId: context.userId, version: { increment: 1 } },
  });
  if (count !== 1) throw new EmrError('INVALID_STATE', { message: 'The visit for this admission is no longer open.' });
}

const UNIQUE = {
  one_per_bed: 'BED_NOT_AVAILABLE',
  one_per_patient: 'PATIENT_ALREADY_ADMITTED',
  one_per_encounter: 'PATIENT_ALREADY_ADMITTED',
};

async function requireAttending(context, userId) {
  if (userId && !await activeMemberWithRole(context.organizationId, userId, 'DOCTOR')) {
    throw new EmrError('VALIDATION_FAILED', { message: 'The attending clinician must be an active doctor in this organization.' });
  }
}

// ---------------------------------------------------------------------------------------------
// Wards and beds
// ---------------------------------------------------------------------------------------------
export async function listWards(context, { includeInactive }) {
  return withTenant(context, async (tx) => {
    const wards = await tx.emrWard.findMany({ where: { organizationId: context.organizationId, ...(includeInactive === 'true' ? {} : { active: true }) }, orderBy: { code: 'asc' } });
    const counts = await tx.emrBed.groupBy({ by: ['wardId', 'status'], where: { organizationId: context.organizationId }, _count: { _all: true } });
    return wards.map((ward) => {
      const beds = Object.fromEntries(policy.BED_STATUSES.map((status) => [status, 0]));
      for (const row of counts.filter((c) => c.wardId === ward.id)) beds[row.status] = row._count._all;
      const total = Object.values(beds).reduce((a, b) => a + b, 0);
      const inService = total - beds.OUT_OF_SERVICE;
      return { ...ward, beds: { ...beds, total }, occupancy: inService ? Math.round((beds.OCCUPIED / inService) * 1000) / 10 : 0 };
    });
  });
}

export async function createWard(context, { beds = [], ...ward }) {
  try {
    return await withTenant(context, async (tx) => {
      const row = await tx.emrWard.create({ data: { ...ward, organizationId: context.organizationId } });
      if (beds.length) await tx.emrBed.createMany({ data: beds.map((code) => ({ organizationId: context.organizationId, wardId: row.id, code })) });
      await recordAudit(tx, context, { action: 'ward.created', resourceType: 'ward', resourceId: row.id, changedFields: beds.length ? ['beds'] : [] });
      return row;
    });
  } catch (error) {
    throw uniqueViolation(error, { ward_id_code: 'BED_CODE_IN_USE', code: 'WARD_CODE_IN_USE' }) ?? error;
  }
}

export async function updateWard(context, wardId, expectedVersion, changes) {
  return withTenant(context, async (tx) => {
    const ward = await tx.emrWard.findFirst({ where: { organizationId: context.organizationId, id: wardId } });
    if (!ward) throw new EmrError('WARD_NOT_FOUND');
    const inpatients = await tx.emrAdmission.findMany({ where: { organizationId: context.organizationId, wardId, status: 'ADMITTED' }, select: { patient: { select: { sex: true } } } });
    if (changes.active === false && inpatients.length) throw new EmrError('INVALID_STATE', { message: `Ward ${ward.code} still has ${inpatients.length} admitted patient(s).` });
    if (changes.genderRestriction && changes.genderRestriction !== 'ANY' && inpatients.some((a) => a.patient.sex !== changes.genderRestriction)) {
      throw new EmrError('INVALID_STATE', { message: `Ward ${ward.code} has patients who do not fit that restriction.` });
    }
    const row = await updateVersioned(tx.emrWard, { organizationId: context.organizationId, id: wardId, expectedVersion, data: changes, notFoundCode: 'WARD_NOT_FOUND' });
    await recordAudit(tx, context, { action: 'ward.updated', resourceType: 'ward', resourceId: wardId, changedFields: changedFieldNames(ward, changes) });
    return row;
  });
}

export async function addBeds(context, wardId, { codes }) {
  try {
    return await withTenant(context, async (tx) => {
      const ward = await tx.emrWard.findFirst({ where: { organizationId: context.organizationId, id: wardId }, select: { id: true } });
      if (!ward) throw new EmrError('WARD_NOT_FOUND');
      const beds = await tx.emrBed.createManyAndReturn({ data: codes.map((code) => ({ organizationId: context.organizationId, wardId, code })) });
      await recordAudit(tx, context, { action: 'bed.created', resourceType: 'ward', resourceId: wardId, changedFields: codes });
      return beds;
    });
  } catch (error) {
    throw uniqueViolation(error, { ward_id_code: 'BED_CODE_IN_USE' }) ?? error;
  }
}

/** Beds of a ward with, for occupied beds, the admission and minimal patient identity. */
export async function listBeds(context, wardId) {
  return withTenant(context, async (tx) => {
    const ward = await tx.emrWard.findFirst({ where: { organizationId: context.organizationId, id: wardId } });
    if (!ward) throw new EmrError('WARD_NOT_FOUND');
    const beds = await tx.emrBed.findMany({ where: { organizationId: context.organizationId, wardId }, orderBy: { code: 'asc' } });
    const admissions = await tx.emrAdmission.findMany({
      where: { organizationId: context.organizationId, wardId, status: 'ADMITTED' },
      select: { id: true, bedId: true, admittedAt: true, attendingUserId: true, patient: patientSummary },
    });
    await recordAudit(tx, context, { action: 'bed_census.viewed', resourceType: 'ward', resourceId: wardId });
    return {
      ward,
      beds: beds.map((bed) => {
        const admission = admissions.find((a) => a.bedId === bed.id);
        return { ...bed, admission: admission ? { id: admission.id, admittedAt: admission.admittedAt, attendingUserId: admission.attendingUserId, patient: toPatient(admission.patient) } : null };
      }),
    };
  });
}

async function lockBeds(tx, context, bedIds) {
  const ids = [...new Set(bedIds)].sort();
  const rows = await tx.$queryRaw`
    SELECT "id" FROM "emr_beds" WHERE "organization_id" = ${context.organizationId} AND "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
  if (rows.length !== ids.length) throw new EmrError('BED_NOT_FOUND');
  return tx.emrBed.findMany({ where: { organizationId: context.organizationId, id: { in: ids } }, include: { ward: true } });
}

const setBed = (tx, context, bed, data) =>
  tx.emrBed.updateMany({ where: { organizationId: context.organizationId, id: bed.id }, data: { statusReason: null, ...data, version: { increment: 1 } } });

export async function setBedStatus(context, bedId, expectedVersion, { status, reason }) {
  return withTenant(context, async (tx) => {
    const [bed] = await lockBeds(tx, context, [bedId]);
    if (bed.version !== expectedVersion) throw new EmrError('VERSION_CONFLICT', { details: { currentVersion: bed.version }, headers: { ETag: etagFor(bed.version) } });
    policy.requireBedTransition(bed, status);
    await setBed(tx, context, bed, { status, statusReason: reason ?? null });
    await recordAudit(tx, context, { action: 'bed.status_changed', resourceType: 'bed', resourceId: bedId, changedFields: ['status'] });
    return tx.emrBed.findFirst({ where: { organizationId: context.organizationId, id: bedId } });
  });
}

// ---------------------------------------------------------------------------------------------
// Admissions
// ---------------------------------------------------------------------------------------------
export async function admit(context, encounterId, input, { idempotencyKey } = {}) {
  await requireAttending(context, input.attendingUserId);
  try {
    return await withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: `admission:${encounterId}`, body: input }, async () => {
      // Lock the visit first (as visit status changes do), so a concurrent cancel cannot slip in.
      const encounter = await lockEncounter(tx, context.organizationId, encounterId);
      if (!encounter) throw new EmrError('ENCOUNTER_NOT_FOUND');
      if (!OPEN_STATUSES.includes(encounter.status)) throw new EmrError('INVALID_STATE', { message: 'Only an open visit can lead to an admission.' });
      const patient = await tx.emrPatient.findFirst({ where: { organizationId: context.organizationId, id: encounter.patientId }, select: { status: true, sex: true } });
      if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');

      const [bed] = await lockBeds(tx, context, [input.bedId]);
      policy.requireWardAccepts(bed.ward, patient.sex);
      policy.requireBedAvailable(bed);
      const now = new Date();
      const admission = await tx.emrAdmission.create({
        data: {
          organizationId: context.organizationId, encounterId, patientId: encounter.patientId, wardId: bed.wardId, bedId: bed.id,
          reason: input.reason, admittedAt: now, admittedByUserId: context.userId, attendingUserId: input.attendingUserId ?? null,
          expectedDischargeDate: input.expectedDischargeDate ? new Date(`${input.expectedDischargeDate}T00:00:00.000Z`) : null,
        },
      });
      await tx.emrBedAssignment.create({ data: { organizationId: context.organizationId, admissionId: admission.id, wardId: bed.wardId, bedId: bed.id, reason: 'ADMISSION', assignedByUserId: context.userId, startedAt: now } });
      await setBed(tx, context, bed, { status: 'OCCUPIED' });
      // The visit becomes an inpatient stay (and is in progress from admission).
      await setEncounterFromOpen(tx, context, encounterId, { class: 'INPATIENT', status: 'IN_PROGRESS', ...(encounter.startedAt ? {} : { startedAt: now }) });
      await recordAudit(tx, context, { action: 'admission.created', resourceType: 'admission', resourceId: admission.id });
      await enqueueEvent(tx, context, { type: 'admission.created', aggregateType: 'admission', aggregateId: admission.id, data: { patientId: encounter.patientId, encounterId, wardId: bed.wardId } });
      return { statusCode: 201, body: toAdmission({ ...admission, ward: { code: bed.ward.code, name: bed.ward.name }, bed: { code: bed.code } }) };
    }));
  } catch (error) {
    throw uniqueViolation(error, UNIQUE) ?? error;
  }
}

async function withPlaces(tx, context, admissions) {
  const beds = await tx.emrBed.findMany({ where: { organizationId: context.organizationId, id: { in: [...new Set(admissions.map((a) => a.bedId))] } }, include: { ward: { select: { code: true, name: true } } } });
  return admissions.map((a) => {
    const bed = beds.find((b) => b.id === a.bedId);
    return toAdmission({ ...a, ward: bed.ward, bed: { code: bed.code } });
  });
}

/** Census (default: currently admitted), newest admission first. */
export async function listAdmissions(context, { status, wardId, patientId, cursor, limit }) {
  const after = afterCursor('admittedAt', cursor, 'desc');
  return withTenant(context, async (tx) => {
    const rows = await tx.emrAdmission.findMany({
      where: {
        organizationId: context.organizationId, status: status ?? 'ADMITTED',
        ...(wardId ? { wardId } : {}), ...(patientId ? { patientId } : {}),
        ...after,
      },
      include: { patient: patientSummary },
      orderBy: [{ admittedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    await recordAudit(tx, context, { action: 'admission.listed', resourceType: 'admission' });
    const result = page(rows, limit, 'admittedAt');
    return { ...result, items: await withPlaces(tx, context, result.items) };
  });
}

export async function getAdmission(context, admissionId) {
  return withTenant(context, async (tx) => {
    const row = await tx.emrAdmission.findFirst({
      where: { organizationId: context.organizationId, id: admissionId },
      include: { patient: patientSummary, assignments: { orderBy: { startedAt: 'asc' } } },
    });
    if (!row) throw new EmrError('ADMISSION_NOT_FOUND');
    const beds = await tx.emrBed.findMany({ where: { organizationId: context.organizationId, id: { in: row.assignments.map((a) => a.bedId) } }, include: { ward: { select: { code: true, name: true } } } });
    const place = (bedId) => { const bed = beds.find((b) => b.id === bedId); return { bed: { code: bed.code }, ward: bed.ward }; };
    await recordAudit(tx, context, { action: 'admission.viewed', resourceType: 'admission', resourceId: admissionId });
    return toAdmission({ ...row, ...place(row.bedId), assignments: row.assignments.map((a) => ({ ...a, ...place(a.bedId) })) });
  });
}

/** Locks the admission row and checks the caller's version before anything else is read. */
async function lockAdmission(tx, context, admissionId, expectedVersion) {
  const rows = await tx.$queryRaw`
    SELECT "id" FROM "emr_admissions" WHERE "organization_id" = ${context.organizationId} AND "id" = ${admissionId} FOR UPDATE`;
  if (!rows.length) throw new EmrError('ADMISSION_NOT_FOUND');
  const admission = await tx.emrAdmission.findFirst({ where: { organizationId: context.organizationId, id: admissionId }, include: { patient: { select: { sex: true } } } });
  if (admission.version !== expectedVersion) throw new EmrError('VERSION_CONFLICT', { details: { currentVersion: admission.version }, headers: { ETag: etagFor(admission.version) } });
  return admission;
}

const closeAssignment = (tx, context, admissionId, at) =>
  tx.emrBedAssignment.updateMany({ where: { organizationId: context.organizationId, admissionId, endedAt: null }, data: { endedAt: at } });

const updateAdmission = (tx, context, admission, data) =>
  updateVersioned(tx.emrAdmission, { organizationId: context.organizationId, id: admission.id, expectedVersion: admission.version, data, notFoundCode: 'ADMISSION_NOT_FOUND' });

export async function transfer(context, admissionId, expectedVersion, { bedId, note }) {
  try {
    return await withTenant(context, async (tx) => {
      const admission = await lockAdmission(tx, context, admissionId, expectedVersion);
      policy.requireAdmitted(admission, 'transferred');
      if (bedId === admission.bedId) throw new EmrError('VALIDATION_FAILED', { message: 'The patient is already in that bed.' });
      const beds = await lockBeds(tx, context, [admission.bedId, bedId]);
      const from = beds.find((b) => b.id === admission.bedId);
      const to = beds.find((b) => b.id === bedId);
      policy.requireWardAccepts(to.ward, admission.patient.sex);
      policy.requireBedAvailable(to);
      const now = new Date();
      await closeAssignment(tx, context, admissionId, now);
      await tx.emrBedAssignment.create({ data: { organizationId: context.organizationId, admissionId, wardId: to.wardId, bedId: to.id, reason: 'TRANSFER', note: note ?? null, assignedByUserId: context.userId, startedAt: now } });
      await setBed(tx, context, from, { status: 'CLEANING' });
      await setBed(tx, context, to, { status: 'OCCUPIED' });
      await updateAdmission(tx, context, admission, { wardId: to.wardId, bedId: to.id });
      await recordAudit(tx, context, { action: 'admission.transferred', resourceType: 'admission', resourceId: admissionId, changedFields: ['bedId', ...(from.wardId !== to.wardId ? ['wardId'] : [])] });
      await enqueueEvent(tx, context, { type: 'admission.transferred', aggregateType: 'admission', aggregateId: admissionId, data: { patientId: admission.patientId, fromWardId: from.wardId, toWardId: to.wardId } });
      return (await withPlaces(tx, context, [await tx.emrAdmission.findFirst({ where: { organizationId: context.organizationId, id: admissionId } })]))[0];
    });
  } catch (error) {
    throw uniqueViolation(error, UNIQUE) ?? error;
  }
}

/** Ends the stay: bed to cleaning, visit finished; a death also closes the patient record. */
export async function discharge(context, admissionId, expectedVersion, { disposition, summary }) {
  return withTenant(context, async (tx) => {
    const admission = await lockAdmission(tx, context, admissionId, expectedVersion);
    policy.requireAdmitted(admission, 'discharged');
    // Lock order everywhere: admission → visit → beds (admit takes visit → beds), so no cycle.
    const encounter = await lockEncounter(tx, context.organizationId, admission.encounterId);
    const [bed] = await lockBeds(tx, context, [admission.bedId]);
    const now = new Date();
    await closeAssignment(tx, context, admissionId, now);
    await setBed(tx, context, bed, { status: 'CLEANING' });
    await updateAdmission(tx, context, admission, { status: 'DISCHARGED', dischargedAt: now, dischargedByUserId: context.userId, dischargeDisposition: disposition, dischargeSummary: summary });
    await setEncounterFromOpen(tx, context, admission.encounterId, { status: 'FINISHED', endedAt: now, ...(encounter.startedAt ? {} : { startedAt: admission.admittedAt }) });
    await closeForEncounter(tx, context, admission.encounterId);
    if (disposition === 'DECEASED') {
      await tx.emrPatient.updateMany({
        where: { organizationId: context.organizationId, id: admission.patientId, status: 'ACTIVE' },
        data: { status: 'INACTIVE', deactivatedAt: now, deactivationReason: 'Deceased', updatedByUserId: context.userId, version: { increment: 1 } },
      });
    }
    await recordAudit(tx, context, { action: 'admission.discharged', resourceType: 'admission', resourceId: admissionId, changedFields: ['status', 'dischargeDisposition'] });
    await enqueueEvent(tx, context, { type: 'admission.discharged', aggregateType: 'admission', aggregateId: admissionId, data: { patientId: admission.patientId, encounterId: admission.encounterId, disposition } });
    return (await withPlaces(tx, context, [await tx.emrAdmission.findFirst({ where: { organizationId: context.organizationId, id: admissionId } })]))[0];
  });
}

/** For an admission entered in error — only while nothing has been charted against it. */
export async function cancelAdmission(context, admissionId, expectedVersion, { reason }) {
  return withTenant(context, async (tx) => {
    const admission = await lockAdmission(tx, context, admissionId, expectedVersion);
    policy.requireAdmitted(admission, 'cancelled');
    const charted = await tx.emrMedicationAdministration.count({ where: { organizationId: context.organizationId, admissionId, entryStatus: 'ACTIVE' } });
    if (charted) throw new EmrError('INVALID_STATE', { message: 'Medication has been charted on this admission; discharge it instead.' });
    const [bed] = await lockBeds(tx, context, [admission.bedId]);
    const now = new Date();
    await closeAssignment(tx, context, admissionId, now);
    await setBed(tx, context, bed, { status: 'CLEANING' });
    await updateAdmission(tx, context, admission, { status: 'CANCELLED', cancelledAt: now, cancelledByUserId: context.userId, cancellationReason: reason });
    await recordAudit(tx, context, { action: 'admission.cancelled', resourceType: 'admission', resourceId: admissionId });
    await enqueueEvent(tx, context, { type: 'admission.cancelled', aggregateType: 'admission', aggregateId: admissionId, data: { patientId: admission.patientId } });
    return (await withPlaces(tx, context, [await tx.emrAdmission.findFirst({ where: { organizationId: context.organizationId, id: admissionId } })]))[0];
  });
}
