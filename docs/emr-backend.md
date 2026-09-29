# EMR backend — design, tenancy model and use cases

Status: foundation + patients in progress (branch `emr-backend`). This document is written before
the code and kept current as modules land. Section 6 is the use-case catalogue every module is
tested against.

## 1. What already exists

### Shared platform (built for Sabi ID / Command Center / telemedicine)

| Concern | Where | What it gives the EMR |
| --- | --- | --- |
| Auth | `middleware/authMiddleware.js` `protect` | HS256 JWT (issuer `sabi-identity`, audience `sabi-api`), server-side session check (`sid`), `req.user = { id, sessionId, organizationId }`. |
| Tenant claim | `middleware/accessMiddleware.js` `requireOrganization` | Tenant comes **only** from the verified JWT `organizationId` claim; loads the active membership → `req.accessContext = { organization, roles, permissions }`. Doctors/nurses/pharmacists must also have a VERIFIED professional profile. |
| RBAC | `access_roles`, `access_permissions`, `access_role_permissions`, `membership_roles` | Permission codes per role, e.g. `patient.read`, `patient.update`, `patient.register`, `clinical.consultation.create`, `lab.order.create`, `lab.result.create`, `prescription.create`, `invoice.create`, `audit.view`. Checked with `requirePermission(code)`. |
| Tenant | `identity_organizations` | One row per hospital/clinic/pharmacy. **This is the tenant.** `organisation_id` links to the facility record. |
| EMR entitlement | `modules/emr/emr.entitlement.js` | EMR opens only for an approved application with setup completed and a published package whose `moduleKeys` include `emr`. |
| EMR today | `modules/emr/emr.patients.routes.js`, `emr_patients` | Tenant-scoped patient list + register (behind `EMR_PATIENT_REGISTRY_ENABLED`), audited to `activity_logs`. |
| Validation | `middleware/validateMiddleware.js` + zod 4 | Strict schemas for params/query/body. |
| Rate limits | `middleware/rateLimitMiddleware.js` | Per-account/per-IP limits, **in-process memory store**. |
| DB | `config/db.js` | Prisma 7 with the `pg` adapter, one pool per process (`DATABASE_POOL_MAX`). |
| Migrations | `prisma/migrations/*/migration.sql` | Hand-written SQL, applied by `prisma migrate deploy` on Render. Partial/expression indexes and triggers live only in SQL. |
| Tests | `test/*.routes.test.js` | Vitest + supertest with a mocked Prisma client. No real-database tests yet. |

### Telemedicine modules (the pattern to mirror)

Each module is a folder `src/modules/<name>/` with `routes → controller → service → repository`,
plus `validator` (zod), `policy` (authorization/eligibility, throws coded errors) and `audit`.
Services run inside `repository.transaction(tx => …)` and write an audit row in the same
transaction. Routes end with a module error handler that never leaks internals. Responses are
`{ status: 'success', data }`; errors `{ status: 'error', error: { code, message } }` (the newer
identity/EMR style — the EMR uses it everywhere).

### EMR frontend (the consumer)

The Sabi EMR UI (`src/pages/clinical`, `diagnostics`, `mch`, `programs`, `admin`) already models:
patients (demographics, identifiers, next of kin, consent), queue/check-in, appointments,
encounters (complaint → exam → assessment → plan, coded diagnoses, sign/amend, NHMIS indicators),
vitals, lab orders (sample → phases → result → sign-off → acknowledgement), prescriptions
(pharmacist review → dispense), admissions/beds/nursing, referrals, MCH registers, billing.
The backend models follow these shapes so the UI can switch from its local stores to the API
module by module.

## 2. Conventions the EMR backend follows

1. **Folder layout** — `src/modules/emr/` with `core/` (tenant context, DB, audit, idempotency,
   concurrency, errors, rate limit, logging, outbox) and one folder per clinical module
   (`patients/`, `encounters/`, …), each with `routes / controller / service / repository /
   validator / policy`.
2. **Tenant from the JWT only.** The `:organizationId` in the URL must equal the token's tenant;
   it is never trusted on its own. No `X-Tenant` header is accepted.
3. **Every EMR query runs in a tenant transaction** (`withTenant`) — never through the global
   Prisma client. The transaction switches to the restricted `sabi_emr_app` role and sets
   `app.organization_id`, so Postgres row-level security filters every read and write.
4. **Every table carries `organization_id`**, every primary/unique key and foreign key includes
   it (composite FKs), and every index leads with it.
5. **Writes are audited in the same transaction** to the append-only `emr_audit_events`
   (actor, action, resource, request id, changed field names — not values).
6. **Critical creates accept `Idempotency-Key`**; updates require `If-Match` (optimistic
   concurrency on a `version` column).
7. **Side effects go through the outbox** (`emr_outbox_events`), written in the same transaction,
   delivered by a worker — never called inline.
8. **API versioning** — everything under `/api/v1/emr/organizations/:organizationId/…`; breaking
   changes get `/api/v2`, additive fields don't.
9. **Errors** use stable codes (`PATIENT_NOT_FOUND`, `VERSION_CONFLICT`, …), never raw
   database messages; 404 is returned for another tenant's IDs (never 403), so IDs can't be probed.

## 3. Tenancy model

### Decision: shared database, shared schema, `organization_id` on every row, enforced by Postgres row-level security

