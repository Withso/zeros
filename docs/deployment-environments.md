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

| Variable                     | Alpha                                    | Beta                                    | Production                                    |
| ---------------------------- | ---------------------------------------- | --------------------------------------- | --------------------------------------------- |
| `DATABASE_URL`               | Alpha Postgres private reference         | Beta Postgres private reference         | Production Postgres private reference         |
| `AUTH_PROVIDER`              | optional; `workos` or unset              | optional; `workos` or unset             | optional; `workos` or unset                   |
| `AUTH_AUDIENCE`              | `https://api-alpha.zeros.build`          | `https://api-beta.zeros.build`          | `https://api.zeros.build`                     |
| `AUTH_ISSUER`                | exact Alpha WorkOS issuer                | exact Beta WorkOS issuer                | exact Production WorkOS issuer                |
| `AUTH_JWKS_URL`              | exact Alpha WorkOS JWKS URL              | exact Beta WorkOS JWKS URL              | exact Production WorkOS JWKS URL              |
| `AUTH_WEB_CLIENT_ID`         | Alpha Web Application                    | Beta Web Application                    | Production Web Application                    |
| `AUTH_DESKTOP_CLIENT_ID`     | Alpha Desktop Application                | Beta Desktop Application                | Production Desktop Application                |
| `APP_ORIGIN`                 | `https://app-alpha.zeros.build`          | `https://app-beta.zeros.build`          | `https://app.zeros.build`                     |
| `OPS_ORIGIN`                 | `https://ops-alpha.zeros.build`          | unset; startup rejects Ops in Beta      | `https://ops.zeros.build`                     |
| `WORKOS_API_KEY`             | Alpha server key                         | Beta server key                         | Production server key                         |
| `WORKOS_COOKIE_PASSWORD`     | unique random Alpha 32+ character secret | unique random Beta 32+ character secret | unique random Production 32+ character secret |
| `WORKOS_WEBHOOK_SECRET`      | Alpha endpoint signing secret            | Beta endpoint signing secret            | Production endpoint signing secret            |
| `NODE_ENV`                   | `production`                             | `production`                            | `production`                                  |
| `INVITE_LINK_BASE`           | `https://app-alpha.zeros.build/invite`   | `https://app-beta.zeros.build/invite`   | `https://app.zeros.build/invite`              |
| `GITHUB_OAUTH_CALLBACK_URL`  | matching Alpha API callback              | matching Beta API callback              | matching Production API callback              |
| `GITHUB_COMPLETION_PAGE_URL` | matching Alpha app page                  | matching Beta app page                  | matching Production app page                  |

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

Set these common values in the project's Production variable configuration:

| Variable            | Alpha                           | Beta                           | Production                |
| ------------------- | ------------------------------- | ------------------------------ | ------------------------- |
| `ZEROS_DEPLOY_ENV`  | `alpha`                         | `beta`                         | `production`              |
| `AUTH_PROVIDER`     | `workos` or unset               | `workos` or unset              | `workos` or unset         |
| `APP_ORIGIN`        | `https://app-alpha.zeros.build` | `https://app-beta.zeros.build` | `https://app.zeros.build` |
| `CONTROL_PLANE_URL` | `https://api-alpha.zeros.build` | `https://api-beta.zeros.build` | `https://api.zeros.build` |

Pages has no provider-specific secret or binding. It remains a same-origin
facade using only the common `APP_ORIGIN` and `CONTROL_PLANE_URL`. Remove any
retired `SESSIONS` or `AUTH_SESSIONS` binding, `AUTH0_*` variable,
`WORKOS_SESSION_WORKER`, `WORKOS_WEBHOOK_SECRET`, or `AUTH_BROKER_SECRET` from
the Pages projects. Browser credentials are host-only random cookies; their
digests, PKCE verifier, encrypted sealed session, and serialized refresh state
live in the channel's PlanetScale Postgres.

For `zeros-ops-alpha` and `zeros-ops`, set `ZEROS_SURFACE=ops`,
`WORKOS_BROWSER_ROUTE_PREFIX=/ops`, and the Ops hostname as `APP_ORIGIN`.
Do not configure marketing hosts.
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
3. In Railway's `alpha` environment, set the exact
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
   `APP_ORIGIN=https://app-alpha.zeros.build`, and
   `CONTROL_PLANE_URL=https://api-alpha.zeros.build`. Remove retired broker,
   session-worker, and WorkOS secret bindings, then deploy the same `main` SHA.
7. In the GitHub `alpha` Environment, set the public WorkOS desktop release
   variables from the table below and build the same SHA. Do not add a WorkOS
   API key to GitHub.
8. Qualify private-browser web login/refresh/logout, webhook delivery, and a
   packaged macOS login/refresh/relaunch/current-device logout/all-device
   revocation. Keep the previous database/deployments available until Alpha
   passes the soak window.

