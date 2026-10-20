# Google Cloud backend packaging

Target project: `project-2dfff4eb-ff04-40b1-aff` (production). Existing Render and `sabi-health-dev` remain staging. These files do not deploy resources or change either environment.

## Images

Build from **this backend repository**, not the frontend parent directory:

```sh
docker build --target runtime -t sabi-api:REVIEWED_REVISION .
docker build --target migration -t sabi-migration:REVIEWED_REVISION .
```

The runtime uses Node 22, installs native runtime prerequisites, excludes dev dependencies, runs as a non-root user, and listens on the platform `PORT`. Docker's context allowlist excludes .env, local uploads, node_modules and Git metadata. No database URL or provider secret is needed at build time. Pin the base-image digest for a release and scan the resulting images; the tag is only a development default.

The migration target retains the Prisma CLI. Execute it once with a dedicated migration identity and a server-side `DATABASE_URL` after a verified backup and reviewed migration plan. API startup does **not** run migrations. Promote immutable image digests, not mutable `latest` tags.

The image has not yet been built or smoke-tested in Docker in the current Windows environment (Docker is not installed). Successful unit tests are not a substitute for that release check.

Local verification on 20 October 2026: backend lint passed; 902 unit/route tests across 92 files passed using Vitest's threads pool. Another 37 embedded PostgreSQL AI tests passed. The cookie tests cover legacy compatibility, Firebase cookie selection, production attributes, exact-origin enforcement and lookalike/legacy cookie rejection. The Windows sandbox blocked localhost HTTP connections (`EACCES`), so the full regression run used the approved non-sandbox test execution. No live environment settings were changed by the tests.

## Hosting/auth compatibility

Set `AUTH_HOSTING_PROXY=firebase` **only** for an API reached through Firebase Hosting `/api` rewrites. Firebase forwards only its `__session` cookie. This opt-in selects that cookie name while preserving Secure in production, HttpOnly, SameSite=Lax, bounded lifetime, `/api/v1/auth` path and exact trusted-origin checks. Leave `AUTH_COOKIE_DOMAIN` empty for host-only isolation unless a specific reviewed cookie-domain design requires otherwise.

Do not set this option on existing Render/Vercel staging just because it uses the same code. Switching names ends refresh continuity for existing browser cookies; verify a fresh login, refresh, sign-out and MFA flow after cutover. Hosted staging should still use `NODE_ENV=production`; staging is not a reason to issue insecure cookies.

No public production custom domain or trusted origin is changed by this code. Keep separate OAuth clients, signing secrets, encryption-key lifecycle and databases for each environment. Account migration must deliberately preserve or re-enroll encrypted MFA state rather than blindly changing the key under existing ciphertext.

## Cloud Run release blockers

The current entrypoint starts interval workers in the same process. A request-billed, scale-to-zero deployment would suspend reminders, scanning, queue consumption and other asynchronous operations. Either refactor these to authenticated durable queue/job handlers, or quote continuously allocated worker compute for the full duration. Do not turn them off silently or claim that this Dockerfile solves worker orchestration.

Current in-memory rate limits also require shared atomic enforcement before horizontal scaling. Review maximum replicas, concurrency and PostgreSQL pool totals together. Migrations, durable jobs, transactional outbox delivery, distributed limits, Google storage integration, backup/restore and full staging acceptance remain prerequisites for production cutover.

All costs must fit the user's **less than USD 120 cumulative** allowance, with USD 90 as the operating target. The saved Google budget is an alert mechanism, not a hard total cap. No paid resource is created by either build command.

The user subsequently approved a **USD 60/month ongoing hosting budget**, with no artificial
30-day rollout expiry. This does not remove the original cumulative trial allowance or authorize
a paid-billing upgrade. Plan the complete database/storage/API/worker/AI/backup cost against both
constraints, using actual regional quotes and expected load before provisioning. The TypeSafe key
is now stored in official-project Secret Manager (`typesafe-api-key`); no runtime access grant,
resource deployment, database copy or DNS cutover was made by that secret setup.
