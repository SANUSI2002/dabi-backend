# Sabi AI foundation integration

## Scope and provenance

First implementation against the Sabi AI Product and Engineering Specification, version 1.0.
The nine original prompt modules in `src/modules/ai/prompts` are preserved from the supplied
`dev sabi ai.zip`. Its `.env`, dependency folder, independent patients table and Supabase Auth
provisioning trigger are deliberately not imported. Sabi Identity remains the authority for people,
sessions and account suspension; no new Firebase or Supabase identity database is created by this code.

The current slice includes general conversation and explicitly selected, owner-reviewed personal
documents. It does not automatically retrieve charts, generate clinical writeback, execute bookings
or dispense medicines. JEV is deferred by the user's 20 October decision. Other requirements remain
in scope; this document is not a declaration that the full product specification is complete.

## Implemented contracts

All paths below start with `/api/v1/ai` and require the existing Sabi bearer session.
Responses carry `requestId`; sensitive responses use `Cache-Control: no-store`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/config` | Capability flags and current consent version, never keys |
| POST | `/sessions` | Create own GENERAL conversation with explicit consent |
| GET | `/sessions` | Latest 50 own conversations |
| GET | `/sessions/:id` | Own conversation with latest 100 messages |
| POST | `/sessions/:id/messages` | Queue a durable response, return 202 and job ID |
| GET | `/runs/:id` | Poll queued/running/terminal response status |
| POST | `/runs/:id/cancel` | Cancel a queued or running response |
| PATCH / DELETE | `/sessions/:id` | Rename or erase own conversation with confirmation |
| GET | `/sessions/:id/export` | Export own available conversation content |
| GET | `/usage` | Persisted request allowance; not a monetary invoice |
| GET / POST | `/memory` | Inspect or explicitly save personal unverified context |
| PATCH / DELETE | `/memory/:id` | Revision-checked correction or revocation |
| POST | `/runs/:id/feedback` | Owner feedback on a completed response |
| GET | `/source-documents` | Own existing medical files, including screening progress |
| GET / POST | `/sources` | List own extractions or queue a screened document with consent |
| GET / DELETE | `/sources/:id` | Inspect or erase a personal derivative, not the original |
| POST | `/sources/:id/review` | Review every page and confirm patient match |
| POST | `/sources/:id/preview` | Authorise a short-lived original page preview |
| GET | `/action-targets/reminders` | Own existing active scheduled-medicine reminder settings |
| GET | `/sessions/:id/actions` | Own previews and immutable completion receipts |
| POST | `/sessions/:id/actions/reminders` | Prepare an exact notification-only change; no mutation yet |
| POST | `/actions/:id/confirm` | Explicitly apply the unchanged preview through the reminder domain |
| POST | `/actions/:id/cancel` | Cancel an own pending preview without changing reminders |

Session creation body: `{ "consentGiven": true, "consentVersion": "sabi-ai-conversation-v1", "mode": "GENERAL" }`.
Message body: `{ "clientMessageId": "<new UUID>", "message": "<text>", "sourceIds": ["<optional reviewed own source UUID>"] }`.
Reuse the same message UUID after a network interruption; different content with that UUID conflicts.
Only one unfinished response is accepted per conversation. Poll at a bounded interval with backoff;
polling is not streaming. Token streaming and resumable stream events are not implemented yet.

## Execution and security

Jobs move QUEUED -> RUNNING -> SUCCEEDED, FAILED or CANCELLED. Their creation, input and audit commit
atomically. The worker claims with a conditional update. The database enforces one active run and one
message UUID per session. Provider calls run outside transactions and have a 45-second timeout.
Cancellation aborts a local request; across instances the terminal database state still blocks late
publication. Cancellation does not promise a provider stopped computing or reverse charges.

Account/session validity is checked before generation and again before publication, using transaction
locks for the final check. Selected source IDs are resolved under owner, scan, version and review checks;
no arbitrary patient/tenant scope or external file URL is accepted. Tenant and delegated contexts must be built
as separate authorised modes, not added as arbitrary prompt fields. AI tables have RLS enabled without
browser policies. The privileged Prisma server must still enforce owner checks; RLS is not claimed as
protection against a privileged credential. General conversation is personal workspace data, not an EMR.

History is bounded to 20 messages and 24,000 characters. Only completed, still-authorised runs enter
context; failed, cancelled or source-revoked turns cannot seed later answers. User memory is explicitly
saved, revisioned and deletable; no automatic verified clinical memory or rolling summary is claimed.
The original triage/action-tag prompts are retained but not activated as validated routing.
Provider output cannot execute tools. Raw provider errors and reasoning parts are never returned.

Development provider calls use `x-goog-api-key`, not a key in the URL. Production Vertex supports ADC
through the attached service identity, without downloaded JSON keys. Both endpoint shapes are supported.
Model selection is explicit; there is no hard-coded old model fallback.
The official project ID is recorded in the example config. Credentials must actually belong to that
project; configuration alone cannot move a key between projects. Clinical data/vendor terms and the
selected model still require review before activating real conversations.

## Deployment and verification

Apply the five additive `2026102410*` AI migrations and regenerate Prisma. The existing medical-document
table gains a composite owner key; existing auth and clinical facts are unchanged. Starting the API starts
a lightweight queue poller; it makes no provider
calls unless AI is enabled and credentials/model/processing approval are configured. Reads of existing
conversations remain available when generation is switched off. An interrupted running job is marked
failed after its lease window, not silently resent. Do not remove tables to roll back; disable generation
and deploy the previous application while retaining records.

Synthetic database tests cover ownership, consent, rejected context injection, idempotency, one active
turn, out-of-transaction generation, cancellation and late completion, provider failure, suspension and
configuration gating. Adapter tests cover secret handling, partial-output rejection, safe errors and
official-project Vertex URLs. No actual Gemini request or live database mutation is required by tests.

## Outstanding requirements

- Token streaming and resumable events; fair worker capacity and monetary cost/tenant entitlements.
- Licensed global reference registry, source rights/publication review, embeddings and book viewer.
- Delegated/page-aware patient and EMR encounter modes; personal owner-selected documents exist now.
- JEV deferred by the user. Reviewed urgency/escalation rules remain separate; no staffed response is implied.
- Further domain tool adapters, EMR drafts/signatures and event integrations. The reminder-only adapter below exists now.
- Time-based conversation retention, versioned clinical evaluations and release review. Owner deletion,
  revoked-document derivative purge, metadata-only Command Centre traces and generation pause exist now.
- WhatsApp, Care Circle, reminders, licensed reference collections, speech/languages and avatar.

Official references used for adapter design: https://ai.google.dev/api/generate-content and
https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/quickstart .
Firebase project addition guidance: https://firebase.google.com/docs/projects/use-firebase-with-existing-cloud-project .

## Personal document pipeline

The patient workspace reuses the existing private upload + Cloudmersive screening flow. Only owner
documents with both CLEAN status and CLEAN verdict, an immutable SHA-256 and private clean object key
can enter AI extraction. A separate versioned consent sends the selected file to the configured Google
processor. No model is asked to inspect an arbitrary URL or quarantined file. Current limits are 3.5 MB,
20 physical PDF pages or one PNG/JPEG; the spec's proposed larger limits are not claimed as implemented.
PDF inspection runs in a resource-limited worker thread with a 5-second deadline; encrypted PDFs,
invalid signatures, huge images and excess pages fail before the provider request.

QUEUED -> EXTRACTING -> NEEDS_REVIEW -> READY, with explicit FAILED/DELETED outcomes. The extraction
adapter requires structured JSON, original page order, nullable missing units/ranges and bounded output;
truncated/invalid results are not published as a normal report. Original text and candidate result fields
remain separate from owner corrections. Printed patient labels prompt reconciliation, never identity
merging. Owner confirmation does not certify clinical authenticity or write to medical records.

Only explicitly selected READY derivatives enter bounded lexical retrieval (maximum 3 files, 6 windows).
Responses carry server-selected page anchors, source revisions and snippet hashes. Invalid [S-number]
references are rejected. This validates source identity, not the medical accuracy of every generated
claim; source-grounding quality still needs evaluated real-world review. No semantic index is claimed.
Deleting/correcting a source revokes its prior version for history, run, retry, cancellation and export
reads, subsequent model history and in-flight publication. A worker purges text derivatives of deleted,
infected or rejected originals. Minimal usage/audit metadata remain. Existing downloaded exports cannot
be remotely erased and backup retention must be operationally configured before production.

## Administration and verification

`/api/v1/command-centre/ai` exposes metadata-only operational counts, paginated runs, concern feedback,
audited traces and a version-checked pause switch. Policy writes/trace reads require existing platform
permissions and recent MFA. Administrators do not receive raw private conversations through these routes.
The shared user interface uses existing Sabi auth in standalone, patient and professional workspaces.

20 October foundation verification before the reminder adapter: 902 backend unit/route tests (92 files), 32 embedded PostgreSQL AI tests,
17 focused frontend tests, TypeScript, backend lint, 716/716 API route coverage and OpenAPI validation
passed. API validation retains one unrelated existing social-provider 4xx warning. npm audit reports
zero known vulnerabilities after compatible Prisma 7.10.1 updates; no RC/major upgrade was installed.
All model/file test inputs are synthetic; no live model request or clinical-data transfer has occurred.

## First confirmed domain action: reminder notifications

The user explicitly opens Reminder controls, selects an existing medicine notification setting,
reviews an exact ten-minute preview and confirms it. No LLM output executes a tool. The proposal
binds owner, conversation, schedule version and desired setting; injected dose or patient fields fail.
Confirmation rechecks all of these under database locks, invokes the existing medication-schedule
domain service and stores a receipt in the same transaction. Retries return the same receipt. A database
trigger forbids receipt updates/deletion. This adapter changes notifications only, not doses,
prescriptions or evidence of taking medicine. Existing schedule audit and materialisation still run.
Conversation export includes receipts; conversation deletion cancels pending previews but does not
undo a confirmed domain change or erase its receipt. Booking and other clinical actions remain pending.
