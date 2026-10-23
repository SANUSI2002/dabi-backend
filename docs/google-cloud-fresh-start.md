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
- Cloud SQL has no existing instance. No new instance has been provisioned.
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
The instance form is prepared but has not been submitted: the account owner must
complete the initial administrator credential entry and submission. No database
is ready until the console confirms creation and connectivity is verified.

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
copied and no API/worker service-account access has yet been granted. Console
creation is not proof of application connectivity; verify the keyless runtime
and its restricted preview-signing permissions before cutover.

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

1. Confirm the regional resource quote and provision the backed-up database.
2. Create separate API, worker, migration and Scheduler identities. Limit each
   identity to the database, buckets and individual secrets it needs; do not use
   project-wide Editor or download service-account keys.
3. Connect the provisioned private buckets, Secret Manager values and Cloud SQL
   configuration. Existing provider secrets must be transferred securely; never
   print them, put them in source or expose them as frontend variables.
4. Run all reviewed migrations once with a migration identity, then a restore
   drill. Establish and test the runtime SQL grants, including tenant RLS roles.
5. Split API serving from interval workers. Use authenticated request-billed
   worker handlers and durable queue/Scheduler wakeups; do not suspend reminders,
   scanning, reconciliation or notifications by deploying the current combined
   entrypoint at scale-to-zero. Quote the complete worker cost.
   Bounded single-pass functions now exist for rider dispatch, rider transfer
   reconciliation and subscription reconciliation; the existing interval hosts
   delegate to those same functions. This preparation does not yet implement
   Cloud Tasks/Scheduler orchestration or remove any existing worker.
6. Build immutable backend images in Google Cloud. Start with a bounded replica
   and database-pool budget; distributed rate enforcement is required before
   increasing API replicas.
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
