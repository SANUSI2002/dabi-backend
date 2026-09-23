# Sabi Health Backend API

This is the reviewer-facing reference for the implemented Sabi Health backend.
The exhaustive UI-to-API adapter mapping lives in
[`frontend-endpoint-contract.md`](./frontend-endpoint-contract.md); clinical,
pharmacy, payment and fulfilment policy lives in
[`prescription-commerce-workflow.md`](./prescription-commerce-workflow.md).
The additive central identity and membership contract is documented in
[`identity-api.md`](./identity-api.md).

## Conventions

- Base URL: `/api/v1`; health check: `GET /api/health`.
- Protected routes require `Authorization: Bearer <access-token>`.
- JSON responses use `{ "status": "success", "data": ... }` or a safe error
  response. Validation errors are `400`; unauthenticated requests are `401`;
  hidden/missing resources use safe `404` responses.
- All currency is NGN minor units (kobo). Never send amounts as floating-point
  naira values.
- All mutable resources are owner/role scoped. IDs are UUIDs unless stated
  otherwise. Request bodies reject unknown fields.
- Patient-facing frontend adapters are required for paths whose live-design
  routes differ from the backend paths.

## Authentication and accounts

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/register/patient` | Register a patient account. |
| POST | `/auth/register/caregiver` | Register a caregiver; no patient access is granted automatically. |
| POST | `/auth/login` | Login and receive access/refresh-token data. |
| POST | `/auth/refresh` | Refresh an access token. |
| POST | `/auth/logout` | Revoke a refresh token. |
| GET | `/auth/me` | Current authenticated account. |
| GET | `/auth/organizations` | List caller's organization memberships. |
| POST | `/auth/organizations/switch` | Select a verified organization and receive scoped access token. |
| GET/POST | `/auth/organizations/:organizationId/memberships` | Read or invite staff within selected organization and permission. |
| POST | `/auth/memberships/:id/accept` | Accept own pending membership. |
| POST | `/auth/organizations/:organizationId/memberships/:id/revoke` | Revoke another member within selected organization. |
| GET | `/auth/platform-context` | Read scoped platform roles and permissions. |
| POST | `/auth/password-reset/request` | Non-enumerating reset request. |
| POST | `/auth/password-reset/confirm` | Complete a single-use password reset. |
| POST | `/professionals/register` | Register a professional in `PENDING` verification state. |
| GET | `/professionals/me` | Current professional onboarding/verification state. |
| GET | `/caregivers/me` | Current caregiver onboarding and linked-patient state. |

Professional verification is controlled by Super Admin:
`GET /professionals/admin` and `POST /professionals/admin/:id/{approve|reject|suspend|reactivate}`.

## Patient portal

| Area | Endpoints |
| --- | --- |
| Profile & security | `GET /profile`, `GET /profile/emergency-summary`, `PUT /profile/update`, `PUT /profile/security`, `PUT /profile/security/change-password`, `DELETE /profile/delete-account` |
| Dashboard | `GET /dashboard`, `GET /dashboard/records-stats` |
| Notifications | `GET /notifications`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all` |
| Appointments | `GET/POST /appointments`, `GET/PATCH/DELETE /appointments/:id` |
| Medications | `GET/POST /medications`, `GET/PUT/DELETE /medications/:id`, `PATCH /medications/:id/taken` |
| Vitals & metrics | `GET/POST /vitals`, `GET /health-metrics` |
| Medical records | `GET/POST /medical-records`, `GET/PATCH/DELETE /medical-records/:id`, `GET /medical-records/timeline`, `GET /medical-records/uncategorized`, `PATCH /medical-records/:id/category`, `GET/POST /medical-records/categories`, `PATCH/DELETE /medical-records/categories/:id`, `GET /medical-records/categories/counts`, `GET /medical-records/emergency-summary` |

Medical-record document URLs are metadata only. Binary upload, download,
sharing, PDF generation and document processing are not implemented in this API.

## Family and care circle

All paths below are prefixed with `/family-care`.

| Endpoints | Purpose |
| --- | --- |
| `GET /circle`, `GET /` | Circle/member and relationship views. |
| `POST /members`, `GET/DELETE /members/:id`, `POST /members/:id/approve` | Invite, view, approve or remove a member. |
| `POST /join-links`, `POST /join/lookup`, `POST /join` | Expiring join-link/QR-code flow. |
| `POST /dependents`, `GET/PATCH/DELETE /dependents/:id` | Patient-owned dependent profiles. |
| `POST /invitations`, `POST /invitations/{accept|decline}`, `PATCH /:id/permissions`, `DELETE /:id`, `GET /access/:patientId` | Explicit caregiver permissions and revocation. |
| `GET /calendar`, `GET /calendar/upcoming` | Permission-scoped, read-only Care Calendar. |

## Organisations, hospitals and pharmacies

