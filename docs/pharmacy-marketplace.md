# Pharmacy marketplace release

The pharmacy backend is an additive extension of the existing Sabi identity, private storage, Cloudmersive evidence screening, prescriptions, reservations, orders, Paystack payments and fulfilments modules. Do not run a separate backend repository/service for it.

## Migration and configuration

- Migration: `20261010120000_pharmacy_marketplace`. Seeded policies: tier 1 1500 bps / 5 km / 1 branch; tier 2 2000 bps / 7 km / 5 branches; tier 3 3000 bps / 10 km / no cap. No seeded pharmacies or automatically published products.
- Generate Prisma before starting, and apply migrations before exposing the new endpoints.
- Reuse server-only Supabase configuration and private quarantine/clean buckets. Never expose service credentials in browser environment variables.
- Reuse configured Cloudmersive credentials screening with `EVIDENCE_SCANNER_ENABLED=true`, `EVIDENCE_SCANNER_PROVIDER=cloudmersive` and the existing approved credential-processing switch. The owner explicitly authorized pharmacy licences/CAC/appointment evidence; patient documents are excluded.
- `PHARMACY_PORTAL_URL` defaults to `https://pharmacy.sabihealth.org`, used for single-use email verification links. Reuse server-only Resend configuration. No emailed passwords.
- Screening persists queued jobs with compare-and-set leases and bounded retries; failed scanner jobs stay non-previewable. Operators can request an audited retry, never override a file to clean.
- Apply additive migration `20261010180000_pharmacy_operations` for reorder policies, report indexes and durable pharmacy email jobs before starting the release.
- The pharmacy mail worker starts with the API unless `PHARMACY_EMAIL_WORKER=false`. Reuse server-only `RESEND_API_KEY`, `PASSWORD_RESET_EMAIL_FROM` and existing recipient restrictions. Decision notices commit atomically with review decisions; no password, private document link or internal findings are emailed. No backfill of historical approvals.
- Reminder sweep visits 100 verified pharmacies per batch (one minute between batches, one hour between complete sweeps). It checks superintendent/verified-premises licences at 30/14/7/1-day windows and once expired, deduplicated by licence/expiry/window; renewed or superseded jobs are cancelled. It does not send stock-batch expiry emails yet.
- Delivery claims one persisted job per 15-second tick using `FOR UPDATE SKIP LOCKED`, 60-second leases and stable Resend idempotency keys. Six attempts with exponential backoff; stop automatic retries after 23 hours. Resend's [idempotency retention is 24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys), so do not blindly replay an uncertain old send after that window. Investigate failed jobs/provider logs before deliberate reissue. `SENT` records provider acceptance, not inbox delivery. Free/sleeping API hosting may delay reminders; use always-on hosting and queue-age alerts for delivery SLAs.

## Stock and reporting APIs

Active owners use `GET /pharmacy-portal/stock`, `/stock/export`, `/inventory/:id/adjustments`, `PATCH /inventory/:id/reorder-policy`, `GET /reports/sales`, `/reports/sales/export` and `/communications` under `/api/v1`. Existing stock-adjustment endpoints remain idempotent and expected-balance protected. Branches and inventory IDs must belong to the owner; these routes do not expand general staff clinical privileges.

Stock filters support branch/search/state/expiry horizon. Available units exclude holds; active reservations and unfinalized paid/pending order allocations are separate. Earlier expiry sorting is visibility, not automatic multi-lot FEFO. Reorder point/target changes require expected version and reason. Manual adjustment history is immutable through the API but is not a full stock movement ledger.

Sales require `PAID` plus the earliest successful payment completion, NGN, and a Lagos-date range of at most 366 days. Immutable commission snapshots exclude delivery. Unknown legacy commission is excluded from net. Pending refund review is not an executed refund. Branch filters include whole matching fulfilments, not prorated branch accounting. Orders-created counts use creation date, separately from paid sales. These figures are not profit or payout statements.

Reports use repeatable-read snapshots, whitelist fields without clinical/contact data, audit access and export, paginate 50 records and reject CSV exports over 5,000 rows. CSV is formula-escaped, `no-store`, attachment-only and rate limited. Do not upload exports to public storage. Communications history excludes recipients, bodies and provider secrets.

## Access and data rules

Owner mutation requires active matching identity membership. Verified pharmacists explicitly accept invitations before clinical access. General pharmacy staff has inventory-view access only. Platform review/account decisions require explicit permissions and recent MFA. Own-pharmacy review, self-lockout and last-platform-admin removal are denied.

Images are mandatory, decoded with bounded pixels, resized/re-encoded and stripped of metadata. Medicine stock requires a batch and future expiry. Only eligible public listings are returned. Prescription-only medicines use issued prescription requests/quotes, not public promotion. Prices, stock, delivery radii and commission snapshots are rechecked server-side. Browser flags never imply payment or approval.

Account suspension/ban/disable revokes sessions and refresh credentials across Sabi surfaces. Directory responses never contain password/session/token fields or clinical records. Document preview is signed, private, audited and expires after 60 seconds.

## Verification and remaining work

845 backend regression tests passed; the full embedded PostgreSQL suite passed 237 tests, with six operations cases re-run after final Lagos-date fixes. The existing pharmacy cases include complete synthetic prescription quote/reservation/order/dispensing transitions. New cases cover tenant isolation, CSV privacy, reorder conflicts, durable transactional email jobs, reminder deduplication and first-success-payment/midnight boundaries. Eleven operations unit tests cover email retries, stale leases, superseded reminders, export safety and valid dates. No tests sent real email, made real charges or approved a real pharmacy.

Automatic settlements/payouts, provider-executed refunds, abandoned converted-order payment reconciliation, clarification resolution, complete courier proof-of-delivery, FEFO/recalls, purchase orders/cost valuation, stock-expiry email alerts, provider delivery/bounce webhooks and operational backup/restore acceptance remain work. Approval/rejection/suspension email jobs, licence reminders and stock/paid-sales reports are now implemented. No blind stock release after payment initiation is permitted. Existing dependency advisories still need remediation.

The detailed frontend/API workflow, acceptance evidence, sources and commercial-readiness checklist are maintained in the frontend repository at `docs/PHARMACY_IMPLEMENTATION.md`. The hosted database remains the existing disposable test database, not a backed-up production database.
