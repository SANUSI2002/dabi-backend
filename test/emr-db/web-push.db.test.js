// Phone and computer notifications on a real database. The push service is replaced by a stub that
// records what would be sent to each device (encryption is the web-push library's job); everything
// else — subscriptions, preferences, re-checks, retries and the Taken button — runs for real.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({ calls: [], failNext: [] }));
vi.mock('web-push', () => ({ default: { sendNotification: vi.fn(async (subscription, payload) => {
  const failure = sent.failNext.shift();
  if (failure) throw Object.assign(new Error('push failed'), { statusCode: failure });
  sent.calls.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
}) } }));

process.env.WEB_PUSH_PUBLIC_KEY = 'BSyntheticPublicKeyForTestsOnly000000000000000000000000000000000000000000000000000000';
process.env.WEB_PUSH_PRIVATE_KEY = 'synthetic-private-key-for-tests';

const { app } = await import('../../src/app.js');
const { prisma, tokenFor } = await import('./fixtures.js');
const { deliverDue } = await import('../../src/modules/notifications/notification.delivery.js');
const { notify } = await import('../../src/modules/notifications/notify.service.js');
const { processDueReminders } = await import('../../src/modules/medication-schedules/schedule.service.js');
const { localClock } = await import('../../src/modules/medication-schedules/schedule.time.js');

const keys = { p256dh: 'B'.padEnd(87, 'x'), auth: 'synthetic-auth-secret' };
async function patient() {
  const tag = randomUUID().slice(0, 8);
  const user = await prisma.user.create({ data: { patientId: `SABI-WP-${tag}`, email: `push-${tag}@push.test`, password: 'x', full_name: `Patient ${tag}`, accountStatus: 'ACTIVE', emailVerifiedAt: new Date(), roles: { create: { role: 'PATIENT' } } } });
  return { id: user.id, auth: tokenFor(user.id) };
}
const as = (who) => ({
  get: (url) => request(app).get(url).set('Authorization', who.auth),
  post: (url, body = {}) => request(app).post(url).set('Authorization', who.auth).set('User-Agent', 'Mozilla/5.0 (Linux; Android 14) Chrome/129.0 Mobile').send(body),
  put: (url, body) => request(app).put(url).set('Authorization', who.auth).send(body),
  delete: (url, body) => request(app).delete(url).set('Authorization', who.auth).send(body),
});
const allowOn = async (who, name = 'phone') => {
  const endpoint = `https://push.example.test/${name}/${randomUUID()}`;
  expect((await as(who).post('/api/v1/notifications/push/subscriptions', { endpoint, keys })).status).toBe(200);
  return endpoint;
};
async function dueDose(who) {
  const at = new Date(Date.now() + 5 * 60_000);
  const created = await as(who).post('/api/v1/medication-schedules', { name: 'Synthetic Metformin', dosage: '500 mg', times: [localClock(at, 'Africa/Lagos')] });
  const dose = await prisma.medicationDose.findFirst({ where: { scheduleId: created.body.data.id }, orderBy: { scheduledFor: 'asc' } });
  await processDueReminders({ now: new Date(dose.scheduledFor.getTime() + 60_000) });
  return dose;
}
const action = (token, which) => request(app).post('/api/v1/notifications/push/action').send({ token, action: which });

beforeEach(() => { sent.calls.length = 0; sent.failNext.length = 0; });

