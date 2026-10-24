# Fresh Google Cloud production environment

Decision: 23 October 2026. This supersedes the earlier plan to retain Render and
Supabase as active staging dependencies. The user requested a **new database and
new storage**, not a copy of existing accounts, clinical records or uploaded files.
Do not delete the old providers or imply their records were migrated.

## Verified starting point

- Official project: `project-2dfff4eb-ff04-40b1-aff`, number `556396127853`.
- Official Google account: `damilare@sabihealth.org`.
- Console reports USD 300 trial credit and 86 days remaining at inspection.
- `sabi-ai-runtime` exists in `europe-west1` and reports healthy.
- `sabi-production-db` is RUNNABLE in `us-east1`, Enterprise PostgreSQL 18.6,
  with regional HA, 1 vCPU, 3.75 GiB RAM and 10 GiB SSD.
- `sabi_production` is a fresh database: 149 migrations applied, zero unfinished
  migrations and zero user accounts, verified through IAM authentication.
- The schema has 363 application tables, including 235 RLS-enabled tables and
  216 with FORCE RLS. These protections were not disabled during migration.
- The old Render PostgreSQL database is expired and suspended; do not bypass
  migrations or configure a replacement as though it contained the old records.
- The EMR backend release is merged at `f61552f`; frontend PR #7 is green and
  contains the unpublished EMR development, not the image library.

## Approved funding and availability decision

The user approved a **USD 150/month target** and explicitly replaced the earlier
USD 120 cumulative trial-consumption cap. Eligible usage may consume the remaining
USD 300 Google trial credit. No paid-billing upgrade, commitment or automatic
service shutdown is authorised. Budgets are alerts, not guaranteed spend caps.
Trial credit is finite; continued service after its expiry requires a separate
billing decision. External provider charges are not covered by Google credit.

The inspected PostgreSQL Enterprise configuration in `us-east1` is 1 dedicated
vCPU, 3.75 GiB RAM and 10 GiB SSD, with automated backups and PITR. Published
regional console quote for **multiple-zone high availability** is approximately
USD 0.14/hour (about USD 102/month) including primary and standby compute and
baseline storage, before backup use, traffic and the other services. The user
approved proceeding under the revised budget. This leaves approximately USD 48
of the monthly target for API, workers, storage, AI and other Google usage;
actual consumption must be monitored rather than represented as a hard cap.
The account owner completed the administrator credential entry and submission.
Subsequent schema setup used short-lived IAM authentication over the loopback-only
Cloud SQL Auth Proxy 2.26.0; the administrator password was not obtained or reused
by the application. Seven automatic backups and seven days of PITR are configured.

The earlier USD 90 total-trial alert was replaced with a USD 150 **monthly**
project-scoped usage alert, excluding credits from the calculation so trial
consumption still counts. Thresholds are 50%, 80%, 100% actual and 100% forecast.
No automatic shutdown, Pub/Sub action or paid-billing upgrade was configured.

## Storage implementation

Production configuration:

```text
PRIVATE_STORAGE_PROVIDER=gcs
GCS_BUCKET_PREFIX=sabi-prod-556396127853
GOOGLE_CLOUD_PROJECT_NUMBER=556396127853
```

Provisioned and verified in the official project on 23 October 2026:

- `sabi-prod-556396127853-hospital-evidence-quarantine`
- `sabi-prod-556396127853-hospital-evidence-clean`
- `sabi-prod-556396127853-clinical-documents`
- `sabi-prod-556396127853-profile-images`
- `sabi-prod-556396127853-finance-documents`

All five use regional Standard storage in `us-east1`, uniform bucket-level
access, enforced public-access prevention, Google-managed encryption and the
default seven-day soft-delete recovery window. No source-provider objects were
copied. API/worker identities have bucket-scoped `sabiPrivateObjects` permissions
(bucket metadata read and object create/read/delete, no IAM administration).
Only the API identity has `sabiPreviewSigner` on itself, containing signBlob only.
Console creation and IAM bindings are not proof of application connectivity;
verify the keyless runtime and its restricted preview signing before cutover.