Railway accepts one issuer at a time. Change the database, Railway, Pages,
WorkOS webhook, and matching desktop build as one coordinated operation. Never
change only the browser or only the control plane.

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
renderer, and both are now also available to Electron main for hosted WorkOS
desktop authorization and GitHub handoffs. A missing Alpha/Beta value
cannot silently fall back to Production.

Desktop release environments recognize these environment-scoped Actions
variables:

| Variable                         | Value                                                                 |
| -------------------------------- | --------------------------------------------------------------------- |
| `AUTH_PROVIDER`                  | `workos` or unset                                                     |
| `AUTH_DESKTOP_CLIENT_ID`         | channel Desktop Application ID                                        |
| `AUTH_ISSUER`                    | exact qualified issuer                                                |
| `AUTH_JWKS_URL`                  | exact qualified JWKS URL                                              |
| `AUTH_AUDIENCE`                  | matching channel API origin                                           |
| `ZEROS_CLOUD_WORKSPACES_ENABLED` | `false` until that channel's desktop cloud client is release-approved |

The authentication entries are public verification values baked only into
Electron main. Never add a WorkOS API key—generic, web, desktop, or channel-
prefixed—to a desktop release environment. The release gate rejects any
`WORKOS_*_API_KEY` shape.

`ZEROS_CLOUD_WORKSPACES_ENABLED` is a separate exact-`true` desktop build
capability, not the Railway `CLOUD_V2_ENABLED` rollout flag and not an
installed-app preference. The checked-in
[`cloud/channels.json`](../apps/control-plane/src/cloud/channels.json)
policy is an additional required gate shared by desktop builds, control-plane
configuration and release jobs. Every channel currently allows cloud; setting
one to `false` pauses it. Desktop `dev` maps to `development`, and `stable` to
`production`. Environment opt-ins cannot override a paused channel. On an allowed channel,
the protected release environment supplies one value to both the packaged
engine and Electron compile steps; each artifact bakes it, and Electron pins
the child environment to the same decision. Leave it unset or set it to `false`
until the channel is approved. Enabling only the backend does not activate a
desktop client, and enabling only the desktop does not bypass backend admission.
Cloud v2 relays agents, files, Git and terminals through the control plane's
connection into each worker. Design,
browser, simulators, old preview grants and SSH gateway configuration are not
part of this release path.

On channels that allow cloud, Organization Settings → Agents credential
enrollment is independent of desktop cloud execution. Signed-in members can
connect their own native accounts while
`ZEROS_CLOUD_WORKSPACES_ENABLED=false`; Electron still validates requests, binds
ceremonies to the current main session and window, and imports into the current
channel's authenticated backend. That backend needs its credential encryption
and Codex refresh-fingerprint keys. Enrollment allocates no VM, bypasses no
workspace admission gate, and does not authorize release checks: **Use for release
checks** retains its separate configured platform-owner and current-revision
consent requirements.

### Cloud channel policy

`apps/control-plane/src/cloud/channels.json` allows cloud on every channel. The
desktop and release tools read the same policy. Setting a channel to `false`
pauses it: cloud entry points close, existing resources are preserved, and Local
Personal and organization-local workspaces stay available.

Allowing a channel changes nothing by itself. The backend still needs
`CLOUD_V2_ENABLED=true` and its provider configuration, and a desktop build
needs `ZEROS_CLOUD_WORKSPACES_ENABLED=true`. Turn on Beta first, then
Production from the same release commit. Every resource and key below is the
channel's own; never reuse Alpha's.

