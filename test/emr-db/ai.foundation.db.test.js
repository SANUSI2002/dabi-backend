import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { app } from '../../src/app.js';
import { prisma, tokenFor } from './fixtures.js';
import { AI_CONSENT_VERSION } from '../../src/modules/ai/ai.config.js';
import { processAiQueue } from '../../src/modules/ai/ai.service.js';
import { createAiSession, queueAiMessage } from '../../src/modules/ai/ai.service.js';

const env = { SABI_AI_ENABLED: 'true', SABI_AI_GOOGLE_PROCESSING_APPROVED: 'true', SABI_AI_GOOGLE_API_KEY: 'synthetic-key-never-transmitted', SABI_AI_MODEL: 'synthetic-model', SABI_AI_USER_DAILY_RUNS: '1000', SABI_AI_GLOBAL_DAILY_RUNS: '10000', SABI_AI_GLOBAL_TOTAL_RUNS: '100000' };
const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
let owner, stranger;
const createUser = () => prisma.user.create({ data: { patientId: `AI-${randomUUID()}`, email: `${randomUUID()}@ai.test`, password: 'synthetic', accountStatus: 'ACTIVE', emailVerifiedAt: new Date() } });
const post = (user, path, body) => request(app).post(`/api/v1/ai${path}`).set('Authorization', tokenFor(user.id)).send(body);
const get = (user, path) => request(app).get(`/api/v1/ai${path}`).set('Authorization', tokenFor(user.id));
const session = async () => {
  const result = await post(owner, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION });
  expect(result.status, JSON.stringify(result.body)).toBe(201); return result.body.data.id;
};
const queue = (id, extra = {}) => post(owner, `/sessions/${id}/messages`, { clientMessageId: randomUUID(), message: 'Explain what a medical report is.', ...extra });
const result = { text: 'A medical report records information from a health assessment.', usage: { inputTokens: 20, outputTokens: 15 } };
beforeAll(async () => { Object.assign(process.env, env); owner = await createUser(); stranger = await createUser(); });
afterAll(() => { for (const key of Object.keys(env)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });

describe('Sabi AI asynchronous foundation', () => {
  it('rechecks a real originating session through the publication transaction without retaining its connection', async () => {
    const user = await createUser(); const device = await prisma.authDevice.create({ data: { userId: user.id, label: 'Synthetic device' } });
    const auth = await prisma.authSession.create({ data: { userId: user.id, deviceId: device.id, expiresAt: new Date(Date.now() + 3600000) } });
    const conversation = await createAiSession(user.id, {});
    const queued = await queueAiMessage({ ...user, sessionId: auth.id }, conversation.id, { clientMessageId: randomUUID(), message: 'A synthetic question.' });
    await processAiQueue({ generate: async () => result });
    expect((await prisma.aiRun.findUnique({ where: { id: queued.id } })).status).toBe('SUCCEEDED');
    const revoked = await queueAiMessage({ ...user, sessionId: auth.id }, conversation.id, { clientMessageId: randomUUID(), message: 'Revoke while generating.' });
    await processAiQueue({ generate: async () => { await prisma.authSession.update({ where: { id: auth.id }, data: { revokedAt: new Date() } }); return result; } });
    expect((await prisma.aiRun.findUnique({ where: { id: revoked.id } }))).toMatchObject({ status: 'FAILED', errorCode: 'AI_SESSION_REVOKED' });
    expect(await prisma.aiMessage.count({ where: { runId: revoked.id, role: 'assistant' } })).toBe(0);
  });
  it('enforces composite owner/session references even for direct database writes', async () => {
    const id = await session(); const second = await session(); const queued = await queue(id);
    await expect(prisma.aiPersonalMemory.create({ data: { ownerUserId: stranger.id, sourceSessionId: id, kind: 'PREFERENCE', content: 'cross-owner' } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(prisma.aiMessage.create({ data: { sessionId: second, runId: queued.body.data.id, role: 'assistant', content: 'cross-session' } })).rejects.toMatchObject({ code: 'P2003' });
    await post(owner, `/runs/${queued.body.data.id}/cancel`, {});
  });
  it('keeps AI operations restricted and applies a versioned, audited pause without hiding history', async () => {
    const admin = await createUser(); const patient = await createUser();
    await prisma.platformRoleAssignment.create({ data: { userId: admin.id, roleCode: 'SABI_PLATFORM_ADMIN' } });
    const base = '/api/v1/command-centre/ai';
    const adminGet = (path) => request(app).get(`${base}${path}`).set('Authorization', tokenFor(admin.id));
    const policyPost = (version, generationPaused) => request(app).post(`${base}/policy`).set('Authorization', tokenFor(admin.id)).send({ expectedVersion: version, generationPaused, reason: 'Synthetic operational check' });
    expect((await request(app).get(`${base}/overview`).set('Authorization', tokenFor(patient.id))).status).toBe(403);
    const overview = await adminGet('/overview'); expect(overview.status).toBe(200);
    expect(JSON.stringify(overview.body)).not.toContain(env.SABI_AI_GOOGLE_API_KEY);
    const created = await post(patient, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION }); const id = created.body.data.id;
    const firstVersion = overview.body.data.policy.version;
    expect((await policyPost(firstVersion, true)).status).toBe(200);
    try {
      expect((await get(patient, '/config')).body.data.enabled).toBe(false);
      expect((await get(patient, `/sessions/${id}`)).status).toBe(200);
      expect((await post(patient, `/sessions/${id}/messages`, { clientMessageId: randomUUID(), message: 'Paused' })).status).toBe(503);
      expect((await policyPost(firstVersion, false)).status).toBe(409);
      expect((await adminGet('/runs')).status).toBe(200);
      expect(await prisma.auditEvent.count({ where: { actorUserId: admin.id, resourceType: 'ai-runtime-policy' } })).toBeGreaterThan(0);
    } finally { const policy = await prisma.aiRuntimePolicy.findUnique({ where: { id: 'global' } }); await policyPost(policy.version, false); }
  });
  it('does not publish a response if operations pauses generation while the provider is working', async () => {
    const user = await createUser(); const created = await post(user, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION }); const id = created.body.data.id;
    const queued = await post(user, `/sessions/${id}/messages`, { clientMessageId: randomUUID(), message: 'Explain a report' });
    try {
      await processAiQueue({ generate: async () => { await prisma.aiRuntimePolicy.update({ where: { id: 'global' }, data: { generationPaused: true } }); return result; } });
      expect((await prisma.aiRun.findUnique({ where: { id: queued.body.data.id } }))).toMatchObject({ status: 'FAILED', errorCode: 'AI_GENERATION_PAUSED' });
      expect(await prisma.aiMessage.count({ where: { runId: queued.body.data.id, role: 'assistant' } })).toBe(0);
    } finally { await prisma.aiRuntimePolicy.update({ where: { id: 'global' }, data: { generationPaused: false } }); }
  });
  it('keeps explicit memories private and rejects verified-fact injection or stale corrections', async () => {
    const user = await createUser(); const foreign = await createUser();
    expect((await post(user, '/memory', { kind: 'VERIFIED_CLINICAL', content: 'spoof' })).status).toBe(422);
    const created = await post(user, '/memory', { kind: 'PREFERENCE', content: 'Please use short explanations.' });
    expect(created.status).toBe(201); const id = created.body.data.id;
    expect((await get(user, '/memory')).body.data.items[0].content).toBe('Please use short explanations.');
    expect((await get(foreign, '/memory')).body.data.items).toEqual([]);
    const update = (who, revision) => request(app).patch(`/api/v1/ai/memory/${id}`).set('Authorization', tokenFor(who.id)).send({ kind: 'PREFERENCE', content: 'Use more detail.', revision });
    expect((await update(foreign, 1)).status).toBe(404);
    expect((await update(user, 1)).body.data.revision).toBe(2);
    expect((await update(user, 1)).status).toBe(409);
    expect((await request(app).delete(`/api/v1/ai/memory/${id}`).set('Authorization', tokenFor(foreign.id))).status).toBe(404);
    expect((await request(app).delete(`/api/v1/ai/memory/${id}`).set('Authorization', tokenFor(user.id))).status).toBe(200);
    expect((await get(user, '/memory')).body.data.items).toEqual([]);
    expect((await prisma.aiPersonalMemory.findUnique({ where: { id } })).content).toBe('');
  });
  it('cannot bind a memory to a foreign conversation and purges source-linked derivatives', async () => {
    const user = await createUser(); const foreign = await createUser();
    const created = await post(user, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION }); const id = created.body.data.id;
    expect((await post(foreign, '/memory', { kind: 'USER_REPORTED', content: 'foreign', sourceSessionId: id })).status).toBe(404);
    const memory = await post(user, '/memory', { kind: 'USER_REPORTED', content: 'This is only a self report.', sourceSessionId: id });
    expect(memory.status).toBe(201);
    await request(app).delete(`/api/v1/ai/sessions/${id}`).set('Authorization', tokenFor(user.id)).send({ confirm: true });
    expect((await get(user, '/memory')).body.data.items).toEqual([]);
    expect((await prisma.aiPersonalMemory.findUnique({ where: { id: memory.body.data.id } })).content).toBe('');
  });
  it('discards an in-flight answer if user-saved context is revoked', async () => {
    const user = await createUser(); const memory = await post(user, '/memory', { kind: 'PREFERENCE', content: 'Short explanations.' });
    const created = await post(user, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION }); const id = created.body.data.id;
    const queued = await post(user, `/sessions/${id}/messages`, { clientMessageId: randomUUID(), message: 'Explain a report' });
    await processAiQueue({ generate: async (_messages, options) => {
      expect(options.memories[0].id).toBe(memory.body.data.id);
      await request(app).delete(`/api/v1/ai/memory/${memory.body.data.id}`).set('Authorization', tokenFor(user.id));
      return result;
    } });
    expect((await prisma.aiRun.findUnique({ where: { id: queued.body.data.id } }))).toMatchObject({ status: 'FAILED', errorCode: 'AI_CONTEXT_CHANGED' });
    expect(await prisma.aiMessage.count({ where: { runId: queued.body.data.id, role: 'assistant' } })).toBe(0);
  });
  it('records feedback only on the owner\'s completed answer', async () => {
    const user = await createUser(); const foreign = await createUser();
    const created = await post(user, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION }); const id = created.body.data.id;
    const queued = await post(user, `/sessions/${id}/messages`, { clientMessageId: randomUUID(), message: 'Explain a report' }); const runId = queued.body.data.id;
    expect((await post(user, `/runs/${runId}/feedback`, { feedback: 'HELPFUL' })).status).toBe(409);
    await processAiQueue({ generate: async () => result });
    expect((await post(foreign, `/runs/${runId}/feedback`, { feedback: 'HELPFUL' })).status).toBe(404);
    expect((await post(user, `/runs/${runId}/feedback`, { feedback: 'unsafe arbitrary content' })).status).toBe(422);
    expect((await post(user, `/runs/${runId}/feedback`, { feedback: 'UNSAFE' })).body.data).toEqual({ recorded: true, feedback: 'UNSAFE' });
    expect((await get(user, `/sessions/${id}`)).body.data.runs[0].feedback).toBe('UNSAFE');
  });
  it('supports owner-only rename, export, deletion and immediate consent revocation', async () => {
    const user = await createUser(); const foreign = await createUser();
    const created = await post(user, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION }); const id = created.body.data.id;
    const patch = (who) => request(app).patch(`/api/v1/ai/sessions/${id}`).set('Authorization', tokenFor(who.id)).send({ title: 'Renamed' });
    expect((await patch(foreign)).status).toBe(404);
    expect((await patch(user)).body.data.title).toBe('Renamed');
    const submitted = await post(user, `/sessions/${id}/messages`, { clientMessageId: randomUUID(), message: 'Synthetic question for deletion.' });
    expect(submitted.status).toBe(202);
    expect((await get(user, `/sessions/${id}`)).body.data.runs[0].status).toBe('QUEUED');
    expect((await get(foreign, `/sessions/${id}/export`)).status).toBe(404);
    expect((await get(user, `/sessions/${id}/export`)).body.data.messages[0].content).toBe('Synthetic question for deletion.');
    expect((await get(user, '/usage')).body.data).toMatchObject({ today: 1, total: 1, completed: 0, billingEnabled: false });
    const del = (who, body) => request(app).delete(`/api/v1/ai/sessions/${id}`).set('Authorization', tokenFor(who.id)).send(body);
    expect((await del(user, {})).status).toBe(422);
    expect((await del(foreign, { confirm: true })).status).toBe(404);
    expect((await del(user, { confirm: true })).body.data.deleted).toBe(true);
    expect(await prisma.aiMessage.count({ where: { sessionId: id } })).toBe(0);
    expect((await prisma.aiRun.findUnique({ where: { id: submitted.body.data.id } })).status).toBe('CANCELLED');
    expect((await get(user, `/sessions/${id}`)).status).toBe(404);
    expect((await get(user, '/sessions')).body.data.items).toEqual([]);
    expect((await post(user, `/sessions/${id}/messages`, { clientMessageId: randomUUID(), message: 'Cannot revive' })).status).toBe(404);
  });
  it('enforces persisted daily request quotas without charging idempotent retries twice', async () => {
    const user = await createUser(); const created = await post(user, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION }); const id = created.body.data.id;
    const previous = process.env.SABI_AI_USER_DAILY_RUNS; process.env.SABI_AI_USER_DAILY_RUNS = '1';
    try {
      const payload = { clientMessageId: randomUUID(), message: 'One question' };
      const first = await post(user, `/sessions/${id}/messages`, payload); expect(first.status).toBe(202);
      expect((await post(user, `/sessions/${id}/messages`, payload)).body.data.id).toBe(first.body.data.id);
      await post(user, `/runs/${first.body.data.id}/cancel`, {});
      const blocked = await post(user, `/sessions/${id}/messages`, { ...payload, clientMessageId: randomUUID() });
      expect(blocked.status).toBe(429); expect(blocked.body.error.code).toBe('AI_USER_QUOTA');
      expect(await prisma.aiRun.count({ where: { sessionId: id } })).toBe(1);
    } finally { process.env.SABI_AI_USER_DAILY_RUNS = previous; }
  });
  it('cannot publish or export content after deletion during a provider response', async () => {
    const user = await createUser(); const created = await post(user, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION }); const id = created.body.data.id;
    const queued = await post(user, `/sessions/${id}/messages`, { clientMessageId: randomUUID(), message: 'Delete during generation' });
    await processAiQueue({ generate: async () => {
      expect((await request(app).delete(`/api/v1/ai/sessions/${id}`).set('Authorization', tokenFor(user.id)).send({ confirm: true })).status).toBe(200);
      return result;
    } });
    expect((await prisma.aiRun.findUnique({ where: { id: queued.body.data.id } })).status).toBe('CANCELLED');
    expect(await prisma.aiMessage.count({ where: { sessionId: id } })).toBe(0);
    expect((await get(user, `/sessions/${id}/export`)).status).toBe(404);
  });
  it('requires Sabi authentication and never exposes provider credentials', async () => {
    expect((await request(app).get('/api/v1/ai/config')).status).toBe(401);
    const response = await get(owner, '/config');
    expect(response.body.data).toMatchObject({ enabled: true, personalRecords: false, tools: false, billing: false });
    expect(JSON.stringify(response.body)).not.toContain(env.SABI_AI_GOOGLE_API_KEY);
  });
  it('requires explicit consent and rejects invented patient or tenant context', async () => {
    expect((await post(owner, '/sessions', {})).status).toBe(422);
    expect((await post(owner, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION, patientId: stranger.id })).status).toBe(422);
    expect((await post(owner, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION, mode: 'EMR' })).status).toBe(422);
  });
  it('isolates conversations, job results and cancellation between users', async () => {
    const id = await session(); const queued = await queue(id); const runId = queued.body.data.id;
    expect((await get(stranger, `/sessions/${id}`)).status).toBe(404);
    expect((await get(stranger, `/runs/${runId}`)).status).toBe(404);
    expect((await post(stranger, `/runs/${runId}/cancel`, {})).status).toBe(404);
    expect((await post(stranger, `/sessions/${id}/messages`, { clientMessageId: randomUUID(), message: 'spoof' })).status).toBe(404);
    expect((await get(stranger, '/sessions')).body.data.items).toEqual([]);
    await post(owner, `/runs/${runId}/cancel`, {});
  });
  it('deduplicates retries and rejects changed payloads or concurrent turns', async () => {
    const id = await session(); const clientMessageId = randomUUID();
    const first = await queue(id, { clientMessageId });
    const repeat = await queue(id, { clientMessageId });
    expect(first.status).toBe(202); expect(repeat.body.data.id).toBe(first.body.data.id);
    expect((await queue(id, { clientMessageId, message: 'changed' })).status).toBe(409);
    expect((await queue(id)).status).toBe(409);
    expect(await prisma.aiMessage.count({ where: { sessionId: id } })).toBe(1);
    await post(owner, `/runs/${first.body.data.id}/cancel`, {});
  });
  it('completes a persisted job without holding a DB transaction during generation', async () => {
    const id = await session(); const queued = await queue(id); const runId = queued.body.data.id;
    const generate = vi.fn(async (messages) => {
      // The embedded test DB has just one pooled connection: this would deadlock if the AI call held it.
      expect(await prisma.user.count({ where: { id: owner.id } })).toBe(1);
      expect(messages.at(-1).content).toContain('medical report'); return result;
    });
    await processAiQueue({ generate });
    expect(generate).toHaveBeenCalledOnce();
    expect((await get(owner, `/runs/${runId}`)).body.data).toMatchObject({ status: 'SUCCEEDED', answer: result.text });
    expect((await get(owner, `/sessions/${id}`)).body.data.messages).toHaveLength(2);
    expect(await prisma.auditEvent.count({ where: { actorUserId: owner.id, action: 'AI_RESPONSE_COMPLETED', resourceId: id } })).toBe(1);
  });
  it('does not send queued cancelled jobs to a provider', async () => {
    const id = await session(); const queued = await queue(id); const runId = queued.body.data.id;
    expect((await post(owner, `/runs/${runId}/cancel`, {})).body.data.status).toBe('CANCELLED');
    const generate = vi.fn(); await processAiQueue({ generate }); expect(generate).not.toHaveBeenCalled();
  });
  it('never resurrects a running job after cancellation', async () => {
    const id = await session(); const queued = await queue(id); const runId = queued.body.data.id;
    await processAiQueue({ generate: async () => { await post(owner, `/runs/${runId}/cancel`, {}); return result; } });
    expect((await get(owner, `/runs/${runId}`)).body.data.status).toBe('CANCELLED');
    expect(await prisma.aiMessage.count({ where: { runId, role: 'assistant' } })).toBe(0);
  });
  it('sanitises provider failures without persisting incomplete answers', async () => {
    const id = await session(); const queued = await queue(id); const runId = queued.body.data.id;
    await processAiQueue({ generate: async () => { throw new Error('SECRET_SYNTHETIC_PROVIDER_BODY'); } });
    const response = await get(owner, `/runs/${runId}`);
    expect(response.body.data).toMatchObject({ status: 'FAILED', errorCode: 'AI_RESPONSE_FAILED' });
    expect(JSON.stringify(response.body)).not.toContain('SECRET_SYNTHETIC');
    expect(await prisma.aiMessage.count({ where: { runId, role: 'assistant' } })).toBe(0);
  });
  it('rechecks suspension before exposing a response and before completion', async () => {
    const id = await session(); const queued = await queue(id); const runId = queued.body.data.id;
    await processAiQueue({ generate: async () => { await prisma.user.update({ where: { id: owner.id }, data: { accountStatus: 'SUSPENDED' } }); return result; } });
    expect((await get(owner, `/runs/${runId}`)).status).toBe(403);
    expect((await prisma.aiRun.findUnique({ where: { id: runId } })).status).toBe('FAILED');
    await prisma.user.update({ where: { id: owner.id }, data: { accountStatus: 'ACTIVE' } });
  });
  it('fails closed when processing approval is absent while leaving history available', async () => {
    process.env.SABI_AI_GOOGLE_PROCESSING_APPROVED = 'false';
    expect((await get(owner, '/config')).body.data.enabled).toBe(false);
    expect((await post(owner, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION })).status).toBe(503);
    expect((await get(owner, '/sessions')).status).toBe(200);
    process.env.SABI_AI_GOOGLE_PROCESSING_APPROVED = 'true';
  });
});
