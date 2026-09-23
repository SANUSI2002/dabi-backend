# Patient portal endpoint contract

All paths are rooted at `/api/v1`; protected paths scope data to `req.user.id`.

## Account and onboarding

| Screen / action | Method and path | Status |
| --- | --- | --- |
| Login and sessions | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` | IMPLEMENTED |
| Forgot password | `POST /auth/password-reset/request` | IMPLEMENTED |
| Reset password | `POST /auth/password-reset/confirm` | IMPLEMENTED |
| Register patient | `POST /auth/register/patient` | IMPLEMENTED |
| Register caregiver | `POST /auth/register/caregiver`; `GET /caregivers/me` | IMPLEMENTED |
| Register professional/organisation | See role-specific contracts below | PARTIAL |
| OAuth buttons | `POST /auth/oauth/:provider` | NOT_APPLICABLE_PENDING_SLICE |

## Patient dashboard and settings

| Screen / action | Method and path | Status |
| --- | --- | --- |
| Profile and preferences | `GET /profile`, `PUT /profile/update` | IMPLEMENTED |
| Emergency summary | `GET /profile/emergency-summary` | IMPLEMENTED |
| Two-factor preference | `PUT /profile/security` | IMPLEMENTED_PREFERENCE_ONLY |
| Password and deletion | `PUT /profile/security/change-password`, `DELETE /profile/delete-account` | IMPLEMENTED |
| Notifications | `GET /notifications`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all` | IMPLEMENTED |
| Activity history | `/activity` | NOT_APPLICABLE_PENDING_SLICE |

## Records, medication, vitals, appointments

| Screen / action | Method and path | Status |
| --- | --- | --- |
| Medical-record timeline, metadata, and category actions | `GET/POST /medical-records`, `GET/PATCH/DELETE /medical-records/:id`, `GET /medical-records/timeline`, `GET /medical-records/uncategorized`, `PATCH /medical-records/:id/category`, `GET/POST /medical-records/categories`, `PATCH/DELETE /medical-records/categories/:id`, `GET /medical-records/categories/counts` | IMPLEMENTED — owner only, metadata only |
| Records emergency summary | `GET /medical-records/emergency-summary` | IMPLEMENTED — owner-only minimized profile payload |

## Slice 3 dashboard action matrix

| Dashboard screen action | Endpoint | Scope |
| --- | --- | --- |
| Overview cards and empty state | `GET /dashboard` | IMPLEMENTED — authenticated patient aggregate |
| Records summary cards | `GET /dashboard/records-stats` | IMPLEMENTED — authenticated, owner-scoped aggregate |
| Appointment list/filter/detail | `GET /appointments`, `GET /appointments/:id` | IMPLEMENTED — owner only |
| Book/reschedule/cancel | `POST /appointments`, `PATCH /appointments/:id`, `DELETE /appointments/:id` | IMPLEMENTED — owner only |
| Medication list and adherence toggle | `GET/POST /medications`, `PUT/DELETE /medications/:id`, `PATCH /medications/:id/taken` | IMPLEMENTED — owner only |
| Vitals list/history/add | `GET /vitals`, `POST /vitals` | IMPLEMENTED — owner only |
| Health-score history | `GET /health-metrics` | IMPLEMENTED — owner only, stored history only |
| Notifications list/unread/read actions | `GET /notifications`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all` | owner only |

### Vital recording constraints

`POST /vitals` accepts only manually entered `BLOOD_PRESSURE` (`mmHg`,
`systolic/diastolic`), `HEART_RATE` (`bpm`), `TEMPERATURE` (`C` or `F`),
`BLOOD_GLUCOSE` (`mg/dL` or `mmol/L`), and `OXYGEN_SATURATION` (`%`). Values
must be finite, within the documented API recording bounds, and use no more than
two decimal places. `status` is a caller-recorded `NORMAL`, `LOW`, `HIGH`, or
`UNSPECIFIED` label; the API does not diagnose, classify emergencies, or offer
medical advice. Vital creation never changes the cached profile health score.

## Family, facilities, and wellness

| Screen / action | Method and path | Status |
| --- | --- | --- |
| Family/caregiver relationships | `GET /family-care`, `POST /family-care/invitations`, `POST /family-care/invitations/accept`, `POST /family-care/invitations/decline`, `PATCH /family-care/:id/permissions`, `DELETE /family-care/:id`, `GET /family-care/access/:patientId` | IMPLEMENTED — explicit, revocable patient authorization |

Facility enrolment, practitioner directory, and wellness engagements are
NOT_APPLICABLE_PENDING_SLICE.

## CTO-approved commerce and prescription scope

Prescription, pharmacy quotes, cart, checkout, Paystack payment, fulfilment,
delivery, and external-prescription upload are
`APPROVED_CTO_SPEC_PENDING_IMPLEMENTATION`. This is a CTO product decision, not
an existing endpoint or permission to bypass the controls in
`docs/prescription-commerce-workflow.md`.

## Live frontend reconciliation — 2026-09-11

Evidence: public deployed portal and production bundle
`/assets/index-WyNbE8L4.js` at `https://sabi-health-frontend-patient-portal.onrender.com/`.
The table records visible route/action labels, not inferred healthcare features.
The live build contains client-side demo/local-state flows, so visual presence is
not evidence that an API already exists.

### CTO status overrides for visible commerce/document routes

The following rows supersede only the old `DEFERRED_PRODUCT_DECISION` status
text in this reconciliation. Their visible labels and paths remain unchanged.

| Visible requirement | Source | Current status |
| --- | --- | --- |
| `Download record`; `Share record`; `Generate Emergency PDF`; uploaded/external prescription | `LIVE_PATIENT_PORTAL` + `CTO_PRODUCT_DECISION` | `APPROVED_CTO_SPEC_PENDING_IMPLEMENTATION` |
| Prescriptions; select pharmacy; quotes/refills | `LIVE_PATIENT_PORTAL` + `CTO_PRODUCT_DECISION` | `APPROVED_CTO_SPEC_PENDING_IMPLEMENTATION` |
| Pharmacy market; cart; checkout; order confirmation; emergency meds | `LIVE_PATIENT_PORTAL` + `CTO_PRODUCT_DECISION` | `APPROVED_CTO_SPEC_PENDING_IMPLEMENTATION` |
| `Track Delivery` | `LIVE_PATIENT_PORTAL` + `CTO_PRODUCT_DECISION` | IMPLEMENTED - see delivery contract below |
| Paystack payment, pharmacist verification/dispensing, inventory reservation, multi-pharmacy fulfilment | `CTO_PRODUCT_DECISION` | `APPROVED_CTO_SPEC_PENDING_IMPLEMENTATION` |