## Database identities and release checks

`sabi-api-production`, `sabi-worker-production` and `sabi-migration-production`
exist as separate service identities, without downloaded keys. Their Cloud SQL
Client and Instance User bindings are conditional on this instance's exact
resource name and SQL service. The API/worker database users have no CREATEDB,
CREATEROLE or BYPASSRLS attributes. Only the migration identity and the explicitly
approved official operator account have database-administration membership.
The reviewed `ops/google-cloud/runtime-grants.sql` was applied from pinned commit
`ed7a41b` on 24 October. API/worker have application-table DML through a NOLOGIN
group, not ownership or schema administration. Both can explicitly SET ROLE to
`sabi_emr_app` but do not inherit its privileges. A live PostgreSQL check confirmed
application DML=true, direct EMR SELECT=false, schema CREATE=false,
EMR inheritance=false and elevated role attributes=false for both identities.
All 235 RLS-enabled tables and 216 FORCE RLS tables remain protected. The 18
internal AI tables have explicit backend-only policies instead of relying on an
owner connection; JEV job maintenance is worker-only. Immutable audit, allowance
and receipt histories receive no UPDATE/DELETE grants. New tables receive no
automatic/default grants. Eight embedded-PostgreSQL tests cover these grants,
including repeat application, denial and policy checks; lint also passed.

The baseline on-demand database backup completed successfully. A restore drill
has not yet been performed. No users or medical records were imported.

## Provider credentials and server secrets

Five existing provider values (Resend, Cloudmersive, Daily, Google OAuth client
ID/secret) were securely transferred into Secret Manager with approval. Seven
independent server keys were generated directly into Secret Manager without
printing them or saving plaintext files. All 12 have enabled version 1, verified
through metadata-only queries. The existing two AI secrets were retained.
`ops/google-cloud/secrets.md` records the environment mappings and per-secret
API/worker access. The migration identity gets none of these application secrets.
No expired database URL, Supabase key, old signing key or user password was copied.
IAM and version checks are not proof that live provider workflows work end-to-end.

`DATABASE_CONNECTION_MODE=cloud-sql-iam` selects the Google Node connector with
ADC and automatic short-lived token renewal. Configure the exact instance name,
service-account IAM username, `CLOUD_SQL_DATABASE=sabi_production` and a bounded
pool (initially 4). Leave `DATABASE_URL` unset in this mode. URL mode remains for
development and embedded tests; unknown modes or mixed credentials fail closed.

Release `29b5316` passed 997 unit tests and 620 embedded PostgreSQL workflow tests,
with machine-readable reports independently checked in CI. One earlier run had
reported a green GitHub status despite a midnight-sensitive reminder assertion
failure; the replacement time is now relative to the original dose, and CI
explicitly rejects any JSON report containing failures. No production reminder
logic was weakened to fix that test. The production dependency audit is clean;
three moderate development-only Vitest advisories remain. Do not represent
dependency audit results as a complete application-security assessment.

SQL release `ed7a41b` additionally passed the full 997-unit/628-database CI suite,
including the eight new runtime-grant tests. The request-only API at `de7b669`
passed six focused host tests and lint. Its non-root container was successfully
built in Google Cloud Shell with no live secrets in build arguments; image ID
`sha256:0aa58d2f3a643bf44fc7db5396c1ce7703551368a02b0b1963a66f0dfade9630`.
Container syntax and non-root entrypoint checks passed. Starting that image with
only synthetic legacy connection settings exited 1 with a sanitised dependency
preflight error, as intended. This is a local Cloud Shell image, not a registry
publication, deployed API or successful production-connectivity check.

The Google adapter uses Application Default Credentials; no downloaded account
key or Supabase credential is required. Five logical buckets map to private,
project-scoped physical names under this prefix: hospital quarantine, released
evidence, clinical documents, profile images and finance documents. Every
operation checks the project number, uniform bucket-level access and enforced
public-access prevention. Uploads do not overwrite; reads/signatures pin an
object generation; deletion uses a generation precondition. Short-lived preview
links are still issued only after the existing domain authorisation and scan
checks. The application enforces type/size restrictions because GCS does not
provide Supabase's per-bucket MIME/size policy fields.

