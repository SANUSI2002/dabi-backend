import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { prisma, tokenFor } from './fixtures.js';
import { createAiSession } from '../../src/modules/ai/ai.service.js';
const env = { SABI_AI_ENABLED: 'true', SABI_AI_GOOGLE_PROCESSING_APPROVED: 'true', SABI_AI_GOOGLE_API_KEY: 'synthetic', SABI_AI_MODEL: 'synthetic-model' };
const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
beforeAll(() => Object.assign(process.env, env)); afterAll(() => { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const post = (u, p, body) => request(app).post(`/api/v1/ai${p}`).set('Authorization', tokenFor(u.id)).send(body);
const get = (u, p) => request(app).get(`/api/v1/ai${p}`).set('Authorization', tokenFor(u.id));
async function fixture() {
  const user = await prisma.user.create({ data: { patientId: `AI-ACT-${randomUUID()}`, email: `${randomUUID()}@ai.test`, password: 'synthetic', accountStatus: 'ACTIVE', emailVerifiedAt: new Date() } });
  const session = await createAiSession(user.id, {});
  const schedule = await prisma.medicationSchedule.create({ data: { userId: user.id, source: 'PATIENT', name: 'Synthetic existing medicine', dosage: 'Original user-entered value', times: ['09:00'], startDate: new Date('2026-01-01'), remindersEnabled: true } });
  return { user, session, schedule };
}
const propose = (f, extra = {}) => post(f.user, `/sessions/${f.session.id}/actions/reminders`, { clientRequestId: randomUUID(), scheduleId: f.schedule.id, expectedVersion: 1, enableReminders: false, ...extra });
describe('confirmed AI account actions use the domain service', () => {
  it('previews without changing any reminder, requires explicit confirmation and returns one immutable receipt', async () => {
    const f = await fixture(); const proposed = await propose(f); expect(proposed.status).toBe(201); const id = proposed.body.data.id;
    expect((await prisma.medicationSchedule.findUnique({ where: { id: f.schedule.id } })).remindersEnabled).toBe(true);
    expect((await post(f.user, `/actions/${id}/confirm`, {})).status).toBe(422);
    const [first, retry] = await Promise.all([post(f.user, `/actions/${id}/confirm`, { confirm: true }), post(f.user, `/actions/${id}/confirm`, { confirm: true })]);
    expect(first.status, JSON.stringify(first.body)).toBe(200); expect(retry.status).toBe(200); expect(first.body.data.id).toBe(retry.body.data.id);
    expect(first.body.data.result).toMatchObject({ action: 'REMINDER_TOGGLE', remindersEnabled: false, scheduleVersion: 2, treatmentChanged: false });
    expect(await prisma.aiActionReceipt.count({ where: { proposalId: id } })).toBe(1);
    expect((await prisma.medicationSchedule.findUnique({ where: { id: f.schedule.id } }))).toMatchObject({ version: 2, status: 'ACTIVE', dosage: 'Original user-entered value', remindersEnabled: false });
    expect(await prisma.auditEvent.count({ where: { actorUserId: f.user.id, action: 'AI_ACTION_APPLIED', resourceId: id } })).toBe(1);
    await expect(prisma.aiActionReceipt.update({ where: { id: first.body.data.id }, data: { result: { forged: true } } })).rejects.toBeTruthy();
    await expect(prisma.aiActionReceipt.delete({ where: { id: first.body.data.id } })).rejects.toBeTruthy();
  });
  it('isolates targets, conversation proposals and confirmation across owners, including direct database references', async () => {
    const f = await fixture(); const foreign = await fixture(); const p = await propose(f); const id = p.body.data.id;
    expect((await get(foreign.user, '/action-targets/reminders')).body.data.items.map((s) => s.id)).not.toContain(f.schedule.id);
    expect((await get(foreign.user, `/sessions/${f.session.id}/actions`)).status).toBe(404);
    expect((await propose(foreign, { scheduleId: f.schedule.id })).status).toBe(404);
    expect((await post(foreign.user, `/actions/${id}/confirm`, { confirm: true })).status).toBe(404);
    expect((await post(foreign.user, `/actions/${id}/cancel`, {})).status).toBe(404);
    await expect(prisma.aiActionProposal.create({ data: { ownerUserId: foreign.user.id, sessionId: f.session.id, scheduleId: f.schedule.id, scheduleVersion: 1, enableReminders: false, clientRequestId: randomUUID(), expiresAt: new Date(Date.now() + 60000) } })).rejects.toMatchObject({ code: 'P2003' });
  });
  it('deduplicates previews but refuses changed intent under the same request key', async () => {
    const f = await fixture(); const key = randomUUID(); const first = await propose(f, { clientRequestId: key });
    expect((await propose(f, { clientRequestId: key })).body.data.id).toBe(first.body.data.id);
    expect((await propose(f, { clientRequestId: key, enableReminders: true })).status).toBe(409);
    expect((await propose(f, { dosage: 'invented dose', patientId: f.user.id })).status).toBe(422);
  });
  it('rejects stale, expired and cancelled confirmations without overwriting newer settings', async () => {
    const f = await fixture(); const p = await propose(f); const id = p.body.data.id;
    await prisma.medicationSchedule.update({ where: { id: f.schedule.id }, data: { version: { increment: 1 } } });
    expect((await post(f.user, `/actions/${id}/confirm`, { confirm: true })).status).toBe(409);
    expect(await prisma.aiActionReceipt.count({ where: { proposalId: id } })).toBe(0);
    const next = await propose(f, { expectedVersion: 2 }); const nextId = next.body.data.id;
    await prisma.aiActionProposal.update({ where: { id: nextId }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await post(f.user, `/actions/${nextId}/confirm`, { confirm: true })).status).toBe(409);
    const last = await propose(f, { expectedVersion: 2 }); const lastId = last.body.data.id;
    expect((await post(f.user, `/actions/${lastId}/cancel`, {})).status).toBe(200);
    expect((await post(f.user, `/actions/${lastId}/confirm`, { confirm: true })).status).toBe(409);
  });
  it('cancels pending proposals when the conversation is erased and preserves completed receipts', async () => {
    const f = await fixture(); const first = await propose(f); await post(f.user, `/actions/${first.body.data.id}/confirm`, { confirm: true });
    const exported = await get(f.user, `/sessions/${f.session.id}/export`);
    expect(exported.body.data.actionReceipts).toHaveLength(1);
    expect(exported.body.data.actionReceipts[0].result).toMatchObject({ action: 'REMINDER_TOGGLE', remindersEnabled: false, treatmentChanged: false });
    const next = await propose(f, { expectedVersion: 2, enableReminders: true }); const id = next.body.data.id;
    expect((await request(app).delete(`/api/v1/ai/sessions/${f.session.id}`).set('Authorization', tokenFor(f.user.id)).send({ confirm: true })).status).toBe(200);
    expect((await prisma.aiActionProposal.findUnique({ where: { id } })).status).toBe('CANCELLED');
    expect((await post(f.user, `/actions/${id}/confirm`, { confirm: true })).status).toBe(404);
    expect(await prisma.aiActionReceipt.count({ where: { proposalId: first.body.data.id } })).toBe(1);
  });
});