| Visible screen/action label | Live route/control | Backend mapping | Reconciliation |
| --- | --- | --- | --- |
| Login; `Forgot Password?`; `Send Reset Link`; `Reset password` | `/login`, `/forgot-password`, `/reset-password/:uid/:token` | Password-reset API exists but uses different paths/payloads. | PARTIAL |
| Patient sign-up | `/signup`, `/signup/patient` | `POST /auth/register/patient` | MATCHES_DESIGN |
| `Caregiver Registration` | `/signup/caregiver` | `POST /auth/register/caregiver`; adapter and exact visible form contract below | IMPLEMENTED_BACKEND_ADAPTER_REQUIRED |
| Professional registration | `/signup/professional/:type` | `POST /professionals/register`; the canonical frontend-to-backend profession mapping is documented below and includes all twelve visible choices. | PARTIAL |
| Verified doctor directory/profile and patient consent request | `/doctor`, `/doctors` | `GET /doctor-care/doctors`, `GET /doctor-care/doctors/:id`, `POST /doctor-care/relationships`, `GET /doctor-care/relationships/patient`, `GET /doctor-care/relationships/doctor`, `POST /doctor-care/relationships/:id/accept`, `POST /doctor-care/relationships/:id/decline`, and `DELETE /doctor-care/relationships/:id`. Only a patient can create or revoke; only a verified Doctor can accept or decline. | IMPLEMENTED |
| Prescription issuance eligibility guard | CTO_PRODUCT_DECISION | The next prescription slice must require both an issuer whose professional profile is `DOCTOR` and `VERIFIED`, and an `ACTIVE`, unrevoked, unexpired `DoctorCareRelationship` between that doctor profile and the patient. | APPROVED_CTO_SPEC_PENDING_IMPLEMENTATION |
| Organisation registration | `/signup/organisation/:type` | `POST /organisations/register`, owner `GET /organisations/mine`; private evidence and controlled verification. Pharmacy reuses its existing compliance model. See exact mapping below. | IMPLEMENTED_ADAPTER_REQUIRED |
| Pharmacy organisation registration and compliance status | `CTO_PRODUCT_DECISION` | `POST /pharmacies/register`, `GET /pharmacies/mine`, verified-only public `GET /pharmacies` and `GET /pharmacies/:id`, plus controlled compliance review routes. No inventory, quote, cart, or payment path is included. | IMPLEMENTED |
| Pharmacy inventory and prescription-scoped discovery | `LIVE_PATIENT_PORTAL` + `CTO_PRODUCT_DECISION` | `POST/GET/PUT/DELETE /inventory` is private to the owning verified pharmacy admin. `GET /pharmacies/discovery/prescriptions/:id` returns only verified pharmacies with stored coordinates for the authenticated patient’s issued prescription. Quotes, reservations, cart, payment, and fulfilment remain pending. | IMPLEMENTED |
| Dashboard; `Emergency ID`; `Today's Appointments`; records/medication widgets | `/dashboard` | `GET /dashboard`, `/dashboard/records-stats` | PARTIAL |
| Profile; `Complete Your Health Profile`; `Delete Account`; emergency access | `/profile` | Profile, settings, consent, emergency, security APIs. Avatar/local display controls need no endpoint. | PARTIAL |
| `Medical Records`; `Organized Records`; filters; categories; `View`; `Remove from this category` | `/records` | `/medical-records` metadata/category/timeline APIs; route and vocabulary differ. | PARTIAL |
| `Download record`; `Share record`; `Generate Emergency PDF`; uploaded prescriptions | `/records`, `/reports/:id`, `/prescriptions` | No download/upload/PDF/share/document-processing API. | MISSING — DEFERRED_PRODUCT_DECISION |
| `All Appointments`; details; `Reschedule Appointment`; `Cancel` | `/appointments`, `/appointments/reschedule/:id` | Appointment CRUD/cancel API. Hospital-specific scheduling fields differ. | PARTIAL |
| `Vitals`; `Add`; type history | `/vitals`, `/vitals/add`, `/vitals/add/:type`, `/vitals/history/:type` | `GET/POST /vitals`; `GET /health-metrics`. Bundle calls `/api/vital-records`, not current API paths. | PARTIAL |
| `Family & Care Circle`; `Add New Member`; `Join a Family Circle`; `Setup Dependent Profile`; member profile/removal | `/family`, `/family/add`, `/family/add/dependent`, `/family/member/:memberId` | Existing `family-care` bucket now provides circle listing, owner-issued invitations, expiring token/QR join requests with owner approval, dependent CRUD and member revocation. See foundation contract below. | IMPLEMENTED_BACKEND_ADAPTER_REQUIRED |
| `Care Calendar` | `/family/care-calendar` | Read-only `GET /family-care/calendar` and `/family-care/calendar/upcoming`; strict circle/member permissions and safe existing-appointment summaries. Dependent booking associations remain unavailable. See mapping below. | IMPLEMENTED_READ_ONLY_ADAPTER_REQUIRED |
| Invitation/access labels | Family add/join flows | Patient-issued invitations, explicit permissions, recipient acceptance, token-based join requests and patient approval/revocation. Email provider remains unconfigured; new direct invitations return secure owner handoff material. | IMPLEMENTED_FOUNDATION |
| `Hospitals`; `View All Partners`; enrollment; member plan; booking; check-in | `/hospitals`, `/hospitals/:id`, `/hospitals/:id/enroll`, `/hospitals/:id/appointment`, `/hospitals/check-in/:appointmentId`, `/family/hospital-enrollment` | Verified-only partner name/location/contact listing and detail: `GET /organisations?type=hospital`, `GET /organisations/:id`. Hospital-owned active plan catalogue: `GET /hospitals/:hospitalId/plans` and `/plans/:planId`. Enrollment, booking, check-in, insurance and rich directory data remain unavailable. | PARTIAL_ADAPTER_REQUIRED |
| `Wellness Hub`; practitioner profile; `Send Booking Request`; engagements/session actions | `/wellness-hub`, category/practitioner/book/engagement routes | No wellness directory, booking, engagement, or session API. | MISSING |
| Prescriptions; select pharmacy; quotes/refills | `/prescriptions`, detail/select-pharmacy/quotes, `/pharmacy-quotes` | `POST /prescriptions` drafts, `PUT /prescriptions/:id`, `POST /prescriptions/:id/issue`, `GET /prescriptions/patient`, `GET /prescriptions/issued`, `GET /prescriptions/:id`, and `DELETE /prescriptions/:id` implement doctor-issued draft/issue/read/cancel only. Pharmacy selection, quotes, refills, dispensing, and commerce remain pending. | PARTIAL — APPROVED_CTO_SPEC_PENDING_IMPLEMENTATION |
| Prescription requests and quotes | `LIVE_PATIENT_PORTAL` + `CTO_PRODUCT_DECISION` | Quote responses include `quoteExpiresAt` exactly 24 hours after issue; comparison excludes expired quotes. A future patient-selection/reservation response will include `reservationExpiresAt` exactly 20 minutes after creating a stock hold. Expired quotes cannot be selected; expired reservations release stock automatically. | IMPLEMENTED |
| Quote reservability | `CTO_PRODUCT_DECISION` | Patient quote items expose `reservable: boolean` and `reservableReason`. Legacy quote items without an immutable inventory reference remain viewable but return `reservable: false` with `LEGACY_QUOTE_NOT_RESERVABLE`; internal inventory identifiers and stock data are never returned to patients. | IMPLEMENTED |
| Reservation creation, active/detail reads, and release | `CTO_PRODUCT_DECISION` | `POST /reservations` accepts `{ prescriptionId, idempotencyKey, allocations[] }`; every allocation supplies `prescriptionItemId`, `quoteItemId`, and `selectedQuantity`. The same patient/idempotency key safely returns the existing reservation without another stock hold. `GET /reservations/active`, `GET /reservations/:id`, and `DELETE /reservations/:id` are patient-owner scoped. Responses include `reservationExpiresAt` and immutable price snapshots only. Allocations across active reservable quote lines must exactly cover every prescribed item; Phase 1 forbids partial prescription checkout. Holds expire exactly 20 minutes after creation and explicit release/expiry restores stock once. The expiry runner is process-local and supported only for a single backend instance; horizontal scaling requires a shared scheduler/worker plus distributed locking. | IMPLEMENTED |
| Checkout pricing, order creation, and order reads | `CTO_PRODUCT_DECISION` | Super Admins use `GET`/`PUT /checkout-pricing/admin` to view or create a versioned NGN pricing configuration: `platformFeeMinor`, `deliveryRatePerKmMinor`, `currency`, `version`, and `effectiveAt`. Default delivery rate is ₦600/km (`60000` minor units); default platform fee is `0` minor units. Patients call `POST /checkout-pricing/preview/reservations/:id` with `{ fulfilments: [{ pharmacyId, fulfilmentMethod: 'PICKUP' | 'DELIVERY' }], deliveryCoordinates? }`. Preview returns per-pharmacy snapshot subtotals, `deliveryFeeMinor`, `platformFeeMinor`, `totalPayableMinor`, and the pricing configuration version. `POST /orders` converts one active reservation into one idempotent parent order using `{ reservationId, idempotencyKey, fulfilments, delivery? }`; `GET /orders` and `GET /orders/:id` are patient-owner scoped. Orders snapshot the pricing-config version, platform fee, delivery rate, pharmacy subtotal, delivery/pickup fee, allocation price/quantity, and total. Pickup delivery fee is `0`. Delivery requires recipient name, phone, address, and coordinates and is rejected unless `ORDER_DELIVERY_ENCRYPTION_KEY` is configured; these details are encrypted at rest and omitted from ordinary order responses. Orders begin `PENDING_PAYMENT`; fulfilments begin `AWAITING_PAYMENT`. No Paystack call, dispensing, or delivery assignment is created. | IMPLEMENTED |
| Paystack payment initialization and payment status | `CTO_PRODUCT_DECISION` | Patient-only `POST /orders/:id/payment/initialize` accepts only an idempotency key. The server uses immutable order totals in NGN, reuses a pending attempt/reference on retry, and returns only the Paystack authorization URL/access code/reference and safe payment status. `GET /orders/:id/payment` is owner scoped. `POST /payments/paystack/webhook` requires Paystack's raw-body `x-paystack-signature` HMAC-SHA512 signature. Signed `charge.success` marks the order `PAID` and fulfilments `AWAITING_PHARMACIST_REVIEW`; signed failed/cancelled/expired events mark payment/order failure and release the converted reservation hold once. | IMPLEMENTED |
| Pharmacy fulfilment verification and preparation | `CTO_PRODUCT_DECISION` | Active, verified pharmacist staff use `GET /fulfilments`, `GET /fulfilments/:id`, `POST /fulfilments/:id/decision`, and `POST /fulfilments/:id/preparation`. Patient-visible states include `APPROVED_FOR_DISPENSING`, `PREPARING`, and `READY_FOR_PICKUP`, as well as bounded safe `CLARIFICATION_REQUIRED`, `REJECTED`, and `UNABLE_TO_FULFILL` messages. Preparation transitions are only `APPROVED_FOR_DISPENSING → PREPARING → READY_FOR_PICKUP`. At `READY_FOR_PICKUP`, the original hold is committed exactly once and recorded with `inventoryFinalizedAt`; stock is not released by a later expiry path. Terminal rejection/unable decisions release only that fulfilment allocation hold once and create an internal `PENDING_REVIEW` refund case. `PENDING_REVIEW` requires Finance/Admin action and never automatically calls Paystack or issues a refund. | IMPLEMENTED |
| Pharmacy market; cart; checkout; confirmation; emergency meds | `/pharmacy-market`, detail/subroutes, `/cart`, `/checkout`, `/order-confirmation/:orderId` | No commerce/stock/payment API. | MISSING — DEFERRED_PRODUCT_DECISION |
| `Track Delivery` | `/delivery-tracking`, `/delivery-tracking/:orderId` | Patient-owned `GET /delivery/orders/:id/tracking` returns parent tracking state, per-pharmacy fulfilment states and timestamped locations. See delivery contract below. | IMPLEMENTED |
| `Insurance is coming to Sabi Health`; `Notify me when it's ready` | `/insurance` | Coming-soon local UI. | NO_BACKEND_NEEDED |
| Navigation-only back buttons, search fields, view toggles, local tabs/filter pills, empty cards | Across routes | No persistence implied without a paired action above. | NO_BACKEND_NEEDED |

