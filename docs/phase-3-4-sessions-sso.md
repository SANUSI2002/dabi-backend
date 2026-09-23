# Phase 3/4 implementation and rollout boundary

## What is implemented

- One backend user identity remains the authority. Browser login can request an HttpOnly refresh cookie by sending `X-Sabi-Client: browser` from an allowlisted `Origin`; non-browser API clients still receive the refresh token in the response. Access JWTs are short-lived and contain a server session ID.
- New refresh credentials are 48 random bytes, stored only as SHA-256 hashes. Refresh rotates them atomically, with an idle expiry and 90-day default absolute session cap. Reuse of a consumed credential revokes its session and active descendants. New sessions and devices are persisted; access middleware checks revocation on each authenticated request. Password reset and logout-all revoke server sessions.
- Browser cookie requests require an exact allowlisted Origin. Production cookies are `Secure`, `HttpOnly`, `SameSite=Lax`, with optional `AUTH_COOKIE_DOMAIN`. The cookie is scoped to `/api/v1/auth`.
- The Telemedicine patient portal keeps its existing login UI but authenticates against this backend, restores via the refresh cookie, enforces a backend patient/caregiver role before showing protected routes, and revokes on logout. The Google/Apple placeholder buttons no longer initiate unregistered OAuth requests.
- The main EMR/Pharmacy/Command Centre frontend has a central identity account screen. When `VITE_API_BASE_URL` is configured, its sign-ins authenticate against the same backend, restore using the same API cookie, and display backend memberships/roles. It **does not** route live identities into the old fixture-backed workspaces.

## Required deployment configuration

1. Apply both identity migrations to the same PostgreSQL database used by the backend; run Prisma generate. Back up first. Old signed refresh JWTs cannot be refreshed after this cutover: users must sign in again. Existing user records are not removed; the old token table is retained temporarily for controlled cleanup.
2. Deploy the backend at an HTTPS origin such as `https://api.example.com`. Set strong `JWT_SECRET` and `JWT_REFRESH_SECRET`, `NODE_ENV=production`, `SESSION_DAYS`, `AUTH_COOKIE_DOMAIN=.example.com`, and exact comma-separated `CLIENT_URLS` for `https://care.example.com`, `https://emr.example.com`, `https://pharmacy.example.com`, and `https://command.example.com` (plus the landing page if it hosts sign-in). Do not include wildcards.
3. Set `VITE_SABI_IDENTITY_API_URL=https://api.example.com` in Telemedicine, and `VITE_API_BASE_URL=https://api.example.com` in the main frontend deployments. Never put server secrets in `VITE_` variables. Independent `*.vercel.app` origins do **not** provide reliable same-site cookie SSO; use the owned common domain and test cross-origin cookies in the target browsers.
4. For local development, use the same hostname consistently for frontend/API (`localhost` or `127.0.0.1`) and add each exact origin to `CLIENT_URLS`. `AUTH_COOKIE_DOMAIN` should be blank locally.

## Session API contract

All paths below are under `/api/v1/auth`. Errors have non-secret messages; 401 means no valid session, 403 means authenticated but denied. The browser client sends `credentials: include` and `X-Sabi-Client: browser`.

| Method | Path | Auth | Request | Result |
| --- | --- | --- | --- | --- |
| POST | `/login` | Public, rate-limited, origin-checked for browser | `{email,password}` | Access token, user, HttpOnly refresh cookie for browser; API clients also receive refresh token |
| POST | `/refresh` | Refresh cookie or body token, rate-limited | `{organizationId?}` and optionally `{refreshToken}` for non-browser clients | Rotated refresh credential and new access token; 403 for denied tenant |
| POST | `/logout` | Refresh cookie or body token | `{refreshToken?}` | Revokes that session, clears cookie |
| GET | `/sessions` | Bearer access | None | Active sessions and device display metadata, current flag |
| POST | `/sessions/:id/revoke` | Bearer access | None | Revokes only a session owned by the caller |
| POST | `/sessions/logout-others` | Bearer access | None | Revokes every other session |
| POST | `/sessions/logout-all` | Bearer access | None | Revokes every session and clears cookie |
| GET | `/me` | Bearer access | None | User, active organization memberships, current organization |
| POST | `/organizations/switch` | Bearer access | `{organizationId}` | Session-bound access token with selected tenant context |

## Phase 4 is not complete yet

This is shared-cookie central authentication, **not an OAuth/OIDC authorization server**. It must not be marketed as completed standards-based OIDC SSO. Before declaring Phase 4 complete:

- Select and configure a standards-compliant OIDC authorization server for Sabi Identity (issuer, clients, redirect URIs, PKCE, discovery/JWKS, signing-key rotation, logout behavior) and migrate existing backend identities without unsafe email-only account linking. The existing Google/Apple placeholders are intentionally disabled.
- Connect Command Centre, EMR, and Pharmacy operational data to backend tenant-scoped APIs, then replace local store projections and demo role checks. A backend membership must be selected and checked server-side on every tenant API. Current live sign-in stops at the central account screen so real users cannot see another tenant's fixture data.
- Add distributed rate-limit storage before horizontal scaling, MFA/step-up for privileged roles (Phase 5), security event logging (Phase 8), and end-to-end cross-subdomain/browser tests. No production deployment or database migration was performed in this task.

The implementation follows [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) refresh-token rotation guidance. Any OIDC browser client should use authorization code with PKCE per [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html) and the [OpenID Connect Core specification](https://openid.net/specs/openid-connect-core-1_0.html).
