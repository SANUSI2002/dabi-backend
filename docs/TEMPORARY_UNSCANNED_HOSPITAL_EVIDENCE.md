# Temporary unscanned hospital-evidence exception (test release)

This exception is for hospital onboarding documents only. It does not enable
patient records, prescriptions, lab results, or any other clinical file upload.
The Render test PostgreSQL database is disposable and has no automated backup.
Keep applicant copies and do not present this release as a production records
system. Supabase Storage is private, but a lost application database can
orphan its document and audit metadata.

## Activation

Enable only after the database migration is applied and private Supabase
quarantine and clean buckets have been checked. Set the following server-side
environment variables on the test API:

```text
HOSPITAL_EVIDENCE_INTAKE_ENABLED=true
HOSPITAL_EVIDENCE_REVIEW_ENABLED=true
EVIDENCE_SCANNER_ENABLED=false
HOSPITAL_UNSCANNED_EXCEPTION_ENABLED=true
HOSPITAL_UNSCANNED_EXCEPTION_UNTIL=<UTC timestamp, YYYY-MM-DDTHH:mm:ssZ, within 30 days>
```

Do not put the Supabase service-role key or these switches in Vercel client
environment variables. The exception expires automatically. Setting either
exception flag to false or removing the expiry stops new intake, exception
downloads, authenticity decisions on unscanned files, and new EMR approvals
using those files. Already-approved EMR owners are unaffected.

## Reviewer procedure

1. Require a verified applicant email and use the one-time evidence access
   link. Each upload is type/size/signature checked, placed in private
   quarantine and recorded as `PENDING`. It is **not** scanned or CLEAN.
2. A platform approver with recent MFA starts review and requests a 60-second
   **attachment** URL for the latest pending version. The API audits URL
   issuance. URL issuance is not proof the operator actually downloaded or
   inspected the file.
3. Only on an isolated review workstation, download cautiously and compare
   the SHA-256 shown by Command Center. Do not use the ordinary clean-file
   inline preview and do not upload the document to an external registry.
4. Record a reason and explicitly accept the unscanned risk within two hours
   of that approver's download-link request. The file stays in quarantine and
   becomes `UNSCANNED_EXCEPTION`, never CLEAN.
5. Check registry identifiers on the authoritative external website and
   record its source and reference for each latest required document. An
   authenticity decision is separate from the exception and from final EMR
   approval.
6. Confirm the server-owned readiness check before approval. Approval sends a
   one-time owner password-setup link; it does not email a password.

When an always-on malware scanner is available, disable the exception first,
scan every quarantined object, review rejected files, and use the normal clean
bucket workflow. Do not silently relabel an exception as a clean scan.
