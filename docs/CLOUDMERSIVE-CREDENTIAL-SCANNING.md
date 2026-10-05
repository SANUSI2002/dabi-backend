# Cloudmersive credential screening

Scope: hospital onboarding evidence. Doctor onboarding can reuse `scanWithCloudmersive` once its credential queue is connected; this change alone does not enable doctor registration. Patient prescriptions, laboratory results and other medical records are **not** sent to this provider.

## Data path

Applicant capability → bounded Node upload → private Supabase quarantine → database-backed scan job → Cloudmersive Advanced Virus Scan API → checksum-bound verdict → private clean bucket → MFA-protected reviewer preview → independent authenticity check → approval.

Upload returns immediately after storing and recording evidence. The existing background poller leases one job at a time, verifies SHA-256/size, scans it, and records an audit event. Restarts resume queued jobs. A stale worker cannot overwrite a newer lease. Public signed links are not passed to Cloudmersive; only file bytes with a generic filename and MIME type are transmitted. Supabase secrets stay in Node.

## Operator setup (server secrets only)

1. Create a Cloudmersive account; the account owner accepts terms and chooses the plan. Do not purchase a plan without explicit approval.
2. Assess data-processing terms, region and legal suitability for professional credential files before enabling real submissions. Free evaluation is not a production healthcare compliance certification.
3. Add `CLOUDMERSIVE_API_KEY` to the Render API's secret environment. Never commit it, expose it through VITE variables, or put it in a URL.
4. Set `EVIDENCE_SCANNER_PROVIDER=cloudmersive`, `CLOUDMERSIVE_CREDENTIAL_PROCESSING_APPROVED=true`, `CLOUDMERSIVE_MAX_FILE_BYTES=3500000`, and `EVIDENCE_SCANNER_ENABLED=true`.
5. Keep `HOSPITAL_EVIDENCE_INTAKE_ENABLED=true` and `HOSPITAL_EVIDENCE_REVIEW_ENABLED=true` only after synthetic end-to-end checks pass. Selecting Cloudmersive disables the temporary unscanned bypass even if its old flag remains set.
6. Scan a valid synthetic PDF/PNG plus an official harmless antivirus test fixture in an isolated test environment. Verify CLEAN versus blocked verdicts, clean-bucket privacy, checksum, audit event and private preview. No real patient records in tests.

Official references: [API](https://api.cloudmersive.com/docs/virus.asp), [plan limits](https://portal.cloudmersive.com/selectplan), [DPA](https://cdn2.cloudmersive.com/data-processing-dpa).

## Limits and failure handling

Conservative default: 3,500,000 bytes per file. The Sabi free test key dashboard showed 800 calls/month and 1 call/sec on 5 October 2026; check the account dashboard for current limits. Our single worker polls every 15 seconds. A paid plan may support a larger size; setting a larger server limit does **not** purchase that plan. The application's absolute cap stays 10 MiB.

- CLEAN requires a boolean clean result, no identified viruses, no affirmative unsafe-content flags, and a verified MIME-compatible file format.
- Malware yields INFECTED; unsafe scripts/macros/password protection/invalid content yield REJECTED. Neither permits preview or approval.
- Auth errors, timeouts, malformed responses, quota exhaustion and provider outages do not become clean. Retries use existing exponential backoff, with five attempts maximum, then FAILED.
- Operational FAILED jobs can be requeued from Command Center by an authorized reviewer with recent MFA. Infected/rejected/integrity failures cannot be reset with that control. Oversized files must be compressed and resubmitted as new immutable versions.
- Pending old exception files for unapproved applications enter hosted scanning. Approved historical applications are not silently rescanned or revoked by this rollout.
- After a quota/key problem is fixed, use **Retry operational scan failure**, then **Refresh scan status**. Check the provider quota dashboard and server sanitized error codes.

## Rollback

Set `EVIDENCE_SCANNER_ENABLED=false` to stop polling. Leave provider set to cloudmersive: this keeps hosted intake/review fail-closed and does not resurrect the old bypass. To use ClamAV later, explicitly select `clamav` and configure/test its private host; that is a separate operational change. No API keys, provider payloads, original filenames or document bytes are logged.
