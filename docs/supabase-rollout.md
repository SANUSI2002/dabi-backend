# Supabase test migration and private file storage

Status (24 September 2026): the separate `sabi-health-test` project and four
private, size/MIME-restricted buckets exist. The Render test API has server-only
Supabase Storage credentials. The applicant upload and manual evidence-review
workflow is enabled under a dated, explicit **unscanned test exception** through
8 October 2026 at 12:00 UTC. The files remain in private quarantine and are
never labeled clean. The asynchronous scanner path is implemented but disabled;
no ClamAV service is provisioned. No clinical file route is available. The API
still uses its disposable Render PostgreSQL database without backups. Do not
upload patient records or switch `DATABASE_URL` without a separate migration
plan. See [the temporary exception procedure](TEMPORARY_UNSCANNED_HOSPITAL_EVIDENCE.md).

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
3. The optional Node polling loop claims queued rows with a five-minute lease,
   checks the private object's length and SHA-256, and sends bytes to ClamAV
   through its `INSTREAM` protocol on a *private* Render hostname. It rejects
   uncertain responses and stale signatures, retries transient failures at a
   bounded rate, and never releases infected files. This loop is not enabled in
   the shared test API because no private ClamAV service is running.
4. After a trustworthy `CLEAN` result, the worker writes the same bytes to the
   private clean bucket with `upsert: false`, atomically records the clean
   location and scan event, then removes the quarantine copy. If the worker
   crashes after writing, it compares the existing clean object with the
   original digest before reusing it. Do not treat an applicant-supplied scan
   flag or a manual authenticity check as a malware result.
5. Only when the separate review flag is enabled, a platform reviewer with
   recent MFA can request a 60-second signed preview URL for the exact clean
   object. Record the access event. Reviewers
   check authenticity on an authoritative external registry without sending
   the uploaded file to that site unless permitted by the data agreement.
6. A separate audited human decision records the registry/source reference and
   marks only the latest eligible evidence version `VERIFIED` or `REJECTED`.
   This does not activate an EMR tenant.

The live test service currently has intake and review enabled, scanning
disabled, and the dated unscanned exception enabled. The normal clean-file
preview is still unavailable for these unscanned uploads. An approver must use
the separate audited attachment download, accept the risk per file, then record
an external authenticity decision before final EMR approval can pass. The
exception automatically stops accepting new work when its expiry is reached.
ClamAV's official container guidance recommends 4 GB RAM; the user declined a
paid Render test service for now, so do not create it. Restore the normal
scanner-controlled workflow before treating this as a production release.

Supabase Storage is the private file store, not an antivirus verdict. Hosted
Supabase Edge Functions have a 256 MB memory ceiling, so they are not a place
to run full ClamAV. See [Supabase Edge Function limits](https://supabase.com/docs/guides/functions/limits)
and [ClamAV Docker memory guidance](https://docs.clamav.net/manual/Installing/Docker.html).
For local synthetic testing, run ClamAV on a suitable developer machine and
point the local Node API at `CLAMD_HOST=127.0.0.1`; never point a public
deployment at a developer laptop or expose port 3310 to the internet.

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
