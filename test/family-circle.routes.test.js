import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { serialize, deserialize } from 'node:v8';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = { $transaction: vi.fn() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/family-care/family-care.routes.js');
const uid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const owner = uid(1), other = uid(2), caregiver = uid(3), stranger = uid(4);
process.env.JWT_SECRET = 'family-circle-tests';
const app = express(); app.set('trust proxy', 1); app.use(express.json()); app.use('/family-care', routes);
let state, tx, failAudit, failWrite, zeroWrite, seq, ip;
let testNumber = 0;
const clone = (v) => deserialize(serialize(v));
const match = (row, where = {}) => Object.entries(where).every(([key, value]) => {
  if (key === 'OR') return value.some((condition) => match(row, condition));
  if (key === 'AND') return value.every((condition) => match(row, condition));
  const actual = row?.[key];
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if ('in' in value) return value.in.includes(actual);
    if ('has' in value) return actual?.includes(value.has);
    if ('gt' in value) return actual != null && actual > value.gt;
    if ('lte' in value) return actual != null && actual <= value.lte;
  }
  return actual === value;
});
const project = (row, select) => row ? Object.fromEntries(Object.keys(select).map((key) => [key, clone(row[key] ?? null)])) : null;
const auth = (id) => `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}`;
const call = (method, path, body, actor = owner) => {
  const req = request(app)[method](`/family-care${path}`).set('Authorization', auth(actor)).set('X-Forwarded-For', ip);
  return body === undefined ? req : req.send(body);
};
const emailInvite = (extra = {}) => ({ method: 'email', email: 'care@example.test', permissionLevel: 'caregiver', permissions: ['PROFILE'], ...extra });
const fullDependent = () => ({ fullName: 'Private Child', nickname: 'Child', dateOfBirth: '2018-01-02', gender: 'Female', bloodGroup: 'A+', genotype: 'AA', allergies: ['Private allergy'], conditions: ['Private condition'], careType: 'Child', immunizationStatus: 'Up to date', milestones: ['Rolling Over'], weightKg: 20, heightCm: 110, primaryPhysician: 'Private Physician', insuranceProvider: 'Private Insurance', policyNumber: 'PRIVATE-POLICY', coManagerIds: [] });
const createDep = async (body = fullDependent()) => { const r = await call('post', '/dependents', body); expect(r.status).toBe(201); return r.body.data; };
const activeLink = async () => {
  const invite = await call('post', '/members', emailInvite()); expect(invite.status).toBe(201);
  const response = await call('post', '/invitations/accept', { token: invite.body.data.token }, caregiver); expect(response.status).toBe(200);
  return invite.body.data.member.id;
};
beforeEach(() => {
  vi.clearAllMocks(); failAudit = false; failWrite = null; zeroWrite = null; seq = 10; ip = `203.0.113.${++testNumber}`;
  state = {
    user: [{ id: owner, patientId: '#SHM00001', email: 'owner@example.test', full_name: 'Circle Owner' }, { id: other, patientId: '#SHM00002', email: 'other@example.test', full_name: 'Other Owner' }, { id: caregiver, patientId: 'CG-id', email: 'care@example.test', full_name: 'Caregiver' }, { id: stranger, email: 'stranger@example.test', full_name: 'Stranger' }],
    userRole: [{ id: uid(5), userId: owner, role: 'PATIENT' }, { id: uid(6), userId: other, role: 'PATIENT' }, { id: uid(7), userId: caregiver, role: 'CAREGIVER' }],
    careRelationship: [], dependentProfile: [], activityLog: [],
  };
  tx = {};
  for (const model of Object.keys(state)) {
    const find = async ({ where, select }) => project(state[model].find((row) => match(row, where)), select);
    tx[model] = {
      findFirst: vi.fn(find), findUnique: vi.fn(find),
      findMany: vi.fn(async ({ where, select, skip = 0, take }) => state[model].filter((row) => match(row, where)).slice(skip, take === undefined ? undefined : skip + take).map((row) => project(row, select))),
      count: vi.fn(async ({ where }) => state[model].filter((row) => match(row, where)).length),
      create: vi.fn(async ({ data, select }) => {
        if ((model === 'activityLog' && failAudit) || failWrite === model) throw new Error('PRIVATE DATABASE FAILURE');
        const defaults = model === 'careRelationship' ? { status: 'PENDING', caregiverId: null, revokedAt: null, respondedAt: null, joinRequestedAt: null, invitationKind: 'DIRECT', requestedPermissions: [], permissions: [] } : model === 'dependentProfile' ? { coManagerIds: [], allergies: [], conditions: [], milestones: [] } : {};
        const item = { id: uid(++seq), createdAt: new Date(), ...defaults, ...data }; state[model].push(item); return select ? project(item, select) : item;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (failWrite === model) throw new Error('PRIVATE DATABASE FAILURE');
        if (zeroWrite === model) return { count: 0 };
        const rows = state[model].filter((row) => match(row, where)); rows.forEach((row) => Object.assign(row, data)); return { count: rows.length };
      }),
      update: vi.fn(async ({ where, data }) => { const row = state[model].find((r) => match(r, where)); Object.assign(row, data); return row; }),
      deleteMany: vi.fn(async ({ where }) => { const before = state[model].length; state[model] = state[model].filter((row) => !match(row, where)); return { count: before - state[model].length }; }),
    };
    prisma[model] = tx[model];
  }
  prisma.$transaction.mockImplementation(async (work) => { const snapshot = clone(state); try { return await work(tx); } catch (error) { state = snapshot; throw error; } });
});

