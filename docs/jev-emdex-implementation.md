# JEV and EMDEX implementation contract

Checkpoint: 20 October 2026. Source requirements: `Jev_EMR_Implementation_Specification.docx`
and `EMDEX_AI_EMR_Doctor_Portal_Codex_Instructions.docx`, supplied by the user.
This is a traceability and release document, not a declaration that all modules are delivered.

## Provider responsibilities

- **JEV / TypeSafe:** structured Choice, Score and Noul assessments of explicitly supplied state.
  It is an external service, not a renamed Sabi chat persona. Confidence is not disease probability.
  Noul returns a single value, not an invented confidence field or diagnostic certainty.
- **Gemini:** wording, conversational assistance and supported document extraction. It must not
  substitute for a structured JEV result or a deterministic safety/business rule.
- **EMDEX:** licensed medicine catalogue/reference fields that the subscribed API actually supplies.
  Product strength is not a patient dose. A catalogue match does not establish prescribing safety.
- **Sabi domain services:** authorization, patient identity, calculations, signed notes, prescriptions,
  inventory, payments and approvals. A clinician remains responsible for clinical decisions.

No raw JEV proxy, arbitrary question editor, clinician-autonomous action or model-generated
inventory/financial mutation is exposed to a browser.

## Delivered backend foundation

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Typed external provider boundary | `src/modules/ai/jev/jev.provider.js` | `test/jev.provider.test.js` |
| Choice / Score / Noul validation | Exact answer keys, allowed choices, ordered score legend/distribution, bounded values, model match | Same adapter suite; malformed/partial output rejected |
| Model discovery and pinning | Server-only model-list adapter; tenant execution requires evaluated full `jev-X.Y.Z` | Model-list fixture, alias/pin tests; current real model availability not yet verified |
| Approved atomic question registry | `jev.registry.js`: `MEDICATION_HISTORY_DOCUMENTATION`, `medication-history-v1`, C12 subset | Fixed application questions; no client state/model/question override |
| Durable jobs and lineage | `EmrJevAssessment`, `JevAssessmentJob`, source fingerprint, note/policy/question/model versions, usage | `test/emr-db/jev.assessments.db.test.js` with embedded PostgreSQL |
| Tenant isolation | `withTenant`, restricted database role, forced RLS for clinical assessment/review/policy, composite source FK | Cross-tenant API and direct database tests |
| Rechecks and staleness | Verified doctor/membership/EMR entitlement checked before and after provider call; note/policy rechecked | Source-edited-before/during, role removal and policy-revision tests |
| Human disposition | Append-only ACCEPTED / REJECTED / DEFERRED review receipts with reason and request UUID | Retry and update/delete denial tests; clinical note unchanged |
| EMR review panel | Frontend `src/components/clinical/JevNoteReview.tsx`, mounted beside saved consultation drafts via `src/emr-live/consultation.ts` | Six component tests: explicit submission, unavailable policy, human receipt, unsaved edits, provider failure, previous-note response isolation |
| Outage behavior | Safe error codes, no raw vendor errors, no synthetic negative findings, no automatic uncertain retry | Provider failure, interrupted-claim and malformed-output tests |
| Shadow and review-only modes | Tenant policy DISABLED / SHADOW / REVIEW_ONLY; shadow answers not shown | Shadow acceptance denied; disabling hides answers while metadata stays readable |
| Bounded processing | 60 KB request, 256 KB response, 8-second provider deadline, 30 questions maximum, persisted tenant/day allowance | Boundary and quota tests; these are not a monetary cap |
| EMDEX request transport | `src/modules/medicine-reference/emdex.transport.js` | `test/emdex.transport.test.js` |

The first persisted assessment classifies how medicine history is documented in an existing draft
note. It does **not** perform medication reconciliation, identify an unknown drug, assess interactions,
recommend treatment or provide the entirety of C12. Unknown/not documented/denied/conflicting are
separate choices. Source text remains untrusted evidence; removing IDs is not a guarantee of anonymization.

### API contract

Existing authenticated EMR tenant base: `/api/v1/emr/organizations/:organizationId/ai`.
Existing Sabi membership and clinical-note signing permission are required, plus a freshly verified
DOCTOR role in the service. URL tenant IDs never override the authenticated organization.

| Method | Relative path | Body / result |
| --- | --- | --- |
| GET | `/encounters/:encounterId/notes/:noteId/assessments` | Latest 25 assessment metadata/results, latest 10 reviews each; private/no-store |
| POST | Same path | Strict `{clientRequestId: UUID, noteVersion: integer}`; 202 and durable assessment ID |
| POST | `/assessments/:assessmentId/reviews` | Strict `{clientRequestId: UUID, disposition, reason}`; 201 and immutable receipt |

