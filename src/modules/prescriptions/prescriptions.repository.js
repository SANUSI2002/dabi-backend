import prisma from '../../config/db.js';

export const detailSelect = {
  id: true, reference: true, patientId: true, doctorProfileId: true, status: true, instructions: true, issuerAttestedAt: true, issuedAt: true, cancelledAt: true, createdAt: true, updatedAt: true,
  items: { select: { id: true, medicationName: true, dosage: true, frequency: true, route: true, duration: true, quantity: true, indication: true } },
  doctorProfile: { select: { specialty: true, practiceName: true, user: { select: { full_name: true } } } },
};
export const transaction = (callback) => prisma.$transaction(callback);
export const create = (tx, data) => tx.prescription.create({ data, select: detailSelect });
export const findDoctorDraft = (tx, id, doctorProfileId) => tx.prescription.findFirst({ where: { id, doctorProfileId, status: 'DRAFT' }, select: detailSelect });
export const findDoctor = (tx, id, doctorProfileId) => tx.prescription.findFirst({ where: { id, doctorProfileId }, select: detailSelect });
export const replaceDraft = (tx, id, data) => tx.prescription.update({ where: { id }, data: { instructions: data.instructions, items: { deleteMany: {}, create: data.items } }, select: detailSelect });
export const issue = (tx, id, doctorProfileId) => tx.prescription.updateMany({ where: { id, doctorProfileId, status: 'DRAFT' }, data: { status: 'ISSUED', issuedAt: new Date(), issuerAttestedAt: new Date() } });
export const cancel = (tx, id, doctorProfileId) => tx.prescription.updateMany({ where: { id, doctorProfileId, status: 'ISSUED' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
export const findByDoctor = (id, userId) => prisma.prescription.findFirst({ where: { id, doctorProfile: { userId } }, select: detailSelect });
export const findByPatient = (id, patientId) => prisma.prescription.findFirst({ where: { id, patientId, status: 'ISSUED' }, select: detailSelect });
export const listDoctor = async (userId, page, limit) => { const where = { doctorProfile: { userId } }; const [items, total] = await Promise.all([prisma.prescription.findMany({ where, select: detailSelect, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }), prisma.prescription.count({ where })]); return { items, page, limit, total }; };
export const listPatient = async (patientId, page, limit) => { const where = { patientId, status: 'ISSUED' }; const [items, total] = await Promise.all([prisma.prescription.findMany({ where, select: detailSelect, orderBy: { issuedAt: 'desc' }, skip: (page - 1) * limit, take: limit }), prisma.prescription.count({ where })]); return { items, page, limit, total }; };
