#!/usr/bin/env node
// UC-5 scale check (docs/emr-backend.md §6): 10,000 tenants × 100 patients = 1,000,000 rows.
// For one tenant, with row-level security ON (restricted role + tenant setting, exactly like a
// request), the three hot queries must each execute in under 50 ms and use an index (never a
// sequential scan over other tenants' rows):
//   1. first page of the patient list (keyset order)
//   2. a name search
//   3. get by id
//
// Runs entirely in memory (PGlite) — no database URL, nothing leaves this machine. Too slow for
// every CI run; run it on demand:   node scripts/emr-scale-check.mjs
// Smaller run:   EMR_SCALE_TENANTS=1000 EMR_SCALE_PER_TENANT=100 node scripts/emr-scale-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const TENANTS = Number(process.env.EMR_SCALE_TENANTS) || 10_000;
const PER_TENANT = Number(process.env.EMR_SCALE_PER_TENANT) || 100;
const BUDGET_MS = Number(process.env.EMR_SCALE_BUDGET_MS) || 50;
const RUNS = 5;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrations = path.join(root, 'prisma', 'migrations');
const log = (...args) => console.log('[emr-scale]', ...args);
const started = Date.now();

// Reserve memory up front; growing the WebAssembly heap mid-load is slow.
const db = await PGlite.create({ initialMemory: 1536 * 1024 * 1024 });
// PGlite is a single process: parallel plans (big scans, index builds) would wait forever for
// worker processes. The measured queries are single-tenant index lookups, unaffected by this.
await db.exec('SET max_parallel_workers_per_gather = 0; SET max_parallel_maintenance_workers = 0');
for (const dir of fs.readdirSync(migrations).filter((name) => /^\d/.test(name)).sort()) {
  await db.exec(fs.readFileSync(path.join(migrations, dir, 'migration.sql'), 'utf8'));
}
log(`migrations applied (${((Date.now() - started) / 1000).toFixed(1)}s)`);

// ---- seed ----
const seedStart = Date.now();
await db.exec(`
  INSERT INTO users (id, patient_id, password, account_status)
  VALUES ('00000000-0000-4000-8000-000000000001', 'SABI-SCALE-0001', 'x', 'ACTIVE');
  INSERT INTO organisations (id, owner_id, type, name, address, country, state, city, contact_email, contact_phone, status)
  SELECT gen_random_uuid()::text, '00000000-0000-4000-8000-000000000001', 'HOSPITAL', 'Scale Hospital ' || n, '1 Road', 'Nigeria', 'Lagos', 'Ikeja',
         'scale' || n || '@hospital.test', '+234 700 000 0000', 'VERIFIED'
  FROM generate_series(1, ${TENANTS}) AS n;
  INSERT INTO identity_organizations (id, type, organisation_id)
  SELECT gen_random_uuid()::text, 'HOSPITAL', id FROM organisations;
`);
const given = ['Ada', 'Bola', 'Chidi', 'Dayo', 'Emeka', 'Funmi', 'Gozie', 'Halima', 'Ife', 'Jide', 'Kemi', 'Lola', 'Musa', 'Ngozi', 'Obi', 'Segun'];
const family = ['Adeyemi', 'Bello', 'Chukwu', 'Danjuma', 'Eze', 'Fashola', 'Garba', 'Ibrahim', 'Johnson', 'Okafor', 'Olawale', 'Sanusi', 'Usman', 'Yusuf'];
// Bulk load the usual way: drop the secondary indexes, load in batches, recreate them from their
// exact migration definitions (so the query plans below are checked against the real indexes).
const { rows: secondary } = await db.query(`
  SELECT i.indexname, i.indexdef FROM pg_indexes i
  WHERE i.tablename = 'emr_patients' AND i.indexdef NOT LIKE 'CREATE UNIQUE%'`); // unique ones back foreign keys