describe('patient-owned circle and dependents', () => {
  it('returns a predictable empty circle without demo members or clinical aggregates', async () => {
    const response = await call('get', '/circle'); expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ members: [], dependents: [], joinedCircles: [], empty: true });
    expect((await call('get', '/circle', undefined, caregiver)).body.data).toEqual(response.body.data);
  });
  it('supports owner CRUD with only full name required and no login/account created', async () => {
    const dep = await createDep({ fullName: 'Minimal Child' }); expect(dep.fullName).toBe('Minimal Child');
    expect(state.user).toHaveLength(4); expect(state.userRole).toHaveLength(3);
    expect((await call('get', `/dependents/${dep.id}`)).status).toBe(200);
    const updated = await call('patch', `/dependents/${dep.id}`, { nickname: 'New name', dateOfBirth: '2020-02-29' });
    expect(updated.status).toBe(200); expect(updated.body.data.nickname).toBe('New name');
    expect((await call('get', '/circle')).body.data.dependents).toHaveLength(1);
    expect((await call('delete', `/dependents/${dep.id}`)).status).toBe(200);
    expect((await call('get', `/dependents/${dep.id}`)).status).toBe(404);
    expect((await call('get', '/circle')).body.data.empty).toBe(true);
    expect(state.activityLog.map((a) => a.type)).toEqual(['DEPENDENT_CREATED', 'DEPENDENT_UPDATED', 'DEPENDENT_REMOVED']);
    expect(JSON.stringify(state.activityLog)).not.toContain('Minimal Child');
  });
  it('stores visible optional profile fields and projects only basic identity in lists', async () => {
    const dep = await createDep(); expect(dep).toMatchObject({ fullName: 'Private Child', weightKg: 20, genotype: 'AA' });
    const listing = await call('get', '/circle'); expect(JSON.stringify(listing.body)).not.toMatch(/Private allergy|PRIVATE-POLICY|coManagerIds|primaryPhysician/);
  });
  it('denies cross-patient dependent CRUD and denies caregiver ownership actions', async () => {
    const dep = await createDep();
    for (const actor of [other, caregiver]) {
      expect((await call('get', `/dependents/${dep.id}`, undefined, actor)).status).toBe(404);
      expect((await call('patch', `/dependents/${dep.id}`, { fullName: 'Hijack' }, actor)).status).toBe(actor === other ? 404 : 403);
      expect((await call('delete', `/dependents/${dep.id}`, undefined, actor)).status).toBe(actor === other ? 404 : 403);
      expect((await call('get', '/circle', undefined, actor)).body.data.dependents).toEqual([]);
    }
    expect((await call('post', '/dependents', { fullName: 'Child' }, caregiver)).status).toBe(403);
  });
  it('requires both explicit selected co-manager and active PROFILE permission; never permits caregiver writes', async () => {
    const dep = await createDep(); const linkId = await activeLink();
    expect((await call('get', `/dependents/${dep.id}`, undefined, caregiver)).status).toBe(404);
    expect((await call('patch', `/dependents/${dep.id}`, { coManagerIds: [linkId] })).status).toBe(200);
    const shared = await call('get', `/dependents/${dep.id}`, undefined, caregiver);
    expect(shared.status).toBe(200); expect(shared.body.data.fullName).toBe(dep.fullName);
    expect(JSON.stringify(shared.body)).not.toMatch(/bloodGroup|genotype|conditions|allergies|policyNumber|patientId|coManagerIds/);
    expect((await call('patch', `/dependents/${dep.id}`, { fullName: 'Changed' }, caregiver)).status).toBe(403);
    await call('patch', `/${linkId}/permissions`, { permissions: ['VITALS'] });
    expect((await call('get', `/dependents/${dep.id}`, undefined, caregiver)).status).toBe(404);
    await call('patch', `/${linkId}/permissions`, { permissions: ['PROFILE'] });
    await call('delete', `/members/${linkId}`);
    expect((await call('get', `/dependents/${dep.id}`, undefined, caregiver)).status).toBe(404);
  });
  it('rejects pending, foreign, non-PROFILE and duplicate co-manager selections', async () => {
    const pending = await call('post', '/members', emailInvite());
    expect((await call('post', '/dependents', { fullName: 'Child', coManagerIds: [pending.body.data.member.id] })).status).toBe(400);
    const linkId = await activeLinkAfterPending(pending);
    expect((await call('post', '/dependents', { fullName: 'Child', coManagerIds: [linkId] }, other)).status).toBe(400);
    expect((await call('post', '/dependents', { fullName: 'Child', coManagerIds: [linkId, linkId] })).status).toBe(400);
    await call('patch', `/${linkId}/permissions`, { permissions: [] });
    expect((await call('post', '/dependents', { fullName: 'Child', coManagerIds: [linkId] })).status).toBe(400);
  });
});
const activeLinkAfterPending = async (pending) => {
  expect((await call('post', '/invitations/accept', { token: pending.body.data.token }, caregiver)).status).toBe(200);
  return pending.body.data.member.id;
};