| Option | 10,000+ tenants | Verdict |
| --- | --- | --- |
| Database per tenant | 10,000 databases, 10,000 connection pools, migrations run 10,000 times; impossible on Supabase/Render cost-wise. | Rejected |
| Schema per tenant | ~40 EMR tables × 10,000 = 400,000 tables: catalog bloat slows planning and `pg_dump`; each migration must loop 10,000 schemas (hours, partial-failure states); Prisma cannot target a dynamic schema per request; the connection pooler can't share prepared statements across `search_path`s. | Rejected |
| **Shared schema + `organization_id` + RLS** | One migration, one pool, one set of indexes. Row counts in the millions per table are routine for Postgres with indexes leading on `organization_id`. Isolation is enforced in three independent layers (below). Scales further by hash-partitioning or sharding **on `organization_id`** without changing application code. | **Chosen** |

### Isolation is enforced in three independent layers

1. **Application** — the tenant comes only from the verified JWT; every repository function takes
   the transaction from `withTenant` and filters by `organizationId`.
2. **Database schema** — composite foreign keys `(organization_id, patient_id) → emr_patients
   (organization_id, id)`: an encounter *cannot* reference another tenant's patient even if the
   application has a bug.
3. **Row-level security** — every EMR table has `ENABLE` + `FORCE ROW LEVEL SECURITY` with the
   policy `organization_id = current_setting('app.organization_id', true)`. `withTenant` runs
   `SET LOCAL ROLE sabi_emr_app` (a `NOLOGIN` role **without** `BYPASSRLS`) and
   `set_config('app.organization_id', …, true)`. If the setting is missing, the policy matches
   nothing (verified: an unset tenant sees zero rows and cannot insert).

`SET LOCAL` is transaction-scoped, so it is safe with PgBouncer/Supavisor transaction pooling
and can never leak to the next request on the same connection.

### Tenant resolution

Only via the JWT `organizationId` claim (a user picks an organization at sign-in, which issues a
tenant-scoped token). Subdomain and header resolution are **deliberately not supported**: both
are client-controlled. The URL `:organizationId` is a routing/consistency check only.

### Provisioning (UC-4)

A tenant exists once the platform approves the application (`identity_organizations` row). EMR
defaults (numbering sequences, settings) are created **lazily and idempotently on first use**
(`INSERT … ON CONFLICT DO NOTHING`), so onboarding needs no per-tenant migration and no
downtime, and a crashed onboarding is repaired by the next request.

### Scaling path

- Every index starts with `organization_id`; list endpoints use keyset (cursor) pagination on
  `(organization_id, created_at, id)` — `OFFSET` degrades linearly and is not used.
- When a table passes ~100M rows: `PARTITION BY HASH (organization_id)` (keys already include it).
- Beyond one node: shard on `organization_id` (e.g. Citus) — composite keys make this a
  configuration change, not a rewrite.

## 4. Breaking points called out before implementation

| # | Risk | At what point it breaks | Handling |
| --- | --- | --- | --- |
| B1 | Supabase/Render connect as a role that **bypasses RLS** (owner/superuser). | Day one — RLS would silently do nothing. | `withTenant` switches to `sabi_emr_app` with `SET LOCAL ROLE`; the migration creates the role and grants it to the connecting user. Integration tests run as the restricted role. |
| B2 | Rate limits are in-process memory. | As soon as there are 2+ API instances: each instance counts separately, so the real limit is N×. | Per-tenant limiter added with a pluggable store; **a shared store (Redis) is required before horizontal scaling**. Documented, not faked. |
| B3 | Audit goes to `activity_logs` (no tenant column, FK to users, mutable). | Tenant audit export at scale; HIPAA requires tamper-evidence. | New `emr_audit_events`: tenant-scoped, append-only (trigger blocks UPDATE/DELETE), indexed per tenant/time. Partition monthly later. |
| B4 | Two clinicians edit the same record. | First concurrent edit — last write silently wins. | `version` column + `If-Match`; stale writes get `412 VERSION_CONFLICT`; missing header `428`. |
| B5 | Retries of a create (flaky network) duplicate records. | Mobile/poor-network clinics — immediately. | `Idempotency-Key` on creates; same key + same body replays the stored response, different body → `422`. |
| B6 | Webhooks called inline would couple request latency and correctness to a subscriber. | First slow subscriber. | Transactional outbox + worker with `FOR UPDATE SKIP LOCKED` (safe with several workers), HMAC-signed payloads, exponential backoff. Payloads carry IDs, not PHI. |
| B7 | Entitlement check hits the DB on every request. | High request rates. | Short in-process TTL cache (60 s) per tenant; revocation takes effect within the TTL (documented trade-off). |
| B8 | Telemedicine appointments have no tenant (patient ↔ doctor, not hospital). | Handoff (UC-2): which hospital's EMR receives the encounter? | The doctor must designate one EMR organization for telehealth; if none, no encounter is created (event recorded as skipped, never guessed). Patient matched by linked Sabi user, never by name. |
| B9 | The global error handler returns `err.message` (and stack outside production). | Any unexpected DB error could echo data. | EMR routes use their own handler: stable code + request id only. |
| B10 | `activity_logs`-style `console.log` logging. | Multi-instance debugging, per-tenant metrics. | Structured JSON request log (request id, tenant, route, status, latency; no PHI) + per-tenant counters. |
| B11 | Migrations locking large tables. | Once tables are big. | New tables are created empty (no lock issue). Rules for later changes: add columns nullable/with constant defaults, build indexes `CONCURRENTLY` in their own migration, expand → backfill in batches → contract. |

