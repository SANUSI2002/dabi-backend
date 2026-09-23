# Prescription, pharmacy, and commerce workflow

Status: `APPROVED_CTO_SPEC_PENDING_IMPLEMENTATION`. This document is a product
and security specification; it does not create endpoints, permissions, payment
handling, document storage, or delivery integrations.

## Roles and minimum access

| Role | Allowed | Prohibited |
| --- | --- | --- |
| Patient | View own prescriptions, request quotes, choose quotes, pay, cancel where eligible, track own fulfilments. | View another patient's data, approve clinical/pharmacy actions, alter inventory or payment results. |
| Doctor/Clinician | Issue signed Sabi prescriptions; review external uploads; approve, reject, or request clarification. | Self-approve a submitted prescription; dispense; approve own credentials without policy approval. |
| Pharmacist | Verify a paid/eligible allocation, record dispensing, substitutions only with approved policy/patient consent. | Clinical approval of external uploads, payment capture, dispensing without verification. |
| Pharmacy Admin | Maintain their pharmacy staff, inventory and quotes after compliance approval. | Approve their own pharmacy, access unrelated patient data, alter Paystack results. |
| Pharmacy/Compliance Admin | Review pharmacy verification evidence and compliance state. | Approve their own pharmacy or dispense orders. |
| Finance/Admin | Reconcile payments, refunds and exceptions using minimum financial/order data. | Read clinical documents/details unless separately authorized. |
| Delivery Partner | Receive only delivery ID, recipient/contact, verified hand-off instructions and the minimum address/location needed for assigned delivery. | Access diagnosis, prescription, medication rationale, payment details, records, or unassigned deliveries. |
| Super Admin | Break-glass administrative support under audited policy. | Bypass immutable audits, self-approve restricted actions, or use access outside approved support purpose. |

Administrative users receive least-privilege views; delivery data is purpose- and
assignment-limited, with retention controlled by policy.

`PHARMACY_COMPLIANCE_ADMIN` accounts are not publicly registrable. Operations
must provision them through the same controlled, audited runbook used for Super
Admin accounts, with a separate operator and approver. A pharmacy is eligible
for future discovery, prescription requests, inventory, or sale only when its
`PharmacyComplianceStatus` is `VERIFIED`; `PENDING`, `REJECTED`, and
`SUSPENDED` pharmacies are never eligible.

The current discovery API accepts transient patient coordinates and enforces a
maximum radius of 100 km as an API safety limit; it is not a product-design
claim. The browser owns permission and rendering. Coordinates are not stored,
logged, or sent to third parties by this API.

Frontend timer contract: every patient-visible quotation exposes
`quoteExpiresAt`, set to exactly 24 hours after issuance. The client must treat
expired quotes as non-selectable. The future selection endpoint will create an
atomic 20-minute stock hold and return `reservationExpiresAt`; expired holds
release inventory automatically.

## Prescription paths

### Sabi Health doctor-issued

Doctor issues signed prescription → patient views → pharmacy search → requests
to one or more pharmacies → quotations → patient selects allocations → atomic
inventory reservations → checkout/Paystack payment → pharmacist dispensing
verification → fulfilment → per-pharmacy delivery or pickup.

Doctor-issued prescriptions do **not** require a second clinician review. They
always require pharmacist dispensing verification before fulfilment.

### External patient-uploaded

Private upload → malware/virus scan → quarantine → clinician review → approval,
rejection, or clarification → pharmacy search → the same request, quote,
selection, reservation, payment, pharmacist verification, fulfilment and
delivery sequence. An external upload is never visible to a pharmacy before its
required review policy is satisfied.

## Required data-model inventory

- Prescription; items; clinical indication/reason; dosage, frequency, route,
  duration, quantity, instructions; issuing clinician; signature and issue time.
- Pharmacy; verification/compliance status and evidence; pharmacy staff;
  inventory and atomic inventory reservations.
- Prescription request; pharmacy quotation; quoted line items; availability;
  unit/total price; quote expiry; fulfilment estimate; pickup/delivery options.
- One patient order with multiple pharmacy fulfilments and allocation line items.
- Payment abstraction, with Paystack Phase 1, NGN, and Nigeria-first operations.
- Pharmacist review; fulfilment; delivery assignment/tracking; cancellation and
  refund records.
