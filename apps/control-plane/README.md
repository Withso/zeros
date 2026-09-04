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
| `DATABASE_URL`           | PostgreSQL connection string; use Railway's private-network URL in production                                                                    |
| `AUTH_PROVIDER`          | `auth0` during compatibility rollout, or `workos` after client cutover                                                                           |
| `AUTH_AUDIENCE`          | Expected access-token audience                                                                                                                   |
| `AUTH_ISSUER`            | Exact WorkOS environment/default-Application issuer; required in WorkOS mode, optionally comma-separated only for legacy Auth0                 |
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

Authentication foundation migrations after the original Hosted AuthKit slice:

| Migration | Durable contract |
| --------- | ---------------- |
| `0013_auth_lifecycle.sql` | stable account/identity/session lifecycle, provider tombstones, auth revisions |
| `0014_workos_organization_sync.sql` | collaborative organization/member/invitation projections plus ordered command/event outboxes |
| `0015_security_events.sql` | organization/account/data revisions, replayable security events, endpoint-grant revocation hooks |
| `0016_account_recovery.sql` | fresh-auth reviewed recovery and at-least-once security-notification outbox |

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

### Clean authentication cutover reset

Prefer attaching a fresh channel-local Postgres service and running migrations.
When Alpha or Beta must be reset in place, `reset:database` provides a guarded
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
   schema replays the full migration ladder, also include every currently
   required controlled-downtime migration approval (currently `0009`), then
   execute:

   ```bash
   CONTROL_PLANE_RESET_CHANNEL=alpha \
   CONTROL_PLANE_RESET_BACKUP_CONFIRMED=true \
   CONTROL_PLANE_RESET_APPROVAL='reset:alpha:<target-fingerprint>' \
   CONTROL_PLANE_MIGRATION_APPROVALS=0009_organization_team_hierarchy.sql \
   pnpm reset:database -- --execute
   ```

Execution drops and recreates the entire `public` schema, then replays every
migration. It is not a partial user deletion. `RAILWAY_ENVIRONMENT_NAME`, when
present, must exactly match the selected channel. Keep the previous database or
backup available until Alpha acceptance is complete.

## Railway deployment

Configure the Railway service root as `apps/control-plane`. The colocated
[`Dockerfile`](Dockerfile) builds the service and
[`railway.json`](railway.json) configures `/healthz`, restart behavior, and the
Dockerfile builder.

Use one Railway project with persistent `alpha`, `beta`, and `production`
environments. Each environment has its own control-plane instance, Postgres,
authentication contract, GitHub App, feedback destinations, and public domain.
Production autodeploy stays disabled; only Alpha tracks `main`.

Before a production deployment:

1. Provision PostgreSQL with backups and a pinned supported major version.
2. Set `DATABASE_URL`, the selected provider's complete `AUTH_*` block, and
   `NODE_ENV=production` in Railway. WorkOS mode additionally requires
   `APP_ORIGIN`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`, and
   `WORKOS_WEBHOOK_SECRET`. None belongs in Pages or a desktop build.
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
and product data. A same-email replacement subject enters a 24-hour recovery
request. Only a freshly authenticated staff operator may approve it; approval
is audited, notifies the owner, and does not restore collaborative access.

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

## Gated cloud-workspace lifecycle

Cloud workspace lifecycle is a disabled-by-default, pre-production surface.
Setting a provider key does not enable it: `CLOUD_WORKSPACES_ENABLED=true`, a
complete exact-pinned cloud block, and a valid GitHub App RSA private key are
all required at boot. Each approved Organization additionally needs a quota row
and a durable object-storage limit row created through their respective owner
commands; neither has a permissive default.

The authenticated Organization surface is:

| Route                                                   | Purpose                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `GET/POST /v1/organizations/:id/cloud-workspaces`       | List authorized workspaces or request an idempotent create  |
| `GET /v1/organizations/:id/cloud-workspaces/:workspace` | Read one team-authorized workspace                          |
| `POST .../:workspace/stop`                              | Request a durable stop intent                               |
| `POST .../:workspace/wake`                              | Request wake after rechecking current eligibility and quota |
| `POST .../:workspace/archive`                           | Request stop-plus-archive reconciliation                    |
| `DELETE .../:workspace`                                 | Revoke endpoint grants, then request verified deletion      |

Mutating requests require an `Idempotency-Key`; replaying the same key and
semantic request returns the original workspace/intent, while reusing it for
different parameters returns `409`. Public documents contain the stable Zeros
workspace id, never Daytona's resource id. PostgreSQL records the immutable
image, architecture, source commit, and resource allocation per generation.
The provider reconciler uses leases, observes before mutating, recovers lost
create responses, converges drift, and only deletes a managed true orphan after
repeat observation plus a grace period.

### Cloud-workspace quota provisioning

`cloud_workspace_quotas` is an explicit paid-resource admission gate. Never
create or edit its rows with ad-hoc SQL. Use the database-owner command from a
controlled Railway shell or equivalent operator workstation, and do not persist
its one-shot variables on the service. The target Organization must be active,
non-Personal, cloud-enabled, and have a current cloud entitlement. The
accountable actor must be an active `platform_owner`.

Set `DATABASE_URL` plus these target-bound inputs:

- `CONTROL_PLANE_CLOUD_QUOTA_CHANNEL` — `development`, `alpha`, `beta`, or
  `production`; it must match `RAILWAY_ENVIRONMENT_NAME` when present.
- `CONTROL_PLANE_CLOUD_QUOTA_ORGANIZATION_ID` and
  `CONTROL_PLANE_CLOUD_QUOTA_EXPECTED_ORGANIZATION_SLUG` — both must resolve to
  the same exact Organization.
- `CONTROL_PLANE_CLOUD_QUOTA_ACTOR_USER_ID` — the accountable platform owner's
  Zeros UUID.
- `CONTROL_PLANE_CLOUD_QUOTA_MAX_WORKSPACES` and
  `CONTROL_PLANE_CLOUD_QUOTA_MAX_RUNNING_WORKSPACES` — positive limits, with
  running no greater than total.
- `CONTROL_PLANE_CLOUD_QUOTA_MAX_CPU_MILLICORES`,
  `CONTROL_PLANE_CLOUD_QUOTA_MAX_MEMORY_MIB`, and
  `CONTROL_PLANE_CLOUD_QUOTA_MAX_STORAGE_MIB` — aggregate limits large enough
  for current usage and the deployment's pinned per-generation resources.
- `CONTROL_PLANE_CLOUD_QUOTA_REASON` — a 16–512 character audit reason.

Generate a read-only plan first:

```sh
pnpm --dir apps/control-plane cloud-quota:manage
```

The command prints an approval string bound to the database fingerprint,
channel, Organization, actor, current quota, requested quota, and a hash of the
reason. Copy the exact value into `CONTROL_PLANE_CLOUD_QUOTA_APPROVAL`, then
execute:

```sh
pnpm --dir apps/control-plane cloud-quota:manage --execute
```

Production additionally requires
`CONTROL_PLANE_CLOUD_QUOTA_PRODUCTION_CONFIRMED=true`. Execution re-locks and
revalidates every fact, rejects a stale plan or a quota below current usage,
and appends an immutable `cloud_workspace_quota_changes` record in the same
transaction. Creating a quota does not enable cloud routes or setup execution;
the two feature gates remain separate release decisions.

### Durable object-storage limit provisioning

`cloud_workspace_object_storage_limits` bounds the coordinator-owned encrypted
object volume. It is deliberately separate from both
`cloud_workspace_quotas.max_storage_mib` (sandbox disks) and the storage
provider's physical volume quota. A missing row rejects new object publication;
there is no default derived from either provider setting.

The Organization limit counts tenant-deduplicated physical blobs in upload,
available, quarantine, and deletion states, plus copy-on-write key-rotation
headroom. The workspace limit counts each unique blob reserved by that
workspace. Retrying one hash does not charge it twice, while two workspaces that
share one tenant blob each consume their own logical workspace allowance.

Use the database-owner command from a controlled shell. Set `DATABASE_URL` and:

- `CONTROL_PLANE_CLOUD_OBJECT_STORAGE_CHANNEL` — the exact deployment channel,
  matching `RAILWAY_ENVIRONMENT_NAME` when present;
- `CONTROL_PLANE_CLOUD_OBJECT_STORAGE_ORGANIZATION_ID` and
  `CONTROL_PLANE_CLOUD_OBJECT_STORAGE_EXPECTED_ORGANIZATION_SLUG` — the same
  active, non-Personal, cloud-enabled Organization;
- `CONTROL_PLANE_CLOUD_OBJECT_STORAGE_ACTOR_USER_ID` — an active
  `platform_owner` UUID;
- `CONTROL_PLANE_CLOUD_OBJECT_STORAGE_MAX_ORGANIZATION_BYTES` and
  `CONTROL_PLANE_CLOUD_OBJECT_STORAGE_MAX_WORKSPACE_BYTES` — positive exact
  byte counts, not MiB values; the workspace ceiling must not exceed the
  Organization ceiling; and
- `CONTROL_PLANE_CLOUD_OBJECT_STORAGE_REASON` — a 16–512 character audit
  reason.

Generate a target-bound read-only plan, copy its approval value into
`CONTROL_PLANE_CLOUD_OBJECT_STORAGE_APPROVAL`, then execute the same request:

```sh
pnpm --dir apps/control-plane cloud-object-storage:manage
pnpm --dir apps/control-plane cloud-object-storage:manage --execute
```

Production execution additionally requires
`CONTROL_PLANE_CLOUD_OBJECT_STORAGE_PRODUCTION_CONFIRMED=true`. Execution locks
and revalidates the current target, refuses limits below physical or logical
usage, and appends immutable owner evidence to
`cloud_workspace_object_storage_limit_changes`. Migration `0055` intentionally
does not invent rows for existing Organizations: provision reviewed limits
before re-enabling object-writing clients or the rotation worker. Size the
provider volume above the aggregate application limits for filesystem metadata,
temporary publication files, backups, and operational response headroom.

### Secret keyring rotation

`CLOUD_WORKSPACE_SECRET_KEY_V1` remains a compatible single-key deployment.
For rotation, set `CLOUD_WORKSPACE_SECRET_KEYS_JSON` to every version still
needed for decryption and set `CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION` to
the version used for new secret-binding versions and setup material. The
binding verifier is a contextual HMAC derived from that version's envelope key;
the database no longer stores a raw value digest that could act as an offline
dictionary oracle. Migrated bindings have no verifier and are compared only
after authenticated decryption.

Deploy old and new keys together first, select the new current version, rotate
bindings, and replace generations so newly emitted setup material uses it.
Retire an old key only after no retained binding or setup-material row—and no
backup that must remain restorable—depends on that version. The secret keyring
and `CLOUD_WORKSPACE_OBJECT_KEYS_JSON` are independent cryptographic domains.

Provider creation queues a setup run and leaves the workspace in `setting_up`
while `CLOUD_WORKSPACE_SETUP_WORKER_ENABLED=false`. The setup worker,
workspace-bound admission and engine grant issuer are implemented, but remain
behind that separate operator gate until the exact Daytona image, lifecycle,
root-coordinator decision, and signed macOS access paths complete protected
qualification. End-user cloud catalog, creation, details, and management UI is
also intentionally unwired. Configuration and safe defaults are documented in
[`.env.example`](.env.example).

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
flows, health checks, and migration startup in a disposable staging
environment.
