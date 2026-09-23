import prisma from '../../config/db.js';
export const transaction = (work) => prisma.$transaction(work, { isolationLevel: 'Serializable' });
export const eligibleHospital = (hospitalId, ownerId) => ({ id: hospitalId, type: 'HOSPITAL', status: 'VERIFIED', ...(ownerId ? { ownerId } : {}) });
export const hospital = (tx, hospitalId, ownerId) => tx.organisation.findFirst({ where: eligibleHospital(hospitalId, ownerId), select: { id: true } });
export const publicSelect = { id: true, hospitalId: true, name: true, description: true, feeMinor: true };
export const ownerSelect = { ...publicSelect, status: true, createdAt: true, updatedAt: true, archivedAt: true };
const scope = (hospitalId, ownerId) => ({ hospitalId, hospital: eligibleHospital(hospitalId, ownerId) });
export const create = (tx, hospitalId, data) => tx.hospitalMemberPlan.create({ data: { ...data, hospitalId }, select: ownerSelect });
export const list = async (tx, hospitalId, query, ownerId) => {
  const where = { ...scope(hospitalId, ownerId), ...(ownerId ? query.status ? { status: query.status } : {} : { status: 'ACTIVE' }) };
  const [items, total] = await Promise.all([
    tx.hospitalMemberPlan.findMany({ where, select: ownerId ? ownerSelect : publicSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: query.limit, skip: query.offset }),
    tx.hospitalMemberPlan.count({ where }),
  ]);
  return { items, total, limit: query.limit, offset: query.offset };
};
export const detail = (tx, hospitalId, planId, ownerId) => tx.hospitalMemberPlan.findFirst({ where: { ...scope(hospitalId, ownerId), id: planId, ...(ownerId ? {} : { status: 'ACTIVE' }) }, select: ownerId ? ownerSelect : publicSelect });
export const change = (tx, hospitalId, planId, ownerId, data) => tx.hospitalMemberPlan.updateMany({ where: { ...scope(hospitalId, ownerId), id: planId, status: 'ACTIVE' }, data });