describe('invitations, strong-code join and patient-controlled removal', () => {
  it('adds by visible Patient ID/relationship with existing CareRelationship and rejects unknown/self targets', async () => {
    const payload = { method: 'patientId', patientReference: '#SHM00002', relationship: 'Sister', permissionLevel: 'viewer', permissions: [] };
    const response = await call('post', '/members', payload); expect(response.status).toBe(201);
    expect(response.body.data.member).toMatchObject({ patientId: owner, caregiverEmail: 'other@example.test', relationshipLabel: 'Sister', status: 'PENDING' });
    expect((await call('post', '/members', payload)).status).toBe(409);
    expect((await call('post', '/members', { ...payload, patientReference: '#UNKNOWN' })).status).toBe(404);
    expect((await call('post', '/members', { ...payload, patientReference: '#SHM00001' })).status).toBe(400);
  });
  it('direct email invitation is recipient bound; acceptance alone does not grant dependent data', async () => {
    const dep = await createDep(); const response = await call('post', '/members', emailInvite());
    const { token, member } = response.body.data; expect(token).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(state)).not.toContain(token);
    expect((await call('post', '/join/lookup', { token }, stranger)).status).toBe(404);
    expect((await call('post', '/invitations/accept', { token }, stranger)).status).toBe(404);
    expect((await call('post', '/invitations/accept', { token }, caregiver)).status).toBe(200);
    expect((await call('post', '/invitations/accept', { token }, caregiver)).status).toBe(404);
    expect((await call('get', `/dependents/${dep.id}`, undefined, caregiver)).status).toBe(404);
    expect((await call('get', `/members/${member.id}`)).body.data.status).toBe('ACTIVE');
    expect((await call('get', `/members/${member.id}`, undefined, other)).status).toBe(404);
  });
  it('shares only a strong single-use QR/code, joins pending, and activates only on owner approval', async () => {
    const response = await call('post', '/join-links', { permissionLevel: 'caregiver' }); expect(response.status).toBe(201);
    const { token, id, qrPayload } = response.body.data; expect(qrPayload).toBe(token);
    const lookup = await call('post', '/join/lookup', { token }, caregiver);
    expect(lookup.body.data).toEqual({ name: 'Family Circle', ownerName: 'Circle Owner', expiresAt: response.body.data.expiresAt });
    const joined = await call('post', '/join', { token, permissionLevel: 'owner', requestedPermissions: ['PROFILE', 'VITALS'] }, caregiver);
    expect(joined.body.data).toEqual({ id, status: 'PENDING', permissions: [] });
    expect((await call('get', `/access/${owner}`, undefined, caregiver)).body.data.permissions).toEqual([]);
    expect((await call('post', '/join', { token, permissionLevel: 'caregiver', requestedPermissions: [] }, stranger)).status).toBe(404);
    expect((await call('post', `/members/${id}/approve`, { permissions: ['PROFILE'] }, other)).status).toBe(404);
    expect((await call('post', `/members/${id}/approve`, { permissions: ['PROFILE'] }, caregiver)).status).toBe(403);
    expect((await call('post', `/members/${id}/approve`, { permissions: ['PROFILE'] })).body.data.permissions).toEqual(['PROFILE']);
    expect((await call('get', `/access/${owner}`, undefined, caregiver)).body.data.permissions).toEqual(['PROFILE']);
    expect(state.userRole.filter((r) => r.userId === caregiver)).toEqual([{ id: uid(7), userId: caregiver, role: 'CAREGIVER' }]);
  });
  it('does not expose rosters, dependents or invitations from another circle to a joined member', async () => {
    const ownLink = await activeLink(); await createDep();
    await call('post', '/members', emailInvite({ email: 'stranger@example.test' }));
    const foreign = await call('post', '/members', emailInvite({ email: 'foreign@example.test' }), other);
    const response = await call('get', '/circle', undefined, caregiver);
    expect(response.body.data.members).toEqual([]); expect(response.body.data.dependents).toEqual([]);
    expect(response.body.data.joinedCircles.map((m) => m.id)).toEqual([ownLink]);
    expect(JSON.stringify(response.body)).not.toMatch(/stranger@example|foreign@example|Private Child/);
    expect((await call('get', `/members/${foreign.body.data.member.id}`)).status).toBe(404);
    expect((await call('delete', `/members/${foreign.body.data.member.id}`)).status).toBe(404);
  });
  it('revokes immediately, preserves minimal history and invalidates an unconsumed join token', async () => {
    const id = await activeLink(); const before = state.careRelationship.length;
    expect((await call('delete', `/members/${id}`)).body.data.status).toBe('REVOKED');
    expect((await call('get', `/access/${owner}`, undefined, caregiver)).body.data.permissions).toEqual([]);
    expect(state.careRelationship).toHaveLength(before); expect(state.careRelationship[0].revokedAt).toBeInstanceOf(Date);
    const link = await call('post', '/join-links', { permissionLevel: 'viewer' });
    await call('delete', `/members/${link.body.data.id}`);
    expect((await call('post', '/join/lookup', { token: link.body.data.token }, caregiver)).status).toBe(404);
    expect(JSON.stringify(state.activityLog)).not.toMatch(/@|Private|token|permissions/);
  });
  it('displays pending, active, declined, revoked and expired states safely', async () => {
    const response = await call('post', '/members', emailInvite()); const id = response.body.data.member.id;
    for (const status of ['PENDING', 'ACTIVE', 'DECLINED', 'REVOKED', 'EXPIRED']) {
      state.careRelationship[0].status = status;
      expect((await call('get', `/members/${id}`)).body.data.status).toBe(status);
    }
    state.careRelationship[0].status = 'PENDING'; state.careRelationship[0].expiresAt = new Date(0);
    expect((await call('get', `/members/${id}`)).body.data.status).toBe('EXPIRED');
    expect((await call('get', '/circle')).body.data.members[0].status).toBe('EXPIRED');
    expect((await call('get', '/?status=EXPIRED')).body.data.items).toHaveLength(1);
    expect((await call('get', '/?status=PENDING')).body.data.items).toEqual([]);
  });
  it('rejects expired lookup, join and pending approval; decline does not grant access', async () => {
    const link = await call('post', '/join-links', { permissionLevel: 'caregiver' }); const { token, id } = link.body.data;
    state.careRelationship[0].expiresAt = new Date(0);
    expect((await call('post', '/join/lookup', { token }, caregiver)).status).toBe(410);
    expect((await call('post', '/join', { token, permissionLevel: 'viewer', requestedPermissions: [] }, caregiver)).status).toBe(410);
    state.careRelationship[0].joinRequestedAt = new Date(); state.careRelationship[0].caregiverId = caregiver;
    expect((await call('post', `/members/${id}/approve`, { permissions: ['PROFILE'] })).status).toBe(410);
    const invite = await call('post', '/members', emailInvite());
    expect((await call('post', '/invitations/decline', { token: invite.body.data.token }, caregiver)).status).toBe(200);
    expect((await call('get', `/access/${owner}`, undefined, caregiver)).body.data.permissions).toEqual([]);
  });
  it('losing an accept compare-and-set cannot revive a concurrently revoked relationship', async () => {
    const invite = await call('post', '/members', emailInvite()); zeroWrite = 'careRelationship';
    expect((await call('post', '/invitations/accept', { token: invite.body.data.token }, caregiver)).status).toBe(404);
    expect(state.careRelationship[0].status).toBe('PENDING');
  });
});