Patient intake, scan workers, AI personal sources, finance intake and rider
onboarding select the active provider rather than requiring Supabase environment
variables. Existing Supabase support is retained only for compatibility/testing;
the new production environment must explicitly select `gcs` and have no Supabase
secrets. Legacy S3 presigned-upload endpoints need a separate GCS adapter and
acceptance check before claiming every document API is migrated.

## Remaining cutover work — not yet completed

**24 October deployment update:** the request-only API, private worker, scoped
queue identities, Cloud Tasks and Scheduler are now deployed and verified.
The database has 150 applied migrations; all 27 worker categories completed idle
checks with zero failures. Full deployed-source CI passed 1,025 unit and 635
database tests. See `ops/google-cloud/DEPLOYMENT-20261024.md` for the authoritative
resource state, permissions, verified checks and remaining acceptance gaps. This
does not mean the frontend is switched or all end-to-end workflows are certified.

1. Conduct a restore drill for the completed baseline backup, then verify keyless
   API/worker connectivity using their own identities and the applied SQL grants.
2. Recheck scoped permissions during acceptance. Scheduler/task identities and
   queue/invocation grants are now applied. Do not use project-wide Editor or
   download service-account keys.
3. Connect the provisioned private buckets, Secret Manager values and Cloud SQL
   configuration. Provider secrets are now transferred; pin their enabled versions
   in the runtime revisions. Never expose them as frontend variables.
4. Use the migration identity for subsequent schema changes. All 149 existing
   migrations are applied, and runtime grants are tested; the actual attached
   service-account connection and restore drill still require verification.
5. API/worker separation and authenticated Tasks/Scheduler orchestration are now
   deployed. Perform realistic load, retry, crash-recovery and provider tests.
   The implemented design uses authenticated request-billed
   worker handlers and durable queue/Scheduler wakeups; do not suspend reminders,
   scanning, reconciliation or notifications by deploying the current combined
   entrypoint at scale-to-zero. Quote the complete worker cost.
   Bounded single-pass functions now exist for rider dispatch, rider transfer
   reconciliation and subscription reconciliation; the existing interval hosts
   delegate to those same functions. This preparation does not yet implement
   Cloud Tasks/Scheduler orchestration was added in the deployment update above;
   the existing combined development entrypoint remains unchanged.
   The new explicit Docker `api` target uses `src/api.js`: no intervals, database
   and five-private-bucket startup/readiness checks, bounded readiness caching and
   SIGTERM draining. Six unit tests cover host behaviour. Its Google-only startup
   requires IAM SQL and GCS rather than silently accepting legacy providers.
   Default/`runtime` builds still use the existing combined entrypoint. Do not
   promote the request-only target before the durable worker is deployed and
   verified; this target alone is not a complete production rollout.
6. Immutable digest-pinned images are published/deployed. Complete OS-image
   vulnerability review and shared rate enforcement before increasing replicas.
7. Establish initial platform ownership through a verified account and an
   explicitly authorised first-admin grant. Existing Render passwords, roles and
   sessions will not exist in this fresh database. Do not invent demo credentials.
8. Deploy each frontend surface with the Google API target, correct OAuth origins
   and redirects, and no Render rewrite. If all hosting also moves, prepare the
   separate Firebase Hosting targets and its refresh-cookie compatibility.
9. Verify registration, email verification, login/refresh/MFA, tenant isolation,
   uploads/scanning/previews, background jobs and financial idempotency before
   moving the existing domains. Health checks alone are insufficient.
10. Remove active Render/Supabase traffic only after the replacement passes these
    checks. Retain old resources without deleting them unless separately asked.

References: https://cloud.google.com/sql/pricing and
https://docs.cloud.google.com/storage/docs/request-preconditions.
