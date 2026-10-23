// Family planning. Registering a client records the first ("new") visit with the starting method; later
// visits are revisits, resupply, a switch of method (the registration takes the new method) or removal
// (the registration is discontinued). Discontinuing needs a reason. One active registration per person.
import { requireListed } from '../../org-config/orgConfig.service.js';
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { idempotent } from '../core/idempotency.js';
import { enqueueEvent } from '../core/outbox.js';
import { updateVersioned } from '../core/concurrency.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { userNameMap } from '../core/people.js';
import { findPatient } from '../patients/patients.repository.js';

export const FP_METHODS = ['Oral Pill', 'Injectable (DMPA-IM)', 'Injectable (DMPA-SC)', 'Implant', 'IUCD', 'Male Condom', 'Female Condom', 'LAM', 'Natural / Calendar'];
// The starter reasons for stopping (Settings → Master Data); 'Removal' is what a removal visit records.
export const DISCONTINUE_REASONS = ['Wants to conceive', 'Side effects', 'Method failure', 'Moved away', 'Partner objection', 'Switched method', 'Removal'];
const toDate = (iso) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const today = () => toDate(new Date().toISOString().slice(0, 10));
const patientSummary = { select: { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true } };
const include = { patient: patientSummary, visits: { orderBy: [{ visitDate: 'asc' }, { createdAt: 'asc' }] } };

async function present(tx, rows) {
  const names = await userNameMap(tx, rows.flatMap((c) => [c.registeredByUserId, c.discontinuedByUserId, ...c.visits.map((v) => v.recordedByUserId)]));
  const name = (id) => (id ? names.get(id) ?? null : null);
  return rows.map((c) => ({
    id: c.id, patientId: c.patientId, patient: c.patient ? { ...c.patient, dateOfBirth: isoDay(c.patient.dateOfBirth) } : undefined, version: c.version,
    method: c.method, firstTime: c.firstTime, startDate: isoDay(c.startDate), nextVisitDate: isoDay(c.nextVisitDate), counselled: c.counselled, notes: c.notes,
    status: c.status, discontinueReason: c.discontinueReason, discontinuedAt: c.discontinuedAt, discontinuedByName: name(c.discontinuedByUserId), registeredByName: name(c.registeredByUserId),
    visits: c.visits.map((v) => ({ id: v.id, visitDate: isoDay(v.visitDate), visitType: v.visitType, method: v.method, nextVisitDate: isoDay(v.nextVisitDate), notes: v.notes, recordedByName: name(v.recordedByUserId) })),
  }));
}
const fullClient = async (tx, context, id) => (await present(tx, [await tx.emrFpClient.findFirst({ where: { organizationId: context.organizationId, id }, include })]))[0];
async function changed(tx, context, client, action, data = {}) {
  await recordAudit(tx, context, { action: `fp.${action}`, resourceType: 'fp_client', resourceId: client.id });
  await enqueueEvent(tx, context, { type: `fp.${action}`, aggregateType: 'patient', aggregateId: client.patientId, data: { clientId: client.id, ...data } });
  return fullClient(tx, context, client.id);
}
const futureCheck = (iso, label) => {
  if (iso && toDate(iso) > today()) throw new EmrError('VALIDATION_FAILED', { message: `The ${label} cannot be in the future.` });
};

export async function listClients(context, { status, patientId, limit }) {
  return withTenant(context, async (tx) => {
    const rows = await tx.emrFpClient.findMany({
      where: { organizationId: context.organizationId, ...(status ? { status: { in: status } } : {}), ...(patientId ? { patientId } : {}) },
      include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit,
    });
    await recordAudit(tx, context, { action: 'fp.listed', resourceType: 'fp_client' });
    return { items: await present(tx, rows) };
  });
}