## 5. Modules and build order

1. **Foundation** — tenant context middleware, `withTenant`, RLS role/policies, errors, audit,
   idempotency, optimistic concurrency, per-tenant rate limit, request logging/metrics, outbox +
   webhook subscriptions.
2. **Patients** — register (idempotent), get, search (keyset), update (versioned), identifiers
   (NIN unique per tenant), duplicate check, deactivate (no hard delete — records are retained),
   link to a Sabi patient account.
3. **Encounters** — check-in → in progress → note draft → sign (locks) → amend (append-only
   amendment trail); vitals as observations; diagnoses.
4. **Telemedicine handoff** — completed doctor appointment → EMR encounter (UC-2).
5. Then: orders & results (lab), prescriptions/dispensing, admissions, billing — same pattern.

## 6. Use cases (each is an automated test)

Legend: **I** = real-database integration test (RLS on), **U** = unit/route test.

### Foundation / tenancy
- **UC-1** Provider in tenant A never sees tenant B's patients — list, get, search, update, and
  guessing B's patient id all return nothing/404 (I).
- **UC-1b** A token for tenant A calling `/organizations/{B}/…` gets 403 `ORGANIZATION_ACCESS_DENIED` (U).
- **UC-1c** Even if application code forgets the `organizationId` filter, RLS returns only the
  current tenant's rows (I — query without a filter inside `withTenant`).
- **UC-1d** Inside `withTenant(A)`, inserting a row for tenant B fails (I).
- **UC-1e** A transaction with no tenant set sees zero rows (I).
- **UC-1f** An encounter cannot reference another tenant's patient — composite FK rejects it (I).
- **UC-4** A newly approved tenant registers its first patient with no manual setup; running
  default provisioning twice changes nothing (I).
- **UC-6** Tenant without EMR entitlement → 403 `EMR_ACCESS_DENIED`; entitlement cache expires (U).
- **UC-7** Per-tenant rate limit: tenant A exhausting its budget does not throttle tenant B (U).

### Permissions
- **UC-8** Receptionist can register/read patients but not sign an encounter; nurse can record
  vitals but not sign; doctor can sign; lab scientist cannot read the patient list (U).
- **UC-9** A member whose membership is suspended mid-session is refused on the next request (U).

### Concurrency / idempotency
- **UC-10** Two providers update the same patient: the second with the old version gets 412; no
  data is lost (I).
- **UC-11** Update without `If-Match` → 428 (U).
- **UC-12** Retried registration with the same `Idempotency-Key` returns the same patient, not a
  duplicate; same key with a different body → 422 (I).
- **UC-13** Two simultaneous registrations with the same MRN → one 201, one 409 (I).

### Audit / events
- **UC-3** A patient update writes an audit event (field names only) and an outbox event in the
  same transaction; the worker delivers it to the tenant's webhook with a valid HMAC signature;
  a failing subscriber is retried with backoff and never blocks the request (I + U).
- **UC-14** Audit rows cannot be updated or deleted, even by the app role (I).
- **UC-15** Tenant A's webhook never receives tenant B's events (I).

### Encounters
- **UC-16** A signed note cannot be edited; an amendment preserves the original and records
  who/when/why (I).
- **UC-17** Encounter for a deactivated patient is refused (U).

### Integration
- **UC-2** A completed telemedicine appointment creates exactly one EMR encounter in the doctor's
  designated organization, linked to the patient's EMR record; replaying the event does not
  create a second encounter; a doctor with no designated organization produces no encounter (I).

### Scale
- **UC-5** 10,000 tenants × 100 patients (1,000,000 rows): a tenant's first page of patients,
  a name search and a get-by-id each stay under **50 ms** at the database, and the plan uses the
  tenant index (script `scripts/emr-scale-check.mjs`, run on demand — too slow for every CI run).
  **Measured 2026-09-29** (1,000,000 rows, 10,000 tenants, RLS on, in-memory PGlite): first page
  0.44 ms, name search 0.69 ms, get by id 0.09 ms (median of 5); the restricted role sees exactly
  100 of 1,000,000 rows. Re-run on production-like Postgres before go-live.

## 7. Non-functional requirements

| Requirement | How |
| --- | --- |
| Encryption in transit | TLS at Render/Supabase; HSTS via helmet. |
| Encryption at rest | Supabase disk encryption. Webhook secrets are stored encrypted (AES-256-GCM, `EMR_SECRET_KEY`). |
| Webhook SSRF | HTTPS only, no credentials in URLs, redirects not followed, and private/loopback/link-local addresses refused inside the socket's own DNS lookup (no check-then-connect window for DNS rebinding). |
| Audit | `emr_audit_events`, append-only, tenant-scoped, exported by users with `audit.view`. |
| Access control | JWT tenant claim + membership + permission codes + RLS. |
| Observability | Request id (`X-Request-Id`, echoed), structured JSON logs, per-tenant request/error/latency counters. |
| Idempotency | `Idempotency-Key` on creates (24 h retention). |
| Rate limiting | Per tenant and per account; shared store required before scaling out (B2). |
| Migrations | Additive; `CONCURRENTLY` rules in B11. |
| API versioning | `/api/v1/emr/...`. |
| No PHI in logs/events | Logs and outbox carry IDs and codes only. |

## 8. Running

