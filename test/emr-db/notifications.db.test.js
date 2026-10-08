// Notifications, WhatsApp and medication reminders on a real database, with the local WhatsApp
// simulator standing in for Meta. Covers the milestone loop — enable WhatsApp → reminder → tap Taken →
// the same dose shows as taken in Sabi — and the guarantees around it: consent, number changes,
// idempotency, no stale or duplicate reminders, retries, opt-out re-checks and signed webhooks.
// Synthetic data only; nothing leaves the machine.
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { prisma, tokenFor } from './fixtures.js';
import { simulator } from '../../src/modules/whatsapp/whatsapp.provider.js';
import { notify } from '../../src/modules/notifications/notify.service.js';
import { deliverDue } from '../../src/modules/notifications/notification.delivery.js';
import { materializeDue, processDueReminders } from '../../src/modules/medication-schedules/schedule.service.js';
import { localClock, localDay } from '../../src/modules/medication-schedules/schedule.time.js';

const SECRET = 'synthetic-whatsapp-app-secret';
process.env.WHATSAPP_PROVIDER = 'simulator';
process.env.WHATSAPP_APP_SECRET = SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = 'synthetic-verify-token';

const MINUTE = 60_000;
let phoneSeq = 1000;
const nextPhone = () => `+23480${String(30000000 + (phoneSeq++)).slice(-8)}`;

async function patient(label = 'patient') {
  const tag = randomUUID().slice(0, 8);
  const user = await prisma.user.create({ data: {
    patientId: `SABI-NT-${tag}`, email: `${label}-${tag}@notify.test`, password: 'not-a-real-hash', full_name: `${label} ${tag}`,
    accountStatus: 'ACTIVE', emailVerifiedAt: new Date(), roles: { create: { role: 'PATIENT' } },
  } });
  return { id: user.id, auth: tokenFor(user.id) };
}
const as = (who) => ({
  get: (url) => request(app).get(url).set('Authorization', who.auth),
  post: (url, body = {}) => request(app).post(url).set('Authorization', who.auth).send(body),
  put: (url, body) => request(app).put(url).set('Authorization', who.auth).send(body),
  patch: (url, body) => request(app).patch(url).set('Authorization', who.auth).send(body),
  delete: (url) => request(app).delete(url).set('Authorization', who.auth),
});
const lastCode = (phone) => /(\d{6}) is your Sabi verification code/.exec(simulator.messages(phone).filter((m) => m.template === 'sabi_verification_code').at(-1)?.text ?? '')?.[1];

async function linkWhatsApp(who, phone = nextPhone()) {
  expect((await as(who).post('/api/v1/notifications/settings/whatsapp', { phone, consent: true })).status).toBe(200);
  const verified = await as(who).post('/api/v1/notifications/settings/whatsapp/verify', { code: lastCode(phone) });
  expect(verified.status).toBe(200);
  return phone;
}

