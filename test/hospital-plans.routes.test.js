import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const model = () => Object.fromEntries(['create', 'findFirst', 'findMany', 'count', 'updateMany'].map((key) => [key, vi.fn()]));
const prisma = { userRole: model(), organisation: model(), hospitalMemberPlan: model(), activityLog: model(), $transaction: vi.fn() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/hospital-plans/hospital-plans.routes.js');
const { loadHospitalPlans, toPlanCard } = await import('../src/modules/hospital-plans/hospital-plans.adapter.js');
const app = express(); app.use(express.json()); app.use('/api/v1/hospitals', routes);
const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', hospital = '33333333-3333-4333-8333-333333333333', otherHospital = '44444444-4444-4444-8444-444444444444', planId = '55555555-5555-4555-8555-555555555555';
process.env.JWT_SECRET = 'hospital-plan-test';
let db;
const auth = (actor) => `Bearer ${jwt.sign({ userId: actor, roles: ['SUPER_ADMIN', 'ORGANISATION_OWNER'] }, process.env.JWT_SECRET)}`;
const call = (method, suffix = '', data, actor = owner, hospitalId = hospital) => {
  const req = request(app)[method](`/api/v1/hospitals/${hospitalId}/plans${suffix}`);
  if (actor) req.set('Authorization', auth(actor));
  return data === undefined ? req : req.send(data);
};
const input = () => ({ name: 'Standard Plan', description: 'Covers one person.', feeMinor: 1500000 });
const match = (row, where) => Object.entries(where ?? {}).every(([key, value]) => value && typeof value === 'object' ? match(key === 'hospital' ? db.hospitals.find((h) => h.id === row.hospitalId) ?? {} : row[key] ?? {}, value) : row[key] === value);
const select = (row, fields) => row ? Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]])) : null;
beforeEach(() => {
  vi.resetAllMocks();
  db = { hospitals: [{ id: hospital, ownerId: owner, type: 'HOSPITAL', status: 'VERIFIED' }, { id: otherHospital, ownerId: other, type: 'HOSPITAL', status: 'VERIFIED' }], roles: [{ userId: owner, role: 'ORGANISATION_OWNER' }, { userId: other, role: 'ORGANISATION_OWNER' }], plans: [], audits: [] };
  prisma.userRole.findFirst.mockImplementation(async ({ where }) => db.roles.find((r) => match(r, where)) ?? null);
  prisma.organisation.findFirst.mockImplementation(async ({ where, select: fields }) => select(db.hospitals.find((r) => match(r, where)), fields));
  prisma.hospitalMemberPlan.create.mockImplementation(async ({ data, select: fields }) => { const row = { id: planId, status: 'ACTIVE', description: null, archivedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data }; db.plans.push(row); return select(row, fields); });
  prisma.hospitalMemberPlan.findFirst.mockImplementation(async ({ where, select: fields }) => select(db.plans.find((r) => match(r, where)), fields));
  prisma.hospitalMemberPlan.findMany.mockImplementation(async ({ where, select: fields, skip, take }) => db.plans.filter((r) => match(r, where)).slice(skip, skip + take).map((r) => select(r, fields)));
  prisma.hospitalMemberPlan.count.mockImplementation(async ({ where }) => db.plans.filter((r) => match(r, where)).length);
  prisma.hospitalMemberPlan.updateMany.mockImplementation(async ({ where, data }) => { const rows = db.plans.filter((r) => match(r, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; });
  prisma.activityLog.create.mockImplementation(async ({ data }) => { db.audits.push(data); return data; });
  prisma.$transaction.mockImplementation(async (work) => { const snapshot = globalThis.structuredClone(db); try { return await work(prisma); } catch (error) { db = snapshot; throw error; } });
});
it('creates owner-linked active plans and ID-only audits using serializable transactions', async () => {
  const response = await call('post', '', input()); expect(response.status).toBe(201);
  expect(response.body.data).toMatchObject({ id: planId, hospitalId: hospital, ...input(), currency: 'NGN', status: 'ACTIVE' });
  expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  expect(db.audits[0].meta).toEqual({ hospitalId: hospital, planId });
});
it('returns empty catalogues without demo plans, permits zero fee and optional description', async () => {
  expect((await call('get', '', undefined, null)).body.data).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  expect((await call('get', '/manage')).body.data.items).toEqual([]);
  expect((await call('post', '', { name: 'Free Plan', feeMinor: 0 })).body.data).toMatchObject({ description: null, feeMinor: 0 });
});
it('updates, archives, hides public data immediately and retains owner history', async () => {
  await call('post', '', input());
  expect((await call('patch', `/${planId}`, { name: 'Revised', feeMinor: 1500001, description: null })).status).toBe(200);
  const response = await call('get', `/${planId}`, undefined, null);
  expect(response.body.data).toEqual({ id: planId, hospitalId: hospital, name: 'Revised', feeMinor: 1500001, description: null, currency: 'NGN' });
  expect(response.headers['cache-control']).toBe('no-store');
  expect((await call('post', `/${planId}/archive`, {})).body.data.status).toBe('ARCHIVED');
  expect(db.plans[0].archivedAt).toBeInstanceOf(Date);
  expect((await call('get', '', undefined, null)).body.data.items).toEqual([]);
  expect((await call('get', `/${planId}`, undefined, null)).status).toBe(404);
  expect((await call('patch', `/${planId}`, { name: 'Reopen' })).status).toBe(404);
  expect((await call('get', '/manage?status=ARCHIVED')).body.data.total).toBe(1);
  expect((await call('get', '/manage?status=ACTIVE')).body.data.total).toBe(0);
  expect((await call('post', `/${planId}/archive`, {})).status).toBe(200);
  expect(db.audits.map((a) => a.type)).toEqual(['HOSPITAL_PLAN_CREATED', 'HOSPITAL_PLAN_UPDATED', 'HOSPITAL_PLAN_ARCHIVED']);
});
it('isolates plan identifiers and paginates within one hospital', async () => {
  await call('post', '', input()); db.plans.push({ ...db.plans[0], id: other, hospitalId: otherHospital });
  expect((await call('get', '', undefined, null)).body.data.total).toBe(1);
  expect((await call('get', '?limit=1&offset=1', undefined, null)).body.data).toMatchObject({ items: [], total: 1 });
  expect((await call('get', `/${planId}`, undefined, null, otherHospital)).status).toBe(404);
  expect((await call('get', `/${other}`, undefined, null, otherHospital)).status).toBe(200);
});
const management = () => [['post', '', input()], ['get', '/manage'], ['patch', `/${planId}`, { name: 'Changed' }], ['post', `/${planId}/archive`, {}]];
it('denies another owner and swapped hospital/plan IDs', async () => {
  await call('post', '', input());
  for (const [method, path, data] of management()) expect((await call(method, path, data, other)).status).toBe(404);
  for (const [method, path, data] of management().slice(2)) expect((await call(method, path, data, other, otherHospital)).status).toBe(404);
  expect(db.plans[0].name).toBe(input().name); expect(db.audits).toHaveLength(1);
});
it.each(['CLINIC', 'LABORATORY', 'DIAGNOSTIC_CENTRE', 'OTHER', 'PHARMACY'])('denies %s facilities management and public visibility', async (type) => {
  await call('post', '', input()); db.hospitals[0].type = type;
  for (const [method, path, data] of management()) expect((await call(method, path, data)).status).toBe(404);
  for (const path of ['', `/${planId}`]) expect((await call('get', path, undefined, null)).status).toBe(404);
});
it.each(['PENDING', 'REJECTED', 'SUSPENDED'])('denies %s hospitals management and all public plans', async (status) => {
  await call('post', '', input()); db.hospitals[0].status = status;
  for (const [method, path, data] of management()) expect((await call(method, path, data)).status).toBe(404);
  for (const path of ['', `/${planId}`]) expect((await call('get', path, undefined, null)).status).toBe(404);
  db.hospitals[0].status = 'VERIFIED'; expect((await call('get', '', undefined, null)).body.data.total).toBe(1);
});
it('requires current owner role, not claimed JWT roles or a Super Admin role', async () => {
  db.roles = [{ userId: owner, role: 'SUPER_ADMIN' }];
  for (const [method, path, data] of management()) expect((await call(method, path, data)).status).toBe(404);
  expect(prisma.hospitalMemberPlan.create).not.toHaveBeenCalled();
});
it.each(['', 'Bearer invalid', `Bearer ${jwt.sign({ userId: owner }, 'wrong')}`, `Bearer ${jwt.sign({ userId: owner }, process.env.JWT_SECRET, { expiresIn: -1 })}`])('rejects token failure %s on every write and owner read', async (authorization) => {
  for (const [method, suffix, data] of management()) {
    const req = request(app)[method](`/api/v1/hospitals/${hospital}/plans${suffix}`); if (authorization) req.set('Authorization', authorization); if (data) req.send(data); expect((await req).status).toBe(401);
  }
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
it.each(['ownerId', 'hospitalId', 'status', 'currency', 'patientId', 'role', 'insurance', 'benefits', 'rating', 'payment', 'type', 'maxMembers'])('rejects injected or non-visible field %s', async (field) => {
  expect((await call('post', '', { ...input(), [field]: 'injected' })).status).toBe(400);
  expect((await call('patch', `/${planId}`, { [field]: 'injected' })).status).toBe(400);
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
it.each([-1, 1.1, '15000', 2147483648, null])('rejects unsafe fee %s', async (feeMinor) => {
  expect((await call('post', '', { ...input(), feeMinor })).status).toBe(400);
  expect((await call('patch', `/${planId}`, { feeMinor })).status).toBe(400);
});
it.each([{ name: '' }, { name: '   ' }, { name: 'x'.repeat(121) }, { description: 'x'.repeat(1001) }, { description: {} }])('rejects malformed/unbounded text %#', async (fields) => {
  expect((await call('post', '', { ...input(), ...fields })).status).toBe(400);
  expect((await call('patch', `/${planId}`, fields)).status).toBe(400);
});
it('rejects missing fields, empty patches, archive payloads, malformed IDs and extra filters', async () => {
  for (const field of ['name', 'feeMinor']) { const data = input(); delete data[field]; expect((await call('post', '', data)).status).toBe(400); }
  expect((await call('patch', `/${planId}`, {})).status).toBe(400);
  expect((await call('post', `/${planId}/archive`, { status: 'ACTIVE' })).status).toBe(400);
  for (const path of ['?status=ARCHIVED', '?type=family', '?insurance=true', '?limit=101', '?offset=-1', '?search=test', '/manage?status=DRAFT', '/bad-id']) expect((await call('get', path)).status).toBe(400);
  expect((await call('get', '', undefined, null, 'bad-id')).status).toBe(400);
});
it('uses identical safe 404 responses for unavailable hospitals and plans', async () => {
  const missing = await call('get', `/${planId}`, undefined, null); expect(missing.status).toBe(404);
  expect((await call('get', '', undefined, null, other)).body).toEqual(missing.body);
  expect((await call('patch', `/${planId}`, { name: 'Missing' })).body).toEqual(missing.body);
});
it.each(['create', 'update', 'archive'])('rolls back %s when its audit fails', async (action) => {
  if (action !== 'create') await call('post', '', input());
  prisma.activityLog.create.mockRejectedValueOnce(new Error('private database password'));
  const response = action === 'create' ? await call('post', '', input()) : action === 'update' ? await call('patch', `/${planId}`, { name: 'Changed' }) : await call('post', `/${planId}/archive`, {});
  expect(response.status).toBe(500); expect(response.text).not.toContain('private database');
  if (action === 'create') expect(db.plans).toEqual([]); else expect(db.plans[0]).toMatchObject({ name: input().name, status: 'ACTIVE', archivedAt: null });
  expect(db.audits).toHaveLength(action === 'create' ? 0 : 1);
});
it('keeps eligibility in write predicates and sanitizes transaction conflicts', async () => {
  await call('post', '', input());
  prisma.hospitalMemberPlan.updateMany.mockImplementationOnce(async ({ where }) => { db.hospitals[0].status = 'SUSPENDED'; return { count: db.plans.filter((p) => match(p, where)).length }; });
  expect((await call('patch', `/${planId}`, { name: 'Must not change' })).status).toBe(404);
  prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('private SQL'), { code: 'P2034' }));
  expect((await call('post', '', input())).status).toBe(409); expect(db.audits).toHaveLength(1);
});
it('sanitizes database errors on public reads and owner lookup', async () => {
  prisma.hospitalMemberPlan.findMany.mockRejectedValueOnce(new Error('private SQL'));
  expect((await call('get', '', undefined, null)).body).toEqual({ status: 'error', message: 'Hospital plan service temporarily unavailable' });
  prisma.hospitalMemberPlan.findFirst.mockRejectedValueOnce(new Error('private SQL'));
  expect((await call('get', `/${planId}`, undefined, null)).status).toBe(500);
  prisma.userRole.findFirst.mockRejectedValueOnce(new Error('private SQL')); expect((await call('get', '/manage')).status).toBe(500);
});
it('adapts the exact live cards and never falls back to demo enrollment data', async () => {
  await call('post', '', input());
  const fetcher = vi.fn(async (path) => { const res = await request(app).get(path); return { ok: res.status === 200, status: res.status, json: async () => res.body }; });
  expect(await loadHospitalPlans(hospital, fetcher)).toEqual([{ id: planId, name: input().name, description: input().description, fee: 15000 }]);
  expect(fetcher.mock.calls[0][0]).toBe(`/api/v1/hospitals/${hospital}/plans?limit=100&offset=0`);
  expect(toPlanCard({ id: planId, name: 'Free', feeMinor: 0 })).toEqual({ id: planId, name: 'Free', fee: 0, description: '' });
  await call('post', `/${planId}/archive`, {}); expect(await loadHospitalPlans(hospital, fetcher)).toEqual([]);
  db.hospitals[0].status = 'SUSPENDED'; await expect(loadHospitalPlans(hospital, fetcher)).rejects.toMatchObject({ status: 404 });
});