### Existing backend capability not evidenced by the inspected design

| Existing capability | Reconciliation |
| --- | --- |
| Notification endpoints | EXTRA_NOT_IN_DESIGN — no dedicated notification screen/route/action was found in the deployed route table. |
| `GET /health-metrics` and score-history endpoint | EXTRA_NOT_IN_DESIGN — vital history is visible; a distinct health-score-history route is not. |
| `GET /medical-records/emergency-summary` | EXTRA_NOT_IN_DESIGN — the design has Emergency ID/Card, but no separate records emergency-summary route. `/profile/emergency-summary` is closer. |
| `GET /dashboard/records-stats` | EXTRA_NOT_IN_DESIGN — record totals are visible, but no independently visible API action was found; retain as internal BFF only pending client mapping. |
| Family-care invitation schema and access-check endpoint | Family-circle foundation extends these same relationships; no parallel membership/access model. |

### Reconciliation decisions needed before another feature slice

- Approve concrete contracts for partner facilities, dependent/family-circle
  membership, caregiver registration, wellness, and role onboarding.
- Use the implemented pharmacy, prescription, quote, reservation, checkout,
  payment, fulfilment and delivery contracts documented here. Unimplemented
  extensions still require an explicit product decision.
- Agree an adapter or frontend change for the reset-password and vital API path
  mismatches before declaring those current backend routes client-integrated.

### Complete deployed route manifest (grouped reconciliation)

| Deployed paths not separately expanded above | Reconciliation |
| --- | --- |
| `/`, `/auth`, `/verify`, `/success`, `/submitted` | Authentication/verification presentation states; `PARTIAL` because only patient auth is implemented and the live verification flow has no approved API mapping. |
| `/doctor`, `/doctors` | `MISSING` professional directory/doctor dashboard. |
| `/reports/:id` | `MISSING — DEFERRED_PRODUCT_DECISION` because the visible flow includes document/report handling. |
| `/pharmacy-market/:pharmacyId`, `/pharmacy-market/prescription`, `/pharmacy-market/refill`, `/pharmacy-market/repeat-last-order`, `/pharmacy-market/emergency-meds` | `MISSING — DEFERRED_PRODUCT_DECISION` commerce/dispensing flows. |
| `/prescriptions/:id`, `/prescriptions/:id/select-pharmacy`, `/prescriptions/:id/quotes` | `MISSING — DEFERRED_PRODUCT_DECISION` prescription/quote flows. |
| `/family/add/success` | `NO_BACKEND_NEEDED` success presentation; navigate only after a successful member invitation, dependent creation, or pending join response. |
| `/hospitals/:id` | `GET /organisations/:id`: verified-only name/location/contact detail. Rich facility content and clinical actions remain unavailable. |
| `/wellness-hub/:categoryId`, `/wellness-hub/:categoryId/:practitionerId`, `/wellness-hub/:categoryId/:practitionerId/book`, `/wellness-hub/engagements`, `/wellness-hub/engagements/:engagementId` | `MISSING` wellness discovery, booking, and engagement APIs. |

### Requirement-source legend

| Requirement | Source |
| --- | --- |
| Visible labels, paths, navigation, filters, empty states, role screens, and route manifest | `LIVE_PATIENT_PORTAL` |
| Prescription issuance/review, external upload controls, inventory/quote/order/payment/fulfilment/delivery behaviour and roles | `CTO_PRODUCT_DECISION` |
| Visible prescription/pharmacy/cart/checkout/delivery/upload requirements now approved to build | `LIVE_PATIENT_PORTAL` + `CTO_PRODUCT_DECISION` |
| Password reset mismatch: frontend `/forgot-password`, `/reset-password/:uid/:token`; backend `POST /auth/password-reset/request`, `POST /auth/password-reset/confirm` | `LIVE_PATIENT_PORTAL` + current backend inventory |
| Vital mismatch: frontend `/api/vital-records`; backend `GET/POST /api/v1/vitals` | `LIVE_PATIENT_PORTAL` + current backend inventory |

### Professional verification deployment requirement

`POST /professionals/register` can create only a `PROFESSIONAL` in `PENDING`
status. It cannot accept a Super Admin role or a verification status. A
`SUPER_ADMIN` must be provisioned through a controlled, audited deployment or
operations procedure (for example, a one-time privileged database migration/run
book with dual approval); no public bootstrap endpoint exists. Only that role
may use the professional verification decision endpoints.

### Professional registration type mapping

The visible frontend route is `/signup/professional/:type`; the current backend
adapter is `POST /api/v1/professionals/register` with a `professionType` body
field. The frontend must map its display choices exactly as follows:

| Visible frontend label | Canonical API `professionType` |
| --- | --- |
| Doctor | `DOCTOR` |
| Nurse | `NURSE` |
| Dentist | `DENTIST` |
| Dermatologist | `DERMATOLOGIST` |
| Psychiatrist | `PSYCHIATRIST` |
| Psychologist | `PSYCHOLOGIST` |
| Physiotherapist | `PHYSIOTHERAPIST` |
| Pharmacist | `PHARMACIST` |
| Nutritionist / Dietitian | `NUTRITIONIST_DIETITIAN` |
| Optometrist | `OPTOMETRIST` |
| Midwife | `MIDWIFE` |
| Other Healthcare Professional | `OTHER_HEALTHCARE_PROFESSIONAL` |

`THERAPIST` is not a public API value. A frontend therapist-like choice must use
the visible `Other Healthcare Professional` label and canonical value above.


### Delivery assignment and patient tracking (implemented)

All paths below are relative to `/api/v1/delivery` and require an access token
in `Authorization: Bearer <token>`. Authorization uses current database roles
and partner activation, not client-supplied roles. Responses use
`{ "status": "success", "data": ... }`; successful operations return HTTP 200.
IDs are UUIDs. Request bodies and query parameters reject unknown fields.

| Method/path | Authorized actor | Body / response |
| --- | --- | --- |
| `PUT /operations/partners/:id` | Super Admin only | `:id` is an existing user ID. Body `{ displayName, isActive }`, with a trimmed 2-120 character name and boolean activation. Atomically grants `DELIVERY_PARTNER` and creates/updates the profile. Returns `{ id, userId, displayName, isActive }`; profile `id` is the assignment `partnerId`. |
| `GET /partners?limit=50&offset=0` | Pharmacy Admin | Active configured partner choices: `[{ id, displayName }]`. |
| `POST /fulfilments/:id/assignment` | Owning Pharmacy Admin | `{ partnerId }`. Requires `DELIVERY` method, paid order, committed inventory and `READY_FOR_PICKUP`, with no pending/accepted/completed assignment. Returns assignment ID, fulfilment ID, `status: PENDING`, and lifecycle timestamps. |
| `GET /assignments?limit=50&offset=0` | Active Delivery Partner | Only own pending/accepted assignments, oldest first. Each entry has `id`, `fulfilmentId`, `assignmentStatus`, `fulfilmentStatus`, order `reference`, `pickup: { id, name, address, contactPhone }`, and lifecycle timestamps. No recipient data in queue. |
| `GET /assignments/:id` | Active assigned Delivery Partner | Queue fields plus `recipient: { recipientName, recipientPhone, address }` for pending/accepted assignments. Completed assignment detail retains status/timestamps without recipient data. Rejected assignments are inaccessible. |
| `POST /assignments/:id/accept` | Active assigned Delivery Partner | Empty body `{}`; pending only. Returns `{ id, assignmentStatus: ACCEPTED, fulfilmentStatus: READY_FOR_PICKUP }`. |
| `POST /assignments/:id/reject` | Active assigned Delivery Partner | `{ reason }`, trimmed 1-300 characters; pending only. Returns `{ id, assignmentStatus: REJECTED, fulfilmentStatus: READY_FOR_PICKUP }`. |
| `POST /assignments/:id/status` | Active assigned Delivery Partner | `{ status: "PICKED_UP" \| "OUT_FOR_DELIVERY" \| "DELIVERED" }`; accepted only, exact forward sequence. Returns `{ id, assignmentStatus, fulfilmentStatus }`. Delivery completion changes assignment status to `COMPLETED`. |
| `POST /assignments/:id/locations` | Active assigned Delivery Partner | `{ latitude, longitude }`; finite numbers in [-90,90] and [-180,180]. Only accepted assignments at `PICKED_UP` or `OUT_FOR_DELIVERY`. Returns `{ id, latitude, longitude, recordedAt }`. Timestamp is generated by the server; client timestamps are rejected. |
| `GET /orders/:id/tracking` | Owning Patient | Parent `{ id, reference, status, trackingStatus, fulfilments[] }`. Every fulfilment includes `{ id, status, fulfilmentMethod, pharmacy: { id, name }, deliveryAssignments[] }`. Current assignment includes `id`, `fulfilmentId`, `status`, lifecycle timestamps and `trackingPoints: [{ latitude, longitude, recordedAt }]`, latest 100 points newest first. Rejected assignment history/reasons and unrelated order locations are omitted. |

