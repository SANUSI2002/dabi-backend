// The portal audit trail on a real database: sign-ins with device and location, who opened whose
// health record (seen by both sides, worded for each), everyday activity, and the guarantees around
// it (append-only, no network details shown to others, repeat views counted once). Synthetic data only.
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { prisma, tokenFor } from './fixtures.js';

const PASSWORD = 'synthetic-passphrase-for-tests';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const LAGOS = { 'x-vercel-ip-city': 'Lagos', 'x-vercel-ip-country-region': 'LA', 'x-vercel-ip-country': 'NG' };

async function account(label, { professionType, role = professionType ? 'PROFESSIONAL' : 'PATIENT' } = {}) {
  const tag = randomUUID().slice(0, 8);
  const user = await prisma.user.create({ data: {
    patientId: `SABI-AU-${tag}`, email: `${label}-${tag}@audit.test`, password: await bcrypt.hash(PASSWORD, 4), full_name: `${label} ${tag}`,
    accountStatus: 'ACTIVE', emailVerifiedAt: new Date(), roles: { create: { role } },
  } });
  const profile = professionType ? await prisma.professionalProfile.create({ data: { userId: user.id, professionType, registrationNumber: `REG-${tag}`, verificationStatus: 'VERIFIED' } }) : null;
  return { id: user.id, email: user.email, name: user.full_name, profileId: profile?.id, auth: tokenFor(user.id) };
}
const mine = (who, query = '') => request(app).get(`/api/v1/audit/mine${query}`).set('Authorization', who.auth);

let patient; let doctor; let stranger; let appointment;
beforeAll(async () => {
  [patient, doctor, stranger] = await Promise.all([account('patient'), account('doctor', { professionType: 'DOCTOR' }), account('stranger')]);
  const startsAt = new Date(Date.now() - 40 * 60_000);
  const slot = await prisma.doctorAvailabilitySlot.create({ data: { doctorProfileId: doctor.profileId, startsAt, endsAt: new Date(startsAt.getTime() + 20 * 60_000), consultationTypes: ['VIRTUAL'] } });
  appointment = await prisma.doctorAppointment.create({ data: { patientId: patient.id, doctorProfileId: doctor.profileId, slotId: slot.id, startsAt, endsAt: slot.endsAt, consultationType: 'VIRTUAL', status: 'COMPLETED', completedAt: new Date() } });
});

describe('sign-ins', () => {
  it('records the time, device and approximate location of a sign-in, for the account holder only', async () => {
    const signedIn = await request(app).post('/api/v1/auth/login').set('User-Agent', ANDROID_CHROME).set(LAGOS).send({ email: patient.email, password: PASSWORD });
    expect(signedIn.status).toBe(200);
    const [entry] = (await mine(patient, '?category=SIGN_IN')).body.data.items;
    expect(entry).toMatchObject({ action: 'SIGNED_IN', text: 'You signed in', device: 'Chrome on Android', location: { city: 'Lagos', region: 'LA', country: 'NG' } });
    expect(entry.ip).toMatch(/\.x\.x$|:…$/);
    expect(Date.now() - new Date(entry.at).getTime()).toBeLessThan(60_000);
  });

  it('shows the account holder failed attempts on their account', async () => {
    expect((await request(app).post('/api/v1/auth/login').send({ email: patient.email, password: 'wrong-password' })).status).toBe(401);
    const [entry] = (await mine(patient, '?category=SIGN_IN')).body.data.items;
    expect(entry.text).toBe('Someone tried to sign in to your account with a wrong password');
  });
});

describe('access to a patient record', () => {
  it('is shown to both sides, in their own words, and only to them', async () => {
    const opened = await request(app).get(`/api/v1/consultation-notes/practice/appointments/${appointment.id}`).set('Authorization', doctor.auth).set('User-Agent', ANDROID_CHROME).set(LAGOS);
    expect(opened.status).toBe(200);

    const doctorSees = (await mine(doctor, '?category=RECORD_ACCESS')).body.data.items[0];
    expect(doctorSees).toMatchObject({ action: 'CONSULTATION_NOTE_VIEWED', side: 'actor', text: `You opened ${patient.name}'s consultation note`, device: 'Chrome on Android' });

    const patientSees = (await mine(patient, '?category=RECORD_ACCESS')).body.data.items[0];
    expect(patientSees).toMatchObject({ action: 'CONSULTATION_NOTE_VIEWED', side: 'subject', text: `${doctor.name} opened the notes about your consultation` });
    // The doctor's network and device are not the patient's business.
    expect(patientSees).not.toHaveProperty('ip');
    expect(patientSees).not.toHaveProperty('device');
    expect(patientSees).not.toHaveProperty('location');

    expect((await mine(stranger)).body.data.items).toEqual([]);
  });

  it('counts repeat views within a short window once', async () => {
    const before = await prisma.auditEvent.count({ where: { actorUserId: doctor.id, action: 'CONSULTATION_NOTE_VIEWED' } });
    for (let i = 0; i < 3; i += 1) await request(app).get(`/api/v1/consultation-notes/practice/appointments/${appointment.id}`).set('Authorization', doctor.auth);
    expect(await prisma.auditEvent.count({ where: { actorUserId: doctor.id, action: 'CONSULTATION_NOTE_VIEWED' } })).toBe(before);
  });
});

describe('everyday activity', () => {
  it('records changes made through the portals in plain words', async () => {
    const notification = await prisma.notification.create({ data: { userId: patient.id, title: 'Synthetic', message: 'Synthetic' } });
    expect((await request(app).patch(`/api/v1/notifications/${notification.id}/read`).set('Authorization', patient.auth)).status).toBe(200);
    // Written after the response is sent.
    await expect.poll(async () => (await mine(patient, '?category=ACTIVITY')).body.data.items[0]?.text).toBe('You marked a notification as read');
  });

  it('pages through older entries with a cursor', async () => {
    const first = (await mine(patient, '?limit=1')).body.data;
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = (await mine(patient, `?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).body.data;
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(new Date(second.items[0].at) <= new Date(first.items[0].at)).toBe(true);
  });
});

describe('guarantees', () => {
  it('entries cannot be edited or deleted', async () => {
    const entry = await prisma.auditEvent.findFirst({ where: { actorUserId: patient.id } });
    await expect(prisma.auditEvent.update({ where: { id: entry.id }, data: { summary: 'changed' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditEvent.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
  });

  it('needs a signed-in person and rejects malformed filters', async () => {
    expect((await request(app).get('/api/v1/audit/mine')).status).toBe(401);
    expect((await mine(patient, '?category=EVERYTHING')).status).toBe(400);
  });
});