- Unit/route tests: `npm test`.
- Real-database EMR tests: `npm run test:emr` (starts an in-memory Postgres (PGlite), applies every
  migration, runs requests as the restricted role with RLS on). PGlite is a single Postgres
  session, so the tests use one connection at a time.
- Scale check: `node scripts/emr-scale-check.mjs` (in memory; `EMR_SCALE_TENANTS` /
  `EMR_SCALE_PER_TENANT` shrink it).
- Enable routes: `EMR_API_ENABLED=true` (the older `EMR_PATIENT_REGISTRY_ENABLED` still works);
  webhook worker: `EMR_OUTBOX_WORKER=true`.

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `EMR_API_ENABLED` | to serve EMR routes | Feature switch; off → 503 `EMR_PATIENT_REGISTRY_DISABLED`. |
| `EMR_SECRET_KEY` | **yes in production** | 32 random bytes, base64. Encrypts webhook signing secrets. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Never commit it. |
| `EMR_OUTBOX_WORKER` | optional | `true` runs outbox dispatch + webhook delivery in this process. Safe on several instances. |
| `EMR_TENANT_RATE_LIMIT_PER_MINUTE` | optional | Per-tenant budget (default 3000). |
| `EMR_WEBHOOK_ALLOW_LOCAL` | never in production | Lets tests/dev deliver to `http://` / private hosts. Ignored when `NODE_ENV=production`. |
| `EMR_DEBUG_ERRORS` | never in production | Adds raw error messages to local logs (they can contain patient data). Ignored in production. |

The migration creates the `sabi_emr_app` role and `GRANT`s it to the migrating user. On Supabase
this is the `postgres` role; no other setup is needed.

## 9. API (v1)

All routes: `/api/v1/emr/organizations/{organizationId}/…`, `Authorization: Bearer <token>` whose
organization claim equals `{organizationId}`. Errors: `{ status: "error", error: { code, message, details?, requestId } }`.

