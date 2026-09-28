// Test-only Prisma client for the PGlite socket. Same adapter as src/config/db.js, but every
// pool checkout gets a fresh socket connection (maxUses: 1): PGlite's socket bridge can leave a
// connection's replies misaligned after an error mid-pipeline, and a new connection resets that.
// Still one connection at a time (max: 1), because PGlite is a single Postgres session.
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, maxUses: 1 });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

export default prisma;