`limit` is 1-100 and `offset` is 0-100000; both must be integers. Only the two
list endpoints accept these query parameters. Assignment timestamps are
`assignedAt`, `respondedAt`, `pickedUpAt`, `outForDeliveryAt`, and `deliveredAt`;
not-yet-reached lifecycle timestamps are null. Clients can poll the tracking
endpoint for updates; there is no external map/provider integration.

The assignment state machine is `PENDING -> ACCEPTED -> COMPLETED`, or
`PENDING -> REJECTED`. Acceptance leaves the fulfilment ready. Rejection also
leaves it `READY_FOR_PICKUP`, immediately assignable to an active partner;
inventory stays committed. A new assignment gets a new ID and rejected
partners lose access. Accepted delivery fulfilments follow exactly:

`READY_FOR_PICKUP -> PICKED_UP -> OUT_FOR_DELIVERY -> DELIVERED`

No skipping, reverse transitions, acceptance replay or post-acceptance rejection
is permitted. A repeated/stale action returns 409; refresh the detail before
retrying. Deactivation or role removal blocks all subsequent partner reads and
actions. Reactivation requires Super Admin operations; automatic reassignment
of accepted deliveries is not supported.

The parent order `status` remains its existing order/payment status (normally
`PAID` during delivery). A separate derived `trackingStatus` uses this precedence:
all fulfilments delivered -> `DELIVERED`; any delivered -> `PARTIALLY_DELIVERED`;
any picked up/out for delivery -> `IN_DELIVERY`; all ready -> `READY_FOR_PICKUP`;
any clarification/rejected/unable -> `ACTION_REQUIRED`; all cancelled ->
`CANCELLED`; otherwise `PROCESSING`. Always render individual pharmacy statuses
alongside the aggregate, especially mixed delivery/pickup orders. Pickup-only
fulfilments do not enter this delivery state machine.

Errors: 400 invalid/extra input; 401 missing, malformed, invalid or expired token;
403 missing current role/inactive partner; 404 missing or inaccessible resource;
409 invalid state, unavailable partner, duplicate assignment or concurrent-write
conflict; 500 generic temporary failure. No database error text or delivery PII
appears in errors. State writes, role configuration and minimal ID-only audits
are transactional; failures roll back together. A database partial unique index
prevents two current assignments to the same fulfilment.

Delivery Partner provisioning is a controlled Super-Admin operations process,
not public signup. Operations verifies the partner and existing account outside
this API, then calls the configuration endpoint using a provisioned Super Admin
account. Do not offer delivery-partner signup or send role/configuration fields
to patient/professional registration. Those registration contracts do not grant
`DELIVERY_PARTNER`. Super Admin bootstrap remains a privileged deployment process.

Deploy the additive `20260914000000_add_delivery_assignments` migration and
regenerate Prisma Client before serving these routes. Retain the existing
32-byte base64 `ORDER_DELIVERY_ENCRYPTION_KEY` used at checkout: assigned detail
responses decrypt the existing authenticated ciphertext only after authorization.
There is no duplicate plaintext recipient store. Missing keys/corrupt ciphertext
fail closed. Queue and patient tracking do not decrypt recipient details.
Delivery responses exclude prescription items/indications, clinical notes,
medical history, pricing, payment details and unrelated pharmacies. Partners
cannot change those resources through this API, and patients cannot change
delivery status. No maps, geocoding, proof uploads, provider integrations or
refund behavior are included.


## Caregiver Registration - live design mapping (2026-09-17)