describe('strict input, token safety and rollback', () => {
  it.each([{ fullName: '' }, { fullName: 'X', patientId: other }, { fullName: 'X', password: 'secret' }, { fullName: 'X', role: 'PATIENT' }, { fullName: 'X', accessToken: 'token' }, { fullName: 'X', permissions: ['PROFILE'] }, { fullName: 'X', dateOfBirth: '2026-02-30' }, { fullName: 'X', gender: 'invalid' }, { fullName: 'X', weightKg: -1 }, { fullName: 'X', bloodGroup: 'invalid' }])('rejects invalid dependent input %j', async (input) => {
    expect((await call('post', '/dependents', input)).status).toBe(400); expect(tx.dependentProfile.create).not.toHaveBeenCalled();
  });
  it('rejects authority injection, unsupported permissions, missing visible fields and malformed codes', async () => {
    expect((await call('post', '/members', { ...emailInvite(), patientId: other })).status).toBe(400);
    expect((await call('post', '/members', emailInvite({ permissions: ['PAYMENTS'] }))).status).toBe(400);
    expect((await call('post', '/members', { method: 'patientId', patientReference: '#SHM00002', permissions: [], permissionLevel: 'viewer' })).status).toBe(400);
    expect((await call('post', '/join/lookup', { token: 'OKAFOR-7721' }, caregiver)).status).toBe(400);
    expect((await call('post', '/join/lookup', { token: 'a'.repeat(64) }, caregiver)).status).toBe(404);
    expect((await call('get', '/circle?patientId=other')).status).toBe(400);
    expect((await call('get', '/dependents/not-uuid')).status).toBe(400);
    const dep = await createDep(); expect((await call('patch', `/dependents/${dep.id}`, {})).status).toBe(400);
  });
  it.each([undefined, 'Bearer bad', `Bearer ${jwt.sign({ userId: owner }, 'wrong')}`, `Bearer ${jwt.sign({ userId: owner }, process.env.JWT_SECRET, { expiresIn: -1 })}`])('fails authentication before database access: %s', async (token) => {
    let req = request(app).get('/family-care/circle'); if (token) req = req.set('Authorization', token);
    expect((await req).status).toBe(401); expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rate limits join-code lookups without revealing tokens', async () => {
    for (let i = 0; i < 20; i++) expect((await call('post', '/join/lookup', { token: 'a'.repeat(64) }, caregiver)).status).toBe(404);
    const response = await call('post', '/join/lookup', { token: 'a'.repeat(64) }, caregiver); expect(response.status).toBe(429); expect(JSON.stringify(response.body)).not.toContain('a'.repeat(64));
  });
  it('rolls back dependent CRUD and invitations on audit failure and hides DB errors', async () => {
    const dep = await createDep(); let before = clone(state); failAudit = true;
    for (const [method, path, input] of [['post', '/dependents', { fullName: 'New' }], ['patch', `/dependents/${dep.id}`, { fullName: 'Changed' }], ['delete', `/dependents/${dep.id}`, undefined], ['post', '/members', emailInvite()], ['post', '/join-links', { permissionLevel: 'viewer' }]]) {
      const response = await call(method, path, input); expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain('PRIVATE'); expect(state).toEqual(before);
    }
    failAudit = false; const link = await call('post', '/join-links', { permissionLevel: 'viewer' }); before = clone(state); failAudit = true;
    expect((await call('post', '/join', { token: link.body.data.token, permissionLevel: 'viewer', requestedPermissions: [] }, caregiver)).status).toBe(500); expect(state).toEqual(before);
  });
  it('rolls back approval/revocation on audit failure, and reports write conflicts safely', async () => {
    const link = await call('post', '/join-links', { permissionLevel: 'viewer' });
    await call('post', '/join', { token: link.body.data.token, permissionLevel: 'viewer', requestedPermissions: [] }, caregiver);
    const before = clone(state); failAudit = true;
    expect((await call('post', `/members/${link.body.data.id}/approve`, { permissions: ['PROFILE'] })).status).toBe(500); expect(state).toEqual(before);
    expect((await call('delete', `/members/${link.body.data.id}`)).status).toBe(500); expect(state).toEqual(before);
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('PRIVATE'), { code: 'P2034' }));
    expect((await call('get', '/circle')).status).toBe(409);
    prisma.$transaction.mockRejectedValueOnce(new Error('PRIVATE DB CONNECTION'));
    const response = await call('get', '/circle'); expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain('PRIVATE');
  });
});