- Encrypted private-document metadata; scan/quarantine/review state; retention;
  immutable audit events.

## State machines and actors

| Lifecycle | States and authorized transitions |
| --- | --- |
| Prescription | `DRAFT → ISSUED` (issuing clinician); `ISSUED → QUOTE_REQUESTED` (patient); `ISSUED/QUOTE_REQUESTED → CANCELLED` (patient where no paid allocation exists; admin exception only). |
| External upload | `UPLOADED → SCANNING` (system) → `QUARANTINED` (system) → `UNDER_REVIEW` (system) → `APPROVED`, `REJECTED`, or `CLARIFICATION_REQUIRED` (clinician); approved only then enters quote request. |
| Request/quote | `REQUESTED → QUOTED` (eligible pharmacy); `QUOTED → SELECTED` (patient); `QUOTED → EXPIRED/DECLINED` (system/patient); request `CANCELLED` (patient before selection). |
| Reservation | `PENDING → RESERVED` (atomic inventory service after selection); `RESERVED → CONSUMED` (paid allocation); `RESERVED → EXPIRED/RELEASED` (system/cancellation). No oversell transition is permitted. |
| Order/payment | `DRAFT → PAYMENT_PENDING` (patient); `PAYMENT_PENDING → PAID/FAILED` (verified Paystack webhook); `PAID → PARTIALLY_FULFILLED/FULFILLED`; cancellation/refund transitions require policy and finance authorization. |
| Pharmacist/fulfilment | `AWAITING_PHARMACIST → VERIFIED` or `REJECTED/CLARIFICATION_REQUIRED` (assigned pharmacist); `VERIFIED → DISPENSED → READY_FOR_PICKUP/READY_FOR_DELIVERY` (assigned pharmacy staff). |
| Delivery per fulfilment | `READY_FOR_DELIVERY → ASSIGNED → PICKED_UP → IN_TRANSIT → DELIVERED` (assigned delivery partner/system); exception transitions `FAILED_ATTEMPT/RETURNED` are audited. |
| Cancellation/refund | `REQUESTED → ELIGIBLE/INELIGIBLE` (policy/finance); `ELIGIBLE → REFUND_PENDING → REFUNDED/REFUND_FAILED` (Paystack/finance). A cancelled allocation releases eligible reservation stock atomically. |

Every transition checks current state, actor role, ownership/assignment, consent,
and immutable audit creation in the same transaction where feasible.

## Mandatory security rules

- Documents use private encrypted storage only; never public URLs.
- Malware/virus scanning completes before any uploaded document becomes
  available; failed/unknown scans remain quarantined.
- Inventory reservation is atomic and expires/releases deterministically.
- Paystack references and webhooks are idempotent; signature verification,
  replay protection, reconciliation, and audit records are mandatory.
- Role checks, patient consent, minimum disclosure, and immutable sensitive
  action audits are mandatory.
- No self pharmacy approval; no self-prescribing without explicit policy
  approval; no dispensing without pharmacist verification; no bypass of
  clinical, payment, inventory, or delivery controls.

## Open CTO/product decisions

- Quote and inventory-reservation expiry durations.
- Cancellation/refund eligibility, timing, and partial-order behaviour.
- Delivery-provider selection and tracking-data retention.
- Geographic/map provider and location-consent behaviour.
- Pharmacy verification evidence and renewal policy.
- Paystack webhook, reconciliation, chargeback, and refund operations.
- Clinical signing and credential-verification policy.
- Records-retention jurisdiction, deletion, and legal-hold policy.

## Phased implementation plan

1. Doctor-issued prescription vertical slice: roles, signed prescription data,
   patient read access, audit and tests.
2. External-upload vertical slice: private storage abstraction, scanning,
   quarantine/review states, retention and tests.
3. Pharmacy/inventory/quote vertical slice: compliance gating, requests, quotes,
   atomic reservations and tests.
4. Multi-pharmacy order vertical slice: allocations, expiries and order state.
5. Paystack vertical slice: payment abstraction, verified idempotent webhook,
   NGN reconciliation and refund controls.
6. Pharmacist fulfilment vertical slice: verification, dispensing and pickup.
7. Delivery vertical slice: assignment, minimum-data hand-off, tracking and
   cancellation/refund integration.
