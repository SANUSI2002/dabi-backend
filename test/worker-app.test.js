import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createWorkerApp } from '../src/runtime/worker-app.js';
import { JOB_KINDS } from '../src/runtime/job-kinds.js';
const config = { workerUrl: 'https://sabi-worker-synthetic.run.app', invoker: 'task@synthetic.iam.gserviceaccount.com', scheduler: 'scheduler@synthetic.iam.gserviceaccount.com' };
function fixture(identity = config.invoker, overrides = {}) {
  const claims = { iss: 'https://accounts.google.com', aud: config.workerUrl, email: identity, email_verified: true, ...overrides };
  const verify = vi.fn(async () => ({ getPayload: () => claims }));
  const runJob = vi.fn(async () => ({ state: 'completed' }));
  const enqueue = vi.fn(async () => ({}));
  const app = createWorkerApp({ config, verify, runJob, enqueue, now: () => 120000 });
  const post = path => request(app).post(path).set('Authorization', 'Bearer synthetic-google-id-token').send({});
  return { app, post, verify, runJob, enqueue };
}
describe('private background worker', () => {
  it('does not accept unsigned task headers as authentication', async () => {
    const f = fixture();
    const response = await request(f.app).post('/internal/jobs/ai-chat').set('X-CloudTasks-TaskName', 'forged').send({});
    expect(response.status).toBe(401); expect(f.runJob).not.toHaveBeenCalled();
  });
  it('verifies the token signature/audience before executing a job', async () => {
    const f = fixture();
    expect((await f.post('/internal/jobs/ai-chat')).status).toBe(200);
    expect(f.verify).toHaveBeenCalledWith({ idToken: 'synthetic-google-id-token', audience: config.workerUrl });
    expect(f.runJob).toHaveBeenCalledWith('ai-chat');
  });
  it.each([{ iss: 'https://attacker.invalid' }, { aud: 'https://wrong.run.app' }, { email_verified: false }, { email: 'other@synthetic.iam.gserviceaccount.com' }])('rejects wrong claims %j', async claims => {
    const f = fixture(config.invoker, claims);
    expect((await f.post('/internal/jobs/ai-chat')).status).toBe(401);
    expect(f.runJob).not.toHaveBeenCalled();
  });
  it('rejects signature verification failures without leaking details', async () => {
    const f = fixture(); f.verify.mockRejectedValue(new Error('synthetic-private-details'));
    const response = await f.post('/internal/jobs/ai-chat');
    expect(response.status).toBe(401); expect(response.text).not.toContain('private-details');
  });
  it('separates Scheduler dispatch from task execution permissions', async () => {
    const task = fixture(); const scheduler = fixture(config.scheduler);
    expect((await task.post('/internal/dispatch')).status).toBe(403);
    expect((await scheduler.post('/internal/jobs/ai-chat')).status).toBe(403);
    expect((await scheduler.post('/internal/dispatch')).status).toBe(200);
    expect(scheduler.enqueue.mock.calls.map(c => c[0])).toEqual(JOB_KINDS);
    expect(scheduler.enqueue.mock.calls.every(c => c[1].id === 'scheduled-2')).toBe(true);
  });
  it('rejects unknown categories and data-bearing task payloads', async () => {
    const f = fixture();
    expect((await f.post('/internal/jobs/unknown')).status).toBe(404);
    expect((await request(f.app).post('/internal/jobs/ai-chat').set('Authorization', 'Bearer synthetic').send({ patientId: 'not-allowed' })).status).toBe(400);
    expect(f.runJob).not.toHaveBeenCalled();
  });
  it('returns retryable status for an active lease or failed job', async () => {
    const f = fixture();
    f.runJob.mockResolvedValueOnce({ state: 'busy' }).mockRejectedValueOnce(new Error('synthetic-sensitive-details'));
    expect((await f.post('/internal/jobs/ai-chat')).status).toBe(409);
    const response = await f.post('/internal/jobs/ai-chat');
    expect(response.status).toBe(503); expect(response.text).not.toContain('sensitive-details');
  });
  it('continues a drained queue and retries a partial scheduler dispatch', async () => {
    const f = fixture(); f.runJob.mockResolvedValue({ state: 'completed', continue: true });
    expect((await f.post('/internal/jobs/ai-chat')).status).toBe(200);
    expect(f.enqueue).toHaveBeenCalledWith('ai-chat');
    const s = fixture(config.scheduler); s.enqueue.mockRejectedValueOnce(new Error('unavailable'));
    expect((await s.post('/internal/dispatch')).status).toBe(503);
  });
});