1. **Release.** Ship a `main` commit containing the allowing policy through
   the normal ladder. The channel must reach migration 0215 or later; from 0166
   that includes the controlled batches 0182 and 0191–0200, applied with the
   [controlled cutover](#controlled-cutover-workflow). On an allowed channel the
   control plane parses existing `CLOUD_WORKSPACE_SECRET_*` and
   `CLOUD_CODEX_REFRESH_FINGERPRINT_*` values at boot, and a malformed one stops
   it. Check them first from a checkout with the channel's Railway environment
   linked; this prints `cloud keyrings ok` or names the bad variable, never a
   value:

   ```sh
   railway run pnpm --dir apps/control-plane exec tsx -e 'import("./src/agent-credentials/agent-credential-config.ts").then(m => { m.loadCloudAgentCredentialConfig(process.env); console.log("cloud keyrings ok") }).catch(e => { console.error(e.message); process.exit(1) })'
   ```
2. **Cloudflare R2.** Create a bucket and an R2 API token with Object Read &
   Write on that bucket only. The runtime publisher and the control plane both
   use it.
3. **Boat.** Create an API key for the channel's Boat account, plus its billing
   organization if it pays from an organization wallet.
4. **Railway.** On the channel's control-plane service, set the variables in
   [Cloud workspaces → Configuration](cloud-workspaces.md#configuration):
   `CLOUD_V2_API_URL` and `CLOUD_V2_REALTIME_URL` (the channel's API origin as
   `https://` and `wss://`), a new `CLOUD_V2_WORKER_SIGNING_KEY` and the four
   `CLOUD_V2_RUNTIME_STORE_*` values. Keep an existing `BOAT_API_KEY`,
   `BOAT_BILLING_ORG`, agent vault keyring (`CLOUD_WORKSPACE_SECRET_*`) and
   Codex fingerprint keyring; add them only where missing. Leave
   `CLOUD_V2_ENABLED` unset until step 5. Back the keys up: credentials sealed
   with a lost key cannot be read.
5. **Runtime.** Publish the worker runtime to the channel's store with its
   variables, set the returned `CLOUD_V2_RUNTIME_SHA256`, then set
   `CLOUD_V2_ENABLED=true` and redeploy. `/v1/release-identity` must report
   cloud enabled and healthy.
6. **Desktop.** Set the GitHub environment's
   `ZEROS_CLOUD_WORKSPACES_ENABLED=true` and release a desktop build.
7. **Qualify.** With an account that has Pro (platform owners and developers
   have it automatically), create an organization, build its Cloud Computer,
   and create, stop, wake and delete a workspace. Members connect GitHub in
   Settings → Integrations; the channel's GitHub App needs the same repository
   permissions as Alpha's.
8. **Clean up.** Once the release runs in the channel, delete settings nothing
   reads any more, after saving any secret you may need for old backups: the
   cloud v1 settings `BOAT_ACCOUNT_SCOPE`, `BOAT_COMPUTE_POLICY_ID`,
   `BOAT_IMAGE_BUILD_SHA256`, `BOAT_SECONDS_PER_DOLLAR`, `BOAT_SNAPSHOT_ID`,
   `BOAT_TTL_SECONDS`, `CLOUD_WORKSPACES_ENABLED`, every `CLOUD_WORKSPACE_*`
   except `CLOUD_WORKSPACE_SECRET_*`, `RUNTIME_QUALIFICATION_ACTOR_USER_ID`,
   `WORKER_ADMISSION_CONFIG_JSON`, `WORKER_CANARY_*`,
   `ZEROS_CLOUD_IMAGE_ARCHITECTURE`, `ZEROS_CLOUD_SOURCE_COMMIT`,
   `ZEROS_RELEASE_CANARIES_ENABLED` and `OPERATIONS_ALERT_EMAIL`, plus
   `VAULT_MASTER_KEY` and the optional `AUTH_PROVIDER`. Older releases still
   read some of these, and before the Auth0 removal an unset `AUTH_PROVIDER`
   meant Auth0, so never delete them first.

WorkOS needs no cloud-specific change.

Cloud runtime publication and VM lifecycle are described in
[Cloud workspaces](cloud-workspaces.md). Runtime delivery is independent of
signed desktop artifact publication.

Set GitHub Environment deployment-branch protection too: `alpha` permits only
`main`; `beta` and `production` permit `release/*`.
The stable desktop workflow itself rejects `main` and requires an exact
`release/X.Y.Z` ref, so a manual dispatch cannot bypass the promotion ladder.

Production takes **one human approval per run**. The `production-approval`
environment holds the required reviewer, permits only `release/*`, and has no
secrets or variables. `release.yml` starts with an `approve` job in that
environment, and every job that can read `production` secrets needs it: build,
submit, notarize, publish and the hosted lane it calls. A direct Production
dispatch of `controlled-cutover.yml` needs the same approval; Alpha and Beta
skip it. The `production` environment
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
   advancing through this migration artifact requires all 21 controlled
   boundaries:

   ```bash
   NODE_ENV=production \
   CONTROL_PLANE_MIGRATION_APPROVALS=0009_organization_team_hierarchy.sql,0025_cloud_workspace_engine_authority.sql,0060_cloud_workspace_pending_blob_deletions.sql,0061_workos_provider_erasure_fences.sql,0073_cloud_workspace_compute_leases.sql,0075_security_event_commit_order.sql,0076_cloud_workspace_individual_pro_and_pilot.sql,0079_cloud_workspace_user_compute_funding.sql,0101_cloud_workspace_pro_entitlements.sql,0103_cloud_workspace_pro_sharing.sql,0182_retire_legacy_cloud.sql,0191_retire_legacy_cloud_02.sql,0192_retire_legacy_cloud_03.sql,0193_retire_legacy_cloud_04.sql,0194_retire_legacy_cloud_05.sql,0195_retire_legacy_cloud_06.sql,0196_retire_legacy_cloud_07.sql,0197_retire_legacy_cloud_08.sql,0198_retire_legacy_cloud_09.sql,0199_retire_legacy_cloud_10.sql,0200_retire_legacy_cloud_11.sql \
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

The ZIP must also store each framework's symlinks as links. electron-builder
26.15.0–26.15.3 built it with 7-Zip 24.09 without `-snl`, so `Versions/Current`
became a real directory and the ZIP failed verification as "bundle format is
ambiguous" while the DMG passed; 26.15.4 restores the links. PR packaging checks
build only an unpacked `--dir` app, so the first ZIP is the release's own.
`scripts/__tests__/electron-builder-mac-zip-symlinks.test.ts` runs the real archive
step and fails if a dependency change stops it storing links for macOS.

1. Merge a green PR to `main`. Each release starts its signed Mac build **in
   parallel** with the wait for **required CI for its exact event SHA**. By
   default that is successful Preflight and CodeQL; automatic Alpha can opt in
   to the critical evidence policy below. `hosted-promotion.yml` starts after CI,
   without waiting for the build. A separate feed publisher waits for both lanes
   and CI. PR checks for a
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
secret-free ship guards. Mac builds retain provider artifact checks,
the compiled engine lifecycle and packaged terminal smoke tests, channel-specific
environment routing, blockmaps, and signature verification. Builds have only
`contents: read`, protected signing credentials and public build configuration,
not Railway/PlanetScale/Cloudflare/Boat/WorkOS or Apple notary credentials. Signing
credentials appear only in the build job. Only the final publisher has
`contents: write`; it has no signing or provider credentials.

```text
CI (exact SHA) ──► hosted services ──► final API readiness ──┐
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
target, not a measured guarantee**: provider deployment,  CI failures/reruns, runner queues and Production's Apple queue can
extend it. The `ui-smoke` job is unchanged by this restructuring.

### Concurrent Alpha preparation

Each `release-alpha.yml` push/main run starts its exact-source CI barrier,
read-only version preparation independently. Protected
macOS signing waits only for that small version job, independently of CI.
There is no workflow-wide Alpha lock. Its `publication` job calls
`alpha-publication.yml` after the CI barrier reports `ready=true` and version
preparation succeeds, and holds `release-alpha` with cancellation disabled for
that entire reusable call:
entry revalidation, hosted services, final hosted receipt and desktop
feed/ledger/tag/readback/retention.
Individual hosted locks remain `hosted-mutation-<channel>`; their different
group avoids nesting the outer lock into itself. Beta and Production retain
their separate workflow-wide channel locks, full CI, branch gates and
Production approval/notarization. Their builds already run alongside Alpha.

The read-only `metadata` job computes `<next stable>-alpha.<parent run_number>`
with the original `compute-version.mjs` and a full tagged exact-SHA checkout.
Signing and publication consume that one output. The transaction passes it to
every hosted/publisher checkpoint; it never recomputes from later stable
tags. Failed-job retries can carry the successful metadata job and its original
version. A higher run counter with a lower prepared stable base must fail before
hosted writes: `1.0.0-alpha.402` cannot follow `1.0.1-alpha.401`. Both counter/source
and complete semantic-version/idempotency rules fence entry and downstream
mutations in every automatic Alpha mode. Off/unset/invalid mode still requires
exact current main and does not require an admission receipt. A context claiming
the original automatic parent must authenticate its current attempt/status;
failed authentication cannot fall back to ordinary full-CI/direct authority.

Hosted promotion can start while signing continues. After hosted success,
each publisher waits only for its own parent producer: up to 45 minutes,
polling every 10 seconds. The wait authenticates the original repository and
head repository, workflow path/name, push/main event, source SHA, run ID,
attempt and run number, then the exact producer job and its successful upload
and verification steps. Only the current attempt's jobs endpoint supplies
proof; GitHub-listed successful producers carried from older attempts remain
valid. Missing, ambiguous, malformed, failed, cancelled or skipped producer
proof refuses publication promptly. A queued/running producer waits within the
bound; a changed run attempt aborts. There is no cross-run fallback.

The wait authenticates the existing SHA-named artifact and emits its immutable
artifact ID. Download uses that ID from the original run, and post-download
verification rereads the current parent, producer ID/attempt and artifact ID.
A same-name overwrite or new attempt cannot replace the approved bytes. The
signed producer includes `alpha-build-metadata.json` with its source, repository,
parent run/counter, producing attempt, version and baked cloud boolean. The
desktop publisher verifies that metadata against the producing attempt, the
exact prepared version and updater feed before using the version/capability.
Current environment variables
cannot substitute for the capability already baked into the signed desktop.


The existing Alpha release's metadata edit retries at most three identical
`gh release edit` attempts, with 1 s and 2 s backoffs, only when gh reports a
single HTTP 5xx error for this repository's exact release object. Logs retain
the status and attempt without response text. Cancellation, other errors and
retry exhaustion stop publication before assets upload or tag advancement.
Release creation, upload and tag writes keep their existing behavior. These
retries stay inside the original publication lock and job lifetime; they do
not relax signed producing-attempt checks. After a terminal release failure,
use a full workflow rerun or a new push, not a failed-jobs-only rerun.

With an 8-minute gate, 11-minute signing build and 6-minute hosted deployment,
the example critical path stays `max(8+6, 11) = 14` minutes before final
publication when the small version job finishes during the gate and signing
still finishes before hosted. Version preparation adds a short stage before
signing; a delayed runner can extend that path. Waiting for signing before
starting hosted work would take about 17 minutes. These figures illustrate
overlap, not a measured latency guarantee;
runner queues, native qualification and deployment readiness still add time.
Concurrent preparation removes the previous release's build time from the
next candidate's preparation queue. GitHub can replace a pending publication
call, but never cancels an active transaction. A superseded initial CI barrier
skips that call without cancelling independent builds.

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

### Automatic Alpha CI evidence

The repository variable `ZEROS_ALPHA_CI_FAST_PATH=enabled` opts automatic
`release-alpha.yml` main pushes into Preflight's early `alpha-gate` alone.
An unset or other value retains the existing whole-run Preflight + CodeQL
policy. Beta, Production, manual Alpha operations and direct worker/cutover
paths keep that full policy and strict branch-HEAD equality. They do not read
Alpha authority or consume Alpha readiness outputs.

The release client authenticates `GITHUB_RUN_ID` through the Actions API. Its
parent must be `.github/workflows/release-alpha.yml`, a `push` on `main`, at the
exact `RELEASE_SHA` and current run attempt, with both repository identities
matching the release repository. `GITHUB_WORKFLOW_REF` must also identify that
caller; reusable hosted promotion retains the caller's workflow ref. Neither
the flag nor the workflow ref alone grants fast evidence. The shared hosted
input defaults to empty, so existing callers retain their original guard,
services, optional worker, finalization and receipt conditions.

Fast evidence selects the newest trusted exact-SHA **push/main** Preflight run
without status filtering, ordered by run ID and attempt. Its current attempt's
paginated jobs must list exactly one completed, successful `alpha-gate`. The
gate depends on successful `quality`, `test`, `build`, `control-plane` and
`secret-scan` aggregates. A carried gate cannot override a currently pending or
failed critical aggregate. Every main Preflight run executes all database
shards, including a docs-only push after an earlier service change. The fast path does not wait
for CodeQL: its findings are advisory, the scan still runs on every push, and
Beta, Production and every full-policy caller keep requiring its exact-SHA
success. PR, merge-group, fork and older-attempt proof cannot replace the gate, and Preflight from another branch is ineligible; cancellation refuses
admission. Every main push has its own full Preflight
([CI concurrency](ci-concurrency.md)). If a cancelled or failed candidate's gate
cannot succeed and main has moved on, the barrier treats it as superseded, a
green skip before any destination mutation, instead of waiting for the barrier
timeout. A newer pending or failed gate defeats an older success. API-listed
carried successes count on an ancillary-only retry; timestamps and certificate
artifacts are not inferred as proof. History is bounded to 100 runs per
workflow and 1,000 jobs, and an attempt change during job retrieval denies the
old snapshot.

The full Preflight run continues, including composer smoke and macOS workload.
Pending macOS credential proof is a deliberate Alpha deferral.
Observed failures in the macOS runtime pins, agent boot, Design authoring,
GitHub credential or file-access checks veto later admission and
publication even with a green gate. Only explicitly classified packaged-engine
lifecycle, workspace-lifecycle and Changes/Review failures may be deferred;
unknown or mixed failing macOS steps deny. Composer smoke failure may coexist
with a successful critical gate. Signed Mac builds retain their own shipping
provider, engine, packaged terminal, artifact and signature checks.

The initial automatic Alpha barrier writes `ready=true` after successful CI
and freshness checks, including when the flag is off and full CI succeeds. A
well-formed supersession before any destination mutation instead writes
`ready=false`, emits a notice and exits successfully. It checks all retained
parent attempts: a started destination, an earlier successful barrier that
unblocked destinations, or unavailable mutation evidence keeps the retry red.
Hosted promotion, desktop feed and runtime publication require `ready=true`.
Other errors and downstream supersession remain failures; a green no-op never
falls through to a provider, feed or runtime writer.

Hosted guard, services, finalization and both final publishers re-read the
selected evidence. Hosted promotion passes the optional Alpha CI input to its
nested native-worker callable, so that authenticated automatic Alpha parent
uses the same evidence at the worker wait and every worker checkpoint. Both
reusable inputs default to empty; direct worker dispatch, controlled cutover,
staff bootstrap, Beta and Production keep full CI and strict HEAD equality.

Leave the flag unset until the ordered Alpha controller is rehearsed and
independent Railway/Pages Git autodeploy is held. No repository or provider
setting changes are part of this opt-in implementation. Served-deployment
verification remains after deployment; `check:web-deploy` is not an early CI
producer.

### Automatic Alpha forward-only stages

`ZEROS_ALPHA_FORWARD_ONLY` is a separate repository variable from the CI fast
path. It defaults off: unset, empty or any value other than exactly `admitted`
or `enabled` preserves strict branch-HEAD equality. Only the authenticated
automatic `release-alpha.yml` push/main identity can use either stage; setting
the variable or reusable input alone grants no authority. The source remains
the immutable event SHA, including on reruns.

| Value | Barrier admission | Checks after admission |
| --- | --- | --- |
| Unset or other | Candidate equals current main HEAD | Candidate equals current main HEAD; authenticate parent and fence prepared version/publication order |
| `admitted` (Stage 1) | Candidate equals current main HEAD | Main contains the candidate; re-read every destination and publication order and refuse regression |
| `enabled` (Stage 2) | Main contains the candidate and every live Alpha destination is at or before it | Main contains the candidate; re-read every destination and publication order and refuse regression |

Ancestry uses the GitHub compare API with immutable SHAs: `identical` or `ahead`
is accepted only when the merge base is the base SHA. A rewritten main that
removes the candidate, missing main/admission identity, malformed comparison or
compare error fails red. Run IDs, publication times and identical input trees do not prove
Git ancestry. Main advancing to a descendant after admission allows the same
candidate to finish; all exact-source CI, services/worker/final receipts and
live API/Pages/schema/worker checks remain required.

The flagged barrier saves `alpha-admission-<sha>` only after successful CI and
freshness checks. Later checks require its own source/run/attempt-bound receipt
and the successful producing barrier and upload steps. A green `ready=false`
skip has no admission receipt. An earlier admitted attempt can support an
otherwise valid desktop-only retry of the same parent; an expired, missing or
foreign receipt blocks forward-only freshness. Enabling a stage midway through
an older unflagged run cannot manufacture admission.

Both stages read destinations after admission; Stage 2 also reads them at the
initial barrier. The checks use the existing bounded public Alpha API release identity, both
app and Ops `/zeros-deployment.json` manifests, the current rolling `alpha`
Git tag (including annotated tags), and the feed's cumulative
`alpha-release-ledger.json`. It compares each source separately with the
candidate; a live worker tuple, when present, must also be at or before it.
An enabled cloud API without a worker tuple is unknown and blocks admission;
the explicit cloud-disabled null tuple remains supported.
At admission, the tag and latest ledger entry must agree. After admission, a
parallel publisher may observe the current candidate's ledger before its tag
update (or the older cached ledger after the tag update); both sources must
still be at or before the candidate, and one must identify that candidate.
Other disagreements block. Missing feeds or
unreadable/malformed identities are unknown, not a zero/genesis destination.
The initial automatic Alpha barrier runs outside the publication lock, so it
can read an older publisher's ledger upload before that publisher moves the
tag. Only a mismatch whose identities and ancestry already passed validation
is pending: retry every 10 seconds, for at most 12 observations and a two-minute
pending deadline. Each retry reads all frontiers again; if the mismatch was
observed after green CI, it also reads CI again before issuing admission. A
persistent mismatch fails red, without `ready=true` or an admission receipt.
Malformed, unavailable, newer or divergent identities retain their existing
closed behavior; downstream, manual, Beta and Production checks gain no retry
or authority from this exception.
The publication entry job repeats authentication, CI/admission and fresh
frontier checks **inside** the encompassing lock before any provider writes.
It compares the authenticated parent's immutable `run_number` with every
retained Alpha ledger counter; an older order or another source claiming the
same order refuses mutation, including when source ancestry alone is equal.
It also validates the complete prepared version through the same semantic
version/idempotency checks used when building the publication ledger, without
waiting for signing. Signed metadata and the updater feed must match this
immutable prepared version. Downstream checkpoints repeat parent, version and
counter checks in every mode, plus frontier checks in both forward-only stages,
because a failed-job rerun can carry an earlier successful entry
job after a newer candidate has published. Only the original parent `ci` job
can issue admission or a green pre-mutation skip; nested entry conflicts fail
visibly.
The strict migrator still rejects unknown or newer schema rows; neither stage
rolls schema back or authorizes a controlled migration.

**Recovering an overlapping Alpha publication.**

Read the prior publisher's job outcomes first. Ledger upload and rolling-tag
movement are separate writes; neither side alone proves a completed release.
Read `GET /repos/Withso/zeros/git/ref/tags/alpha` (peeling annotated tags to a
commit) and the public
`https://github.com/Withso/zeros/releases/download/alpha/alpha-release-ledger.json`.
Require the tag to equal the last entry's `sourceSha`, a valid monotonic Alpha
ledger, and successful prior feed publication. The proposed source must contain
every destination source, with its exact-source required CI green. The normal
barrier and in-lock entry revalidate API, Pages, worker and schema identities;
`/healthz` alone is insufficient.

If the previous publisher finished and those reads now agree, no tag or ledger
repair is needed. Check that the candidate has no active attempt, then fully
rerun its release:

```sh
pnpm agent:gh run rerun <release-run-id> --repo Withso/zeros
```

Never use `--failed` for a release. Rebuild both producers in the same attempt
to preserve signed-build and artifact provenance. Verify the successful barrier,
fresh signed desktop and Linux runtime producers, hosted promotion, both
publishers, and matching final tag/ledger. Check the published runtime's exact
base qualification separately before rebuilding a Computer.

If disagreement persists after the publisher has stopped, retain the tag,
ledger, feed, producer and job evidence for owner-led forward recovery. There
is no tag/ledger rewrite operator: `release-ledger-cli.ts --build` and
`--verify` construct or verify ledgers, and do not reconcile partial publication.
Do not move tags or discard ledger history merely to unblock admission.

Stage 2 admission and both stages' later checkpoints read the deployed identity from a valid
HTTP 503 readiness response so a newer candidate can repair an unready Alpha
by moving forward. Maintenance, non-current or mismatched migration heads,
channel mismatch, invalid or persistently unreadable identities, other HTTP failures and
destinations newer than or divergent from the candidate still refuse admission.

The Alpha frontier reader retries transport failures, timeouts, HTTP 408/429/500/502/504
gateway failures and non-JSON 503 responses up to three times. Each attempt has
its own five-second abort deadline, with one- and two-second backoffs: at most
18 seconds overall. A received JSON identity with an invalid channel, source,
schema or maintenance state is refused immediately. The recovered identity
still passes the existing ancestry checks before any destination mutation.
This covers the failure where a healthy API answered just after a runner's
first connection timed out, after the signed desktop had already built.

Alpha hosted plans and pre-deploy worker preparation use the same bounded
identity reader even when forward-only mode is off. A valid 503 identity from
the old API allows a candidate to deploy a health repair; worker provider,
qualification and committed-input checks still apply when required. The newly
deployed candidate must pass strict API readiness before Pages, worker execution,
finalization or desktop publication. Include the health repair in that candidate;
changing the desktop `ZEROS_CLOUD_WORKSPACES_ENABLED` flag does not disable the
Railway backend's cloud service. Pause and drain automatic Alpha before using
the documented manual cutover or recovery procedure.

A newer, divergent, unreadable or malformed destination can produce the existing
green pre-mutation skip only at the initial barrier, after complete retained
parent job evidence proves no destination has started. It never issues an
admission receipt. Main ancestry, authentication, admission proof and compare
errors remain red. After admission or a possible mutation, every conflict or
unknown check remains red; reconcile actual provider state and retained receipts
before retrying. Locks remain
`hosted-mutation-<channel>` with cancellation disabled. Automatic Alpha
transactions remain serialized by `release-alpha` on the reusable publication
call, while candidate CI and builds prepare concurrently.

To enable, pause automatic Alpha delivery operationally, let running and
pending Alpha work finish, and verify a healthy current Alpha API/schema,
Pages and feed/tag/ledger baseline. Hold independent provider Git
autodeploy. Start with `ZEROS_ALPHA_FORWARD_ONLY=admitted`; after observing
successful admitted candidates finish while main advances, set it to `enabled`
to admit candidates already behind main. `ZEROS_ALPHA_CI_FAST_PATH` remains an
independent choice of exact-source evidence. No repository variable or provider
setting is changed by this implementation.

The pilot requires exclusive automatic Alpha writers across its stages.
Individual hosted locks are released between services and finalization;
they do not provide cross-destination atomicity or exclude a direct operation
between stages. Before a manual Alpha cutover, direct runtime/feed
operation or recovery, pause and drain automatic releases, perform the existing
strict full/current operation, verify every destination and cleanup receipt,
then resume. Unknown partial mutations require owner reconciliation; this
change does not introduce an automatic recovery journal. GitHub's pending slot
coalesces queued arrivals, so out-of-order main events may still affect liveness;
frontier checks prevent an older source from overwriting a newer destination.

To roll back Stage 2, pause and drain before setting the variable to `admitted`.
To restore today's strict policy, pause and drain before unsetting it (or use
any other value). Existing receipts remain valid for their original protocols;
there is no tag, feed, provider or schema rollback. An in-flight variable change
can stop a later checkpoint, so drain before toggling. Beta, Production and
direct/manual paths keep their existing policy throughout.

When enabled, the hosted controller performs a read-only provider plan, a
short-lived migration-role SQL plan, source retarget, a fresh successful
PlanetScale backup, strict production-mode migration, explicit exact-SHA
Railway deploy, deployment `SUCCESS`, public release readiness, app/Ops Pages
build and direct upload, custom-domain manifest verification, then anonymous
WorkOS handshake verification. That job saves
`hosted-services-<channel>-<sha>` with status `services-ready`, **not** desktop
publication authority. Finalization authenticates that artifact against this
parent release's exact repository, branch and SHA and the successful producing
job. It verifies current provider, Pages, API source and schema before saving
`hosted-promotion-<channel>-<sha>`. Only that final receipt authorizes the desktop
publisher and cumulative release ledger.
There is no Ops deployment in Beta. Every Pages artifact includes Functions
and the applicable marketing output. Build/install output from provider-facing
subprocesses is withheld, and receipts contain allowlisted public fields only.

WorkOS verification anonymously exercises `/auth/start` on every channel Pages
surface, checks the exact issuer/client/callback, PKCE, no-store and host-only
flow-cookie contract, and requires the provider to accept the authorization request.
It also exercises the installed app's `/auth/desktop` entrypoint with fresh
channel-prefixed state and PKCE, checking the distinct Desktop client, exact
`/auth/desktop/callback`, unchanged state/challenge, no-store and no-referrer,
then provider acceptance and public JWKS availability. Receipts retain only
the surface list, `desktopVerified: true` and verification time, never state,
cookies or authorization URLs. Older receipts remain readable and do not gain
a Desktop verification claim. This is a public
handshake/readiness gate, **not** an authenticated login/logout or native desktop
canary. The owner still rehearses those complete flows with dedicated approved
accounts before enabling a channel.

Immediately before each desktop publisher writes its release, it runs
`scripts/release/publication-cli.ts`. With hosted promotion enabled, the gate
downloads this run's receipt, verifies the successful hosted job in its recorded
attempt, then rereads the current backend and every channel Pages manifest.
Source SHA and migration manifest must still match the receipt.
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
`current`/`pending`/`controlled`/`unknown` state and cloud service readiness. It returns 503 unless ready; `/healthz`
retains its existing liveness semantics. Provider errors, tenant information,
credentials and cloud-health diagnostic strings never enter the identity body.
The controller verifies the response against its exact checkout manifest.
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

Cloud v1 retirement is one controlled cutover across eleven contract files:
`0182_retire_legacy_cloud.sql` and `0191_retire_legacy_cloud_02.sql` through
`0200_retire_legacy_cloud_11.sql`. The owner approved that retirement; every
batch retains the `2026-10-21` not-before date. 0182 preserves vault metadata
and removes retained-table hooks before the first drops. Follow-up batches
come after 0190 so existing migration numbers do not move. Their small
transactions target fewer than 1,000 backend locks; the ladder test measures
`pg_locks` before each contract commit and fails above 1,500. Never combine
the batches into one transaction: PostgreSQL holds dependency locks until
commit, even when the dropped objects no longer exist.

For a database already at 0181, the one-shot approval is:

```bash
CONTROL_PLANE_MIGRATION_APPROVALS=0182_retire_legacy_cloud.sql,0191_retire_legacy_cloud_02.sql,0192_retire_legacy_cloud_03.sql,0193_retire_legacy_cloud_04.sql,0194_retire_legacy_cloud_05.sql,0195_retire_legacy_cloud_06.sql,0196_retire_legacy_cloud_07.sql,0197_retire_legacy_cloud_08.sql,0198_retire_legacy_cloud_09.sql,0199_retire_legacy_cloud_10.sql,0200_retire_legacy_cloud_11.sql \
NODE_ENV=production node dist/migrate.js
```

For `controlled-cutover.yml`, pass that comma-separated filename list as
`approvals`. Reconcile the ledger after an interruption and approve only the
remaining controlled filenames. Keep old writers stopped and maintenance
enabled until the final batch and schema verification succeed; automatic
service boot cannot approve or defer these contracts. Restore the paired
backup for a v1 rollback, rather than attempting to run the old binary on a
partially or fully retired schema.

The first rollout needs a compatible bridge: binaries released before this
phase-aware verifier still reject every unknown row. Deploy/rehearse the
tolerant verifier against the unchanged 0121 ledger before applying 0122, retain
that bridge as the rollback target, then rehearse expand → new API → bridge
restart against the advanced ledger. Do not claim arbitrary historical binaries
can now roll back or apply 0122 ahead of an unprepared old-binary restart. Schema
rollback is never automatic reverse SQL; reconcile partial deployment and use a
compatible API rollback or a reviewed forward fix/paired data recovery.

## Ordered-controller rollout switches and owner setup

The hosted controller uses source, schema, provider and publication receipts.
A green disabled guard is not a deployment receipt. Set `ZEROS_HOSTED_PROMOTION`
to exactly `enabled` only after the channel setup below and an isolated live
rehearsal. Missing required secrets with the switch enabled fails the guard.
With it disabled, both the initial guard and the desktop publication step
compare the candidate's complete committed schema
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
matches this verified publication baseline**.
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

Every disabled-promotion guard performs one anonymous, five-second public identity read. If the
endpoint answers, its readiness/schema state takes precedence over the
publication baseline. An answering but unready or malformed identity cannot be replaced
with an older tag's proof. If neither a usable baseline nor an identity answers,
publication blocks with operator steps. An unavailable endpoint alone does not
block an unchanged published schema. Every disabled decision emits an annotation
and step summary and creates no hosted receipt.

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
in its error annotation and summary.

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

The channel lock protects the running transaction (the full workflow for Beta
and Production, the publication call for Alpha), but GitHub may replace a
**pending** transaction with a later one. Every desktop writer reruns the complete
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
| `AUTH_PROVIDER`                                                      | `workos` or unset                                                                                    |
| `AUTH_ISSUER`, `AUTH_JWKS_URL`                                       | channel's qualified public WorkOS issuer and signing-key URL; HTTPS only                             |
| `AUTH_WEB_CLIENT_ID`, `AUTH_DESKTOP_CLIENT_ID`                       | distinct channel client IDs; public verification metadata, never client secrets                      |
| `ZEROS_CLOUD_WORKSPACES_ENABLED`                                     | exact desktop capability decision; `true` only after qualification                                   |
| Existing desktop auth/origin values                                  | the exact channel values in the earlier tables                                                       |

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
   encryption keys and validated callback allowlists. Bootstrap the stable
   database object owner through the documented
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
