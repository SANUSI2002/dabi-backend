import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fn = () => vi.fn();
const tx = { userRole: { findFirst: fn() }, user: { findUnique: fn() }, careRelationship: { findFirst: fn(), findMany: fn() }, dependentProfile: { findMany: fn() }, appointment: { findMany: fn(), create: fn(), updateMany: fn(), deleteMany: fn() }, activityLog: { create: fn() } };
const prisma = { $transaction: fn() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/family-care/family-care.routes.js');
const uid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const owner = uid(1), other = uid(2), caregiver = uid(3), member = uid(4), dep = uid(5), ownLink = uid(6), caregiverLink = uid(7), reverseLink = uid(8);
const from = '2026-09-01T00:00:00+01:00', to = '2026-10-01T00:00:00+01:00';
process.env.JWT_SECRET = 'calendar-http';
const app = express(); app.use(express.json()); app.use('/family-care', routes);
let relationships, appointments, dependents;
const auth = (id) => `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}`;
const get = (query = {}, actor = owner, path = '/calendar') => request(app).get(`/family-care${path}`).query({ from, ...(path === '/calendar' ? { to } : {}), ...query }).set('Authorization', auth(actor));
const matches = (row, where) => Object.entries(where).every(([key, value]) => {
  if (value && typeof value === 'object') {
    if ('in' in value) return value.in.includes(row[key]);
    if ('not' in value) return row[key] !== value.not;
    if ('has' in value) return row[key]?.includes(value.has);
    return (!value.gte || row[key] >= value.gte) && (!value.lt || row[key] < value.lt);
  }
  return row[key] === value;
});
const select = (row, fields) => row ? Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]])) : null;
const grant = (id, patientId, caregiverId, permissions, status = 'ACTIVE') => ({ id, patientId, caregiverId, permissions, status, revokedAt: null, relationshipLabel: 'Sister' });
beforeEach(() => {
  vi.clearAllMocks();
  relationships = [grant(ownLink, owner, member, ['APPOINTMENTS']), grant(caregiverLink, owner, caregiver, ['APPOINTMENTS', 'PROFILE'])];
  dependents = [{ id: dep, patientId: owner, fullName: 'Child', careType: 'Child', coManagerIds: [caregiverLink], conditions: ['SECRET'] }, { id: uid(20), patientId: other, fullName: 'Other child', coManagerIds: [] }];
  appointments = [
    { id: uid(10), userId: owner, doctorName: 'Dr Safe', title: 'PRIVATE DIAGNOSIS', type: 'PRIVATE TYPE', time: new Date('2026-09-01T00:00:00+01:00'), status: 'SCHEDULED', records: ['SECRET'] },
    { id: uid(11), userId: other, doctorName: 'Other doctor', time: new Date('2026-09-02T00:00:00Z'), status: 'SCHEDULED' },
    { id: uid(12), userId: member, doctorName: 'Dr Member', time: new Date('2026-09-03T00:00:00Z'), status: 'CANCELLED' },
    { id: uid(13), userId: owner, doctorName: null, time: new Date('2026-10-01T00:00:00+01:00'), status: 'COMPLETED' },
  ];
  prisma.$transaction.mockImplementation((work) => work(tx));
  tx.userRole.findFirst.mockImplementation(async ({ where }) => [owner, other, member].includes(where.userId) ? { id: uid(30) } : null);
  tx.user.findUnique.mockImplementation(async ({ where, select: fields }) => select({ id: where.id, full_name: where.id === member ? 'Approved Member' : 'Patient Name', email: 'PRIVATE EMAIL' }, fields));
  tx.careRelationship.findFirst.mockImplementation(async ({ where, select: fields }) => select(relationships.find((row) => matches(row, where)), fields));
  tx.careRelationship.findMany.mockImplementation(async ({ where, select: fields }) => relationships.filter((row) => matches(row, where)).map((row) => select(row, fields)));
  tx.dependentProfile.findMany.mockImplementation(async ({ where, select: fields }) => dependents.filter((row) => matches(row, where)).map((row) => select(row, fields)));
  tx.appointment.findMany.mockImplementation(async ({ where, select: fields, take, skip = 0 }) => appointments.filter((row) => matches(row, where)).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)).slice(skip, take === undefined ? undefined : skip + take).map((row) => select(row, fields)));
});