| Method & path | Permission | Notes |
| --- | --- | --- |
| `GET /patients?q&status&limit&cursor` | `patient.read` | Keyset pages: `{ items, nextCursor }`. `status` = `ACTIVE` (default) \| `INACTIVE` \| `ALL`. Legacy `?page=` still returns `nextPage`. Audited (`patient.listed` / `patient.searched`, never the search text). |
| `POST /patients` | `patient.register` | Optional `Idempotency-Key` (16–128 chars). 201 + `ETag`. 409 `MEDICAL_RECORD_NUMBER_IN_USE` / `NATIONAL_ID_IN_USE`. |
| `GET /patients/duplicates?nationalId\|phone\|familyName+dateOfBirth` | `patient.read` or `patient.register` | Up to 10 likely matches in this tenant. |
| `GET /patients/{id}` | `patient.read` | `ETag: W/"version"`. Audited (`patient.viewed`). |
| `PATCH /patients/{id}` | `patient.update` | `If-Match` required (428 without, 412 `VERSION_CONFLICT` if stale). 409 `PATIENT_INACTIVE` on an inactive record. |
| `POST /patients/{id}/deactivate` `{ reason }` | `patient.deactivate` | `If-Match`. Records are never deleted. |
| `POST /patients/{id}/reactivate` | `patient.deactivate` | `If-Match`. |
| `POST /patients/{id}/link-account` `{ userId }` | `patient.update` | `If-Match`. The account must have an ACTIVE enrollment with this hospital; one record per account per tenant. |
| `GET /encounters?status=ARRIVED,IN_PROGRESS&patientId&class&cursor&limit` | `encounter.read` | Visit list with patient summary (no clinical content). Keyset pages. |
| `POST /encounters` `{ patientId, class?, reason?, attendingUserId? }` | `encounter.create` | Check-in. Optional `Idempotency-Key`. 409 `ENCOUNTER_ALREADY_OPEN` (one open visit per patient), 409 `PATIENT_INACTIVE` (UC-17). The attending must be an active doctor of the tenant. |
| `GET /encounters/{id}` · `PATCH /encounters/{id}` | `encounter.read` · `encounter.update` | `ETag`; PATCH needs `If-Match` and an open visit. |
| `POST /encounters/{id}/start` · `/finish` · `/cancel` `{ reason }` | `encounter.update` | `If-Match`. ARRIVED → IN_PROGRESS → FINISHED; open visits can be cancelled with a reason. A visit with a current admission cannot be finished or cancelled — discharge (or cancel the admission) closes it. |
| `GET /encounters/{id}/notes` | `clinical.read` | Notes with their amendments. Audited. |
| `POST /encounters/{id}/notes` `{ kind, subjective?, objective?, assessment?, plan?, body? }` | `clinical.note.write` | Draft. You may only write a kind you may sign (nurses: `NURSING`). |
| `PATCH /encounters/{id}/notes/{noteId}` | `clinical.note.write` | Author only, draft only, `If-Match`. 409 `NOTE_SIGNED`. |
| `POST /encounters/{id}/notes/{noteId}/sign` | `clinical.note.sign` (any) / `nursing.note.sign` (nursing) | Author only, `If-Match`. The database then refuses any change or delete (UC-16). |
| `POST /encounters/{id}/notes/{noteId}/amendments` `{ reason, body }` | as signing | Append-only; the original is never modified. |
| `GET` · `POST /encounters/{id}/vitals` `{ recordedAt?, readings: [{ code, value }] }` | `clinical.read` · `vitals.record` | Units fixed server-side; plausibility ranges; BP needs both values. Open visits only. |
| `POST /encounters/{id}/vitals/{observationId}/entered-in-error` `{ reason }` | `vitals.record` | Values are never edited (column-level grant). |
| `GET` · `POST /encounters/{id}/diagnoses` `{ code (ICD-10), description, rank }` | `clinical.read` · `diagnosis.record` | One active PRIMARY per visit (409 `PRIMARY_DIAGNOSIS_EXISTS`). |
| `POST /encounters/{id}/diagnoses/{diagnosisId}/entered-in-error` `{ reason }` | `diagnosis.record` | |
| `GET /lab/tests?includeInactive` | `lab.order.create` / `lab.order.read` / `lab.catalog.manage` | Tenant catalog; the starter catalog (FBC, MP RDT, FBS, RBS, lipids, E/U/Cr, urinalysis, HIV, HBsAg, pregnancy) is provisioned on first use. Ranges are typical adult values — **each lab must review them**. |
| `POST /lab/tests` · `PATCH /lab/tests/{code}` | `lab.catalog.manage` | Analytes: `NUMERIC` (unit, low/high, criticalLow/High, female/male ranges), `CHOICE` (options, normal), `TEXT`. `If-Match` on PATCH. |
| `POST /encounters/{id}/lab-orders` `{ tests, priority, clinicalNotes }` | `lab.order.create` | Open visit only. Optional `Idempotency-Key`. Each test's definition is copied into the order. |
| `GET /encounters/{id}/lab-orders` | `clinical.read` or `lab.order.read` | Orders with current (non-superseded) results. Audited. |
| `GET /lab/orders?status&priority&patientId&cursor&limit` | `lab.order.read` | Worklist, oldest first; default ORDERED/COLLECTED/IN_PROGRESS; minimal patient identity only. |
| `GET /lab/orders/{orderId}` | `lab.order.read` | Full detail including superseded results (amendment history). |
| `POST /lab/orders/{orderId}/collect` `{ note? }` | `lab.specimen.collect` | `If-Match`. Assigns `LAB-<year>-<nnnnnn>`, unique and consecutive per organization. |
| `POST /lab/orders/{orderId}/cancel` `{ reason }` | `lab.order.create` or `lab.result.verify` | `If-Match`. Only before any results. |
| `PUT /lab/orders/{orderId}/items/{itemId}/results` `{ results: [{ analyteCode, value }] }` | `lab.result.create` | Test's `If-Match`. Every analyte, once. Flags computed server-side (sex-specific ranges). Re-entry replaces preliminary values. |
| `POST /lab/orders/{orderId}/items/{itemId}/verify` | `lab.result.verify` | Test's `If-Match`. Values become FINAL (database-locked); order COMPLETED when every test is verified. Emits `lab.result.released` and, for critical values, `lab.result.critical`. |
| `POST /lab/orders/{orderId}/items/{itemId}/amend` `{ reason, results }` | `lab.result.verify` | Test's `If-Match`. Old values kept as SUPERSEDED; new FINAL values carry the reason. |
| `GET /pharmacy/formulary?q&includeInactive` | `emr.stock.view` / `prescription.create` / `prescription.read` | Tenant formulary with in-date stock; starter formulary (~20 essential medicines) provisioned on first use. Doses are typical adult values — **the hospital must review them**. |
| `POST /pharmacy/formulary` · `PATCH /pharmacy/formulary/{code}` | `emr.formulary.manage` | Dose unit, dispense unit, dose per unit, max daily dose, route, drug classes, controlled, high-alert, reorder level. `If-Match` on PATCH. |
| `GET /pharmacy/stock?q&lowOnly&expiringWithinDays` | `emr.stock.view` | Per drug: in-date on hand, expired on hand, expiring soon, next expiry, batches. |
| `POST /pharmacy/stock/receipts` `{ formularyCode, batchNumber, expiryDate, quantity, unitCostMinor?, supplier? }` | `emr.stock.manage` | **`Idempotency-Key` required.** Same batch + expiry tops up. Expired stock refused. |
| `POST /pharmacy/stock/batches/{batchId}/adjust` `{ quantity (signed), reason, note? }` | `emr.stock.manage` | Batch `If-Match`. Reasons: COUNT_CORRECTION, DAMAGED, EXPIRED, LOST, OTHER (note required). Never below zero. |
| `GET /pharmacy/stock/movements?formularyCode&batchId&cursor` · `GET /pharmacy/stock/reconciliation?cursor&limit` | `emr.stock.view` | Append-only ledger; reconciliation proves on-hand = sum of movements, one page of batches (≤ 1000) per call, continued with `nextCursor`. |
| `GET` · `POST /patients/{id}/allergies` · `POST …/allergies/{allergyId}/entered-in-error` | read: `clinical.read`/`prescription.read`/`allergy.record`; write: `allergy.record` | `substanceCode` is a formulary code or a drug class (e.g. `PENICILLIN`) — what prescribing checks match. One active entry per substance. |
| `GET /patients/{id}/medications?scope=current\|all` | `prescription.read` | Current medicines across visits (course not yet ended) or full history. |
| `POST /encounters/{id}/prescriptions` `{ items: [{ drugCode, dose, doseUnit, frequency, route?, durationDays?, quantity?, prn?, prnReason?, instructions? }], notes?, overrides? }` | `prescription.create` | Open visit, active patient. Quantity computed when possible. Safety checks: ALLERGY / MAX_DOSE / DUPLICATE_THERAPY (HIGH — need `overrides: [{ drugCode, type, reason }]`, else 409 `SAFETY_CHECK_REQUIRED` listing them), DUPLICATE_CLASS (MODERATE), CONTROLLED / HIGH_ALERT (INFO). Alerts + overrides stored per line. |
| `GET /encounters/{id}/prescriptions` · `POST /encounters/{id}/prescriptions/{rxId}/cancel` `{ reason }` | `prescription.read` · `prescription.create` | Cancel keeps what was dispensed; `If-Match`. |
| `GET /pharmacy/prescriptions?status&patientId&cursor` | `prescription.review` or `prescription.dispense` | Queue, oldest first; flags controlled lines and overridden alerts. |
| `GET /pharmacy/prescriptions/{id}` | `prescription.read` | Minimal identity, active allergies, lines with in-date stock, dispenses with batch numbers. |
| `POST /pharmacy/prescriptions/{id}/approve` `{ note? }` · `/reject` `{ reason }` | `prescription.review` | `If-Match`. Reject cancels the lines. |
| `POST /pharmacy/prescriptions/{id}/dispense` `{ lines: [{ itemId, quantity }], witnessUserId?, note? }` | `prescription.dispense` | **`Idempotency-Key` required.** All-or-nothing, FEFO, partial fills allowed, 409 `INSUFFICIENT_STOCK` with what is available. Controlled lines need a witness: a different, active member with `prescription.dispense`. |
| `POST /pharmacy/dispenses/{dispenseId}/returns` `{ lines: [{ lineId, quantity }], reason, restock }` | `prescription.dispense` | **`Idempotency-Key` required.** Back to the same batch (RETURN); `restock: false` also writes it off (ADJUSTMENT). Reopens the line. |
| `GET /wards?includeInactive` · `POST /wards` `{ code, name, kind, genderRestriction, beds? }` · `PATCH /wards/{wardId}` | read: `admission.read`/`ward.manage`; write: `ward.manage` | Bed counts by status and occupancy %. A ward with patients cannot be deactivated or restricted against them. |
| `GET /wards/{wardId}/beds` · `POST /wards/{wardId}/beds` `{ codes }` | `admission.read`/`ward.manage` · `ward.manage` | Beds with the occupying admission and minimal patient identity. Audited. |
| `POST /beds/{bedId}/status` `{ status, reason? }` | `bed.manage` | Bed `If-Match`. AVAILABLE ↔ CLEANING ↔ OUT_OF_SERVICE (reason required); OCCUPIED only via admit/transfer/discharge. |
| `POST /encounters/{id}/admission` `{ bedId, reason, attendingUserId?, expectedDischargeDate? }` | `admission.create` | Open visit, active patient, available bed, ward accepts the patient's sex. Visit becomes INPATIENT / IN_PROGRESS. 409 `BED_NOT_AVAILABLE`, `PATIENT_ALREADY_ADMITTED`, `WARD_RESTRICTED`. |
| `GET /admissions?status&wardId&patientId&cursor` · `GET /admissions/{id}` | `admission.read` | Census (default ADMITTED) with ward/bed; detail with bed history. |
| `POST /admissions/{id}/transfer` `{ bedId, note? }` | `admission.transfer` | `If-Match`. Old bed → CLEANING, new → OCCUPIED, history row. |
| `POST /admissions/{id}/discharge` `{ disposition, summary }` | `admission.discharge` | `If-Match`. Bed → CLEANING, visit FINISHED; `DECEASED` also deactivates the patient. |
| `POST /admissions/{id}/cancel` `{ reason }` | `admission.create` | `If-Match`. Entered-in-error only, and only if nothing is charted. |
| `GET /admissions/{id}/mar` | `medication.administer`/`clinical.read`/`prescription.read` | Administrable medicines (approved, active, prescribed in this stay) with last dose, next allowed time, amount in 24 h; all entries. |
| `POST /admissions/{id}/mar` `{ prescriptionItemId, status: GIVEN\|HELD\|REFUSED\|MISSED, dose?, doseUnit?, route?, administeredAt?, witnessUserId?, reason? }` | `medication.administer` | **`Idempotency-Key` required.** GIVEN passes the administration guard (409 `ADMINISTRATION_NOT_ALLOWED` with `details.rule`: DOSE_UNIT, DOSE_ABOVE_PRESCRIBED, TOO_SOON (+`nextAllowedAt`), DAILY_COUNT, ALREADY_GIVEN, DAILY_MAXIMUM, NOT_ACTIVE). Controlled → witness. Late charting up to 24 h, never before admission or in the future. |
| `POST /admissions/{id}/mar/{administrationId}/entered-in-error` `{ reason }` | `medication.administer` | Entries are never edited or deleted. |
| `GET /billing/prices?category&q` · `POST /billing/prices` `{ category, reference, name, unitPriceMinor, taxRateBp?, currency? }` · `PATCH /billing/prices/{id}` | `billing.read`/`billing.price.manage` | Money in **integer minor units** (kobo). References: `CONSULTATION:<visit class>`, `LAB:<test>`, `MEDICATION:<drug>` (per dispense unit), `BED_DAY:<ward code>` then `BED_DAY:<ward kind>`. Price changes never alter existing charges. |
| `POST /billing/encounters/{id}/capture` | `billing.charge.manage` or `billing.invoice.create` | Creates missing charges from the visit's records, once each (unique source key); returns `{ created, unpriced }` — unpriced items are reported, never charged at zero. |
| `GET /billing/encounters/{id}/charges` · `POST …/charges` · `POST /billing/charges/{id}/void` `{ reason }` | `billing.read` · `billing.charge.manage` | Manual charge from a price item, or hand-priced PROCEDURE/OTHER. Only unbilled charges can be voided; a voided captured charge is not captured again. |
| `POST /billing/encounters/{id}/invoices` `{ discountMinor?, discountReason?, dueDate? }` | `billing.invoice.create` (+ `billing.discount` for a discount) | Captures, then claims every unbilled charge (`FOR UPDATE`), numbers `INV-<year>-<nnnnnn>`, writes the ledger. 409 `NOTHING_TO_INVOICE`. |
| `GET /billing/invoices?status&patientId&cursor` · `GET /billing/invoices/{id}` | `billing.read` | Detail includes charges, payments and the ledger. |
| `POST /billing/invoices/{id}/void` `{ reason }` | `billing.invoice.void` | `If-Match`. Only with nothing paid; charges return to UNBILLED. |
| `POST /billing/invoices/{id}/payments` `{ amountMinor, method, reference? }` | `billing.payment.record` | **`Idempotency-Key` required.** Non-cash needs a reference. 409 `OVERPAYMENT` with the balance. Receipt `RCPT-<year>-<nnnnnn>`. |
| `POST /billing/payments/{id}/reverse` `{ reason }` | `billing.payment.reverse` | Never by the person who recorded the payment. |
| `GET /billing/patients/{id}/statement` · `GET /billing/reconciliation?cursor&limit` | `billing.read` | Outstanding + unbilled; reconciliation checks each invoice against its charges, posted payments and ledger, one page (≤ 1000) per call, continued with `nextCursor`. |
| `GET /audit-events?resourceType&resourceId&cursor&limit` | `audit.view` | Newest first; reading it is audited. |
| `GET` · `PUT` · `DELETE /telehealth/designation` | DOCTOR role | The doctor designates this hospital to receive their completed telemedicine visits (UC-2). Returns `{ designated, designatedElsewhere }` — never another hospital's id. |
| `GET /webhooks` · `POST /webhooks` `{ url, eventTypes }` | `emr.webhook.manage` | HTTPS only, max 10 active. The signing `secret` is returned once. |
| `PATCH /webhooks/{id}` · `POST /webhooks/{id}/rotate-secret` | `emr.webhook.manage` | `If-Match`. Disable with `active: false` (no hard delete). |
| `GET /webhooks/{id}/deliveries` | `emr.webhook.manage` | Recent delivery attempts. |
| `GET /api/v1/emr/internal/metrics` | platform staff | Per-tenant request/error/latency counters. |