UI source: deployed [Patient Portal](https://sabi-health-frontend-patient-portal.onrender.com/)
and its `/assets/index-WyNbE8L4.js` bundle, component `Pv`, route
`/signup/caregiver`. Direct deep-link GET currently returns 404 at the host;
the root serves the React route/bundle. This backend change does not deploy or
rewrite the frontend. Use the browser-compatible reference adapter in
`src/modules/caregivers/caregivers.adapter.js` when wiring the frontend.

Visible heading: **Caregiver Registration**. Subtitle: **Manage or assist another
person's healthcare.** Steps, in order: **Account**, **Caregiver Type**,
**Patient Connection**, **Consent**. Navigation is **Change account type** on the
first step, then **Back**; advance with **Save & Continue**, finish with
**Submit** (**Submitting...** while pending). No skip control or optional extra
caregiver fields appear in this flow.

| Step / exact visible label | Canonical backend field | Required / validation |
| --- | --- | --- |
| Account / First Name | `account.firstName` | Required, nonblank; max 100 |
| Account / Last Name | `account.lastName` | Required, nonblank; max 100 |
| Account / Email Address | `account.email` | Required; visible email pattern (nonspace text before/after @ and a dot); max 320; trimmed/lowercased |
| Account / Phone Number | `account.phone` | Required, nonblank; max 50. Hint: Include country code, e.g. +234 801 234 5678. Spaces are accepted; the bundle imposes no phone regex. |
| Account / Date of Birth | `account.dateOfBirth` | Required ISO date (`YYYY-MM-DD`); no additional age restriction |
| Account / State | `account.state` | Required, nonblank; max 120 |
| Account / City | `account.city` | Required, nonblank; max 120 |
| Account / Country | `account.country` | Required; Nigeria (visible default), Ghana, Kenya, South Africa, United Kingdom, United States, Other |
| Account / Password | `account.password` | Required: 8+ characters, 1 uppercase letter, 1 lowercase letter, 1 number, 1 special character. Server max 128. |
| Account / Confirm Password | `account.confirmPassword` | Required, matches password; never persisted |
| Caregiver Type / What's your relationship to the person you'll be caring for? | `caregiverType` | Required exact choice: Parent, Guardian, Spouse, Child, Sibling, Relative, Professional caregiver, Legal representative, Other |
| Patient Connection / Relationship to Patient | `connection.relationship` | Required nonblank free text, max 200; placeholder: e.g. Mother, Home nurse, Legal guardian |
| Patient Connection / Invite patient | `connection.mode: "invite"` | Visible default selection |
| Patient Connection / Patient's Email or Phone Number | `connection.inviteContact` | Required only for invite mode; nonblank, max 320; no stricter email/phone regex in the bundle |
| Patient Connection / Connect to existing patient | `connection.mode: "connect"` | Alternative selection |
| Patient Connection / Patient's Sabi Health ID or Email | `connection.patientReference` | Required only for connect mode; nonblank, max 320. Adapter renames the frontend's `connection.patientId` to this non-authoritative reference. |
| Consent / I agree to Sabi Health Terms & Conditions. | `consent.terms` | Must be true |
| Consent / I acknowledge the Privacy Policy. | `consent.privacy` | Must be true |

Length caps and whitespace rejection are server safety bounds, not extra UI
fields. The inactive connection input is omitted. No licence, verification,
organisation, dependent, calendar or medical field is required. Selecting
**Professional caregiver** assigns only `CAREGIVER`, never `PROFESSIONAL`.

### Adapter and responses

Replace the live generic `wv(...)` call to `POST /api/auth/register` with:

```js
const result = await submitCaregiverRegistration({
  account, caregiverType, connection, consent: { terms, privacy },
});
// Only after HTTP 201: navigate to /submitted with the existing presentation state.
```

The helper sends **POST `/api/v1/auth/register/caregiver`**. Example canonical body:

```json
{
  "account": {
    "firstName": "Ada", "lastName": "Care", "email": "ada@example.test",
    "phone": "+234 801 234 5678", "dateOfBirth": "1990-01-01",
    "country": "Nigeria", "state": "Lagos", "city": "Ikeja",
    "password": "StrongPass1!", "confirmPassword": "StrongPass1!"
  },
  "caregiverType": "Parent",
  "connection": { "mode": "connect", "relationship": "Mother", "patientReference": "#SHM12345" },
  "consent": { "terms": true, "privacy": true }
}
```

Do not forward the live helper's generated `accountType`, consent `version` or
`timestamp`; endpoint selection fixes the role, and the server records version
`1.0` and both acceptance timestamps. Do not use the bundle's localStorage
fallback (`sabi-pending-registration-caregiver`): it stores passwords and treats
failed requests as completion. The provided adapter surfaces errors and never
stores the form locally.

HTTP 201 returns `{ status: "success", user: { id, email, roles: ["CAREGIVER"],
caregiverProfile }, onboarding: { status: "AWAITING_PATIENT_INVITATION",
linkedPatients: [] } }`. Signup does not authenticate automatically. Use existing
`POST /api/v1/auth/login` with email/password; its access/refresh tokens work for
`GET /api/v1/auth/me`, which now includes `caregiverProfile` for this account.
Neither response includes the password hash or confirmation. Login still uses
the existing exact email lookup; submit the normalized signup email.

`GET /api/v1/caregivers/me` requires a current `CAREGIVER` role and profile and
returns `{ status: "success", data: { user, onboarding } }`. This owner-only user
projection includes account identity, phone, date of birth and caregiver profile.
The profile contains first/last names, country/state/city, caregiver type,
connection mode/reference/relationship, server consent timestamps/version and
creation timestamp. It contains no patient record or resolved patient identity.

The onboarding state is derived from existing relationships: no active,
unrevoked relationship with nonempty permissions returns
`AWAITING_PATIENT_INVITATION` and `linkedPatients: []`. Otherwise it returns
`LINKED` and `linkedPatients: [{ id, patientId, permissions }]`. Pending/declined/
expired/revoked invitations and permission-free relationships grant no access.
These are relationship identifiers and allowed permission names, not clinical
records. Revocation and permission removal are reflected on the next read.

### Patient approval boundary

The visible connection hints promise an invitation/approval request. In this
scoped backend implementation, both inputs are stored only as the caregiver's
stated connection intent; no patient is looked up, no message is sent, and no
relationship is created. The submitted screen must show awaiting a patient-issued
invitation, not claim an invitation was sent or access approved. Its existing
presentation flags (`needsVerification: false`, `caregiverPendingApproval: true`)
are not authorization or verification fields.

A user with the `PATIENT` role must issue `POST /api/v1/family-care/invitations`
with the caregiver email and explicit existing permissions. The logged-in
caregiver accepts using `POST /api/v1/family-care/invitations/accept` with the
patient-issued token. Registration does not consume or auto-accept pending
invitations. Email matching, pending state and invitation expiry checks still
apply. Patients alone control their own relationship permissions and revocation;
the access query also excludes revoked relationships. No new patient-data read
endpoint or delegation is introduced by signup. Existing owner-only patient data
routes remain owner scoped. The invitation expiry is an acceptance deadline;
it does not impose a new lifetime on an accepted relationship.

Strict schemas reject unknown keys at every level, including client `role`,
`roles`, `SUPER_ADMIN`, `verificationStatus`, `patientId`, relationship permissions,
caregiver IDs and onboarding state. The sole visible patient-ID control is renamed
by the adapter before submission; it cannot override any account/relationship ID.
The existing non-null `User.patientId` column gets a server-generated `CG-<uuid>`
internal identifier; this creates no patient role or patient health profile.

Errors: 400 invalid/missing/unknown input with field paths; 409 duplicate account;
429 registration throttled (five attempts per IP per 15 minutes, even if email
changes); 500 generic safe database failure. Protected reads also return 401 for
missing/invalid/expired tokens and 403 without the caregiver role/profile.
Rate limiting uses the existing single-instance in-memory store and restarts
reset its counters. Registration is one atomic nested Prisma user/profile/role
write; no partial account is returned on failure.

Deploy additive migration `20260917000000_add_caregiver_registration` and
regenerate Prisma Client. This slice adds only `CAREGIVER` and its onboarding
profile. No dependent profiles, join code/QR, family member operations, care
calendar, professional registration, or commerce changes are included.


## Family & Care Circle foundation - live design mapping (2026-09-17)

Source: deployed Patient Portal root and `/assets/index-WyNbE8L4.js` at
`https://sabi-health-frontend-patient-portal.onrender.com/`, components `hC`
(circle), `bC` (add/join), `CC` (dependent), `JC` (member). All endpoints below
are relative to **`/api/v1/family-care`** and require a bearer access token.
This is a backend foundation with frontend adapter mapping; the deployed
bundle's demo/local-state helpers must be replaced. No frontend deployment is
performed here.

| Live route/control | Exact backend mapping | Result / authority |
| --- | --- | --- |
| `/family` / Family & Care Circle; Members; Circles You've Joined | `GET /circle` | `{ members: [], dependents: [], joinedCircles: [], empty: true }` for an empty account. Members are the patient's own relationship records. Joined circles contain only the caller's own relationship, never a foreign roster. Dependents contains only owned basic profile summaries. |
| `/family/add` / Add New Member; Add a member to my circle; 1. By Sabi Health Patient ID; Send Request | `POST /members` | `{ method: "patientId", patientReference, relationship, permissionLevel, permissions }`. Reference and relationship required; creates a pending invitation addressed to that account, not patient-data access. |
| `/family/add` / 2. Via Email; Send Invite | `POST /members` | `{ method: "email", email, permissionLevel, permissions }`. No non-visible name/relationship input required for this method. |
| `/family` / Invite to Care Circle; `/family/add` / 3. QR Code; Generate QR Code | `POST /join-links` | `{ permissionLevel }`; returns `{ id, token, qrPayload, expiresAt }`. Frontend encodes `qrPayload` as QR and can implement Save Image locally. |
| `/family/add` / Join a Family Circle; Join someone else's family circle; Scan a QR Code / Start Scanning; Enter Invite Code / Look Up Code | `POST /join/lookup` | `{ token }` from the scanner or typed input. Returns only `{ name: "Family Circle", ownerName, expiresAt }` for Circle Found. No foreign member count/list, profile, permissions or dependent details. |
| `/family/add` / Request to Join as [level] | `POST /join` | `{ token, permissionLevel, requestedPermissions }`. Returns `{ id, status: "PENDING", permissions: [] }`. Requested permissions never activate themselves. |
| Patient approval of a pending join request | `POST /members/:id/approve` | `{ permissions }`, owner with PATIENT role only. Returns `{ id, status: "ACTIVE", permissions }`. Required security step for the existing pending-admin-approval state, not a new circle-owner role. |
| Recipient acceptance/decline of a direct invitation | Existing `POST /invitations/accept` or `/invitations/decline` | `{ token }`; only matching recipient email can respond. Acceptance uses only patient-issued permissions. |
| `/family/add/dependent` / Setup Dependent Profile / Create Profile | `POST /dependents` | Profile fields below. Only Full Name is required. Owner must hold PATIENT role. |
| `/family/member/:memberId` / dependent Overview | `GET /dependents/:id` | Owner gets the saved profile; explicitly selected eligible co-manager gets only basic identity. |
| Dependent profile editing/removal | `PATCH /dependents/:id`; `DELETE /dependents/:id` | Owner-only update of the same fields or removal. There is no separate visible dependent-edit route; use the same form/detail adapter. |
| `/family/member/:memberId` / account member profile | `GET /members/:id` | Owner-only minimal relationship profile, name/email, safe status and permissions; never the invitee's medical history or health indicators. |
| `/family/member/:memberId?tab=permissions` / Permissions | Existing `PATCH /:id/permissions` | `{ permissions }`, scoped to the owning patient. Use the relationship ID, not an account ID. |
| `/family` / Remove member; Cancel Request | `DELETE /members/:id` | Owner-only revocation; preserves relationship history and clears usable permissions/token. |
| `/family/add/success` | No endpoint | Navigate only after API success. Show requested/pending approval, not active access, for a join request. |

### Add/join steps and permission mapping

The visible selector is **What would you like to do?**. Both choices start with
permission selection, then **Continue with [level] Access** leads to the method
step. Back labels are **Back to Permission** and **Back to Circles**.
Add uses **1. Select Permission Level**; join uses **1. Select the Access You're
Requesting**. Levels are `owner` (Owner), `care-manager` (Care Manager),
`caregiver` (Caregiver), `viewer` (Viewer), `emergency-only` (Emergency Only).
`permissionLevel` is a display/request label, never a role or ownership grant.
Even selecting Owner cannot change the patient who controls the circle.

Granular controls visible in the design are Medical Records, Prescriptions,
Appointments, Vitals, Laboratory Results, Messaging and Health Wallet. For this
foundation, map supported toggles explicitly: `medicalRecords -> RECORDS`,
`appointments -> APPOINTMENTS`, `vitals -> VITALS`. Existing `PROFILE`,
`MEDICATIONS` and `EMERGENCY_SUMMARY` permissions remain supported by the shared
permission API, but do not map Prescriptions to MEDICATIONS or Health Wallet to
payment access. Prescriptions, Laboratory Results as a separate permission,
Messaging and Health Wallet controls remain unavailable in this slice; no new
permissions or data endpoints are invented for them. No clinical access may be
inferred from a label/preset. Direct Emergency Only invitations start with no
permissions because emergency activation is not implemented. Explicit patient
permission updates/approval are the only grants.

Patient-ID method uses the visible placeholder **Patient ID, e.g. #S-2940**
and **Select Relationship** choices: Spouse, Mother, Father, Son, Daughter,
Sister, Brother, Grandparent, Guardian, Other. `patientReference` is looked up
only to address an invitation; it cannot set the owning `patientId` or reveal
the target's medical profile. Full Name exists in demo state but is not a visible
input for this method and is not required by the backend.

The email method's placeholder is **example@email.com**. Direct invitation
responses are `{ member, token, delivery: "MANUAL_SHARE_REQUIRED" }`. The existing
email delivery seam has no configured production provider; do not show "email
sent". The authenticated owner can securely share the returned token. Raw tokens
appear only in successful creation responses, never in subsequent lists/details,
audits or database storage. Membership profile access never grants the owner
reverse access to an invited account's clinical information.

### Secure join mechanism

The demo **OKAFOR-7721** code and fake scanning/lookup must be replaced by the
returned 64-character lowercase hexadecimal token. QR and typed input use exactly
the same 256-bit random token, SHA-256 hash, seven-day expiry and existing
`CareRelationship` record. No separate circle membership/permission table or
weaker short-code namespace exists. Token lookup/join require authentication and
are limited to 20 combined attempts per IP per 15 minutes.

An open QR invitation carries no recipient or usable permissions. First valid
join binds it to the authenticated account, consumes the token, records requested
permissions, and remains PENDING. The owner must approve before it becomes ACTIVE.
The token cannot be replayed by the same or a different account. Owner approval
also checks expiry; a late pending request needs a fresh invitation. Direct
recipient-bound invitations can still use the original accept/decline routes.
An accept compare-and-set prevents stale acceptance from reviving a revoked
relationship. Active relationships do not expire when the original acceptance
deadline passes; the patient controls subsequent access through permissions and
revocation.

### Dependent profile fields

**Setup Profile** follows **Adding someone without a smartphone?**. The dependent
screen is **Setup Dependent Profile**, ending with **Cancel** / **Create Profile**.
It has no required login, email, password, independent patient ID or access token.
A dependent is a `DependentProfile` owned by an existing patient, never a User.

| Visible section / field | Backend field | Validation / optionality |
| --- | --- | --- |
| Profile Basics / Full Name | `fullName` | Only required field; trimmed 1-160 characters |
| Nickname (Optional) | `nickname` | Optional/null, max 100 |
| Date of Birth | `dateOfBirth` | Optional/null ISO date |
| Gender | `gender` | Optional/null: Male, Female |
| Clinical Identity / Blood Group | `bloodGroup` | Optional/null; visible buttons A+, A-, B+, B-, plus the bundle's initial O+ value. No server default. |
| Known Allergies | `allergies` | Optional array, max 50 nonblank entries of max 120 characters; split the visible comma-separated textarea |
| Chronic Conditions / Add condition | `conditions` | Optional array with the same bounds; do not manufacture the demo Asthma value |
| Genotype | `genotype` | Optional/null: AA, AS, SS, AC, SC; no server default |
| Specialized Care Needs / Child or Elderly | `careType` | Optional/null: Child, Elderly |
| Immunization Status | `immunizationStatus` | Optional/null: Up to date, Partially complete, Not started |
| Pediatric Milestones / Mobility & Safety | `milestones` | Optional list from Smiling & Cooing, Rolling Over, Sitting Unassisted, Independent Mobility, Uses Walking Aid, Fall Risk Assessment Done |
| Growth Tracking (Weight/Height) / Kg, Cm | `weightKg`, `heightCm` | Optional/null finite positive numbers, capped at 1000 kg / 400 cm as input bounds |
| Primary Care Details / Primary Physician | `primaryPhysician` | Optional/null, max 200 |
| Insurance Provider; Policy Number | `insuranceProvider`, `policyNumber` | Optional/null, max 200 / 100; profile text only, no insurance/enrollment integration |
| Care Coordination / Select circle members who should also manage this profile. | `coManagerIds` | Optional array of up to 30 unique existing relationship IDs from this patient's circle, each ACTIVE, unrevoked and explicitly granted PROFILE |

All optional text inputs may be omitted or set to null; the adapter must convert
blank controls to omission/null. PATCH supports the same fields, requires at least
one supplied field, and clears optional fields with null or lists with `[]`.
Persist only values intentionally submitted; no demo condition, blood group,
milestone or co-manager is assumed by the server. The visible Profile Photo widget
has no working input in this bundle; photo uploads are not added. Capture currently
unbound growth/immunization controls in the frontend adapter if submitted.

Care Coordination does not confer ownership or edit rights. The owner explicitly
selects a relationship already bearing PROFILE permission. A read checks that same
relationship's current active state and permission every time and returns only
`id`, `fullName`, `nickname`, `dateOfBirth`, `gender`, `careType`. The co-manager
cannot read clinical identity, growth, conditions, insurance, other managers or
other dependents, and cannot create/edit/remove dependents. Revoking/removing the
member or removing PROFILE immediately ends access, even if an old relationship
ID remains in `coManagerIds`. Signup, joining or accepting a generic invitation
without this explicit selection never permits dependent access.

The owner alone receives the full saved profile. Removal deletes profile content
and writes only an ID-based audit; no login account, dependent medical record,
prescription or calendar event is created. Member removal preserves the original
relationship ID and minimal state/timestamps for history, rather than deleting it.

### Status, privacy and errors

Display statuses are `PENDING`, `ACTIVE`, `DECLINED`, `REVOKED`, `EXPIRED` (labels
Pending, Active, Declined, Revoked, Expired). Pending rows past their deadline are
returned as EXPIRED even before an expiry job updates storage; legacy list filters
also respect effective expiry. Never use the demo Stable/Monitoring/Needs Attention
labels as clinical assessments. The empty circle contains no invented self/member
records, health scores, medication counts, activity events or shared orders.

Responses use `{ status: "success", data }`, HTTP 201 for creation and 200 for
reads/updates/removal/join. Writes and minimal audits are transactional. Errors:
400 invalid/unknown fields or ineligible co-manager; 401 token failures;
403 missing patient authority; 404 missing/inaccessible resource or used token;
409 duplicate/current write conflict; 410 expired invitation; 429 join throttling;
500 generic safe failure. Unauthorized lookups never return another circle's
members, dependents, invitations or permission lists. Only the minimal Circle
Found confirmation is available to a valid token holder. GET responses carry no
raw or hashed invitation tokens.

Deploy additive migration `20260917010000_add_family_circle_foundation` and
regenerate Prisma Client. Existing invitation records default to DIRECT. Care
Calendar, dependent medical records/prescriptions, member clinical tabs, hospital
enrollment, wellness, pharmacy, payments and delivery are not implemented here.


## Care Calendar - live read-only mapping (2026-09-17)

Evidence: deployed `/family/care-calendar` in `/assets/index-WyNbE8L4.js`,
components `ew` and `$C`. The visible heading is **Care Calendar**, subtitle
**Everyone in your circle's appointments, at a glance.** The page contains a
**Care Circle** sidebar, **Previous month** / **Next month**, a Monday-first month
grid with event dots, clickable days, **Today's Events** (or a selected-date
heading), and **Upcoming**. **Back to Family Circle** links to `/family`;
sidebar members link to `/family/member/:memberId`. Sidebar clicks navigate;
they are not a visible filtering control. The shared search placeholder is
**Search family, appointments...**, but this component does not implement search.

