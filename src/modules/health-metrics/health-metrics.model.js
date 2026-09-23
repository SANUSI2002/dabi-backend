import prisma from '../../config/db.js';
const selectMetric = { id: true, health_score: true, recordedAt: true };
export const list = async (userId, query) => {
  const { page, limit, from, to, minScore, maxScore, sort } = query;
  const where = { userId, ...(from || to ? { recordedAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}), ...(minScore !== undefined || maxScore !== undefined ? { health_score: { ...(minScore !== undefined ? { gte: minScore } : {}), ...(maxScore !== undefined ? { lte: maxScore } : {}) } } : {}) };
  const [items, total] = await Promise.all([prisma.healthMetric.findMany({ where, select: selectMetric, orderBy: { recordedAt: sort }, skip: (page - 1) * limit, take: limit }), prisma.healthMetric.count({ where })]);
  return { items, page, limit, total };
};
