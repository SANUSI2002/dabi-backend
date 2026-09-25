import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';

const model = () => Object.fromEntries(['create', 'findFirst', 'findMany', 'count', 'updateMany'].map((key) => [key, vi.fn()]));
const prisma = { userRole: model(), organisation: model(), hospitalMemberPlan: model(), hospitalEnrollment: model(), activityLog: model(), $transaction: vi.fn() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/hospital-enrollments/hospital-enrollments.routes.js');
const app = express(); app.use(express.json()); app.use('/api/v1/hospital-enrollments', routes);
process.env.JWT_SECRET = 'enrollment-test';
const patient = '11111111-1111-4111-8111-111111111111', owner = '22222222-2222-4222-822222222222', other = '33333333-3333-4333-8333-333333333333', hospital = '44444444-4444-4444-8444-444444444444', plan = '55555555-5555-4555-8555-555555555555', enrollment = '66666666-6666-4666-8666-666666666666';
const auth = (id) => ({ Authorization: `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}` });
const matches = (row, where) => !where || Object.entries(where).every(([key, value]) => {
  if (key === 'hospital') return matches(db.hospitals.find((h) => h.id === row.hospitalId), value);
  if (key === 'status' && value?.in) return value.in.includes(row.status);
  return value && typeof value === 'object' ? matches(row[key], value) : (value === null ? row[key] == null : row[key] === value);
});
let db;
beforeEach(() => {
  vi.resetAllMocks(); db = { roles: [{ userId: patient, role: 'PATIENT' }, { userId: owner, role: 'ORGANISATION_OWNER' }], hospitals: [{ id: hospital, ownerId: owner, type: 'HOSPITAL', status: 'VERIFIED', name: 'Sabi Hospital' }], plans: [{ id: plan, hospitalId: hospital, status: 'ACTIVE', name: 'Care', feeMinor: 9000 }], enrollments: [], audits: [] };
  prisma.userRole.findFirst.mockImplementation(async ({ where }) => db.roles.find((x) => matches(x, where)) ?? null);
  prisma.organisation.findFirst.mockImplementation(async ({ where }) => db.hospitals.find((x) => matches(x, where)) ?? null);
  prisma.hospitalMemberPlan.findFirst.mockImplementation(async ({ where }) => db.plans.find((x) => matches(x, where)) ?? null);
  prisma.hospitalEnrollment.findFirst.mockImplementation(async ({ where }) => db.enrollments.find((x) => matches(x, where)) ?? null);
  prisma.hospitalEnrollment.create.mockImplementation(async ({ data }) => { const row = { id: enrollment, status: 'PENDING', createdAt: new Date(), updatedAt: new Date(), decisionReason: null, decidedAt: null, ...data, hospital: db.hospitals[0], plan: db.plans[0] }; db.enrollments.push(row); return row; });
  prisma.hospitalEnrollment.findMany.mockImplementation(async ({ where }) => db.enrollments.filter((x) => matches(x, where)));
  prisma.hospitalEnrollment.count.mockImplementation(async ({ where }) => db.enrollments.filter((x) => matches(x, where)).length);
  prisma.hospitalEnrollment.updateMany.mockImplementation(async ({ where, data }) => { const rows = db.enrollments.filter((x) => matches(x, where)); rows.forEach((x) => Object.assign(x, data)); return { count: rows.length }; });
  prisma.activityLog.create.mockImplementation(async ({ data }) => { db.audits.push(data); return data; }); prisma.$transaction.mockImplementation((fn) => fn(prisma));
});
it('creates a patient-owned pending request and records only its identifier', async () => {
  const res = await request(app).post('/api/v1/hospital-enrollments').set(auth(patient)).send({ hospitalId: hospital, planId: plan, patientNote: 'Please review' });
  expect(res.status).toBe(201); expect(res.body.data.status).toBe('PENDING'); expect(db.audits[0].meta).toEqual({ enrollmentId: enrollment });
});
it('blocks duplicate open requests, permits rejected resubmission, and scopes patient reads', async () => {
  await request(app).post('/api/v1/hospital-enrollments').set(auth(patient)).send({ hospitalId: hospital, planId: plan });
  expect((await request(app).post('/api/v1/hospital-enrollments').set(auth(patient)).send({ hospitalId: hospital, planId: plan })).status).toBe(409);
  db.enrollments[0].status = 'REJECTED'; expect((await request(app).post('/api/v1/hospital-enrollments').set(auth(patient)).send({ hospitalId: hospital, planId: plan })).status).toBe(201);
  expect((await request(app).get(`/api/v1/hospital-enrollments/${enrollment}`).set(auth(other))).status).toBe(404);
});
it('allows only the verified owner to decide pending requests', async () => {
  await request(app).post('/api/v1/hospital-enrollments').set(auth(patient)).send({ hospitalId: hospital, planId: plan });
  expect((await request(app).post(`/api/v1/hospital-enrollments/${enrollment}/approve`).set(auth(patient)).send({})).status).toBe(404);
  expect((await request(app).post(`/api/v1/hospital-enrollments/${enrollment}/approve`).set(auth(owner)).send({})).body.data).toEqual({ id: enrollment, status: 'ACTIVE' });
  expect(db.audits.at(-1).type).toBe('HOSPITAL_ENROLLMENT_APPROVED');
});
it('rejects invalid bodies and authentication without exposing database errors', async () => {
  expect((await request(app).post('/api/v1/hospital-enrollments').send({ hospitalId: hospital, planId: plan })).status).toBe(401);
  expect((await request(app).post('/api/v1/hospital-enrollments').set(auth(patient)).send({ hospitalId: 'bad', planId: plan, status: 'ACTIVE' })).status).toBe(400);
  prisma.userRole.findFirst.mockRejectedValueOnce(new Error('private database password'));
  const res = await request(app).get('/api/v1/hospital-enrollments/mine').set(auth(patient)); expect(res.body.message).toBe('Hospital enrollment service temporarily unavailable');
});