No week-view toggle, status selector, event create/edit/delete/reschedule,
recurrence, drag/drop, reminder, or external calendar integration appears.
Accordingly this slice adds no writable event model, mutation route or migration.
Appointment ownership and existing appointment routes remain unchanged.

All paths below start with `/api/v1/family-care` and require a bearer access token.

| Frontend control / data | Endpoint / adapter mapping |
| --- | --- |
| `/family/care-calendar`, initial month / Previous month / Next month | `GET /calendar?from=<ISO instant>&to=<ISO instant>`. Compute the displayed month grid, including leading/trailing days, and send its start and exclusive end. |
| Select a day / Today's Events | Filter the returned month events by that local date, or use the same endpoint with that day's start and next day's start. |
| Upcoming | `GET /calendar/upcoming?from=<today's local midnight as ISO instant>&limit=50&offset=0`. Independent of the displayed month, matching the live component. Follow `nextOffset` while `hasMore`. |
| Dependent/member-specific data requested by the integration | Add `memberId=self`, a permitted active relationship UUID, or an eligible dependent UUID to either read endpoint. This is an API scope filter, not a new UI control. |
| A caregiver reading a patient-controlled circle | Add `circlePatientId=<patient UUID>` to either endpoint. Omit it for the authenticated patient's own circle. This is authorization context, not a new visible circle picker. |
| Member sidebar / Back to Family Circle | Existing member-profile and circle navigation; no new calendar mutation. |

`from`/`to` require ISO timestamps with explicit UTC offset or Z. Bounds are
inclusive `from`, exclusive `to`; adjacent days/months do not duplicate boundary
events. The month/day range must be positive and at most 43 elapsed days (covers
a 42-day display grid across daylight-saving changes). No `month`, `week`, `view`,
`status`, search, arbitrary patient ID or permission query fields are accepted.
There is no status filter in the live design: SCHEDULED, CANCELLED and COMPLETED
source appointments are returned as stored. Clients must not invent status
changes. Upcoming accepts only `from`, the scope fields, `limit` (1-100, default
50) and `offset` (0-100000, default 0). Send the frontend's local-midnight instant;
the backend does not guess browser timezone. Render event times in that same
frontend timezone.

Success is HTTP 200 with `{ status: "success", data: { members, events, from,
to?, empty, hasMore?, nextOffset? } }`. Range reads include `to`; Upcoming includes
`hasMore` and `nextOffset` (null on the last page). Members have `{ id, kind,
name, relationship, calendarAvailable }`, with kind PATIENT, MEMBER or DEPENDENT.
`self` denotes the selected circle's patient, not an arbitrary foreign account.
Each event contains only `{ id, memberId, memberName, title, time, status }`.
`title` is the existing appointment's doctor name (the live `$C` projection uses
the doctor as title), falling back to `Appointment`; it never copies the free-text
appointment reason/title. No type, email, clinical indication, record, medication,
prescription, payment, or delivery data is projected. Events are ordered by
appointment time then ID. The event ID remains the source appointment ID and
confers no new write access.

