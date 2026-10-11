// The rest of Sabi Health and platform administration in the Command Centre, against real Postgres:
// prescriptions (clinical detail gated and audited), marketplace requests and holds, wellness,
// hospitals, laboratories, verification queue, waitlist, EMR tenant usage (counts only), roles and
// staff sessions, security, tenants and analytics. Synthetic data only.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { createTenant, tokenFor, prisma } from './fixtures.js';
import { ensureDeliveryKey, marketplacePharmacy, person } from './commerce-fixtures.js';

const CC = '/api/v1/command-centre';
const as = (user) => ({
  get: (path) => request(app).get(`${CC}${path}`).set('Authorization', tokenFor(user.id)),
  post: (path, body = {}) => request(app).post(`${CC}${path}`).set('Authorization', tokenFor(user.id)).send(body),
});

let root; let ops; let support; let clinical; let patient; let prescription; let tenant;

beforeAll(async () => {
  ensureDeliveryKey();
  root = await person('Root Admin', { platformRoles: ['SABI_SUPER_ADMIN'] });
  ops = await person('Ops Staff', { platformRoles: ['SABI_OPERATIONS'] });
  support = await person('Support Staff', { platformRoles: ['SABI_SUPPORT'] });
  clinical = await person('Clinical Staff', { platformRoles: ['SABI_CLINICAL_OVERSIGHT'] });
  patient = await person('Products Patient', { role: 'PATIENT' });
  const doctor = await person('Products Doctor', { role: 'PROFESSIONAL' });
  const profile = await prisma.professionalProfile.create({ data: { userId: doctor.id, professionType: 'DOCTOR', registrationNumber: `MDCN-${randomUUID().slice(0, 6)}`, verificationStatus: 'VERIFIED' } });
  prescription = await prisma.prescription.create({ data: { reference: `RX-${randomUUID().slice(0, 8)}`, patientId: patient.id, doctorProfileId: profile.id, status: 'ISSUED', issuedAt: new Date(),
    items: { create: [{ medicationName: 'Synthetic amoxicillin', dosage: '500 mg', frequency: 'three times daily', route: 'oral', duration: '5 days', quantity: 15, indication: 'synthetic' }] } } });
  const shop = await marketplacePharmacy();
  await prisma.prescriptionRequest.create({ data: { prescriptionId: prescription.id, patientId: patient.id, pharmacyId: shop.pharmacy.id, status: 'REQUESTED', createdAt: new Date(Date.now() - 3 * 3_600_000) } });
  await prisma.waitlistSignup.create({ data: { product: 'SABI_AI', email: `wait-${randomUUID().slice(0, 6)}@example.test`, fullName: 'Waiting Person', role: 'PROFESSIONAL', consentedAt: new Date() } });
  tenant = await createTenant(`cc-${randomUUID().slice(0, 4)}`);
});
afterAll(async () => {
  await prisma.user.updateMany({ where: { platformRoleAssignments: { some: {} }, email: { endsWith: '@command.test' } }, data: { accountStatus: 'DISABLED' } });
});

