import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = () => vi.fn();
const db = {
  professionalTimeBlock: { findFirst: f() },
  userRole: { findFirst: f() },
  professionalProfile: { findFirst: f(), update: f() },
  dependentProfile: { findFirst: f() },
  doctorAvailabilitySlot: { findFirst: f(), findMany: f(), create: f(), update: f() },
  doctorAppointment: { findFirst: f(), findMany: f(), count: f(), create: f(), updateMany: f() },
  activityLog: { create: f() },
  domainEvent: { create: f() },
  $transaction: f(),
};
vi.mock('../src/config/db.js', () => ({ default: db }));
const { default: routes } = await import('../src/modules/doctor-appointments/doctor-appointments.routes.js');

process.env.JWT_SECRET = 'doctor-appointments-test';
const uid = (n) => `${String(n).padStart(8, '0')}-2222-4222-8222-222222222222`;
const patient = uid(1), doctorUser = uid(2), doctorProfile = uid(3), slot = uid(4), appt = uid(5), dependent = uid(6);
const auth = (id) => ({ Authorization: `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET)}` });
const app = express(); app.use(express.json()); app.use('/doctor-appointments', routes);
const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();
const openSlot = { id: slot, doctorProfileId: doctorProfile, startsAt: new Date(inHours(24)), endsAt: new Date(inHours(24.5)), consultationTypes: ['VIRTUAL'] };

beforeEach(() => {
  vi.clearAllMocks();
  db.professionalTimeBlock.findFirst.mockResolvedValue(null);
  db.$transaction.mockImplementation((work) => work(db));
  db.userRole.findFirst.mockImplementation(async ({ where }) => (where.userId === patient && where.role === 'PATIENT' ? { id: 'role' } : null));
  db.professionalProfile.findFirst.mockImplementation(async ({ where }) => (where.userId === doctorUser || where.id === doctorProfile ? { id: doctorProfile } : null));
  db.doctorAvailabilitySlot.findFirst.mockResolvedValue(openSlot);
  db.doctorAvailabilitySlot.findMany.mockResolvedValue([]);
  db.doctorAppointment.create.mockImplementation(async ({ data }) => ({ id: appt, ...data, status: 'REQUESTED', doctorProfile: { id: doctorProfile, specialty: 'Cardiology', practiceName: 'Heart Clinic', practiceAddress: null, user: { full_name: 'Dr Ada' } } }));
  db.doctorAppointment.findFirst.mockResolvedValue({ id: appt, status: 'CONFIRMED', patient: { full_name: 'Pat Ient', patientId: '#SHM1' }, dependent: null });
  db.doctorAppointment.updateMany.mockResolvedValue({ count: 1 });
  db.activityLog.create.mockResolvedValue({});
});

