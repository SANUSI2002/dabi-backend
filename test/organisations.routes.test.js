import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Buffer } from 'node:buffer';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const model = () => Object.fromEntries(['create', 'findUnique', 'findFirst', 'findMany', 'count', 'updateMany', 'update'].map((key) => [key, vi.fn()]));
const prisma = { user: model(), userRole: model(), organisation: model(), organisationSubmission: model(), organisationDocument: model(), pharmacy: model(), identityOrganization: model(), organizationMembership: model(), membershipRole: model(), activityLog: model(), refreshToken: model(), authDevice: model(), authSession: model(), authRefreshCredential: model(), mfaTotp: model(), $transaction: vi.fn() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/organisations/organisations.routes.js');
const { default: pharmacyRoutes } = await import('../src/modules/pharmacies/pharmacies.routes.js');
const { default: authRoutes } = await import('../src/modules/auth/auth.routes.js');
const { mapOrganisationRegistration, submitOrganisationRegistration } = await import('../src/modules/organisations/organisations.adapter.js');
const { authorities } = await import('../src/modules/organisations/organisations.validator.js');
const owner = '11111111-1111-4111-8111-111111111111';
const admin = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const id = '44444444-4444-4444-8444-444444444444';
const submissionId = '55555555-5555-4555-8555-555555555555';
const compliance = '66666666-6666-4666-8666-666666666666';
process.env.JWT_SECRET = 'organisation-test-secret';
process.env.JWT_REFRESH_SECRET = 'organisation-refresh-test';
const app = express(); app.set('trust proxy', 1); app.use('/api/v1/organisations', routes); app.use(express.json()); app.use('/api/v1/pharmacies', pharmacyRoutes); app.use('/api/v1/auth', authRoutes);
const doc = () => ({ name: 'evidence.pdf', contentType: 'application/pdf', base64: Buffer.from('%PDF-1.4\nprivate-evidence').toString('base64') });
const body = (type = 'hospital') => ({ organisationType: type, organisation: { entityName: 'Sabi Hospital', legalName: 'Sabi Health Ltd', country: 'Nigeria', state: 'Lagos', city: 'Ikeja', address: '1 Health St', phone: '+234 801 234 5678', email: 'facility@example.test' }, representative: { firstName: 'Ada', lastName: 'Owner', phone: '+234 801 234 5678', email: 'owner@example.test', position: 'Owner', password: 'Abcdef1!', confirmPassword: 'Abcdef1!' }, regulatory: { registrationNumber: 'LIC-100', regulatoryAuthority: authorities[type][0] }, documents: { businessRegistration: doc(), representativeId: doc(), ...(type === 'other' ? {} : type === 'pharmacy' ? { pharmacyLicense: doc() } : { facilityLicense: doc() }) }, consent: { terms: true, privacy: true } });
let db, ip, n = 0;
const auth = (userId) => `Bearer ${jwt.sign({ userId, roles: ['SUPER_ADMIN'] }, process.env.JWT_SECRET)}`;
const call = (method, path, data, actor = owner) => {
  const req = request(app)[method](`/api/v1/organisations${path}`).set('X-Forwarded-For', ip);
  if (actor) req.set('Authorization', auth(actor));
  return data === undefined ? req : req.send(data);
};
const signup = (input = body()) => call('post', '/register', input, null);
const match = (row, where) => Object.entries(where ?? {}).every(([key, value]) => {
  if (key === 'OR') return value.some((v) => match(row, v));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if ('contains' in value) return row[key]?.toLowerCase().includes(value.contains.toLowerCase());
  }
  return row[key] instanceof Date && value instanceof Date ? row[key].getTime() === value.getTime() : row[key] === value;
});
const select = (row, fields) => row ? Object.fromEntries(Object.entries(fields ?? {}).map(([key, value]) => [key, value === true ? row[key] : Array.isArray(row[key]) ? row[key].map((v) => select(v, value.select)) : select(row[key], value.select)])) : null;
const relation = (row) => ({ ...row, onboarding: db.submissions.find((s) => s.organisationId === row.id || s.pharmacyId === row.id) ?? null });
beforeEach(() => {
  vi.resetAllMocks(); ip = `203.0.113.${++n}`;
  db = { users: [], organisations: [], pharmacies: [], submissions: [], documents: [], audit: [], roles: [{ userId: admin, role: 'SUPER_ADMIN' }, { userId: compliance, role: 'PHARMACY_COMPLIANCE_ADMIN' }] };
  prisma.userRole.findFirst.mockImplementation(async ({ where }) => db.roles.find((r) => match(r, where)) ?? null);
  prisma.user.create.mockImplementation(async ({ data, select: fields }) => {
    if (db.users.some((u) => u.email === data.email)) throw Object.assign(new Error('private duplicate'), { code: 'P2002' });
    const row = { ...data, id: owner, accountStatus: 'ACTIVE', roles: [{ role: data.roles.create.role }], profile: null };
    db.users.push(row); db.roles.push({ userId: owner, role: data.roles.create.role }); return select(row, fields);
  });
  prisma.user.findUnique.mockImplementation(async ({ where, select: fields }) => { const row = db.users.find((u) => match(u, where)); return fields ? select(row, fields) : row ?? null; });
  for (const [modelName, table] of [['organisation', 'organisations'], ['pharmacy', 'pharmacies']]) {
    prisma[modelName].create.mockImplementation(async ({ data, select: fields }) => { const row = { id, status: 'PENDING', complianceStatus: 'PENDING', createdAt: new Date(), updatedAt: new Date(), ...data }; db[table].push(row); return select(row, fields); });
    prisma[modelName].findFirst.mockImplementation(async ({ where, select: fields }) => { const row = db[table].find((r) => match(r, where)); return row ? select(relation(row), fields) : null; });
    prisma[modelName].findUnique.mockImplementation(prisma[modelName].findFirst);
    prisma[modelName].findMany.mockImplementation(async ({ where, select: fields, skip = 0, take = 20 }) => db[table].filter((r) => match(r, where)).slice(skip, skip + take).map((r) => select(relation(r), fields)));
    prisma[modelName].count.mockImplementation(async ({ where }) => db[table].filter((r) => match(r, where)).length);
    prisma[modelName].updateMany.mockImplementation(async ({ where, data }) => { const rows = db[table].filter((r) => match(r, where)); rows.forEach((r) => Object.assign(r, data, { updatedAt: new Date() })); return { count: rows.length }; });
    prisma[modelName].update.mockImplementation(async ({ where, data, select: fields }) => { const row = db[table].find((r) => match(r, where)); Object.assign(row, data); return select(row, fields); });
  }
  prisma.organisationSubmission.create.mockImplementation(async ({ data, select: fields }) => { const documents = data.documents.create.map((d) => ({ ...d, submissionId })); const row = { ...data, id: submissionId, documents }; db.submissions.push(row); db.documents.push(...documents); return select(row, fields); });
  prisma.organisationSubmission.findUnique.mockImplementation(async ({ where }) => { const row = db.submissions.find((r) => r.id === where.id); return row ? { organisation: db.organisations.find((o) => o.id === row.organisationId) ?? null, pharmacy: db.pharmacies.find((p) => p.id === row.pharmacyId) ?? null } : null; });
  prisma.organisationDocument.findUnique.mockImplementation(async ({ where }) => db.documents.find((d) => match(d, where.submissionId_key)) ?? null);
  prisma.activityLog.create.mockImplementation(async ({ data }) => { db.audit.push(data); return data; });
  prisma.identityOrganization.create.mockResolvedValue({ id: '77777777-7777-4777-8777-777777777777' });
  prisma.organizationMembership.create.mockResolvedValue({ id: '88888888-8888-4888-8888-888888888888' });
  prisma.organizationMembership.findMany.mockResolvedValue([]);
  prisma.membershipRole.create.mockResolvedValue({});
  prisma.refreshToken.create.mockResolvedValue({});
  prisma.authDevice.create.mockResolvedValue({ id: '99999999-9999-4999-8999-999999999999' });
  prisma.authSession.create.mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  prisma.authSession.findFirst.mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  prisma.authRefreshCredential.create.mockResolvedValue({});
  prisma.mfaTotp.findUnique.mockResolvedValue(null);
  prisma.$transaction.mockImplementation(async (work) => {
    const snapshot = globalThis.structuredClone(db);
    try { return await work(prisma); } catch (error) { db = snapshot; throw error; }
  });
});