**Webhook deliveries** are `POST`ed JSON `{ id, type, organizationId, occurredAt, aggregate: { type, id }, data }`
(identifiers and changed-field names only) with headers `X-Sabi-Event`, `X-Sabi-Delivery` and
`X-Sabi-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. Receivers should verify the
signature, reject timestamps older than 5 minutes, and de-duplicate by `X-Sabi-Delivery`.
Failures retry with exponential backoff (30 s doubling, capped at 6 h); after 10 attempts the
delivery is marked `DEAD`.

## 10. Prescriptions and dispensing — guarantees

| Risk | Guard |
| --- | --- |
| Double dispense / double receipt on retry | `Idempotency-Key` mandatory; claimed in the same transaction as the stock movement. |
| Overselling the last pack | Prescription row + all batches of the drugs locked `FOR UPDATE` before quantities are read; `CHECK (quantity_on_hand >= 0)`. |
| Deadlocks between dispenses sharing drugs | Batches always locked by one statement ordered by (drug, expiry, id). |
| Untracked stock changes | Quantities change only via `moveStock()` which writes the append-only ledger row (with `balance_after`) in the same transaction; column-level grants stop the request role editing anything else; `/stock/reconciliation` checks it. |
| Dispensing expired stock | FEFO over batches with `expiry_date > today` only. |
| Dispensed > prescribed, returned > dispensed | Database `CHECK` constraints on items and dispense lines. |
| Unsafe prescribing | Server-side allergy (drug and class), max-dose, duplicate-therapy checks; HIGH alerts need a stored override reason; dose must be in the formulary's unit. |
| Controlled medicines | ≤ 30 days' supply, as-needed quantity stated, witnessed dispensing (different active pharmacy member). |
| Low stock | `stock.low` emitted once when in-date stock crosses the reorder level. |

## 11. Admissions and MAR — guarantees

| Risk | Guard |
| --- | --- |
| Two patients in one bed | Bed row locked `FOR UPDATE` and status checked; unique index: one ADMITTED admission per bed. |
| Patient or visit admitted twice | Unique indexes: one ADMITTED admission per patient; one non-cancelled admission per visit. |
| Deadlocks (transfer vs discharge, bed swaps) | Lock order everywhere: admission → visit → beds (beds in one statement ordered by id); admit takes visit → beds. |
| Visit closed under an admission, or admission on a cancelled visit | Visit status changes and admit both lock the visit row; finishing/cancelling a visit with a current admission is refused; discharge only closes a still-open visit. |
| Dose charted on a discharged stay | Charting holds a `FOR SHARE` lock on the admission while it checks and writes; discharge takes `FOR UPDATE`. |
| Bed/ward mismatch | Composite FK (ward, bed) on admissions and bed history. |
| Rewriting bed history | Trigger: an assignment can only be closed, once; no deletes. |
| Dose charted twice (double tap / retry) | `Idempotency-Key` mandatory on MAR entries. |
| Dose too soon / too many / STAT repeated / PRN over max | Administration guard: half-interval minimum gap (both directions, so late charting is checked too), daily count over a 22 h window (tolerates daily-dose drift), STAT once, PRN ≤ formulary max over 24 h. The prescription line is locked while checking, so two nurses cannot both pass. |
| Unapproved / stopped / other-visit medicine | Only pharmacist-approved, non-cancelled lines prescribed in the admission's visit. |
| Controlled drugs | Witness required: a different, active member with `medication.administer`. |
| Editing the chart | MAR rows append-only; column-level grant allows only the entered-in-error fields. |

Not modelled yet: ward stock / dispensing to the ward is not decremented by MAR entries (the
pharmacy dispense is the stock event); scheduled dose times (the guard is interval-based).

## 12. Billing — guarantees

| Risk | Guard |
| --- | --- |
| Rounding / float errors | Integer minor units end to end (BigInt in the service); `CHECK amount = quantity × unit price` and `tax = ROUND(amount × rate)` on every charge; JSON conversion refuses unsafe integers. |
| Billing a service twice | Unique `(source_type, source_key)` per tenant: visit, lab item, dispense line, admission-night; capture is `ON CONFLICT DO NOTHING`. |
| Returned medicine still billed | Credit charges for the returned quantity at the unit price originally charged, keyed by cumulative returned. |
| Cancelled lab test still billed | Capture nets every cancelled test to zero: unbilled charges voided, invoiced ones offset by a `LAB_CANCELLED` adjustment at the price charged (also correct if that invoice is voided later). |
| Cancelled visit | No consultation fee, but medicine dispensed and samples collected on it are still billed. |
| A charge on two invoices | Charges claimed `FOR UPDATE` + guarded update; concurrent invoices → one wins, the other gets `NOTHING_TO_INVOICE`. |
| Double payment / overpayment | `Idempotency-Key` mandatory; invoice locked; `CHECK amount_paid <= total`. |
| Silent edits to money | Column-level grants: charge and invoice amounts cannot be updated by the request role; append-only ledger with running balance; reconciliation endpoint. |
| Fraudulent reversals | Separate permission (admin) and a database `CHECK` that the reverser is not the recorder. |
| Silent ₦0 charges | Unpriced items are returned from capture, not charged. |

Not modelled yet: insurance/HMO claims and co-pays, credit notes/refunds of paid invoices beyond
payment reversal, tenant time zones for bed-day midnights (UTC today), multi-currency invoices.

## 13. Telemedicine → EMR handoff (UC-2)

```
doctor completes appointment ──(same tx)──► domain_events: doctor_appointment.completed {appointmentId}
                                                   │  (telemedicine knows nothing about the EMR)
