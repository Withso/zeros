# Hosted deployment environments

Zeros uses the same promotion ladder for the hosted application and the macOS
application:

```text
main ────────────────> Alpha
  └─ release/X.Y.Z ─> Beta
       └─ same SHA ─> Production (manual)
```

Merging to `main` is an Alpha action, not a Production action. Production must
never continuously deploy `main`; it is a manual promotion of the exact commit
that Beta validated.

## Deployment topology

| Channel    | Source                                 | Railway                                                    | Cloudflare surfaces                     | Public origins                                                             |
| ---------- | -------------------------------------- | ---------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| Alpha      | `main`                                 | `alpha` environment: control plane + isolated PlanetScale Postgres      | `zeros-web-alpha`, `zeros-ops-alpha`    | `api-alpha.zeros.build`, `app-alpha.zeros.build`, `ops-alpha.zeros.build`  |
| Beta       | current `release/X.Y.Z`                | `beta` environment: control plane + isolated PlanetScale Postgres       | `zeros-web-beta`; **no Ops deployment** | `api-beta.zeros.build`, `app-beta.zeros.build`                             |
| Production | the same release commit Beta validated | `production` environment: control plane + isolated PlanetScale Postgres | `zeros-web`, `zeros-ops`                | `api.zeros.build`, `app.zeros.build`, `ops.zeros.build`, marketing domains |

This remains one backend codebase and one frontend codebase. Each channel is an
isolated deployment instance with independent data, credentials, sessions, and
domains.

Railway supports named persistent environments, so keep one Railway project and
the same logical control-plane service in all three environments. Each channel uses
its own PlanetScale database and runtime login. Never share `DATABASE_URL` across them.

Cloudflare Pages exposes only `production` and one shared `preview`
configuration inside a project. Preview branches share variables and bindings,
so a single Pages project cannot safely represent independent Alpha and Beta
environments. Use five release Pages projects from the same `apps/web` source:
three customer-app projects plus the Alpha and Production Ops projects. Each
channel uses that project's Production configuration; do not treat Pages
Preview as a Zeros release channel.

Platform references:

