# Zeros Control Plane

The always-on backend for teams, membership, invitations, team settings, and (later) billing. Teams are **optional**: none is auto-created at sign-in, and the shared-secrets vault was removed.

- **Stack:** Node 22 · Hono · `pg` · `jose` · plain-SQL migrations. No ORM, no framework lock-in — the whole service is a container + a Postgres, portable to any host (`pg_dump` away).
- **Auth:** Auth0 is the **issuer only**. Every request's JWT is verified locally against Auth0's public JWKS. Identity = JWT; authorization = this database, every request. `users.id` is an internally-generated uuid, decoupled from Auth0's `sub` via `user_identities` (`provider`, `provider_sub`) — a future provider swap is a new identity row, not a schema change.
- **Tenancy:** shared schema, `team_id` everywhere, app-layer role spine + staged RLS.
- **Lives outside the pnpm workspace** on purpose (same pattern as `website/web-app`): own lockfile, deployed independently by Railway, invisible to the desktop typecheck/lint.

## Local dev

```bash
cd backend
pnpm install
# a throwaway local Postgres, e.g.:
#   docker run -d -p 5432:5432 -e POSTGRES_USER=user -e POSTGRES_PASSWORD=password -e POSTGRES_DB=zeros postgres:16
cp .env.example .env       # edit DATABASE_URL / AUTH0_DOMAIN / AUTH_AUDIENCE
pnpm migrate               # apply migrations
pnpm dev                   # http://localhost:8080/healthz
pnpm test                  # unit tests; + DB integration tests when TEST_DATABASE_URL is set
```

## Migrations — the two guards

`backend/migrations/` is applied by `runMigrations` (`src/migrate.ts`) at **service boot**, before `serve()`. A migration that throws is therefore not a failed deploy — it is a crash-loop with no control plane. Two gates stand in front of that, both on the per-PR path:

