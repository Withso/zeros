# Control plane

Railway-hosted API for Zeros identity, organizations, child teams, invitations,
organization settings,
GitHub App coordination, authenticated feedback delivery, audit records, and
rate limiting. It owns its Postgres
schema and is deployed independently from the desktop application.

## Runtime boundary

- Node.js 22, Hono, PostgreSQL, `jose`, and plain SQL migrations.
- The selected identity provider issues access tokens; this service verifies
  JWT signatures, exact issuer, audience, expiry, and required claims locally
  against JWKS. WorkOS mode additionally enforces the Web/Desktop Application
  allowlist and session/token identifiers.
- In WorkOS mode Railway also owns browser PKCE exchange, encrypted sealed
  sessions, PostgreSQL-serialized refresh, Hosted AuthKit Desktop Application
  authorization, webhook verification, desktop current/all-session revocation,
  WorkOS management-command reconciliation, Events API repair, security-event
  streaming, and durable lifecycle notifications. Cloudflare Pages holds none
  of those secrets.
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

| Variable                 | Purpose                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`           | Restricted PostgreSQL application connection; hosted channels use PlanetScale with `sslmode=verify-full`                                         |
| `AUTH_PROVIDER`          | `auth0` during compatibility rollout, or `workos` after client cutover                                                                           |
| `AUTH_AUDIENCE`          | Expected access-token audience                                                                                                                   |
| `AUTH_ISSUER`            | Exact WorkOS environment/default-Application issuer; required in WorkOS mode, optionally comma-separated only for legacy Auth0                   |
| `AUTH_JWKS_URL`          | Exact public signing JWKS for that WorkOS environment/default Application; required in WorkOS mode                                               |
| `AUTH_WEB_CLIENT_ID`     | Allowed WorkOS Web Application client ID                                                                                                         |
| `AUTH_DESKTOP_CLIENT_ID` | Allowed WorkOS Desktop Application client ID                                                                                                     |
| `APP_ORIGIN`             | Exact channel app origin used for the browser callback and safe returns in WorkOS mode                                                           |
| `WORKOS_API_KEY`         | WorkOS server API key; Railway-only                                                                                                              |
| `WORKOS_COOKIE_PASSWORD` | Unique 32+ character key for WorkOS sealed sessions; Railway-only                                                                                |
| `WORKOS_WEBHOOK_SECRET`  | Exact WorkOS endpoint signing secret; Railway-only                                                                                               |
| `RESEND_API_KEY`         | Optional Railway-only, sending-only Resend key for Zeros product/security notifications and the Auth0 invitation rollback path                   |
| `EMAIL_FROM`             | Optional verified Resend sender, for example `Zeros <notifications@updates.zeros.build>`                                                         |
| `ZEROS_SELF_HOSTED`      | Public templates only: `true` allows installer-owned platform domains; frontend and API origins must differ; official deployments leave it unset |
| `AUTH0_DOMAIN`           | Legacy Auth0 fallback used only when explicit issuer/JWKS values are absent                                                                      |
| `PORT`                   | HTTP port, default `8080`                                                                                                                        |
| `NODE_ENV`               | Use `production` for production-safe error responses                                                                                             |

The optional GitHub App, invitation-email, and feedback variables are documented in
[`.env.example`](.env.example). Secrets belong in Railway's secret store and
must never be exposed through renderer `VITE_*` variables.

When WorkOS synchronization is enabled, keep WorkOS's native **user
invitation** email enabled and configure its custom User Invitation URL to the
exact channel app origin plus `/invite`. WorkOS appends `invitation_token` and
sends the single branded email; Railway resolves that token against the exact
Zeros invitation before granting product access. Organization invitations must
be created through Zeros rather than manually in the WorkOS Dashboard.
The copyable Zeros link is also fail-closed: until its provider ID is prepared it
returns a retryable error, and acceptance re-fetches that exact WorkOS object so
a direct provider revoke cannot be bypassed by a still-present local record.
Zeros intentionally does not pass organization invitation tokens into AuthKit's
authenticate call because WorkOS permits corporate-domain invitations to be
accepted by another address on the same domain; the authenticated Railway POST
enforces exact recipient equality instead.

## Database migrations

SQL migrations live in `migrations/` and use contiguous names of the form
`NNNN_snake_case_name.sql`. Before accepting traffic, service boot examines the
ledger and applies only migrations that are safe for automatic startup.

Released migrations are immutable, including comments. Add a new migration for
every schema or data change. The runner stores an exact SHA-256 content checksum
beside each canonical filename and refuses a later mismatch. On the first run of
this hardened runner, canonical rows from the former filename-only ledger are
bound to the files in that release; recognized historical alias rows remain as
evidence while their canonical rows receive checksums.

One dedicated PostgreSQL client holds a fixed, session-level advisory lock for
the complete run. Its ordinary request `statement_timeout` is disabled only for
that run and restored before the client returns to the pool. Each file and its
ledger insert commit in one runner-owned transaction. Migration SQL must not
contain top-level `BEGIN`, `COMMIT`, `ROLLBACK`, savepoint, or other transaction
control; `check:control-plane-migrations` and the runtime both reject it.

A migration whose header contains `zeros:requires-controlled-downtime` can be
approved in `NODE_ENV=production` only for the explicit strict migrator, by
putting its exact filename in `CONTROL_PLANE_MIGRATION_APPROVALS`. Production
service boot never consumes that variable. Migration `0009` uses the guard
because the prior and new server binaries require incompatible core schemas;
an unapproved `0009` always fails startup. Seven cloud-era migrations (`0025`,
`0060`, `0061`, `0073`, `0075`, `0076`, and `0079`) also require explicit approval
because old and new workers must not overlap their authority, object-lifecycle,
provider-erasure, funding, or security-event transitions. The service-boot pause
policies for `0025`, `0060`, and `0061` are separate from the strict migrator's
complete ten-file approval set. Follow the `0009`
procedure in
[`docs/deployment-environments.md`](../../docs/deployment-environments.md);
never approve one during a rolling deploy.

The strict operator command never skips an unapproved boundary. From a source
checkout use the first command; inside the production image (where `tsx` and
`src/` are intentionally absent) use the supported compiled entrypoint:

```bash
pnpm --dir apps/control-plane migrate
node dist/migrate.js
```

Automatic service boot has exactly three filename-specific, fail-safe pause
policies: `0025_cloud_workspace_engine_authority.sql`,
`0060_cloud_workspace_pending_blob_deletions.sql`, and
`0061_workos_provider_erasure_fences.sql`. It may stop before any
boundary and serve the non-cloud control plane only while v2 is unavailable and no later migration is recorded. Deferring `0025` additionally requires every pre-`0025` cloud state
table to be empty. Deferring `0060` from a `0059` ledger permits existing cloud
state because that is the data the controlled migration must conservatively
backfill. Deferring `0061` permits existing state, keeps exact active WorkOS
mappings usable, and makes unknown provider subjects fail closed until
historical purge evidence is reconciled. At any pending cloud-era boundary,
service boot keeps the WorkOS deletion lifecycle worker stopped; the WorkOS
command, event-repair, and security-notification loops continue. No boundary
DDL or cloud worker runs while it is pending. A leaked or standing
`CONTROL_PLANE_MIGRATION_APPROVALS` value does not change any decision. Boot
neither records the boundary nor applies its suffix; only a completed strict
operator run can advance the ledger. All pending suffixes are classified
explicitly, so appending any migration makes the pause fail closed until its
runtime dependency is reviewed. `/healthz` remains HTTP 200 for Railway but
exposes the incomplete schema explicitly:

```json
{
  "ok": true,
  "migrations": {
    "state": "controlled_migration_pending",
    "migration": "0025_cloud_workspace_engine_authority.sql",
    "dependentRuntime": "cloud_workspaces"
  }
}
```

While that state is present, the v2 runtime, agent credentials, organization
agent connections and authentication snapshots/events return a non-cacheable
`503` with `error.code=controlled_migration_pending` before authentication or
database access. Unrelated APIs remain available.

If the ledger has crossed a missing boundary or a controlled migration has no
explicit boot-pause policy, startup fails closed. Run the strict migrator in
a drained window, with a verified backup, before deploying the runtime that
requires its schema. Migration 0182 removes the old cloud graph and must deploy
with the v2-only control plane and desktop.

The current tenant hierarchy is Account → Personal/Organization → Team →
Member. Personal is permanent and local-only; every tenant currently receives
one default child team. The compatibility and rollout contract is documented in
[`docs/organizations-and-teams.md`](../../docs/organizations-and-teams.md).

Authentication foundation migrations after the original Hosted AuthKit slice:

| Migration                           | Durable contract                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `0013_auth_lifecycle.sql`           | stable account/identity/session lifecycle, provider tombstones, auth revisions                   |
| `0014_workos_organization_sync.sql` | collaborative organization/member/invitation projections plus ordered command/event outboxes     |
| `0015_security_events.sql`          | organization/account/data revisions, replayable security events, endpoint-grant revocation hooks |
| `0016_account_recovery.sql`         | fresh-auth reviewed recovery and at-least-once security-notification outbox                      |

Two checks protect the migration ladder:

```bash
# Naming, sequence, and forward-only comparison with origin/main
pnpm check:control-plane-migrations

