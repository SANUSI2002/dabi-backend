# Sabi AI allocations

Command Centre > AI operations is the authority for provider-token allowances.
These units are not Naira, purchased credits, or a provider billing statement.

## Controls

- Personal and server-verified professional defaults: requests per day and tokens per period.
- Daily or monthly token renewal, monthly day 1–28, reset clock and supported IANA time zone.
- Requests always renew daily. Tokens can renew monthly independently.
- Per-request total token ceiling and output ceiling; shared daily/cumulative request safeguards.
- Per-account overrides (blank inherits, zero blocks), and signed current-period token adjustments.
- Per-user balances, remaining requests, last 50 ledger events, and unresolved provider outcomes.

Initial migration defaults preserve the previous 10 requests/user/day, 30 shared requests/day,
and 1,000 cumulative requests. The new token allowance is 100,000/day for each account,
12,000 total tokens/request and at most 2,048 output tokens. Reset is 00:00 UTC (01:00 Lagos).
Defaults are editable, not a promise of unlimited service capacity or a paid plan.

## Lifecycle and security

The database opens one durable period on first use; registration, login, reload and retries
cannot refill it. New accounts inherit the current defaults automatically. Changing a schedule
preserves already-open period boundaries and spend; the new schedule governs the next period.
Unused tokens and one-period adjustments do not roll over. Limit edits apply to the remaining
balance without erasing spend. Provider results settle against their original period.

Requests reserve capacity atomically before queueing. The runtime counts the entire prompt
(including context) before generation, bounds output to the reservation, and reports actual
input/output/total usage. Repeated client IDs and provider results cannot debit twice.
Queued cancellations and known preflight failures release tokens, but the accepted request
still counts. Work already performed is not made free by cancelling or deleting a conversation.

If a dispatched provider outcome is unknown, its reservation remains held, marked UNCERTAIN.
An administrator can reconcile it with provider usage, an evidence reference, a reason and
recent MFA. Enter zero only with evidence that no provider generation occurred.
Known usage exceeding a reservation is recorded as TOKEN_OVERAGE, never discarded.

Settings writes require platform.settings.manage, recent MFA, a reason and optimistic versions.
Per-account mutations are audited. Current-period adjustments also require an idempotency UUID.
Non-admin operations readers cannot list account balances. Public usage is owner-scoped and
does not contain conversation text, secret keys or other users' balances. Ledger rows are
append-only at the database layer; owner/window foreign keys prevent cross-account references.
RLS denies unprivileged public access; privileged API authorization remains necessary.

Patient, doctor and standalone shared workspaces show server-owned remaining tokens,
request counts and renewal details. Low/exhausted thresholds create deduplicated in-app
notices, not email. Refresh balance retrieves grants without creating another allocation.

## Rollout order

1. Build/deploy the backward-compatible Cloud Run AI runtime first (optional tokenBudget).
2. Apply additive migration 20261020150000_ai_allowances and deploy the API.
3. Deploy frontend controls and allowance indicators.
4. Verify signed synthetic gateway generation, health/version, authorization and deployed assets.

Do not deploy an API sending tokenBudget to the older strict gateway schema. No extra
Google IAM, public credentials, patient document processing or monetary billing is enabled here.
This request-control layer is not a dollar-spend hard cap; cloud budget alerts and hosting
cost controls remain independent. The current Render test database expires 23 October 2026
and has no backups: durable production database migration is still required separately.
