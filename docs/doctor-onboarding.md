# Doctor credential onboarding

## Operator setup

Apply Prisma migrations, retain the existing private `sabi-hospital-evidence-quarantine`
and `sabi-hospital-evidence-clean` buckets, then set `DOCTOR_REGISTRATION_ENABLED=true`.
The gate additionally requires the existing evidence scanner configuration. With
Cloudmersive, `CLOUDMERSIVE_CREDENTIAL_PROCESSING_APPROVED=true` and a server-only
API key are required. Keep the credential limit compatible with the scanner plan
(this test deployment uses 3,500,000 bytes). Resend and its verified sender must be
configured. Never put storage or scanner keys in Vercel/browser variables.

`DOCTOR_PORTAL_URL` controls verification and approval email links; use the
canonical HTTPS portal URL, not a deployment preview URL. Registration config is
public at `GET /api/v1/doctors/registration-config`.

## Workflow

1. JSON registration creates a PENDING Sabi user, PROFESSIONAL role, DOCTOR profile
   and credential application. It stores a password hash and consent version.
2. A hashed, single-use verification token expires after 24 hours. Its raw value
   travels only in the email URL fragment. The recipient explicitly confirms it.
   Email verification activates Sabi ID, not clinical privileges.
3. The verified owner signs in and uploads practising licence and MDCN registration
   certificate through authenticated, owner-checked endpoints. Files are immutable
   revisions with a SHA-256 checksum and private quarantine location. Replacements
   invalidate submission and their own previous authenticity findings.
4. Submission adds the application to review. A leased background worker alternates
   hospital and doctor jobs, verifies stored bytes and screens credentials. CLEAN
   files are copied to the private clean bucket. Infection, uncertain replies,
   provider failures and content rejections never unlock previews or approval.
5. Command Center staff with platform onboarding review permission and MFA verified
   within 10 minutes can inspect the queue and request 60-second private previews.
   Approval permission is also required to record source/reference/findings and
   authenticity decisions. Sabi staff verify authenticity externally; no automatic
   eligibility decision is made from a malware verdict.
6. Server approval rechecks verified email, submission, licence expiry, both latest
   CLEAN files and both independent VERIFIED findings, within row locks. Self-review
   and self-approval are forbidden. Legacy professional approval uses the same gates.
7. Approval email links to sign-in with the password chosen at registration. No
   generated password is emailed. Email failure is reported and can be retried;
   it does not revert a saved review decision. Password reset remains Sabi Auth.
8. Rejected applicants can replace evidence and resubmit. Suspended accounts cannot
   mutate their application or access clinical tools. New doctor registrations through
   the legacy `/professionals/register` endpoint are rejected to prevent bypass.

## Operational limitations

This remains a test release. The current Render database has no backups. Provider
quotas may delay scans; operational failures retry with capped backoff and can be
requeued by authorized reviewers. Unsafe/infected files cannot be reset to CLEAN.
Never approve synthetic test credentials for a real clinical account. This workflow
does not enable patient medical-document processing through Cloudmersive.

The scanner runs in the existing single API instance. Scaling requires a shared
rate limiter and operational queue/capacity planning. Registration and approval
email calls currently have a bounded timeout and explicit resend controls rather
than a durable transactional email outbox. Retention/purge policy, privacy notice
and clinical compliance review remain organization-owned launch requirements.

## Verification

Run the doctor policy, routes and scanner tests, legacy professional routes,
hospital evidence tests and doctor care/appointment tests. These use only synthetic
credentials and mocked providers. Also run Prisma validation/generation and the
frontend doctor-portal and Command Center tests/builds. Live smoke tests must not
grant clinical approval or send real credentials without an authorized staff action.