const signed = (body) => {
  const raw = JSON.stringify(body);
  return request(app).post('/api/v1/whatsapp/webhook').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`).send(raw);
};
const tap = (phone, payload, id = `wamid.IN${randomUUID()}`) => signed({ entry: [{ changes: [{ value: { messages: [{ id, from: phone.slice(1), type: 'button', button: { payload, text: 'x' } }] } }] }] });
const lastReply = (phone) => simulator.messages(phone).filter((m) => m.type === 'text').at(-1)?.text;
const lastReminder = (phone) => simulator.messages(phone).filter((m) => m.template === 'sabi_medication_reminder').at(-1);

/** A patient medicine with one daily time a few minutes from now (Lagos time). */
async function soonSchedule(who, body = {}) {
  const at = new Date(Date.now() + 5 * MINUTE);
  const created = await as(who).post('/api/v1/medication-schedules', { name: 'Synthetic Amlodipine', dosage: '5 mg', times: [localClock(at, 'Africa/Lagos')], ...body });
  expect(created.status).toBe(200);
  const dose = await prisma.medicationDose.findFirst({ where: { scheduleId: created.body.data.id }, orderBy: { scheduledFor: 'asc' }, include: { reminder: true } });
  return { schedule: created.body.data, dose };
}
const runAt = async (when) => { await processDueReminders({ now: when }); await deliverDue({ now: when }); };
const after = (dose, minutes = 1) => new Date(dose.scheduledFor.getTime() + minutes * MINUTE);

beforeEach(() => simulator.reset());

describe('WhatsApp settings and consent', () => {
  it('links a number with a 6-digit code and records consent', async () => {
    const who = await patient();
    const initial = (await as(who).get('/api/v1/notifications/settings')).body.data;
    expect(initial).toMatchObject({ preferences: { whatsappEnabled: false, whatsappCategories: ['MEDICATION'], showMedicationDetails: false }, whatsapp: { available: true, connection: null } });

    expect((await as(who).post('/api/v1/notifications/settings/whatsapp', { phone: '0803 000 0000' })).status).toBe(400); // no consent
    const phone = nextPhone();
    const started = await as(who).post('/api/v1/notifications/settings/whatsapp', { phone: `0${phone.slice(4)}`, consent: true }); // Nigerian local format
    expect(started.status).toBe(200);
    expect(started.body.data.whatsapp.pending).toMatchObject({ phone: `${phone.slice(0, 4)} *** *** ${phone.slice(-4)}`, attemptsLeft: 5 });
    const code = lastCode(phone);
    expect(code).toMatch(/^\d{6}$/);

    const wrong = await as(who).post('/api/v1/notifications/settings/whatsapp/verify', { code: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ code: 'WRONG_CODE', attemptsLeft: 4 });

    const verified = await as(who).post('/api/v1/notifications/settings/whatsapp/verify', { code });
    expect(verified.status).toBe(200);
    expect(verified.body.data.preferences).toMatchObject({ whatsappEnabled: true, consentVersion: 'whatsapp-notifications-v1' });
    expect(verified.body.data.whatsapp.connection).toBeTruthy();
    const stored = await prisma.whatsAppConnection.findFirst({ where: { userId: who.id, status: 'ACTIVE' } });
    expect(stored).toMatchObject({ phone, codeHash: null });
    const [audit] = (await as(who).get('/api/v1/audit/mine?category=ACCOUNT')).body.data.items;
    expect(audit.action).toBe('WHATSAPP_ENABLED');
    const activity = (await as(who).get('/api/v1/audit/mine?category=ACTIVITY')).body.data.items.map((item) => item.text);
    expect(activity).toContain('You asked for a WhatsApp verification code');
  });

  it('refuses a number already linked to another account, and expired or exhausted codes', async () => {
    const [owner, other] = await Promise.all([patient('owner'), patient('other')]);
    const phone = await linkWhatsApp(owner);
    expect((await as(other).post('/api/v1/notifications/settings/whatsapp', { phone, consent: true })).body.code).toBe('NUMBER_IN_USE');

    const second = nextPhone();
    await as(other).post('/api/v1/notifications/settings/whatsapp', { phone: second, consent: true });
    await prisma.whatsAppConnection.updateMany({ where: { userId: other.id, status: 'PENDING' }, data: { codeExpiresAt: new Date(Date.now() - 1000) } });
    expect((await as(other).post('/api/v1/notifications/settings/whatsapp/verify', { code: lastCode(second) })).status).toBe(410);
    expect((await as(other).post('/api/v1/notifications/settings/whatsapp/resend')).body.code).toBe('RESEND_TOO_SOON');
  });

  it('changes the number only after the new one is verified, then rejects buttons sent to the old one', async () => {
    const who = await patient();
    const oldPhone = await linkWhatsApp(who);
    const { dose } = await soonSchedule(who);
    await runAt(after(dose));
    const oldButton = lastReminder(oldPhone).buttons[0].payload;

    const newPhone = nextPhone();
    await as(who).post('/api/v1/notifications/settings/whatsapp', { phone: newPhone, consent: true });
    expect(await prisma.whatsAppConnection.count({ where: { userId: who.id, status: 'ACTIVE', phone: oldPhone } })).toBe(1); // still works meanwhile
    await as(who).post('/api/v1/notifications/settings/whatsapp/verify', { code: lastCode(newPhone) });
    expect(await prisma.whatsAppConnection.findFirst({ where: { userId: who.id, phone: oldPhone } })).toMatchObject({ status: 'REVOKED', revokedReason: 'NUMBER_CHANGED' });

    expect((await tap(oldPhone, oldButton)).status).toBe(200);
    expect(lastReply(oldPhone)).toMatch(/no longer active/);
    expect((await prisma.medicationDose.findUnique({ where: { id: dose.id } })).status).toBe('NOT_CONFIRMED');
    const [audit] = (await as(who).get('/api/v1/audit/mine?category=ACCOUNT')).body.data.items;
    expect(audit.action).toBe('WHATSAPP_NUMBER_CHANGED');
  });

  it('turning WhatsApp off unlinks the number and cancels anything still queued', async () => {
    const who = await patient();
    await linkWhatsApp(who);
    const { dose } = await soonSchedule(who);
    await processDueReminders({ now: after(dose) });
    expect(await prisma.notificationDelivery.count({ where: { userId: who.id, status: 'PENDING' } })).toBe(1);
    const off = await as(who).delete('/api/v1/notifications/settings/whatsapp');
    expect(off.body.data).toMatchObject({ preferences: { whatsappEnabled: false }, whatsapp: { connection: null } });
    expect(await prisma.notificationDelivery.count({ where: { userId: who.id, status: 'CANCELLED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: who.id, eventType: 'medication.dose_due' } })).toBe(1); // the bell keeps it
  });
});

describe('the milestone loop', () => {
  it('reminder on WhatsApp → tap Taken → the same dose is taken in Sabi; a second tap says already recorded', async () => {
    const who = await patient();
    const phone = await linkWhatsApp(who);
    const { dose } = await soonSchedule(who);
    expect(dose.reminder.status).toBe('SCHEDULED');

    await runAt(after(dose));
    const bell = await as(who).get('/api/v1/notifications');
    expect(bell.body.data.items[0]).toMatchObject({ title: 'Time for your medicine', category: 'MEDICATION', link: '/medications' });
    const reminder = lastReminder(phone);
    expect(reminder.text).toMatch(/your (morning|afternoon|evening|night) medicine dose/); // no medicine name unless the patient allows it
    expect(reminder.text).not.toMatch(/Amlodipine/);
    expect(reminder.buttons.map((b) => b.title)).toEqual(['Taken', 'Remind me later']);
    const delivery = await prisma.notificationDelivery.findFirst({ where: { userId: who.id } });
    expect(delivery).toMatchObject({ status: 'SENT', providerMessageId: reminder.id });

    expect((await tap(phone, reminder.buttons[0].payload)).status).toBe(200);
    expect(lastReply(phone)).toMatch(/^Recorded: dose taken at/);
    const today = await as(who).get(`/api/v1/medication-schedules/doses?day=${localDay(dose.scheduledFor, 'Africa/Lagos')}`);
    expect(today.body.data.doses.find((d) => d.id === dose.id)).toMatchObject({ status: 'TAKEN', confirmedVia: 'WHATSAPP' });

    await tap(phone, reminder.buttons[0].payload);
    expect(lastReply(phone)).toBe('Already recorded. You do not need to do anything else.');
    const [audit] = (await as(who).get('/api/v1/audit/mine?category=ACTIVITY')).body.data.items;
    expect(audit.text).toMatch(/dose of Synthetic Amlodipine as taken on WhatsApp$/);
  });

  it('shows the medicine name only when the patient turns that on', async () => {
    const who = await patient();
    const phone = await linkWhatsApp(who);
    expect((await as(who).put('/api/v1/notifications/settings', { showMedicationDetails: true })).status).toBe(200);
    const { dose } = await soonSchedule(who);
    await runAt(after(dose));
    expect(lastReminder(phone).text).toMatch(/Synthetic Amlodipine 5 mg dose/);
  });

  it('Taken in the app is idempotent and cancels the WhatsApp reminder still waiting', async () => {
    const who = await patient();
    await linkWhatsApp(who);
    const { dose } = await soonSchedule(who);
    const first = await as(who).post(`/api/v1/medication-schedules/doses/${dose.id}/taken`);
    expect(first.body.data).toMatchObject({ alreadyRecorded: false, dose: { status: 'TAKEN', confirmedVia: 'APP' } });
    expect((await as(who).post(`/api/v1/medication-schedules/doses/${dose.id}/taken`)).body.data.alreadyRecorded).toBe(true);
    await runAt(after(dose));
    expect((await prisma.reminderJob.findUnique({ where: { doseId: dose.id } })).status).toBe('CANCELLED');
    expect(simulator.messages().filter((m) => m.template === 'sabi_medication_reminder')).toHaveLength(0);
    const stranger = await patient('stranger');
    expect((await as(stranger).post(`/api/v1/medication-schedules/doses/${dose.id}/taken`)).status).toBe(404);
  });
});

describe('reminders', () => {
  it('Remind me later moves only the reminder, at most three times', async () => {
    const who = await patient();
    const phone = await linkWhatsApp(who);
    const { dose } = await soonSchedule(who);
    let when = after(dose);
    await runAt(when);
    for (let round = 1; round <= 3; round += 1) {
      await tap(phone, lastReminder(phone).buttons[1].payload);
      expect(lastReply(phone)).toMatch(/^OK. I'll remind you again at/);
      const job = await prisma.reminderJob.findUnique({ where: { doseId: dose.id } });
      expect(job).toMatchObject({ status: 'SNOOZED', snoozeCount: round });
      when = new Date(job.dueAt.getTime() + 1000);
      await runAt(when);
    }
    expect((await prisma.medicationDose.findUnique({ where: { id: dose.id } })).scheduledFor).toEqual(dose.scheduledFor);
    expect(await prisma.notification.count({ where: { userId: who.id, eventType: 'medication.dose_due' } })).toBe(4);
    await tap(phone, lastReminder(phone).buttons[1].payload);
    expect(lastReply(phone)).toMatch(/snoozed the most times allowed/);
  });

  it('never sends a reminder more than two hours late (after an outage)', async () => {
    const who = await patient();
    await linkWhatsApp(who);
    const { dose } = await soonSchedule(who);
    await runAt(after(dose, 150));
    expect((await prisma.reminderJob.findUnique({ where: { doseId: dose.id } })).status).toBe('EXPIRED');
    expect(await prisma.notification.count({ where: { userId: who.id, eventType: 'medication.dose_due' } })).toBe(0);
    expect((await prisma.medicationDose.findUnique({ where: { id: dose.id } })).status).toBe('NOT_CONFIRMED'); // not a missed dose, just unconfirmed
  });

  it('creates each reminder once, even when the worker runs twice', async () => {
    const who = await patient();
    await linkWhatsApp(who);
    const { dose } = await soonSchedule(who);
    await runAt(after(dose));
    await runAt(after(dose, 2));
    await materializeDue({ now: after(dose, 3) });
    expect(await prisma.notification.count({ where: { userId: who.id, eventType: 'medication.dose_due' } })).toBe(1);
    expect(simulator.messages().filter((m) => m.template === 'sabi_medication_reminder')).toHaveLength(1);
    const again = await notify(prisma, { userId: who.id, eventType: 'medication.dose_due', eventKey: `medication.dose_due:${dose.id}:0`, title: 'x', message: 'y' });
    expect(again.created).toBe(false);
  });

  it('a WhatsApp outage never blocks the in-app notification, and is retried', async () => {
    const who = await patient();
    const phone = await linkWhatsApp(who);
    const { dose } = await soonSchedule(who);
    simulator.failNext({ transient: true });
    const when = after(dose);
    await runAt(when);
    expect(await prisma.notification.count({ where: { userId: who.id, eventType: 'medication.dose_due' } })).toBe(1);
    const waiting = await prisma.notificationDelivery.findFirst({ where: { userId: who.id } });
    expect(waiting).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(waiting.nextAttemptAt.getTime()).toBeGreaterThan(when.getTime());
    await deliverDue({ now: new Date(waiting.nextAttemptAt.getTime() + 1000) });
    expect((await prisma.notificationDelivery.findUnique({ where: { id: waiting.id } })).status).toBe('SENT');
    expect(lastReminder(phone)).toBeTruthy();
  });

  it('re-checks preferences just before sending', async () => {
    const who = await patient();
    await linkWhatsApp(who);
    const { dose } = await soonSchedule(who);
    await processDueReminders({ now: after(dose) });
    await as(who).put('/api/v1/notifications/settings', { whatsappCategories: [] });
    await deliverDue({ now: after(dose) });
    expect(await prisma.notificationDelivery.findFirst({ where: { userId: who.id } })).toMatchObject({ status: 'SKIPPED' });
    expect(simulator.messages().filter((m) => m.template === 'sabi_medication_reminder')).toHaveLength(0);
  });

  it('records delivery and read receipts once and in order', async () => {
    const who = await patient();
    const phone = await linkWhatsApp(who);
    const { dose } = await soonSchedule(who);
    await runAt(after(dose));
    const { id } = lastReminder(phone);
    const status = (s) => signed({ entry: [{ changes: [{ value: { statuses: [{ id, status: s, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
    await status('read');
    await status('delivered');
    await status('failed');
    expect(await prisma.notificationDelivery.findFirst({ where: { providerMessageId: id } })).toMatchObject({ status: 'READ' });
    expect((await prisma.medicationDose.findUnique({ where: { id: dose.id } })).status).toBe('NOT_CONFIRMED'); // read is not taken
  });
});

describe('schedules', () => {
  let doctorProfileId; let doctorAuth;
  beforeAll(async () => {
    const tag = randomUUID().slice(0, 8);
    const doctor = await prisma.user.create({ data: { patientId: `SABI-ND-${tag}`, email: `doctor-${tag}@notify.test`, password: 'x', full_name: `Dr ${tag}`, accountStatus: 'ACTIVE', roles: { create: { role: 'PROFESSIONAL' } } } });
    doctorProfileId = (await prisma.professionalProfile.create({ data: { userId: doctor.id, professionType: 'DOCTOR', registrationNumber: `REG-${tag}`, verificationStatus: 'VERIFIED' } })).id;
    doctorAuth = tokenFor(doctor.id);
  });
  const prescribe = (who, items) => prisma.prescription.create({
    data: { reference: `RX-${randomUUID()}`, patientId: who.id, doctorProfileId, status: 'ISSUED', issuedAt: new Date(), items: { create: items.map((item) => ({ route: 'ORAL', quantity: 10, indication: 'Synthetic', duration: '7 days', dosage: '500 mg', ...item })) } },
    include: { items: true },
  });

  it('suggests times from the prescription; "as needed" medicines get no schedule', async () => {
    const who = await patient();
    await prescribe(who, [{ medicationName: 'Synthetic Amoxicillin', frequency: 'TWICE_DAILY' }, { medicationName: 'Synthetic Paracetamol', frequency: 'AS_NEEDED' }]);
    const suggestions = (await as(who).get('/api/v1/medication-schedules/suggestions')).body.data;
    const amox = suggestions.find((s) => s.medicationName === 'Synthetic Amoxicillin');
    expect(amox).toMatchObject({ suggestedTimes: ['08:00', '20:00'], asNeeded: false });
    expect(amox.suggestedEndDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const para = suggestions.find((s) => s.medicationName === 'Synthetic Paracetamol');
    expect(para).toMatchObject({ suggestedTimes: [], asNeeded: true });

    const scheduled = await as(who).post('/api/v1/medication-schedules', { prescriptionItemId: amox.prescriptionItemId, times: ['08:00', '20:00'] });
    expect(scheduled.body.data).toMatchObject({ source: 'PRESCRIPTION', name: 'Synthetic Amoxicillin', dosage: '500 mg', times: ['08:00', '20:00'] });
    const asNeeded = await as(who).post('/api/v1/medication-schedules', { prescriptionItemId: para.prescriptionItemId, times: ['09:00'] });
    expect(asNeeded.body.data).toMatchObject({ asNeeded: true, times: [], remindersEnabled: false });
    expect(await prisma.medicationDose.count({ where: { scheduleId: asNeeded.body.data.id } })).toBe(0);
    expect(await prisma.medicationDose.count({ where: { scheduleId: scheduled.body.data.id } })).toBeGreaterThanOrEqual(3); // 48 hours ahead
    expect((await as(who).post('/api/v1/medication-schedules', { prescriptionItemId: amox.prescriptionItemId, times: ['09:00'] })).body.code).toBe('ALREADY_SCHEDULED');
    expect((await as(who).get('/api/v1/medication-schedules/suggestions')).body.data).toHaveLength(0);
  });

  it('a changed schedule cancels the old future doses and reminders', async () => {
    const who = await patient();
    const { schedule, dose } = await soonSchedule(who);
    const changed = await as(who).patch(`/api/v1/medication-schedules/${schedule.id}`, { times: ['23:59'] });
    expect(changed.body.data.version).toBe(2);
    expect(await prisma.medicationDose.findUnique({ where: { id: dose.id }, include: { reminder: true } })).toMatchObject({ status: 'CANCELLED', reminder: { status: 'CANCELLED' } });
    await runAt(after(dose));
    expect(await prisma.notification.count({ where: { userId: who.id, eventType: 'medication.dose_due' } })).toBe(0);

    // Changing back to the original time brings that dose back for the new version.
    await as(who).patch(`/api/v1/medication-schedules/${schedule.id}`, { times: schedule.times });
    expect(await prisma.medicationDose.findUnique({ where: { id: dose.id }, include: { reminder: true } })).toMatchObject({ status: 'NOT_CONFIRMED', scheduleVersion: 3, reminder: { status: 'SCHEDULED' } });
  });

  it('cancelling the prescription stops its reminders', async () => {
    const who = await patient();
    const at = new Date(Date.now() + 5 * MINUTE);
    const rx = await prescribe(who, [{ medicationName: 'Synthetic Metformin', frequency: 'ONCE_DAILY' }]);
    const created = await as(who).post('/api/v1/medication-schedules', { prescriptionItemId: rx.items[0].id, times: [localClock(at, 'Africa/Lagos')] });
    expect(created.status).toBe(200);
    expect((await request(app).delete(`/api/v1/prescriptions/${rx.id}`).set('Authorization', doctorAuth).send({})).status).toBe(200);
    expect((await prisma.medicationSchedule.findUnique({ where: { id: created.body.data.id } })).status).toBe('STOPPED');
    expect(await prisma.reminderJob.count({ where: { userId: who.id, status: 'SCHEDULED' } })).toBe(0);
  });

  it('stopping a medicine keeps its history and is recorded in the Activity log', async () => {
    const who = await patient();
    const { schedule } = await soonSchedule(who);
    expect((await as(who).post(`/api/v1/medication-schedules/${schedule.id}/stop`)).body.data.status).toBe('STOPPED');
    expect((await as(who).get('/api/v1/medication-schedules')).body.data[0]).toMatchObject({ id: schedule.id, status: 'STOPPED' });
    const [audit] = (await as(who).get('/api/v1/audit/mine?category=ACTIVITY')).body.data.items;
    expect(audit.text).toBe('You stopped Synthetic Amlodipine');
    expect((await as(who).patch(`/api/v1/medication-schedules/${schedule.id}`, { times: ['10:00'] })).body.code).toBe('NOT_LIVE');
  });
});

describe('the webhook', () => {
  it('refuses unsigned or wrongly signed requests', async () => {
    const body = JSON.stringify({ entry: [] });
    expect((await request(app).post('/api/v1/whatsapp/webhook').set('Content-Type', 'application/json').send(body)).status).toBe(401);
    expect((await request(app).post('/api/v1/whatsapp/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', `sha256=${'0'.repeat(64)}`).send(body)).status).toBe(401);
    expect((await signed({ entry: [] })).status).toBe(200);
  });

  it('answers the subscription handshake only with the verify token', async () => {
    expect((await request(app).get('/api/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42')).status).toBe(403);
    const ok = await request(app).get('/api/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=synthetic-verify-token&hub.challenge=42');
    expect(ok.text).toBe('42');
  });

  it('applies a repeated message only once', async () => {
    const who = await patient();
    const phone = await linkWhatsApp(who);
    const { dose } = await soonSchedule(who);
    await runAt(after(dose));
    const id = `wamid.IN${randomUUID()}`;
    await tap(phone, lastReminder(phone).buttons[1].payload, id);
    await tap(phone, lastReminder(phone).buttons[1].payload, id);
    expect((await prisma.reminderJob.findUnique({ where: { doseId: dose.id } })).snoozeCount).toBe(1);
    expect(simulator.messages(phone).filter((m) => m.type === 'text')).toHaveLength(1);
  });
});