for (const { indexname } of secondary) await db.exec(`DROP INDEX "${indexname}"`);
const BATCH = 500;
for (let offset = 0; offset < TENANTS; offset += BATCH) {
  await db.exec(`
    INSERT INTO emr_patients (id, organization_id, medical_record_number, given_name, family_name, date_of_birth, sex, created_by_user_id, created_at, updated_at)
    SELECT gen_random_uuid()::text, o.id,
           'MRN-' || lpad(n::text, 6, '0'),
           (ARRAY['${given.join("','")}'])[1 + (abs(hashtext(o.id || n)) % ${given.length})],
           (ARRAY['${family.join("','")}'])[1 + (abs(hashtext(n || o.id)) % ${family.length})],
           DATE '1940-01-01' + (abs(hashtext(o.id || 'd' || n)) % 30000),
           (ARRAY['FEMALE','MALE'])[1 + n % 2]::"EmrPatientSex",
           '00000000-0000-4000-8000-000000000001',
           now() - (n || ' minutes')::interval, now()
    FROM (SELECT id FROM identity_organizations ORDER BY id OFFSET ${offset} LIMIT ${BATCH}) o
    CROSS JOIN generate_series(1, ${PER_TENANT}) AS n;
  `);
  await db.exec('CHECKPOINT'); // recycle WAL, which otherwise piles up in the in-memory filesystem
  if ((offset / BATCH) % 4 === 3) log(`  … ${Math.min(offset + BATCH, TENANTS).toLocaleString()} tenants seeded (${((Date.now() - seedStart) / 1000).toFixed(0)}s)`);
}
for (const { indexdef } of secondary) await db.exec(indexdef);
await db.exec('ANALYZE emr_patients');
log(`recreated ${secondary.length} indexes (${((Date.now() - seedStart) / 1000).toFixed(0)}s)`);
const { rows: [{ total }] } = await db.query('SELECT count(*)::int AS total FROM emr_patients');
log(`seeded ${total.toLocaleString()} patients across ${TENANTS.toLocaleString()} tenants (${((Date.now() - seedStart) / 1000).toFixed(1)}s)`);

// ---- measure, as a request would run ----
const { rows: [tenant] } = await db.query('SELECT id FROM identity_organizations ORDER BY id OFFSET $1 LIMIT 1', [Math.floor(TENANTS / 2)]);
const { rows: [patient] } = await db.query('SELECT id, family_name FROM emr_patients WHERE organization_id = $1 LIMIT 1', [tenant.id]);
const columns = 'id, medical_record_number, given_name, family_name, other_names, date_of_birth, sex, status, version, created_at';
const checks = [
  {
    name: 'first page (keyset)',
    sql: `SELECT ${columns} FROM emr_patients WHERE organization_id = $1 AND status = 'ACTIVE' ORDER BY created_at DESC, id DESC LIMIT 26`,
    params: [tenant.id],
  },
  {
    name: 'name search',
    sql: `SELECT ${columns} FROM emr_patients WHERE organization_id = $1 AND status = 'ACTIVE'
          AND (medical_record_number LIKE $2 OR national_id LIKE $2 OR given_name ILIKE $3 OR family_name ILIKE $3 OR other_names ILIKE $3)
          ORDER BY created_at DESC, id DESC LIMIT 26`,
    params: [tenant.id, `${patient.family_name.slice(0, 4).toUpperCase()}%`, `%${patient.family_name.slice(0, 4)}%`],
  },
  {
    name: 'get by id',
    sql: 'SELECT * FROM emr_patients WHERE organization_id = $1 AND id = $2',
    params: [tenant.id, patient.id],
    // A primary-key probe is a single-row lookup (the tenant is then checked on that row) — as good.
    acceptIndex: (name) => name === 'emr_patients_pkey',
  },
];

const indexNames = (node, found = []) => {
  if (node['Index Name']) found.push(node['Index Name']);
  for (const child of node.Plans ?? []) indexNames(child, found);
  return found;
};

let failed = false;
for (const check of checks) {
  const times = [];
  let plan;
  let rowCount = 0;
  for (let run = 0; run < RUNS; run += 1) {
    await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE sabi_emr_app');
      await tx.query("SELECT set_config('app.organization_id', $1, true)", [tenant.id]);
      const { rows: [row] } = await tx.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${check.sql}`, check.params);
      const [result] = row['QUERY PLAN'];
      times.push(result['Execution Time']);
      plan = result.Plan;
      rowCount = plan['Actual Rows'];
    });
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const indexes = indexNames(plan);
  const tenantIndex = indexes.some((name) => name.startsWith('emr_patients_organization_id') || check.acceptIndex?.(name));
  const ok = median < BUDGET_MS && tenantIndex;
  failed ||= !ok;
  log(`${ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(20)} median ${median.toFixed(2)} ms (budget ${BUDGET_MS})  rows ${rowCount}  index ${indexes.join(', ') || 'NONE (sequential scan)'}`);
}

// Isolation sanity at scale: the restricted role sees exactly this tenant's rows.
const visible = await db.transaction(async (tx) => {
  await tx.exec('SET LOCAL ROLE sabi_emr_app');
  await tx.query("SELECT set_config('app.organization_id', $1, true)", [tenant.id]);
  return (await tx.query('SELECT count(*)::int AS n FROM emr_patients')).rows[0].n;
});
const isolated = visible === PER_TENANT;
failed ||= !isolated;
log(`${isolated ? 'PASS' : 'FAIL'}  isolation            restricted role sees ${visible} of ${total.toLocaleString()} rows (expected ${PER_TENANT})`);

await db.close();
log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
