# Supabase test migration and private file storage

Status (24 September 2026): the separate `sabi-health-test` project and four
private, size/MIME-restricted buckets exist. The Render test API has server-only
Supabase Storage credentials. Applicant upload and reviewer metadata routes are
implemented behind `HOSPITAL_EVIDENCE_INTAKE_ENABLED=false`; no malware scanner,
reviewer preview, or clinical file route is available. The API still uses its existing
Render PostgreSQL database. Do not upload real hospital/patient records or
switch `DATABASE_URL` until the checks below have been completed.

## Ownership and isolation

- Sabi Auth remains the only session and role authority. Supabase Auth is not
  enabled for Sabi users by this migration.
- The Node API alone holds the Supabase database URL and Storage secret key.
  Vercel receives neither. Never use the secret in a `VITE_` variable.
- Use a separate `sabi-health-test` Supabase project. Keep its Data API disabled
  while Prisma is the only application database access path.
- Create **private** buckets named `sabi-hospital-evidence-quarantine`,
  `sabi-hospital-evidence-clean`, `sabi-clinical-documents`, and
  `sabi-profile-images`. Restrict types and sizes per bucket. Do not add public
  read policies or enable public access for profile images by default.
- Once the test project exists, set `SUPABASE_URL`, `SUPABASE_SECRET_KEY`,
  and `SUPABASE_EXPECTED_PROJECT_REF` in a secure operator environment (never
  source control). Run `node scripts/provision-supabase-buckets.mjs` to inspect
  the exact project. Run it with `--apply` only after confirming the project
  reference. It creates missing private buckets, verifies MIME/size limits,
  refuses unsafe existing buckets, and never changes an existing bucket.
- The service key bypasses Storage RLS. Every Sabi API route must authorize the
  exact application, tenant, patient, actor, and action before touching files.
  Object paths should use random IDs, not patient names or document titles.

## Hospital evidence lifecycle

1. Verify the applicant's email and issue a 30-minute, single-purpose evidence
   token. The emailed re-entry link is rate-limited, generic on missing/mismatched
   accounts, and can be reissued after a cooldown. Anonymous application IDs are
   not authority. The frontend removes the token from URL history and never
   stores it persistently.
2. When explicitly enabled for a controlled test, receive bounded PDF/JPEG/PNG
   bytes via the Node API; validate size, type, content signature, and
   requirement key. Upload with `upsert: false` to the private quarantine
   bucket. Store an SHA-256 digest, `PENDING` scan status, and an append-only
   upload event. Re-submissions create new versions; the newest version controls
   readiness. The reviewer API currently exposes metadata only and logs access.
3. Scan asynchronously with a separately operated malware scanner. A file
   remains inaccessible to reviewers while the scan is pending or failed.
   Infected files are never released.
4. After a trustworthy `CLEAN` result, atomically record the state and move the
   object into the private clean bucket. Do not treat an applicant-supplied scan
   flag or a manual authenticity check as a malware result.
5. A platform reviewer with recent MFA can request a short-lived signed
   preview URL for the exact clean object. Record the access event. Reviewers
   check authenticity on an authoritative external registry without sending
   the uploaded file to that site unless permitted by the data agreement.
6. A separate audited human verification action may mark the specific evidence
   requirement `VERIFIED`. Only then can it satisfy approval readiness.

The feature flag must remain false on the shared test service until a scanner
and safe quarantine operations are available; the current approval gate deliberately retains
`SECURE_DOCUMENT_WORKFLOW_NOT_CONNECTED`. Do not remove it until the applicant
session, upload, scan, private preview, audit, and reviewer decision all pass
end-to-end tests in the test project.

## PostgreSQL cutover

1. Take a recoverable backup of the current Render test database; verify a
   restore on a disposable database. Confirm the new Supabase region, project,
   backups, retention, and test-only data classification.
2. Apply the complete checked-in Prisma migration history to an empty Supabase
   database. Compare schema and row counts. Migrate data only through a secure
   database-to-database path, not browser exports or source control.
3. On an IPv4-only persistent backend, use the exact Supabase **session pooler**
   connection string from its Connect dialog. Never construct the host by hand.
   Keep the secret in Render's server environment and test `prisma migrate
   status`, Sabi login/MFA, packages, invitations, and applications before
   switching public traffic.
4. Switch `DATABASE_URL` only after a tested rollback plan. Keep the prior
   Render database available and read-only until verification finishes.

The Supabase Free plan does not provide automatic database backups and may
pause after inactivity. Database backups also do not restore Storage object
bytes. Do not migrate patient data to a free test project. A real release needs
separate database and object backups with a tested restore, retention and
deletion policy, data-processing review, scanner operation, audit retention,
and access-control testing.