describe('Sabi Health products', () => {
  it('serves every new read endpoint without errors', async () => {
    const paths = [
      '/prescriptions', `/prescriptions/${prescription.id}`, '/marketplace/requests', '/marketplace/requests?unanswered=true', '/marketplace/holds',
      '/wellness', '/wellness?view=offerings', '/wellness?view=providers', '/hospitals', '/hospitals?view=appointments', '/hospitals?view=plans',
      '/laboratories', '/verification', '/waitlist', '/emr/tenants', '/ops/jobs?type=document-scan', '/ops/jobs/summary',
      '/access', '/sessions', '/sessions?include=all', '/security', '/tenants', '/analytics',
    ];
    for (const path of paths) {
      const res = await as(root).get(path);
      expect(res.status, `${path}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    }
  });

  it('shows prescriptions without medicines, and opens medicines only with clinical permission and a reason', async () => {
    const list = await as(ops).get(`/prescriptions?q=${prescription.reference}`);
    expect(list.body.data.items[0]).toMatchObject({ reference: prescription.reference, items: 1, pharmacyRequests: 1, stage: 'QUOTES_REQUESTED' });
    expect(JSON.stringify(list.body)).not.toContain('amoxicillin');
    const detail = await as(ops).get(`/prescriptions/${prescription.id}`);
    expect(JSON.stringify(detail.body)).not.toContain('amoxicillin');
    expect(detail.body.data.timeline.map((e) => e.text)).toEqual(expect.arrayContaining([expect.stringContaining('Quote requested')]));

    expect((await as(ops).post(`/prescriptions/${prescription.id}/items`, { reason: 'Checking a complaint' })).status).toBe(403);
    expect((await as(clinical).post(`/prescriptions/${prescription.id}/items`, {})).status).toBe(400);
    const items = await as(clinical).post(`/prescriptions/${prescription.id}/items`, { reason: 'Quality review of antibiotic prescribing' });
    expect(items.body.data.items[0].medicationName).toBe('Synthetic amoxicillin');
    expect(await prisma.auditEvent.findFirst({ where: { actorUserId: clinical.id, action: 'ADMIN_CLINICAL_VIEWED', resourceId: prescription.id } })).toMatchObject({ subjectUserId: patient.id });
  });

  it('flags unanswered quote requests, masks the waitlist, and counts EMR activity without clinical content', async () => {
    const unanswered = await as(ops).get('/marketplace/requests?unanswered=true');
    expect(unanswered.body.data.items.some((r) => r.prescription.id === prescription.id)).toBe(true);
    const waitlist = await as(ops).get('/waitlist');
    expect(waitlist.body.data.items[0].email).toMatch(/^w••••@example\.test$/);
    const tenants = await as(ops).get('/emr/tenants');
    const mine = tenants.body.data.items.find((t) => t.organizationId === tenant.organizationId);
    expect(mine).toMatchObject({ emrEnabled: true, activity: { patients: expect.any(Number), encounters30d: expect.any(Number) } });
    const verification = await as(ops).get('/verification');
    expect(Array.isArray(verification.body.data.items)).toBe(true);
    expect((await as(support).get('/emr/tenants')).status).toBe(200);
  });
});

describe('platform administration', () => {
  it('grants and removes a platform role with a reason, never to yourself or beyond your own authority', async () => {
    const access = await as(root).get('/access');
    expect(access.body.data.grantable).toEqual(expect.arrayContaining(['SABI_FINANCE', 'SABI_OPERATIONS']));
    expect(access.body.data.roles.find((r) => r.code === 'SABI_FINANCE').permissions.map((p) => p.code)).toContain('platform.finance.approve');

    expect((await as(root).post(`/access/staff/${support.id}/grant`, { roleCode: 'SABI_FINANCE' })).status).toBe(400);
    expect((await as(root).post(`/access/staff/${root.id}/grant`, { roleCode: 'SABI_FINANCE', reason: 'Give myself finance' })).body.error.code).toBe('SAME_PERSON');
    expect((await as(root).post(`/access/staff/${support.id}/grant`, { roleCode: 'SABI_SUPER_ADMIN', reason: 'Escalate support' })).body.error.code).toBe('ROLE_SCOPE_DENIED');
    expect((await as(ops).post(`/access/staff/${support.id}/grant`, { roleCode: 'SABI_FINANCE', reason: 'Not allowed' })).status).toBe(403);
    expect((await as(root).post(`/access/staff/${patient.id}/grant`, { roleCode: 'SABI_FINANCE', reason: 'Patient is not staff' })).status).toBe(404);

    const granted = await as(root).post(`/access/staff/${support.id}/grant`, { roleCode: 'SABI_FINANCE', reason: 'Covering refunds this month' });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body.data.roles).toEqual(['SABI_FINANCE', 'SABI_SUPPORT']);
    expect((await as(support).get('/finance/summary')).status).toBe(200);
    const removed = await as(root).post(`/access/staff/${support.id}/remove`, { roleCode: 'SABI_FINANCE', reason: 'Cover finished' });
    expect(removed.body.data.roles).toEqual(['SABI_SUPPORT']);
    expect((await as(support).get('/finance/summary')).status).toBe(403);
    const audit = await prisma.auditEvent.findMany({ where: { resourceType: 'platform_role', resourceId: support.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.context.after.roles)).toEqual([['SABI_FINANCE', 'SABI_SUPPORT'], ['SABI_SUPPORT']]);
  });

  it('signs a staff member out of a session and reports security posture', async () => {
    const device = await prisma.authDevice.create({ data: { userId: ops.id, label: 'Synthetic laptop' } });
    const session = await prisma.authSession.create({ data: { userId: ops.id, deviceId: device.id, expiresAt: new Date(Date.now() + 86_400_000) } });
    const list = await as(root).get('/sessions');
    expect(list.body.data.items.some((s) => s.id === session.id && s.state === 'ACTIVE')).toBe(true);
    expect((await as(root).post(`/sessions/${session.id}/revoke`, {})).status).toBe(400);
    const revoked = await as(root).post(`/sessions/${session.id}/revoke`, { reason: 'Laptop reported lost' });
    expect(revoked.body.data.state).toBe('SIGNED_OUT');
    expect((await as(root).post(`/sessions/${session.id}/revoke`, { reason: 'Again' })).status).toBe(409);
    const security = await as(root).get('/security');
    expect(security.body.data.staff.withoutTwoStep.length).toBeGreaterThan(0);
    expect((await as(ops).get('/security')).status).toBe(403);
  });

  it('lists tenants with subscription, licence, entitlements and go-live state, and weekly analytics', async () => {
    const tenants = await as(ops).get('/tenants');
    const mine = tenants.body.data.items.find((t) => t.organizationId === tenant.organizationId);
    expect(mine).toMatchObject({ provisioning: { state: 'LIVE' }, entitlements: expect.arrayContaining(['emr']), subscription: { billingCycle: 'Monthly' } });
    expect(tenants.body.data.billingNote).toMatch(/does not yet invoice/);
    const analytics = await as(ops).get('/analytics?weeks=4');
    expect(analytics.body.data.activity.length).toBeGreaterThanOrEqual(4);
  });
});