# Unit tests, plus database suites when TEST_DATABASE_URL is present
pnpm test:control-plane
```

`TEST_DATABASE_URL` must point to a disposable database. Database-backed suites
intentionally skip when that variable is absent. The Vitest global setup drops,
recreates and migrates the `public` schema once per run. Between tests,
`resetMigratedTestDatabase()` restores the migrated rows and sequences, and
replays the ladder only after a test changed the schema, a privilege or a
trigger. `src/migrations.test.ts` still replays the ladder itself.

Path-selected PR CI can skip the database suites when none of their inputs
changed (`scripts/ci/control-plane-scope.mjs`). Selected suites run across eight
PostgreSQL services with Vitest `--shard`, and the required `control plane`
check rejects any skipped database-backed test. Independent Full CI runs all
eight shards on every PR, and Preflight runs all eight on every main push.

### Clean authentication cutover reset

Preserve existing channel data during authentication and database migrations.
For an explicitly disposable Alpha or Beta database, `reset:database` provides a guarded
full-schema reset. It never supports Production, is read-only by default, and
does not print the database URL.

1. Point `DATABASE_URL` at the exact Alpha or Beta database through the normal
   secret environment and run a plan:

   ```bash
   CONTROL_PLANE_RESET_CHANNEL=alpha pnpm reset:database
   ```

2. Record the target fingerprint and row counts. Take a restorable backup and
   complete a restore drill before continuing.
3. Copy the non-secret approval value printed by the plan. Because the empty
   schema replays the full migration ladder through the strict operator runner,
   include the exact ten currently required controlled-downtime approvals as
   one comma-separated value, then execute:

   ```bash
   CONTROL_PLANE_RESET_CHANNEL=alpha \
   CONTROL_PLANE_RESET_BACKUP_CONFIRMED=true \
   CONTROL_PLANE_RESET_APPROVAL='reset:alpha:<target-fingerprint>' \
   CONTROL_PLANE_MIGRATION_APPROVALS=0009_organization_team_hierarchy.sql,0025_cloud_workspace_engine_authority.sql,0060_cloud_workspace_pending_blob_deletions.sql,0061_workos_provider_erasure_fences.sql,0073_cloud_workspace_compute_leases.sql,0075_security_event_commit_order.sql,0076_cloud_workspace_individual_pro_and_pilot.sql,0079_cloud_workspace_user_compute_funding.sql,0101_cloud_workspace_pro_entitlements.sql,0103_cloud_workspace_pro_sharing.sql,0182_retire_legacy_cloud.sql,0191_retire_legacy_cloud_02.sql,0192_retire_legacy_cloud_03.sql,0193_retire_legacy_cloud_04.sql,0194_retire_legacy_cloud_05.sql,0195_retire_legacy_cloud_06.sql,0196_retire_legacy_cloud_07.sql,0197_retire_legacy_cloud_08.sql,0198_retire_legacy_cloud_09.sql,0199_retire_legacy_cloud_10.sql,0200_retire_legacy_cloud_11.sql \
   pnpm reset:database -- --execute
   ```

Execution drops and recreates the entire `public` schema, then replays every
migration with `runMigrations`; it never uses the service-boot deferral policy.
It is not a partial user deletion. `RAILWAY_ENVIRONMENT_NAME`, when present,
must exactly match the selected channel. Keep the previous database or backup
available until Alpha acceptance is complete.

## Railway deployment

Configure the Railway service root as `apps/control-plane`. The colocated
[`Dockerfile`](Dockerfile) builds the service and
[`railway.json`](railway.json) configures `/healthz`, restart behavior, and the
Dockerfile builder.

Use one Railway project with persistent `alpha`, `beta`, and `production`
environments. Each environment has its own control-plane instance, PlanetScale Postgres database,
authentication contract, GitHub App, feedback destinations, and public domain.
Production autodeploy stays disabled; only Alpha tracks `main`.

Before a production deployment:

1. Provision PlanetScale Postgres with backups and a qualified supported major version.
2. Set `DATABASE_URL`, the selected provider's complete `AUTH_*` block, and
   `NODE_ENV=production` in Railway. WorkOS mode additionally requires
   `APP_ORIGIN`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`, and
   `WORKOS_WEBHOOK_SECRET`. None belongs in Pages or a desktop build.
