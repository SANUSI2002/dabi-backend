# Sabi Health — Backend

This is the existing modular Express API with Prisma/PostgreSQL persistence.
Routes are mounted under `/api/v1` from `src/index.js`; patient, caregiver,
organization, pharmacy, prescription, order and payment modules already exist.
See [the API reference](./docs/API.md) for current routes.

The [identity assessment](./docs/identity-foundation-assessment.md) records the
existing authentication and security gaps. The
[Phase 2 identity API](./docs/identity-api.md) adds organization membership,
scoped roles/permissions and an additive migration. It does not yet provide
browser SSO or production sessions.

## Adding a resource

Follow the existing `src/modules/<resource>/` controller, service, repository,
route and validation pattern. Keep tenant and patient authorization in reusable
server policies, not in frontend route guards.

## Running locally

1. Copy `.env.example` to `.env` and fill in your local database URL.
2. `npm ci`
3. `npx prisma migrate deploy` for an existing database, followed by
   `npx prisma generate`. Never use `migrate reset` on retained data.
4. `npm run dev`. The backend listens on `PORT` (default 4000).
5. `npm test` and `npm run lint` before a deployment.
