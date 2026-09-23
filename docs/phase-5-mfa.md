# Phase 5: Sabi Identity MFA

This work extends the supplied `sabi-health-backend-develop (1).zip` backend, not a new authentication service. The original zip's `/api/v1/profile/security` route could flip `two_factor_auth` without proving possession of any authenticator. That route now returns HTTP 410 and does not change MFA state. The new method table, not the old profile flag, is authoritative.

## Controls implemented

- RFC 6238 TOTP with 30-second steps, six digits, a one-step drift window and per-user secrets generated from 20 random bytes. An accepted time-step cannot be reused, including across login and step-up.
- TOTP secrets are encrypted at rest with AES-256-GCM using `MFA_ENCRYPTION_KEY`; no source-code fallback key. Enrollment requires the current password, expires after ten minutes, and is only enabled after a valid OTP. The provisioning secret and URI are returned only during setup with `Cache-Control: no-store`.
- Ten high-entropy recovery codes are issued once after enrollment. Only SHA-256 hashes are stored. Each code is consumed atomically and cannot be used again. Regeneration invalidates all previous codes.
- Password login for an enrolled user returns a short-lived, hashed, five-attempt login challenge rather than a session. The session is created only after valid TOTP or recovery verification. The same session records an MFA verification timestamp.
- Recent MFA (ten minutes) is required for platform context, membership invitations/revocations, recovery-code replacement and MFA removal. MFA removal also requires the account password and revokes other sessions. Email/phone edits, password change, and account deletion require recent MFA if enrolled. Password change revokes other sessions.
- The Telemedicine login and the shared EMR/Pharmacy/Command Centre sign-in screens handle the MFA challenge. The main frontend provides `/identity/mfa` for setup, recovery and step-up. Telemedicine's old local-only security toggle was replaced with backend status and a link to those settings.

## API contract

All paths below are under `/api/v1/auth`. Browser calls use an exact allowlisted Origin, `credentials: include` and `X-Sabi-Client: browser`. State-changing endpoints are rate-limited. Successful browser login sets the Phase 3 HttpOnly refresh cookie; non-browser clients receive the refresh token in the response.

| Method | Route | Auth | Request | Result |
| --- | --- | --- | --- | --- |
| POST | `/login` | Public | `{email,password}` | 202 `{status:"mfa_required",challengeToken,methods}` when enrolled; no session yet |
| POST | `/mfa/login/verify` | Challenge token | `{challengeToken,code}` or `{challengeToken,recoveryCode}` | Access session after successful proof |
| GET | `/mfa/status` | Bearer | None | Enabled flag and unused recovery-code count; never returns secret |
| POST | `/mfa/totp/enroll` | Bearer | `{password}` | Base32 secret and `otpauthUri`, pending only |
| POST | `/mfa/totp/confirm` | Bearer | `{code}` | Enables TOTP, returns recovery codes once |
| POST | `/mfa/step-up` | Bearer | `{code}` or `{recoveryCode}` | Marks current session recently verified |
| POST | `/mfa/recovery/regenerate` | Bearer + recent MFA | `{}` | Invalidates prior codes; returns new codes once |
| POST | `/mfa/disable` | Bearer + recent MFA | `{password}` | Removes method/codes and revokes other sessions |

Error responses are generic; no OTP, password, recovery code, or secret is logged. A wrong or replayed factor returns 401; privileged routes without recent MFA return 403 with `MFA_REQUIRED` or `MFA_ENROLLMENT_REQUIRED`; missing encryption-key configuration fails closed with 503.

## Migration and deployment

1. Back up the database. Apply Phase 2, 3 and new `20260923150000_mfa_totp_recovery` migrations in order. The new migration resets legacy `user_profiles.two_factor_auth=true` flags to `false` because those flags were not backed by a verified method. It does **not** remove user accounts or passwords.
2. Generate and store a random 32-byte key as base64 in the backend secret manager under `MFA_ENCRYPTION_KEY`. Treat loss of this key as loss of enrolled TOTP methods; plan a controlled key-rotation process before production. Never put this key in Git or frontend environment variables.
3. Set `VITE_SABI_IDENTITY_UI_URL` in Telemedicine to the origin hosting `/identity/mfa`. Use the common-domain cookie/CORS configuration from the Phase 3/4 runbook. Deploy frontend and backend changes together; old clients calling the boolean toggle receive 410 and must upgrade.
4. Test real enrollment, recovery, session expiry, step-up and cross-origin cookies against an isolated PostgreSQL environment before production. No migration, secret, deployment or live credential was created in this task.

## Remaining risk / later phases

TOTP is not phishing-resistant; passkeys are Phase 6. Rate-limit counters are process-local and need a shared store before horizontal scaling. Phase 8 must add persistent security events, alerting and controlled MFA recovery for users who lose both authenticator and recovery codes. The existing product workspaces and OIDC provider remain Phase 4 integration work; MFA does not make those unfinished connections production-ready.

Implementation is based on [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238.html), [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html), and the [OWASP MFA Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).
