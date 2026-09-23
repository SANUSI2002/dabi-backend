import prisma from '../../config/db.js';
const selectMedication = { id: true, name: true, instructions: true, time: true, isTaken: true, updatedAt: true };
const notFound = () => Object.assign(new Error('Medication not found'), { code: 'NOT_FOUND' });
const audit = (tx, userId, type, medicationId) => tx.activityLog.create({ data: { userId, type, description: 'Medication state changed', meta: { medicationId } } });

export const list = async (userId, query) => {
  const { page, limit, adherence, search, sort } = query;
  const where = { userId, ...(adherence === 'taken' ? { isTaken: true } : adherence === 'pending' ? { isTaken: false } : {}), ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}) };
  const [items, total] = await Promise.all([prisma.medication.findMany({ where, select: selectMedication, orderBy: { time: sort }, skip: (page - 1) * limit, take: limit }), prisma.medication.count({ where })]);
  return { items, page, limit, total };
};
export const getById = (userId, id) => prisma.medication.findFirst({ where: { id, userId }, select: selectMedication });
export const create = (userId, data) => prisma.$transaction(async (tx) => { const medication = await tx.medication.create({ data: { userId, ...data }, select: selectMedication }); await audit(tx, userId, 'MEDICATION_CREATED', medication.id); return medication; });
export const update = (userId, id, data) => prisma.$transaction(async (tx) => { const result = await tx.medication.updateMany({ where: { id, userId }, data }); if (!result.count) throw notFound(); const medication = await tx.medication.findFirst({ where: { id, userId }, select: selectMedication }); await audit(tx, userId, 'MEDICATION_UPDATED', id); return medication; });
export const setAdherence = (userId, id, isTaken) => prisma.$transaction(async (tx) => {
  const existing = await tx.medication.findFirst({ where: { id, userId }, select: selectMedication });
  if (!existing) throw notFound();
  if (existing.isTaken === isTaken) return existing;
  await tx.medication.updateMany({ where: { id, userId }, data: { isTaken } });
  const medication = await tx.medication.findFirst({ where: { id, userId }, select: selectMedication });
  await audit(tx, userId, 'MEDICATION_ADHERENCE_UPDATED', id);
  return medication;
});
export const remove = (userId, id) => prisma.$transaction(async (tx) => { const result = await tx.medication.deleteMany({ where: { id, userId } }); if (!result.count) throw notFound(); await audit(tx, userId, 'MEDICATION_DELETED', id); });
