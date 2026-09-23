# Test control-plane slice: packages and hospital applications

This slice adds server-owned commercial package versions and email-verified
hospital applications. It does **not** approve, provision, license, or activate
an organization. It is not a production healthcare release.

## Package API

- `GET /api/v1/catalog/packages` is public and returns active packages with
  only their current published version. Prices are integer **minor** NGN units.
- `GET /api/v1/platform/packages` lists all package drafts and versions.
- `POST /api/v1/platform/packages` creates metadata and version 1 as a draft.
- `POST /api/v1/platform/packages/:packageId/versions` creates the next draft
  from new price and module values; an existing draft must be published first.
- `POST /api/v1/platform/packages/:packageId/versions/:versionId/publish`
  atomically publishes that draft, retires the prior published price, moves the
  package pointer and writes an operator audit entry.

All platform routes require a server-verified platform role,
`platform.catalog.manage` and recent MFA. Published prices are not editable;
changing a price creates a new version. Creating a draft never changes the
public catalog. No packages are seeded into the test database automatically.

## Application API

- `POST /api/v1/applications` validates hospital metadata, consent and a
  current published package, pins its exact version and stores an
  `AWAITING_EMAIL` application. A bounded-rate verification email is sent to
  the applicant. A stable client draft ID makes retries idempotent; changed
  payloads using the same ID conflict.
- `POST /api/v1/applications/:id/verify` consumes a SHA-256-hashed, 24-hour,
  single-use token and moves that application to `SUBMITTED`.
- `GET /api/v1/platform/applications` and `GET /:id` require platform
  onboarding-review permission and recent MFA. Unverified applications are
  excluded from the default review queue.

Submission creates **no** `Organisation`, `IdentityOrganization`, membership,
subscription or license. Applicant passwords are not collected by the live
registration form. Compliance files staged in the browser are **not** sent to
this API and cannot support an approval decision. Secure evidence upload,
review decisions, applicant status authentication and provisioning are later
control-plane slices. Browser draft storage is temporary test behavior and
must not be used for real regulated information.

## Release sequence

1. Review migration `20260924010000_platform_catalog_applications` against
   the disposable test database and apply it with `prisma migrate deploy`.
   Never reset a retained database.
2. Deploy the backend and verify the health endpoint plus an empty public
   catalog response. Do not submit a real hospital application as a smoke test.
3. Deploy Command Center, then Sabi Health. An authorized operator must create
   and publish a test package before the public registration can submit.
4. Test one synthetic application: receive its email, verify once, observe a
   `SUBMITTED` review row, and verify no tenant or license was created.

For real production use, add managed backups and restore testing, durable
evidence storage/scanning, applicant authentication, queue/audit hardening and
the full approval/provisioning workflow.
