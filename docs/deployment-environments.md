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
| Alpha      | `main`                                 | `alpha` environment: control plane + its own Postgres      | `zeros-web-alpha`, `zeros-ops-alpha`    | `api-alpha.zeros.build`, `app-alpha.zeros.build`, `ops-alpha.zeros.build`  |
| Beta       | current `release/X.Y.Z`                | `beta` environment: control plane + its own Postgres       | `zeros-web-beta`; **no Ops deployment** | `api-beta.zeros.build`, `app-beta.zeros.build`                             |
| Production | the same release commit Beta validated | `production` environment: control plane + its own Postgres | `zeros-web`, `zeros-ops`                | `api.zeros.build`, `app.zeros.build`, `ops.zeros.build`, marketing domains |

This remains one backend codebase and one frontend codebase. Each channel is an
isolated deployment instance with independent data, credentials, sessions, and
domains.

Railway supports named persistent environments, so keep one Railway project and
the same logical `zeros-control-plane` service in all three environments. Never
share `DATABASE_URL` across them.

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
and Beta, but provision a fresh PostgreSQL service in each environment; a
configuration duplicate is not permission to copy or share Production data.

For the control-plane service in every environment:

- repository root directory: `apps/control-plane`
- Dockerfile builder using the colocated `Dockerfile`
- health check: `/healthz`
- service name: `zeros-control-plane`
- one environment-local Postgres reference for `DATABASE_URL`
- watch paths restricted to `apps/control-plane/**` when Railway asks for them

Configure sources and deploy controls as follows:

| Railway environment | Git source                        | Autodeploy               | Wait for CI                   |
| ------------------- | --------------------------------- | ------------------------ | ----------------------------- |
| `alpha`             | `main`                            | on                       | on                            |
| `beta`              | current `release/X.Y.Z`           | on after the release cut | on                            |
| `production`        | current validated `release/X.Y.Z` | **off**                  | required before manual deploy |

Attach each custom API domain to the matching service instance. Confirm all
three `/healthz` endpoints before configuring a desktop build.

For a normal Production promotion, freeze the validated release branch and use
Railway's command palette → **Deploy Latest Commit**. Railway deploys the latest
commit on the service's connected branch even while autodeploy is disabled.
Compare the resulting deployment SHA with the Beta SHA before promoting the
frontend.

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
target fingerprint, and refuses Production; Production always receives a fresh
database service.

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
| `zeros-web-alpha` | `main`                            | on                                | **off**                   | `app-alpha.zeros.build`                             |
| `zeros-ops-alpha` | `main`                            | on                                | **off**                   | `ops-alpha.zeros.build`                             |
| `zeros-web-beta`  | current `release/X.Y.Z`           | on while stabilizing that release | **off**                   | `app-beta.zeros.build`                              |
| `zeros-web`       | current validated `release/X.Y.Z` | **off**                           | **off**                   | `app.zeros.build` plus Production marketing domains |
| `zeros-ops`       | current validated `release/X.Y.Z` | **off**                           | **off**                   | `ops.zeros.build`                                   |

Disable Preview deployments for these release projects. If PR previews are
needed later, create a sixth preview-only project with preview-only credentials
and data instead of sharing Alpha/Beta state.

For manual Production builds, create a protected Pages deploy hook tied to the
current frozen `release/X.Y.Z` branch (or call the Pages deployment API with
that branch). Trigger it only after the backend is healthy, and verify that the
deployment metadata contains the recorded Beta SHA. A deploy-hook URL is an
unauthenticated secret: keep it in a protected password manager or GitHub
Environment, rotate/recreate it when the release branch changes, and never put
it in the repository. Do not temporarily turn Production autodeploy back on.

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
live in the channel's Railway Postgres.

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

Desktop releases additionally require these environment-scoped Actions
variables:

| Variable                 | Auth0 rollback build | WorkOS build                   |
| ------------------------ | -------------------- | ------------------------------ |
| `AUTH_PROVIDER`          | `auth0`              | `workos`                       |
| `AUTH_DESKTOP_CLIENT_ID` | unused               | channel Desktop Application ID |
| `AUTH_ISSUER`            | unused               | exact qualified issuer         |
| `AUTH_JWKS_URL`          | unused               | exact qualified JWKS URL       |
| `AUTH_AUDIENCE`          | unused               | matching channel API origin    |

These are public verification values baked only into Electron main. Never add a
WorkOS API key—generic, web, desktop, or channel-prefixed—to a desktop release
environment. The release gate rejects any `WORKOS_*_API_KEY` shape.

Set GitHub Environment deployment-branch protection too: `alpha` permits only
`main`; `beta` permits only `release/*`; `production` permits only `release/*`
and requires a human reviewer. The stable workflow itself now rejects `main`
and requires an exact `release/X.Y.Z` ref, so a manual dispatch cannot bypass
the promotion ladder.

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
compatible with the post-migration schema. Railway starts and health-checks the
new deployment while the old deployment is still serving, so this migration
must not run as an ordinary rolling deploy.

Alpha and Beta use their isolated databases first. For each, temporarily set:

```text
CONTROL_PLANE_MIGRATION_APPROVALS=0009_organization_team_hierarchy.sql
```

Deploy, verify the migration log and API behavior, then remove the approval.

For Production:

1. Verify the exact release SHA in Alpha and Beta, including login,
   organizations, invitations, settings, GitHub connection, and feedback.
2. Take and verify a fresh Production database backup. Keep Cloudflare on the
   existing frontend.
3. Confirm Railway Production autodeploy is off and its source is the validated
   `release/X.Y.Z` branch.
4. Stage (but do not yet deploy) the one-time approval variable below, then
   **Remove** the currently active Production control-plane deployment from its
   deployment menu. A
   short control-plane maintenance window begins; local desktop workspaces
   remain local.
5. Apply the staged variable change and choose **Deploy Latest Commit** for the
   selected release branch. The new deployment applies the migration
   transactionally and starts the new API. If your Railway UI cannot stage a
   variable edit, remove the old deployment before saving the approval.
6. Require `/healthz`, inspect the migration log, and smoke-test the old
   `/v1/teams` compatibility API plus the new organization API.
7. Remove the approval variable. Leave Production autodeploy off.
8. Deploy the same release commit to `zeros-web`, verify browser login and the
   dashboard, then release the matching stable desktop build.

Do not use Railway image rollback after `0009`: the old image expects the old
schema. Restore the database backup or roll forward with corrected new code.

## Normal promotion after the one-time migration

Every macOS channel verifies the two independently consumed release containers
before promotion: users install from the DMG, while the in-place updater installs
the ZIP. `scripts/verify-macos-release-artifacts.mjs` mounts/extracts both, runs a
deep strict signature check, constrains the root to bundle ID `com.zeros*` and
Apple team `H8MS56JU2Z`, requires hardened runtime plus a secure timestamp,
checks ShipIt-safe owner-write modes, and requires matching root code-directory
hashes. Alpha/Beta run this immediately before publication; Production runs it
before notary submission and separately rechecks notarization/Gatekeeper after
stapling.

1. Merge a green PR to `main`; Railway Alpha, `zeros-web-alpha`, and the Alpha
   desktop channel update.
2. Test Alpha.
3. Cut `release/X.Y.Z` from the selected commit; point Beta's Railway and Pages
   sources at that branch. Beta updates only from that stabilization branch.
4. Fix Beta by cherry-picking onto the release branch; do not replace it with a
   moving `main` build.
5. Record the validated SHA. Point Production sources at the same frozen
   release branch and keep autodeploy off. Use Railway **Deploy Latest Commit**,
   then the Cloudflare deploy hook/API for that branch, then dispatch the stable
   desktop workflow from that branch. Confirm all three report the recorded SHA.
6. Verify `/healthz`, login, dashboard API, feedback, and deployment commit IDs.

Future schema changes should use expand/contract migrations so old and new
server versions can overlap. Marking another migration for controlled downtime
is an exceptional, reviewed release decision.
