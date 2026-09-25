# Medical document operations

## Security boundary

Medical documents use one dedicated, private Cloudflare R2 bucket. Public access, custom public domains, anonymous object access, and public bearer-share links must remain disabled. The API stores opaque UUID object keys only and never stores signed URLs. Legacy `MedicalRecord.documentUrl` metadata is unchanged; migrating it requires a separate inventory, ownership validation, scanning, and cutover plan.

Production use remains subject to an organization-specific medical-data compliance, privacy, retention, breach-response, and legal review. This implementation does not itself establish regulatory compliance.

## R2 setup and credentials

1. Create a private bucket dedicated to `medical-documents` in the production Cloudflare account.
2. Create an API service token restricted to object read/write/delete for this bucket only. Do not use an account-wide token or expose it to a browser.
3. Configure `DOCUMENT_STORAGE_PROVIDER=r2`, the account/bucket endpoint values, access key, secret, and region from `.env.example` in the deployment secret manager.
4. Use a five-minute signed-URL TTL (maximum supported by this module is 15 minutes). Rotate access keys regularly and immediately after suspected exposure; deploy the new key, verify health, then revoke the prior key.
5. Never log request/response headers for signed object requests. They contain credentials.

The bucket CORS policy must allow `PUT` only from the exact deployed frontend origins, allow only the `Content-Type` header, and expose no unnecessary response headers. Do not use `*` origins. The API CORS allowlist and R2 allowlist must agree.

## Object lifecycle

New objects receive opaque keys under `quarantine/<uuid>`. `PENDING_UPLOAD` and `PENDING_SCAN` objects have no download path. A scanner-authenticated clean verdict changes the database access gate to `CLEAN`; the object remains private and is available only through an owner or active named-share authorization followed by a short-lived signed GET. The `quarantine` prefix is therefore a storage namespace, while the database state is the authoritative quarantine/access boundary.

Infected and rejected objects have all grants revoked and are deleted immediately after the atomic verdict transaction. Retain the minimal document row and immutable scan-result row for audit purposes, but no filename is written to audit events. Alert if deletion fails and remediate the private orphan object using its database ID through a restricted operational tool; do not place keys in tickets or chat. Soft deletion revokes grants, minimizes stored metadata, and requests object deletion once.

Apply a bucket lifecycle rule to remove abandoned `PENDING_UPLOAD` objects after the organization-approved short retention interval. A scheduled reconciler for stale uploads and failed deletion alerts is an operational follow-up; it must use the same private credentials and must never make objects public.

## Private ClamAV worker contract

Deploy the worker and ClamAV on private networking. Never publish the ClamAV TCP port or Unix socket. The worker receives scan jobs from a private queue/reconciler, obtains the quarantined object using a bucket-scoped service identity or a short-lived signed GET, and streams it into ClamAV without persisting it to a public/shared filesystem. Keep virus signatures updating automatically, monitor update age, and fail closed when signatures or the scanner are unavailable.

The worker posts JSON to `POST /api/v1/internal/document-scans/:documentId/result`:

```json
{
  "verdict": "CLEAN",
  "validatedContentType": "application/pdf",
  "byteSize": 12345,
  "sha256": "64-lowercase-hex-characters",
  "scannerTimestamp": "2026-09-25T09:00:00.000Z"
}
```

Allowed verdicts are `CLEAN`, `INFECTED`, and `REJECTED`; allowed validated types are PDF, JPEG, and PNG. The scanner must determine file type from content, calculate SHA-256 over the scanned bytes, and ensure its byte count matches the object. It must not send filenames, object keys, content, findings, health data, or extra fields.

Set `X-Document-Scan-Timestamp` to the current ten-digit Unix seconds. Calculate `hex = HMAC-SHA256(DOCUMENT_SCAN_CALLBACK_SECRET, timestamp + "." + exactRawBody)` and set `X-Document-Scan-Signature: sha256=<hex>`. Requests outside five minutes, reused signatures, malformed bodies, mismatched sizes, and documents outside `PENDING_SCAN` are rejected. Use a random secret of at least 32 characters. For rotation, coordinate a brief worker/API deployment window; never accept an unsigned compatibility mode.

## Incident handling

For an infected upload, verify that grants were revoked and deletion succeeded, preserve only approved audit identifiers, notify the security/privacy incident owner through the approved channel, and investigate related uploads without downloading content to analyst laptops. Rotate credentials if exposure is suspected. Do not disclose scanner internals or malware details in API responses.

## External prescriptions

A clean `EXTERNAL_PRESCRIPTION` transitions to `PENDING_CLINICAL_REVIEW`, never directly to a pharmacy quote, request, reservation, or order. A later clinical-review slice must require an authorized, verified clinician and explicit patient permission before any clinical approval or downstream pharmacy routing.
