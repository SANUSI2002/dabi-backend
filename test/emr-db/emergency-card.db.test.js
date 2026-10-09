import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { prisma, tokenFor, createTenant, addMember } from './fixtures.js';
import { emergencySummary, newEmergencyCode } from '../../src/modules/profile/emergency-card.service.js';

const path = '/api/v1/profile/emergency-card';
const as = (u) => ({
  get: (suffix = '') => request(app).get(path + suffix).set('Authorization', u.auth),
  post: (suffix, body) => request(app).post(path + suffix).set('Authorization', u.auth).send(body),
  put: (body) => request(app).put(path).set('Authorization', u.auth).send(body),
});
async function patient() {
  const tag = randomUUID();
  const user = await prisma.user.create({ data: { patientId: `E-${tag.slice(0, 8)}`, email: `${tag}@emergency.test`, password: 'synthetic-only', full_name: 'Synthetic Emergency Patient', roles: { create: { role: 'PATIENT' } }, accountStatus: 'ACTIVE', emailVerifiedAt: new Date() } });
  return { id: user.id, auth: tokenFor(user.id) };
}
async function sharing(who, scopes = { careCircle: true, hospitals: true }) {
  const card = (await as(who).get()).body.data;
  const saved = await as(who).put({ version: card.version, sharingEnabled: true, scopes, consentVersion: 'emergency-card-v1' });
  expect(saved.status).toBe(200);
  return saved.body.data;
}
async function circle(owner, caregiver, extras = {}) {
  return prisma.careRelationship.create({ data: { patientId: owner.id, caregiverId: caregiver.id, caregiverEmail: `${randomUUID()}@circle.test`, relationshipType: 'CAREGIVER', status: 'ACTIVE', permissions: ['EMERGENCY_SUMMARY'], emergencyAccessGrantedAt: new Date(), ...extras } });
}
const lookup = (who, card, extra = {}) => as(who).post('/lookup', { code: card.code, ...extra });