3. Use the channel's verified PlanetScale TLS endpoint and separate restricted
   application and migration-owner credentials. Keep `DATABASE_MIGRATIONS_ON_BOOT=false`.
4. Run the verification commands below against the exact commit being
   deployed.
5. Apply migrations through the guarded one-shot operator, then confirm the
   application's read-only schema verification passes before directing traffic
   to the new instance. Use expand/contract migrations for ordinary rolling deploys.

The authoritative topology, variable matrix, promotion flow, and migration
runbook live in
[`docs/deployment-environments.md`](../../docs/deployment-environments.md).

The service and desktop release independently. API changes therefore remain
backward compatible until deployed desktop versions no longer use the previous
contract. Add new fields or routes first; remove old ones only after observed
client migration.

### WorkOS browser/desktop authorization and account lifecycle

In WorkOS mode, `GET /auth/start`, `GET /auth/callback`,
`GET /auth/browser/session`, `POST /auth/browser/refresh`, and
`GET /auth/logout` are Railway-owned. Migration `0012` stores only SHA-256
digests of random browser credentials and OAuth state. PKCE verifiers are
single-use, access tokens are not stored as table columns, and encrypted sealed
sessions are refreshed under a PostgreSQL advisory/row lock so multiple
Railway replicas cannot race rotation.

