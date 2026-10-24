import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { createDatabasePool } from './databasePool.js';
import 'dotenv/config';

// URL mode remains for development/tests. Google production explicitly selects
// cloud-sql-iam with an attached identity, never an administrator URL.
const { pool, closeConnector } = await createDatabasePool();

// Pass the pool to the adapter
const adapter = new PrismaPg(pool);

// Initialize Prisma 7 with the required adapter
const prisma = new PrismaClient({ adapter });

if (process.env.SKIP_DB_CONNECT !== 'true') {
  prisma.$connect()
    .then(() => console.log('Prisma connected to PostgreSQL successfully!'))
    .catch(() => console.error('Prisma connection unavailable; check the server-side database configuration.'));
}

export async function disconnectDatabase() {
  try { await prisma.$disconnect(); if (!pool.ended) await pool.end(); }
  finally { closeConnector(); }
}

export default prisma;
