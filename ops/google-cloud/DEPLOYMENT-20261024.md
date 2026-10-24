# Google backend deployment — 24 October 2026

Project: `project-2dfff4eb-ff04-40b1-aff` (`556396127853`).
Region: `us-east1`. Source: backend commit
`7df59cc573071788b4f4a8768cb0840a5bd24bb9`, release PR #10.
The existing `sabi-ai-runtime` in `europe-west1` was not replaced.

## Deployed resources

| Resource | Observed state |
| --- | --- |
| `sabi-api-production` | Cloud Run Ready; public ingress, application authentication retained |
| `sabi-worker-production` | Cloud Run Ready; private IAM invocation plus Google OIDC verification |
| `sabi-production-jobs` | Cloud Tasks RUNNING; 2 concurrent dispatches, 2 dispatches/second |
| `sabi-production-tick` | Scheduler ENABLED; every minute, UTC; authenticated dispatch succeeded |
| `sabi-production-images` | Private Artifact Registry Docker repository; digest-pinned deployment |
| `sabi-production-db` / `sabi_production` | 150 migrations applied, including worker coordination metadata |

API: `https://sabi-api-production-556396127853.us-east1.run.app`.
Worker: `https://sabi-worker-production-556396127853.us-east1.run.app`.
The corresponding hash-based Google URLs also resolve to these same services.

Both services use Gen2, one CPU, 512 MiB memory, request-based CPU allocation,
minimum zero and service maximum one instance. Revision maximum is also one.
API concurrency is 40; worker concurrency is 2. Database pools are bounded at 4.
These are the explicitly approved initial bounds, not an assertion of unlimited
horizontal scalability. Distributed rate limiting is still needed before raising
the API replica cap; current counters are process-local and reset on restart.

The $150/month gross-usage budget and trial billing remain unchanged. No paid
billing upgrade, commitment or automatic shutdown was configured. Budget alerts
are not a hard spending cap. The HA database remains the main recurring cost;
Resend, Daily and Cloudmersive have separate provider limits and charges.

## Access and secrets

API and worker run as their separate approved production service accounts, not
the default compute identity. They use IAM Cloud SQL authentication and private
GCS buckets, with no database password, Supabase key or downloaded Google key.
Enabled Secret Manager versions are pinned in the revisions. The environment
file contains only non-secret configuration and preserves the inspected existing
origins, issuer, feature flags and provider settings. In particular the existing
AI-document-processing flag was false and was not silently changed.

Only `sabi-task-invoker-production` and `sabi-scheduler-production` receive
service-level Run Invoker on the worker. There is no `allUsers` worker binding.
API/worker have Enqueuer only on `sabi-production-jobs` and Service Account User
only on the task-invoker identity. Scheduler/task identities receive no database,
bucket, application-secret or platform-administrator access.

Cloud Tasks payloads contain `{}` and a static allowlisted category in the URL,
not patient identifiers, document contents or chat messages. The worker verifies
Google signatures, audience, issuer, verified email and the exact caller identity.
Scheduler can dispatch categories but cannot call execution routes; task identity
can execute categories but cannot invoke the Scheduler dispatch route.

## Durable background processing

All 27 categories are registered: AI chat/source/knowledge/purge, JEV, four
credential scanners, patient and finance screening/cleanup, pharmacy/rider/
finance/subscription mail, pharmacy licence reminders, subscription/rider
reconciliation, rider dispatch, reservation expiry, notifications, EMR outbox and
idempotency cleanup, video cleanup and tracking retention.

Coordination uses PostgreSQL leases, compare-and-set completion, persisted due
times and the pharmacy reminder cursor. Existing domain-job leases, financial
idempotency and scan/reviewer gates remain in place. AI chat additionally wakes
the queue after its transaction commits; Scheduler recovers a failed wakeup.
Finance scanning and delivery batches are bounded for HTTP execution. Neither
new host starts the legacy combined entrypoint's interval loops. The existing
combined Docker target remains available; unqualified builds still select it.

Tasks have a 300-second deadline, exponential retries (10–300 seconds), maximum
20 attempts and 24-hour retry duration. Database work remains persisted if a
wakeup/task is lost. A crash may delay a category until its ten-minute
coordination lease expires; there is not yet a lease heartbeat. Long-running and
realistic load/recovery cases remain acceptance work, not proven by empty queues.