No events returns `events: []` and `empty: true`, even when eligible members exist.
Use the exact visible labels **No events for this day.** and **No upcoming events
across your care circle.** Member initials, colors, date headings and dots are
presentation derived from returned safe identity/event fields; no demo events,
health scores or names are synthesized.

### Calendar authorization and source limitations

Own-circle reads require the current PATIENT role. They include the owner's
appointments. An ACTIVE, unrevoked member can contribute appointments only if
that member has independently issued the viewer an ACTIVE, unrevoked relationship
with APPOINTMENTS permission. The owner's outgoing invitation grants access to
the owner's data; it does not grant reciprocal access to the invitee's data.
Unapproved or non-consenting members are omitted from the calendar sidebar.

Caregiver reads require an ACTIVE, unrevoked relationship from the requested
patient with APPOINTMENTS permission. They include only that patient's safe
appointment summaries, not other members' appointments/rosters. Dependent identity
is included for a caregiver only when the same relationship also grants PROFILE
and the patient explicitly selected that relationship as a dependent co-manager.
Being a member, being a co-manager, or PROFILE permission alone never grants
calendar access. Every read checks current permissions and revocation within the
same transaction as appointment reads. Unknown/ineligible member filters and
cross-circle requests return 404 without querying unrelated appointments.

The live demo associates booked-for events by member name. The existing backend
Appointment has only `userId` and no stable dependent/other-beneficiary reference.
This read-only feature deliberately does not guess associations by name or assign
all owner appointments to a dependent. Owned/explicitly shared dependent identities
are selectable with `calendarAvailable: false`; their filtered events are empty.
Stable dependent booking association is a remaining booking-flow capability;
adding it requires that flow's design-backed contract and is not silently
introduced through this calendar. No dependent event creation is claimed.

Calendar POST/PATCH/DELETE return 405 (`Allow: GET`); no calendar writes or write
audits occur. Existing appointment changes are reflected on subsequent reads.
Validation failures are 400, missing/invalid/expired access tokens 401, lack of
own-patient authority 403, inaccessible circle/member 404, concurrent permission
conflict 409 and generic database failure 500. Errors disclose no partial event
payload. This completes the visible calendar read surface only; frontend wiring
is still required.


## Organisation onboarding and verification - 2026-09-17

Evidence: live `/signup/organisation/:type`, components `Rv`, `Mv`, `Lv`,
`jv` in `/assets/index-WyNbE8L4.js` on the deployed patient portal.
Backend implementation and a browser-compatible adapter are complete in
`src/modules/organisations/organisations.adapter.js`. This backend repository
does not deploy the frontend; the adapter must replace the demo submission.

### Exact frontend mapping

All endpoints below have prefix `/api/v1`.

| Frontend route / action | Backend mapping | Scope |
| --- | --- | --- |
| `/signup/organisation/hospital` / Hospital Registration / Submit | `POST /organisations/register`, `organisationType: "hospital"` | Creates owner and PENDING HOSPITAL |
| `/signup/organisation/clinic` / Clinic Registration / Submit | Same endpoint, `organisationType: "clinic"` | Creates owner and PENDING CLINIC |
| `/signup/organisation/pharmacy` / Pharmacy Registration / Submit | Same endpoint, `organisationType: "pharmacy"` | Calls existing pharmacy registration core; PHARMACY_ADMIN and PENDING Pharmacy only |
| `/signup/organisation/laboratory` / Laboratory Registration / Submit | Same endpoint, `organisationType: "laboratory"` | Creates owner and PENDING LABORATORY |
| `/signup/organisation/diagnostic-centre` / Diagnostic / Radiology Centre Registration / Submit | Same endpoint, `organisationType: "diagnostic-centre"` | Creates owner and PENDING DIAGNOSTIC_CENTRE |
| `/signup/organisation/other` / Other Healthcare Facility Registration / Submit | Same endpoint, `organisationType: "other"` | Creates owner and PENDING OTHER |
| Save & Continue / Back / Change account type | Local form navigation | No draft or implicit account creation |
| Owner organisation / verification status | `GET /organisations/mine` | Authenticated owner only; no supplied owner ID |
| Existing login / current account | `POST /auth/login`, `GET /auth/me` | Existing sessions; server-issued ORGANISATION_OWNER or PHARMACY_ADMIN role |
| Hospitals / View All Partners / safe facility cards | `GET /organisations?type=hospital&page=1&limit=20&search=Ikeja` | Public, VERIFIED only; name/location search |
| `/hospitals/:id` / safe facility detail | `GET /organisations/:id` | Public, VERIFIED only |
| Pharmacy public listing/detail | Existing `GET /pharmacies`, `GET /pharmacies/:id` | Pharmacy compliance VERIFIED only |

Controlled operations (not invented public-signup fields):

| Operation | Endpoint | Authority |
| --- | --- | --- |
| Review queue | `GET /organisations/admin?status=PENDING&page=1&limit=20&type=hospital` | Current database SUPER_ADMIN role; optional type, default PENDING |
| Review detail / evidence metadata | `GET /organisations/admin/:id` | SUPER_ADMIN, non-pharmacy only |
| Approve / reject / suspend / reactivate | `POST /organisations/admin/:id/approve`, `/reject`, `/suspend`, `/reactivate` | SUPER_ADMIN; strict `{ note?: string }`, 1-500 trimmed characters when present |
| Pharmacy onboarding evidence metadata | `GET /organisations/pharmacy-compliance/:id` | PHARMACY_COMPLIANCE_ADMIN only; ID is existing Pharmacy ID |
| Pharmacy queue and decisions | Existing `GET /pharmacies/compliance`, `POST /pharmacies/compliance/:id/decision` | Existing PHARMACY_COMPLIANCE_ADMIN control remains unchanged |
| Download selected evidence | `GET /organisations/submissions/:id/documents/:key` | Owner, or SUPER_ADMIN for non-pharmacy / PHARMACY_COMPLIANCE_ADMIN for Pharmacy; ID is submission ID |

### Four visible steps and validation

The visible steps are **Organisation**, **Representative**, **Regulatory**,
**Consent**. Submit once, after all four steps pass validation.

- Organisation: `{ organisation: { entityName, legalName, country, state,
  city, address, phone, email, website? } }`. Required labels are
  Hospital/Clinic/Pharmacy/Laboratory/Diagnostic Centre Name (Facility Name for
  Other), Business / Legal Registration Name, Country, State, City,
  Physical Address, Phone Number, Email Address. Country choices: Nigeria,
  Ghana, Kenya, South Africa, United Kingdom, United States, Other.
  Website (if available) is optional and Pharmacy-only. No visible input
  requires `facilityTypeOther`; the adapter drops its empty demo state.
- Representative: `{ representative: { firstName, lastName, phone, email,
  position, password, confirmPassword } }`. All visible inputs are required.
  Labels: First Name, Last Name, Phone Number, Email Address, Position,
  Password, Confirm Password. Password follows all five visible rules:
  8+ characters, uppercase, lowercase, number, special character; confirmation
  must match. Representative email is the login identity; organisation email
  is the facility contact. Registration creates a new account; duplicate
  account email returns 409 and cannot attach someone else's account.
- Regulatory: `{ regulatory: { registrationNumber, regulatoryAuthority },
  documents }`. Registration / Licence Number and Regulatory Authority are
  required. Hospital/Clinic: State Ministry of Health, Federal Ministry of
  Health, Other. Pharmacy: PCN (Pharmacists Council of Nigeria), Other.
  Laboratory: MLSCN (Medical Laboratory Science Council of Nigeria), Other.
  Diagnostic Centre: Radiographers Registration Board of Nigeria, Other.
  Other Healthcare Facility: Other.
- Documents: `businessRegistration` (Business Registration Document) and
  `representativeId` (Government ID of Authorised Representative) are required.
  `facilityLicense` (Facility / Practice Licence) is required for Hospital,
  Clinic, Laboratory and Diagnostic Centre; optional for Other (Facility
  Licence (if applicable)). Pharmacy requires `pharmacyLicense` (Pharmacy
  Licence), reusing the existing pharmacy identity and verification system.
- Hospital-only Services Offered is optional `services: []`. Exact options:
  General medicine, Emergency, Surgery, Paediatrics, Maternity, Laboratory,
  Pharmacy, Radiology, Dental, Mental health, Other. These declarations do not
  authorize clinical services.
- Pharmacy-only optional `operatingInfo: { openingHours?, delivery?, pickup? }`.
  Opening Hours choices: `8:00 AM \u2013 6:00 PM`, `8:00 AM \u2013 8:00 PM`,
  `24 hours`, `Custom (set later)` (the first two contain an en dash).
  Delivery available and Pickup available are optional booleans. Empty opening
  hours are accepted. No schedule or delivery workflow is created.
- Consent: `{ consent: { terms: true, privacy: true, healthData?: boolean } }`.
  Terms & Conditions and Privacy Policy acknowledgement are required;
  patient health-information processing consent is optional, matching the
  deployed validator. Version `1.0` and acceptance timestamps are server-set.
  Consent never grants patient-data permissions.