- [Railway environments](https://docs.railway.com/environments)
- [Railway GitHub autodeploy controls](https://docs.railway.com/deployments/github-autodeploys)
- [Cloudflare Pages production and preview configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)
- [Cloudflare Pages branch deployment controls](https://developers.cloudflare.com/pages/configuration/branch-build-controls/)
- [Cloudflare Pages deploy hooks](https://developers.cloudflare.com/pages/configuration/deploy-hooks/)

## Stop Production automation before merging this rollout

Do these first, while the current deployment is still serving:

1. In Railway's `production` environment, disable GitHub autodeploys for the
   control-plane service. Leave the current deployment running.
2. In Cloudflare `zeros-web`, disable automatic Production branch deployments.
   Disable Preview deployments unless a separate preview policy is introduced.
3. Take a restorable Production Postgres backup and record the current Railway
   deployment and Cloudflare deployment commit.
4. Do not merge the organization migration until Alpha and Beta infrastructure
   below exists.

Repository guards are a backstop, not a substitute for those controls:

- Railway detects its injected `RAILWAY_ENVIRONMENT_NAME` and refuses an
  environment/audience/branch mismatch. Production and Beta reject a
  Git-connected `main` deployment.
- Cloudflare builds require `ZEROS_DEPLOY_ENV` and exact channel URLs.
- desktop release workflows reject a channel whose web or API origin points at
  another channel.
- migration `0009_organization_team_hierarchy.sql` requires a one-time explicit
  approval in every production-mode container.

## Railway setup

Create or rename the persistent environments to exactly `alpha`, `beta`, and
`production`. Duplicate the existing service configuration to bootstrap Alpha
and Beta, but provision an isolated PlanetScale PostgreSQL database for each; a
configuration duplicate is not permission to copy or share Production data.

For the control-plane service in every environment:

- repository root directory: `apps/control-plane`
- Dockerfile builder using the colocated `Dockerfile`
- health check: `/healthz`
- service name: `zeros-control-plane`
- one channel-local, unprivileged PlanetScale runtime URL for `DATABASE_URL`
- `DATABASE_MIGRATIONS_ON_BOOT=false`; no permanent migration-owner URL
- watch paths restricted to `apps/control-plane/**` when Railway asks for them

Configure sources and deploy controls as follows **when enabling the ordered
controller**. While it is disabled, existing Alpha/Beta Git autodeploy and
Wait for CI can remain enabled; the disabled guard does not change them.

| Railway environment | Git source                        | Autodeploy               | Wait for CI                   |
| ------------------- | --------------------------------- | ------------------------ | ----------------------------- |
| `alpha`             | `main`                            | **off under the controller** | **off**                     |
| `beta`              | current `release/X.Y.Z`           | **off under the controller** | **off**                     |
| `production`        | current validated `release/X.Y.Z` | **off**                      | **off**                     |

Attach each custom API domain to the matching service instance. Confirm all
three `/healthz` endpoints before configuring a desktop build.

The ordered controller uses `serviceInstanceDeployV2` with the immutable event
SHA. It refuses Railway autodeploy or Wait for CI: waiting for the whole desktop
workflow would create a dependency cycle. Source retargets commit an explicit metadata patch
with `skipDeploys:true`, then re-read the source and autodeploy state before
migration. Never commit unrelated staged dashboard changes during a promotion.

### Railway IaC migration (owner-operated Phase 2)

Railway's official [Infrastructure as Code contract](https://docs.railway.com/infrastructure-as-code)
replaces per-service Config as Code; existing `railway.json`/`railway.toml` files
stop being read on **December 1, 2026**. `.railway/railway.ts` is authored with the
official `railway/iac` TypeScript DSL, checked against SDK `3.12.0`, and is **not
applied by this change or by a release workflow**. Keep
`apps/control-plane/railway.json` until the reviewed migration is complete.

The named `zeros-control-plane` partial describes the existing `zeros` service,
not a new project, database, or secret inventory. It takes the linked project
name, allows only Alpha/Beta/Production, keeps Alpha on `main`, and requires
`RELEASE_BRANCH=release/X.Y.Z` for Beta/Production. Desired settings are Dockerfile
build (`Dockerfile`), root `apps/control-plane`, repository-root watch pattern
`/apps/control-plane/**`, `/healthz` with a 60-second healthcheck timeout, and
`ON_FAILURE` restart with five retries. Those explicit file-controlled settings,
not potentially stale dashboard defaults, are the migration target.

For each channel, the owner must:

1. Install SDK `railway@3.12.0` and Railway CLI `5.42.1` or newer in an isolated
   operator tool directory. Copy the candidate authoring file into that
   directory's `.railway/` so its SDK resolves without changing application
   dependencies or lockfiles. Authenticate without putting token values in
   command arguments, then `railway link` to the **existing** project/environment.
2. Hold competing deploys, disable independent Git autodeploy and Wait for CI,
   and record the current source/configuration/rollback identity. Use
   `railway config partials list` to inspect ownership and confirm the existing
   service is named `zeros`. Do not rename a different existing service to fit
   the candidate or take ownership from another partial implicitly.
3. Back up the candidate file, then `railway config pull --force` in the private
   tool directory to import current configuration. Never use
   `--include-variables` or `--show-values`. Retain imported `preserve()` variable
   references, domains and unrelated live configuration; merge only this
   candidate's source/build/deploy settings and stable partial name. Review any
   ownership transfer separately. A partial protects unrelated resources, but
   does not justify deleting variables from the service it owns.
4. Preview `railway config migrate --service zeros`. Under separate explicit
   owner approval, migrate/clear the legacy Config File setting (the CLI's
   `--apply` is a provider mutation), and remove the legacy repository file in
   the coordinated Phase 2 change. Railway deliberately refuses IaC planning
   while that service is still managed by Config as Code; do not bypass it.
5. Run `railway config plan`, inspect the redacted diff, and stop on unexpected
   resource/variable/domain deletion or unrelated changes. Only after approving
   the exact channel/diff run interactive `railway config apply`. No automatic
   apply action, blanket destructive confirmation, or unreviewed saved plan is
   part of the release pipeline.
6. Require `railway config plan --detailed-exit-code` to return 0, inspect the
   effective source/root/watch/build/health/restart settings, then use the
   ordered controller's explicit exact-SHA deployment and verify anonymous
   `/healthz` and `/v1/release-identity`. Repeat independently for Beta and
   Production; an Alpha plan does not certify either other environment.

IaC settings application does not replace CI, migrations, source-bound
readiness, or protected Production approval. Do not apply while the legacy file
is still effective, and do not delete it merely because authoring tests pass.

### Railway variables

Set these independently in every environment:

| Variable                     | Alpha                                                    | Beta                                                    | Production                                                    |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| `DATABASE_URL`               | Alpha Postgres private reference                         | Beta Postgres private reference                         | Production Postgres private reference                         |
| `AUTH_PROVIDER`              | `auth0` until cutover, then `workos`                     | `auth0` until cutover, then `workos`                    | `auth0` until cutover, then `workos`                          |
| `AUTH_AUDIENCE`              | `https://api-alpha.zeros.build`                          | `https://api-beta.zeros.build`                          | `https://api.zeros.build`                                     |
| `AUTH_ISSUER`                | exact Alpha WorkOS issuer; optional override for Auth0   | exact Beta WorkOS issuer; optional override for Auth0   | exact Production WorkOS issuer; optional override for Auth0   |
| `AUTH_JWKS_URL`              | exact Alpha WorkOS JWKS URL; optional override for Auth0 | exact Beta WorkOS JWKS URL; optional override for Auth0 | exact Production WorkOS JWKS URL; optional override for Auth0 |
| `AUTH_WEB_CLIENT_ID`         | Alpha Web Application in WorkOS mode                     | Beta Web Application in WorkOS mode                     | Production Web Application in WorkOS mode                     |
| `AUTH_DESKTOP_CLIENT_ID`     | Alpha Desktop Application in WorkOS mode                 | Beta Desktop Application in WorkOS mode                 | Production Desktop Application in WorkOS mode                 |
| `APP_ORIGIN`                 | `https://app-alpha.zeros.build` in WorkOS mode           | `https://app-beta.zeros.build` in WorkOS mode           | `https://app.zeros.build` in WorkOS mode                      |
| `OPS_ORIGIN`                 | `https://ops-alpha.zeros.build`                          | unset; startup rejects Ops in Beta                      | `https://ops.zeros.build`                                     |
| `WORKOS_API_KEY`             | Alpha server key in WorkOS mode                          | Beta server key in WorkOS mode                          | Production server key in WorkOS mode                          |
| `WORKOS_COOKIE_PASSWORD`     | unique random Alpha 32+ character secret                 | unique random Beta 32+ character secret                 | unique random Production 32+ character secret                 |
| `WORKOS_WEBHOOK_SECRET`      | Alpha endpoint signing secret                            | Beta endpoint signing secret                            | Production endpoint signing secret                            |
| `AUTH0_DOMAIN`               | legacy fallback until Alpha cutover                      | legacy fallback until Beta cutover                      | legacy fallback until Production cutover                      |
| `NODE_ENV`                   | `production`                                             | `production`                                            | `production`                                                  |
| `INVITE_LINK_BASE`           | `https://app-alpha.zeros.build/invite`                   | `https://app-beta.zeros.build/invite`                   | `https://app.zeros.build/invite`                              |
| `GITHUB_OAUTH_CALLBACK_URL`  | matching Alpha API callback                              | matching Beta API callback                              | matching Production API callback                              |
| `GITHUB_COMPLETION_PAGE_URL` | matching Alpha app page                                  | matching Beta app page                                  | matching Production app page                                  |

Use separate GitHub App registrations per environment. Keep OAuth secrets,
refresh-binding secrets, database credentials, Intercom credentials, and Linear
credentials in Railway only.

The issuer, JWKS URL, audience, and client IDs are public verification values;
they still remain environment-local configuration so channels cannot drift or
accept one another's tokens. The WorkOS API key, cookie password, and endpoint
signing secret are Railway-only. Never put them in Pages, a desktop build,
GitHub variables, command arguments, logs, or repository files.

`INVITE_LINK_BASE` is an exact channel contract, not a free-form redirect. In an
official Railway environment it must equal `${APP_ORIGIN}/invite`, use HTTPS,
and contain no credentials, query, or fragment; startup rejects a wrong-channel
or malformed value. The Pages invitation route derives its installed-app scheme
from the validated `ZEROS_DEPLOY_ENV` (`zeros-alpha`, `zeros-beta`, or `zeros`),
so a query parameter cannot cross channels. Query-selected schemes remain a
local-preview convenience only. Desktop accepts pasted invitations only from
the exact official app hosts or official channel schemes and the exact
`/invite` action, never a lookalike hostname or nested path.

For the clean-slate identity cutover, prefer provisioning a fresh database and
running all migrations. An Alpha/Beta in-place reset must use the guarded
`pnpm --dir apps/control-plane reset:database` procedure in the control-plane
README. It is dry-run by default, requires a backup confirmation plus an exact
target fingerprint, uses the strict migration runner, and currently requires
the comma-separated `0009_organization_team_hierarchy.sql`,
`0025_cloud_workspace_engine_authority.sql`,
`0060_cloud_workspace_pending_blob_deletions.sql`, and
`0061_workos_provider_erasure_fences.sql` migration approvals. It refuses
Production; Production always receives a fresh database service.

### Provision a channel's cloud backend

Use **Cloud backend provision** (`cloud-provision.yml`) from a reviewed
`release/X.Y.Z` ref for Beta, then Production. Production takes the single
`production-approval` review before the channel job reads secrets. Plan and
apply share `hosted-mutation-<channel>` with cutover and promotion; runs never
cancel one another. Alpha apply is refused (the CLI permits a read-only Alpha
plan from `main`). No provisioning run deploys an API or calls Boat, R2 or Resend.

The owner creates only three external credentials per channel, in the `beta`
or `production` GitHub environment: a non-admin runtime `BOAT_API_KEY`, an R2
token scoped to `zeros-cloud-workspaces-<channel>` stored as
`CLOUD_WORKSPACE_S3_ACCESS_KEY_ID` and `CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY`,
and `RESEND_API_KEY`. Reuse the existing channel `RAILWAY_DEPLOY_TOKEN` and
Railway target-ID / `PLANETSCALE_DATABASE` variables. Boat is **one shared
account across Dev and every channel**: the orchestrator supplies the canonical
`BOAT_ACCOUNT_SCOPE` and `BOAT_BILLING_ORG` as GitHub environment **variables**.
Apply requires both inputs even if Railway already has them; neither is generated.

The managed-Boat configuration derived from `apps/control-plane/src/config.ts`
has these sources (all output is names/status only):

| Railway variables | Source / rule |
| --- | --- |
| `BOAT_API_KEY`, `CLOUD_WORKSPACE_S3_ACCESS_KEY_ID`, `CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY`, `RESEND_API_KEY` | Owner secrets; set only when different, otherwise unchanged; missing inputs may retain existing values |
| `BOAT_ACCOUNT_SCOPE`, `BOAT_BILLING_ORG` | Required GitHub environment variables; identical to `profile.boat` in the shared admission configuration |
| `BOAT_COMPUTE_POLICY_ID` | Initially `zeros-<channel>-standard-v1`; thereafter retain the existing channel database price-policy label |
| `BOAT_TTL_SECONDS`, `BOAT_SECONDS_PER_DOLLAR` | Initial constants `900`, `100000`; retain values belonging to an existing selected price policy, never silently reprice it |
| `CLOUD_WORKSPACE_CPU_MILLICORES`, `CLOUD_WORKSPACE_MEMORY_MIB` | Constants `4000`, `8192` (4 vCPU / 8 GB) |
| `CLOUD_WORKSPACE_OBJECT_STORE_KIND`, `CLOUD_WORKSPACE_S3_REGION`, `CLOUD_WORKSPACE_OBJECT_RESTORE_WINDOW_HOURS` | Constants `s3`, `auto`, `336` (14 days); retain recovery keys and objects accordingly |
| `CLOUD_WORKSPACE_S3_ENDPOINT` | GitHub variable of that name, else `https://<CLOUD_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com`; retain a valid existing endpoint if neither source is supplied |
| `CLOUD_WORKSPACE_S3_BUCKET`, `CLOUD_WORKSPACE_CONTROL_PLANE_URL` | Derived channel bucket and `CHANNELS[channel].api` from `scripts/release/contracts.ts` |
| `ZEROS_DEPLOY_ENV` | Derived channel marker required by the worker tuple-selection adapter |
| `CLOUD_WORKSPACE_SECRET_KEYS_JSON`, `CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION` | Generated once, version `1`; settings, setup and agent-credential encryption share this ring |
| `CLOUD_WORKSPACE_OBJECT_KEYS_JSON`, `CLOUD_WORKSPACE_OBJECT_CURRENT_KEY_VERSION` | Independently generated once, version `1`; durable-object encryption |
| `CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON`, `CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION` | Independently generated once, version `1`; Codex renewal/security fingerprints, never a native refresh token |
| `CLOUD_WORKSPACES_ENABLED`, `CLOUD_WORKSPACE_BACKGROUND_WORKERS_ENABLED`, `CLOUD_WORKSPACE_SETUP_WORKER_ENABLED` | Initially all `false`; preserve existing enabled/paused states on repeat apply; set all `true` only on an explicit `enable_cloud` apply with a selected tuple, qualified unless `ZEROS_WORKER_PROMOTION` is off |
| `EMAIL_FROM`, `OPERATIONS_ALERT_EMAIL` | Constants `Zeros <notifications@zeros.build>`, `alert@zeros.build` |
| `CLOUD_WORKSPACE_PROVIDER`, `BOAT_SNAPSHOT_ID`, `BOAT_IMAGE_BUILD_SHA256`, `ZEROS_CLOUD_SOURCE_COMMIT`, `ZEROS_CLOUD_IMAGE_ARCHITECTURE`, `CLOUD_WORKSPACE_STORAGE_MIB` | Worker lane's complete six-field tuple. Provisioning writes them only for `adopt_base_worker` while worker promotion is off and the channel has no tuple: it copies the tuple Alpha serves when that image is the channel's `BOAT_BASE_SNAPSHOT`. It never completes a partial tuple or replaces a selected one |
| `ZEROS_RELEASE_CANARIES_ENABLED`, `RUNTIME_QUALIFICATION_ACTOR_USER_ID`, `WORKER_CANARY_ORGANIZATION_ID`, `WORKER_CANARY_REPOSITORY` | Optional existing GitHub environment variables; missing ones are reported `missing-input`, not invented |
| `WORKER_CANARY_ADMISSION_TOKEN`, `WORKER_ADMISSION_CONFIG_JSON` | Optional existing GitHub environment secrets, also installed server-side; required and validated when release canaries are enabled |
| Existing `DATABASE_URL`, authentication/WorkOS configuration, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_OAUTH_CALLBACK_URL`, `GITHUB_APP_PRIVATE_KEY` | Kept Railway-only; the enabled API requires a valid RSA private key and complete GitHub registration |

While `ZEROS_WORKER_PROMOTION` is off, apply with `enable_cloud` and
`adopt_base_worker` to turn on a channel's cloud with the shared base image.
The next release deploys those variables. Agents in cloud workspaces still run
only on images with recorded runtime qualifications for that channel.

Engine protocol/port/heartbeat, setup deadlines and operation/archive/reconcile
limits retain existing validated values or the boot loader's defaults. Managed
Boat does not need the optional Daytona/BYO provider-credential key. Railway
injects `RAILWAY_GIT_COMMIT_SHA` at deployment; provisioning must not invent it.

Every new keyring is a JSON object such as `{"1":"<canonical base64url for 32
crypto-random bytes>"}` with an independent key and matching current selector.
No generated value reaches output, artifacts or GitHub secrets. Existing rings
and selectors are never overwritten or rotated. Supported legacy
`CLOUD_WORKSPACE_SECRET_KEY_V1` / `CLOUD_WORKSPACE_OBJECT_KEY_V1` are adopted
without changing their key material. A single V1 ring may receive its missing
selector; incomplete or ambiguous rings fail rather than guess or rotate. Use
the separate [key-rotation procedure](cloud-workspace/security.md#secret-binding-verification-and-key-rotation)
for rotation.

The Actions token is read-only and cannot install environment secrets. The
orchestrator securely copies the existing release-only admission bearer (at
least 32 characters) and shared admission JSON into the channel's GitHub secrets;
this workflow does **not** generate either. The JSON retains the canonical shared
Dev/Boat/registry profile, not the channel's deployment targets. Native account
credentials stay in the channel's encrypted API store, never CI. See
[release worker qualification](cloud-workspace/release-worker-qualification.md)
for owner designations, budgets and the remaining worker-lane configuration.

1. Configure the owner credentials, canonical identity variables and endpoint
   source, then dispatch `mode=plan`, `channel=beta` (or `production`). Review
   only names and `unchanged`, `set`, `generate`, `missing-input`, `kept-existing`.
2. Dispatch `mode=apply`, `confirm=zeros-control-plane-beta` (or
   `zeros-control-plane-production`), leaving `enable_cloud=false`. Configuration
   is validated in memory with a placeholder database URL and the real boot
   loader, without its potentially sensitive diagnostics. The enabled schema is
   also checked using validation-only placeholders for absent worker fields and
   planned keyrings; **none of those placeholders can be written**. Apply uses
   one `variableCollectionUpsert` with `replace:false, skipDeploys:true`, then
   verifies exact readback in memory. Missing optional canary inputs do not block
   staging unless server-side canaries are requested. Autodeploy/staged changes,
   concurrent variable changes, previews or invalid existing configuration stop apply.
3. Deploy the reviewed same-SHA API with current compatible migrations and
   **customer cloud still disabled**. The boot loader validates account encryption
   keys independently of the worker profile. Authenticated owners can connect
   native accounts and explicitly designate exact credentials/models for release
   checks. Customer allocation, workspace credential delegation, engine execution
   and customization stay disabled. With `ZEROS_RELEASE_CANARIES_ENABLED=true`,
   the separate release-only bearer, immutable `RAILWAY_GIT_COMMIT_SHA`, owner/
   organization/repository and matching shared admission configuration, release
   native canaries can run **without any preexisting image tuple**. Staff/owner
   consent, migration/maintenance fences and account admission remain enforced.
4. Obtain the trusted same-SHA services receipt, qualify all three native kinds
   through the worker lane, select its complete immutable tuple, then redeploy
   the same API SHA **still cloud-off**. `/v1/release-identity` now exposes that
   selected tuple and the database-backed three-kind, same-contract, enabled,
   MCP-qualified approval result independently of customer rollout.
5. Plan and apply with `enable_cloud=true` only after that readback. The enable
   gate requires an exact selected tuple match, same channel, worker and API
   source SHAs both equal to the approved release SHA, current compatible schema,
   valid whole configuration and `workerQualified=true`; tuple presence or a
   qualified older worker is insufficient. Qualification is rechecked before the
   single variable write. A default repeat apply preserves existing flags and
   keyrings, including deliberately paused workers; invalid existing state fails
   rather than being reset. The next explicit deploy or hosted promotion picks
   up the enabled values and verifies live readiness. A staged enable is not
   live readiness: qualification can be revoked after the check, and per-account
   runtime admission still validates current authority. Desktop cloud capability
   remains a separate approved release flag. Previews stay off.

### WorkOS application callbacks

Create separate Web and Desktop Applications inside each channel's WorkOS
environment. Register these exact HTTPS redirects:

| Channel    | Web Application redirects                                                                    | Desktop Application redirect                          | App handoff after the hosted callback |
| ---------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------- |
| Alpha      | `https://app-alpha.zeros.build/auth/callback`, `https://ops-alpha.zeros.build/auth/callback` | `https://app-alpha.zeros.build/auth/desktop/callback` | `zeros-alpha://auth/callback`         |
| Beta       | `https://app-beta.zeros.build/auth/callback`                                                 | `https://app-beta.zeros.build/auth/desktop/callback`  | `zeros-beta://auth/callback`          |
| Production | `https://app.zeros.build/auth/callback`, `https://ops.zeros.build/auth/callback`             | `https://app.zeros.build/auth/desktop/callback`       | `zeros://auth/callback`               |

The app handoff is generated by Zeros after WorkOS returns to the HTTPS
callback; it is not the WorkOS redirect URI for a new desktop build. During the
transition, retain any previously registered channel custom-scheme or wildcard
loopback redirects so an older build can still complete sign-in. Remove them
only after that build is outside the rollback/support window.

Desktop sign-in opens `${APP_ORIGIN}/auth/desktop`. Pages sends only bounded
state and the PKCE challenge to Railway, which uses the Desktop Application
client ID and always redirects to WorkOS Hosted AuthKit. Provider, connection,
and organization selectors are discarded. Hosted AuthKit owns provider choice,
verification, MFA, recovery, and account linking. The return page is again on
`APP_ORIGIN`, then opens the exact installed channel. No WorkOS API key,
pending verification credential, or refresh token enters Pages, the browser
page, a deep link, or renderer code.

## Legacy Auth0 setup during migration

Use three Regular Web Applications and three API identifiers. A shared Auth0
tenant is acceptable, but clients and audiences stay isolated:

| Channel    | Callback                                      | Logout URL                       | API identifier                  |
| ---------- | --------------------------------------------- | -------------------------------- | ------------------------------- |
| Alpha      | `https://app-alpha.zeros.build/auth/callback` | `https://app-alpha.zeros.build/` | `https://api-alpha.zeros.build` |
| Beta       | `https://app-beta.zeros.build/auth/callback`  | `https://app-beta.zeros.build/`  | `https://api-beta.zeros.build`  |
| Production | `https://app.zeros.build/auth/callback`       | `https://app.zeros.build/`       | `https://api.zeros.build`       |

Keep the Post-Login Action that stamps the namespaced email, email verification,
name, and picture claims consistent across the three clients. Do not let an
Alpha or Beta web project use the Production client secret or audience.

## Cloudflare Pages setup

Create `zeros-web-alpha` and `zeros-web-beta` beside the existing `zeros-web`,
plus `zeros-ops-alpha` and `zeros-ops` from the same source. All five use:

| Build setting    | Value           |
| ---------------- | --------------- |
| Framework        | None            |
| Root directory   | `apps/web`      |
| Build command    | `npm run build` |
| Output directory | `dist`          |

Configure each project:

| Project           | Production branch                 | Automatic Production deploys      | Automatic Preview deploys | Custom domain(s)                                    |
| ----------------- | --------------------------------- | --------------------------------- | ------------------------- | --------------------------------------------------- |
| `zeros-web-alpha` | `main`                            | **off under the controller**       | **off**                   | `app-alpha.zeros.build`                             |
| `zeros-ops-alpha` | `main`                            | **off under the controller**       | **off**                   | `ops-alpha.zeros.build`                             |
| `zeros-web-beta`  | current `release/X.Y.Z`           | **off under the controller**       | **off**                   | `app-beta.zeros.build`                              |
| `zeros-web`       | current validated `release/X.Y.Z` | **off**                           | **off**                   | `app.zeros.build` plus Production marketing domains |
| `zeros-ops`       | current validated `release/X.Y.Z` | **off**                           | **off**                   | `ops.zeros.build`                                   |

Disable Preview deployments for these release projects. If PR previews are
needed later, create a sixth preview-only project with preview-only credentials
and data instead of sharing Alpha/Beta state.

The controller retargets the project production branch under the channel lock,
keeps both production and preview autodeploys disabled, then uploads the exact
checkout with the pinned Wrangler dependency. Disable independent deploy hooks
as well. Direct upload into an existing Git-connected project is supported; it
does not require recreating the project. The build sets `CF_PAGES=1` so the
existing hosted environment guards run in Actions too.

Each project retains its own `SESSIONS` KV namespace for Auth0 rollback and
legacy abuse controls. Set these common values in the project's Production
variable/binding configuration:

| Variable            | Alpha                                            | Beta                                             | Production                                       |
| ------------------- | ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------ |
| `ZEROS_DEPLOY_ENV`  | `alpha`                                          | `beta`                                           | `production`                                     |
| `AUTH_PROVIDER`     | `auth0` until coordinated cutover, then `workos` | `auth0` until coordinated cutover, then `workos` | `auth0` until coordinated cutover, then `workos` |
| `APP_ORIGIN`        | `https://app-alpha.zeros.build`                  | `https://app-beta.zeros.build`                   | `https://app.zeros.build`                        |
| `CONTROL_PLANE_URL` | `https://api-alpha.zeros.build`                  | `https://api-beta.zeros.build`                   | `https://api.zeros.build`                        |

Auth0 compatibility mode additionally requires:

| Variable              | Alpha                           | Beta                           | Production                |
| --------------------- | ------------------------------- | ------------------------------ | ------------------------- |
| `AUTH0_AUDIENCE`      | `https://api-alpha.zeros.build` | `https://api-beta.zeros.build` | `https://api.zeros.build` |
| `AUTH0_DOMAIN`        | configured domain               | configured domain              | configured domain         |
| `AUTH0_CLIENT_ID`     | Alpha client                    | Beta client                    | Production client         |
| `AUTH0_CLIENT_SECRET` | Alpha secret                    | Beta secret                    | Production secret         |

WorkOS mode adds no provider-specific Pages secret or binding. Pages remains a
same-origin facade using only the common `APP_ORIGIN` and
`CONTROL_PLANE_URL`. Remove any retired `AUTH_SESSIONS` binding,
`WORKOS_SESSION_WORKER`, `WORKOS_WEBHOOK_SECRET`, or `AUTH_BROKER_SECRET` from
the Pages projects. Browser credentials are host-only random cookies; their
digests, PKCE verifier, encrypted sealed session, and serialized refresh state
live in the channel's PlanetScale Postgres.

For `zeros-ops-alpha` and `zeros-ops`, set `ZEROS_SURFACE=ops`,
`WORKOS_BROWSER_ROUTE_PREFIX=/ops`, and the Ops hostname as `APP_ORIGIN`.
Set `AUTH_PROVIDER=workos`; do not configure Auth0 fallback or marketing hosts.
The corresponding Railway environment uses the same control-plane service and
database as its customer app, with `OPS_ORIGIN` set to the exact Ops hostname.
There is intentionally no `zeros-ops-beta` project.

For each WorkOS environment, register the exact channel URL
`https://<api-host>/auth/workos-webhook` and subscribe to the complete
management event set in `docs/workos-authentication-migration.md`. Zeros uses
Hosted AuthKit and does not render provider,
credential, email-verification, MFA, recovery, or account-linking forms. A
custom AuthKit domain is optional for the initial rollout and should be
evaluated separately for Production branding and anti-phishing. Subscribe to
`user.created`, but do not provision a product account from it; first
authenticated requests create the subject-to-Zeros-account mapping and the
webhook handler records then deliberately ignores creation events.
A self-hosted template can use platform-provided HTTPS domains instead of
buying domains. Keep the frontend `APP_ORIGIN` separate from the API origin so
server-only session responses are never same-origin browser endpoints; two
services in one Railway project can each use their generated domain. Such a
template sets `ZEROS_SELF_HOSTED=true`; official Alpha/Beta/Production services
must leave it unset so the repository's exact channel and branch checks remain
active.

### Alpha WorkOS activation order

After the Hosted AuthKit change is merged to `main`, activate Alpha in this
order:

1. In the WorkOS Alpha environment, make `Zeros Web Alpha` the default
   Application and verify both exact HTTPS callbacks. Enable Hosted AuthKit,
   the intended login methods, email verification, session policy, and the
   required JWT template. Keep legacy custom-scheme and loopback redirects only
   for the measured rollback/support window.
2. Rotate any WorkOS API key that has appeared outside the secret store. Copy
   the replacement directly from WorkOS into Railway; never put it in Pages,
   GitHub, a terminal command, or this repository.
3. In Railway's `alpha` environment, set `AUTH_PROVIDER=workos`, exact
   `APP_ORIGIN`, `AUTH_AUDIENCE`, both Application client IDs, issuer, JWKS URL,
   replacement `WORKOS_API_KEY`, a unique cookie password, and the Alpha webhook
   signing secret. Capture issuer and JWKS from the qualified real token
   contract; do not derive them from a display name or assume Application IDs
   are interchangeable. Remove `AUTH_BROKER_SECRET` and leave
   `ZEROS_SELF_HOSTED` unset for official Alpha.
4. Point the WorkOS webhook directly to
   `https://api-alpha.zeros.build/auth/workos-webhook` and subscribe to the
   complete management event set in `docs/workos-authentication-migration.md`.
5. Deploy Railway first. Confirm migrations complete and
   `https://api-alpha.zeros.build/healthz` succeeds before changing Pages.
6. In Cloudflare Pages `zeros-web-alpha`, set `ZEROS_DEPLOY_ENV=alpha`,
   `AUTH_PROVIDER=workos`, `APP_ORIGIN=https://app-alpha.zeros.build`, and
   `CONTROL_PLANE_URL=https://api-alpha.zeros.build`. Remove retired broker,
   session-worker, and WorkOS secret bindings, then deploy the same `main` SHA.
7. In the GitHub `alpha` Environment, set the public WorkOS desktop release
   variables from the table below and build the same SHA. Do not add a WorkOS
   API key to GitHub.
8. Qualify private-browser web login/refresh/logout, webhook delivery, and a
   packaged macOS login/refresh/relaunch/current-device logout/all-device
   revocation. Keep Auth0 and the previous database/deployments available until
   Alpha passes the soak window.

The repository prepares this topology but does not activate it. Railway accepts
one issuer at a time, while released builds remain on Auth0 until the
coordinated cutover. Switch the clean Alpha database, Railway `AUTH_PROVIDER`,
Pages `AUTH_PROVIDER`, WorkOS webhook, and matching desktop build as one
coordinated operation. Never switch only the browser or only the control plane.

Only `zeros-web` owns `zeros.build`, `www.zeros.build`, and `zeros.design`.
Those marketing domains must never be attached to Alpha or Beta.

## GitHub release environments

The repository already has `alpha`, `beta`, and `production` GitHub
Environments. Add environment-scoped Actions **variables** (secrets remain a
backward-compatible fallback):

| GitHub environment | `VITE_APP_BASE_URL`             | `VITE_CONTROL_PLANE_URL`        |
| ------------------ | ------------------------------- | ------------------------------- |
| `alpha`            | `https://app-alpha.zeros.build` | `https://api-alpha.zeros.build` |
| `beta`             | `https://app-beta.zeros.build`  | `https://api-beta.zeros.build`  |
| `production`       | `https://app.zeros.build`       | `https://api.zeros.build`       |

The workflows validate these exact pairs. Both values are baked into the
renderer, and both are now also available to Electron main for Auth0, hosted
WorkOS desktop authorization, and GitHub handoffs. A missing Alpha/Beta value
cannot silently fall back to Production.

Desktop release environments recognize these environment-scoped Actions
variables:

| Variable                                     | Auth0 rollback build      | WorkOS build                                                                    |
| -------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------- |
| `AUTH_PROVIDER`                              | `auth0`                   | `workos`                                                                        |
| `AUTH_DESKTOP_CLIENT_ID`                     | unused                    | channel Desktop Application ID                                                  |
| `AUTH_ISSUER`                                | unused                    | exact qualified issuer                                                          |
| `AUTH_JWKS_URL`                              | unused                    | exact qualified JWKS URL                                                        |
| `AUTH_AUDIENCE`                              | unused                    | matching channel API origin                                                     |
| `ZEROS_CLOUD_WORKSPACES_ENABLED`             | `false`                   | `false` until that channel's desktop cloud client is release-approved           |
| `VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES` | unset: Cloud previews hidden | optional; when supplied, 1-8 unique exact lowercase DNS suffixes |
| `CLOUD_WORKSPACE_PROVIDER`                  | unused while cloud is off | `boat` or `daytona`; omission preserves the legacy Daytona policy |
| `VITE_CLOUD_WORKSPACE_SSH_KNOWN_HOSTS_B64`   | unused while cloud is off | Daytona: canonical base64url OpenSSH pins covering `ssh.app.daytona.io`; optional for managed Boat |

The authentication entries are public verification values baked only into
Electron main. Never add a WorkOS API key—generic, web, desktop, or channel-
prefixed—to a desktop release environment. The release gate rejects any
`WORKOS_*_API_KEY` shape.

`ZEROS_CLOUD_WORKSPACES_ENABLED` is a separate exact-`true` desktop build
capability, not the Railway `CLOUD_WORKSPACES_ENABLED` rollout flag and not an
installed-app preference. The protected release environment supplies one value
to both the packaged engine and Electron compile steps; each artifact bakes it,
and Electron pins the child environment to the same decision. Leave it unset or
set it to `false` until the channel is approved. Enabling only the backend does
not activate a desktop client, and enabling only the desktop does not bypass
backend admission. The first cloud release leaves public cloud-preview suffixes
unset: Cloud Preview URL controls are hidden, while preview-independent
forward-to-localhost tunnels remain available. The release-environment check
allows cloud-enabled builds without preview suffixes and validates their format
whenever supplied. Daytona still requires its complete SSH host-key policy.
Managed Boat uses the backend terminal tunnel, so it needs no Daytona pin; a
supplied pin document is still validated. Flags-off builds remain valid without
either value.

Organization Settings → Agents credential enrollment is independent of desktop
cloud execution. Signed-in members can connect their own native accounts while
`ZEROS_CLOUD_WORKSPACES_ENABLED=false`; Electron still validates requests, binds
ceremonies to the current main session and window, and imports into the current
channel's authenticated backend. That backend needs its credential encryption
and Codex refresh-fingerprint keys. Enrollment allocates no VM, bypasses no
workspace admission gate, and does not authorize release checks: **Use for release
checks** retains its separate configured platform-owner and current-revision
consent requirements.

Set GitHub Environment deployment-branch protection too: `alpha` permits only
`main`; `beta` permits only `release/*`; `production` permits only `release/*`.
The stable workflow itself rejects `main` and requires an exact
`release/X.Y.Z` ref, so a manual dispatch cannot bypass the promotion ladder.

Production takes **one human approval per run**. The `production-approval`
environment holds the required reviewer, permits only `release/*`, and has no
secrets or variables. `release.yml` starts with an `approve` job in that
environment, and every job that can read `production` secrets needs it: build,
submit, notarize, publish and the hosted lane it calls. A direct Production
dispatch of `controlled-cutover.yml` or `cloud-worker-promotion.yml` needs the
same approval; Alpha and Beta skip it. The hosted lane passes `caller_gated` to
the worker workflow, which a dispatch cannot set. The `production` environment
therefore keeps its secrets and branch policy but no reviewer of its own.

That moves secret protection to the release branches: the `release` ruleset
must be active, block deletion and force-push, and restrict branch creation and
updates to repository admins and the `zeros-agent` App, which cuts release
branches. Other changes reach a release branch through reviewed PRs.

Apply the settings in this order, so no window runs without a gate:

1. Create `production-approval` with the reviewer and the `release/*` policy.
   A job that names a missing environment would create it unprotected.
2. Merge the workflows that use it. Until step 3, Production asks for that
   approval plus the old per-job approvals.
3. Activate the `release` ruleset restrictions above.
4. After the next Beta release publishes, remove the reviewer from
   `production`. Older release branches still run their earlier workflows,
   which lack the approval job; their Production jobs refuse a SHA that the
   latest Beta did not publish.

### macOS signing keychain

The pinned `app-builder-lib@26.8.1` dependency has a pnpm patch that passes its
generated temporary-keychain password to `security set-key-partition-list`.
Each P12 password remains scoped to importing that certificate. Using a P12
password to unlock the separately created keychain can fail with
`SecKeychainUnlock`, preventing the signed Alpha release and its gated Railway
deployment from completing.

Keep this patch until a replacement dependency uses the generated keychain
password for every partition update, including installer certificates. Run
`mac-signing-keychain.test.ts` when updating the dependency; it exercises the
installed implementation with a strict OS-command model and no real credentials.
Actual Developer ID signing and installer/updater signature verification remain
required in the release workflows.

## Feedback consolidation

Feedback is now `POST /v1/feedback` on the Railway control plane. The desktop
uses `VITE_CONTROL_PLANE_URL`; there is no `VITE_FEEDBACK_URL` and no standalone
Cloudflare Worker in the repository.

Configure at least one destination in each shipped Railway environment:

- Intercom: `INTERCOM_TOKEN`, optional region/admin/tag/app variables
- Linear: `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, optional label map
- optional: `POSTHOG_PROJECT_URL`

The endpoint applies a Railway `X-Real-IP` limit before authentication, then
uses the verified Zeros account identity and a tighter per-user limit. It sends
independently to Intercom and Linear and returns success if either destination
accepts the report. Intercom and Linear secrets never enter Cloudflare Pages or
a desktop build.

After the new Production endpoint has received a real test report, remove the
old Worker deployment and its rate-limiter binding from the Cloudflare
dashboard, then delete any obsolete `VITE_FEEDBACK_URL` GitHub variable/secret.
Keeping the old Worker live but unused during verification is a safe rollback
window.

## One-time organization migration `0009`

Migration `0009` renames tenant tables. The old control-plane binary is not
compatible with the post-migration schema. It must not run as an ordinary
rolling deploy in any channel, and production service boot intentionally
ignores migration approvals.

Exercise this procedure in Alpha and Beta before Production. For each channel:

1. Verify the exact release SHA and build the production image that will be
   promoted. Disable autodeploy, take and verify a fresh database backup, and
   keep the existing frontend in place.
2. Drain and prove stopped every old and new control-plane process. No API,
   worker, pre-deploy command, or replacement deployment may overlap the
   migration.
3. In a database-owner shell inside that exact reviewed image, run only the
   compiled strict migrator. Scope the approval to this one process; never save
   it on the Railway web service. A database beginning before `0009` and
   advancing through this migration artifact requires all ten controlled
   boundaries:

   ```bash
   NODE_ENV=production \
   CONTROL_PLANE_MIGRATION_APPROVALS=0009_organization_team_hierarchy.sql,0025_cloud_workspace_engine_authority.sql,0060_cloud_workspace_pending_blob_deletions.sql,0061_workos_provider_erasure_fences.sql,0073_cloud_workspace_compute_leases.sql,0075_security_event_commit_order.sql,0076_cloud_workspace_individual_pro_and_pilot.sql,0079_cloud_workspace_user_compute_funding.sql,0101_cloud_workspace_pro_entitlements.sql,0103_cloud_workspace_pro_sharing.sql \
   node dist/migrate.js
   ```

   From a source checkout, `pnpm --dir apps/control-plane migrate` is the
   equivalent entrypoint. If the database already records a controlled
   boundary, omit only that already-recorded filename; the runner never skips
   an unapproved pending boundary.

4. Verify the contiguous checksummed migration ledger and inspect the migration
   log. Remove the one-shot approval environment, then start the same release
   image normally with both cloud feature flags false.
5. Require `/healthz`, smoke-test login, organizations, invitations, settings,
   GitHub connection, feedback, the `/v1/teams` compatibility API, and the new
   organization API. Keep Production autodeploy off until the complete
   promotion is accepted.
6. After Production succeeds, deploy the same release commit to `zeros-web`,
   verify browser login and the dashboard, then release the matching stable
   desktop build.

Do not use Railway image rollback after `0009`: the old image expects the old
schema. Restore the database backup or roll forward with corrected new code.

## One-time cloud authority migration `0025`

Alpha tracks `main`, so an unapproved controlled migration must not turn its
automatic deploy into a restart loop. The service-boot runner may stop before
`0025_cloud_workspace_engine_authority.sql` only while both cloud runtime flags
are false, every pre-boundary cloud state table is empty, and no later migration
is recorded. Railway then receives a healthy HTTP response whose `/healthz`
body contains `migrations.state=controlled_migration_pending`; every cloud API
returns `503 controlled_migration_pending`, unrelated APIs remain available,
and no migration after `0024` is recorded or applied. Existing cloud state or
an enabled cloud flag makes startup fail closed instead.

That state is a maintenance signal, not approval and not cloud readiness.
Production service boot never honors `CONTROL_PLANE_MIGRATION_APPROVALS` and
never executes a controlled boundary; in particular, unapproved `0009` remains
a startup failure because it changes core schema. Drain old processes, take a
verified backup, record the commit and checksummed ledger, and run
`node dist/migrate.js` inside that exact production image with
`NODE_ENV=production` and the exact one-process approval for `0025`. Never put
the approval on the web service. Remove it, restart the same commit, and require
the pending state to disappear before enabling either cloud flag. The complete
empty-state and existing-state sequences are in
[`cloud-workspace/infrastructure-and-operations.md`](cloud-workspace/infrastructure-and-operations.md#controlled-migration-rollout).

## Normal promotion after the one-time migration

Every macOS channel verifies the two independently consumed release containers
before promotion: users install from the DMG, while the in-place updater installs
the ZIP. `scripts/verify-macos-release-artifacts.mjs` mounts/extracts both, runs a
deep strict signature check, constrains the root to bundle ID `com.zeros*` and
Apple team `H8MS56JU2Z`, requires hardened runtime plus a secure timestamp,
checks ShipIt-safe owner-write modes, and requires matching root code-directory
hashes. Every build verifies before saving its signed artifact; Production
separately rechecks notarization/Gatekeeper after stapling. No unpacked `.app`
crosses the artifact boundary, so its signed modes and symlinks remain inside the
DMG/ZIP rather than being normalized by Actions artifact upload.

1. Merge a green PR to `main`. Each release starts its signed Mac build **in
   parallel** with the wait for successful **Preflight and CodeQL for its exact
   event SHA**. `hosted-promotion.yml` starts after CI, without waiting for the
   build. A separate feed publisher waits for both lanes and CI. PR checks for a
   different SHA, a fork's checks, or an older successful attempt cannot authorize
   mutation.
2. Test Alpha, then cut an exact `release/X.Y.Z` branch. Beta uses one global
   destination lock across every release branch. The controller retargets
   Railway and Pages metadata to the selected branch and deploys its event SHA.
3. Stabilize with cherry-picks on that branch. Every resulting SHA needs its own
   required CI evidence (Preflight and CodeQL push on both `main` and
   `release/**`). Superseded same-branch commits
   and branches older than an already-selected release version are rejected
   before mutation. Never cancel an active migration/cutover.
4. Dispatch `release.yml` from the frozen release branch. With hosted promotion
   enabled, Production requires a successful `release-beta.yml` push run and
   its unexpired success receipt for the same repository/branch/SHA. The
   receipt's recorded attempt must contain a successful hosted mutation job.
   An earlier hosted attempt of the same run remains valid after a successful
   desktop-only retry. The Production human approval, notarization and all
   macOS gates remain; disabled legacy mode does not enforce the Beta receipt.
5. Keep the branch fixed until desktop publication completes. The whole release
   workflow holds a non-cancelling, channel-global publication lock.

The release graph deliberately has no repeated Linux quality job: exact-SHA
Preflight already covers typechecks, lint, Vitest, release contracts and the
secret-free ship guards. Mac builds retain shipping-kernel ZSR qualification,
the compiled engine lifecycle and packaged terminal smoke tests, channel-specific
environment routing, blockmaps, and signature verification. Builds have only
`contents: read`, protected signing credentials and public build configuration,
not Railway/PlanetScale/Cloudflare/Boat/WorkOS or Apple notary credentials. Signing
credentials appear only in the build job. Only the final publisher has
`contents: write`; it has no signing or provider credentials.

```text
CI (exact SHA) ──► hosted services ──► worker / final API readiness ──┐
Mac build + sign (parallel with CI) ──► signed artifact ─────────────┼─► feed + ledger
                                                                  │
Production only: CI + build ──► Apple submit ──► notarize + verify ──┘
```

Production's Apple submission is a separate **CI-gated** job, never part of the
parallel build. With hosted promotion enabled, its read-only guard also requires
the existing unexpired exact-SHA Beta success receipt before submitting; it does
not wait for Production's hosted lane. It saves the submission ID separately
from the signed build;
notarization retries poll that same submission and artifact without rebuilding
or re-uploading to Apple. The final publisher downloads the verified notarized
artifact and still waits for hosted success. Saved artifacts last five days;
explicit build reruns overwrite only this run's same-named build artifact.

The ordinary Alpha critical path is `max(Mac build, required CI + hosted flow)`
plus artifact/feed publication, not their sum and not another seven-minute
quality job. With the September 30, 2026 measurements (about 15 minutes CI and
13 minutes Mac packaging), **approximately 25 minutes merge-to-feed is a
target, not a measured guarantee**: provider deployment, cold worker/native
canaries, CI failures/reruns, runner queues and Production's Apple queue can
extend it. The `ui-smoke` job is unchanged by this restructuring.

The read-only CI barrier checks the newest trusted run of each required workflow
without filtering out failures. It waits up to 110 minutes, including through a
failed Preflight attempt, and proceeds after that exact commit's rerun succeeds.
Each poll also refuses a superseded branch SHA instead of occupying the channel
lock for the whole bound while newer commits wait.
If CI remains unsuccessful beyond the bound, rerun the failed required checks
and retry the release; no provider or feed mutation has been authorized. Manual
Production dispatch uses the same exact-SHA proof, not a branch-level green
badge. The callable hosted guard, Apple jobs and every final publisher recheck
required CI; the CI CLI and publisher also refuse a branch head that superseded
their candidate. A release rerun reads the current exact-SHA check attempts,
not a cached failure from the original release attempt.

When enabled, the hosted controller performs a read-only provider plan, a
short-lived migration-role SQL plan, source retarget, a fresh successful
PlanetScale backup, strict production-mode migration, explicit exact-SHA
Railway deploy, deployment `SUCCESS`, public release readiness, app/Ops Pages
build and direct upload, custom-domain manifest verification, then anonymous
WorkOS handshake verification. That job saves
`hosted-services-<channel>-<sha>` with status `services-ready`, **not** desktop
publication authority. The worker lane runs only after these services succeed,
so its native canaries target the newly deployed API. It must complete audited
qualification, temporary-role/resource cleanup and the atomic complete tuple
update with deployment suppressed before saving its authenticated
`worker-promotion-<channel>-<sha>` success receipt.

Finalization authenticates both artifacts against this parent release's exact
repository/branch/SHA and successful producing jobs in their recorded attempts,
rechecks current provider/Pages state and the selected worker tuple, then
explicitly redeploys the same API SHA with the new tuple. It requires final
source, schema-manifest, health and current qualification proof before saving
`hosted-promotion-<channel>-<sha>`. An unchanged qualified worker with identical
committed inputs is reused without a second API deploy. A failed/rate-limited
canary, missing receipt, incomplete cleanup, changed tuple or failed API redeploy
withholds final publication authority. Only the final hosted receipt can
authorize the signed desktop publisher and cumulative release ledger.
There is no Ops deployment in Beta. Every Pages artifact includes Functions
and the applicable marketing output. Build/install output from provider-facing
subprocesses is withheld, and receipts contain allowlisted public fields only.

WorkOS verification anonymously exercises `/auth/start` on every channel Pages
surface, checks the exact issuer/client/callback, PKCE, no-store and host-only
flow-cookie contract, requires the provider to accept the authorization request,
and checks public JWKS availability. Receipts retain only the surface list and
verification time, never state, cookies or authorization URLs. This is a public
handshake/readiness gate, **not** an authenticated login/logout or native desktop
canary. The owner still rehearses those complete flows with dedicated approved
accounts before enabling a channel.

Immediately before each desktop publisher writes its release, it runs
`scripts/release/publication-cli.ts`. With hosted promotion enabled, the gate
downloads this run's receipt, verifies the successful hosted job in its recorded
attempt, then rereads the current backend and every channel Pages manifest.
Source SHA, migration manifest and complete worker tuple must still match the
receipt; cloud-enabled desktops also require current `workerQualified=true`.
Run A cannot publish after run B promoted a newer hosted state. A retry with
unchanged hosted state is allowed. Production rechecks CI and branch freshness
before Apple submission/polling, then the complete hosted proof immediately
before publication, preserving the same signed artifact without rebuilding.
Do not race dashboard/provider
writes against these checks; external mutations are outside the workflow lock.

Each publisher builds a cumulative version-1 desktop release ledger **before**
altering the feed release, uploads it with the feed, then reads the full expected
ledger back anonymously before declaring publication successful. The assets are
`alpha-release-ledger.json` on the rolling `alpha` release,
`beta-release-ledger.json` on `beta`, and `release-ledger.json` on every stable
Production release (`/releases/latest/download/release-ledger.json`). Shape:

```json
{
  "version": 1,
  "channel": "alpha",
  "releases": [
    {
      "version": "0.1.20-alpha.180",
      "publishedAt": "2026-09-30T02:59:43.000Z",
      "sourceSha": "559eb5093eb962d6297f02005e201cb28422128b"
    }
  ]
}
```

Entries are ordered oldest to newest with stable chronological ordering and
bounded to the newest 200. Version numbers and publication times must advance;
retrying the latest same-version/same-SHA publication retains its **original**
timestamp so it cannot extend an older client's support window. Different-source
or historical same-version replacement is refused. The prior ledger comes from
the current channel feed release, including before Production replaces an
existing tag. A missing first/legacy ledger may bootstrap empty history; an
inaccessible, malformed, wrong-channel or duplicate-version ledger must never
silently reset history. Rolling binary asset retention is independent of the
200-entry ledger. Failed anonymous readback is a partial-publication incident:
inspect/reconcile visible assets and use a higher-version forward fix where
clients may have observed a release, rather than silently rewriting timestamps.

`GET /v1/release-identity` is public and secret-free, including during
maintenance. It returns version 1, deployed Railway Git SHA, channel,
maintenance, packaged/recorded migration head and checksum-manifest digest,
`current`/`pending`/`controlled`/`unknown` state, aggregate cloud readiness and
the complete selected worker identity. It returns 503 unless ready; `/healthz`
retains its existing liveness semantics. Provider errors, tenant information,
credentials and cloud-health diagnostic strings never enter the identity body.
The controller verifies the response against its exact checkout manifest.
The additive `workerQualified` flag requires enabled, audited native approvals
for **Claude Account (`claude-setup-token`), Codex Account (`codex-chatgpt`) and
Cursor (`cursor-api-key`)** on the selected provider/image, one common native
contract, and the `zeros-cloud-worker-v3` profile, each with MCP qualification.
It exposes no credential kind, account, evidence or owner identity; a failed
approval read returns false. Each agent's runtime admission still enforces its
own credential kind and exact runtime contract. This flag is separate from
aggregate service readiness and does not alter `/healthz`.
Enabled worker reuse and final hosted readiness require affirmative current
qualification whenever the desktop publishes cloud capability. Reuse pins the
entire live tuple after checking the committed input tree; final readiness
requires that exact tuple. Missing, false or revoked approval blocks publication.
The public boolean does not replace per-credential native launch qualification.

Hosted control planes keep `DATABASE_MIGRATIONS_ON_BOOT=false`. The migration
subprocess requires `NODE_ENV=production`, rejects pending controlled
boundaries (use the reviewed drain ceremony separately), verifies checksums,
and requires `ledger=verified`, a successful backup and `role.deleted=true`.
The standalone command remains:

```sh
NODE_ENV=production pnpm --dir apps/control-plane release-migration:manage \
  --database zeros-control-plane-alpha --branch main \
  --execute --confirm zeros-control-plane-alpha
```

Its default plan creates/deletes a one-hour provider owner login even though
its SQL is read-only. `scripts/release/cli.ts --plan` performs only read-only
provider inspection and never creates a role. Neither plan authorizes a
controlled migration. A failed or ambiguous deploy stops publication; no
old-binary rollback or database restore runs automatically. Inspect provider
state and retained receipts before a retry. Temporary-role cleanup failure is
a failure, with the one-hour TTL only a backstop.

`pnpm check:web-deploy` defaults to the two Alpha Pages projects and fails
closed unless both `app-alpha.zeros.build` and `ops-alpha.zeros.build` publish
the exact `origin/main` SHA in `/zeros-deployment.json`. Cloudflare Pages
injects that SHA at build time; the manifest contains only its schema version,
Git commit, and `app`/`ops` surface, and is served with `Cache-Control: no-store`.
Use `CF_PAGES_PROJECT` plus `WEB_DEPLOY_REF` for an individual Beta or
Production qualification. A Cloudflare API token is optional corroboration,
not a prerequisite for checking the custom domains users actually reach.

### Expand/contract migration rules

The **Step A bridge** merges the phase-aware runner/verifier/lint without adding
any migration to the packaged 0121 manifest. It boots and runs migrations on a
0121 database with no phase column; boot reads a missing phase as legacy, and
the runner writes phase only when that column exists. No schema-owner mutation
or ledger alteration happens just because the bridge API boots.

**Step B ships `apps/control-plane/migrations/0122_migration_phases.sql`.** Every
channel ran the Step A bridge before it (Alpha from `6eabbd78`, Beta and
Production from `87ee454f`). Alpha's enabled hosted lane applies it as an
ordinary expand migration. Beta and Production take it with their next release,
through their hosted lane or a controlled cutover; their disabled guard refuses
publication until the schema matches. Migration 0122 adds `schema_migrations.phase`, defaulting
existing rows to `legacy`; files 0001–0121 and their checksums remain immutable.
New files (0122 onward) start with exactly `-- zeros-migration: expand` or
`-- zeros-migration: contract`. The runner records the declared phase in the same
transaction as the SQL and checksum when the phase column is present, including
0122's own `expand` row after its SQL adds that column. Before Step B, the
filename/checksum-only insert remains compatible with the 0121 database.

Normal hosted releases apply **expand only**, before deploying the new API.
`pnpm check:migration-phases` runs in Preflight and rejects missing declarations,
destructive expand SQL (including DROP, RENAME, column type changes, SET NOT NULL,
TRUNCATE, DELETE, REVOKE and dynamic EXECUTE), and contract files without a valid
`-- zeros-contract-after: YYYY-MM-DD` declaration near the header. Executable
DO, function and procedure bodies in expand files must use inspectable dollar
quoting; string-quoted bodies, including escape and Unicode strings, fail closed.
Quoted defaults and comments remain data. Prefer new tables, nullable columns,
compatible defaults and reviewed indexes; backfill in
bounded batches. A static lint cannot prove old-client/API semantics or bounded
database lock duration, so old/new boot, read/write and rollout tests remain
required. 0122 bounds its DDL lock wait to five seconds rather than waiting
indefinitely behind traffic.

Read-only boot verification retains every packaged-file presence/checksum guard.
Unknown rows are allowed **only** when their sequence is newer than the packaged
head and their recorded phase is `expand`; boot emits an allowlisted warning.
Unknown `contract`, `legacy`, malformed or historical rows fail closed. An
explicit migrator remains strict against unknown rows, and a pre-0122 ledger
without the phase column is read as legacy without changing it at boot.

The phase-aware release identity applies the same rule to a compatible rollback
binary: it reports ready with `migrations.head` ahead of `migrations.expectedHead`,
while publication and promotion still require the exact candidate manifest.
As of October 1, 2026, Beta and Production run `87ee454f`, which predates this
identity fix; after they take 0122, that rollback target still serves but reports
a not-ready identity.

Contract SQL belongs to a later, separately reviewed rollout after backfill,
all live API rollback targets and the 30-day desktop support window no longer
need the removed schema. Declare the real not-before date in UTC; the runner
refuses a pending contract before midnight UTC on that date in **every**
environment, preflighting all pending dates before any application SQL commits.
An approval variable cannot bypass that date. The hosted migration plan treats
contracts like controlled boundaries and refuses them even after their date;
the strict operator migrator is the separate authority. Legacy controlled
downtime approvals remain unchanged and are not a zero-downtime escape hatch.

The first rollout needs a compatible bridge: binaries released before this
phase-aware verifier still reject every unknown row. Deploy/rehearse the
tolerant verifier against the unchanged 0121 ledger before applying 0122, retain
that bridge as the rollback target, then rehearse expand → new API → bridge
restart against the advanced ledger. Do not claim arbitrary historical binaries
can now roll back or apply 0122 ahead of an unprepared old-binary restart. Schema
rollback is never automatic reverse SQL; reconcile partial deployment and use a
compatible API rollback or a reviewed forward fix/paired data recovery.

## Ordered-controller rollout switches and owner setup

This repository implements the hosted controller and the guarded worker build,
native-canary, approval and receipt transport. They are shipped disabled and
have not undergone a live protected-channel rehearsal. Do not interpret a green disabled guard or
`worker-plan` artifact as a deployment receipt. Set `ZEROS_HOSTED_PROMOTION`
to exactly `enabled` only after the channel setup below and an isolated live
rehearsal. Missing required secrets with the switch enabled fails the guard.
With it disabled, both the initial guard and the desktop publication step
compare the candidate's complete committed schema and worker-input contract
against the **published channel baseline**, never an event-local push diff.
The guard derives the published SHA from a successful same-channel release
workflow with a successful desktop publish step, checking the exact repository,
source repository, workflow path, event, channel branch and job SHA. Alpha must
publish from `main`; Beta/Production must publish from `release/X.Y.Z`. Beta's
previous publication may be on an older release branch because its destination
is global. The most recent successful publish-step time determines the baseline,
including a later rerun of an older workflow. This reads retained Actions
history with `actions:read`; it never trusts release `target_commitish` alone.

That proof is cross-checked against the `alpha` or `beta` rolling tag, or the
numerically highest stable `vX.Y.Z` tag for Production. Existing rolling refs
can predate their published assets because the old publisher only updated
release metadata. When the tag disagrees, the successful publication's SHA
wins and the annotation/summary reports both SHAs and the proving run ID.
The guard never changes tags. Checkouts fetch full history and tags; publication
refreshes them again. Missing tags, unavailable/unverifiable publication history,
or history exceeding the bounded scan require live manual-cutover proof.

Migration identity hashes every ordered migration name and checksum from Git
objects, so packaging edits cannot change the comparison. A dispatch or first
branch push can publish without an identity endpoint **only when its schema
matches this verified publication baseline** and the worker guard permits it.
An unresolved change remains visible on every descendant push, even when its
own diff contains only documentation. New migrations on this branch still
require manual cutover regardless of legacy-tag bootstrap.

Alpha/Beta advance the actual rolling Git tag ref only after their assets upload
successfully. Updating a release's `--target` alone does not move an existing
tag ([GitHub release API](https://docs.github.com/en/rest/releases/releases#update-a-release)).
Production continues publishing `v${VERSION}`. Its highest stable tag may differ
from GitHub's `Latest` flag when retired higher-version tags remain; the same
successful-publication cross-check applies. Do not manufacture or move a
baseline tag to bypass a cutover.

Every guard performs one anonymous, five-second public identity read. If the
endpoint answers, its readiness/schema/worker state takes precedence over the
publication baseline. An answering but unready or malformed identity cannot be replaced
with an older tag's proof. If neither a usable baseline nor an identity answers,
publication blocks with operator steps. An unavailable endpoint alone does not
block an unchanged published schema. Every disabled decision emits an annotation
and step summary and creates no hosted receipt.

- Worker input changes are warning-only when
  `ZEROS_CLOUD_WORKSPACES_ENABLED` is not exactly `true`. Ordinary engine edits
  therefore preserve legacy desktop publication for cloud-disabled channels
  when the schema is unchanged or manual cutover is verified.
- For a cloud-enabled desktop, changed worker inputs block unless the channel's
  public release identity is ready, its cloud subsystem is enabled, and
  `workerQualified=true`. The complete immutable worker tuple must use the
  selected provider and either the candidate SHA or a source with identical
  committed worker inputs. Missing qualification, stale inputs, unreadable
  Git history or a missing endpoint cannot authorize this exception. An
  answering identity with revoked qualification blocks a cloud-enabled desktop
  even if its worker-input tree matches the tag baseline.
- Migration changes relative to published channel state block until the fixed
  channel API's `/v1/release-identity` verifies a completed manual cutover.
  The response must be ready, belong to that channel, have maintenance off and
  current migrations. It must report either the candidate's exact `sourceSha`,
  or the candidate's complete migration manifest: `expectedHead` and recorded
  `head` equal the candidate head, with equal `manifestSha256`. On success the
  summary says **manual cutover verified**. The guard does not prove backup
  history and does not produce an automated hosted promotion receipt.

Missing, older, mismatched, malformed or timed-out identity responses keep an
unverified migration candidate blocked, with the exact backup/migration/deploy/rerun procedure
in its error annotation and summary. The worker condition remains independent:
manual schema verification cannot authorize an unqualified cloud worker.

The explicit required-CI barrier replaces reliance on Railway's **Wait for CI**
for workflow-owned mutations and feed publication. An initially failed Preflight
does not permanently discard the candidate: the gate observes a successful
same-SHA rerun. Railway's independently skipped autodeploy is not resurrected by
that gate. The disabled compatibility guard still does not control independent
Railway or Pages Git integrations, so leave deploys held until the owner has
disabled those integrations and enabled/rehearsed the ordered controller. A
legacy manual deploy must be selected explicitly after CI and schema proof;
green desktop CI alone does not certify that hosted services shipped.
See [Railway Wait for CI](https://docs.railway.com/deployments/github-autodeploys#wait-for-ci).
Before enabling the ordered controller, disable independent autodeploy and
Wait for CI as below; otherwise the hosted-before-desktop order would deadlock.

The channel lock protects the running workflow, but GitHub may replace a
**pending** workflow with a later one. Every desktop writer reruns the complete
guard decision, so a displaced guard cannot authorize a descendant's desktop
publication. This is not a provider deployment barrier: Railway can ignore a
cancelled workflow if another workflow for that commit passed. Hold independent
Railway and Pages autodeploy **before merging a migration cutover**, freeze the
candidate until completion, or use the enabled ordered controller. Wait for CI
alone cannot guarantee ordering for cancelled pending runs. See
[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
and [Railway's cancellation rules](https://docs.railway.com/deployments/github-autodeploys#wait-for-ci).

Configure these GitHub **environment** variables independently in `alpha`,
`beta`, and `production` (not in `.env.agent`):

| Variable                                                             | Required value or source                                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ZEROS_HOSTED_PROMOTION`                                             | unset/disabled initially; exactly `enabled` after rehearsal                                          |
| `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID` | target UUIDs; environment name must equal channel; API custom domain and repository/root are checked |
| `PLANETSCALE_ORG`                                                    | organization owning this channel database                                                            |
| `PLANETSCALE_DATABASE`                                               | exactly `zeros-control-plane-alpha`, `zeros-control-plane-beta`, or `zeros-control-plane-production` |
| `PLANETSCALE_BRANCH`                                                 | `main`; each is a separate database, not three branches of one database                              |
| `CLOUDFLARE_ACCOUNT_ID`                                              | account owning the channel's Pages projects                                                          |
| `CF_PAGES_APP_PROJECT`                                               | `zeros-web-alpha`, `zeros-web-beta`, or `zeros-web`                                                  |
| `CF_PAGES_OPS_PROJECT`                                               | `zeros-ops-alpha`, empty for Beta, or `zeros-ops`                                                    |
| `AUTH_PROVIDER`                                                      | `workos` for the automated hosted lane                                                               |
| `AUTH_ISSUER`, `AUTH_JWKS_URL`                                       | channel's qualified public WorkOS issuer and signing-key URL; HTTPS only                             |
| `AUTH_WEB_CLIENT_ID`, `AUTH_DESKTOP_CLIENT_ID`                       | distinct channel client IDs; public verification metadata, never client secrets                      |
| `ZEROS_CLOUD_WORKSPACES_ENABLED`                                     | exact desktop capability decision; `true` only after qualification                                   |
| `CLOUD_WORKSPACE_PROVIDER`                                           | `boat` for managed Boat; `daytona` retains the legacy SSH requirement                                |
| Existing desktop auth/origin/preview values                          | the exact channel values in the earlier tables                                                       |

The event supplies `RELEASE_SHA`, `RELEASE_BRANCH` and channel;
they are not owner-overridable deployment variables. `GITHUB_SHA` must equal
the selected source. The workflow checks out that SHA with full history and
refuses a dirty checkout before hosted mutation. The publication guard allows
packaging's working-tree edits and reads contracts from committed Git objects.
IDs, source, database and branch are checked before
mutation, and the current branch head is rechecked after the migration plan.

| Environment secret                                          | Minimum authority                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RAILWAY_DEPLOY_TOKEN`                                      | Railway project token scoped to the target environment, sent as `Project-Access-Token`; read target/config/autodeploy/deployment state, commit an explicit source patch with deploys suppressed, deploy the exact service SHA          |
| `PLANETSCALE_SERVICE_TOKEN_ID`, `PLANETSCALE_SERVICE_TOKEN` | database-scoped `read_database`, `read_branch`, `read_backups`, `write_backups`, `connect_production_branch`, `create_production_branch_password`, `delete_production_branch_password`; Alpha's main is also a production-class branch |
| `CLOUDFLARE_API_TOKEN`                                      | account-scoped Cloudflare Pages Edit for project inspection/update/direct upload; DNS changes stay a separate owner setup action                                                                                                       |
| Existing desktop secrets                                    | `CSC_LINK`, `CSC_KEY_PASSWORD`, analytics public-build credentials; Production retains `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`                                                                                      |

Actions needs `contents:read` and `actions:read` even for the disabled guard's
publication-history bootstrap. The workflow supplies `GH_TOKEN` from its
repository-scoped `GITHUB_TOKEN`, never a provider token. The hosted lane also
reads the successful Beta run and downloads
that run's named receipt artifact; an arbitrary JSON file or a release branch
name is insufficient. Artifacts are retained for 90 days. Expired evidence
requires a new successful Beta run, never a bypass. Job provenance is read from
`/actions/runs/<id>/attempts/<recorded-attempt>/jobs`, with the named promotion
and receipt-upload steps both successful; overall Beta success is checked
separately. Desktop publishing has `actions:read` for this check alongside its
existing narrowly scoped `contents:write`. No migration/runtime owner URL,
WorkOS server secret, GitHub App private key or R2 encryption key belongs in a
Pages or desktop build environment.

Inherited notarization follow-up: Production still passes
`APPLE_APP_SPECIFIC_PASSWORD` to `notarytool --password`. Those existing submit,
poll and log commands remain unchanged here. Apple's supported keychain-profile
or App Store Connect private-key flow can avoid password argv, but secure profile
bootstrap/key provisioning and retry behavior require a macOS rehearsal before
changing Production authentication. This is an existing exception to the new
controller's no-secret-argv rule, not a verified fix. See
[Apple TN3147](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool).

Owner setup, once per channel before **enabling** the controller:

1. Configure protected environment branch policies (`main` for Alpha,
   `release/*` for Beta/Production) and keep the Production human reviewer on
   `production-approval`.
   Confirm fork workflows cannot access release environments.
2. Keep server WorkOS/GitHub App/database/object-store/keyring settings in
   Railway. Provision separate channel databases, unprivileged runtime roles,
   cloud buckets, encryption keys and validated callback allowlists. Supply
   real preview DNS/TLS and a matching preview suffix only for a later
   preview-enabled release; the first desktop cloud release leaves preview
   settings unset. Bootstrap the stable database object owner through the documented
   migration procedure; the workflow cannot grant its own authority.
3. Disable Railway independent autodeploy through its actual toggle and turn
   Wait for CI off. A watch-pattern hold alone is not sufficient: the
   controller checks `serviceInstanceAutoDeployStatus.enabled === false`.
   Keep the Git repository connection, root `apps/control-plane`, custom API
   domain, and correct source branch. Clear unrelated staged environment
   changes; the controller refuses them. Reserve source/config writes to this
   controller during promotion so a dashboard writer cannot race its
   source retarget. The controller never accepts a shared staging area.
4. Disable production AND preview Git builds on every channel Pages project
   and retire independent deploy hooks. Set the project's **production**
   runtime variables and app/Ops domain identity as above. WorkOS server/Dev
   fields must be absent. Rehearse Wrangler upload into the existing
   Git-connected project, including Functions and custom-domain manifests.
5. Agree the recovery window. The migrator creates a fresh 14-day database
   backup, but that alone does not retain R2 objects or encryption-key versions
   for 14 days. Retain referenced objects/keys for the chosen window or declare
   the shorter restorable workspace window. Never automatically restore a
   database or delete a referenced rollback/customer snapshot.
6. Rehearse a failed backup, checksum mismatch, role cleanup failure, lost deploy
   acknowledgement, stale branch, active provider autodeploy and Pages manifest
   mismatch on isolated targets. Every failure must withhold later publication.
   Do not rerun a mutation after an ambiguous response until its provider state
   is reconciled. Workflow cancellation/runner loss also requires reconciliation.

## Worker lane and first rollout of this branch

`cloud-worker-promotion.yml` supports dispatch and `workflow_call`, shares the
hosted mutation lock, and uses `ZEROS_WORKER_PROMOTION=enabled` as its separate
switch. With the switch off, hosted promotion and publication do not require a
qualified worker even for a cloud-enabled desktop; the API keeps its current
worker tuple and the hosted services gate is unchanged. Plans remain mutation-free and never issue success receipts. Execution
requires a clean exact-event-SHA checkout, successful exact-SHA Preflight and
CodeQL, the new exact-SHA API/current schema and trusted pre-worker services
receipt (API, Pages and WorkOS). The supported broker uses only explicitly
designated credentials in the channel's encrypted store, never Dev authority
or static provider credentials from CI. **Keep the switch disabled until the
owner consent/configuration ceremony and protected rehearsal pass.**

Implemented, fake-tested worker primitives in `scripts/release/` include:

- Exact committed input-tree hashing using the existing worker input policy.
- Existing Boat image kit export/build/attestation, fresh sanitation at snapshot
  save, ready-state polling and confirmed owned-builder cleanup.
- Shared disposable-VM transport and native report verification used by Dev,
  rebound to the release channel with a newly hashed version-3 evidence document
  (including native MCP). All three offered credential kinds must pass;
  Codex subscription requires the real
  renewal/cache/account-binding evidence as well as image refresh adoption.
- The audited `manageCloudAgentRuntime` operator with one short-lived
  PlanetScale owner login for plan and execute, target/hash match and confirmed
  role deletion before selection. No direct qualification-table INSERT.
- A complete worker tuple passed to a single update callback:
  `CLOUD_WORKSPACE_PROVIDER`, `BOAT_SNAPSHOT_ID`, `BOAT_IMAGE_BUILD_SHA256`,
  `ZEROS_CLOUD_SOURCE_COMMIT`, `ZEROS_CLOUD_IMAGE_ARCHITECTURE`, and
  `CLOUD_WORKSPACE_STORAGE_MIB`. The Railway adapter uses one
  `variableCollectionUpsert` with `replace:false, skipDeploys:true`, then reads
  back the tuple. Worker owns this sole tuple write; hosted finalization then
  redeploys the same API SHA and verifies qualification and the selected tuple.

The success handoff is artifact `worker-promotion-<channel>-<source_sha>`, file
`worker-receipt.json`, produced by job `worker`, execution step
`Worker plan or guarded execution`, upload step `Save success receipt`. It binds
repository, channel, branch, event SHA, committed inputs, parent run ID and
recorded attempt, the complete tuple, profile, three kinds, approval/evidence
hashes and confirmed temporary-VM/owner-role deletion. Callable executions
require a genuine receipt even if post-services identity would otherwise permit
reuse. Standalone unchanged-worker reuse is receipt-free. No plan or another
run's receipt can authorize hosted finalization.

Default **SMOKE** uses two messages per agent; **FULL** is selected for native
adapter/containment/contract inputs or explicit request. Anthropic/OpenAI
API-key modes stay unoffered on an image until separately qualified. Dev rate
limits defer retry with bounded backoff without consuming the three attempts;
release returns **“canary account rate-limited”** without automatic retry or
approval. Alpha, Beta, Production, Dev and custom images share Boat's current
subscription quota. Zeros imposes no numerical snapshot limit, per-channel
allocation or spare slot. Complete inventory and unreleased named reservations
remain tracked, including the retained base. Boat capture responses enforce
the plan's allowance; quota and rate-limit errors keep their safe classification
without releasing uncertain reservations. Builder compute limits remain separate.

See [release worker qualification](cloud-workspace/release-worker-qualification.md)
for exact protected secret names/configuration, the encrypted rotation-safe
store, the owner-only **Use for release checks** Settings switches and automatic
server-side connection discovery, profile inputs, account
budgets, snapshot retirement and lost-response recovery. No owner, native
credential or approval may be copied from a Dev fixture into a release channel.

Required live rehearsal still includes account/billing and snapshot ownership,
quota and budget failure, runner interruption and cleanup recovery, native
permission/tool execution, Codex real renewal, Files/Changes/Review, terminal,
Git author/PR writes, reconnect, idle cancellation, checkpoint/stop/wake/archive
and existing-generation compatibility. Machine attestation alone does not
prove these user flows. Retain selected snapshots and encryption keys for old
workspaces; selecting a new default does not upgrade running generations.

For this branch's first rollout:

1. Keep `ZEROS_HOSTED_PROMOTION` and `ZEROS_WORKER_PROMOTION` disabled and
   `ZEROS_CLOUD_WORKSPACES_ENABLED=false` for the initial desktop release.
   Hold independent Railway and Pages autodeploy before merging this schema
   cutover; do not rely on Wait for CI if a pending workflow could be cancelled.
   Freeze the candidate SHA until the release finishes. Merge the reviewed
   candidate to `main`. Its schema differs from the published `alpha` baseline,
   so the guard should fail until cutover is verified. An actual failed workflow
   makes Railway skip that SHA when Wait for CI is on; a cancelled pending run
   is not equivalent. Worker changes alone do not fail a cloud-disabled release.
2. The operator records the exact event SHA, re-reads the live ledger/checksums,
   builds the committed candidate and prepares the reviewed drain/maintenance
   ceremony for any controlled migrations. Inspect the complete pending set;
   do not assume migrations 0105–0112 are the entire change and never rewrite
   applied SQL. Hold Railway autodeploy and turn Wait for CI off for the
   explicit cutover, with no unrelated staged dashboard changes. The old
   backend may refuse an advanced ledger on restart.
3. From that exact checkout, run the strict release command:

   ```sh
   NODE_ENV=production pnpm --dir apps/control-plane release-migration:manage \
     --database zeros-control-plane-alpha --branch main \
     --execute --confirm zeros-control-plane-alpha
   ```

   It creates and awaits a fresh PlanetScale backup before migration. Complete
   any separately reviewed controlled-migration approvals and require
   `ledger=verified` and `role.deleted=true`; retain the backup/cleanup evidence.
4. Immediately deploy the same SHA explicitly through Railway's
   `serviceInstanceDeployV2(commitSha, environmentId, serviceId)` for Alpha,
   wait for deployment `SUCCESS`, then verify
   `https://api-alpha.zeros.build/v1/release-identity`: exact SHA, current
   candidate migration manifest, maintenance false and readiness true.
   This manual first cutover installs the endpoint even if the previous
   backend had none; a separate identity bridge is optional for this disabled
   path. Never use a moving “latest commit” deployment or bypass failed
   readiness. Roll forward or use the separately authorized recovery plan.
5. Upload matching Pages app/Ops, verify custom-domain manifests and auth
   handoffs, then **re-run the failed Release (alpha) workflow for the same
   SHA**. Its disabled guard now reports **manual cutover verified**, and the
   desktop publisher reruns that decision against freshly fetched tags and live
   identity before writing assets. The cloud-disabled desktop can publish and
   advance the rolling `alpha` tag. A later docs-only push containing the same
   unverified migrations cannot bypass cutover. All quality, signing, updater,
   PTY and engine gates remain. Restore the chosen legacy Git autodeploy/Wait
   for CI settings after reconciling the completed cutover; later ordinary
   pushes with unchanged published schema keep their existing behavior while
   promotion remains disabled. Beta's first branch push and Production dispatch
   require either matching live identity or unchanged schema relative to a
   successful channel publication verified against its tag. Stale rolling refs
   alone cannot prove the previous published schema; successful publish-step
   evidence can bootstrap them without ref mutation. If that evidence or the
   channel tag is unavailable, perform the identity-verified manual cutover first.
6. Cloud enablement is a separate step: qualify the exact candidate worker,
   apply its audited runtime approval with the same owner login for plan/apply,
   confirm cleanup, select the full worker tuple and verify it live. Rehearse
   the guarded transport/receipt handoff after API, Pages and WorkOS using only
   the owner's explicitly designated three-mode matrix and protected secrets.
   Code and fake tests are not live qualification. Only then set the desktop cloud flag
   true and build/smoke the cloud-enabled macOS app. A successful cloud-disabled
   desktop release does not qualify the full-cloud launch.
7. Enable the ordered controller only after the owner setup above and
   isolated rehearsal pass. An unchanged worker can be reused only when the
   selected public identity has `workerQualified=true` and its committed
   worker-input tree matches the candidate; final readiness pins the same tuple;
   a changed or unmeasurable worker blocks hosted promotion. Then repeat the
   isolated setup for Beta and promote Production only from its successful
   exact-SHA Beta receipt.
   A cloud-disabled desktop (`ZEROS_CLOUD_WORKSPACES_ENABLED` not `true`) is
   the deliberate exception: it does not depend on the worker, so promotion
   neither compares worker inputs nor requires qualification, even when the
   API itself runs staff cloud with an unqualified worker. The API must still
   keep the tuple it served at the services handoff; finalization refuses a
   change, and a worker change belongs to the worker lane. This is not a
   cloud qualification: an API change that a running worker depends on still
   needs the worker ceremony. The services receipt records the desktop cloud
   capability, and finalization and publication refuse a different one. The
   build job records the capability it baked into the app, and publication
   refuses to reinterpret it: changing the variable means rebuilding.

### Controlled cutover workflow

`controlled-cutover.yml` is the dispatched, owner-gated path for migrations
the automated lane refuses: controlled-downtime and contract boundaries such
as a first rollout's 0101/0103. Dispatch it from `main` for Alpha or from the
frozen `release/X.Y.Z` for Beta/Production with `approvals` listing exactly the
pending controlled filenames (empty when none) and `confirm` set to the
channel database name. Production waits for its single approval in
`production-approval`. It uses
the channel environment's promotion secrets and variables and shares the
`hosted-mutation-<channel>` lock.

In order, it:

1. Checks exact-source CI and branch freshness. Production also requires
   Beta's latest successful publication to be this exact SHA.
2. Plans the migration and refuses any mismatch between the plan's controlled
   set and `approvals`.
3. Validates every Railway and Pages destination read-only, and requires the
   channel environment to run only the control-plane service. All of this
   happens before any provider setting changes.
4. Holds every independent deployer. It removes the service's Railway GitHub
   deployment triggers, which are what the dashboard's **Disable** deletes and
   which carry Wait for CI, and confirms automatic deployments are off. It then
   turns off Pages production and preview builds. A project token cannot use
   `serviceInstanceAutoDeployUpdate`, and any source patch, including the
   branch retarget below, can recreate a trigger, so each retarget removes
   triggers again.
5. Retargets the Railway and Pages sources to the release branch.
6. Sets `DATABASE_MAINTENANCE_MODE=true` and deploys the exact SHA, then waits
   until that candidate reports `maintenance: true`. Maintenance fences every
   writer and skips schema verification at boot.
7. Waits until every replaced deployment is `REMOVED`, `FAILED`, `CRASHED` or
   `SKIPPED`, because Railway can keep an old deployment serving through its
   overlap and draining windows.
8. Runs the strict backup and migration with only those approvals, and
   requires `ledger=verified` and `role.deleted=true`.
9. Clears maintenance and redeploys the same SHA, then requires ready identity
   with the candidate manifest.
10. Uploads Pages and verifies WorkOS.

It saves `controlled-cutover-<channel>-<sha>/cutover-receipt.json` on success,
and an allowlisted journal on every run: stage, the maintenance state as last
confirmed, deployment and backup identities, and the pending set after a
failed migration. A failure leaves the state it reached and names it; nothing
is rolled back.

Then rerun the failed desktop release for the same SHA. Its disabled guard
reports **manual cutover verified** only when the API identity matches and
every Pages surface serves the cut-over API's commit. A run stopped before
Pages therefore cannot publish the desktop. The hold leaves the channel ready
for `ZEROS_HOSTED_PROMOTION=enabled`.

Provider contracts used by the controller:
[Railway service API](https://docs.railway.com/integrations/api/manage-services),
[Railway environment schema](https://backboard.railway.com/schema/environment.schema.json),
and [Pages CI direct upload](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).
Provider mutations have not been rehearsed against a release channel by this
implementation; unit fakes and read-only API schema inspection are not a live
deployment qualification.