describe('phone notifications', () => {
  it('a medicine reminder reaches every allowed device, private by default, with Taken and Remind me later', async () => {
    const who = await patient();
    expect((await as(who).get('/api/v1/notifications/push/config')).body.data).toMatchObject({ available: true, publicKey: process.env.WEB_PUSH_PUBLIC_KEY, devices: [] });
    const phone = await allowOn(who, 'phone');
    const laptop = await allowOn(who, 'laptop');
    expect((await as(who).get('/api/v1/notifications/push/config')).body.data.devices).toHaveLength(2);

    await dueDose(who);
    await deliverDue();
    expect(sent.calls.map((c) => c.endpoint).sort()).toEqual([laptop, phone].sort());
    const { payload } = sent.calls[0];
    expect(payload).toMatchObject({ title: 'Time for your medicine', url: '/medications', requireInteraction: true, actions: [{ action: 'taken', title: 'Taken' }, { action: 'snooze', title: 'Remind me later' }] });
    expect(payload.body).toMatch(/^Your (morning|afternoon|evening|night) medicine dose \(/);
    expect(payload.body).not.toContain('Metformin');
    expect(await prisma.notificationDelivery.findFirst({ where: { userId: who.id, channel: 'PUSH' } })).toMatchObject({ status: 'SENT' });
  });

  it('the Taken button records the dose, once, without a sign-in; a forged token is refused', async () => {
    const who = await patient();
    await allowOn(who);
    const dose = await dueDose(who);
    await deliverDue();
    const { actionToken } = sent.calls[0].payload;
    const first = await action(actionToken, 'taken');
    expect(first.status).toBe(200);
    expect(first.body.data.message).toMatch(/^Recorded: dose taken at/);
    expect(await prisma.medicationDose.findUnique({ where: { id: dose.id } })).toMatchObject({ status: 'TAKEN', confirmedVia: 'PUSH' });
    expect((await action(actionToken, 'taken')).body.data.message).toBe('Already recorded. You do not need to do anything else.');
    const [body, signature] = actionToken.split('.');
    expect((await action(`${body}.${signature.slice(0, -2)}xx`, 'taken')).status).toBe(401);
    const audit = (await as(who).get('/api/v1/audit/mine?category=ACTIVITY')).body.data.items.map((i) => i.text);
    expect(audit).toEqual(expect.arrayContaining([expect.stringMatching(/^You recorded your .+ dose of Synthetic Metformin as taken from a notification$/)]));
  });

  it('Remind me later snoozes the reminder', async () => {
    const who = await patient();
    await allowOn(who);
    const dose = await dueDose(who);
    await deliverDue();
    const reply = await action(sent.calls[0].payload.actionToken, 'snooze');
    expect(reply.body.data.message).toMatch(/^OK. I'll remind you again at/);
    expect(await prisma.reminderJob.findUnique({ where: { doseId: dose.id } })).toMatchObject({ status: 'SNOOZED', snoozeCount: 1 });
  });

  it('forgets a device the push service says is gone, and retries a temporary outage', async () => {
    const who = await patient();
    const gone = await allowOn(who, 'old-phone');
    await dueDose(who);
    sent.failNext.push(410);
    await deliverDue();
    expect(await prisma.pushSubscription.findUnique({ where: { endpoint: gone } })).toMatchObject({ revokedAt: expect.any(Date) });
    expect(await prisma.notificationDelivery.findFirst({ where: { userId: who.id, channel: 'PUSH' } })).toMatchObject({ status: 'FAILED' });

    const other = await patient();
    await allowOn(other);
    await notify(prisma, { userId: other.id, eventType: 'appointment.confirmed', title: 'Your appointment is confirmed', message: 'Dr Synthetic confirmed your video consultation tomorrow at 10:00 am.', link: '/appointments' });
    sent.failNext.push(503);
    await deliverDue();
    const waiting = await prisma.notificationDelivery.findFirst({ where: { userId: other.id, channel: 'PUSH' } });
    expect(waiting).toMatchObject({ status: 'PENDING', attempts: 1 });
    await deliverDue({ now: new Date(waiting.nextAttemptAt.getTime() + 1000) });
    expect(sent.calls.at(-1).payload).toMatchObject({ title: 'Your appointment is confirmed', body: 'You have an appointment update. Open Sabi to see it.', url: '/appointments' });
  });

  it('follows the patient\'s choices: details, kinds of update, and turning a device off', async () => {
    const who = await patient();
    const phone = await allowOn(who);
    await as(who).put('/api/v1/notifications/settings', { showMedicationDetails: true, pushCategories: ['MEDICATION', 'CARE'] });
    await notify(prisma, { userId: who.id, eventType: 'appointment.confirmed', title: 'Your appointment is confirmed', message: 'x', link: '/appointments' });
    expect(await prisma.notificationDelivery.count({ where: { userId: who.id, channel: 'PUSH' } })).toBe(0);
    await notify(prisma, { userId: who.id, eventType: 'visit_summary.ready', title: 'Your visit summary is ready', message: 'Dr Synthetic shared the summary of your consultation.', link: '/appointments' });
    await deliverDue();
    expect(sent.calls.at(-1).payload.body).toBe('Dr Synthetic shared the summary of your consultation.');

    expect((await as(who).delete('/api/v1/notifications/push/subscriptions', { endpoint: phone })).status).toBe(200);
    await notify(prisma, { userId: who.id, eventType: 'visit_summary.ready', title: 'Again', message: 'y' });
    expect(await prisma.notificationDelivery.count({ where: { userId: who.id, channel: 'PUSH' } })).toBe(1);
  });

  it('sends a test notification to the devices that allowed it', async () => {
    const who = await patient();
    expect((await as(who).post('/api/v1/notifications/push/test')).status).toBe(409);
    await allowOn(who);
    expect((await as(who).post('/api/v1/notifications/push/test')).body.data.sent).toBe(1);
    expect(sent.calls[0].payload.title).toBe('Notifications are on');
  });
});
