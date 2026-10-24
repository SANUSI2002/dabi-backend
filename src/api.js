import 'dotenv/config';
import { setTimeout, clearTimeout } from 'node:timers';
import { app } from './app.js';
import prisma, { disconnectDatabase } from './config/db.js';
import { privateStorageClient, privateStorageConfigured } from './config/privateStorage.js';
import { checkOrProvisionBuckets } from './config/supabaseBuckets.js';
import { createApiHost } from './runtime/api-host.js';
import { cloudTasksConfig } from './runtime/cloud-tasks.js';

const { host, preflight, drain } = createApiHost({
  app,
  checkDatabase: () => prisma.$queryRaw`SELECT 1`,
  checkStorage: async () => {
    if (process.env.PRIVATE_STORAGE_PROVIDER !== 'gcs' || !privateStorageConfigured()) {
      throw new Error('GOOGLE_PRIVATE_STORAGE_NOT_CONFIGURED');
    }
    const buckets = await checkOrProvisionBuckets(privateStorageClient());
    if (buckets.length !== 5 || buckets.some(bucket => bucket.state !== 'READY')) {
      throw new Error('PRIVATE_STORAGE_NOT_READY');
    }
  },
});

// Fail startup before opening the listener if the attached identity cannot use
// the real database or private buckets. Never run schema migrations on startup.
try {
  if (process.env.DATABASE_CONNECTION_MODE !== 'cloud-sql-iam') throw new Error('GOOGLE_DATABASE_NOT_CONFIGURED');
  cloudTasksConfig();
  await preflight();
}
catch {
  console.error('[api] Production dependency preflight failed.');
  await disconnectDatabase();
  process.exit(1);
}
const server = host.listen(process.env.PORT || 8080, '0.0.0.0', () => {
  console.log('[api] Request-only runtime ready.');
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  drain();
  // Cloud Run grants a bounded SIGTERM grace period. Stop accepting requests,
  // let current requests finish, then close both Prisma and the IAM connector.
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
