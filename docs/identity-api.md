# Sabi identity foundation API (Phase 2)

> Current test-release addendum (23 September 2026): Some Phase 2 notes below describe the original foundation and are superseded by the following email-verification and staff-invitation contracts. The test API now uses server-backed sessions, MFA, and a verified Resend sender.

## Email verification and staff invitations

Patient registration creates a `PENDING` Sabi ID. The API emails a random, single-use verification link through the server-side Resend integration and returns whether the send was accepted. Only the token's SHA-256 hash is stored. Until confirmation, correct credentials return `EMAIL_VERIFICATION_REQUIRED` and no session is issued. `POST /email-verification/request` accepts `{email}` and always returns a generic 202 for a configured sender, with a 60-second per-account cooldown. `POST /email-verification/confirm` accepts `{uid,token}` and atomically consumes a 24-hour token, marks the email verified, and activates the account. Configure `PATIENT_PORTAL_URL` to the HTTPS telemedicine origin; do not place the email API key in any frontend environment variable. Other existing registration paths (organization, pharmacy, caregiver and professional onboarding) retain their earlier behavior and need a separate migration before a universal email-verification claim can be made.

Staff invitations are separate from public registration and the legacy `POST /organizations/:organizationId/memberships` route. They support both new and existing Sabi IDs. No role is assigned until the recipient proves mailbox possession by following a 48-hour, single-use link and accepts it. Existing identities additionally supply their current password. New identities set a full name and a policy-compliant password. Accepted invitation links establish email ownership but do not bypass Command Center MFA. Raw tokens appear only in the email link's URL fragment and are never returned by list/preview endpoints or written to audit logs; the database stores SHA-256 hashes. An invitation's actor, scope, role and lifecycle are audited. Revoked, expired, used, wrong-scope and wrong-tenant invitations cannot be accepted.

| Method and route | Authorization | Behavior |
| --- | --- | --- |
| `POST /invitations/preview` | Link token, rate limited | `{id,token}`; returns recipient email, scope, role, organization name and whether an account already exists. No secret returned. |
| `POST /invitations/accept` | Link token, rate limited | `{id,token,password,fullName?}`; claims once and creates the platform assignment or active tenant membership in a transaction. |
| `GET /platform/invitations/roles` | Platform role, `platform.staff.invite`, recent MFA | Roles the current operator may grant. A platform administrator can invite support/compliance roles only; a super administrator may additionally invite platform/security admins. `SABI_SUPER_ADMIN` cannot be invited through this API. |
| `GET/POST /platform/invitations` | Same | List last 50 or create with `{email,roleCode}`. |
| `POST /platform/invitations/:id/revoke` | Same | Revoke a pending link. |
| `GET /organizations/:organizationId/invitations/roles` | Active selected tenant, `membership.manage`, recent MFA | Allowed non-clinical roles for that tenant type and caller. |
| `GET/POST /organizations/:organizationId/invitations` | Same | List last 50 or create with `{email,roleCode}`. Path organization must equal signed selected organization. |
| `POST /organizations/:organizationId/invitations/:id/revoke` | Same | Revoke a pending link in that tenant only. |

Clinical professional invitations are intentionally excluded here; they continue through credential verification. Tenant admins cannot grant owner roles. `HOSPITAL_ADMIN` and `FINANCE_OFFICER` require an organization owner. Issuance requires the verified Resend sender and an HTTPS `CLIENT_URL` serving `/accept-invite/:id#token`. Provider failure revokes the unsent link. No live recipient should be invited until the operator chooses the address and role.

All paths below are under `/api/v1/auth`. The original patient registration, login, refresh, logout, password-reset and `/me` paths remain available. Every protected call uses `Authorization: Bearer <access-token>`. Tokens are issued by this backend only; no role, membership or permission sent by a browser is authoritative.

| Method and route | Authentication and permission | Request | Response | Errors and security notes |
| --- | --- | --- | --- | --- |
| `POST /login` | Public, rate limited | `{email, password}` | Existing `{status, accessToken, refreshToken, user}` | 401 generic invalid credentials; inactive account cannot log in. Legacy token/session design remains until Phase 3. |
| `POST /refresh` | Valid refresh token, rate limited | `{refreshToken, organizationId?}` | `{status, accessToken}` | 401 invalid/revoked; 403 missing/inactive membership. Optional organization ID is checked on every refresh. Refresh-token rotation is Phase 3. |
| `GET /me` | Bearer token | None | Existing `user` plus `organizations` and `currentOrganization` | 401 inactive account; current organization exists only when selected in the signed access token. |
| `GET /organizations` | Bearer token | None | `{status:"success",data:{items:[membership]}}` | Returns only the caller's active/pending/suspended memberships; no password/profile secrets. |
| `POST /organizations/switch` | Bearer token; active user and membership, verified facility | `{organizationId:uuid}` | `{status,accessToken,currentOrganization}` | 403 wrong/suspended organization or unverified professional. Returns a short-lived access token with signed organization context. |
| `GET /platform-context` | Bearer token, platform role, no selected tenant context | None | `{status,data:{roles,permissions}}` | 403 when no platform assignment. Platform roles do not imply clinical permissions. |
| `GET /platform-assignment` | Bearer token, platform role, no selected tenant context | None | `{status,data:{assigned:true}}` | 403 when unassigned; does not disclose roles or permissions. Used to direct assigned staff to MFA setup. |
| `GET /organizations/:organizationId/memberships` | Selected organization token and `membership.read` | None | `{status,data:{items:[{id,status,user,roles}]}}` | 403 when path differs from selected context; only own organization. |
| `POST /organizations/:organizationId/memberships` | Selected organization token and `membership.manage` | `{email,roleCodes:[...]}` | 201 pending membership ID | Existing active identity only; 404 for absent/ambiguous identity, 409 duplicate, 403 invalid role scope/professional status. No access until target accepts. |
| `POST /memberships/:id/accept` | Bearer token belonging to invited identity | None | `{status,data:{membershipId,organizationId,status:"ACTIVE"}}` | 404 wrong/nonpending invitation; 409 concurrent acceptance. |
| `POST /organizations/:organizationId/memberships/:id/revoke` | Selected organization token and `membership.manage` | None | `{status,data:{id,status:"REVOKED"}}` | 403 wrong tenant, 404 inaccessible/already revoked/self. Record and authorship are retained. |