Reuse the same request UUID for a network retry. Reusing it with different source/intent fails.
Identical source/policy/question work is deduplicated even with another UUID. Failed/uncertain work
is not automatically resent; explicit retry/recovery tooling is still a follow-on requirement.
Jobs carry only internal metadata, not clinical prompt text. Provider calls run outside database
transactions. Expired claims fail visibly instead of leaving a queued assessment permanently stuck.

`clinicalActionApplied` is always false. An ACCEPTED receipt records a clinician's assessment
disposition only; it does not edit/sign a note or prescribe. Manual care remains available if JEV fails.

### Runtime configuration and secret custody

The official Google project `project-2dfff4eb-ff04-40b1-aff` now has Secret Manager enabled and
secret `typesafe-api-key`, version 1. The approved key was created in the user's TypeSafe account
and transferred directly to Secret Manager. No key was printed, committed or saved in the workspace.
On 20 October, the user separately approved and the console verified Secret Manager Secret
Accessor for `sabi-ai-production@project-2dfff4eb-ff04-40b1-aff.iam.gserviceaccount.com` on this
secret only. The identity is not yet attached to a deployed runtime; no other secret access was granted.

Future runtime injection uses `TYPESAFE_API_KEY`. Each tenant workflow also needs a reviewed policy
containing clinical owner, approval/evaluation reference, processing approval time, question version,
mode and evaluated pinned model. This code does not seed clinical approval, invent cutoffs, or infer
approval from the existence of a key. No real patient request was made during this checkpoint.

### Connectivity checks, not configuration guesses

`npm run ai:check` reports redacted configuration metadata only, without database or provider calls.
`npm run ai:check -- --execute-synthetic` explicitly sends fixed non-personal fixtures to the
configured Google and JEV providers. The JEV probe requires an available pinned `JEV_SMOKE_MODEL`;
it does not guess a model or reuse clinical records. Run it within the configured server environment,
never put credentials in command arguments. Exit status is nonzero if either explicit probe fails.
Outputs exclude keys, provider error bodies, prompts and hidden reasoning.

Provider checks are separate from clinical activation and tenant policies. Even a successful probe
does not prove patient login, durable worker execution or a complete conversation. Command Centre
shows configuration metadata, explicitly not a verified connection. Before release, exercise an
authenticated patient conversation through enqueue, worker claim, provider execution, persistence,
reload, cancellation and ownership denial in the intended deployed environment.

`JEV_DAILY_ASSESSMENT_LIMIT` is a bounded count (1–1000, default 30) per tenant per UTC day.
There is not yet a cross-tenant dollar budget, licensed billing policy, department policy editor,
model rollout evaluator or Command Centre JEV monitoring UI. Audit contains IDs/actions, not prompts.

Apply additive migration `20261024105000_jev_assessments` only through the reviewed release job after
a backup/restore check. Do not run migrations as a side effect of API startup. Roll back by disabling
new assessments and deploying the previous compatible binary, retaining assessment/review history.

## Complete JEV module map

All rows reuse the foundation above, but **that does not make their domain-specific assessor complete**.
Only the C12 documentation subset is implemented. Paths below name existing integration seams or
proposed adapters, not proof of deployed JEV behavior. Phases: F1 foundation; F2 documentation and
operational narratives; F3 validated consultation; F4 wider EMR. Each needs its own approved questions,
minimal-state builder, source/dependency fingerprint, evaluation cases, UI and clinician disposition.

