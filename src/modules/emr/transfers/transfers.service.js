// Patient transfers of care. OUT: a patient on this register moves to another facility; completing it
// records that the records were handed over (by a person — nothing is sent electronically). IN: someone
// received from another facility, recorded by name (registration opens their chart). PENDING →
// COMPLETED | CANCELLED.
import { withTenant } from '../core/db.js';
import { requireListed } from '../../org-config/orgConfig.service.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';

// The starter Transfer Reasons list (Settings → Master Data); hospitals add and switch off their own.
export const TRANSFER_REASONS = ['Relocation', 'Catchment reassignment', 'Service not available here', 'Patient request', 'Higher level of care'];
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);

async function present(tx, rows) {
  const names = await userNameMap(tx, rows.flatMap((t) => [t.initiatedByUserId, t.completedByUserId, t.cancelledByUserId]).filter(Boolean));
  const name = (id) => (id ? names.get(id) ?? null : null);
  return rows.map((t) => ({
    id: t.id, version: t.version, direction: t.direction, patientId: t.patientId, patient: t.patient ? { ...t.patient, dateOfBirth: isoDay(t.patient.dateOfBirth) } : undefined,
    patientName: t.patientName, facility: t.facility, reason: t.reason, summary: t.summary, status: t.status, recordsSent: t.recordsSent,
    initiatedByName: name(t.initiatedByUserId), completedByName: name(t.completedByUserId), completedAt: t.completedAt, cancelledAt: t.cancelledAt, createdAt: t.createdAt,
  }));
}
const full = async (tx, context, id) => (await present(tx, [await tx.emrPatientTransfer.findFirst({ where: { organizationId: context.organizationId, id }, include: { patient: patientSummary } })]))[0];
async function changed(tx, context, transfer, action) {
  await recordAudit(tx, context, { action: `transfer.${action}`, resourceType: 'patient_transfer', resourceId: transfer.id });
  await enqueueEvent(tx, context, { type: `transfer.${action}`, aggregateType: transfer.patientId ? 'patient' : 'patient_transfer', aggregateId: transfer.patientId ?? transfer.id, data: { transferId: transfer.id, direction: transfer.direction } });
  return full(tx, context, transfer.id);
}

export async function listTransfers(context, { direction, status, limit }) {
  return withTenant(context, async (tx) => {
    const rows = await tx.emrPatientTransfer.findMany({
      where: { organizationId: context.organizationId, ...(direction ? { direction } : {}), ...(status ? { status } : {}) },
      include: { patient: patientSummary }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit,
    });
    await recordAudit(tx, context, { action: 'transfer.listed', resourceType: 'patient_transfer' });
    return { items: await present(tx, rows) };
  });
}

export async function createTransfer(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'transfer.create', body: input }, async () => {
    await requireListed(tx, context, 'transfer-reasons', input.reason, { what: 'The reason' });
    let patientId = null;
    let patientName = input.patientName ?? null;
    if (input.direction === 'OUT') {
      const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true, givenName: true, familyName: true });
      if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
      if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
      const open = await tx.emrPatientTransfer.findFirst({ where: { organizationId: context.organizationId, patientId: patient.id, direction: 'OUT', status: 'PENDING' }, select: { id: true } });
      if (open) throw new EmrError('TRANSFER_ALREADY_PENDING');
      patientId = patient.id;
      patientName = `${patient.givenName} ${patient.familyName}`;
    }
    let row;
    try {
      row = await tx.emrPatientTransfer.create({
        data: {
          organizationId: context.organizationId, direction: input.direction, patientId, patientName, facility: input.facility, reason: input.reason,
          summary: input.summary ?? null, recordsSent: input.direction === 'IN', initiatedByUserId: context.userId,
        },
      });
    } catch (error) {
      throw uniqueViolation(error, { one_pending_out: 'TRANSFER_ALREADY_PENDING' }) ?? error;
    }
    return { statusCode: 201, body: await changed(tx, context, row, 'initiated') };
  }));
}

export async function finishTransfer(context, transferId, expectedVersion, action) {
  return withTenant(context, async (tx) => {
    const transfer = await tx.emrPatientTransfer.findFirst({ where: { organizationId: context.organizationId, id: transferId } });
    if (!transfer) throw new EmrError('TRANSFER_NOT_FOUND');
    if (transfer.status !== 'PENDING') throw new EmrError('INVALID_STATE', { message: `This transfer is already ${transfer.status.toLowerCase()}.` });
    const now = new Date();
    await updateVersioned(tx.emrPatientTransfer, {
      organizationId: context.organizationId, id: transfer.id, expectedVersion, notFoundCode: 'TRANSFER_NOT_FOUND',
      data: action === 'complete'
        ? { status: 'COMPLETED', recordsSent: true, completedByUserId: context.userId, completedAt: now, updatedAt: now }
        : { status: 'CANCELLED', cancelledByUserId: context.userId, cancelledAt: now, updatedAt: now },
    });
    return changed(tx, context, transfer, action === 'complete' ? 'completed' : 'cancelled');
  });
}
