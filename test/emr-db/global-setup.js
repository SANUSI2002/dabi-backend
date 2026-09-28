// Real-database EMR tests: an in-memory Postgres (PGlite) behind a local socket, with every
// migration applied exactly as production applies them. No network, no external database.
//
// PGlite is ONE Postgres session: the app must use a single pooled connection (env-setup sets
// DATABASE_POOL_MAX=1), otherwise transactions from different connections would interleave.
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

let db;
let server;

export async function setup({ provide }) {
  db = await PGlite.create();
  server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0, maxConnections: 4 });
  await server.start();
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?sslmode=disable`;
  // Async on purpose: the database lives in this process and must keep serving meanwhile.
  await promisify(exec)('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url } });
  provide('emrDatabaseUrl', url);
}

export async function teardown() {
  await server?.stop();
  await db?.close();
}
