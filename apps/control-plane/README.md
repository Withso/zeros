# Control plane

Railway-hosted API for Zeros identity, organizations, child teams, invitations,
organization settings,
GitHub App coordination, authenticated feedback delivery, audit records, and
rate limiting. It owns its Postgres
schema and is deployed independently from the desktop application.

## Runtime boundary

- Node.js 22, Hono, PostgreSQL, `jose`, and plain SQL migrations.
- WorkOS issues access tokens; this service verifies JWT signatures, exact
  issuer, audience, expiry, and required claims locally against JWKS, and
  enforces the Web/Desktop Application allowlist and session/token identifiers.
- Railway also owns browser PKCE exchange, encrypted sealed
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
| `AUTH_PROVIDER`          | Optional; the only accepted value is `workos`                                                                                                    |
| `AUTH_AUDIENCE`          | Expected access-token audience                                                                                                                   |
| `AUTH_ISSUER`            | Exact WorkOS environment/default-Application issuer                                                                                              |
| `AUTH_JWKS_URL`          | Exact public signing JWKS for that WorkOS environment/default Application                                                                        |
| `AUTH_WEB_CLIENT_ID`     | Allowed WorkOS Web Application client ID                                                                                                         |
| `AUTH_DESKTOP_CLIENT_ID` | Allowed WorkOS Desktop Application client ID                                                                                                     |
| `APP_ORIGIN`             | Exact channel app origin used for the browser callback and safe returns                                                                          |
| `WORKOS_API_KEY`         | WorkOS server API key; Railway-only                                                                                                              |
| `WORKOS_COOKIE_PASSWORD` | Unique 32+ character key for WorkOS sealed sessions; Railway-only                                                                                |
| `WORKOS_WEBHOOK_SECRET`  | Exact WorkOS endpoint signing secret; Railway-only                                                                                               |
| `RESEND_API_KEY`         | Optional Railway-only, sending-only Resend key for Zeros product/security notifications                                                          |
| `EMAIL_FROM`             | Optional verified Resend sender, for example `Zeros <notifications@updates.zeros.build>`                                                         |
| `ZEROS_SELF_HOSTED`      | Public templates only: `true` allows installer-owned platform domains; frontend and API origins must differ; official deployments leave it unset |
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
[`Dockerfile`](Dockerfile) builds the service. Each environment's Railway
service settings select that Dockerfile and set the `/healthz` health check and
restart behavior; [`.railway/railway.ts`](../../.railway/railway.ts) records
the same settings for Railway's Infrastructure as Code.

Use one Railway project with persistent `alpha`, `beta`, and `production`
environments. Each environment has its own control-plane instance, PlanetScale Postgres database,
authentication contract, GitHub App, feedback destinations, and public domain.
Production autodeploy stays disabled; only Alpha tracks `main`.

Before a production deployment:

1. Provision PlanetScale Postgres with backups and a qualified supported major version.
2. Set `DATABASE_URL`, the complete WorkOS `AUTH_*` block, `APP_ORIGIN`,
   `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`, `WORKOS_WEBHOOK_SECRET`, and
   `NODE_ENV=production` in Railway. None belongs in Pages or a desktop build.
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

`GET /auth/start`, `GET /auth/callback`,
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

The web sign-in page's Continue with Google and Continue with GitHub send one
exact `provider=google` or `provider=github`, which the app's `/auth/start`
maps to `GoogleOAuth` or `GitHubOAuth`. Every other Web, Ops and Desktop
authorization URL selects `provider=authkit`, where Hosted AuthKit owns provider
choice, credentials, verification, MFA, recovery and identity linking. Any other
provider value, and every connection or organization selector, is ignored and
never reaches the WorkOS SDK.

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

Refresh bindings are signed with a separate key so rotating the OAuth client
secret never invalidates them. Railway Alpha, Beta and Production refuse to
boot without `GITHUB_REFRESH_BINDING_SECRET` (key version 1) or
`GITHUB_REFRESH_BINDING_KEYS_JSON` (`{"<version>":"<secret>"}`, 1–32 versions,
with `GITHUB_REFRESH_BINDING_CURRENT_KEY_VERSION` when there is more than one).
New bindings are signed with the current version; every listed version still
verifies the bindings it signed, and each refresh re-signs with the current
one. Development and self-hosted deployments may still fall back to the client
secret, with a warning on Railway. Rotation steps are in
`docs/deployment-environments.md`. Keep the client and binding secrets
server-side. Callback URLs must return to the matching web
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

