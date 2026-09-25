import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const { Pool } = pg;

// Pool size is configurable because hosted Postgres plans cap connections per database.
const poolMax = Number(process.env.DATABASE_POOL_MAX);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number.isInteger(poolMax) && poolMax > 0 ? poolMax : 10,
});

// Pass the pool to the adapter
const adapter = new PrismaPg(pool);

// Initialize Prisma 7 with the required adapter
const prisma = new PrismaClient({ adapter });

if (process.env.SKIP_DB_CONNECT !== 'true') {
  prisma.$connect()
    .then(() => console.log('Prisma connected to PostgreSQL successfully!'))
    .catch((err) => console.error('Prisma connection failed:', err));
}

export default prisma;
