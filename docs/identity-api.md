# Sabi identity foundation API (Phase 2)

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

If the first test administrator has not established a password they control, hold that role until verified password setup is available. `scripts/hold-test-platform-admin.mjs` performs a dry run by default; `--apply` requires `SABI_TEST_PLATFORM_HOLD_CONFIRM=hold-test-platform-admin`. It is restricted to the same disposable database, removes only `SABI_PLATFORM_ADMIN` for the named email, revokes that account's sessions, and writes an activity log. The password-reset email adapter is still a placeholder until a real provider is configured; an HTTP 202 from `/password-reset/request` does not prove mail delivery.

## Migration and deployment

1. Back up the target PostgreSQL database and check the current migration history. Apply `20260923090000_identity_memberships_permissions` with the project's Prisma 7 `npx prisma migrate deploy` command and `DATABASE_URL` set in the backend environment. Do not use `migrate reset` on existing data.
2. The migration adds account status, identity organization, membership, scoped role and permission tables. It links existing organisation owners, pharmacy admins, pharmacy staff and selected platform admins without deleting legacy rows. Existing facility registration creates the new identity link in the same transaction after deployment.
3. Run `npx prisma generate`, deploy the compatible API, then check that owner and pharmacy membership counts match source records. Investigate missing/duplicate links before exposing tenant endpoints.
4. Configure the existing JWT secrets and backend database secret in a server secret store. Static frontend `VITE_` variables must never contain them.
5. The API base URL and CORS allowlist must be configured for each frontend origin when Phase 4 browser integration is implemented. A GitHub login or Git remote setting is unrelated to Sabi user authentication.

No new environment secret is introduced by Phase 2. `.env.example` remains the complete list for this slice. Later OIDC issuer/client configuration, secure cookie settings, MFA keys and session encryption must be added with their own reviewed migration and environment documentation.

## Known release boundary

This phase does **not** implement OIDC, cross-origin browser SSO, MFA, passkeys, token rotation, server sessions, PostgreSQL RLS or full hospital clinical tenancy. Existing raw refresh-token storage and legacy JWT verification remain and require Phase 3 changes. Do not claim that Vercel demo credentials work as live accounts until the backend is deployed and the frontend identity clients use these endpoints.