## Shared execution activation

Shared execution stays disabled until an operator prepares and activates one
exact workspace. There is no HTTP activation route. The command requires the
database migration owner and an active `platform_owner`; the application role
can advance an existing transition but cannot create an activation or its
approval receipts. Use a controlled operator shell with the intended
`DATABASE_URL`. This procedure does not authorize a live deployment by itself.

Set `CLOUD_EXECUTION_CHANGE_FILE` to a regular JSON file containing exactly:

```json
{
  "activationId": "00000000-0000-4000-8000-000000000001",
  "action": "prepare",
  "channel": "development",
  "organizationId": "00000000-0000-4000-8000-000000000002",
  "workspaceId": "00000000-0000-4000-8000-000000000003",
  "initiatorUserId": "00000000-0000-4000-8000-000000000004",
  "operatorUserId": "00000000-0000-4000-8000-000000000005",
  "runtimeSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "reason": "Explicit approval for this workspace rollout"
}
```

Replace the example identifiers and digest with reviewed values. The channel is
`development`, `alpha`, `beta` or `production` and must match
`RAILWAY_ENVIRONMENT_NAME`, or `CONTROL_PLANE_EXECUTION_CHANNEL` outside Railway.
The reason is 16–512 characters; only its hash is retained. The initiator is the
person whose current membership and repository access will authorize the fresh
boot, with no Creator fallback. The runtime digest identifies the reviewed
worker that supports `acting-user-v1` and legacy-material cleanup.

```sh
pnpm --dir apps/control-plane cloud-execution:manage
# Inspect the plan; set CLOUD_EXECUTION_PLAN_SHA256 to its exact planSha256.
pnpm --dir apps/control-plane cloud-execution:manage --execute
```

The deployed-image equivalent is `node dist/manage-cloud-execution.js`, with
the same optional `--execute`. Planning is read-only. The approval hash binds
the channel, routed database identity, organization, workspace, operator,
initiator, source and permission revisions, run, runtime digest and action.
Changed authority or a stale approval refuses execution. Repeating a committed
action with the same activation identity and approval is inert.

Temporary operator roles may rotate between steps. A `v2:<16 hex digits>`
target fingerprint binds the channel, actual database name, migration owner
(`current_user`), and stable cluster route. For PlanetScale the route includes
the direct host, port and branch suffix of the routed username; other
PostgreSQL targets use the host, port and `pg_control_system().system_identifier`.
The temporary login name is excluded. Planning refuses when the database
identity cannot be read. The existing digest column stores the 16 hex digits;
`prepared_snapshot.targetFingerprintVersion: 2` identifies this format.
No credential or connection string is stored in either field.

An older activation has no fingerprint version and was bound to its original
login. Once that temporary role is deleted, use the recovery option only for
`rollback`: inspect its existing `target_fingerprint`, then add
`"legacyTargetFingerprint": "<the inspected 16 hex digits>"` to the original
change document. Keep the exact activation, organization, workspace, operator,
initiator, runtime and reason. Obtain and approve a fresh rollback plan under
the current role. Recovery requires the completed provider Stop for the same
generation, a stopped workspace, no worker bearer or transition, and no
unretired execution context. Its approval and replay receipt also bind the
current stable database identity. Recovery never rewrites the stored target,
accepts a version-2 target, or enables `prepare` or `activate`. After rollback,
prepare a new activation with a new id. An old prepared-only plan can instead
be superseded by an ordinary new `prepare` while its lifecycle is idle.

`prepare` preserves current execution, tokens and N-1 visibility. Existing
workspaces need a version-2 seed journal before activation. If the journal is
version 1, perform one ordinary Stop/Start on the current runtime while still
legacy or prepared, then Stop. That boot upgrades the journal using the pinned
configuration's content digests and preserves the person's file edits. Prepare
a fresh activation after this cycle: the previous boot/run snapshot is stale.
Then change only `action` to `activate`, obtain a new plan and approve it.
The operator's `bootClean.seedJournal` reports `outdated` when a retained
refusal proves it; `unknown` means the server has not observed the journal.
Planning does not inspect or wake a VM. When the version is unknown, perform
the legacy/prepared cycle before preparing the final activation.

Activation blocks new prompts, connects and starts; advances the access epoch;
cancels pending work; and records a durable drain. The normal lifecycle must
confirm provider Stop before starting the pinned runtime. Each lifecycle
replica can resume the stored phase after a restart. Stop, archive, deletion,
membership loss or changed source authority wins over the rollout. The first
closed failure is retained; the transition has a 30-minute deadline.

