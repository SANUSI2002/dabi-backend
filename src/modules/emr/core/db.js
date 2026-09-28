// Every EMR database access goes through withTenant (or withWorker for the outbox worker).
//
// Inside the transaction we switch to the restricted `sabi_emr_app` role and set
// app.organization_id, so Postgres row-level security filters every read and write to the
// current tenant — even if a repository forgets a filter. Both settings are SET LOCAL
// (transaction-scoped): safe with transaction-mode connection pooling, never leak to the next
// request on the same connection.
//
// Rule: never use the global Prisma client for EMR tables. Always use the `tx` passed in here.
import prisma from '../../../config/db.js';

export const EMR_DB_ROLE = 'sabi_emr_app';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TX_OPTIONS = { maxWait: 5000, timeout: 15000 };

export async function withTenant(context, work, { db = prisma, isolationLevel } = {}) {
  const organizationId = context?.organizationId;
  // Guard before touching the database: an empty/odd tenant id must never reach set_config.
  if (typeof organizationId !== 'string' || !UUID.test(organizationId)) {
    throw Object.assign(new Error('TENANT_CONTEXT_MISSING'), { code: 'TENANT_CONTEXT_MISSING' });
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${EMR_DB_ROLE}`);
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    return work(tx);
  }, { ...TX_OPTIONS, ...(isolationLevel ? { isolationLevel } : {}) });
}

// Cross-tenant system context for the outbox worker only. RLS lets it see outbox, delivery and
// subscription rows — never clinical tables, which have no system-context clause.
export async function withWorker(work, { db = prisma } = {}) {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${EMR_DB_ROLE}`);
    await tx.$executeRaw`SELECT set_config('app.system_context', 'emr-worker', true)`;
    return work(tx);
  }, TX_OPTIONS);
}