| Area | Endpoints |
| --- | --- |
| Organisation onboarding | `POST /organisations/register`, `GET /organisations/mine` |
| Verified organisations | `GET /organisations`, `GET /organisations/:id` |
| Organisation verification | `GET /organisations/admin`, `GET /organisations/admin/:id`, `POST /organisations/admin/:id/{approve|reject|suspend|reactivate}` |
| Private onboarding evidence | `GET /organisations/submissions/:id/documents/:key` |
| Pharmacy onboarding/public data | `POST /pharmacies/register`, `GET /pharmacies`, `GET /pharmacies/:id`, `GET /pharmacies/mine` |
| Pharmacy compliance | `GET /pharmacies/compliance`, `POST /pharmacies/compliance/:id/decision` |
| Hospital plans | `GET /hospitals/:hospitalId/plans`, `GET /hospitals/:hospitalId/plans/:planId`, `GET /hospitals/:hospitalId/plans/manage`, `POST /hospitals/:hospitalId/plans`, `PATCH /hospitals/:hospitalId/plans/:planId`, `POST /hospitals/:hospitalId/plans/:planId/archive` |

Only verified organisations and pharmacies appear in public discovery. Hospital
enrollment, booking and check-in are not yet implemented.

## Doctor care and prescriptions

| Area | Endpoints |
| --- | --- |
| Doctor directory/care relationship | `GET /doctor-care/doctors`, `GET /doctor-care/doctors/:id`, `POST /doctor-care/relationships`, `GET /doctor-care/relationships/patient`, `GET /doctor-care/relationships/doctor`, `POST /doctor-care/relationships/:id/{accept|decline}`, `DELETE /doctor-care/relationships/:id` |
| Prescriptions | `POST /prescriptions`, `PUT /prescriptions/:id`, `POST /prescriptions/:id/issue`, `DELETE /prescriptions/:id`, `GET /prescriptions/patient`, `GET /prescriptions/issued`, `GET /prescriptions/:id` |

Prescription issuance requires a verified Doctor and an active patient-doctor
care relationship. A prescription is `DRAFT`, `ISSUED`, or `CANCELLED`; patients
can view only their own issued prescriptions.

## Pharmacy requests, reservations and orders

| Area | Endpoints |
| --- | --- |
| Inventory/discovery | `GET/POST /inventory`, `PUT/DELETE /inventory/:id`, `GET /pharmacies/discovery/prescriptions/:id` |
| Pharmacy staff & requests | `POST /pharmacy-requests/staff/invite`, `POST /pharmacy-requests/staff/:id/accept`, `POST /pharmacy-requests`, `GET /pharmacy-requests/patient`, `GET /pharmacy-requests/pharmacy` |
| Quotations | `POST /pharmacy-requests/:id/quotes`, `GET /pharmacy-requests/quotes/patient` |
| Reservations | `POST /reservations`, `GET /reservations/active`, `GET /reservations/:id`, `DELETE /reservations/:id` |
| Checkout pricing | `POST /checkout-pricing/preview/reservations/:id`, `GET/PUT /checkout-pricing/admin` |
| Orders | `POST /orders`, `GET /orders`, `GET /orders/:id` |

Quote validity is 24 hours. A reservation must completely cover every prescribed
item and expires after 20 minutes. Reservation creation requires an idempotency
key. Inventory holds are process-local expiry managed for the current
single-instance deployment; horizontal scaling requires a shared scheduler.

## Payments, fulfilment and delivery

| Area | Endpoints |
| --- | --- |
| Paystack | `POST /orders/:id/payment/initialize`, `GET /orders/:id/payment`, `POST /payments/paystack/webhook` |
| Pharmacist fulfilment review | `GET /fulfilments`, `GET /fulfilments/:id`, `POST /fulfilments/:id/decision`, `POST /fulfilments/:id/preparation` |
| Delivery operations | `PUT /delivery/operations/partners/:id`, `GET /delivery/partners`, `POST /delivery/fulfilments/:id/assignment` |
| Delivery partner | `GET /delivery/assignments`, `GET /delivery/assignments/:id`, `POST /delivery/assignments/:id/{accept|reject|status|locations}` |
| Patient tracking | `GET /delivery/orders/:id/tracking` |

Paystack requires `PAYSTACK_SECRET_KEY` and an HTTPS webhook at
`/api/v1/payments/paystack/webhook`. Payment success moves each fulfilment to
`AWAITING_PHARMACIST_REVIEW`. Pharmacists can approve, request clarification,
reject, or mark unable to fulfil. The delivery path is
`READY_FOR_PICKUP → PICKED_UP → OUT_FOR_DELIVERY → DELIVERED`.

## Configuration and operational requirements

- `JWT_SECRET` and `JWT_REFRESH_SECRET`
- `RATE_LIMIT_KEY_SECRET`, plus either `TRUST_PROXY_HOPS` or a trusted
  `TRUST_PROXY_CIDRS` allowlist
- `ORDER_DELIVERY_ENCRYPTION_KEY` for delivery orders
- `PAYSTACK_SECRET_KEY` and optional server-owned `PAYSTACK_CALLBACK_URL`
- A single backend instance while rate limiting and reservation expiry are
  process-local

See [`production-security-checklist.md`](./production-security-checklist.md)
for production hardening and deployment requirements.
