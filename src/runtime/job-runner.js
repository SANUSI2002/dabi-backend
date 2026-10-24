import { randomUUID } from 'node:crypto';
import { validJobKind } from './job-kinds.js';

export async function runDurableJob(kind, { db, registry }) {
  if (!validJobKind(kind) || !registry[kind]) throw new Error('UNKNOWN_BACKGROUND_JOB');
  const lease = randomUUID();
  // Database time and CAS, not process memory: works after cold starts/retries.
  const claimed = await db.$queryRaw`
    INSERT INTO runtime_job_checkpoints (id,lease_token,lease_expires_at)
    VALUES (${kind},${lease}::uuid,CURRENT_TIMESTAMP + INTERVAL '10 minutes')
    ON CONFLICT (id) DO UPDATE SET lease_token=EXCLUDED.lease_token,
      lease_expires_at=EXCLUDED.lease_expires_at,updated_at=CURRENT_TIMESTAMP
    WHERE runtime_job_checkpoints.next_due_at <= CURRENT_TIMESTAMP AND
      (runtime_job_checkpoints.lease_expires_at IS NULL OR runtime_job_checkpoints.lease_expires_at < CURRENT_TIMESTAMP)
    RETURNING cursor`;
  if (!claimed.length) {
    const [state] = await db.$queryRaw`SELECT lease_expires_at > CURRENT_TIMESTAMP AS busy FROM runtime_job_checkpoints WHERE id=${kind}`;
    return { state: state?.busy ? 'busy' : 'deferred' };
  }
  try {
    const result = await registry[kind].run(claimed[0].cursor) || {};
    const cursor = result.cursor ?? null;
    if (cursor !== null && (typeof cursor !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(cursor))) throw new Error('INVALID_JOB_CURSOR');
    const delay = result.nextDelayMs ?? registry[kind].intervalMs;
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 86_400_000) throw new Error('INVALID_JOB_INTERVAL');
    const changed = await db.$executeRaw`UPDATE runtime_job_checkpoints SET cursor=${cursor},
      next_due_at=CURRENT_TIMESTAMP + (${delay} * INTERVAL '1 millisecond'),
      lease_token=NULL,lease_expires_at=NULL,last_completed_at=CURRENT_TIMESTAMP,
      failures=0,updated_at=CURRENT_TIMESTAMP WHERE id=${kind} AND lease_token=${lease}::uuid`;
    if (changed !== 1) throw new Error('BACKGROUND_LEASE_LOST');
    return { state: 'completed', continue: result.continue === true };
  } catch {
    await db.$executeRaw`UPDATE runtime_job_checkpoints SET lease_token=NULL,lease_expires_at=NULL,
      next_due_at=CURRENT_TIMESTAMP + INTERVAL '10 seconds',failures=LEAST(failures+1,1000000),
      updated_at=CURRENT_TIMESTAMP WHERE id=${kind} AND lease_token=${lease}::uuid`;
    throw new Error('BACKGROUND_JOB_FAILED');
  }
}
