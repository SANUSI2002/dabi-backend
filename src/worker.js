import 'dotenv/config';
import { setTimeout, clearTimeout } from 'node:timers';
import prisma, { disconnectDatabase } from './config/db.js';
import { privateStorageClient } from './config/privateStorage.js';
import { checkOrProvisionBuckets } from './config/supabaseBuckets.js';
import { cloudTasksConfig, enqueueJob } from './runtime/cloud-tasks.js';
import { createWorkerApp } from './runtime/worker-app.js';
import { runDurableJob } from './runtime/job-runner.js';
import { jobRegistry } from './runtime/job-registry.js';
import { JOB_KINDS } from './runtime/job-kinds.js';
import { abortAiRuns } from './modules/ai/ai.service.js';

let config;
try {
  config = cloudTasksConfig();
  if (process.env.DATABASE_CONNECTION_MODE !== 'cloud-sql-iam' || process.env.PRIVATE_STORAGE_PROVIDER !== 'gcs') throw new Error('GOOGLE_RUNTIME_REQUIRED');
  if (JOB_KINDS.some(kind => !jobRegistry[kind]) || Object.keys(jobRegistry).length !== JOB_KINDS.length) throw new Error('INCOMPLETE_JOB_REGISTRY');
  await prisma.$queryRaw`SELECT id FROM runtime_job_checkpoints LIMIT 0`;
  const buckets = await checkOrProvisionBuckets(privateStorageClient());
  if (buckets.length !== 5 || buckets.some(bucket => bucket.state !== 'READY')) throw new Error('PRIVATE_STORAGE_NOT_READY');
} catch {
  console.error('[worker] Production dependency preflight failed.');
  await disconnectDatabase();
  process.exit(1);
}
const app = createWorkerApp({ config, enqueue: enqueueJob,
  runJob: kind => runDurableJob(kind, { db: prisma, registry: jobRegistry }) });
const server = app.listen(process.env.PORT || 8080, '0.0.0.0', () => console.log('[worker] Authenticated request-only worker ready.'));
let draining = false;
function shutdown() {
  if (draining) return;
  draining = true;
  abortAiRuns();
  const deadline = setTimeout(() => process.exit(1), 8_000);
  deadline.unref();
  server.close(async () => {
    try { await disconnectDatabase(); clearTimeout(deadline); process.exit(0); }
    catch { process.exit(1); }
  });
  server.closeIdleConnections();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
