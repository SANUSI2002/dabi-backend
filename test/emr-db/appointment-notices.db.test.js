// Appointment and care updates on a real database: the patient hears about a doctor's decisions and
// gets appointment reminders, in the app and (when they chose it) on WhatsApp via the local simulator.
// WhatsApp never names the doctor or the reason for the visit. Synthetic data only.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { prisma, tokenFor } from './fixtures.js';
import { simulator } from '../../src/modules/whatsapp/whatsapp.provider.js';
import { deliverDue } from '../../src/modules/notifications/notification.delivery.js';
import { sendAppointmentReminders, whenLabel } from '../../src/modules/notifications/appointment.notices.js';

process.env.WHATSAPP_PROVIDER = 'simulator';
process.env.WHATSAPP_APP_SECRET = 'synthetic-whatsapp-app-secret';

const HOUR = 3_600_000;
let seq = 5000;

async function account(label, role) {
  const tag = randomUUID().slice(0, 8);
  const user = await prisma.user.create({ data: { patientId: `SABI-AN-${tag}`, email: `${label}-${tag}@notices.test`, password: 'x', full_name: `${label} ${tag}`, accountStatus: 'ACTIVE', emailVerifiedAt: new Date(), roles: { create: { role } } } });
  return { id: user.id, name: user.full_name, auth: tokenFor(user.id) };
}
async function doctor() {
  const who = await account('Dr Synthetic', 'PROFESSIONAL');
  const profile = await prisma.professionalProfile.create({ data: { userId: who.id, professionType: 'DOCTOR', registrationNumber: `REG-${randomUUID().slice(0, 6)}`, verificationStatus: 'VERIFIED' } });
  return { ...who, profileId: profile.id };
}
/** A patient who chose to receive the given categories on WhatsApp. */
async function patientOnWhatsApp(categories = ['MEDICATION', 'APPOINTMENT', 'CARE']) {
  const who = await account('patient', 'PATIENT');
  const phone = `+23481${String(10000000 + (seq++)).slice(-8)}`;
  await prisma.whatsAppConnection.create({ data: { userId: who.id, phone, status: 'ACTIVE', verifiedAt: new Date() } });
  await prisma.notificationPreference.create({ data: { userId: who.id, whatsappEnabled: true, whatsappCategories: categories, consentVersion: 'whatsapp-notifications-v1', consentedAt: new Date() } });
  return { ...who, phone };
}
async function appointment(pat, doc, { inHours = 30, status = 'REQUESTED', confirmedHoursAgo = 48, type = 'VIRTUAL' } = {}) {
  const startsAt = new Date(Date.now() + inHours * HOUR);
  const slot = await prisma.doctorAvailabilitySlot.create({ data: { doctorProfileId: doc.profileId, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), consultationTypes: [type] } });
  return prisma.doctorAppointment.create({ data: {
    patientId: pat.id, doctorProfileId: doc.profileId, slotId: slot.id, startsAt, endsAt: slot.endsAt, consultationType: type, status, reason: 'Synthetic chest pain review',
    ...(status === 'CONFIRMED' ? { confirmedAt: new Date(Date.now() - confirmedHoursAgo * HOUR) } : {}),
  } });
}
const latest = (userId, eventType) => prisma.notification.findFirst({ where: { userId, eventType }, orderBy: { createdAt: 'desc' }, include: { deliveries: true } });
const sentTo = (phone) => simulator.messages(phone).filter((m) => m.type === 'template');

beforeEach(() => simulator.reset());