describe('live organisation signup and owner linkage', () => {
  it.each(['hospital', 'clinic', 'laboratory', 'diagnostic-centre', 'other'])('registers %s from required visible fields only', async (type) => {
    const input = body(type); input.representative.email = 'OWNER@EXAMPLE.TEST';
    const response = await signup(input); expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ status: 'PENDING', organisationType: type, verificationAuthority: 'SUPER_ADMIN', owner: { id: owner, email: 'owner@example.test', role: 'ORGANISATION_OWNER' } });
    expect(await bcrypt.compare(input.representative.password, db.users[0].password)).toBe(true);
    expect(db.roles.filter((r) => r.userId === owner)).toEqual([{ userId: owner, role: 'ORGANISATION_OWNER' }]);
    expect(db.users[0].patientId).toMatch(/^ORG-/); expect(db.submissions[0].healthDataAcceptedAt).toBeNull();
    expect(JSON.stringify(db.submissions)).not.toMatch(/password|confirmPassword/);
    expect(JSON.stringify(response.body)).not.toMatch(/base64|password|contentType|registrationNumber/);
    expect(db.pharmacies).toEqual([]);
  });
  it('retains optional Hospital services and server timestamps, with no clinical access grant', async () => {
    const input = body(); input.services = ['Surgery', 'Maternity']; input.consent.healthData = true;
    expect((await signup(input)).status).toBe(201);
    expect(db.submissions[0].details.services).toEqual(input.services);
    expect(db.submissions[0].healthDataAcceptedAt).toBeInstanceOf(Date);
    expect(db.audit).toHaveLength(1); expect(db.audit[0].meta).toEqual({ organisationId: id });
    expect(db.users[0]).not.toHaveProperty('healthMetrics');
  });
  it('reuses the existing pharmacy owner, table, registration audit and compliance authority', async () => {
    const input = body('pharmacy'); input.organisation.website = 'https://example.test'; input.operatingInfo = { openingHours: '24 hours', delivery: true, pickup: false };
    expect((await signup(input)).body.data).toMatchObject({ status: 'PENDING', verificationAuthority: 'PHARMACY_COMPLIANCE_ADMIN', owner: { role: 'PHARMACY_ADMIN' } });
    expect(db.organisations).toEqual([]); expect(db.pharmacies).toHaveLength(1); expect(db.submissions[0].pharmacyId).toBe(id);
    expect((await call('get', '/mine')).body.data.status).toBe('PENDING');
    expect((await call('post', `/admin/${id}/approve`, {}, admin)).status).toBe(404);
    expect((await call('get', `/pharmacy-compliance/${id}`, undefined, admin)).status).toBe(404);
    expect((await call('get', `/pharmacy-compliance/${id}`, undefined, compliance)).status).toBe(200);
    const decide = (actor) => request(app).post(`/api/v1/pharmacies/compliance/${id}/decision`).set('Authorization', auth(actor)).send({ status: 'VERIFIED' });
    expect((await decide(admin)).status).toBe(404); expect((await decide(compliance)).status).toBe(200);
    expect((await request(app).get(`/api/v1/pharmacies/${id}`)).status).toBe(200);
    expect((await call('get', `/${id}`, undefined, null)).status).toBe(404);
  });
  it('rejects duplicate owner email and rolls back a repeated signup', async () => {
    await signup(); expect((await signup()).status).toBe(409); expect(db.users).toHaveLength(1); expect(db.submissions).toHaveLength(1);
  });
  it('supports existing login/current-user and restricts mine to the owner', async () => {
    await signup();
    const login = await request(app).post('/api/v1/auth/login').send({ email: body().representative.email, password: body().representative.password });
    expect(login.status).toBe(200); expect(login.body.user.roles).toEqual(['ORGANISATION_OWNER']);
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200); expect(me.body.user.roles).toEqual(['ORGANISATION_OWNER']);
    expect((await call('get', '/mine')).body.data.onboarding.documents).toHaveLength(3);
    for (const actor of [other, admin, compliance]) expect((await call('get', '/mine', undefined, actor)).status).toBe(404);
    expect((await call('get', `/mine?ownerId=${owner}`)).status).toBe(400);
  });
  it.each(['role', 'roles', 'status', 'verificationStatus', 'ownerId', 'complianceStatus', 'SUPER_ADMIN'])('rejects injected %s at all writable levels', async (field) => {
    for (const container of ['root', 'organisation', 'representative', 'regulatory', 'consent']) {
      const input = body(); (container === 'root' ? input : input[container])[field] = 'SUPER_ADMIN';
      expect((await signup(input)).status).toBe(400);
    }
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
  it.each(['entityName', 'legalName', 'country', 'state', 'city', 'address', 'phone', 'email'])('requires visible organisation %s', async (field) => {
    const input = body(); delete input.organisation[field]; expect((await signup(input)).status).toBe(400);
  });
  it.each(['firstName', 'lastName', 'phone', 'email', 'position', 'password', 'confirmPassword'])('requires visible representative %s', async (field) => {
    const input = body(); delete input.representative[field]; expect((await signup(input)).status).toBe(400);
  });
  it.each(['short', 'abcdefgh1!', 'ABCDEFGH1!', 'Abcdefgh!!', 'Abcdefgh12'])('enforces the visible password checklist: %s', async (password) => {
    const input = body(); input.representative.password = password; input.representative.confirmPassword = password; expect((await signup(input)).status).toBe(400);
  });
  it.each([
    (v) => { v.representative.confirmPassword = 'different'; },
    (v) => { v.organisation.email = 'invalid'; },
    (v) => { v.organisation.country = 'invented'; },
    (v) => { v.organisation.entityName = '   '; },
    (v) => { v.organisationType = 'SUPER_ADMIN'; },
    (v) => { v.regulatory.regulatoryAuthority = 'PCN (Pharmacists Council of Nigeria)'; },
    (v) => { v.regulatory.registrationNumber = ''; },
    (v) => { v.documents.businessRegistration.base64 = 'not base64'; },
    (v) => { v.documents.businessRegistration.base64 = Buffer.from('<html>bad</html>').toString('base64'); },
    (v) => { v.documents.businessRegistration.name = '../secret.pdf'; },
    (v) => { delete v.documents.facilityLicense; },
    (v) => { v.documents.representativeId.contentType = 'image/png'; },
    (v) => { v.documents.representativeId.base64 = Buffer.alloc(5 * 1024 * 1024 + 1, 65).toString('base64'); },
    (v) => { v.consent.terms = false; },
    (v) => { v.consent.privacy = false; },
    (v) => { v.consent.timestamp = '2026-01-01'; },
    (v) => { v.operatingInfo = { delivery: true }; },
  ])('rejects invalid data before persistence %#', async (mutate) => { const input = body(); mutate(input); expect((await signup(input)).status).toBe(400); expect(prisma.user.create).not.toHaveBeenCalled(); });
  it('accepts a valid document at the 5 MiB boundary', async () => {
    const input = body(); const bytes = Buffer.alloc(5 * 1024 * 1024, 65); bytes.write('%PDF-1.4');
    input.documents.businessRegistration.base64 = bytes.toString('base64');
    expect((await signup(input)).status).toBe(201);
    expect(db.documents.find((d) => d.key === 'businessRegistration').content.length).toBe(bytes.length);
  });
  it('rate limits registration by IP despite changing email', async () => {
    for (let i = 0; i < 5; i++) { const input = body(); input.representative.email = `invalid-${i}`; expect((await signup(input)).status).toBe(400); }
    const response = await signup(); expect(response.status).toBe(429); expect(response.headers['retry-after']).toBeDefined(); expect(prisma.user.create).not.toHaveBeenCalled();
  });
  it.each(['create-owner', 'create-org', 'create-submission', 'audit'])('rolls back signup on safe database failure: %s', async (stage) => {
    const target = { 'create-owner': prisma.user.create, 'create-org': prisma.organisation.create, 'create-submission': prisma.organisationSubmission.create, audit: prisma.activityLog.create }[stage];
    target.mockRejectedValueOnce(new Error('private connection/password info'));
    const response = await signup(); expect(response.status).toBe(500); expect(response.body).toEqual({ status: 'error', message: 'Organisation service temporarily unavailable' });
    expect(db.users).toEqual([]); expect(db.organisations).toEqual([]); expect(db.submissions).toEqual([]); expect(db.audit).toEqual([]);
  });
  it('rolls back the reused pharmacy account if evidence persistence fails', async () => {
    prisma.organisationSubmission.create.mockRejectedValueOnce(new Error('private'));
    expect((await signup(body('pharmacy'))).status).toBe(500); expect(db.users).toEqual([]); expect(db.pharmacies).toEqual([]); expect(db.audit).toEqual([]);
  });
});

