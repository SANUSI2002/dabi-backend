import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTestBootstrap } from './bootstrap-test-platform-admin.mjs';

const ROLE = 'SABI_PLATFORM_ADMIN';
const CONFIRMATION = 'hold-test-platform-admin';

export function validateTestHold({ databaseUrl, email, confirmation, apply }) {
  const normalizedEmail = validateTestBootstrap({ databaseUrl, email, apply: false });
  if (apply && confirmation !== CONFIRMATION) throw new Error('Explicit test-role hold confirmation is required for --apply.');
  return normalizedEmail;
}

export async function holdTestPlatformAdmin(prisma, email, { apply = false } = {}) {
  return prisma.$transaction(async (tx) => {
    const users = await tx.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
      take: 2,
    });
    if (users.length !== 1) throw new Error('Exactly one Sabi ID must match the requested email.');
    const userId = users[0].id;
    const assignment = await tx.platformRoleAssignment.findUnique({ where: { userId_roleCode: { userId, roleCode: ROLE } } });
    if (!assignment) return { status: 'already-held', roleCode: ROLE };
    if (!apply) return { status: 'dry-run', roleCode: ROLE };
    await tx.platformRoleAssignment.delete({ where: { userId_roleCode: { userId, roleCode: ROLE } } });
    await tx.authSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.refreshToken.deleteMany({ where: { userId } });
    await tx.activityLog.create({ data: {
      userId,
      type: 'TEST_PLATFORM_ADMIN_HELD',
      description: 'Test platform role held pending verified password setup',
      meta: { roleCode: ROLE, database: 'sabi_backend_test_db' },
    } });
    return { status: 'held', roleCode: ROLE };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes('--apply');
  const email = validateTestHold({
    databaseUrl: process.env.DATABASE_URL,
    email: process.env.SABI_TEST_PLATFORM_ADMIN_EMAIL,
    confirmation: process.env.SABI_TEST_PLATFORM_HOLD_CONFIRM,
    apply,
  });
  const [{ default: pg }, { PrismaPg }, { PrismaClient }] = await Promise.all([
    import('pg'), import('@prisma/adapter-pg'), import('@prisma/client'),
  ]);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const result = await holdTestPlatformAdmin(prisma, email, { apply });
    console.log(`${result.status}: ${result.roleCode}. ${apply ? 'No password was changed.' : 'Nothing was changed.'}`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}
