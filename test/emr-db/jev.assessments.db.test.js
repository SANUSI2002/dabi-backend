// Synthetic records and an injected provider only. Never calls TypeSafe or EMDEX.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app.js';
import { withTenant } from '../../src/modules/emr/core/db.js';
import { processJevAssessmentQueue } from '../../src/modules/ai/jev/jev.assessments.js';
import { documentationQuestionSet } from '../../src/modules/ai/jev/jev.registry.js';
import { addMember, createTenant, newPatient, prisma } from './fixtures.js';

const names = ['JEV_ENABLED', 'JEV_PROCESSING_APPROVED', 'JEV_DAILY_ASSESSMENT_LIMIT'];
const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
beforeAll(() => Object.assign(process.env, { JEV_ENABLED: 'true', JEV_PROCESSING_APPROVED: 'true', JEV_DAILY_ASSESSMENT_LIMIT: '30' }));
afterAll(() => { for (const k of names) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const http = (f, method, path, body) => request(app)[method](`/api/v1/emr/organizations/${f.organizationId}${path}`).set('Authorization', f.auth).send(body);
const path = (f) => `/ai/encounters/${f.encounter.id}/notes/${f.note.id}/assessments`;
const queue = (f, overrides = {}) => http(f, 'post', path(f), { clientRequestId: randomUUID(), noteVersion: 1, ...overrides });
const list = (f) => http(f, 'get', path(f));
const context = (f) => ({ organizationId: f.organizationId, userId: f.userId });
const noteRow = (f) => withTenant(context(f), (tx) => tx.emrClinicalNote.findUnique({ where: { id: f.note.id } }));
const edit = (f) => withTenant(context(f), (tx) => tx.emrClinicalNote.update({ where: { id: f.note.id }, data: { body: 'Revised synthetic evidence', version: { increment: 1 } } }));
const policy = (f, data) => prisma.emrJevPolicy.update({ where: { organizationId_workflow: { organizationId: f.organizationId, workflow: documentationQuestionSet.workflow } }, data });
const answer = () => ({ model: 'jev-1.13.0', answers: { medication_history: { type: 'choice', choice: 'unresolved', confidence: 0.9,
  probabilities: { identified: 0.02, unresolved: 0.9, denied: 0.02, not_documented: 0.03, conflicting: 0.03 } } }, usage: { inputTokens: 30, outputTokens: 15 } });
async function fixture(mode = 'REVIEW_ONLY') {
  const tenant = await createTenant(`jev-${randomUUID().slice(0, 6)}`);
  const doctor = await addMember(tenant, ['DOCTOR']);
  const f = { ...tenant, ...doctor };
  const patient = await http(tenant, 'post', '/patients', newPatient());
  expect(patient.status, JSON.stringify(patient.body)).toBe(201);
  f.encounter = (await http(f, 'post', '/encounters', { patientId: patient.body.data.id, reason: 'Synthetic documentation test' })).body.data;
  const note = await http(f, 'post', `/encounters/${f.encounter.id}/notes`, { kind: 'CONSULTATION', subjective: 'Reports taking a medicine but cannot recall its name.' });
  expect(note.status, JSON.stringify(note.body)).toBe(201); f.note = note.body.data;
  await prisma.emrJevPolicy.create({ data: { organizationId: f.organizationId, workflow: documentationQuestionSet.workflow, mode, model: 'jev-1.13.0', questionVersion: documentationQuestionSet.version,
    clinicalOwnerUserId: f.userId, approvalReference: 'SYNTHETIC-EVALUATION-ONLY', processingApprovedAt: new Date() } });
  return f;
}

describe('JEV durable tenant assessment workflow', () => {
  it('deduplicates concurrent requests, persists typed answers and never mutates clinical records', async () => {
    const f = await fixture(); const before = await noteRow(f); const key = randomUUID();
    const results = await Promise.all([queue(f, { clientRequestId: key }), queue(f, { clientRequestId: key })]);
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(results[0].body.data.id).toBe(results[1].body.data.id);
    expect(await prisma.jevAssessmentJob.count({ where: { organizationId: f.organizationId } })).toBe(1);
    const evaluate = vi.fn(async (payload) => {
      expect(payload.state.note.subjective).toContain('cannot recall');
      expect(payload.state.note.plan).toBeNull();
      expect(JSON.stringify(payload.state)).not.toContain(f.organizationId);
      expect(JSON.stringify(payload.state)).not.toContain(f.encounter.id);
      expect(payload.questions).toEqual(documentationQuestionSet.questions);
      return answer();
    });
    expect(await processJevAssessmentQueue({ evaluate })).toBe(true); expect(evaluate).toHaveBeenCalledOnce();
    const result = await list(f); expect(result.status).toBe(200);
    expect(result.body.data.items[0]).toMatchObject({ processingStatus: 'COMPLETED', resolvedModel: 'jev-1.13.0', answers: answer().answers, clinicalActionApplied: false });
    expect(await noteRow(f)).toEqual(before);
    const audit = await withTenant(context(f), (tx) => tx.emrAuditEvent.findMany({ where: { resourceId: results[0].body.data.id } }));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['jev.assessment.requested', 'jev.assessment.completed']));
  });
  it('blocks another tenant, role injection and arbitrary provider/model/prompt fields', async () => {
    const f = await fixture(); const other = await fixture();
    expect((await http(other, 'get', path(f))).status).toBe(404);
    expect((await http(other, 'post', path(f), { clientRequestId: randomUUID(), noteVersion: 1 })).status).toBe(404);
    expect((await queue(f, { model: 'attacker', state: { patientId: other.note.patientId }, roles: ['DOCTOR'] })).status).toBe(400);
    const staff = await addMember(f, ['RECEPTIONIST']);
    expect((await queue({ ...f, ...staff })).status).toBe(403);
    const rows = await withTenant(context(other), (tx) => tx.emrClinicalNote.findMany({ where: { id: f.note.id } })); expect(rows).toEqual([]);
  });
  it('rejects a mismatched encounter even at the foreign-key boundary', async () => {
    const f = await fixture();
    // A historical visit avoids the database's one-open-visit constraint.
    const alternate = await withTenant(context(f), (tx) => tx.emrEncounter.create({ data: { organizationId: f.organizationId, patientId: f.note.patientId, createdByUserId: f.userId, status: 'FINISHED', arrivedAt: new Date(Date.now() - 3000), startedAt: new Date(Date.now() - 2000), endedAt: new Date(Date.now() - 1000) } }));
    await expect(withTenant(context(f), (tx) => tx.emrJevAssessment.create({ data: { organizationId: f.organizationId, noteId: f.note.id, encounterId: alternate.id, requestedByUserId: f.userId, clientRequestId: randomUUID(),
      workflow: documentationQuestionSet.workflow, questionVersion: documentationQuestionSet.version, sourceFingerprint: '0'.repeat(64), noteVersion: 1, policyVersion: 1, mode: 'REVIEW_ONLY', requestedModel: 'jev-1.13.0' } }))).rejects.toBeTruthy();
  });
  it('does not send edited source material under an old request', async () => {
    const f = await fixture(); expect((await queue(f)).status).toBe(202); await edit(f);
    const evaluate = vi.fn(); await processJevAssessmentQueue({ evaluate }); expect(evaluate).not.toHaveBeenCalled();
    expect((await list(f)).body.data.items[0]).toMatchObject({ processingStatus: 'STALE', answers: null });
  });
  it('suppresses results when the note changes while the provider is working', async () => {
    const f = await fixture(); await queue(f);
    await processJevAssessmentQueue({ evaluate: async () => { await edit(f); return answer(); } });
    expect((await list(f)).body.data.items[0]).toMatchObject({ processingStatus: 'STALE', answers: null });
  });
  it('invalidates in-flight work after a policy revision and hides previously completed answers on disable', async () => {
    const f = await fixture(); await queue(f);
    await processJevAssessmentQueue({ evaluate: async () => { await policy(f, { approvalReference: 'SYNTHETIC-REVISION' }); return answer(); } });
    const stale = (await list(f)).body.data.items[0]; expect(stale.answers).toBeNull(); expect(stale.processingStatus).toBe('STALE');
    const next = await queue(f); expect(next.status).toBe(202); await processJevAssessmentQueue({ evaluate: async () => answer() });
    expect((await list(f)).body.data.items.some((a) => a.answers)).toBe(true);
    await policy(f, { mode: 'DISABLED' }); expect((await list(f)).body.data.items.every((a) => a.answers === null)).toBe(true);
  });
  it('rechecks staff access after generation and refuses publication after membership removal', async () => {
    const f = await fixture(); await queue(f);
    await processJevAssessmentQueue({ evaluate: async () => {
      await prisma.organizationMembership.updateMany({ where: { userId: f.userId, organizationId: f.organizationId }, data: { status: 'SUSPENDED' } }); return answer();
    } });
    const stored = await withTenant(context(f), (tx) => tx.emrJevAssessment.findFirst());
    expect(stored.processingStatus).toBe('FAILED'); expect(stored.answers).toBeNull(); expect((await list(f)).status).toBe(403);
  });
  it('records provider failure as unavailable rather than a negative clinical finding', async () => {
    const f = await fixture(); await queue(f);
    await processJevAssessmentQueue({ evaluate: async () => { throw Object.assign(new Error('secret vendor detail'), { code: 'JEV_PROVIDER_BUSY' }); } });
    const result = (await list(f)).body.data.items[0]; expect(result).toMatchObject({ processingStatus: 'FAILED', errorCode: 'JEV_PROVIDER_BUSY', answers: null });
    expect(JSON.stringify(result)).not.toContain('secret vendor');
    expect(await processJevAssessmentQueue({ evaluate: vi.fn() })).toBe(false);
  });
  it('persists shadow assessments without displaying answers or permitting acceptance', async () => {
    const f = await fixture('SHADOW'); const id = (await queue(f)).body.data.id; await processJevAssessmentQueue({ evaluate: async () => answer() });
    expect((await list(f)).body.data.items[0]).toMatchObject({ mode: 'SHADOW', processingStatus: 'COMPLETED', answers: null });
    expect((await http(f, 'post', `/ai/assessments/${id}/reviews`, { clientRequestId: randomUUID(), disposition: 'ACCEPTED', reason: 'Synthetic review' })).status).toBe(409);
  });
  it('appends one immutable review receipt on retry without modifying the note', async () => {
    const f = await fixture(); const before = await noteRow(f); const id = (await queue(f)).body.data.id;
    await processJevAssessmentQueue({ evaluate: async () => answer() });
    const body = { clientRequestId: randomUUID(), disposition: 'DEFERRED', reason: 'Clarify the medicine history with the patient.' };
    const first = await http(f, 'post', `/ai/assessments/${id}/reviews`, body); expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await http(f, 'post', `/ai/assessments/${id}/reviews`, body)).body.data.id).toBe(first.body.data.id);
    expect((await http(f, 'post', `/ai/assessments/${id}/reviews`, { ...body, disposition: 'ACCEPTED' })).status).toBe(422);
    await expect(prisma.emrJevReview.update({ where: { id: first.body.data.id }, data: { reason: 'Tampered' } })).rejects.toBeTruthy();
    await expect(prisma.emrJevReview.delete({ where: { id: first.body.data.id } })).rejects.toBeTruthy();
    expect(await noteRow(f)).toEqual(before);
  });
  it('keeps manual note updates available while assessment is unavailable', async () => {
    const f = await fixture(); await policy(f, { mode: 'DISABLED' });
    expect((await queue(f)).status).toBe(503);
    await edit(f); expect((await noteRow(f)).version).toBe(2);
    await policy(f, { mode: 'REVIEW_ONLY' }); expect((await queue(f)).status).toBe(412);
    await withTenant(context(f), (tx) => tx.emrClinicalNote.update({ where: { id: f.note.id }, data: { status: 'SIGNED', signedByUserId: f.userId, signedAt: new Date() } }));
    expect((await queue(f, { noteVersion: 2 })).status).toBe(409);
  });
  it('terminates an interrupted claim even if it never reached the provider, without retrying', async () => {
    const f = await fixture(); const id = (await queue(f)).body.data.id;
    await prisma.jevAssessmentJob.updateMany({ where: { assessmentId: id }, data: { status: 'RUNNING', startedAt: new Date(Date.now() - 180000) } });
    const evaluate = vi.fn(); expect(await processJevAssessmentQueue({ evaluate })).toBe(false); expect(evaluate).not.toHaveBeenCalled();
    expect((await list(f)).body.data.items[0]).toMatchObject({ processingStatus: 'FAILED', errorCode: 'JEV_INTERRUPTED', answers: null });
  });
  it('enforces a persisted per-tenant allowance and never confuses it with a billing cap', async () => {
    const f = await fixture(); process.env.JEV_DAILY_ASSESSMENT_LIMIT = '1';
    try {
      const id = (await queue(f)).body.data.id;
      expect((await queue(f)).body.data.id).toBe(id); // Deduplication does not consume another allowance.
      await edit(f); expect((await queue(f, { noteVersion: 2 })).status).toBe(429);
      // Finish the original job so it cannot affect another test's worker.
      await processJevAssessmentQueue({ evaluate: vi.fn() });
    } finally { process.env.JEV_DAILY_ASSESSMENT_LIMIT = '30'; }
  });
});