describe('patient booking', () => {
  it('books an open slot for a VIRTUAL consultation and returns the doctor summary', async () => {
    const res = await request(app).post('/doctor-appointments').set(auth(patient)).send({ slotId: slot, consultationType: 'VIRTUAL', reason: 'Chest pain follow-up' });
    expect(res.status).toBe(201);
    expect(db.doctorAppointment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ patientId: patient, doctorProfileId: doctorProfile, slotId: slot, consultationType: 'VIRTUAL', startsAt: openSlot.startsAt, endsAt: openSlot.endsAt }),
    }));
    expect(res.body.data.doctor).toEqual({ id: doctorProfile, name: 'Dr Ada', specialty: 'Cardiology', practiceName: 'Heart Clinic', practiceAddress: null });
    // The slot lookup only matches open, future slots of verified doctors.
    const where = db.doctorAvailabilitySlot.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: slot, cancelledAt: null, appointments: { none: { status: { in: ['REQUESTED', 'CONFIRMED'] } } }, doctorProfile: { professionType: 'DOCTOR', verificationStatus: 'VERIFIED' } });
  });

  it('rejects a type the slot does not offer, an unavailable slot, a lost race, and non-patients', async () => {
    expect((await request(app).post('/doctor-appointments').set(auth(patient)).send({ slotId: slot, consultationType: 'IN_PERSON' })).body.code).toBe('TYPE_NOT_OFFERED');
    db.doctorAvailabilitySlot.findFirst.mockResolvedValueOnce(null);
    const gone = await request(app).post('/doctor-appointments').set(auth(patient)).send({ slotId: slot, consultationType: 'VIRTUAL' });
    expect([gone.status, gone.body.code]).toEqual([409, 'SLOT_UNAVAILABLE']);
    db.doctorAppointment.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    const raced = await request(app).post('/doctor-appointments').set(auth(patient)).send({ slotId: slot, consultationType: 'VIRTUAL' });
    expect([raced.status, raced.body.code]).toEqual([409, 'SLOT_UNAVAILABLE']);
    expect((await request(app).post('/doctor-appointments').set(auth(doctorUser)).send({ slotId: slot, consultationType: 'VIRTUAL' })).status).toBe(403);
  });

  it('only books for the patient\'s own dependents', async () => {
    db.dependentProfile.findFirst.mockResolvedValueOnce(null);
    expect((await request(app).post('/doctor-appointments').set(auth(patient)).send({ slotId: slot, consultationType: 'VIRTUAL', dependentId: dependent })).status).toBe(404);
    expect(db.dependentProfile.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: dependent, patientId: patient } }));
  });

  it('cancels only its own active, future appointments', async () => {
    expect((await request(app).post(`/doctor-appointments/${appt}/cancel`).set(auth(patient)).send({})).status).toBe(200);
    expect(db.doctorAppointment.updateMany.mock.calls[0][0].where).toMatchObject({ id: appt, patientId: patient, status: { in: ['REQUESTED', 'CONFIRMED'] } });
    db.doctorAppointment.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await request(app).post(`/doctor-appointments/${appt}/cancel`).set(auth(patient)).send({})).body.code).toBe('INVALID_STATE');
  });

  it('reschedules only onto another slot of the same doctor', async () => {
    db.doctorAppointment.findFirst.mockResolvedValueOnce({ id: appt, doctorProfileId: doctorProfile, dependentId: null, consultationType: 'VIRTUAL', reason: null });
    db.doctorAvailabilitySlot.findFirst.mockResolvedValueOnce({ ...openSlot, id: uid(9), doctorProfileId: uid(99) });
    const other = await request(app).post(`/doctor-appointments/${appt}/reschedule`).set(auth(patient)).send({ slotId: uid(9) });
    expect(other.body.code).toBe('SLOT_UNAVAILABLE');
  });

  it('validates input strictly', async () => {
    expect((await request(app).post('/doctor-appointments').set(auth(patient)).send({ slotId: slot, consultationType: 'PHONE' })).status).toBe(400);
    expect((await request(app).post('/doctor-appointments').set(auth(patient)).send({ slotId: slot, consultationType: 'VIRTUAL', patientId: uid(7) })).status).toBe(400);
    expect((await request(app).get('/doctor-appointments/mine')).status).toBe(401);
  });
});