Strings are trimmed and bounded for transport/storage. Emails are validated
and normalized; phones remain nonempty strings with the design's country-code
hint, not a new mandatory phone-format rule. Upper bounds: names 160,
legal name 200, state/city 100, address 500, phone 40, representative names 80,
position/authority 120, registration number 160, email 254, password 128.
Optional website must be HTTP(S), up to 500 characters. Unknown keys are rejected
at every request object level, including role/status/owner/compliance injections.
No staff invite, professional profile, patient link, or clinical permission is
created by signup.

### File adapter and responses

Call `submitOrganisationRegistration` with `{ organisationType, organisation,
representative, regulatory, services?, operatingInfo?, documents, consent }`;
`documents` contains the selected browser File objects. It replaces the live
`POST /api/auth/register` demo call. Do not send `accountType`, `documentNames`,
client consent version/timestamp, or persist the form/password in
`sabi-pending-registration-organisation`. A failed response stays on the form.

Each file maps to `{ name, contentType, base64 }`. PDF/JPEG/PNG only, filename
extension/MIME/signature checked, canonical base64, maximum 5 MiB each, 21 MiB
JSON request ceiling. These are transport safety limits, not additional form
fields. Evidence is stored as private database bytes, not public URLs; owners
and the correct verifier can retrieve it as a no-store attachment. File names,
regulatory numbers, representative contacts, consent and evidence never appear
in public projections. No storage-provider integration or browser preview is
introduced.

Success is 201 `{ status: "success", data: { id, organisationType,
status: "PENDING", verificationAuthority, owner: { id, email, role },
submissionId } }`. No access token or patient access is issued on registration;
use existing login. Owner/detail responses include onboarding metadata and
file names, never password or file bytes. List responses use
`{ status: "success", data: { items: [], total: 0, page: 1, limit: 20 } }`
for an empty result. Paging limit is 1-100 and page 1-10000. Missing owner
organisation returns 404. Malformed input 400, missing/invalid/expired bearer
401, inaccessible or ineligible detail 404, duplicate/state conflict 409,
oversized payload 413, IP rate limit 429, sanitized database failure 500.

### Verification and eligibility

Non-pharmacy state machine:
`PENDING -> VERIFIED` (approve), `PENDING -> REJECTED` (reject),
`REJECTED -> VERIFIED` (approve after review),
`VERIFIED -> SUSPENDED` (suspend), `SUSPENDED -> VERIFIED` (reactivate).
Self-decisions are forbidden, including owners who also hold SUPER_ADMIN.
Every decision rechecks the current database role; JWT role claims alone do
not authorize review. Compare-and-update rejects concurrent stale decisions.
Account, facility, evidence and audit registration writes are transactional;
state changes and their minimal ID-only audits commit together.

Only VERIFIED organisations qualify for public partner listing/detail. Public
fields: ID, type, name, address, country, state, city, contactEmail, contactPhone.
PENDING, REJECTED and SUSPENDED are excluded in database queries, including
by-ID access. Pharmacy eligibility continues to depend exclusively on existing
`Pharmacy.complianceStatus === VERIFIED`; Super Admin organisation actions
cannot approve or suspend a Pharmacy. No second Pharmacy table, owner role or
verification status was added. Shared onboarding evidence has exactly one
facility link, enforced by an additive database check constraint.

Verification does not itself create booking, enrollment or patient-data access.
This slice exposes no organisation booking or clinical mutation endpoint.
Directory type/insurance filters, ratings, insurance acceptance, invented
services, booking, plans, check-in, hospital enrollment, laboratory workflows,
staff invitations and clinical data are not supplied. The frontend must show
only stored safe fields and keep unavailable actions unavailable; it must not
fall back to demo eligibility. Remaining rich-directory controls need their
own verified design-backed slice.


## Hospital member plan catalogue - 2026-09-17

Source: the deployed `/hospitals` (`Mw`) and `/hospitals/:id` (`Nw`)
components in `/assets/index-WyNbE8L4.js`, using the bundle retrieved during
organisation onboarding. The deployed host failed DNS resolution during this
slice, so the documented cached bundle was inspected; no replacement design
or inferred enrollment fields were used.

The detail screen's exact heading is **Enrollment Plans**. Each card displays
`name`, `fee` prefixed with the naira symbol and suffixed **enrollment fee**,
and `description` only when present. The sample names **Standard Plan** and
**Family Plan** are data examples, not fixed plan types or seeded products.
The `/hospitals` screen links to hospital detail; it has no plan-specific
filter. Hospital search/type/insurance controls are not plan filters.

### Fields and lifecycle

| Live card field | API / persistence | Validation |
| --- | --- | --- |
| Plan name (`name`) | `name` | Required, trimmed 1-120 characters |
| Naira enrollment fee (`fee`) | `feeMinor`, integer kobo; response `currency: "NGN"` is server-set | Required JSON integer 0-2147483647; no numeric strings or fractional kobo |
| Conditional description (`description`) | `description` | Optional, nullable, trimmed 0-1000 characters; null/empty hides the card description |

For example, the demo's NGN 15,000 fee maps to `feeMinor: 1500000`.
Amounts remain integers throughout API storage and writes. Conversion to
`feeMinor / 100` occurs only when formatting the existing frontend card.
No recurring period, benefits, insurance, rating, discount, payment, or clinical
field is added. Bundle `type` and `maxMembers` are used by the out-of-scope
enrollment wizard, not rendered as fields on these catalogue routes; they are
not accepted here. Family capacity text can remain in the visible description.

The requested create/archive controls use the minimal lifecycle
`ACTIVE -> ARCHIVED`. Creation is immediately ACTIVE. There is no visible draft
or approval workflow to reproduce. Archived plans remain in the owner's list,
are immutable, and cannot be reactivated; repeated archive is idempotent and
adds no duplicate audit. Visibility also depends on the hospital's current
verification, independent of plan status. Hospital suspension hides all its
plans; re-verification exposes only plans still ACTIVE.

### Exact mapping

All backend paths below have prefix `/api/v1`. Hospital IDs are existing
Organisation UUIDs, not the frontend demo slugs. Owner controls are explicitly
requested backend capabilities; this does not claim the patient portal has an
owner-management form.

| Screen / action | Endpoint | Request / result |
| --- | --- | --- |
| `/hospitals` hospital navigation | Existing `GET /organisations?type=hospital` | Verified hospitals only; no plan-specific filter added |
| `/hospitals/:id` / Enrollment Plans | `GET /hospitals/:hospitalId/plans?limit=20&offset=0` | Public or patient; only ACTIVE plans from this VERIFIED HOSPITAL |
| Safe plan detail | `GET /hospitals/:hospitalId/plans/:planId` | Same visibility and hospital scope; no new frontend route claimed |
| Owner create | `POST /hospitals/:hospitalId/plans` | `{ name, feeMinor, description? }`; 201 |
| Owner catalogue/history | `GET /hospitals/:hospitalId/plans/manage` | Optional `status=ACTIVE` or `ARCHIVED`; default both; same pagination |
| Owner update | `PATCH /hospitals/:hospitalId/plans/:planId` | Nonempty subset of create fields; ACTIVE only |
| Owner archive | `POST /hospitals/:hospitalId/plans/:planId/archive` | Empty body or `{}`; preserves history |

Public objects contain only `{ id, hospitalId, name, description, feeMinor,
currency }`. Owner objects additionally include `status`, `createdAt`,
`updatedAt`, `archivedAt`. Lists return
`{ status: "success", data: { items: [], total: 0, limit: 20, offset: 0 } }`
when the eligible hospital has no matching plans. An unavailable/non-hospital
organisation returns 404, not a misleading successful empty list. Pagination
is bounded to limit 1-100 and offset 0-100000. Unknown body/query/parameter keys
are rejected. Public status/type/insurance/search filters are not supported.

`src/modules/hospital-plans/hospital-plans.adapter.js` supplies
`loadHospitalPlans(hospitalId)` and `toPlanCard(plan)`. Replace `r.plans` in the
existing detail component with this catalogue response. The loader follows
pagination, returns an empty array for an empty catalogue, and propagates
failures without demo/local-storage fallback. Existing `Enroll as Patient`
and `Book Appointment` actions remain unavailable in this slice. No automatic
enrollment, approval, payment or hospital patient ID is created. Frontend
wiring is still required in the separately deployed frontend repository.

### Authorization and persistence

Management requires a current database ORGANISATION_OWNER role AND ownership
of the specified organisation with `type: HOSPITAL`, `status: VERIFIED`.
JWT role claims, Super Admin status, hospital staff or ownership of another
hospital do not substitute. Clinics, laboratories, diagnostic centres, other
facilities and Pharmacy are ineligible. Reads/updates also constrain the
hospital relation in the plan query itself. Transactions use serializable
isolation; serialization conflicts return a safe 409 for reload/retry.

Every create/update/archive and its minimal hospital-ID/plan-ID audit commit
or roll back together. Archive preserves the row. The migration only adds the
plan enum, table, hospital foreign key, index and nonnegative-fee constraint.
No existing organisation or pharmacy verification model changes.

Missing, inaccessible, archived public or cross-hospital plan references use
safe 404 responses. Management without a valid bearer returns 401; invalid
input 400; database failures use a sanitized 500. Public responses are no-store
and check eligibility each time. Owning or publishing a plan grants no patient,
family, medical-record, enrollment, booking, check-in, payment, insurance,
clinical, approval or staff access.
