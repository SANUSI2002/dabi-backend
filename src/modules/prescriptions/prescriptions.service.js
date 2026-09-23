import { randomUUID } from 'node:crypto';
import * as auditLog from './prescriptions.audit.js';
import * as policy from './prescriptions.policy.js';
import * as repository from './prescriptions.repository.js';

const reference = () => `RX-${randomUUID()}`;
const itemData = (items) => items.map((item) => ({ medicationName: item.medicationName, dosage: item.dosage, frequency: item.frequency, route: item.route, duration: item.duration, quantity: item.quantity, indication: item.indication }));

export const createDraft = (doctorUserId, data) => repository.transaction(async (tx) => {
  const doctor = await policy.verifiedDoctor(tx, doctorUserId);
  await policy.activeCareRelationship(tx, data.patientId, doctor.id);
  const prescription = await repository.create(tx, { reference: reference(), patientId: data.patientId, doctorProfileId: doctor.id, instructions: data.instructions, items: { create: itemData(data.items) } });
  await auditLog.audit(tx, doctorUserId, 'PRESCRIPTION_DRAFT_CREATED', prescription.id);
  return prescription;
});

export const updateDraft = (doctorUserId, id, data) => repository.transaction(async (tx) => {
  const doctor = await policy.verifiedDoctor(tx, doctorUserId);
  const draft = await repository.findDoctorDraft(tx, id, doctor.id);
  if (!draft) throw policy.error('NOT_FOUND');
  await policy.activeCareRelationship(tx, draft.patientId, doctor.id);
  const prescription = await repository.replaceDraft(tx, id, { instructions: data.instructions, items: itemData(data.items) });
  await auditLog.audit(tx, doctorUserId, 'PRESCRIPTION_DRAFT_UPDATED', id);
  return prescription;
});

export const issue = (doctorUserId, id) => repository.transaction(async (tx) => {
  const doctor = await policy.verifiedDoctor(tx, doctorUserId);
  const draft = await repository.findDoctorDraft(tx, id, doctor.id);
  if (!draft) throw policy.error('NOT_FOUND');
  await policy.activeCareRelationship(tx, draft.patientId, doctor.id);
  if (!(await repository.issue(tx, id, doctor.id)).count) throw policy.error('NOT_FOUND');
  await auditLog.audit(tx, doctorUserId, 'PRESCRIPTION_ISSUED', id);
  return repository.findDoctor(tx, id, doctor.id);
});

export const cancel = (doctorUserId, id) => repository.transaction(async (tx) => {
  const doctor = await policy.verifiedDoctor(tx, doctorUserId);
  if (!(await repository.cancel(tx, id, doctor.id)).count) throw policy.error('NOT_FOUND');
  await auditLog.audit(tx, doctorUserId, 'PRESCRIPTION_CANCELLED', id);
});

export const patientList = (patientId, query) => repository.listPatient(patientId, query.page, query.limit);
export const doctorList = (doctorUserId, query) => repository.listDoctor(doctorUserId, query.page, query.limit);
export const read = async (userId, id) => (await repository.findByDoctor(id, userId)) || repository.findByPatient(id, userId);
