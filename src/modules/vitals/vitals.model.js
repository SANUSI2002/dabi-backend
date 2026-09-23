import prisma from '../../config/db.js';
const selectVital = { id: true, type: true, value: true, unit: true, status: true, recordedAt: true };

export const list = async (userId, query) => {
  const { page, limit, type, status, from, to, sort } = query;
  const where = { userId, ...(type ? { type } : {}), ...(status ? { status } : {}), ...(from || to ? { recordedAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}) };
  const [items, total] = await Promise.all([prisma.vital.findMany({ where, select: selectVital, orderBy: { recordedAt: sort }, skip: (page - 1) * limit, take: limit }), prisma.vital.count({ where })]);
  return { items, page, limit, total };
};
export const create = (userId, data) => prisma.$transaction(async (tx) => {
  const vital = await tx.vital.create({ data: { userId, ...data, recordedAt: new Date(data.recordedAt) }, select: selectVital });
  await tx.activityLog.create({ data: { userId, type: 'VITAL_RECORDED', description: 'Vital entry recorded', meta: { vitalId: vital.id, vitalType: vital.type } } });
  return vital;
});
