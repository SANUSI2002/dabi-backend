import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app.js';
import { prisma, tokenFor } from './fixtures.js';
import { AI_CONSENT_VERSION, AI_DOCUMENT_CONSENT_VERSION } from '../../src/modules/ai/ai.config.js';
import { processAiSourceQueue, purgeRevokedAiSources } from '../../src/modules/ai/ai.sources.js';
import { processAiQueue } from '../../src/modules/ai/ai.service.js';

const env = { SABI_AI_ENABLED: 'true', SABI_AI_GOOGLE_PROCESSING_APPROVED: 'true', SABI_AI_DOCUMENT_PROCESSING_APPROVED: 'true', SABI_AI_GOOGLE_API_KEY: 'synthetic', SABI_AI_MODEL: 'synthetic-model', SABI_AI_USER_DAILY_RUNS: '1000', SABI_AI_GLOBAL_DAILY_RUNS: '10000', SABI_AI_GLOBAL_TOTAL_RUNS: '100000' };
const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
beforeAll(async () => { Object.assign(process.env, env); const row = await prisma.aiAllowancePolicy.findUnique({ where: { id: 'global' } }); await prisma.aiAllowancePolicy.update({ where: { id: 'global' }, data: { settings: { ...row.settings, personalDailyRequests: 1000, globalDailyRequests: 10000, globalTotalRequests: 100000 } } }); });
afterAll(() => { for (const key of Object.keys(env)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
const createUser = () => prisma.user.create({ data: { patientId: `AI-DOC-${randomUUID()}`, email: `${randomUUID()}@ai.test`, password: 'synthetic', accountStatus: 'ACTIVE', emailVerifiedAt: new Date() } });
const post = (u, path, body) => request(app).post(`/api/v1/ai${path}`).set('Authorization', tokenFor(u.id)).send(body);
const get = (u, path) => request(app).get(`/api/v1/ai${path}`).set('Authorization', tokenFor(u.id));
const remove = (u, id) => request(app).delete(`/api/v1/ai/sources/${id}`).set('Authorization', tokenFor(u.id)).send({ confirm: true });
const file = (u, extra = {}) => prisma.medicalDocument.create({ data: { ownerPatientId: u.id, objectKey: `clean/${randomUUID()}.pdf`, originalFilename: 'Synthetic lab report.pdf', declaredContentType: 'application/pdf', validatedContentType: 'application/pdf', byteSize: 10, kind: 'LAB_RESULT', status: 'CLEAN', scanVerdict: 'CLEAN', sha256: 'a'.repeat(64), uploadBackend: 'supabase', ...extra } });
const source = (u, d, extra = {}) => post(u, '/sources', { documentId: d.id, clientRequestId: randomUUID(), consentGiven: true, consentVersion: AI_DOCUMENT_CONSENT_VERSION, ...extra });
const extracted = { patientLabels: ['Synthetic Person'], pages: [{ pageNumber: 1, text: 'Printed test: synthetic marker. Result 7 fictional-units. Reference range not printed.', uncertain: false, fields: [{ label: 'synthetic marker', value: '7', unit: 'fictional-units', referenceRange: null, date: null, specimen: null, laboratory: null, flag: null }] }], usage: { inputTokens: 20, outputTokens: 30 } };
const work = (extract = async () => extracted) => processAiSourceQueue({ read: async () => ({ bytes: new Uint8Array([1]), contentType: 'application/pdf' }), inspect: async () => ({ pageCount: 1 }), extract });
const review = (u, id, revision = 1, extra = {}) => post(u, `/sources/${id}/review`, { revision, patientMatchConfirmed: true, extractionReviewed: true, pages: [{ pageNumber: 1, text: extracted.pages[0].text }], ...extra });
async function ready() {
  const user = await createUser(); const doc = await file(user); const created = await source(user, doc); expect(created.status, JSON.stringify(created.body)).toBe(202);
  await work(); expect((await review(user, created.body.data.id)).status).toBe(200); return { user, doc, id: created.body.data.id };
}
const session = async (u) => (await post(u, '/sessions', { consentGiven: true, consentVersion: AI_CONSENT_VERSION })).body.data.id;
const ask = (u, s, id, extra = {}) => post(u, `/sessions/${s}/messages`, { clientMessageId: randomUUID(), message: 'Explain the printed synthetic marker.', sourceIds: [id], ...extra });

describe('personal AI document extraction and grounded context', () => {
  it('requires explicit processing consent, screened ownership and no invented document URLs', async () => {
    const user = await createUser(); const foreign = await createUser(); const doc = await file(user);
    expect((await source(user, doc, { consentGiven: false })).status).toBe(422);
    expect((await source(user, doc, { fileUrl: 'https://attacker.invalid/file' })).status).toBe(422);
    expect((await source(foreign, doc)).status).toBe(404);
    const pending = await file(user, { status: 'PENDING_SCAN', scanVerdict: null }); expect((await source(user, pending)).status).toBe(404);
    const tampered = await file(user, { scanVerdict: null }); expect((await source(user, tampered)).status).toBe(404);
    const list = await get(foreign, '/source-documents'); expect(list.body.data.items).toEqual([]);
  });
  it('enforces same-owner document relationships at the database layer', async () => {
    const user = await createUser(); const foreign = await createUser(); const doc = await file(user);
    await expect(prisma.aiDocumentSource.create({ data: { ownerUserId: foreign.id, documentId: doc.id, clientRequestId: randomUUID(), sourceSha256: doc.sha256, model: 'synthetic', promptVersion: 'synthetic', consentVersion: AI_DOCUMENT_CONSENT_VERSION } })).rejects.toMatchObject({ code: 'P2003' });
  });
  it('deduplicates extraction requests and keeps source review separate from malware screening', async () => {
    const user = await createUser(); const doc = await file(user); const key = randomUUID();
    const first = await source(user, doc, { clientRequestId: key });
    expect((await source(user, doc, { clientRequestId: key })).body.data.id).toBe(first.body.data.id);
    expect((await source(user, doc)).body.data.id).toBe(first.body.data.id);
    expect(await prisma.aiDocumentSource.count({ where: { documentId: doc.id } })).toBe(1);
    const extract = vi.fn(async () => { expect(await prisma.user.count({ where: { id: user.id } })).toBe(1); return extracted; }); await work(extract); expect(extract).toHaveBeenCalledOnce();
    const detail = await get(user, `/sources/${first.body.data.id}`);
    expect(detail.body.data).toMatchObject({ state: 'NEEDS_REVIEW', patientLabels: ['Synthetic Person'] });
    expect(detail.body.data.pages[0]).toMatchObject({ originalText: extracted.pages[0].text, text: extracted.pages[0].text });
    const s = await session(user); expect((await ask(user, s, first.body.data.id)).status).toBe(409);
    expect((await review(user, first.body.data.id, 1, { patientMatchConfirmed: false })).status).toBe(422);
    expect((await review(user, first.body.data.id)).body.data.clinicalVerification).toBe(false);
    expect((await review(user, first.body.data.id)).status).toBe(409);
    expect((await prisma.medicalDocument.findUnique({ where: { id: doc.id } })).status).toBe('CLEAN');
  });
  it('isolates review, derivatives and preview between accounts', async () => {
    const { user, id } = await ready(); const foreign = await createUser();
    expect((await get(foreign, '/sources')).body.data.items).toEqual([]);
    expect((await get(foreign, `/sources/${id}`)).status).toBe(404);
    expect((await review(foreign, id, 2)).status).toBe(404);
    expect((await post(foreign, `/sources/${id}/preview`, { pageNumber: 1 })).status).toBe(404);
    expect((await remove(foreign, id)).status).toBe(404);
    expect((await get(user, `/sources/${id}`)).status).toBe(200);
  });
  it('uses only explicitly selected passages with page provenance and no original file bytes in chat context', async () => {
    const { user, id } = await ready(); const s = await session(user); const queued = await ask(user, s, id);
    expect(queued.status).toBe(202);
    await processAiQueue({ generate: async (_messages, options) => {
      expect(options.sources).toHaveLength(1); expect(options.sources[0]).toMatchObject({ sourceId: id, pageNumber: 1, label: 'S1', text: extracted.pages[0].text });
      return { text: 'The document prints a synthetic marker result; no reference range is printed [S1].', usage: {} };
    } });
    const result = await get(user, `/runs/${queued.body.data.id}`); expect(result.body.data.status).toBe('SUCCEEDED');
    expect(result.body.data.citations[0]).toMatchObject({ sourceId: id, pageNumber: 1, label: 'S1' });
    expect(result.body.data.citations[0].text).toBeUndefined();
  });
  it('rejects nonexistent model citations instead of displaying an invented source', async () => {
    const { user, id } = await ready(); const s = await session(user); const queued = await ask(user, s, id);
    await processAiQueue({ generate: async () => ({ text: 'Unsupported [S99]', usage: {} }) });
    expect((await get(user, `/runs/${queued.body.data.id}`)).body.data).toMatchObject({ status: 'FAILED', errorCode: 'AI_RESPONSE_INVALID' });
  });
  it('does not publish an answer when the extraction is removed during generation', async () => {
    const { user, id } = await ready(); const s = await session(user); const queued = await ask(user, s, id);
    await processAiQueue({ generate: async () => { expect((await remove(user, id)).status).toBe(200); return { text: 'Must not publish [S1]', usage: {} }; } });
    expect((await get(user, `/runs/${queued.body.data.id}`)).body.data).toMatchObject({ status: 'FAILED', errorCode: 'AI_CONTEXT_CHANGED' });
    expect(await prisma.aiMessage.count({ where: { runId: queued.body.data.id, role: 'assistant' } })).toBe(0);
  });
  it('revokes old answer reads, retry/cancel responses and exports without deleting the original', async () => {
    const { user, doc, id } = await ready(); const s = await session(user); const messageId = randomUUID(); const queued = await ask(user, s, id, { clientMessageId: messageId }); const runId = queued.body.data.id;
    await processAiQueue({ generate: async () => ({ text: 'PRIVATE_DERIVED_RESULT [S1]', usage: {} }) });
    expect((await remove(user, id)).body.data.originalDeleted).toBe(false);
    expect(await prisma.aiDocumentPage.count({ where: { sourceId: id } })).toBe(0);
    expect((await prisma.medicalDocument.findUnique({ where: { id: doc.id } })).status).toBe('CLEAN');
    for (const response of [await get(user, `/runs/${runId}`), await get(user, `/sessions/${s}`), await get(user, `/sessions/${s}/export`), await ask(user, s, id, { clientMessageId: messageId }), await post(user, `/runs/${runId}/cancel`, {})]) {
      expect(response.status).toBe(200); expect(JSON.stringify(response.body)).not.toContain('PRIVATE_DERIVED_RESULT');
    }
    expect((await get(user, `/sessions/${s}`)).body.data.messages.find((m) => m.role === 'assistant').sourceUnavailable).toBe(true);
  });
  it('purges derivative text after original document deletion and excludes revoked context from subsequent history', async () => {
    const { user, doc, id } = await ready(); const s = await session(user); await ask(user, s, id);
    await processAiQueue({ generate: async () => ({ text: 'DERIVED_SECRET [S1]', usage: {} }) });
    await prisma.medicalDocument.update({ where: { id: doc.id }, data: { status: 'DELETED', deletedAt: new Date() } });
    expect((await get(user, `/sources/${id}`)).status).toBe(404);
    await purgeRevokedAiSources(); expect(await prisma.aiDocumentPage.count({ where: { sourceId: id } })).toBe(0);
    await post(user, `/sessions/${s}/messages`, { clientMessageId: randomUUID(), message: 'A new general question.' });
    await processAiQueue({ generate: async (messages, options) => { expect(JSON.stringify(messages)).not.toContain('DERIVED_SECRET'); expect(options.sources).toEqual([]); return { text: 'General answer.', usage: {} }; } });
  });
  it('fails extraction safely on provider error without fabricating an empty normal report', async () => {
    const user = await createUser(); const doc = await file(user); const created = await source(user, doc);
    await work(async () => { throw new Error('PROVIDER_BODY_SECRET'); });
    const detail = await get(user, `/sources/${created.body.data.id}`);
    expect(detail.body.data).toMatchObject({ state: 'FAILED', errorCode: 'AI_EXTRACTION_FAILED', pages: [] });
    expect(JSON.stringify(detail.body)).not.toContain('PROVIDER_BODY_SECRET');
  });
  it('rechecks processing approval before a queued file is sent', async () => {
    const user = await createUser(); const doc = await file(user); const created = await source(user, doc);
    process.env.SABI_AI_DOCUMENT_PROCESSING_APPROVED = 'false'; const extract = vi.fn();
    try { expect(await work(extract)).toBe(0); expect(extract).not.toHaveBeenCalled(); expect((await source(user, doc)).status).toBe(503); }
    finally { process.env.SABI_AI_DOCUMENT_PROCESSING_APPROVED = 'true'; await remove(user, created.body.data.id); }
  });
});