Membership example:

```json
{
  "id": "membership-uuid",
  "status": "ACTIVE",
  "organization": {
    "id": "identity-organization-uuid",
    "facilityId": "existing-hospital-or-pharmacy-uuid",
    "type": "HOSPITAL",
    "name": "Hospital A",
    "status": "VERIFIED"
  },
  "roles": ["DOCTOR"],
  "permissions": ["clinical.consultation.create", "patient.read", "prescription.create"]
}
```

The `organization.id` is the authentication scope ID. `facilityId` is the existing business record ID. APIs requiring tenant data must use `protect → requireOrganization → requirePermission/requireRole → requirePolicy`; the policy checks record-specific patient/care relationships. The existing patient APIs are still on their original authorization path and must be migrated individually before hospital tenant data is served. `requirePlatform` is a separate path for platform operations.

The generic invite route does not grant owner/super-admin roles. Clinical DOCTOR, NURSE and PHARMACIST invitations require a verified matching professional profile; pharmacist dispensing membership is created through the existing pharmacy professional invite/accept flow. Laboratory clinical role assignment is deferred until its professional verification contract exists. HOSPITAL_ADMIN and FINANCE_OFFICER invitations require an organization owner. Roles and permissions are stored in tables, not read from JWT role claims.

The live `GET /api/v1/platform/organizations?page=N` route requires a platform role, `platform.onboarding.review`, and recent MFA. It returns a paginated, deliberately limited organization registry (identity ID, type, name, status, creation time) without tenant clinical records. It is read-only. No public Command Center account-registration endpoint exists. A controlled first-admin script (`scripts/bootstrap-test-platform-admin.mjs`) is restricted to the disposable `sabi_backend_test_db`, an existing active identity, an explicit confirmation flag for mutation, and no pre-existing platform administrator. It logs the assignment. Never use this test bootstrap as a production staff-management flow.

If the first test administrator has not established a password they control, hold that role until verified password setup is available. `scripts/hold-test-platform-admin.mjs` performs a dry run by default; `--apply` requires `SABI_TEST_PLATFORM_HOLD_CONFIRM=hold-test-platform-admin`. It is restricted to the same disposable database, removes only `SABI_PLATFORM_ADMIN` for the named email, revokes that account's sessions, and writes an activity log.

Password recovery uses Resend's email API. Set server-only `RESEND_API_KEY` and `PASSWORD_RESET_EMAIL_FROM` to a sender verified in Resend, and set `CLIENT_URL` to the Sabi Health frontend origin that serves `/reset-password/:uid#token`. The token is in a URL fragment so it is not sent with the frontend page request. Never put the API key in a `VITE_` variable or repository. With no valid configuration, `/password-reset/request` returns 503 for every address (no success claim). With valid configuration it returns a generic 202 to avoid disclosing whether an identity exists. A provider failure is logged without a token or URL and the unsent token is revoked; monitor provider delivery and retry errors. The link expires after 30 minutes, is single-use, and successful confirmation revokes sessions. End-to-end delivery for all users requires a verified domain and live provider credentials; code deployment alone does not enable it. A disposable self-only test may temporarily use `PASSWORD_RESET_EMAIL_FROM=onboarding@resend.dev` only with `RESEND_TEST_RECIPIENT` set to the sole allowed recipient; all other addresses return 503. Remove the test restriction only after a verified sender is configured.

## Migration and deployment

1. Back up the target PostgreSQL database and check the current migration history. Apply `20260923090000_identity_memberships_permissions` with the project's Prisma 7 `npx prisma migrate deploy` command and `DATABASE_URL` set in the backend environment. Do not use `migrate reset` on existing data.
2. The migration adds account status, identity organization, membership, scoped role and permission tables. It links existing organisation owners, pharmacy admins, pharmacy staff and selected platform admins without deleting legacy rows. Existing facility registration creates the new identity link in the same transaction after deployment.
3. Run `npx prisma generate`, deploy the compatible API, then check that owner and pharmacy membership counts match source records. Investigate missing/duplicate links before exposing tenant endpoints.
4. Configure the existing JWT secrets and backend database secret in a server secret store. Static frontend `VITE_` variables must never contain them.
5. The API base URL and CORS allowlist must be configured for each frontend origin when Phase 4 browser integration is implemented. A GitHub login or Git remote setting is unrelated to Sabi user authentication.

No new environment secret is introduced by Phase 2. `.env.example` remains the complete list for this slice. Later OIDC issuer/client configuration, secure cookie settings, MFA keys and session encryption must be added with their own reviewed migration and environment documentation.

## Known release boundary

This phase does **not** implement OIDC, cross-origin browser SSO, MFA, passkeys, token rotation, server sessions, PostgreSQL RLS or full hospital clinical tenancy. Existing raw refresh-token storage and legacy JWT verification remain and require Phase 3 changes. Do not claim that Vercel demo credentials work as live accounts until the backend is deployed and the frontend identity clients use these endpoints.