The new worker's hello binds a fresh boot and returns no personal material.
Readiness and every execution lease wait for that boot's process cleanup and
`legacyMaterial: "none" | "removed"` attestation. Missing or refused cleanup
keeps execution closed and stops the attempted rollout. The worker owns
descriptor-checked removal of managed legacy files; the control plane never
scripts their deletion. The server-side Creator environment pin is retained.
Managed file removal uses the version-2 journal's SHA-256 of the exact seeded
bytes, a regular file owned by the worker user, and a root-anchored path walk
without following links. Device and inode numbers are not proof across boots.
A version-1 journal refuses with `seed_journal_outdated`. Modified bytes refuse
with `seed_target_modified` and remain on disk: the Creator must remove the
file or restore its intended seeded content before retrying activation.
First complete the failed rollout's provider Stop and rollback; do not retry
cleanup or activate around its fence. Then use the legacy/prepared upgrade
cycle, prepare a new activation and activate it.

The worker may include a sorted, unique, nonempty `refusals` array of at most
24 closed classes. No paths, digests, values or raw errors enter this field.
The boot keeps its latest classes and preserves its first failure, including
an unknown first diagnostic. The activation and operator output retain the
first classes in `bootClean.refusals`; `null` means unreported. A committed
first failed boot logs `[cloud-v2] activation boot-clean refused classes=...`
with only the closed classes and a workspace UUID prefix. Diagnostics never
relax the clean-boot requirement; old workers without the field still refuse
or succeed by the same process/material rules.

Initial activation refuses a lost VM that needs checkpoint restoration. It
retains the checkpoint and completes Stop; the operator can roll back, restore
in legacy mode, and prepare again. Later wakes of an active workspace retain
thin checkpoints. On a newly created organization snapshot VM only, the control
plane fetches Git objects with the persisted initiator's repository credential
before unpacking any checkpoint content. Git starts with a fresh repository,
system/global configuration, hooks, helpers and redirects disabled. Bundle
application after the fetch is offline. A denied initiator receives
`github_access_required`; the Creator's credential is never substituted.
Active restores exclude journal-managed environment targets from the Git
working tree and ignored-file archive, and never apply `environment.tar` to
the checkout. This also covers a retained legacy checkpoint from before
activation. The original workspace pin stays on the server; each execution
lease selects its acting person's environment. Legacy restores continue
restoring their environment files; checkpoint capture accepts seed journal
versions 1 and 2.

The restore consumes a durable attempt before releasing the credential. An
uncertain fetch or unpack cannot receive another credential on that VM: retry
must confirm deletion and create a new snapshot VM. The provider command
channel sees the credential, as it does in legacy restore. Inside the VM it is
written only to a random `/dev/shm/zeros-restore-auth-XXXXXXXXXX/token` file
(private 0700 directory, 0600 file, verified tmpfs), read through askpass, then
removed and checked absent before unpacking. It is absent from Git arguments,
configuration and output. Boot cleanup removes proven owned leftovers or
refuses. This is the sole restore exception to waiting for boot-clean before
personal credential delivery. It uses the narrowest available credential:
read-only repository installation tokens for an App connection, or the
initiator's existing PAT when that connection cannot be downscoped. The broker
cache deadline does not shorten GitHub's token lifetime.

A `rollback` plan requires a completed provider Stop for the current generation,
no live contexts and no worker token. It leaves the workspace stopped, changes
it back to legacy mode and never restores old tokens or starts it. Any later
legacy start requires a new explicit action. A new `prepare` can supersede an
obsolete prepared plan; failed or cancelled rollouts require rollback first.
Up to 128 activation records and their three action receipts are retained per
workspace until workspace deletion. Replays still work at that limit; new
plans refuse instead of silently dropping the audit history.

Migration `0240_cloud_execution_activation.sql` adds a restrictive workspace
RLS predicate. Transactions use the central DB helpers to set
`app.cloud_execution_protocol=1` locally within the transaction. Prepared-only
rows remain visible to released replicas. A transition or active workspace is
hidden from an N-1 transaction, even under `app.system=on`. This is a protocol
fence, not authorization: `zeros_app` can set the marker deliberately, so
ordinary session, membership and repository checks remain mandatory. Never set
the marker at session scope or through connection options on a pooled backend.
Already-started external work is not retroactively revoked; provider-confirmed
Stop and the new boot's cleanup separate it from new execution.

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