| ID | Workflow and integration seam | Current JEV status / work still needed |
| --- | --- | --- |
| C01 | Pre-consultation chart; `emr/records`, `emr/encounters` | F3 pending: chart authorization/minimum snapshot, missing/conflicting context, no inferred negatives |
| C02 | History questions; `emr/encounters` | F3 pending: discipline-specific questions, explicit unknowns, advisory follow-up only |
| C03 | Examination; `emr/encounters` and examination JSON | F3 pending: reviewed exam expectations; never infer observations not performed |
| C04 | Narrative warning; encounter drafts | F3 pending: evaluated concern rubric, explicit escalation ownership; no free-text diagnosis alert masquerading as a rule |
| C05 | Differential considerations; encounter assessment | F3 pending: clinician-owned criteria and evidence, no automatic diagnosis or probability claim |
| C06 | Investigation review; `emr/lab`, `emr/radiology` | F3 pending: structured order context, deterministic units/ranges, repeat/appropriateness advisory |
| C07 | Clinical consistency; notes/diagnoses/orders | F3 pending: cross-record dependency fingerprint, contradictions and abstention |
| C08 | Medication reconciliation; `emr/pharmacy` | F3 pending: explicit product identity, complete actual-use/history state, duplicate/unknown handling |
| C09 | Prescription review; pharmacy/prescription domains | F3 pending: licensed evidence, deterministic allergy/dose/interaction services; no automatic signing |
| C10 | Treatment-plan review; encounter plan | F3 pending: clinically reviewed rubric and state, clinician accepts/rejects/defer; no autonomous regimen |
| C11 | Referral/disposition; `emr/admissions`, encounters | F3 pending: validated rubric and human escalation, no autonomous admit/discharge |
| C12 | Documentation/coding; notes | F1 subset delivered: medicine-history documentation classifier + persisted review + saved-note review panel. F2 pending: remaining completeness/coding checks; no auto-upcoding |
| C13 | Instructions/follow-up; encounter instructions | F3 pending: consistency/readability review, deterministic scheduling remains outside model |
| N01 | Nursing/handover; nursing/ward notes | F4 pending: handover-specific context/questions and nurse scope policy |
| N02 | Ward round; admissions/ward-round context | F4 pending: longitudinal dependency tracking, separate observer vs reported evidence |
| N03 | Adherence/care plan; care-plan domain | F4 pending: approved adherence rubric; no blame, invented adherence or treatment mutation |
| N04 | Discharge documentation; `emr/admissions` | F4 pending: verified checklist, disposition workflow and accountable clinician |
| D01 | Laboratory narrative; `emr/lab` | F4 pending: result/unit/reference authority, critical-result acknowledgment separate from JEV |
| D02 | Result follow-up; lab/radiology follow-up | F4 pending: accountable owner, deadline, acknowledgment/escalation; model cannot mark completed |
| D03 | Radiology/procedure text; `emr/radiology`, `emr/procedures` | F4 pending: text-only review, no diagnostic image interpretation |
| D04 | Allied health; discipline-scoped notes | F4 pending: separate dietetics/physio/etc scope, questions and validation |
| O01 | Pharmacy clarification; pharmacy domain | F2 pending: narrative routing/clarification only; stock/dispense authority deterministic |
| O02 | Inventory narratives; pharmacy/inventory | F2 pending: count/reconciliation facts from ledger, narrative exception classification only |
| O03 | Procurement exceptions; purchasing workflows | F2 pending: provenance and scoped exception questions; no supplier selection/approval by model |
| O04 | Billing narratives; `emr/billing` | F2 pending: invoice facts from ledger, classification only; no total/tax mutation |
| O05 | Claims; claims workflows | F2 pending: structured claim identity and completeness checklist; no autonomous submission |
| O06 | Accounting classification; accounting services | F2 pending: approved chart-of-accounts rubric and human posting; deterministic money math |
| O07 | Reconciliation; financial services | F2 pending: deterministic matching/totals and source references; JEV explains narrative exceptions only |
| A01 | Appointments/registration; `emr/appointments`, patients | F2 pending: completeness/exception questions; deterministic identity and schedule rules |
| A02 | HR requests; HR module | F2 pending: authorized request-only context; no employee performance/personality decisions |
| A03 | Equipment/SCADA notes; equipment module | F2 pending: notes only, no direct equipment/control-system commands |
| A04 | Incident review; incident workflow | F2 pending: scoped incident facts, accountable reviewer, immutable decision record |
| A05 | Platform oversight; Command Centre | F2 pending: metadata metrics, policy/review UI, MFA-protected publication; no default raw-patient dashboard |
| A06 | Knowledge/citation support; AI reference domain | F2 pending: authorized references, evidence version/rights, citation verification; no fabricated library |
| A07 | Messages/portals; patient/doctor portal | F2 pending: authorized mode/context adapters and status UI; no arbitrary chart access or autonomous replies as a clinician |

### Common acceptance suite for each subsequent module

1. Approved atomic criteria and immutable version; evaluation set covers missing, explicit negative,
   unknown, conflicting and out-of-scope evidence. Clinical owner records approval; no invented cutoff.
2. Only minimal authorized source facts are sent; patient/tenant/discipline and source revisions
   cannot be supplied through an untrusted prompt. Source/dependency changes invalidate old results.
3. Strict primitive parsing, correct resolved model and usage; malformed, incomplete, timeout and
   authorization failures show unavailable/abstained, never an all-clear clinical conclusion.
4. Duplicate/concurrent delivery produces one assessment; uncertain calls are not silently repeated.
   A result may not overwrite human work, transition a signed record or bypass a domain safety check.
5. Human dispositions are attributed and append-only. Any future writeback must be a separate
   confirmed, revision-checked domain operation with an immutable receipt, not a side effect of acceptance.
