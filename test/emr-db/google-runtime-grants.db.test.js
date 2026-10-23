import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

const api = 'sabi-api-production@project-2dfff4eb-ff04-40b1-aff.iam';
const worker = 'sabi-worker-production@project-2dfff4eb-ff04-40b1-aff.iam';
const connect = async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
};
let protectionBefore;
const protectionQuery = `SELECT count(*) FILTER (WHERE relrowsecurity)::int AS rls,
  count(*) FILTER (WHERE relforcerowsecurity)::int AS forced FROM pg_class
  WHERE relnamespace='public'::regnamespace AND relkind='r'`;
beforeAll(async () => {
  const client = await connect();
  try {
    protectionBefore = (await client.query(protectionQuery)).rows[0];
    await client.query(`CREATE ROLE "${api}" NOLOGIN; CREATE ROLE "${worker}" NOLOGIN`);
    const sql = await readFile(new URL('../../ops/google-cloud/runtime-grants.sql', import.meta.url), 'utf8');
    await client.query(sql);
    // Repeat application must be safe without changing table ownership or protections.
    await client.query(sql);
  } finally { await client.end(); }
});

describe('non-administrator Google production database roles', () => {
  it('keeps every existing RLS and FORCE RLS protection enabled', async () => {
    const client = await connect();
    try { expect((await client.query(protectionQuery)).rows[0]).toEqual(protectionBefore); }
    finally { await client.end(); }
  });

  it.each([api, worker])('provides application DML but no schema/role administration: %s', async role => {
    const client = await connect();
    try {
      const { rows: [r] } = await client.query(`SELECT
        (SELECT bool_and(has_table_privilege($1,'users',privilege))
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)) AS app,
        has_table_privilege($1,'_prisma_migrations','SELECT') AS migrations,
        has_table_privilege($1,'emr_patients','SELECT') AS clinical,
        has_schema_privilege($1,'public','CREATE') AS ddl,
        pg_has_role($1,'sabi_emr_app','USAGE') AS inherited,
        pg_has_role($1,'sabi_emr_app','MEMBER') AS tenant_role,
        rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls AS elevated
        FROM pg_roles WHERE rolname=$1`, [role]);
      expect(r).toEqual({ app: true, migrations: false, clinical: false, ddl: false,
        inherited: false, tenant_role: true, elevated: false });
    } finally { await client.end(); }
  });

  it.each([api, worker])('does not permit direct clinical SELECT outside withTenant: %s', async role => {
    const client = await connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE "${role}"`);
      await expect(client.query('SELECT * FROM emr_patients LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    } finally { await client.query('ROLLBACK'); await client.end(); }
  });

  it('requires tenant context after explicitly switching to the EMR role', async () => {
    const client = await connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE "${api}"`);
      await client.query('SET LOCAL ROLE sabi_emr_app');
      const result = await client.query('SELECT count(*)::int AS visible FROM emr_patients');
      expect(result.rows[0].visible).toBe(0);
    } finally { await client.query('ROLLBACK'); await client.end(); }
  });

  it('limits AI policies to backend identities and protects immutable history', async () => {
    const client = await connect();
    try {
      const { rows } = await client.query(`SELECT tablename,roles::text[] AS roles FROM pg_policies WHERE policyname='sabi_backend_only'`);
      expect(rows).toHaveLength(18);
      expect(rows.every(r => r.roles.length === 1 && r.roles[0] === 'sabi_application_server')).toBe(true);
      const { rows: [r] } = await client.query(`SELECT
        (SELECT bool_and(has_table_privilege($1,'ai_sessions',privilege))
          FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)) AS ai,
        has_table_privilege($1,'audit_events','INSERT') AS audit_append,
        has_table_privilege($1,'audit_events','UPDATE,DELETE') AS audit_mutate,
        has_table_privilege($1,'ai_allowance_ledger','UPDATE,DELETE') AS ledger_mutate,
        has_table_privilege($1,'ai_action_receipts','UPDATE,DELETE') AS receipts_mutate`, [api]);
      expect(r).toEqual({ ai: true, audit_append: true, audit_mutate: false,
        ledger_mutate: false, receipts_mutate: false });
    } finally { await client.end(); }
  });

  it('grants JEV queue maintenance only to the worker, not the global API role', async () => {
    const client = await connect();
    try {
      const { rows: [r] } = await client.query(`SELECT
        has_table_privilege($1,'jev_assessment_jobs','SELECT') AND
          has_table_privilege($1,'jev_assessment_jobs','UPDATE') AS worker,
        has_table_privilege($2,'jev_assessment_jobs','SELECT,UPDATE') AS api,
        has_table_privilege($1,'jev_assessment_jobs','INSERT,DELETE') AS worker_enqueue_or_delete`, [worker, api]);
      expect(r).toEqual({ worker: true, api: false, worker_enqueue_or_delete: false });
    } finally { await client.end(); }
  });
});