describe('doctor workspace', () => {
  it('reads a single appointment only for the verified doctor who owns it', async () => {
    const result = await request(app).get(`/doctor-appointments/practice/appointments/${appt}`).set(auth(doctorUser));
    expect(result.status).toBe(200);
    expect(db.doctorAppointment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: appt, doctorProfileId: doctorProfile } }));
    db.doctorAppointment.findFirst.mockResolvedValueOnce(null);
    expect((await request(app).get(`/doctor-appointments/practice/appointments/${uid(99)}`).set(auth(doctorUser))).status).toBe(404);
    expect((await request(app).get(`/doctor-appointments/practice/appointments/${appt}`).set(auth(patient))).status).toBe(403);
    expect((await request(app).get(`/doctor-appointments/practice/appointments/${appt}`)).status).toBe(401);
  });
  it('refuses anyone who is not a verified doctor', async () => {
    expect((await request(app).get('/doctor-appointments/practice/appointments').set(auth(patient))).status).toBe(403);
    expect((await request(app).post('/doctor-appointments/practice/slots').set(auth(patient)).send({ slots: [{ startsAt: inHours(30), endsAt: inHours(30.5), consultationTypes: ['VIRTUAL'] }] })).status).toBe(403);
  });

  it('publishes slots, rejecting overlaps with existing slots and bad durations', async () => {
    db.doctorAvailabilitySlot.findFirst.mockResolvedValue(null);
    db.doctorAvailabilitySlot.create.mockImplementation(async ({ data }) => ({ id: uid(20), ...data, cancelledAt: null }));
    const ok = await request(app).post('/doctor-appointments/practice/slots').set(auth(doctorUser)).send({ slots: [
      { startsAt: inHours(30), endsAt: inHours(30.5), consultationTypes: ['VIRTUAL', 'IN_PERSON'] },
      { startsAt: inHours(31), endsAt: inHours(31.5), consultationTypes: ['IN_PERSON'] },
    ] });
    expect(ok.status).toBe(201); expect(ok.body.data.items).toHaveLength(2);
    db.doctorAvailabilitySlot.findFirst.mockResolvedValueOnce({ id: uid(21) });
    const overlap = await request(app).post('/doctor-appointments/practice/slots').set(auth(doctorUser)).send({ slots: [{ startsAt: inHours(40), endsAt: inHours(40.5), consultationTypes: ['VIRTUAL'] }] });
    expect(overlap.body.code).toBe('SLOT_OVERLAP');
    const bad = (slots) => request(app).post('/doctor-appointments/practice/slots').set(auth(doctorUser)).send({ slots });
    expect((await bad([{ startsAt: inHours(40), endsAt: inHours(45), consultationTypes: ['VIRTUAL'] }])).status).toBe(400); // 5 hours
    expect((await bad([{ startsAt: inHours(-1), endsAt: inHours(-0.5), consultationTypes: ['VIRTUAL'] }])).status).toBe(400); // past
    expect((await bad([{ startsAt: inHours(40), endsAt: inHours(40.5), consultationTypes: [] }])).status).toBe(400);
    expect((await bad([{ startsAt: inHours(40), endsAt: inHours(41), consultationTypes: ['VIRTUAL'] }, { startsAt: inHours(40.5), endsAt: inHours(41.5), consultationTypes: ['VIRTUAL'] }])).status).toBe(400); // overlap in batch
  });

  it('will not cancel a slot that has an active booking', async () => {
    db.doctorAvailabilitySlot.findFirst.mockResolvedValueOnce({ id: slot });
    db.doctorAppointment.findFirst.mockResolvedValueOnce({ id: appt });
    expect((await request(app).delete(`/doctor-appointments/practice/slots/${slot}`).set(auth(doctorUser))).body.code).toBe('SLOT_BOOKED');
  });

  it('confirms only REQUESTED future appointments and accepts only https meeting links', async () => {
    const res = await request(app).post(`/doctor-appointments/practice/appointments/${appt}/confirm`).set(auth(doctorUser)).send({ meetingUrl: 'https://meet.example.com/abc' });
    expect(res.status).toBe(200);
    const call = db.doctorAppointment.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: appt, doctorProfileId: doctorProfile, status: 'REQUESTED' });
    expect(call.data).toMatchObject({ status: 'CONFIRMED', meetingUrl: 'https://meet.example.com/abc' });
    expect((await request(app).post(`/doctor-appointments/practice/appointments/${appt}/confirm`).set(auth(doctorUser)).send({ meetingUrl: 'http://insecure.example.com' })).status).toBe(400);
    expect((await request(app).post(`/doctor-appointments/practice/appointments/${appt}/confirm`).set(auth(doctorUser)).send({ meetingUrl: 'javascript:alert(1)' })).status).toBe(400);
    db.doctorAppointment.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await request(app).post(`/doctor-appointments/practice/appointments/${appt}/confirm`).set(auth(doctorUser)).send({})).body.code).toBe('INVALID_STATE');
  });

  it('requires a reason to decline or cancel, and only completes appointments that have started', async () => {
    expect((await request(app).post(`/doctor-appointments/practice/appointments/${appt}/decline`).set(auth(doctorUser)).send({})).status).toBe(400);
    expect((await request(app).post(`/doctor-appointments/practice/appointments/${appt}/decline`).set(auth(doctorUser)).send({ reason: 'Fully booked that day' })).status).toBe(200);
    expect(db.doctorAppointment.updateMany.mock.calls.at(-1)[0].data).toEqual({ status: 'DECLINED', decisionReason: 'Fully booked that day' });
    await request(app).post(`/doctor-appointments/practice/appointments/${appt}/complete`).set(auth(doctorUser)).send({});
    expect(db.doctorAppointment.updateMany.mock.calls.at(-1)[0].where).toMatchObject({ status: 'CONFIRMED', startsAt: { lte: expect.any(Date) } });
    // Completion is published for other modules (the EMR handoff) in the same transaction.
    expect(db.domainEvent.create).toHaveBeenCalledWith({ data: { type: 'doctor_appointment.completed', aggregateType: 'doctor_appointment', aggregateId: appt } });
  });

  it('shows doctors only the minimum identity of their patients', async () => {
    db.doctorAppointment.findMany.mockResolvedValueOnce([{ id: appt, status: 'REQUESTED', patient: { full_name: 'Pat Ient', patientId: '#SHM1' }, dependent: { fullName: 'Kid', dateOfBirth: new Date('2019-01-01') } }]);
    db.doctorAppointment.count.mockResolvedValueOnce(1);
    const res = await request(app).get('/doctor-appointments/practice/appointments').set(auth(doctorUser));
    expect(res.body.data.items[0]).toMatchObject({ patient: { name: 'Pat Ient', patientId: '#SHM1' }, dependent: { name: 'Kid' } });
    const select = db.doctorAppointment.findMany.mock.calls[0][0].select;
    expect(select.patient).toEqual({ select: { id: true, full_name: true, patientId: true } });
    expect(db.doctorAppointment.findMany.mock.calls[0][0].where).toMatchObject({ doctorProfileId: doctorProfile });
  });
});