EMR worker (EMR_OUTBOX_WORKER) ◄──────────────────┘
  1. appointment COMPLETED?                 else SKIPPED_NOT_COMPLETED
  2. for a dependent?                       → SKIPPED_DEPENDENT (dependents can't be linked yet)
  3. doctor designated an EMR organization? else SKIPPED_NO_DESIGNATED_ORGANIZATION
  4. still an ACTIVE doctor there?          else SKIPPED_NOT_A_MEMBER
  5. organization has the EMR entitlement?  else SKIPPED_NO_EMR_ENTITLEMENT
  6. withTenant(org): patient record linked to the appointment's Sabi account?
                                            else SKIPPED_NO_LINKED_PATIENT / SKIPPED_PATIENT_INACTIVE
  7. create FINISHED TELEHEALTH encounter (source TELEMEDICINE, source_reference = appointment id),
     audit + outbox `encounter.created`
  8. record the outcome in emr_telehealth_handoffs (one row per appointment)
```

Exactly once: the outcome table is keyed by appointment and `(organization, source, source_reference)`
is unique on encounters, so replays and concurrent workers never create a second encounter. No row
locks are held while working. Outcomes are final: an appointment skipped because the account was
not linked yet is **not** re-processed automatically once it is (a manual re-run is a later feature).
`domain_events` has no retention job yet — add one (e.g. delete consumed events after 90 days)
before it grows large.

## 14. Build status

| Module | Status |
| --- | --- |
| Foundation (tenant context, RLS, audit, idempotency, concurrency, rate limit, logging/metrics, outbox, webhooks) | Done — `npm run test:emr` (24 real-DB cases) + 20 fast tests |
| Patients | Done |
| Encounters (visits, notes + amendments, vitals, diagnoses) | Done — 14 real-DB cases + 8 fast policy tests |
| Telemedicine handoff (UC-2) | Done — 4 real-DB cases (end to end through the telemedicine `complete()`) |
| Laboratory (catalog, orders, specimen/accession, results, verification, amendments, critical alerts) | Done — 7 real-DB cases + 8 fast policy tests |
| Prescriptions, allergies, formulary, stock, dispensing, returns | Done — 16 real-DB cases + 11 fast policy tests |
| Admissions (wards, beds, admit/transfer/discharge/cancel, census, MAR) | Done — 14 real-DB cases + 10 fast policy tests |
| Billing (price list, capture, charges, invoices, payments, reversals, ledger, statements) | Done — 12 real-DB cases + 10 fast policy tests |
