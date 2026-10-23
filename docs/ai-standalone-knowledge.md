# Standalone Sabi AI and private knowledge service

## Release scope

Standalone login, signup and account applications reuse Sabi Identity and its existing password, email-verification, session, MFA and account-status controls. Personal accounts receive general health-assistant access. Professional and business applications are pending until an authorised Sabi administrator reviews them. Approval affects AI capabilities only: it never creates a clinical professional profile, hospital membership, patient-access relationship or prescribing permission.

Professionals provide discipline, country, issuing body, registration/licence number and a current expiry date. Businesses provide organisation name, registration number and issuing authority. Existing users sign in and submit an application rather than creating another identity. Expired approval falls back to personal access; an AI suspension denies all AI capabilities and cannot be cleared by self-resubmission. Account-category features and per-user overrides are persisted and server-enforced. Token allocations continue to use the durable allowance ledger; business and approved professional accounts inherit professional defaults unless individually overridden.

## Knowledge ownership and permissions

Only Sabi platform administrators holding `platform.settings.manage`, with recent MFA, can list, upload, edit, preview, review, approve, publish, retire or retry knowledge documents. Ordinary accounts, hospital administrators and support staff receive no catalogue or file access. There are no end-user knowledge-search, passage-view or file-download endpoints. Every new table has RLS enabled without public policies; Sabi's privileged backend remains the only data access path.

The administrator confirms indexing/AI-processing rights and the disclosure that file contents are sent to Cloudmersive for malware screening. Files are stored privately in the existing Supabase clinical-documents bucket, under a separate `ai-knowledge/` prefix not associated with a patient's document record. No source is published merely because it is uploaded, scanned or extracted. Scanner availability and configured file-size limits are honoured; no paid scanner upgrade is performed automatically.

Pipeline: awaiting upload → uploaded → processing → review required → approved → published. Failed, retired and superseded versions are unavailable to retrieval. Malware failures cannot use the operational retry to bypass screening. Background parsing runs in a resource/time-bounded worker thread; the knowledge job loop is separate from the conversation loop. All pages require explicit review or exclusion. Empty/scanned pages require reviewed transcription before inclusion. A second Sabi administrator must approve the source; publishing is a distinct, audited action. Replacement editions are immutable new versions; publishing atomically supersedes the previous active edition.

Private source previews require a fresh authorised request and an audited purpose; links expire after 60 seconds. Removing from use means immediate retirement/deindexing, not permanent destruction of the audit source. Original-file destruction and backup-retention policies are not silently inferred from retirement.

## Answer evidence

Only published, clean, in-date, rights-confirmed pages approved for the authenticated account category are selected. The first implementation uses PostgreSQL full-text keyword retrieval with a GIN index, not an advertised semantic index. Four bounded passages at most are supplied to the existing server-side Google gateway. Prompt context distinguishes approved references from untrusted personal document text; neither grants clinical authority or acts as instructions.

The response exposes bibliographic reference records only: book/guideline title, author/publisher, edition, immutable document version and verified printed-page label, or an explicit physical PDF page when the printed label is unknown. No excerpts, storage paths or signed book links are returned to users. Citation labels must resolve to a passage retrieved for that response; unknown labels and responses reproducing 26 or more consecutive source words are rejected. This is not a proof of clinical claim correctness. Patient-specific treatment requires separate clinical validation.

Retirement, supersession, review expiry, account audience changes or removal of reference entitlement invalidate subsequent retrieval and the visibility/export of affected historical answers. Publication is checked again after provider work under the source-lifecycle lock. Usage remains accounted for even when publication is rejected.

## APIs

- `/api/v1/ai-account`: public catalogue, registration and rate-limited verification resend; authenticated own application and entitlements.
- `/api/v1/command-centre/ai/accounts`: administrator category policy, review queue, per-user overrides and decisions.
- `/api/v1/command-centre/ai/knowledge/documents`: administrator-only versioned upload, status, page review, metadata, preview, approval, publishing, retirement and retry.
- Existing `/api/v1/ai` chat/config/usage routes integrate the policy and retrieved evidence; no library-management routes are mounted here.

Mutations use expected versions and audited reasons. Upload creation has a client-generated UUID and checksum for retry safety. All 753 registered operations are documented in OpenAPI.

## Research register

Checked against official regulator sites on 20 October 2026. No universal licence-number pattern or automatic regulator verification API is assumed.

- Medical/dental: MDCN, https://www.mdcn.gov.ng/public/storage/documents/sub_document_1215406857.pdf
- Nursing/midwifery: NMCN, https://local-verification.nmcn.gov.ng/ and https://nmcn.gov.ng/licensing.html
- Pharmacy: PCN, https://pcn.gov.ng/registrations/
- Rehabilitation: MRTB, https://www.mrtb.gov.ng/en/
- Laboratory science: MLSCN, https://www.mlscn.gov.ng/
- Radiography: RRBN, https://services.rrbn.gov.ng/
- Optometry/dispensing opticianry: ODORBN, https://odorbn.gov.ng/registration
- Community health: CHPRBN, https://app.chprbn.gov.ng/verify

Other disciplines and non-Nigerian licences require their explicitly supplied issuing body and independent review. This catalogue is not an assertion that every health-related occupation has the same statutory licensing regime.

## Remaining specification phases

This release does not claim the entire clinical knowledge specification is finished. Automated OCR/layout-aware dosage-table extraction, semantic retrieval/reranking, live external-evidence fetch/refresh/conflict adjudication, private tenant-protocol indexing, structured EMDEX drug data, authorised encounter/patient context and clinician-authored release evaluations remain separate work. Administrators may upload rights-cleared external publisher guidelines for the same review pipeline, but this is not live web search. General assistant conversation remains available according to existing policy; this release does not activate autonomous diagnoses, prescriptions or unreviewed clinical-record writes.

The API/database still use the transitional Render service. Moving them to Google production and replacing the expiring unbacked Render database remain infrastructure work, separate from this release.
