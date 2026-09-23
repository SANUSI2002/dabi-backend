import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROLE = 'SABI_PLATFORM_ADMIN';
const TEST_DATABASE = 'sabi_backend_test_db';
const CONFIRMATION = 'grant-test-platform-admin';

export function validateTestBootstrap({ databaseUrl, email, confirmation, apply }) {
  let database;
  try { database = new URL(databaseUrl); } catch { throw new Error('A valid test DATABASE_URL is required.'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || decodeURIComponent(database.pathname.slice(1)) !== TEST_DATABASE) {
    throw new Error(`Bootstrap is restricted to the ${TEST_DATABASE} database.`);
  }
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error('Set a valid SABI_TEST_PLATFORM_ADMIN_EMAIL.');
  if (apply && confirmation !== CONFIRMATION) throw new Error('Explicit test-bootstrap confirmation is required for --apply.');
  return normalizedEmail;
}

export async function bootstrapFirstTestPlatformAdmin(prisma, email, { apply = false } = {}) {
  return prisma.$transaction(async (tx) => {
    const users = await tx.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, accountStatus: true },
      take: 2,
    });
    if (users.length !== 1 || users[0].accountStatus !== 'ACTIVE') throw new Error('Exactly one active Sabi ID must already exist.');
    const userId = users[0].id;
    const existing = await tx.platformRoleAssignment.findUnique({ where: { userId_roleCode: { userId, roleCode: ROLE } } });
    if (existing) return { status: 'already-assigned', roleCode: ROLE };
    const otherAdmins = await tx.platformRoleAssignment.count({ where: { roleCode: { in: ['SABI_SUPER_ADMIN', ROLE] } } });
    if (otherAdmins !== 0) throw new Error('An administrator already exists; use a separately approved staff-management procedure.');
    const role = await tx.accessRole.findUnique({ where: { code: ROLE }, select: { scope: true } });
    if (role?.scope !== 'PLATFORM') throw new Error('The platform role migration is missing.');
    if (!apply) return { status: 'dry-run', roleCode: ROLE };
    await tx.platformRoleAssignment.create({ data: { userId, roleCode: ROLE } });
    await tx.activityLog.create({ data: {
      userId,
      type: 'TEST_PLATFORM_ADMIN_BOOTSTRAPPED',
      description: 'First test platform administrator assigned by controlled operations script',
      meta: { roleCode: ROLE, database: TEST_DATABASE },
    } });
    return { status: 'assigned', roleCode: ROLE };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes('--apply');
  const email = validateTestBootstrap({
    databaseUrl: process.env.DATABASE_URL,
    email: process.env.SABI_TEST_PLATFORM_ADMIN_EMAIL,
    confirmation: process.env.SABI_TEST_PLATFORM_BOOTSTRAP_CONFIRM,
    apply,
  });
  const [{ default: pg }, { PrismaPg }, { PrismaClient }] = await Promise.all([
    import('pg'), import('@prisma/adapter-pg'), import('@prisma/client'),
  ]);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const result = await bootstrapFirstTestPlatformAdmin(prisma, email, { apply });
    console.log(`${result.status}: ${result.roleCode}. ${apply ? 'No password was created or displayed.' : 'Nothing was changed.'}`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}
