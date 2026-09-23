# Identity foundation assessment

**Source:** attached sabi-health-backend-develop (1).zip, inspected 23 September 2026.

## Existing architecture and retained behavior

The backend is an Express 4 application with modular routes under `src/modules`, Prisma 7 over PostgreSQL, Zod validation, Helmet, CORS and process-local rate limits. `src/index.js` mounts the patient/commerce modules under `/api/v1`. The existing login, patient registration, password reset, profile, prescription, pharmacy, payment and onboarding APIs must remain available.

The `User` row is already a stable UUID-backed identity. `UserRole` is a global enum assignment. `Organisation` and `Pharmacy` have separate onboarding/compliance models, each with one owner/admin link. Pharmacy staff have a separate membership-like table. These business records should be retained and linked to a central identity organization, rather than replaced or duplicated. Existing users and records are preserved by an additive migration.

| Area | Current implementation | Assessment |
| --- | --- | --- |
| Password login | `POST /api/v1/auth/login`, bcrypt hash comparison | Retain endpoint and hashes; add account status and canonical identity context. |
| Patient registration | `POST /api/v1/auth/register/patient`, creates user/profile/PATIENT role | Retain; global identity remains one user per email. |
| Password recovery | Request/confirm endpoints with hashed reset token and refresh-token deletion | Retain; strengthen race handling and session revocation in a later session phase. |
| Access token | JWT with `userId` and email, default 15 minutes | Retain as transitional API token; add issuer/audience/session validation in secure-session phase. |
| Refresh token | JWT stored in plaintext in `refresh_tokens`, returned in JSON; refresh does not rotate it | Refactor in Phase 3 to hashed opaque rotating tokens, server sessions and reuse detection. |
| Authentication middleware | `protect` verifies bearer JWT and assigns `req.user.id` | Retain for legacy patient routes; tenant routes need membership/permission middleware and account state checks. |
| Roles | `UserRoleType` enum; role checks spread across module policies | Keep legacy roles for compatibility, introduce scoped role/permission tables and reusable policy helpers. |
| Tenant model | Owner-only `Organisation`; owner/admin-only `Pharmacy`; separate pharmacy staff | Add identity organization and many-to-many memberships; backfill existing owners/staff. |
| Authorization | Many patient resources are owner scoped in models; some modules check global role enum | Existing protections are useful but cannot imply hospital/branch isolation. Tenant route migration and context policies remain required. |
| Frontend | Root EMR/Pharmacy/Command Center use local identity fixtures; Telemedicine has separate login flow and API path assumptions | Neither frontend currently consumes a shared live auth contract. SSO browser integration is Phase 4. |
| Configuration | `DATABASE_URL`, JWT secrets/expiries, single `CLIENT_URL`, rate-limit secret | Preserve existing variables; add no secret to the static frontend. Multi-origin/OIDC configuration belongs in later phases. |

## Concrete weaknesses and missing work

1. A global role such as `PHARMACY_ADMIN` or `ORGANISATION_OWNER` does not identify **which** pharmacy/hospital grants authority. The current `Organisation.ownerId` is unique and prevents one user from owning multiple organizations.
2. There is no general membership table, role-to-permission catalogue, membership-specific role assignment or reusable permission policy. Existing `PharmacyStaffMember` is limited to pharmacy workflows.
3. No OIDC authorization server, PKCE, central browser SSO session, MFA, passkeys, trusted devices or step-up flow exists. These are later phases; no route in this slice should claim otherwise.
4. Refresh tokens are stored raw and not rotated. A stolen valid token remains usable until expiry or manual deletion; access tokens are not checked against account/session state by `protect`.
5. Existing JWT verification does not constrain issuer/audience or token type. Legacy token compatibility requires a measured migration instead of changing claims without a rollout.
6. `User` has no explicit account status or verified-contact timestamps. An email can be changed only through future controlled identity APIs.
7. Process-local rate limits reset on restart and do not coordinate replicas. The current CORS setting supports one frontend origin.
8. Database tenant isolation/RLS is not yet present for hospital EMR resources. The new membership foundation does not by itself make existing routes tenant safe.
9. Some existing module error handlers mask authorization errors as 500; standard auth errors should be introduced without breaking existing route contracts.
10. A dependency audit on 23 September 2026 reported 13 advisories (6 high, 7 moderate) in the installed lockfile, including Prisma tooling/transitives and Express query parsing. Triage and safe upgrades are a production release task; no broad dependency downgrade was applied in this identity slice.

## Phase 1 and Phase 2 implementation

- Preserve existing `User`, `UserRole`, `Organisation`, `Pharmacy` and patient APIs.
- Add account status and contact verification timestamps with backwards-compatible defaults.
- Add `IdentityOrganization` linking one existing facility, `OrganizationMembership`, scoped role definitions, role permissions, membership role assignments and platform role assignments.
- Backfill existing organization owners, pharmacy admins, active pharmacy staff and selected legacy platform admins through a migration; keep original role rows.
- Make future organization/pharmacy registration create identity membership in the same transaction.
- Add reusable server-side `requireOrganization`, `requireRole`, `requirePermission`, `requireAnyPermission` and `requirePolicy` middleware, backed by current database membership and role state.
- Add authenticated membership listing and organization selection endpoints while keeping legacy `/auth/login` and `/auth/me` response fields.
- Add focused tests for active/suspended memberships, role scope, cross-tenant denial and preservation of legacy auth routes.

## Later phases and release boundary

Phase 3: server sessions, hashed rotating refresh tokens, replay/revocation, device inventory. Phase 4: standards-based OIDC/PKCE with one Sabi identity authority and frontend integration across all origins. Phases 5–8: MFA, passkeys, care-context policy, audit/risk monitoring. Phase 9: penetration, race, IDOR, cross-tenant and operational hardening.

This phase creates identity and authorization primitives only. It does not make the Vercel login credentials live, create a production SSO server, or authorize tenant clinical data access. Those require the secure-session, OIDC/frontend and tenant-data phases.