After a successful callback, Railway sets the host-only `SameSite=Strict`
session cookie on a no-store, no-referrer `200` completion document. That
document immediately navigates to the previously validated same-origin return
URL. Do not replace it with a `3xx`: browsers retain the cross-site AuthKit
navigation context across redirect hops and will correctly withhold the Strict
cookie, making the first signed-in page appear signed out.

Both Web and Desktop authorization URLs always select `provider=authkit`.
Hosted AuthKit owns provider choice, credentials, verification, MFA, recovery,
and identity linking. Caller-supplied provider, connection, or organization
selectors are ignored and never reach the WorkOS SDK.

WorkOS Multiple Applications deliberately use one issuer for every application
in an environment: the issuer references the default Application, while the
signed `client_id` identifies the current web or desktop Application. Configure
`AUTH_ISSUER` and `AUTH_JWKS_URL` from that environment/default Application,
then allowlist both distinct client IDs. Do not point desktop builds or cloud
engine verification at a second issuer/JWKS; all three surfaces enforce the
same exact issuer and distinguish desktop tokens by `client_id`.

`GET /auth/desktop/start` is a public, stateless compatibility entry point for
Pages and older releases. It accepts only bounded exact-channel state and an
S256 challenge, uses `AUTH_DESKTOP_CLIENT_ID`, and fixes the WorkOS redirect to
`${APP_ORIGIN}/auth/desktop/callback`. It never accepts a caller-selected
client, callback, connection, organization, or provider. Electron main retains
the matching verifier and exchanges the returned code directly as the public
Desktop Application.

There is no application-owned email-verification continuation and no endpoint
that accepts pending WorkOS credentials. Hosted AuthKit must finish
verification before returning a usable code. Browser exchange then requires a
verified user and authenticates the sealed session before promotion; Electron
verifies the signed Desktop Application token again before storage.

`POST /auth/workos-webhook` verifies WorkOS's official signature over the exact
bounded raw body on Railway. It consumes user, session, organization,
organization-membership, and invitation events. The existing app-host endpoint
is a byte-preserving pass-through during rollout; new WorkOS endpoint
configuration targets the channel API origin directly.

