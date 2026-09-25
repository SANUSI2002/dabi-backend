import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Real bcrypt (cost 12) is CPU-bound and times out when the whole suite runs in parallel.
vi.mock('bcryptjs', () => ({ default: { hash: async (value) => `test-password-hash:${value}`, compare: async (value, hash) => hash === `test-password-hash:${value}` } }));

const fn = () => vi.fn();
const prisma = {
  userRole: { findFirst: fn() },
  user: { create: fn(), findUnique: fn(), findFirst: fn() },
  organizationMembership: { findMany: fn() },
  careRelationship: { findMany: fn(), count: fn(), findFirst: fn(), create: fn(), update: fn(), updateMany: fn() },
  activityLog: { create: fn() }, refreshToken: { create: fn() },
  authDevice: { create: fn() }, authSession: { create: fn(), findFirst: fn() }, authRefreshCredential: { create: fn() }, $transaction: fn(),
  mfaTotp: { findUnique: fn() },
  mfaLoginChallenge: { create: fn() },
};
const sendCaregiverInvite = fn();
vi.mock('../src/config/db.js', () => ({ default: prisma }));
vi.mock('../src/modules/family-care/family-care.email.js', () => ({ sendCaregiverInvite }));
const { mapCaregiverRegistration, submitCaregiverRegistration } = await import('../src/modules/caregivers/caregivers.adapter.js');
const { default: caregiverRoutes } = await import('../src/modules/caregivers/caregivers.routes.js');
const { default: authRoutes } = await import('../src/modules/auth/auth.routes.js');
const { default: familyRoutes } = await import('../src/modules/family-care/family-care.routes.js');
const caregiverId = '11111111-1111-4111-8111-111111111111';
const patientId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const relationshipId = '44444444-4444-4444-8444-444444444444';
process.env.JWT_SECRET = 'caregiver-access-test';
process.env.JWT_REFRESH_SECRET = 'caregiver-refresh-test';
const app = express(); app.set('trust proxy', 1); app.use(express.json());
app.use('/api/v1', caregiverRoutes); app.use('/api/v1/auth', authRoutes); app.use('/api/v1/family-care', familyRoutes);
const body = () => ({
  account: { firstName: 'Ada', lastName: 'Care', email: 'ada@example.test', phone: '+234 801 234 5678', dateOfBirth: '1990-01-01', country: 'Nigeria', state: 'Lagos', city: 'Ikeja', password: 'StrongPass1!', confirmPassword: 'StrongPass1!' },
  caregiverType: 'Parent', connection: { mode: 'invite', relationship: 'Mother', inviteContact: 'patient@example.test' },
  consent: { terms: true, privacy: true },
});
let user, relationships, testIp, ipCounter = 0;
const auth = (id = caregiverId) => `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}`;
const call = (method, path, data, id = caregiverId) => {
  const req = request(app)[method](`/api/v1${path}`).set('X-Forwarded-For', testIp).set('Authorization', auth(id));
  return data === undefined ? req : req.send(data);
};
const signup = (data = body()) => request(app).post('/api/v1/auth/register/caregiver').set('X-Forwarded-For', testIp).send(data);
const match = (row, where) => Object.entries(where ?? {}).every(([key, value]) => {
  if (key === 'OR') return value.some((w) => match(row, w));
  if (value && typeof value === 'object') {
    if ('in' in value) return value.in.includes(row[key]);
    if ('isEmpty' in value) return (row[key].length === 0) === value.isEmpty;
    if ('some' in value) return row[key]?.some((r) => match(r, value.some));
  }
  return row[key] === value;
});
const select = (row, fields) => row ? Object.fromEntries(Object.entries(fields ?? row).map(([k, v]) => [k, v === true ? row[k] : fields ? select(row[k], v.select) : v])) : null;
beforeEach(() => {
  vi.clearAllMocks(); user = null; relationships = []; testIp = `203.0.113.${++ipCounter}`;
  prisma.userRole.findFirst.mockImplementation(async ({ where }) => where.userId === patientId && where.role === 'PATIENT' ? { id: 'patient-role' } : null);
  prisma.user.create.mockImplementation(async ({ data }) => {
    if (user) throw Object.assign(new Error('duplicate secret'), { code: 'P2002' });
    user = { ...data, id: caregiverId, accountStatus: 'ACTIVE', profile: null, roles: [{ role: data.roles.create.role }], caregiverProfile: { ...data.caregiverProfile.create, createdAt: new Date() } };
    return user;
  });
  prisma.user.findUnique.mockImplementation(async ({ where, select: fields }) => {
    const found = where.id === patientId ? { id: patientId, email: 'patient@example.test' } : where.id === otherId ? { id: otherId, email: 'other@example.test' } : user && (where.id === user.id || where.email === user.email) ? user : null;
    return fields ? select(found, fields) : found;
  });
  prisma.user.findFirst.mockImplementation(async ({ where }) => user && match(user, where) ? user : null);
  prisma.careRelationship.findFirst.mockImplementation(async ({ where, select: fields }) => select(relationships.find((r) => match(r, where)), fields));
  prisma.careRelationship.findMany.mockImplementation(async ({ where, select: fields }) => relationships.filter((r) => match(r, where)).map((r) => select(r, fields)));
  prisma.careRelationship.count.mockImplementation(async ({ where }) => relationships.filter((r) => match(r, where)).length);
  prisma.careRelationship.create.mockImplementation(async ({ data, select: fields }) => {
    const row = { id: relationshipId, caregiverId: null, status: 'PENDING', revokedAt: null, createdAt: new Date(), ...data }; relationships.push(row); return select(row, fields);
  });
  prisma.careRelationship.update.mockImplementation(async ({ where, data, select: fields }) => { const row = relationships.find((r) => match(r, where)); Object.assign(row, data); return select(row, fields); });
  prisma.careRelationship.updateMany.mockImplementation(async ({ where, data }) => { const rows = relationships.filter((r) => match(r, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; });
  prisma.$transaction.mockImplementation((work) => work(prisma));
  prisma.authDevice.create.mockResolvedValue({ id: '55555555-5555-4555-8555-555555555555' });
  prisma.authSession.create.mockResolvedValue({ id: '66666666-6666-4666-8666-666666666666' });
  prisma.authSession.findFirst.mockResolvedValue({ id: '66666666-6666-4666-8666-666666666666' });
  prisma.authRefreshCredential.create.mockResolvedValue({}); prisma.activityLog.create.mockResolvedValue({});
  prisma.mfaTotp.findUnique.mockResolvedValue(null);
  prisma.mfaLoginChallenge.create.mockResolvedValue({});
  prisma.organizationMembership.findMany.mockResolvedValue([]);
});

describe('design-backed caregiver registration', () => {
  it('registers required visible fields atomically with a hashed password and server-only role/consent', async () => {
    const input = body(); input.account.email = 'ADA@example.test';
    const response = await signup(input); expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ email: 'ada@example.test', roles: ['CAREGIVER'] });
    expect(response.body.onboarding).toEqual({ status: 'AWAITING_PATIENT_INVITATION', linkedPatients: [] });
    expect(await bcrypt.compare(input.account.password, user.password)).toBe(true);
    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('profile'); expect(data).not.toHaveProperty('healthMetrics');
    expect(data.roles).toEqual({ create: { role: 'CAREGIVER' } });
    expect(data.caregiverProfile.create).toMatchObject({ termsAcceptedAt: expect.any(Date), privacyAcceptedAt: expect.any(Date), consentVersion: '1.0', connectionReference: input.connection.inviteContact });
    expect(data.patientId).toMatch(/^CG-/);
    expect(JSON.stringify(response.body)).not.toMatch(/password|confirmPassword|patientId/);
    expect(prisma.careRelationship.create).not.toHaveBeenCalled(); expect(sendCaregiverInvite).not.toHaveBeenCalled();
  });
  it('supports connect intent without looking up, linking, or exposing the named patient', async () => {
    const input = body(); input.connection = { mode: 'connect', relationship: 'Home nurse', patientReference: '#SHM12345' };
    input.caregiverType = 'Professional caregiver';
    expect((await signup(input)).status).toBe(201);
    expect(user.caregiverProfile.connectionReference).toBe('#SHM12345');
    expect(prisma.user.findUnique).not.toHaveBeenCalled(); expect(prisma.careRelationship.create).not.toHaveBeenCalled();
    expect(user.roles).toEqual([{ role: 'CAREGIVER' }]);
  });
  it('returns 409 for a duplicate account without replacing the original', async () => {
    expect((await signup()).status).toBe(201); const original = user;
    expect((await signup()).status).toBe(409); expect(user).toBe(original);
  });
  it.each(['firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'country', 'state', 'city', 'password', 'confirmPassword'])('requires visible account field %s', async (field) => {
    const input = body(); delete input.account[field]; expect((await signup(input)).status).toBe(400); expect(prisma.user.create).not.toHaveBeenCalled();
  });
  it.each(['short', 'lowercase1!', 'UPPERCASE1!', 'NoNumber!!', 'NoSpecial1'])('enforces the visible password checklist: %s', async (password) => {
    const input = body(); input.account.password = password; input.account.confirmPassword = password; expect((await signup(input)).status).toBe(400);
  });
  it.each([
    ['email', 'not-email'], ['dateOfBirth', '2026-02-30'], ['country', 'Not an option'], ['firstName', '   '], ['confirmPassword', 'Different1!'],
  ])('rejects invalid %s', async (field, value) => { const input = body(); input.account[field] = value; expect((await signup(input)).status).toBe(400); });
  it.each(['caregiverType', 'connection', 'consent'])('requires visible step %s', async (field) => { const input = body(); delete input[field]; expect((await signup(input)).status).toBe(400); });
  it('requires both consents and only the chosen connection input', async () => {
    for (const field of ['terms', 'privacy']) { const input = body(); input.consent[field] = false; expect((await signup(input)).status).toBe(400); }
    const input = body(); input.connection.inviteContact = ''; expect((await signup(input)).status).toBe(400);
    input.connection = { mode: 'connect', relationship: 'Mother' }; expect((await signup(input)).status).toBe(400);
    input.connection = { mode: 'invite', inviteContact: 'patient@example.test' }; expect((await signup(input)).status).toBe(400);
  });
  it.each(['role', 'roles', 'verificationStatus', 'SUPER_ADMIN', 'patientId', 'permissions', 'caregiverId', 'onboardingStatus'])('rejects client authority injection %s at every request level', async (field) => {
    for (const container of ['root', 'account', 'connection', 'consent']) {
      const input = body(); (container === 'root' ? input : input[container])[field] = 'SUPER_ADMIN';
      expect((await signup(input)).status).toBe(400);
    }
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
  it('rate limits signup by IP even when email changes, before persistence', async () => {
    for (let i = 0; i < 5; i++) { const input = body(); input.account.email = `invalid-${i}`; expect((await signup(input)).status).toBe(400); }
    const response = await signup(); expect(response.status).toBe(429); expect(response.body.code).toBe('RATE_LIMIT_CAREGIVER-REGISTRATION');
    expect(response.headers['retry-after']).toBeDefined(); expect(prisma.user.create).not.toHaveBeenCalled();
  });
  it('returns a generic safe database failure without signup success', async () => {
    prisma.user.create.mockRejectedValueOnce(new Error('database password secret'));
    const response = await signup(); expect(response.status).toBe(500); expect(response.body).toEqual({ status: 'error', message: 'Caregiver service temporarily unavailable' });
    expect(user).toBeNull(); expect(relationships).toEqual([]);
  });
});

describe('caregiver sessions and patient-controlled invitation integration', () => {
  it('withholds access and refresh tokens until enrolled MFA is verified', async () => {
    await signup();
    prisma.mfaTotp.findUnique.mockResolvedValue({ enabledAt: new Date() });
    const response = await call('post', '/auth/login', { email: user.email, password: body().account.password });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'mfa_required', challengeToken: expect.any(String) });
    expect(response.body).not.toHaveProperty('accessToken');
    expect(response.body).not.toHaveProperty('refreshToken');
    expect(prisma.authSession.create).not.toHaveBeenCalled();
  });
  it('supports real login/current user and starts with no linked patients or access', async () => {
    await signup();
    const login = await call('post', '/auth/login', { email: user.email, password: body().account.password });
    expect(login.status).toBe(200); expect(login.body.user.roles).toEqual(['CAREGIVER']); expect(login.body.user.caregiverProfile.caregiverType).toBe('Parent');
    expect(prisma.authRefreshCredential.create).toHaveBeenCalled();
    expect(prisma.authRefreshCredential.create.mock.calls[0][0].data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200); expect(me.body.user.caregiverProfile.country).toBe('Nigeria'); expect(JSON.stringify(me.body)).not.toContain('password');
    expect((await call('get', '/caregivers/me')).body.data.onboarding).toEqual({ status: 'AWAITING_PATIENT_INVITATION', linkedPatients: [] });
    expect((await call('get', '/family-care')).body.data.items).toEqual([]);
    expect((await call('get', `/family-care/access/${patientId}`)).body.data.permissions).toEqual([]);
    expect((await call('post', '/auth/login', { email: user.email, password: 'Wrong1!' })).status).toBe(401);
  });
  it('activates only through a patient-issued invitation, with explicit permissions controlled by that patient', async () => {
    await signup();
    expect((await call('post', '/family-care/invitations', { email: user.email, relationshipType: 'CAREGIVER', permissions: ['VITALS'] })).status).toBe(403);
    const invited = await call('post', '/family-care/invitations', { email: user.email, relationshipType: 'CAREGIVER', permissions: ['VITALS'] }, patientId);
    expect(invited.status).toBe(201); const token = sendCaregiverInvite.mock.calls[0][0].token;
    expect((await call('get', '/caregivers/me')).body.data.onboarding.linkedPatients).toEqual([]);
    expect((await call('get', `/family-care/access/${patientId}`)).body.data.permissions).toEqual([]);
    expect((await call('post', '/family-care/invitations/accept', { token }, otherId)).status).toBe(404);
    expect((await call('post', '/family-care/invitations/accept', { token })).status).toBe(200);
    expect((await call('post', '/family-care/invitations/accept', { token })).status).toBe(404);
    const linked = await call('get', '/caregivers/me'); expect(linked.body.data.onboarding.status).toBe('LINKED');
    expect(linked.body.data.onboarding.linkedPatients).toEqual([{ id: relationshipId, patientId, permissions: ['VITALS'] }]);
    expect((await call('patch', `/family-care/${relationshipId}/permissions`, { permissions: ['RECORDS'] })).status).toBe(404);
    expect((await call('patch', `/family-care/${relationshipId}/permissions`, { permissions: [] }, patientId)).status).toBe(200);
    expect((await call('get', '/caregivers/me')).body.data.onboarding.linkedPatients).toEqual([]);
    await call('patch', `/family-care/${relationshipId}/permissions`, { permissions: ['VITALS'] }, patientId);
    expect((await call('get', `/family-care/access/${patientId}`)).body.data.permissions).toEqual(['VITALS']);
    expect((await call('delete', `/family-care/${relationshipId}`, undefined, patientId)).status).toBe(200);
    expect((await call('get', `/family-care/access/${patientId}`)).body.data.permissions).toEqual([]);
    expect((await call('get', '/caregivers/me')).body.data.onboarding.linkedPatients).toEqual([]);
  });
  it.each(['expired', 'declined', 'invalid'])('does not activate a patient link from %s invitations', async (scenario) => {
    await signup(); await call('post', '/family-care/invitations', { email: user.email, relationshipType: 'CAREGIVER', permissions: ['VITALS'] }, patientId);
    const token = sendCaregiverInvite.mock.calls[0][0].token;
    if (scenario === 'expired') relationships[0].expiresAt = new Date(0);
    if (scenario === 'declined') expect((await call('post', '/family-care/invitations/decline', { token })).status).toBe(200);
    const response = await call('post', '/family-care/invitations/accept', { token: scenario === 'invalid' ? 'x'.repeat(64) : token });
    expect(response.status).toBe(scenario === 'expired' ? 410 : 404);
    expect((await call('get', '/caregivers/me')).body.data.onboarding.linkedPatients).toEqual([]);
  });
  it.each([undefined, 'Bearer bad', `Bearer ${jwt.sign({ userId: caregiverId }, 'wrong')}`, `Bearer ${jwt.sign({ userId: caregiverId }, process.env.JWT_SECRET, { expiresIn: -1 })}`])('rejects token failure %s without DB reads', async (token) => {
    for (const path of ['/caregivers/me', '/auth/me', '/family-care']) {
      let req = request(app).get(`/api/v1${path}`); if (token) req = req.set('Authorization', token);
      expect((await req).status).toBe(401);
    }
    expect(prisma.user.findFirst).not.toHaveBeenCalled(); expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
  it('denies non-caregivers and handles profile DB errors without leaking data', async () => {
    expect((await call('get', '/caregivers/me', undefined, otherId)).status).toBe(403);
    prisma.user.findFirst.mockRejectedValueOnce(new Error('SQL secret'));
    const response = await call('get', '/caregivers/me'); expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain('SQL');
  });
});


describe('live frontend adapter mapping', () => {
  it('renames only the patient reference and omits the inactive connection control', async () => {
    const form = body(); form.connection = { mode: 'connect', patientId: '#SHM12345', inviteContact: '', relationship: 'Mother' };
    expect(mapCaregiverRegistration(form).connection).toEqual({ mode: 'connect', patientReference: '#SHM12345', relationship: 'Mother' });
    expect((await signup(mapCaregiverRegistration(form))).status).toBe(201);
  });
  it('uses the caregiver endpoint and surfaces API/network failures without false success', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'success' }) });
    expect(await submitCaregiverRegistration(body(), fetcher)).toEqual({ status: 'success' });
    expect(fetcher).toHaveBeenCalledWith('/api/v1/auth/register/caregiver', expect.objectContaining({ method: 'POST' }));
    fetcher.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ message: 'Duplicate' }) });
    await expect(submitCaregiverRegistration(body(), fetcher)).rejects.toMatchObject({ status: 409 });
    fetcher.mockRejectedValueOnce(new Error('Network unavailable'));
    await expect(submitCaregiverRegistration(body(), fetcher)).rejects.toThrow('Network unavailable');
    expect(() => mapCaregiverRegistration({ ...body(), role: 'SUPER_ADMIN' })).toThrow('Unexpected');
  });
});
