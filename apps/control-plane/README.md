# Control plane

Railway-hosted API for Zeros identity, organizations, child teams, invitations,
organization settings,
GitHub App coordination, authenticated feedback delivery, audit records, and
rate limiting. It owns its Postgres
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
- Feedback delivery is optional at boot. `POST /v1/feedback` answers a clear
  503 until Intercom and/or Linear is configured.

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

The optional GitHub App, invitation-email, and feedback variables are documented in
[`.env.example`](.env.example). Secrets belong in Railway's secret store and
must never be exposed through renderer `VITE_*` variables.

## Database migrations

SQL migrations live in `migrations/` and use contiguous names of the form
`NNNN_snake_case_name.sql`. The service applies them transactionally at startup
before accepting traffic.

Released migrations are immutable, including comments. Add a new migration for
every schema or data change; editing an applied file does not cause it to run
again and makes the repository diverge from deployed databases.

A migration whose header contains `zeros:requires-controlled-downtime` is
blocked in `NODE_ENV=production` until its exact filename appears in
`CONTROL_PLANE_MIGRATION_APPROVALS`. Migration `0009` uses this guard because
the prior server binary cannot run against its renamed schema. Follow the
one-time procedure in
[`docs/deployment-environments.md`](../../docs/deployment-environments.md);
do not approve it during a rolling deploy.

The current tenant hierarchy is Account → Personal/Organization → Team →
Member. Personal is permanent and local-only; every tenant currently receives
one default child team. The compatibility and rollout contract is documented in
[`docs/organizations-and-teams.md`](../../docs/organizations-and-teams.md).

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

Use one Railway project with persistent `alpha`, `beta`, and `production`
environments. Each environment has its own control-plane instance, Postgres,
Auth0 audience, GitHub App, feedback destinations, and public domain.
Production autodeploy stays disabled; only Alpha tracks `main`.

Before a production deployment:

1. Provision PostgreSQL with backups and a pinned supported major version.
2. Set `DATABASE_URL`, `AUTH0_DOMAIN`, `AUTH_AUDIENCE`, and
   `NODE_ENV=production` in Railway.
3. Use the private PostgreSQL service URL, not a public database endpoint.
4. Run the verification commands below against the exact commit being
   deployed.
5. Confirm startup migrations complete before directing traffic to the new
   instance. Use expand/contract migrations for ordinary rolling deploys.

The authoritative topology, variable matrix, promotion flow, and migration
runbook live in
[`docs/deployment-environments.md`](../../docs/deployment-environments.md).

The service and desktop release independently. API changes therefore remain
backward compatible until deployed desktop versions no longer use the previous
contract. Add new fields or routes first; remove old ones only after observed
client migration.

## Organization API

The authenticated surface is organization-first:

| Route | Purpose |
| --- | --- |
| `GET /v1/me` | Account plus Personal-first organization summaries and capability metadata |
| `POST /v1/organizations` | Create an organization, owner membership, and default team atomically |
| `GET/PATCH/DELETE /v1/organizations/:id` | Read or manage an organization; Personal mutation is rejected |
| `/v1/organizations/:id/members` | Membership, role, leave, and last-owner-safe removal operations |
| `/v1/organizations/:id/invitations` | Exact-email, expiring organization invitations |
| `GET/POST /v1/organizations/:id/teams` | List the default team; additional creation returns a capability error for now |
| `GET /v1/organizations/:id/billing` | Organization-scoped plan/seat metadata; payment management remains disabled |
| `/v1/organizations/:id/settings` | Remote organization settings; Personal reads empty/local-only and rejects writes |

`/v1/teams` mirrors the tenant-root operations for mixed-version desktop
clients. Its IDs are organization IDs, not child-team IDs.

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

## Gated cloud-workspace lifecycle

Cloud workspace lifecycle is a disabled-by-default, pre-production surface.
Setting a provider key does not enable it: `CLOUD_WORKSPACES_ENABLED=true`, a
complete exact-pinned cloud block, and a valid GitHub App RSA private key are
all required at boot. Each approved Organization additionally needs a quota row
created under system authority; there is deliberately no permissive default.

The authenticated Organization surface is:

| Route | Purpose |
| --- | --- |
| `GET/POST /v1/organizations/:id/cloud-workspaces` | List authorized workspaces or request an idempotent create |
| `GET /v1/organizations/:id/cloud-workspaces/:workspace` | Read one team-authorized workspace |
| `POST .../:workspace/stop` | Request a durable stop intent |
| `POST .../:workspace/wake` | Request wake after rechecking current eligibility and quota |
| `POST .../:workspace/archive` | Request stop-plus-archive reconciliation |
| `DELETE .../:workspace` | Revoke endpoint grants, then request verified deletion |

Mutating requests require an `Idempotency-Key`; replaying the same key and
semantic request returns the original workspace/intent, while reusing it for
different parameters returns `409`. Public documents contain the stable Zeros
workspace id, never Daytona's resource id. PostgreSQL records the immutable
image, architecture, source commit, and resource allocation per generation.
The provider reconciler uses leases, observes before mutating, recovers lost
create responses, converges drift, and only deletes a managed true orphan after
repeat observation plus a grace period.

Provider creation currently queues a setup run and leaves the workspace in
`setting_up`. Until the Phase 2 non-root setup worker and workspace-bound engine
grant issuer exist, this API is not a shipping remote workspace experience.
Configuration and safe defaults are documented in [`.env.example`](.env.example).

## Optional feedback destinations

The desktop posts authenticated reports to `POST /v1/feedback` on this service.
Configure Intercom with `INTERCOM_TOKEN` and/or Linear with
`LINEAR_API_KEY` + `LINEAR_TEAM_ID`; see [`.env.example`](.env.example) for
optional regions, type-to-tag maps, labels, and PostHog links.

Create these three tags in Intercom and these three issue labels in Linear
before setting their ID maps:

| Map key    | Display name    |
| ---------- | --------------- |
| `bug`      | Bug or Issue    |
| `feedback` | Feedback        |
| `feature`  | Feature Request |

Copy the provider IDs—not the display names—into `INTERCOM_TAG_IDS` and
`LINEAR_LABEL_IDS`. Do not create a separate `issue` entry. The API still
accepts `issue` from released desktop builds and normalizes it to `bug` before
selecting either provider ID.

Identity always comes from the verified Auth0 user, never the JSON body. The
body is strict, messages and scrubbed logs are bounded, and the route has both
a pre-auth five-per-minute Railway client-IP limit and a five-per-minute
per-user limit. Its larger body allowance applies only after both authentication
and those limits. Intercom and Linear delivery are independent; the request
succeeds when either accepts it. Full scrubbed logs go to a private Linear
upload while Intercom receives only a readable tail.

## Security model

- Authentication middleware fails closed on invalid, expired, wrong-issuer,
  wrong-audience, or unverified-email tokens.
- Application authorization is enforced inside transactions and backed by
  PostgreSQL row-level security under a non-owner, non-superuser role.
- Invitation tokens are random, single-use, expiring values stored only as
  hashes.
- Personal cannot be mutated, deleted, invited into, or used for remotely
  persisted settings through the API.
- OAuth codes, access tokens, refresh tokens, invitation tokens, and database
  credentials must never appear in logs or error bodies.
- Per-user rate limits run before external-provider work; Auth0 and signup
  protections bound identity provisioning separately.
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
pnpm --dir apps/control-plane audit:prod
pnpm check:secrets
pnpm check:licenses
```

For a release candidate, also run the database-backed suites with
`TEST_DATABASE_URL` and exercise authentication, invitations, optional GitHub
flows, health checks, and migration startup in a disposable staging
environment.
