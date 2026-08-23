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

| Channel    | Source                                 | Railway                                                    | Cloudflare web                                              | Public origins                                          |
| ---------- | -------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| Alpha      | `main`                                 | `alpha` environment: control plane + its own Postgres      | Pages `zeros-web-alpha`; Worker `zeros-auth-sessions-alpha` | `api-alpha.zeros.build`, `app-alpha.zeros.build`        |
| Beta       | current `release/X.Y.Z`                | `beta` environment: control plane + its own Postgres       | Pages `zeros-web-beta`; Worker `zeros-auth-sessions-beta`   | `api-beta.zeros.build`, `app-beta.zeros.build`          |
| Production | the same release commit Beta validated | `production` environment: control plane + its own Postgres | Pages `zeros-web`; Worker `zeros-auth-sessions-production`  | `api.zeros.build`, `app.zeros.build`, marketing domains |

This remains one backend codebase and one frontend codebase. Each channel is an
isolated deployment instance with independent data, credentials, sessions, and
domains.

Railway supports named persistent environments, so keep one Railway project and
the same logical `zeros-control-plane` service in all three environments. Never
share `DATABASE_URL` across them.

Cloudflare Pages exposes only `production` and one shared `preview`
configuration inside a project. Preview branches share variables and bindings,
so a single Pages project cannot safely represent independent Alpha and Beta
environments. Use three Pages projects from the same `apps/web` source. Each
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
| `AUTH_BROKER_SECRET`         | random Alpha Pages/Railway shared secret in WorkOS mode  | random Beta Pages/Railway shared secret in WorkOS mode  | random Production Pages/Railway shared secret in WorkOS mode  |
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
accept one another's tokens. A WorkOS API key is not a control-plane variable.
It belongs only in the server-side WorkOS session Worker. The broker secret is
an independently generated channel credential, not a provider credential.

For the clean-slate identity cutover, prefer provisioning a fresh database and
running all migrations. An Alpha/Beta in-place reset must use the guarded
`pnpm --dir apps/control-plane reset:database` procedure in the control-plane
README. It is dry-run by default, requires a backup confirmation plus an exact
target fingerprint, and refuses Production; Production always receives a fresh
database service.

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

Create `zeros-web-alpha` and `zeros-web-beta` beside the existing `zeros-web`.
All three use:

| Build setting    | Value           |
| ---------------- | --------------- |
| Framework        | None            |
| Root directory   | `apps/web`      |
| Build command    | `npm run build` |
| Output directory | `dist`          |

Configure each project:

| Project           | Production branch                 | Automatic Production deploys      | Custom app domain                                   |
| ----------------- | --------------------------------- | --------------------------------- | --------------------------------------------------- |
| `zeros-web-alpha` | `main`                            | on                                | `app-alpha.zeros.build`                             |
| `zeros-web-beta`  | current `release/X.Y.Z`           | on while stabilizing that release | `app-beta.zeros.build`                              |
| `zeros-web`       | current validated `release/X.Y.Z` | **off**                           | `app.zeros.build` plus Production marketing domains |

Disable Preview deployments for these release projects. If PR previews are
needed later, create a fourth preview-only project with preview-only credentials
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

WorkOS mode instead requires this channel-local topology:

| Setting                                     | Alpha                           | Beta                           | Production                         |
| ------------------------------------------- | ------------------------------- | ------------------------------ | ---------------------------------- |
| Pages `WORKOS_SESSION_WORKER`               | `zeros-auth-sessions-alpha`     | `zeros-auth-sessions-beta`     | `zeros-auth-sessions-production`   |
| Pages `AUTH_SESSIONS` binding               | Alpha Worker's `AuthSession`    | Beta Worker's `AuthSession`    | Production Worker's `AuthSession`  |
| Pages secret `WORKOS_WEBHOOK_SECRET`        | Alpha endpoint signing secret   | Beta endpoint signing secret   | Production endpoint signing secret |
| Pages + Railway secret `AUTH_BROKER_SECRET` | same random Alpha value         | same random Beta value         | same random Production value       |
| Worker secret `WORKOS_API_KEY`              | rotated Alpha server key        | Beta server key                | Production server key              |
| Worker `WORKOS_WEB_CLIENT_ID`               | Alpha Web Application           | Beta Web Application           | Production Web Application         |
| Worker secret `WORKOS_COOKIE_PASSWORD`      | unique random 32+ byte value    | unique random 32+ byte value   | unique random 32+ byte value       |
| Worker `AUTH_DESKTOP_CLIENT_ID`             | Alpha Desktop Application       | Beta Desktop Application       | Production Desktop Application     |
| Worker `AUTH_ISSUER`                        | exact Alpha issuer              | exact Beta issuer              | exact Production issuer            |
| Worker `AUTH_JWKS_URL`                      | exact Alpha JWKS URL            | exact Beta JWKS URL            | exact Production JWKS URL          |
| Worker `AUTH_AUDIENCE`                      | `https://api-alpha.zeros.build` | `https://api-beta.zeros.build` | `https://api.zeros.build`          |

`WORKOS_WEB_CLIENT_ID` is public metadata but remains Worker-only so the Pages
deployment cannot accidentally become the confidential exchange boundary.
`WORKOS_API_KEY` and `WORKOS_COOKIE_PASSWORD` must never appear in Pages,
Railway, GitHub, shell arguments, build logs, or repository files.

Deploy the private Worker from `apps/web` with the pinned CLI only after its
channel key is safe:

```bash
npm run check:session-worker
npm exec -- wrangler deploy --env alpha --config session-worker/wrangler.jsonc
```

Repeat the deploy for `beta` and `production` only when those promotion stages
begin. Set the two secrets with interactive `wrangler secret put` or the
Cloudflare dashboard, and set the five public contract values in the matching
Worker environment; do not paste secret values into commands. The Worker has
both `workers_dev` and preview URLs disabled, and its public fetch handler
always returns 404. Pages talks directly to its Durable Object namespace.

For each WorkOS environment, register the exact channel URL
`https://<app-host>/auth/workos-webhook` and subscribe only to `user.updated`
and `user.deleted`. The WorkOS-hosted AuthKit domain is sufficient. A paid
custom WorkOS authentication domain is optional and not part of this rollout.

Phases 2 and 3 prepare this topology but do not activate it. Railway accepts one
issuer at a time, while released builds remain on Auth0 until the coordinated
cutover. At the Phase 4 Alpha cutover, switch the clean Alpha database, Railway
`AUTH_PROVIDER`, Pages `AUTH_PROVIDER`, WorkOS webhook, and matching desktop
build as one coordinated operation. Never switch only the browser or only the
control plane.

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
renderer, and both are now also available to Electron main for Auth0 and GitHub
handoffs. A missing Alpha/Beta value cannot silently fall back to Production.

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
