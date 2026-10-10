# Pharmacy marketplace release

The pharmacy backend is an additive extension of the existing Sabi identity, private storage, Cloudmersive evidence screening, prescriptions, reservations, orders, Paystack payments and fulfilments modules. Do not run a separate backend repository/service for it.

## Migration and configuration

- Migration: `20261010120000_pharmacy_marketplace`. Seeded policies: tier 1 1500 bps / 5 km / 1 branch; tier 2 2000 bps / 7 km / 5 branches; tier 3 3000 bps / 10 km / no cap. No seeded pharmacies or automatically published products.
- Generate Prisma before starting, and apply migrations before exposing the new endpoints.
- Reuse server-only Supabase configuration and private quarantine/clean buckets. Never expose service credentials in browser environment variables.
- Reuse configured Cloudmersive credentials screening with `EVIDENCE_SCANNER_ENABLED=true`, `EVIDENCE_SCANNER_PROVIDER=cloudmersive` and the existing approved credential-processing switch. The owner explicitly authorized pharmacy licences/CAC/appointment evidence; patient documents are excluded.
- `PHARMACY_PORTAL_URL` defaults to `https://pharmacy.sabihealth.org`, used for single-use email verification links. Reuse server-only Resend configuration. No emailed passwords.
- Screening persists queued jobs with compare-and-set leases and bounded retries; failed scanner jobs stay non-previewable. Operators can request an audited retry, never override a file to clean.

## Access and data rules

Owner mutation requires active matching identity membership. Verified pharmacists explicitly accept invitations before clinical access. General pharmacy staff has inventory-view access only. Platform review/account decisions require explicit permissions and recent MFA. Own-pharmacy review, self-lockout and last-platform-admin removal are denied.

Images are mandatory, decoded with bounded pixels, resized/re-encoded and stripped of metadata. Medicine stock requires a batch and future expiry. Only eligible public listings are returned. Prescription-only medicines use issued prescription requests/quotes, not public promotion. Prices, stock, delivery radii and commission snapshots are rechecked server-side. Browser flags never imply payment or approval.

Account suspension/ban/disable revokes sessions and refresh credentials across Sabi surfaces. Directory responses never contain password/session/token fields or clinical records. Document preview is signed, private, audited and expires after 60 seconds.

## Verification and remaining work

834 backend regression tests passed; the focused embedded PostgreSQL pharmacy suite passed 19 cases, including complete synthetic prescription quote/reservation/order/dispensing transitions. The full embedded-database regression suite passed 230 cases before the last focused additions. Unit tests cover unsafe screening and image handling. No tests made real charges or approved a real pharmacy.

Automatic settlements/payouts, provider-executed refunds, abandoned converted-order payment reconciliation, clarification resolution, complete courier proof-of-delivery, FEFO/recalls, approval email outbox and operational backup/restore acceptance remain work. No blind stock release after payment initiation is permitted. Existing dependency advisories still need remediation.

The detailed frontend/API workflow, acceptance evidence, sources and commercial-readiness checklist are maintained in the frontend repository at `docs/PHARMACY_IMPLEMENTATION.md`. The hosted database remains the existing disposable test database, not a backed-up production database.