export async function registerClient(context, input, { idempotencyKey } = {}) {
  return withTenant(context, (tx) => idempotent(tx, context, { key: idempotencyKey, scope: 'fp.register', body: input }, async () => {
    const patient = await findPatient(tx, context.organizationId, input.patientId, { id: true, status: true });
    if (!patient) throw new EmrError('PATIENT_NOT_FOUND');
    if (patient.status !== 'ACTIVE') throw new EmrError('PATIENT_INACTIVE');
    futureCheck(input.startDate, 'start date');
    if (input.nextVisitDate && input.nextVisitDate <= input.startDate) throw new EmrError('VALIDATION_FAILED', { message: 'The next visit must be after the start date.' });
    let client;
    try {
      client = await tx.emrFpClient.create({
        data: {
          organizationId: context.organizationId, patientId: patient.id, method: input.method, firstTime: input.firstTime, startDate: toDate(input.startDate),
          nextVisitDate: toDate(input.nextVisitDate), counselled: input.counselled, notes: input.notes ?? null, registeredByUserId: context.userId,
        },
      });
    } catch (error) {
      throw uniqueViolation(error, { one_active: 'FP_CLIENT_ALREADY_ACTIVE' }) ?? error;
    }
    await tx.emrFpVisit.create({
      data: { organizationId: context.organizationId, clientId: client.id, visitDate: client.startDate, visitType: 'NEW_VISIT', method: client.method, nextVisitDate: client.nextVisitDate, notes: client.notes, recordedByUserId: context.userId },
    });
    return { statusCode: 201, body: await changed(tx, context, client, 'registered', { method: client.method }) };
  }));
}

export async function recordVisit(context, clientId, expectedVersion, input) {
  return withTenant(context, async (tx) => {
    const client = await tx.emrFpClient.findFirst({ where: { organizationId: context.organizationId, id: clientId } });
    if (!client) throw new EmrError('FP_CLIENT_NOT_FOUND');
    if (client.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: 'This client is discontinued. Register her again to restart a method.' });
    const visitDate = input.visitDate ?? new Date().toISOString().slice(0, 10);
    futureCheck(visitDate, 'visit date');
    if (input.nextVisitDate && input.nextVisitDate <= visitDate) throw new EmrError('VALIDATION_FAILED', { message: 'The next visit must be after this visit.' });
    const method = input.visitType === 'SWITCH_METHOD' ? input.method : client.method;
    if (input.visitType === 'SWITCH_METHOD' && method === client.method) throw new EmrError('VALIDATION_FAILED', { message: 'Choose a different method to switch to.' });
    const removal = input.visitType === 'REMOVAL';
    await updateVersioned(tx.emrFpClient, {
      organizationId: context.organizationId, id: client.id, expectedVersion, notFoundCode: 'FP_CLIENT_NOT_FOUND',
      data: {
        method, ...(input.nextVisitDate ? { nextVisitDate: toDate(input.nextVisitDate) } : {}),
        ...(removal ? { status: 'DISCONTINUED', discontinueReason: 'Removal', discontinuedAt: new Date(), discontinuedByUserId: context.userId, nextVisitDate: null } : {}),
      },
    });
    await tx.emrFpVisit.create({
      data: { organizationId: context.organizationId, clientId: client.id, visitDate: toDate(visitDate), visitType: input.visitType, method, nextVisitDate: toDate(input.nextVisitDate), notes: input.notes ?? null, recordedByUserId: context.userId },
    });
    return changed(tx, context, client, 'visit_recorded', { visitType: input.visitType });
  });
}

export async function discontinue(context, clientId, expectedVersion, { reason }) {
  return withTenant(context, async (tx) => {
    const client = await tx.emrFpClient.findFirst({ where: { organizationId: context.organizationId, id: clientId } });
    if (!client) throw new EmrError('FP_CLIENT_NOT_FOUND');
    if (client.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: 'This client is already discontinued.' });
    await requireListed(tx, context, 'fp-discontinue-reasons', reason, { what: 'The reason' });
    await updateVersioned(tx.emrFpClient, {
      organizationId: context.organizationId, id: client.id, expectedVersion, notFoundCode: 'FP_CLIENT_NOT_FOUND',
      data: { status: 'DISCONTINUED', discontinueReason: reason, discontinuedAt: new Date(), discontinuedByUserId: context.userId, nextVisitDate: null },
    });
    return changed(tx, context, client, 'discontinued', { reason });
  });
}
