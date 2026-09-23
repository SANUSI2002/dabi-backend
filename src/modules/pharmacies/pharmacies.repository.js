import prisma from '../../config/db.js';

const publicSelect = { id: true, name: true, address: true, country: true, state: true, city: true, contactEmail: true, contactPhone: true };
const adminSelect = { ...publicSelect, adminUserId: true, complianceStatus: true, decisionNote: true, decidedAt: true, createdAt: true, updatedAt: true };
export const transaction = (callback) => prisma.$transaction(callback);
export const nextPatientId = (tx, patientId) => tx.user.findUnique({ where: { patientId }, select: { id: true } });
export const createAdmin = (tx, data) => tx.user.create({ data, select: { id: true, email: true, full_name: true } });
export const create = (tx, data) => tx.pharmacy.create({ data, select: adminSelect });
export const mine = (tx, adminUserId) => tx.pharmacy.findFirst({ where: { adminUserId }, select: adminSelect });
export const findForDecision = (tx, id) => tx.pharmacy.findUnique({ where: { id }, select: adminSelect });
export const updateDecision = (tx, id, data) => tx.pharmacy.update({ where: { id }, data, select: adminSelect });
export const publicDetail = (id) => prisma.pharmacy.findFirst({ where: { id, complianceStatus: 'VERIFIED' }, select: publicSelect });
const filters = (query, status = 'VERIFIED') => ({ complianceStatus: status, ...(query.country ? { country: { equals: query.country, mode: 'insensitive' } } : {}), ...(query.state ? { state: { equals: query.state, mode: 'insensitive' } } : {}), ...(query.city ? { city: { equals: query.city, mode: 'insensitive' } } : {}) });
export const publicList = async (query) => { const where = filters(query); const [items, total] = await Promise.all([prisma.pharmacy.findMany({ where, select: publicSelect, orderBy: { name: 'asc' }, skip: (query.page - 1) * query.limit, take: query.limit }), prisma.pharmacy.count({ where })]); return { items, page: query.page, limit: query.limit, total }; };
export const complianceList = async (query) => { const where = filters(query, query.status ?? undefined); const [items, total] = await Promise.all([prisma.pharmacy.findMany({ where, select: adminSelect, orderBy: { createdAt: 'asc' }, skip: (query.page - 1) * query.limit, take: query.limit }), prisma.pharmacy.count({ where })]); return { items, page: query.page, limit: query.limit, total }; };
