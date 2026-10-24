import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from './db-client.js';
import { runDurableJob } from '../../src/runtime/job-runner.js';
beforeEach(async () => { await prisma.$executeRaw`DELETE FROM runtime_job_checkpoints`; });
const fixture = run => ({ db: prisma, registry: { 'ai-chat': { run, intervalMs: 0 } } });

describe('durable worker coordination in PostgreSQL', () => {
  it('persists a cursor and cadence across worker restarts', async () => {
    const first = fixture(vi.fn(async () => ({ cursor: 'pharmacy-cursor-100', nextDelayMs: 3600000 })));
    expect(await runDurableJob('ai-chat', first)).toEqual({ state: 'completed', continue: false });
    const restarted = fixture(vi.fn());
    expect(await runDurableJob('ai-chat', restarted)).toEqual({ state: 'deferred' });
    expect(restarted.registry['ai-chat'].run).not.toHaveBeenCalled();
    await prisma.$executeRaw`UPDATE runtime_job_checkpoints SET next_due_at=CURRENT_TIMESTAMP - INTERVAL '1 second'`;
    restarted.registry['ai-chat'].run.mockResolvedValue({});
    await runDurableJob('ai-chat', restarted);
    expect(restarted.registry['ai-chat'].run).toHaveBeenCalledWith('pharmacy-cursor-100');
  });
  it('prevents overlapping execution without holding a transaction across provider work', async () => {
    let release; let started;
    const running = new Promise(resolve => { started = resolve; });
    const blocker = new Promise(resolve => { release = resolve; });
    const f = fixture(vi.fn(async () => { started(); await blocker; return {}; }));
    const first = runDurableJob('ai-chat', f);
    await running;
    expect(await runDurableJob('ai-chat', f)).toEqual({ state: 'busy' });
    release();
    expect((await first).state).toBe('completed');
    expect(f.registry['ai-chat'].run).toHaveBeenCalledOnce();
  });
  it('reclaims an expired lease after a crashed process', async () => {
    await prisma.$executeRaw`INSERT INTO runtime_job_checkpoints(id,lease_token,lease_expires_at)
      VALUES ('ai-chat','11111111-1111-4111-8111-111111111111'::uuid,CURRENT_TIMESTAMP - INTERVAL '1 second')`;
    const f = fixture(vi.fn(async () => ({ continue: true })));
    expect(await runDurableJob('ai-chat', f)).toEqual({ state: 'completed', continue: true });
    const [row] = await prisma.$queryRaw`SELECT lease_token,failures FROM runtime_job_checkpoints WHERE id='ai-chat'`;
    expect(row).toEqual({ lease_token: null, failures: 0 });
  });
  it('records a retry delay without persisting provider errors or losing a cursor', async () => {
    await prisma.$executeRaw`INSERT INTO runtime_job_checkpoints(id,cursor) VALUES ('ai-chat','cursor-1')`;
    await expect(runDurableJob('ai-chat', fixture(async () => { throw new Error('synthetic-private-provider-content'); }))).rejects.toThrow('BACKGROUND_JOB_FAILED');
    const [row] = await prisma.$queryRaw`SELECT cursor,failures,lease_token,next_due_at>CURRENT_TIMESTAMP AS delayed FROM runtime_job_checkpoints WHERE id='ai-chat'`;
    expect(row).toEqual({ cursor: 'cursor-1', failures: 1, lease_token: null, delayed: true });
  });
  it('does not let a stale worker overwrite a replacement lease', async () => {
    await expect(runDurableJob('ai-chat', fixture(async () => {
      await prisma.$executeRaw`UPDATE runtime_job_checkpoints SET lease_token='22222222-2222-4222-8222-222222222222'::uuid WHERE id='ai-chat'`;
      return {};
    }))).rejects.toThrow('BACKGROUND_JOB_FAILED');
    const [row] = await prisma.$queryRaw`SELECT lease_token::text FROM runtime_job_checkpoints WHERE id='ai-chat'`;
    expect(row.lease_token).toBe('22222222-2222-4222-8222-222222222222');
  });
  it('rejects arbitrary job names and invalid checkpoint data', async () => {
    await expect(runDurableJob('unknown', fixture(vi.fn()))).rejects.toThrow('UNKNOWN_BACKGROUND_JOB');
    await expect(runDurableJob('ai-chat', fixture(async () => ({ cursor: '../private-file' })))).rejects.toThrow('BACKGROUND_JOB_FAILED');
  });
});