describe('live Care Calendar reads', () => {
  it('returns safe owned appointment summaries with half-open timezone-aware range boundaries', async () => {
    const response = await get(); expect(response.status).toBe(200);
    expect(response.body.data.events).toEqual([{ id: uid(10), memberId: 'self', memberName: 'Myself', title: 'Dr Safe', time: '2026-08-31T23:00:00.000Z', status: 'SCHEDULED' }]);
    expect(response.body.data.members.map((m) => m.id)).toEqual(['self', dep]);
    expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE|SECRET|userId|conditions|Other doctor/);
    expect(tx.appointment.findMany.mock.calls[0][0].select).toEqual({ id: true, userId: true, doctorName: true, time: true, status: true });
  });
  it('never treats inviting a member as reciprocal permission to their appointments', async () => {
    expect((await get({ memberId: ownLink })).status).toBe(404);
    relationships.push(grant(reverseLink, member, owner, ['APPOINTMENTS']));
    const response = await get({ memberId: ownLink }); expect(response.status).toBe(200);
    expect(response.body.data.events.map((e) => e.title)).toEqual(['Dr Member']);
    expect(response.body.data.events[0].status).toBe('CANCELLED');
    expect((await get()).body.data.events).toHaveLength(2);
  });
  it('filters own dependents predictably without guessing name/owner booking associations', async () => {
    appointments[0].doctorName = 'Child';
    const response = await get({ memberId: dep }); expect(response.status).toBe(200);
    expect(response.body.data.events).toEqual([]); expect(response.body.data.empty).toBe(true);
    expect(response.body.data.members.find((m) => m.id === dep).calendarAvailable).toBe(true);
    expect(tx.appointment.findMany).not.toHaveBeenCalled();
  });
  it('provides predictable empty states, day reads and independently paginated Upcoming', async () => {
    expect((await get({ from: '2026-09-20T00:00:00Z', to: '2026-09-21T00:00:00Z' })).body.data.empty).toBe(true);
    const first = await get({ limit: 1 }, owner, '/calendar/upcoming');
    expect(first.body.data.events).toHaveLength(1); expect(first.body.data.hasMore).toBe(true); expect(first.body.data.nextOffset).toBe(1);
    const second = await get({ limit: 1, offset: 1 }, owner, '/calendar/upcoming');
    expect(second.body.data.events[0].title).toBe('Appointment'); expect(second.body.data.hasMore).toBe(false); expect(second.body.data.nextOffset).toBeNull();
    const empty = await get({ from: '2027-01-01T00:00:00Z' }, owner, '/calendar/upcoming'); expect(empty.body.data.events).toEqual([]); expect(empty.body.data.empty).toBe(true);
  });
  it('reads appointment lifecycle changes without mutating source data or inventing calendar writes', async () => {
    for (const status of ['SCHEDULED', 'CANCELLED', 'COMPLETED']) { appointments[0].status = status; expect((await get()).body.data.events[0].status).toBe(status); }
    for (const method of ['post', 'patch', 'delete']) {
      const response = await request(app)[method]('/family-care/calendar').set('Authorization', auth(owner)).send({ title: 'New' }); expect(response.status).toBe(405);
    }
    expect(tx.appointment.create).not.toHaveBeenCalled(); expect(tx.appointment.updateMany).not.toHaveBeenCalled(); expect(tx.appointment.deleteMany).not.toHaveBeenCalled(); expect(tx.activityLog.create).not.toHaveBeenCalled();
  });
});

