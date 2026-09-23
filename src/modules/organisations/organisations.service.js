import bcrypt from 'bcryptjs';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import * as repository from './organisations.repository.js';
import { fail, requireRole, transitions } from './organisations.policy.js';
import * as audit from './organisations.audit.js';
import { registerInTransaction } from '../pharmacies/pharmacies.service.js';
import { createFacilityOwner } from '../identity/identity.repository.js';

export const register = async (data) => {
  const { organisation: org, representative: rep } = data;
  // Hash outside the database transaction; no passwords are stored in submission JSON.
  const hashedPassword = data.organisationType === 'pharmacy' ? null : await bcrypt.hash(rep.password, 12);
  return repository.transaction(async (tx) => {
    let facility, ownerId;
    const pharmacy = data.organisationType === 'pharmacy';
    if (pharmacy) {
      facility = await registerInTransaction(tx, { email: rep.email, password: rep.password, fullName: `${rep.firstName} ${rep.lastName}`, phoneNumber: rep.phone, name: org.entityName, address: org.address, country: org.country, state: org.state, city: org.city, contactEmail: org.email, contactPhone: org.phone });
      ownerId = facility.adminUserId;
    } else {
      const owner = await repository.createOwner(tx, { patientId: `ORG-${randomUUID()}`, email: rep.email, password: hashedPassword, full_name: `${rep.firstName} ${rep.lastName}`, phone_number: rep.phone, roles: { create: { role: 'ORGANISATION_OWNER' } } });
      ownerId = owner.id;
      facility = await repository.create(tx, { ownerId, type: repository.typeMap[data.organisationType], name: org.entityName, address: org.address, country: org.country, state: org.state, city: org.city, contactEmail: org.email, contactPhone: org.phone });
      await createFacilityOwner(tx, { userId: ownerId, organisationId: facility.id, type: facility.type, roleCode: 'ORGANISATION_OWNER' });
      await audit.record(tx, ownerId, 'ORGANISATION_REGISTERED', facility.id);
    }
    const now = new Date();
    const onboarding = await repository.createSubmission(tx, {
      ...(pharmacy ? { pharmacyId: facility.id } : { organisationId: facility.id }),
      details: { legalName: org.legalName, ...(org.website ? { website: org.website } : {}), representative: { firstName: rep.firstName, lastName: rep.lastName, phone: rep.phone, email: rep.email, position: rep.position }, regulatory: data.regulatory, ...(data.services ? { services: data.services } : {}), ...(data.operatingInfo ? { operatingInfo: data.operatingInfo } : {}) },
      termsAcceptedAt: now, privacyAcceptedAt: now, healthDataAcceptedAt: data.consent.healthData ? now : null, consentVersion: '1.0',
      documents: { create: Object.entries(data.documents).map(([key, value]) => ({ key, name: value.name, contentType: value.contentType, content: Buffer.from(value.base64, 'base64') })) },
    });
    return { id: facility.id, organisationType: data.organisationType, status: pharmacy ? facility.complianceStatus : facility.status, verificationAuthority: pharmacy ? 'PHARMACY_COMPLIANCE_ADMIN' : 'SUPER_ADMIN', owner: { id: ownerId, email: rep.email, role: pharmacy ? 'PHARMACY_ADMIN' : 'ORGANISATION_OWNER' }, submissionId: onboarding.id };
  });
};
export const mine = (userId) => repository.transaction(async (tx) => {
  const org = await repository.find(tx, { ownerId: userId });
  if (org) return { ...org, verificationAuthority: 'SUPER_ADMIN' };
  const pharmacy = await repository.pharmacy(tx, { adminUserId: userId });
  if (pharmacy) return { ...pharmacy, status: pharmacy.complianceStatus, organisationType: 'pharmacy', verificationAuthority: 'PHARMACY_COMPLIANCE_ADMIN' };
  throw fail('NOT_FOUND');
});
export const queue = (userId, query) => repository.transaction(async (tx) => { await requireRole(tx, userId, 'SUPER_ADMIN'); return repository.list(tx, query, true); });
export const detail = (userId, id) => repository.transaction(async (tx) => { await requireRole(tx, userId, 'SUPER_ADMIN'); const org = await repository.find(tx, { id }); if (!org) throw fail('NOT_FOUND'); return org; });
export const pharmacyDetail = (userId, id) => repository.transaction(async (tx) => { await requireRole(tx, userId, 'PHARMACY_COMPLIANCE_ADMIN'); const pharmacy = await repository.pharmacy(tx, { id }); if (!pharmacy) throw fail('NOT_FOUND'); return pharmacy; });
export const decision = (userId, id, action, data) => repository.transaction(async (tx) => {
  await requireRole(tx, userId, 'SUPER_ADMIN');
  const org = await repository.find(tx, { id });
  if (!org || org.ownerId === userId) throw fail('NOT_FOUND');
  const transition = transitions[action];
  if (!transition.from.includes(org.status)) throw fail('INVALID');
  const result = await repository.update(tx, { id, status: org.status, updatedAt: org.updatedAt }, { status: transition.to, decisionNote: data.note ?? null, decidedAt: new Date(), decidedByUserId: userId });
  if (result.count !== 1) throw fail('INVALID');
  await audit.record(tx, userId, `ORGANISATION_${transition.to}`, id);
  return repository.find(tx, { id });
});
export const publicList = repository.publicList;
export const publicDetail = async (id) => { const org = await repository.publicDetail(id); if (!org) throw fail('NOT_FOUND'); return org; };
export const document = (userId, id, key) => repository.transaction(async (tx) => {
  const submission = await repository.submission(tx, id);
  if (!submission) throw fail('NOT_FOUND');
  const ownerId = submission.pharmacy?.adminUserId ?? submission.organisation?.ownerId;
  if (!ownerId) throw fail('NOT_FOUND');
  if (ownerId !== userId) await requireRole(tx, userId, submission.pharmacy ? 'PHARMACY_COMPLIANCE_ADMIN' : 'SUPER_ADMIN');
  const document = await repository.document(tx, id, key);
  if (!document) throw fail('NOT_FOUND');
  return document;
});
