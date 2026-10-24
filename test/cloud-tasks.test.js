import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { cloudTasksConfig, enqueueJob } from '../src/runtime/cloud-tasks.js';
const env = { BACKGROUND_EXECUTION_MODE: 'cloud-tasks', GOOGLE_CLOUD_PROJECT: 'synthetic-project',
  CLOUD_TASKS_LOCATION: 'us-east1', CLOUD_TASKS_QUEUE: 'sabi-production-jobs', WORKER_URL: 'https://sabi-synthetic.run.app',
  TASK_INVOKER_SERVICE_ACCOUNT: 'sabi-task-invoker-production@synthetic-project.iam.gserviceaccount.com',
  SCHEDULER_SERVICE_ACCOUNT: 'sabi-scheduler-production@synthetic-project.iam.gserviceaccount.com' };
describe('keyless Cloud Tasks dispatch', () => {
  it.each([{ WORKER_URL: 'http://sabi-synthetic.run.app' }, { WORKER_URL: 'https://attacker.invalid' },
    { WORKER_URL: 'https://sabi-synthetic.run.app/path' }, { TASK_INVOKER_SERVICE_ACCOUNT: 'different@synthetic-project.iam.gserviceaccount.com' },
    { SCHEDULER_SERVICE_ACCOUNT: '' }, { BACKGROUND_EXECUTION_MODE: 'combined' }, { CLOUD_TASKS_LOCATION: 'invalid' }, { GOOGLE_CLOUD_PROJECT: '../escape' }])('fails closed on invalid configuration %j', changes => {
    expect(() => cloudTasksConfig({ ...env, ...changes })).toThrow('CLOUD_TASKS_CONFIGURATION_INVALID');
  });
  it('uses a static empty payload, exact queue, verified worker audience and bounded deadline', async () => {
    const request = vi.fn(async () => ({}));
    await enqueueJob('ai-chat', { env, request, id: 'synthetic-run', now: () => 1000 });
    const options = request.mock.calls[0][0];
    expect(options.url).toBe('https://cloudtasks.googleapis.com/v2/projects/synthetic-project/locations/us-east1/queues/sabi-production-jobs/tasks');
    expect(Buffer.from(options.data.task.httpRequest.body, 'base64').toString()).toBe('{}');
    expect(options.data.task.httpRequest.oidcToken).toEqual({ serviceAccountEmail: env.TASK_INVOKER_SERVICE_ACCOUNT, audience: env.WORKER_URL });
    expect(options.data.task.dispatchDeadline).toBe('300s');
    expect(options.data.task.name).not.toContain('synthetic-run');
    expect(options.timeout).toBe(5000);
  });
  it('deduplicates retries and sanitises provider errors', async () => {
    const duplicate = vi.fn(async () => { throw { response: { status: 409 } }; });
    await expect(enqueueJob('ai-chat', { env, request: duplicate })).resolves.toEqual({ queued: true });
    const failure = vi.fn(async () => { throw new Error('sensitive-provider-body'); });
    await expect(enqueueJob('ai-chat', { env, request: failure })).rejects.toThrow('BACKGROUND_ENQUEUE_UNAVAILABLE');
    await expect(enqueueJob('unknown', { env, request: failure })).rejects.toThrow('UNKNOWN_BACKGROUND_JOB');
  });
});