1. **`pnpm check:backend-migrations`** (repo root, in preflight's `test` job) — static, no database. Enforces `<4-digit sequence>_<snake_name>.sql` naming (a file that misses the pattern is silently *never applied*), unique + contiguous sequence numbers, and forward-only vs `origin/main`. **A released migration is immutable, comments included**: `schema_migrations` records by filename with no checksum, so editing one never re-runs and the file just stops describing the deployed schema. Fix the wording in a new migration or in the docs, never in place.
2. **`src/migrations.test.ts`** (preflight's `backend` job, against a real `postgres:16` service) — actually executes the ladder: fresh install, redeploy idempotency, applying the newest migration to a database at the previous revision, and replay from every intermediate revision. Migrations that *transform rows* also get a data-preservation block (see the 0006 one); migrations that only add a table or column are covered by the generic tests.

Both DB-backed suites drop the `public` schema, so `TEST_DATABASE_URL` must point at a **throwaway** database. Without it they self-skip and `pnpm test` still exits 0 — which is why CI follows the suite with an explicit skip-guard that fails when zero migration tests ran. Keep that guard: a silently-skipped DB suite is a green check that proves nothing, and it is how a destructive rename once reached review untested.

## Deploy runbook (Railway) — one-time setup

These guard-rails are **mandatory** because Railway Postgres is an unmanaged template:

1. Railway → new project `zeros-control-plane` on the **Pro plan** (PITR requires it).
2. Add **PostgreSQL** from the template. Then, in the database service:
   - **Pin the image version** (Service → Source): never accept automatic major-version bumps — the documented corruption vector.
   - **Enable PITR** (Backups panel) immediately — it is not retroactive.
   - Enable volume backups as well.
3. Add a **service from this GitHub repo**, root directory `backend/` (the `railway.json` + `Dockerfile` here take over). Set env vars:
   - `DATABASE_URL` → reference the Postgres service's **private-network** URL
   - `AUTH0_DOMAIN` → the Auth0 tenant domain (e.g. `your-tenant.us.auth0.com`)
   - `AUTH_AUDIENCE` → the Auth0 API identifier registered for this backend
   - `NODE_ENV` → `production`
4. Migrations run automatically at boot (forward-only, transactional, recorded in `schema_migrations`).
5. **Nightly off-platform dump** (the second backup layer): add a Railway cron service running `pg_dump "$DATABASE_URL" | gzip` → upload to R2/S3. TODO: the cron service definition is not in this repo yet — it lands once the destination bucket exists.

## GitHub App — registration and deployment

Create a separate GitHub App for development, staging, and production. Never
share the confidential client secret across environments.

In each App registration:

1. Set the callback URL to the environment's public control-plane route:
   `https://<control-plane>/v1/github/oauth/callback`.
2. Enable **Expire user authorization tokens**. The desktop requires GitHub's
   rotating access/refresh pair and refuses an unrefreshable response.
3. Enable **Request user authorization (OAuth) during installation**. The
   desktop's first connection uses the App installation URL with a one-time
   `state`; reconnect uses direct OAuth with S256 PKCE. Do not configure a
   separate Setup URL for this flow.
4. Grant only the repository permissions exercised by the desktop: Metadata
   read, Contents read/write, Pull requests read/write, Checks read, Commit
   statuses read, and Workflows read/write (pushing workflow changes). Leave
   Administration, Members, and Email addresses at **No access**. Repository
   creation while this method is selected may therefore require switching to a
   PAT or gh CLI; do not broaden every installation merely for that uncommon
   operation.
5. Keep webhooks disabled until a webhook consumer ships. Installation state
   is revalidated from GitHub on Settings Refresh.

Set these backend variables from the registration:
`GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
`GITHUB_APP_SLUG`, and `GITHUB_OAUTH_CALLBACK_URL`. Keep the secret only in
Railway's backend secret store. The desktop release workflows also need the
public `VITE_CONTROL_PLANE_URL` repository secret so Electron main can bake the
correct control-plane origin; no GitHub credential is baked into the app.

**This block is optional and deliberately not a boot requirement.** Unset, the
service starts normally and `/v1/github/*` answers `503 github_not_configured`,
which the desktop renders as "GitHub App sign-in isn't available on this Zeros
control plane yet — use gh CLI or a Personal Access Token for now". A partially
filled block logs a loud `[config]` error and disables the same single feature.
GitHub sign-in must never be able to take teams, invitations, settings, or
`/healthz` down with it: on Railway a boot failure is a healthcheck crash loop,
not a degraded feature.

Also set `GITHUB_REFRESH_BINDING_SECRET` (any random 32+ byte string) in every
environment you expect to rotate the client secret in. It defaults to
`GITHUB_APP_CLIENT_SECRET`, and while the two are shared, rotating the client
secret invalidates every outstanding refresh binding at once — every desktop is
then asked to reconnect.

Before enabling the App row in a release:

- run `pnpm check:backend-migrations`, `pnpm test:backend`, and
  `cd backend && pnpm typecheck`;
- test install, direct reconnect, cancel, state replay, token rotation,
  suspension, uninstall, and local disconnect in every release channel;
- verify each channel returns to its own scheme (`zeros`, `zeros-alpha`,
  `zeros-beta`, or `zeros-dev`);
- confirm the callback and Railway logs never include OAuth codes, access
  tokens, refresh tokens, or the signed refresh binding.

Rollback by disabling the endpoints or removing the desktop App option. Do
not delete the GitHub App registration: deletion revokes every user's grant.
The cloud installation-token route intentionally remains `501` until cloud
workspaces ship.

## Auth0 — one-time setup

1. Dashboard → Applications → create a **Regular Web App** (confidential client — this backend only verifies JWTs, it never initiates a login flow itself; the same tenant's Regular Web App used by `website/web-app` is the one minting tokens).
2. Dashboard → Applications → APIs → create an **API** with an identifier matching `AUTH_AUDIENCE` above — Auth0 requires an explicit audience on every access token, and there is no implicit default.
3. Verify the tenant's JWKS is reachable: `https://<AUTH0_DOMAIN>/.well-known/jwks.json`.
4. Nothing else — no Auth0 Management API calls happen in this service's hot path. This service treats Auth0 purely as a token issuer.

## RLS (the enforced second lock)

Policies ship in `migrations/0002_rls.sql`, keyed on the per-transaction `app.user_id` / `app.system` GUCs. **As of `0004_rls_enforce.sql` they are active.**

Rather than change the Railway credential, the pool still connects as `postgres` (needed for DDL in `runMigrations`), but `withUserTx`/`withSystemTx` run `SET LOCAL ROLE zeros_app` at the top of every request transaction (`db.ts`). `zeros_app` is a `NOLOGIN, NOBYPASSRLS` role that owns nothing, so for the duration of the transaction the current role is non-superuser + non-owner and RLS binds. `SET LOCAL` is transaction-scoped, so the pooled connection reverts to `postgres` on COMMIT/ROLLBACK — no role leaks across requests. `FORCE ROW LEVEL SECURITY` is also set on every table as belt-and-suspenders for a future non-superuser owner.

The app-layer `requireRole` spine (authz.ts) remains the **primary** lock; RLS is the enforced backstop. Verified end-to-end against live data: as `zeros_app` a user sees only their own row + shared-team members; the system path (signup) sees all.

## Breaking API changes — the app does not deploy with you

Railway redeploys this service off `main` automatically. The desktop app does **not**: `release.yml` is `workflow_dispatch`, and even the beta channel needs a build plus an app restart. **Backend and app can never ship together** — assume every client in the field is still on the previous contract, and split the change in two: ship the new surface, wait for observed rollout, then retire the old one.

Response *shapes* need the same care as paths, and are easier to miss — `/v1/me` and `/v1/invitations/accept` are the same URL on both sides of a rename, so a path alias does not cover them. The 2026-07-25 Organization→Team rename turned on exactly that: invite-accept commits the membership and burns the single-use token *before* the client reads the body, so one dropped response key left the user silently a member, the UI reporting failure, and the link dead with no self-service retry. When a compat layer does go up, **give it a periodic usage counter, not a one-shot log line** — the Organization-era shim logged once per distinct path per process, so silence only ever meant the process had restarted. Retire on client versions you can see, not on logs you stopped noticing.

## API

See `src/routes.ts` for the full surface. Notable behaviors:

- **Teams are optional** (2026-07-22): the first authenticated request JIT-provisions the user row only. A team exists when the user explicitly creates one (`POST /v1/teams`, becoming its owner) or accepts an invitation. Zero-team users are fully supported; an owner can delete any team (soft delete; pending invites are revoked and the accept path refuses deleted teams).
- Invariants live in SQL transactions: last-owner protection, one pending invite per (team, email).
- Invitation tokens: 32-byte CSPRNG, stored as SHA-256 only, 7-day expiry, single-use, revocable; accepting with the wrong signed-in account returns `wrong_account` with a masked email (no enumeration oracles anywhere).