## Verified evidence

- Full CI for the deployed commit: 1,025 unit tests and 635 embedded-PostgreSQL
  tests passed; machine-readable reports independently checked.
- Both attached identities passed actual startup SQL/private-bucket preflight.
- API `/healthz/ready` returned `200` with `{"status":"ready"}`.
- `/api/health` reported the exact deployed source revision.
- Unauthenticated `/api/v1/platform/users` returned `401`.
- Unsigned worker invocation returned platform `403`.
- Real Scheduler/Tasks OIDC requests reached private worker routes with `200`.
- All **27** category checkpoints had completed, **0** recorded failures and
  **0** active leases at the captured verification point. The database is fresh;
  these were idle/empty-queue checks, not 27 clinical or financial transactions.
- All 235 RLS-enabled and 216 FORCE RLS table protections were retained. The new
  coordination table is worker-only; API has no table access.

The Docker-daemon registry push encountered connection refusal. Google's pinned
`crane v0.22.1` successfully published the same image archives using the existing
gcloud credential helper, without changing network controls or disabling TLS.
The Node base is pinned to the digest resolved during the verified build.
Runtime npm dependencies had no known audit findings at the preceding release
check; three moderate development-only Vitest findings remained. No comprehensive
OS-image vulnerability assessment is claimed.

## Not a completed frontend cutover

No existing website domain, Vercel API target, Render setting or Supabase resource
was changed/deleted in this deployment. This is a fresh database with no imported
users, roles, hospitals, records or files. Old test passwords/sessions/admin grants
do not become production accounts. No first production platform admin was granted.

Before switching website traffic: complete realistic upload/scan/preview and provider tests,
signup/verification/login/refresh/MFA and tenant-isolation acceptance, backup
restore drill, initial verified platform-owner provisioning, load/recovery and
monitoring checks, and the reviewed frontend release/API-proxy update. CI/CD
promotion to Google remains a separate follow-up; a Git push alone does not yet
automatically run this deployment script. Retain old resources until separately
authorised retirement.

## Upload compatibility release and frontend acceptance preview

On 24 October the Google API and worker were updated to
`abf7cb37be406f2f3c7196398ae35f5a8bd8c29a` after CI run `40080479442`
independently verified **1,032 unit** and **635 embedded PostgreSQL** tests.
Ready revisions: API `sabi-api-production-00002-7cm`, worker
`sabi-worker-production-00002-htg`. The API reported that exact source commit;
readiness was 200, anonymous platform access 401, anonymous worker access 403.

Both patient-document upload paths now use GCS in Google mode and join the
persisted integrity-checked Cloudmersive screening workflow. Legacy S3 adapters
remain for other environments, not as a Google production dependency. The
compatibility signed-PUT path still needs exact-origin bucket CORS and a real
signed-request smoke test; the current portal's authenticated binary-intake
path does not need browser-to-bucket CORS.

Protected Vercel preview (Ready; **not** production alias):
`https://sabi-health-2hkde60mn-sanusi2002s-projects.vercel.app`.
Deployment `dpl_9oFSV3ErjcfmBQRfTMQ1X4RLqgZj`, source frontend `bf15500`
plus the preview-only configuration now committed as `d18b43f` in PR #7.
An authorised CLI request through that preview's `/api/health` returned the
Google `abf7cb3` revision, and `/telemedicine/login` returned 200. These HTTP
checks do not establish a signed-in patient workflow or successful email delivery.

The owner explicitly approved that single preview origin and temporary email
callback bases. Apply these **only with** `deploy.mjs api --acceptance-preview`
and `deploy.mjs worker --acceptance-preview`; ordinary deploy commands keep the
production callback settings. `acceptance-preview.json` contains no secrets.
The nested patient verification base needs the subsequent `943cad0` fix before
activating that override. All existing origins remain; no wildcard is added.

After acceptance, return both services to the production callback configuration
as part of the reviewed live cutover. No user account, first-admin grant, restore
drill or full clinical/payment acceptance is implied by preparing this preview.