describe('Emergency Card: real migrations, routes, authorization and revocation', () => {
  it('defaults off; consent and a sharing group are required, and notifications are independent', async () => {
    const owner = await patient(); const initial = await as(owner).get();
    expect(initial.headers['cache-control']).toContain('no-store');
    expect(initial.body.data).toMatchObject({ sharingEnabled: false, notificationEnabled: false, scopes: { careCircle: false, hospitals: false } });
    expect(initial.body.data.code).toMatch(/^EC-(?:[A-F0-9]{4}-){5}[A-F0-9]{4}$/);
    const { version } = initial.body.data;
    expect((await as(owner).put({ version, sharingEnabled: true, scopes: { careCircle: true, hospitals: false } })).status).toBe(400);
    expect((await as(owner).put({ version, sharingEnabled: true, consentVersion: 'emergency-card-v1' })).status).toBe(400);
    const enabled = await sharing(owner);
    expect(enabled.consent.at).toBeTruthy();
    expect((await as(owner).put({ version, notificationEnabled: true })).body.data).toMatchObject({ sharingEnabled: true, notificationEnabled: true });
    expect((await as(owner).put({ version, notificationEnabled: false })).body.data).toMatchObject({ sharingEnabled: true, notificationEnabled: false });
    expect((await as(owner).put({ version, scopes: { careCircle: false, hospitals: true } })).status).toBe(400);
  });

  it('grants only this patient’s explicit active Care Circle relationship, and records access without health data', async () => {
    const owner = await patient(); const member = await patient(); const outsider = await patient(); const otherOwner = await patient();
    const card = await sharing(owner); const otherCard = await sharing(otherOwner);
    const relation = await circle(owner, member, { expiresAt: new Date(Date.now() - 86400000), respondedAt: new Date() }); // expired invitation, not expired active membership
    await prisma.userProfile.update({ where: { userId: owner.id }, data: { known_allergies: 'Penicillin', blood_type: 'A+', chronic_conditions: 'Asthma', current_medications: 'Patient reported inhaler' } });
    const allowed = await lookup(member, card);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.summary.allergies).toMatchObject({ state: 'RECORDED', verification: 'PATIENT_REPORTED' });
    expect(allowed.body.data.summary.bloodGroup).toMatchObject({ value: 'A+', verification: 'PATIENT_REPORTED' });
    expect(allowed.headers['cache-control']).toContain('no-store');
    const audit = await prisma.auditEvent.findFirst({ where: { actorUserId: member.id, subjectUserId: owner.id, action: 'EMERGENCY_SUMMARY_ACCESSED' } });
    expect(audit.context).toMatchObject({ outcome: 'SUCCESS', mode: 'CARE_CIRCLE', relationshipId: relation.id });
    expect(JSON.stringify(audit)).not.toContain(card.code);
    expect(JSON.stringify(audit)).not.toContain('Penicillin');
    const bell = await prisma.notification.findFirst({ where: { userId: owner.id, eventType: 'emergency.accessed' } });
    expect(bell.message).toContain('accessed your emergency summary');
    expect(bell.message).not.toContain('Penicillin');
    const denied = await lookup(outsider, card);
    const unknown = await lookup(outsider, { code: newEmergencyCode() });
    expect(denied.status).toBe(403); expect(unknown.body).toEqual(denied.body);
    expect(JSON.stringify(denied.body)).not.toContain(owner.id);
    expect((await lookup(member, otherCard)).status).toBe(403);
    const denialAudit = await prisma.auditEvent.findFirst({ where: { actorUserId: outsider.id, action: 'EMERGENCY_ACCESS_DENIED' } });
    expect(denialAudit.subjectUserId).toBeNull();
  });

  it.each([
    { permissions: [] }, { status: 'REVOKED', revokedAt: new Date() }, { status: 'PENDING' },
    { status: 'EXPIRED' }, { accessExpiresAt: new Date(Date.now() - 60000) }, { emergencyAccessGrantedAt: null },
  ])('denies inactive, revoked, expired or permissionless Care Circle memberships: %j', async (extra) => {
    const owner = await patient(); const member = await patient(); const card = await sharing(owner);
    await circle(owner, member, extra);
    expect((await lookup(member, card)).status).toBe(403);
  });

  it('immediately re-checks removal, scope disablement, sharing disablement and old code replacement', async () => {
    const owner = await patient(); const member = await patient(); let card = await sharing(owner);
    const relation = await circle(owner, member);
    expect((await lookup(member, card)).status).toBe(200);
    await prisma.careRelationship.update({ where: { id: relation.id }, data: { permissions: [] } });
    expect((await lookup(member, card)).status).toBe(403);
    await prisma.careRelationship.update({ where: { id: relation.id }, data: { permissions: ['EMERGENCY_SUMMARY'] } });
    expect((await as(owner).post('/replace-code', { version: card.version })).status).toBe(400);
    const replacement = await as(owner).post('/replace-code', { version: card.version, confirmation: 'REPLACE' });
    expect(replacement.status).toBe(200); expect(replacement.body.data.code).not.toBe(card.code);
    expect((await lookup(member, card)).status).toBe(403);
    expect((await as(owner).post('/replace-code', { version: card.version, confirmation: 'REPLACE' })).status).toBe(409);
    card = replacement.body.data;
    expect((await lookup(member, card)).status).toBe(200);
    await as(owner).put({ version: card.version, scopes: { careCircle: false, hospitals: true }, consentVersion: 'emergency-card-v1' });
    expect((await lookup(member, card)).status).toBe(403);
    await as(owner).put({ version: card.version, sharingEnabled: false });
    expect((await lookup(member, card)).status).toBe(403);
    expect((await as(member).post('/replace-code', { version: card.version, confirmation: 'REPLACE', userId: owner.id })).status).toBe(400);
  });

  it('requires a fresh owner grant for legacy implicit permissions, and rejects another patient changing them', async () => {
    const owner = await patient(); const member = await patient(); const other = await patient(); const card = await sharing(owner);
    const relation = await circle(owner, member, { emergencyAccessGrantedAt: null });
    expect((await lookup(member, card)).status).toBe(403);
    const change = (actor, permissions) => request(app).patch(`/api/v1/family-care/${relation.id}/permissions`).set('Authorization', actor.auth).send({ permissions });
    expect((await change(other, ['EMERGENCY_SUMMARY'])).status).not.toBe(200);
    expect((await change(owner, ['EMERGENCY_SUMMARY'])).status).toBe(200);
    expect((await prisma.careRelationship.findUnique({ where: { id: relation.id } })).emergencyAccessGrantedAt).toBeTruthy();
    expect((await lookup(member, card)).status).toBe(200);
    expect((await change(owner, [])).status).toBe(200);
    expect((await lookup(member, card)).status).toBe(403);
    await prisma.user.update({ where: { id: member.id }, data: { accountStatus: 'SUSPENDED' } });
    expect((await lookup(member, card)).status).not.toBe(200);
  });

  it('allows a verified nurse but denies unverified hospitals and removed clinical roles', async () => {
    const owner = await patient(); const card = await sharing(owner); const tenant = await createTenant(`Nurse-${randomUUID().slice(0, 8)}`);
    const nurse = await addMember(tenant, ['NURSE']); const reader = { auth: nurse.auth };
    const fields = { hospitalId: tenant.organizationId, reason: 'Emergency triage assessment' };
    expect((await lookup(reader, card, fields)).status).toBe(200);
    await prisma.organisation.update({ where: { id: tenant.facilityId }, data: { status: 'PENDING' } });
    expect((await lookup(reader, card, fields)).status).toBe(403);
    await prisma.organisation.update({ where: { id: tenant.facilityId }, data: { status: 'VERIFIED' } });
    await prisma.membershipRole.deleteMany({ where: { membership: { userId: nurse.userId } } });
    expect((await lookup(reader, card, fields)).status).toBe(403);
  });

  it('allows eligible hospital clinicians without prior enrollment; rejects administrators and suspended or removed staff', async () => {
    const owner = await patient(); const card = await sharing(owner); const tenant = await createTenant(`Emergency-${randomUUID().slice(0, 8)}`);
    const clinician = await addMember(tenant, ['DOCTOR']); const reader = { id: clinician.userId, auth: clinician.auth };
    const admin = { id: tenant.userId, auth: tenant.auth };
    const fields = { hospitalId: tenant.organizationId, reason: 'Emergency assessment of an unresponsive patient' };
    expect((await as(reader).get('/responder')).body.data.hospitals).toEqual([{ id: tenant.organizationId, name: expect.any(String) }]);
    expect((await lookup(reader, card, fields)).status).toBe(200);
    const audit = await prisma.auditEvent.findFirst({ where: { actorUserId: reader.id, action: 'EMERGENCY_SUMMARY_ACCESSED' } });
    expect(audit.context).toMatchObject({ hospitalId: tenant.organizationId, reason: fields.reason, mode: 'HOSPITAL' });
    expect((await lookup(admin, card, fields)).status).toBe(403);
    expect((await lookup(reader, card, { hospitalId: tenant.organizationId })).status).toBe(403);
    expect((await lookup(reader, card, { ...fields, hospitalId: randomUUID() })).status).toBe(403);
    await prisma.organisation.update({ where: { id: tenant.facilityId }, data: { status: 'SUSPENDED' } });
    expect((await lookup(reader, card, fields)).status).toBe(403);
    await prisma.organisation.update({ where: { id: tenant.facilityId }, data: { status: 'VERIFIED' } });
    await prisma.professionalProfile.update({ where: { userId: reader.id }, data: { verificationStatus: 'PENDING' } });
    expect((await lookup(reader, card, fields)).status).toBe(403);
    await prisma.professionalProfile.update({ where: { userId: reader.id }, data: { verificationStatus: 'VERIFIED' } });
    await prisma.organizationMembership.updateMany({ where: { userId: reader.id }, data: { status: 'SUSPENDED' } });
    expect((await lookup(reader, card, fields)).status).toBe(403);
  });

  it('does not expose unknown health data as a negative clinical finding, or include unrelated record fields', async () => {
    const owner = await patient(); const member = await patient(); const card = await sharing(owner); await circle(owner, member);
    const response = (await lookup(member, card)).body.data.summary;
    expect(response).toMatchObject({ allergies: { state: 'UNKNOWN', items: [], verification: 'UNKNOWN' }, medications: { state: 'UNKNOWN' }, bloodGroup: { value: null, verification: 'UNKNOWN' } });
    expect(response).not.toHaveProperty('insurance'); expect(response).not.toHaveProperty('consultationNotes');
    await prisma.userProfile.update({ where: { userId: owner.id }, data: { known_allergies: 'No known allergies' } });
    expect((await lookup(member, card)).body.data.summary.allergies).toMatchObject({ state: 'NO_KNOWN_RECORDED', verification: 'PATIENT_REPORTED' });
  });

  it('limits guessing and audits malformed and unauthenticated lookups without exposing codes', async () => {
    const outsider = await patient();
    expect((await request(app).post(path + '/lookup').send({ code: newEmergencyCode() })).status).toBe(401);
    for (let i = 0; i < 12; i++) expect((await lookup(outsider, { code: i === 0 ? 'malformed' : newEmergencyCode() })).status).toBe(403);
    const limited = await lookup(outsider, { code: newEmergencyCode() });
    expect(limited.status).toBe(429); expect(limited.headers['cache-control']).toContain('no-store');
    expect(await prisma.auditEvent.count({ where: { actorUserId: outsider.id, action: 'EMERGENCY_ACCESS_DENIED' } })).toBeGreaterThanOrEqual(12);
  });

  it('does not infer prescriptions are current; issued instructions are used only for a patient’s active dated schedule', async () => {
    const mock = { medicationSchedule: { findMany: async () => [
      { name: 'Reported medicine', dosage: '10 mg', instructions: 'Reported instructions', status: 'ACTIVE', updatedAt: new Date() },
      { name: 'Issued medicine', prescriptionItemId: 'issued', status: 'ACTIVE', updatedAt: new Date() },
      { name: 'Cancelled medicine', prescriptionItemId: 'cancelled', status: 'ACTIVE', updatedAt: new Date() },
    ] }, prescriptionItem: { findFirst: async ({ where }) => where.id === 'issued' ? { medicationName: 'Clinician medicine', dosage: '20 mg', frequency: 'TWICE_DAILY', route: 'ORAL', duration: '7 days', prescription: { instructions: 'With food', issuedAt: new Date() } } : null } };
    const summary = await emergencySummary(mock, { id: 'fake', full_name: 'Synthetic' }, { updated_at: new Date() });
    expect(summary.medications.items).toHaveLength(2);
    expect(summary.medications.items[1]).toMatchObject({ name: 'Clinician medicine', instructions: 'TWICE_DAILY · ORAL · 7 days · With food', verification: 'CLINICIAN_RECORDED' });
  });
});