The webhook is the low-latency path; a leased Events API reconciler with a
durable cursor is the missed-delivery repair path. Event IDs are idempotent,
provider object timestamps reject stale updates, unsupported signed payloads
are quarantined without logging their body, and cursors do not skip an event
that failed transactionally. Zeros mutations use an ordered transactional
command outbox. Provider conflicts/lost responses converge by listing the
existing object, and terminal failures dead-letter for operator action.

Verified profile updates remain subject-linked. An occupied email never
transfers ownership. `user.deleted` disables the identity/account, revokes
known sessions and endpoint grants, removes collaborative memberships, emits
security revisions, and queues notification email while preserving Personal
and product data. While that retained account has not completed final purge, a
same-email replacement subject enters a 24-hour recovery request. Only a
freshly authenticated platform owner may approve it; approval is audited,
notifies the owner, and does not restore collaborative access. After final
Zeros purge there is no account to recover: a new provider subject is a fresh
signup, while the exact erased subject remains permanently fenced.

Migration `0061` stores only append-only, domain-separated subject hashes and a
per-purge reconciliation disposition. After its drained rollout, inspect
historical readiness as the database owner:

```sh
pnpm --dir apps/control-plane workos-erasure:manage --status
# Production image (/app):
node dist/manage-workos-provider-erasure.js --status
```

