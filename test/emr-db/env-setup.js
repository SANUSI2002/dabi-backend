import { inject, vi } from 'vitest';

process.env.DATABASE_URL = inject('emrDatabaseUrl');
process.env.DATABASE_POOL_MAX = '1'; // the embedded server serves one connection at a time
process.env.SKIP_DB_CONNECT = 'true';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'emr-integration-test-secret-not-used-anywhere-else';
process.env.EMR_API_ENABLED = 'true';
process.env.EMR_WEBHOOK_ALLOW_LOCAL = 'true';

// Route the app's Prisma client through the test pool (see db-client.js).
vi.mock('../../src/config/db.js', () => import('./db-client.js'));