describe('doctor decisions', () => {
  it('a confirmation reaches the bell and WhatsApp, without the doctor or reason on WhatsApp', async () => {
    const [pat, doc] = await Promise.all([patientOnWhatsApp(), doctor()]);
    const a = await appointment(pat, doc);
    const confirmed = await request(app).post(`/api/v1/doctor-appointments/practice/appointments/${a.id}/confirm`).set('Authorization', doc.auth).send({});
    expect(confirmed.status).toBe(200);
    const note = await latest(pat.id, 'appointment.confirmed');
    expect(note).toMatchObject({ title: 'Your appointment is confirmed', category: 'APPOINTMENT', link: '/appointments' });
    expect(note.message).toContain(`${doc.name} confirmed your video consultation ${whenLabel(a.startsAt, 'Africa/Lagos')}.`);
    expect(note.message).toContain('You can join from Appointments in Sabi.');
    await deliverDue();
    const [message] = sentTo(pat.phone);
    expect(message.text).toBe('You have a new update in Sabi: Your appointment is confirmed. Open Sabi to view it.');
    expect(message.text).not.toContain(doc.name);
    expect(message.text).not.toContain('chest');
  });

  it('declines and cancellations are announced; completing is not', async () => {
    const [pat, doc] = await Promise.all([patientOnWhatsApp(['MEDICATION']), doctor()]);
    const declined = await appointment(pat, doc);
    expect((await request(app).post(`/api/v1/doctor-appointments/practice/appointments/${declined.id}/decline`).set('Authorization', doc.auth).send({ reason: 'Fully booked that day' })).status).toBe(200);
    expect((await latest(pat.id, 'appointment.declined')).title).toBe('Appointment request not accepted');

    const cancelled = await appointment(pat, doc, { status: 'CONFIRMED' });
    expect((await request(app).post(`/api/v1/doctor-appointments/practice/appointments/${cancelled.id}/cancel`).set('Authorization', doc.auth).send({ reason: 'Called away' })).status).toBe(200);
    const note = await latest(pat.id, 'appointment.cancelled');
    expect(note.title).toBe('Your appointment was cancelled');
    expect(note.deliveries).toHaveLength(0); // appointment updates not chosen for WhatsApp: bell only
  });

  it('accepting a care request tells the patient', async () => {
    const [pat, doc] = await Promise.all([patientOnWhatsApp(), doctor()]);
    const relation = await prisma.doctorCareRelationship.create({ data: { patientId: pat.id, doctorProfileId: doc.profileId } });
    expect((await request(app).post(`/api/v1/doctor-care/relationships/${relation.id}/accept`).set('Authorization', doc.auth).send({})).status).toBe(200);
    expect(await latest(pat.id, 'care.accepted')).toMatchObject({ title: 'Your doctor accepted your request', category: 'CARE', link: '/doctor' });
  });
});

describe('appointment reminders', () => {
  it('sends the day-before and one-hour reminders once each, in the patient time zone', async () => {
    const [pat, doc] = await Promise.all([patientOnWhatsApp(), doctor()]);
    const a = await appointment(pat, doc, { inHours: 20, status: 'CONFIRMED' });
    await sendAppointmentReminders();
    await sendAppointmentReminders();
    const dayBefore = await prisma.notification.findMany({ where: { userId: pat.id, eventType: 'appointment.reminder' } });
    expect(dayBefore).toHaveLength(1);
    expect(dayBefore[0].eventKey).toBe(`appointment.reminder:${a.id}:24h`);
    expect(dayBefore[0].message).toBe(`Your video consultation with ${doc.name} is ${whenLabel(a.startsAt, 'Africa/Lagos')}. You can join from Appointments in Sabi.`);

    await deliverDue();
    expect(sentTo(pat.phone)[0].text).toBe(`Reminder: your video consultation is ${whenLabel(a.startsAt, 'Africa/Lagos')}. Open Sabi to join or manage it.`);

    const hourBefore = new Date(a.startsAt.getTime() - 50 * 60_000);
    await sendAppointmentReminders({ now: hourBefore });
    await sendAppointmentReminders({ now: hourBefore });
    expect(await prisma.notification.count({ where: { userId: pat.id, eventKey: `appointment.reminder:${a.id}:1h` } })).toBe(1);
  });

  it('skips the day-before reminder right after a late confirmation, and nothing after the start', async () => {
    const [pat, doc] = await Promise.all([patientOnWhatsApp(), doctor()]);
    await appointment(pat, doc, { inHours: 5, status: 'CONFIRMED', confirmedHoursAgo: 0.2 });
    const past = await appointment(pat, doc, { inHours: 2, status: 'CONFIRMED' });
    await sendAppointmentReminders({ now: new Date(past.startsAt.getTime() + 60_000) });
    await sendAppointmentReminders();
    expect(await prisma.notification.count({ where: { userId: pat.id, eventType: 'appointment.reminder' } })).toBe(0);
  });

  it('does not send a WhatsApp reminder for an appointment cancelled in the meantime', async () => {
    const [pat, doc] = await Promise.all([patientOnWhatsApp(), doctor()]);
    const a = await appointment(pat, doc, { inHours: 20, status: 'CONFIRMED' });
    await sendAppointmentReminders();
    await prisma.doctorAppointment.update({ where: { id: a.id }, data: { status: 'CANCELLED', cancelledBy: 'PATIENT', cancelledAt: new Date() } });
    await deliverDue();
    expect(sentTo(pat.phone)).toHaveLength(0);
    expect((await latest(pat.id, 'appointment.reminder')).deliveries[0]).toMatchObject({ status: 'CANCELLED' });
  });
});
