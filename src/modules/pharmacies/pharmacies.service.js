import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import * as auditLog from './pharmacies.audit.js';
import * as policy from './pharmacies.policy.js';
import * as repository from './pharmacies.repository.js';
import { createFacilityOwner } from '../identity/identity.repository.js';

const patientId = () => `#SHM${randomInt(0, 100000).toString().padStart(5, '0')}`;
const uniquePatientId = async (tx) => { for (let attempt = 0; attempt < 10; attempt += 1) { const value = patientId(); if (!await repository.nextPatientId(tx, value)) return value; } throw policy.error('ID_COLLISION'); };
export const registerInTransaction = async (tx, data) => { const admin = await repository.createAdmin(tx, { patientId: await uniquePatientId(tx), email: data.email, password: await bcrypt.hash(data.password, 12), full_name: data.fullName, phone_number: data.phoneNumber, roles: { create: { role: 'PHARMACY_ADMIN' } } }); const pharmacy = await repository.create(tx, { adminUserId: admin.id, name: data.name, address: data.address, country: data.country, state: data.state, city: data.city, contactEmail: data.contactEmail, contactPhone: data.contactPhone }); await createFacilityOwner(tx, { userId: admin.id, pharmacyId: pharmacy.id, type: 'PHARMACY', roleCode: 'PHARMACY_ADMIN' }); await auditLog.audit(tx, admin.id, 'PHARMACY_REGISTERED', pharmacy.id); return pharmacy; };
export const register = (data) => repository.transaction((tx) => registerInTransaction(tx, data));
export const mine = (userId) => repository.transaction(async (tx) => { await policy.pharmacyAdmin(tx, userId); const pharmacy = await repository.mine(tx, userId); if (!pharmacy) throw policy.error('NOT_FOUND'); return pharmacy; });
export const publicList = (query) => repository.publicList(query);
export const publicDetail = (id) => repository.publicDetail(id);
export const complianceList = (userId, query) => repository.transaction(async (tx) => { await policy.complianceAdmin(tx, userId); return repository.complianceList(query); });
export const decision = (userId, id, data) => repository.transaction(async (tx) => { await policy.complianceAdmin(tx, userId); const pharmacy = await repository.findForDecision(tx, id); if (!pharmacy || pharmacy.adminUserId === userId) throw policy.error('NOT_FOUND'); const allowed = { VERIFIED: ['PENDING', 'REJECTED', 'SUSPENDED'], REJECTED: ['PENDING'], SUSPENDED: ['VERIFIED'] }; if (!allowed[data.status].includes(pharmacy.complianceStatus)) throw policy.error('INVALID'); const updated = await repository.updateDecision(tx, id, { complianceStatus: data.status, decisionNote: data.note ?? null, decidedByUserId: userId, decidedAt: new Date() }); await auditLog.audit(tx, userId, `PHARMACY_${data.status}`, id); return updated; });