describe('review, eligibility and private document boundaries', () => {
  it('supports queue/detail and approve, suspend, reactivate with immediate verified-only visibility', async () => {
    expect((await call('get', '/', undefined, null)).body.data).toEqual({ items: [], page: 1, limit: 20, total: 0 });
    await signup(); expect((await call('get', '/', undefined, null)).body.data.items).toEqual([]);
    expect((await call('get', `/${id}`, undefined, null)).status).toBe(404);
    expect((await call('get', '/admin', undefined, admin)).body.data.total).toBe(1);
    expect((await call('get', `/admin/${id}`, undefined, admin)).body.data.onboarding.details.legalName).toBe('Sabi Health Ltd');
    for (const action of ['approve', 'suspend', 'reactivate']) {
      const result = await call('post', `/admin/${id}/${action}`, { note: 'Reviewed' }, admin); expect(result.status).toBe(200);
      const visible = action !== 'suspend';
      expect((await call('get', `/${id}`, undefined, null)).status).toBe(visible ? 200 : 404);
      const listing = await call('get', '/?type=hospital&search=Ikeja', undefined, null);
      expect(listing.body.data.total).toBe(visible ? 1 : 0);
      expect(JSON.stringify(listing.body)).not.toMatch(/ownerId|onboarding|representative|regulatory|decisionNote|password|content/);
    }
    expect(db.audit.map((a) => a.type)).toEqual(['ORGANISATION_REGISTERED', 'ORGANISATION_VERIFIED', 'ORGANISATION_SUSPENDED', 'ORGANISATION_VERIFIED']);
    expect((await call('get', '/admin?status=VERIFIED', undefined, admin)).body.data.total).toBe(1);
  });
  it('rejects and permits later approval; rejects repeated and invalid transitions', async () => {
    await signup();
    for (const action of ['suspend', 'reactivate']) expect((await call('post', `/admin/${id}/${action}`, {}, admin)).status).toBe(409);
    expect((await call('post', `/admin/${id}/reject`, { note: 'Document unreadable' }, admin)).status).toBe(200);
    expect((await call('get', `/${id}`, undefined, null)).status).toBe(404);
    expect((await call('post', `/admin/${id}/reject`, {}, admin)).status).toBe(409);
    expect((await call('post', `/admin/${id}/approve`, {}, admin)).status).toBe(200);
    expect((await call('post', `/admin/${id}/approve`, {}, admin)).status).toBe(409);
  });
  it('denies owner, patient, pharmacy compliance and token-claimed Super Admin authority; forbids self approval', async () => {
    await signup();
    for (const actor of [owner, other, compliance]) {
      expect((await call('get', '/admin', undefined, actor)).status).toBe(404);
      for (const action of ['approve', 'reject', 'suspend', 'reactivate']) expect((await call('post', `/admin/${id}/${action}`, {}, actor)).status).toBe(404);
    }
    db.roles.push({ userId: owner, role: 'SUPER_ADMIN' });
    expect((await call('post', `/admin/${id}/approve`, {}, owner)).status).toBe(404);
    db.roles = db.roles.filter((r) => r.userId !== admin);
    expect((await call('post', `/admin/${id}/approve`, {}, admin)).status).toBe(404);
    expect(prisma.organisation.updateMany).not.toHaveBeenCalled();
  });
  it('restricts document bytes to owner or the correct verification authority', async () => {
    await signup(); const path = `/submissions/${submissionId}/documents/representativeId`;
    for (const actor of [owner, admin]) {
      const response = await call('get', path, undefined, actor); expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers['content-disposition']).toMatch(/^attachment/); expect(Buffer.from(response.body).toString()).toBe('%PDF-1.4\nprivate-evidence');
    }
    for (const actor of [other, compliance]) expect((await call('get', path, undefined, actor)).status).toBe(404);
    expect(prisma.organisationDocument.findUnique).toHaveBeenCalledTimes(2);
    expect((await call('get', path.replace(submissionId, other))).status).toBe(404);
  });
  it('prevents Super Admin reading pharmacy documents without compliance role', async () => {
    await signup(body('pharmacy')); const path = `/submissions/${submissionId}/documents/pharmacyLicense`;
    expect((await call('get', path, undefined, admin)).status).toBe(404);
    expect((await call('get', path, undefined, compliance)).status).toBe(200);
  });
  it('rolls back a decision when audit fails and rejects competing decisions', async () => {
    await signup(); prisma.activityLog.create.mockRejectedValueOnce(new Error('private audit'));
    expect((await call('post', `/admin/${id}/approve`, {}, admin)).status).toBe(500); expect(db.organisations[0].status).toBe('PENDING');
    prisma.organisation.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await call('post', `/admin/${id}/approve`, {}, admin)).status).toBe(409); expect(db.audit).toHaveLength(1);
  });
  it.each(['', 'Bearer invalid', `Bearer ${jwt.sign({ userId: owner }, 'wrong-secret')}`, `Bearer ${jwt.sign({ userId: owner }, process.env.JWT_SECRET, { expiresIn: -1 })}`])('rejects missing or bad tokens %s', async (authorization) => {
    for (const path of ['/mine', '/admin', `/admin/${id}`, `/submissions/${submissionId}/documents/representativeId`]) {
      const req = request(app).get(`/api/v1/organisations${path}`); if (authorization) req.set('Authorization', authorization); expect((await req).status).toBe(401);
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rejects invalid filters, extra owner/status inputs, malformed ids and decision bodies', async () => {
    for (const path of ['/?status=PENDING', '/?type=pharmacy', '/?page=0', '/?limit=101', '/?search=', '/admin?status=INVALID', '/admin?ownerId=other', '/bad-id']) expect((await call('get', path, undefined, admin)).status).toBe(400);
    for (const data of [{ status: 'VERIFIED' }, { ownerId: owner }, { note: '' }, { note: 'x'.repeat(501) }]) expect((await call('post', `/admin/${id}/approve`, data, admin)).status).toBe(400);
  });
  it('rejects oversized decision bodies before any database work', async () => {
    expect((await call('post', `/admin/${id}/approve`, { note: 'x'.repeat(17 * 1024) }, admin)).status).toBe(413);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('returns safe parser and database errors', async () => {
    expect((await request(app).post('/api/v1/organisations/register').set('Content-Type', 'application/json').send('{bad')).status).toBe(400);
    prisma.organisation.findMany.mockRejectedValueOnce(new Error('private database'));
    const response = await call('get', '/', undefined, null); expect(response.status).toBe(500); expect(response.text).not.toContain('private database');
  });
});

describe('live form adapter', () => {
  const form = () => { const input = body(); input.organisation.facilityTypeOther = ''; input.organisation.website = ''; input.documents = Object.fromEntries(Object.keys(input.documents).map((key) => [key, new globalThis.File(['%PDF-1.4\nfile'], 'evidence.pdf', { type: 'application/pdf' })])); return input; };
  it('maps the four steps and actual selected files to the exact endpoint', async () => {
    const input = form(); const payload = await mapOrganisationRegistration(input);
    expect(payload.organisation).not.toHaveProperty('facilityTypeOther'); expect(payload.organisation).not.toHaveProperty('website'); expect(payload.documents.representativeId.base64).toBeTruthy();
    const fetcher = vi.fn(async (url, options) => { expect(url).toBe('/api/v1/organisations/register'); expect(options.method).toBe('POST'); const response = await signup(JSON.parse(options.body)); return { ok: response.status === 201, status: response.status, json: async () => response.body }; });
    expect((await submitOrganisationRegistration(input, fetcher)).data.status).toBe('PENDING');
  });
  it('does not turn failed registration into local/demo success or hide authority injection', async () => {
    await expect(submitOrganisationRegistration(form(), async () => ({ ok: false, status: 409, json: async () => ({ message: 'Registration could not be completed' }) }))).rejects.toMatchObject({ status: 409 });
    const input = form(); input.role = 'SUPER_ADMIN'; await expect(mapOrganisationRegistration(input)).rejects.toThrow('Unexpected');
    const nested = form(); nested.representative.role = 'SUPER_ADMIN'; expect((await signup(await mapOrganisationRegistration(nested))).status).toBe(400);
  });
});
