import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const { Pool } = pg;

// Initialize the pg Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10, // Keeps connections in check
});

// Pass the pool to the adapter
const adapter = new PrismaPg(pool);

// Initialize Prisma 7 with the required adapter
const prisma = new PrismaClient({ adapter });

if (process.env.SKIP_DB_CONNECT !== 'true') {
  prisma.$connect()
    .then(() => console.log('Prisma connected to Neon successfully!'))
    .catch((err) => console.error('Prisma connection failed:', err));
}

export default prisma;