describe('explicit calendar permission and circle isolation', () => {
  it('allows a caregiver only their explicitly permitted circle with no unrelated roster', async () => {
    expect((await get({}, caregiver)).status).toBe(403);
    const response = await get({ circlePatientId: owner }, caregiver); expect(response.status).toBe(200);
    expect(response.body.data.events.map((e) => e.id)).toEqual([uid(10)]);
    expect(response.body.data.members.map((m) => m.id)).toEqual(['self', dep]);
    expect((await get({ circlePatientId: owner, memberId: ownLink }, caregiver)).status).toBe(404);
    expect((await get({ circlePatientId: other }, caregiver)).status).toBe(404);
  });
  it.each(['PENDING', 'DECLINED', 'REVOKED', 'EXPIRED'])('denies %s caregivers even with permission strings', async (status) => {
    relationships[1].status = status;
    expect((await get({ circlePatientId: owner }, caregiver)).status).toBe(404); expect(tx.appointment.findMany).not.toHaveBeenCalled();
  });
  it('denies revokedAt, removed permissions and generic co-manager/profile-only access immediately', async () => {
    relationships[1].revokedAt = new Date(); expect((await get({ circlePatientId: owner }, caregiver)).status).toBe(404);
    relationships[1].revokedAt = null; relationships[1].permissions = ['PROFILE']; expect((await get({ circlePatientId: owner }, caregiver)).status).toBe(404);
    relationships[1].permissions = []; expect((await get({ circlePatientId: owner }, caregiver)).status).toBe(404);
    relationships[1].permissions = ['APPOINTMENTS']; const r = await get({ circlePatientId: owner }, caregiver); expect(r.status).toBe(200); expect(r.body.data.members.map((m) => m.id)).toEqual(['self', dep]);
  });
  it('requires dependent selection plus both profile and appointment permissions', async () => {
    dependents[0].coManagerIds = [];
    expect((await get({ circlePatientId: owner, memberId: dep }, caregiver)).status).toBe(404);
    dependents[0].coManagerIds = [caregiverLink];
    expect((await get({ circlePatientId: owner, memberId: dep }, caregiver)).body.data.events).toEqual([]);
  });
  it('rejects foreign dependents, unknown members and unauthorized circle switches without appointment reads', async () => {
    for (const query of [{ memberId: uid(20) }, { memberId: uid(99) }, { circlePatientId: other }]) expect((await get(query)).status).toBe(404);
    expect(tx.appointment.findMany).not.toHaveBeenCalled();
  });
  it('rechecks approved-member reverse consent on each request', async () => {
    relationships.push(grant(reverseLink, member, owner, ['APPOINTMENTS']));
    expect((await get({ memberId: ownLink })).status).toBe(200);
    relationships[2].permissions = ['PROFILE']; expect((await get({ memberId: ownLink })).status).toBe(404);
    relationships[2].permissions = ['APPOINTMENTS']; relationships[0].status = 'REVOKED'; expect((await get({ memberId: ownLink })).status).toBe(404);
  });
});

describe('strict calendar query and token validation', () => {
  it.each([
    { from: '2026-09-01' }, { to: 'invalid' }, { to: from }, { to: '2026-08-01T00:00:00Z' },
    { to: '2027-01-01T00:00:00Z' }, { memberId: 'bad' }, { circlePatientId: 'bad' },
    { view: 'week' }, { month: '2026-09' }, { status: 'CANCELLED' }, { patientId: other }, { permissions: 'APPOINTMENTS' },
  ])('rejects malformed or non-design filters %j', async (query) => {
    expect((await get(query)).status).toBe(400); expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('requires both bounds and rejects invalid upcoming pagination and extra range controls', async () => {
    expect((await request(app).get('/family-care/calendar').set('Authorization', auth(owner))).status).toBe(400);
    for (const q of [{ limit: 101 }, { offset: -1 }, { limit: 'x' }, { to }, { status: 'SCHEDULED' }]) expect((await get(q, owner, '/calendar/upcoming')).status).toBe(400);
  });
  it.each([undefined, 'Bearer bad', `Bearer ${jwt.sign({ userId: owner }, 'wrong')}`, `Bearer ${jwt.sign({ userId: owner }, process.env.JWT_SECRET, { expiresIn: -1 })}`])('rejects token failure before DB: %s', async (token) => {
    let req = request(app).get('/family-care/calendar').query({ from, to }); if (token) req = req.set('Authorization', token);
    expect((await req).status).toBe(401); expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('hides database failures and returns no partial event data', async () => {
    tx.appointment.findMany.mockRejectedValueOnce(new Error('PRIVATE SQL password'));
    const response = await get(); expect(response.status).toBe(500); expect(response.body).toEqual({ status: 'error', message: 'Family care module temporarily unavailable' });
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('PRIVATE'), { code: 'P2034' })); expect((await get()).status).toBe(409);
  });
});