6. Tenant isolation/RLS and before/after revocation tests pass. Frontend includes pending, stale,
   unavailable and review states, keyboard access, clear source/version and no blocking care workflow.
7. Usage, failure rates, latency, drift and reviewer disagreement are monitored without raw medical
   logs. On-demand durable scheduling and distributed limits are required before scale-to-zero rollout.

## EMDEX requirement map and dependency boundary

There is **no authenticated EMDEX account or licensed package supplied**. The linked public Postman
documentation specifies request forms but provides no response examples for these operations.
Do not use its sample email/password, scrape a catalogue, invent products or infer clinical fields.

| Requirement | Current preparation | Remaining acceptance work |
| --- | --- | --- |
| API access/authentication | Backend-only multipart/Bearer transport, fixed verified sandbox host | Licensed account, permitted production host, actual login/token/refresh contract and rotation |
| Brand/generic search | Documented request paths and strict keyword/form/strength validation | Real response fixtures, pagination/error/encoding contracts, correct product selection UI |
| Product details | Documented brand/generic detail request paths | Verify identifiers and returned strength/form/manufacturer/registration fields before normalization |
| Shared catalogue identity | Provider boundary isolated from EMR/patient/doctor UI | Versioned normalized product model and same IDs used by all clients; no first-result auto-selection |
| EMR prescribing | No unsafe substitute wired to a prescription | Explicit product selection, separate clinician dose/route/frequency/duration, normal signing/safety flow |
| Doctor portal | Reuses intended shared reference service, not a duplicate local product list | Authorized lookup and same product selection/snapshot contract as EMR |
| Sabi AI reference use | No raw/unverified EMDEX response enters a prompt | Only fields authorized by licensed package; provenance/ID/version/time and unresolved ambiguity |
| Inventory linkage | EMDEX never claimed as stock/price authority | Explicit tenant formulary-to-product mapping, branch stock/price from inventory, no fuzzy substitution |
| Caching/rights | No catalogue cache or response persistence enabled | Licensed TTL/storage/redistribution and deletion rules; tested cache expiration and stale display |
| Signed prescription history | Existing prescriptions not altered | Freeze selected product snapshot at signing; later catalogue updates cannot rewrite historical Rx |
| Clinical safety | No claim of interaction/dose/allergy validation | Verify licensed clinical endpoints separately; deterministic independent safety authority remains |
| Operations/security | Timeout, response bounds, no redirects, safe failures and no token in URL | Account-scoped rate limit/backoff, provider health metrics, credential expiry/rotation and live contract tests |

Verified transport endpoints (sandbox only): POST `/brand/search`, `/brand/`, `/generic/search`,
`/generic`, relative to `https://sandbox.emdexapi.com/api/v1`. Responses remain explicitly
`normalized: false` inside the provider boundary. There is no public EMDEX route advertising fake
capabilities. `EMDEX_API_TOKEN` and `TYPESAFE_API_KEY` are server-only variables, never `VITE_`.

## Release status

Local verification: **934 unit/route tests across 94 files passed**; **50 embedded PostgreSQL AI
tests passed**, including **13 JEV database scenarios** and the existing conversation/document/action
regressions. The 934 includes **32 JEV/EMDEX adapter tests**; do not add those again when reporting
totals. Lint and complete API coverage are separate checks. No live database was used by these tests.

The first panel uses existing Sabi tokens and controls: clear pending/status feedback, bounded polling,
visible source revision, separate reasoned disposition, no findings for an unsaved editor state and
no changes to the note-signing controls. The UI/UX skill informed those interaction choices. Browser
accessibility state confirmed the synthetic rendered panel; a browser debugger timeout prevented
completion of screenshot/mobile visual QA. That check must not be represented as passed.

This checkpoint is source/local verification, not production clinical activation. Secret storage is
complete, and the approved secret-only runtime IAM binding is verified; runtime attachment,
provider smoke verification, clinically approved pinned
model/policy, broader assessment UI, monitoring/retry operations and production migration remain outstanding.
No existing live EMR, authentication, upload, prescription or inventory feature was disabled by this work.

Provider references consulted:

- [TypeSafe System One API](https://docs.typesafe.ai/api/system-one)
- [Model discovery](https://docs.typesafe.ai/api/list-models)
- [Choice](https://docs.typesafe.ai/primitives/choice), [Score](https://docs.typesafe.ai/primitives/score), [Noul](https://docs.typesafe.ai/primitives/noul)
- [Official EMDEX API site](https://api.emdex.org)
- [EMDEX request documentation](https://documenter.getpostman.com/view/2089551/S1TZybXe?version=latest)