Unknown-subject login and event ingestion remain retryably unavailable until
every historical purge has exact provider-audit evidence. Reconcile one request
at a time with a read-only plan and unchanged `--execute` request; never save
the one-shot `CONTROL_PLANE_WORKOS_ERASURE_*` variables on the service or put
raw provider IDs in the evidence reference. The complete variables, privacy
contract, and production confirmation are documented in
[`docs/workos-authentication-migration.md`](../../docs/workos-authentication-migration.md#account-deletion-replacement-and-recovery).

`GET /v1/auth/snapshot` and `GET /v1/auth/events` provide current revision state
and a replayable authenticated SSE stream. They replace periodic WorkOS polls:
clients snapshot at launch and after a silent/disconnected lifecycle hint,
while every protected API request continues to enforce the local projection.
Directory-managed memberships are marked `scim` and cannot be role-edited or
removed through Zeros local administration.

Operators must alert on `[workos-sync] ... dead-lettered`, a non-advancing
`workos_event_cursors.updated_at`, webhook delivery failures in WorkOS, and
`security_notification_outbox.state='dead'`. Do not manually mark a row
succeeded. Inspect the bounded error code and current provider/local object,
repair the root cause, then use a reviewed replay/requeue procedure. A public
`/healthz` success proves HTTP/database availability only; it is not proof that
provider synchronization or email delivery is current.

Resend delivery is at-least-once from the durable outbox and uses the outbox
UUID as Resend's 24-hour idempotency key. The accepted Resend message ID is
stored on the row for provider-log correlation. Provider migrations never
replay old rows implicitly: migration `0019` preserves unfinished ZeptoMail
rows as `dead`/`legacy_zeptomail`; a reviewed replay creates a new
Resend-owned row instead of changing the historical provider field. Keep open
and click tracking disabled for security notifications, restrict every runtime
key to sending from the exact verified domain, and use a separate key per
deployment channel.

## Organization API

The authenticated surface is organization-first:

| Route                                    | Purpose                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /v1/me`                             | Account plus Personal-first organization summaries and capability metadata       |
| `POST /v1/organizations`                 | Create an organization, owner membership, and default team atomically            |
| `GET/PATCH/DELETE /v1/organizations/:id` | Read or manage an organization; Personal mutation is rejected                    |
| `/v1/organizations/:id/members`          | Membership, role, leave, and last-owner-safe removal operations                  |
| `/v1/organizations/:id/invitations`      | Exact-email, expiring organization invitations                                   |
| `GET/POST /v1/organizations/:id/teams`   | List the default team; additional creation returns a capability error for now    |
| `GET /v1/organizations/:id/billing`      | Organization-scoped plan/seat metadata; payment management remains disabled      |
| `/v1/organizations/:id/settings`         | Remote organization settings; Personal reads empty/local-only and rejects writes |

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

## Cloud workspaces and agent credentials

Cloud v2 uses a small VM worker, the control-plane relay and database history.
See [cloud workspaces](../../docs/cloud-workspaces.md) for its runtime and
configuration. Account and organization deletion mark their v2 workspaces
`deleting`; the lifecycle removes the VMs before final row erasure.

Settings → Agents retains `/v1/cloud-agent-credentials/*`, organization agent
connections and public credential-removal receipts. Workspace delegation and
private engine boot/control APIs have been removed.

The `CLOUD_WORKSPACE_SECRET_KEY_V1`, `CLOUD_WORKSPACE_SECRET_KEYS_JSON`,
`CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION` and
`CLOUD_CODEX_REFRESH_FINGERPRINT_*` names are persisted encryption and deployment
contracts. Keep all readable versions while credentials or restorable backups
reference them. The selected secret key seals new vault material; the separate
Codex fingerprint keyring protects renewal replay detection.

## Organization cloud-entitlement activation

Use the database-owner command to record an explicit current Organization
plan and exact active seat set. Never activate either with ad-hoc SQL. The
Organization must be active, non-Personal, cloud-enabled, linked to one active
WorkOS Organization, and every requested seat must identify an active member.
The accountable actor must be an active `platform_owner`.

Set `DATABASE_URL` and these one-shot inputs in a controlled operator shell:

- `CONTROL_PLANE_CLOUD_ENTITLEMENT_CHANNEL`, matching
  `RAILWAY_ENVIRONMENT_NAME` when present;
- `CONTROL_PLANE_CLOUD_ENTITLEMENT_ORGANIZATION_ID` and
  `CONTROL_PLANE_CLOUD_ENTITLEMENT_EXPECTED_ORGANIZATION_SLUG` for the same
  exact Organization;
- `CONTROL_PLANE_CLOUD_ENTITLEMENT_ACTOR_USER_ID` for the accountable platform
  owner;
- `CONTROL_PLANE_CLOUD_ENTITLEMENT_PLAN` (`pro`, `business`, or `enterprise`)
  and `CONTROL_PLANE_CLOUD_ENTITLEMENT_STATUS` (`active` or `trialing`);
- `CONTROL_PLANE_CLOUD_ENTITLEMENT_VALID_FROM` as an ISO-8601 timestamp and
  `CONTROL_PLANE_CLOUD_ENTITLEMENT_VALID_UNTIL` as a later timestamp or the
  explicit value `none`;
- `CONTROL_PLANE_CLOUD_ENTITLEMENT_SEAT_LIMIT` and
  `CONTROL_PLANE_CLOUD_ENTITLEMENT_ACTIVE_SEAT_USER_IDS`. Business/Enterprise
  require a positive purchased limit and a comma-separated, duplicate-free list
  of active member UUIDs within that limit. Pro requires both values to be
  `none` and also fails closed unless every current collaborator already has
  current Pro account authority; and
- `CONTROL_PLANE_CLOUD_ENTITLEMENT_REASON`, a 16–512 character audit reason.

Generate a read-only plan, copy its exact target-bound approval value into
`CONTROL_PLANE_CLOUD_ENTITLEMENT_APPROVAL`, then execute:

```sh
# Source checkout
pnpm --dir apps/control-plane cloud-entitlement:manage
pnpm --dir apps/control-plane cloud-entitlement:manage --execute

# Production image (/app)
node dist/manage-cloud-workspace-entitlement.js
node dist/manage-cloud-workspace-entitlement.js --execute
```

Production execution also requires
`CONTROL_PLANE_CLOUD_ENTITLEMENT_PRODUCTION_CONFIRMED=true`. The command locks
and revalidates the Organization, WorkOS link, actor, members, current billing
source, entitlement, validity, and seats. It refuses to overwrite Stripe,
contract, or migration authority and writes an immutable
`cloud_workspace_entitlement_changes` row in the same transaction. Entitlement activation
does not enable `CLOUD_V2_ENABLED` or create provider resources.

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

Identity always comes from the verified provider token, never the JSON body. The
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
- Per-user rate limits run before external-provider work; provider and signup
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
flows, health checks, guarded migrations and startup ledger verification in a disposable staging
environment.

Individual Pro grants and revocations during the staff pilot use the explicit
`pnpm --dir apps/control-plane account-pro:manage` operator command.
They are independent of staff roles and organization activation.
