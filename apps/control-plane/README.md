# Control plane

Railway-hosted API for Zeros identity, teams, invitations, team settings,
GitHub App coordination, audit records, and rate limiting. It owns its Postgres
schema and is deployed independently from the desktop application.

## Runtime boundary

- Node.js 22, Hono, PostgreSQL, `jose`, and plain SQL migrations.
- Auth0 issues access tokens; this service verifies JWT signatures, issuer,
  audience, expiry, and required claims locally against JWKS.
- PostgreSQL owns application authorization and tenant data. Request
  transactions use the restricted `zeros_app` role with row-level security.
- `GET /healthz` is public so Railway can evaluate service health.
- GitHub App support is optional. Missing configuration disables only the
  `/v1/github/*` routes; it does not prevent the service from starting.

The app has its own package manifest and lockfile because it is a separate
container build. Run its commands with `pnpm --dir apps/control-plane ...` or
from this directory.

## Local development

Requirements:

- Node.js 22
- pnpm
- A disposable PostgreSQL database

```bash
cd apps/control-plane
pnpm install --frozen-lockfile
cp .env.example .env

# Export the values with your preferred environment loader, then:
pnpm migrate
pnpm dev
```

The default port is `8080`; the health endpoint is
`http://127.0.0.1:8080/healthz`.

Core environment variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string; use Railway's private-network URL in production |
| `AUTH0_DOMAIN` | Auth0 tenant domain without a scheme |
| `AUTH_AUDIENCE` | Expected access-token audience |
| `AUTH_ISSUER` | Optional comma-separated issuer override |
| `AUTH_JWKS_URL` | Optional JWKS endpoint override |
| `PORT` | HTTP port, default `8080` |
| `NODE_ENV` | Use `production` for production-safe error responses |

The optional GitHub App and invitation-email variables are documented in
[`.env.example`](.env.example). Secrets belong in Railway's secret store and
must never be exposed through renderer `VITE_*` variables.

## Database migrations

SQL migrations live in `migrations/` and use contiguous names of the form
`NNNN_snake_case_name.sql`. The service applies them transactionally at startup
before accepting traffic.

Released migrations are immutable, including comments. Add a new migration for
every schema or data change; editing an applied file does not cause it to run
again and makes the repository diverge from deployed databases.

Two checks protect the migration ladder:

```bash
# Naming, sequence, and forward-only comparison with origin/main
pnpm check:control-plane-migrations

# Unit tests, plus database suites when TEST_DATABASE_URL is present
pnpm test:control-plane
```

`TEST_DATABASE_URL` must point to a disposable database. Database-backed suites
drop and recreate the `public` schema and intentionally skip when that variable
is absent. CI supplies PostgreSQL and verifies that those suites did not skip.

## Railway deployment

Configure the Railway service root as `apps/control-plane`. The colocated
[`Dockerfile`](Dockerfile) builds the service and
[`railway.json`](railway.json) configures `/healthz`, restart behavior, and the
Dockerfile builder.

Before production deployment:

1. Provision PostgreSQL with backups and a pinned supported major version.
2. Set `DATABASE_URL`, `AUTH0_DOMAIN`, `AUTH_AUDIENCE`, and
   `NODE_ENV=production` in Railway.
3. Use the private PostgreSQL service URL, not a public database endpoint.
4. Run the verification commands below against the exact commit being
   deployed.
5. Confirm startup migrations complete before directing traffic to the new
   instance.

The service and desktop release independently. API changes therefore remain
backward compatible until deployed desktop versions no longer use the previous
contract. Add new fields or routes first; remove old ones only after observed
client migration.

## Optional GitHub App

Use a separate GitHub App registration for each environment. The five required
values are:

- `GITHUB_APP_ID`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_SLUG`
- `GITHUB_OAUTH_CALLBACK_URL`

Set `GITHUB_REFRESH_BINDING_SECRET` independently so rotating the OAuth client
secret does not invalidate every outstanding refresh binding. Keep the client
and binding secrets server-side. Callback URLs must return to the matching web
and desktop release channel; the supported schemes are `zeros`, `zeros-alpha`,
`zeros-beta`, and `zeros-dev`.

Grant only the repository permissions exercised by the desktop application.
Webhooks are unnecessary until a webhook consumer exists. A partial or invalid
configuration is logged and leaves the GitHub routes unavailable while the
rest of the control plane remains healthy.

## Security model

- Authentication middleware fails closed on invalid, expired, wrong-issuer,
  wrong-audience, or unverified-email tokens.
- Application authorization is enforced inside transactions and backed by
  PostgreSQL row-level security under a non-owner, non-superuser role.
- Invitation tokens are random, single-use, expiring values stored only as
  hashes.
- OAuth codes, access tokens, refresh tokens, invitation tokens, and database
  credentials must never appear in logs or error bodies.
- Rate limits run before expensive authentication and external-provider work.
- Public responses do not reveal whether an unrelated account exists.

See [`src/routes.ts`](src/routes.ts) for the HTTP surface and
[`src/app.ts`](src/app.ts) for middleware assembly.

## Verification

Run from the repository root:

```bash
pnpm check:control-plane-migrations
pnpm test:control-plane
pnpm --dir apps/control-plane typecheck
pnpm --dir apps/control-plane build
pnpm check:secrets
pnpm check:licenses
```

For a release candidate, also run the database-backed suites with
`TEST_DATABASE_URL` and exercise authentication, invitations, optional GitHub
flows, health checks, and migration startup in a disposable staging
environment.
