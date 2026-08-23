# Web hub and edge functions

One frontend codebase is deployed as three isolated Cloudflare Pages projects:
`zeros-web-alpha`, `zeros-web-beta`, and `zeros-web`. Cloudflare Pages exposes
only Production plus one shared Preview configuration per project, so separate
projects are required for true Alpha/Beta/Production bindings and secrets.

The Production project (**`zeros-web`**) serves **both**:

| Host                                        | Surface                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| **`app.zeros.build`**                       | Organization dashboard, selected browser auth (`/auth/*`), invites |
| **`zeros.build`** (+ `www`, `zeros.design`) | Marketing SPA (Vite/React from `apps/marketing`)                   |

Host routing lives in `functions/_middleware.ts` + `lib/hosts.ts`. Marketing traffic is served via `env.ASSETS.fetch()` so `functions/index.ts` never steals `/` on the marketing host. Session cookies stay **host-only** on `app.zeros.build` (never `Domain=.zeros.build`).

See [`docs/deployment-environments.md`](../../docs/deployment-environments.md)
for project/domain/branch mappings and the promotion runbook.

> **Standalone, NOT a pnpm workspace member.** Own `package.json` / lockfile for Functions deps. Marketing is built from the monorepo via `scripts/cf-install-marketing.mjs` + `scripts/assemble-marketing.mjs`.

## Routes

### `app.zeros.build`

```
GET  /                         → signed-in management dashboard; signed-out hub
GET  /launch                   → session-aware desktop handoff
GET  /auth/start|callback|logout
POST /auth/workos-webhook      → signed WorkOS user lifecycle events
POST /auth/desktop-revoke      → verified desktop current/all-session revocation
GET  /github/connected         → GitHub App completion + Open Zeros handoff
GET  /invite?token=
POST /handoff/{mint,redeem,refresh,revoke} → Auth0 compatibility only
GET|POST|PATCH|DELETE /api/v1/* → allowlisted same-origin control-plane proxy
```

### `zeros.build` (marketing)

```
GET  /                         → marketing HomePage
GET  /changelog                → SPA fallback → index.html
GET  /privacy                  → SPA fallback → index.html
GET  /terms                    → SPA fallback → index.html
GET  /schemas/*                → published settings JSON Schema
GET  /LICENSE.txt              → Zeros source license
GET  /THIRD-PARTY-NOTICES.md   → dependency and vendor notices
GET  /THIRD-PARTY-LICENSES.txt → generated exact-version license bundle
GET  /robots.txt               → Allow: /  (middleware; not the app Disallow)
```

App-only paths hit on a marketing host (`/auth/*`, `/handoff/*`, `/api/*`, `/github/connected`, `/launch`, `/invite`) **302 → `app.zeros.build`**.

## Local development

```bash
cd apps/web
npm install
# Needs pnpm at the repo root (marketing workspace member):
#   (from repo root) pnpm install
npm run build          # builds marketing + assembles dist/
npm run build:standalone # forces the independent marketing lockfile install
npm run dev            # wrangler on 127.0.0.1:8788 with MARKETING_HOSTS=127.0.0.1,localhost
```

- Open **http://127.0.0.1:8788/** → marketing (because `dev` sets `MARKETING_HOSTS`)
- Open with Host `app.zeros.build` (or run `npm run dev:app`) → hub / sign-in

```bash
npm run typecheck
npm test               # web/session/auth regression tests
npm run check:session-worker # dry-run all three Worker bundles
```

The ordinary `dev` scripts keep the legacy Auth0/KV path. WorkOS mode also
needs a separately running Durable Object Worker and an `AUTH_SESSIONS` service
binding, so use a dedicated Cloudflare staging environment for an end-to-end
browser login rather than copying its server credentials into local Pages
bindings.

## Cloudflare Pages projects — shared settings

The Builds UI has **no Install command field** (only Framework / Build command /
Output / Root). Marketing deps are installed inside `npm run build` via a
**standalone** `pnpm install --ignore-workspace --frozen-lockfile` from
`apps/marketing/pnpm-lock.yaml` (committed), so the CF build never downloads
Electron or compiles the monorepo's native deps (`--filter` can't narrow a
workspace install — [pnpm#8318](https://github.com/pnpm/pnpm/issues/8318)).
After changing `apps/marketing/package.json`, regenerate that lockfile:
`cd apps/marketing && pnpm install --ignore-workspace --lockfile-only`.

| Setting                    | Value                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| **Framework preset**       | `None`                                                              |
| **Build command**          | `npm run build`                                                     |
| **Build output directory** | `dist` ← change from `public`                                       |
| **Root directory**         | `apps/web`                                                          |
| **Production branch**      | Alpha: `main`; Beta/Production: selected `release/X.Y.Z`            |
| **KV binding**             | `SESSIONS` — retained per project for Auth0 rollback/abuse controls |
| **WorkOS binding**         | `AUTH_SESSIONS` — channel-matched `AuthSession` Durable Object      |
| **Custom domains**         | Channel app domain; only Production also owns marketing domains     |

Disable Preview deployments on these release projects. Configure the following
in each project's Production environment:

| Name                | Required | Notes                                                  |
| ------------------- | -------- | ------------------------------------------------------ |
| `ZEROS_DEPLOY_ENV`  | yes      | `alpha`, `beta`, or `production`; build fails on drift |
| `AUTH_PROVIDER`     | yes      | `auth0` until coordinated cutover, then `workos`       |
| `APP_ORIGIN`        | yes      | matching channel app origin                            |
| `APP_HOSTS`         | optional | comma list; defaults to hostname of `APP_ORIGIN`       |
| `MARKETING_ORIGIN`  | optional | defaults to `https://zeros.build`                      |
| `MARKETING_HOSTS`   | optional | defaults to `zeros.build,www.zeros.build,zeros.design` |
| `CONTROL_PLANE_URL` | yes      | matching channel API origin; server-side only          |

Provider-specific Pages configuration:

| Mode                | Variables and runtime secrets                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth0 compatibility | `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, secret `AUTH0_CLIENT_SECRET`, and channel `AUTH0_AUDIENCE`                                                                                 |
| WorkOS              | `WORKOS_SESSION_WORKER=zeros-auth-sessions-<channel>`; runtime secrets `WORKOS_WEBHOOK_SECRET` and `AUTH_BROKER_SECRET`; `AUTH_SESSIONS` bound to that channel's Worker class |

`ASSETS` is provided automatically by Pages (static output). Do not add it manually.

`CONTROL_PLANE_URL` is never exposed to browser code. The dashboard sends
same-origin requests through `functions/api/[[path]].ts`; that proxy reads the
verified server-side session, keeps bearer and refresh material out of browser
JavaScript, permits only the organization-management route set, bounds request
bodies, and returns JSON with `no-store` caching. Mutations require a
same-origin `Origin`, JSON content type, and `X-Zeros-Request: dashboard`.

### Authentication modes

Auth0 remains selectable for rollback until Phase 5. Use a separate Regular Web
Application per channel with that environment's callback and logout origin.

WorkOS browser sessions use authorization code plus PKCE. The browser cookie
contains only a random 256-bit lookup ID. State, verifier, sealed session,
access token, WorkOS session ID, and refresh rotation live in one channel-local
Durable Object; Workers KV is not the rotation authority. The Worker has no
public `workers.dev` or preview URL.

The Worker configuration is
[`session-worker/wrangler.jsonc`](session-worker/wrangler.jsonc). Before any
real deployment, rotate the API key disclosed during qualification. Then, for
each channel:

1. Run `npm run check:session-worker` and deploy the corresponding environment
   with the pinned local Wrangler CLI.
2. Set Worker secrets `WORKOS_API_KEY` and a random 32-byte-or-longer
   `WORKOS_COOKIE_PASSWORD`. Set public Worker values `WORKOS_WEB_CLIENT_ID`,
   `AUTH_DESKTOP_CLIENT_ID`, exact `AUTH_ISSUER`, exact `AUTH_JWKS_URL`, and
   channel `AUTH_AUDIENCE`. Do not put either secret in Git, Pages, Railway,
   command arguments, or logs.
3. In Pages, bind `AUTH_SESSIONS` to the matching Worker's `AuthSession` class.
   Set the non-secret worker-name marker shown in the table above.
4. Register `https://<channel-app-host>/auth/workos-webhook` for only
   `user.updated` and `user.deleted`. Put its signing secret in Pages as
   `WORKOS_WEBHOOK_SECRET`.
5. Generate an independent 32-byte-or-longer `AUTH_BROKER_SECRET` and set the
   same value in Pages and that channel's Railway control plane. It is not a
   WorkOS API key.

WorkOS-hosted AuthKit domains are the Phase 2 choice. A paid custom WorkOS
domain is optional and is not a release requirement.

Do not switch `AUTH_PROVIDER=workos` yet. The control plane intentionally
accepts one issuer at a time. The provider switch, clean database, web
deployment, and matching Phase 3 desktop build are one coordinated Alpha
cutover in Phase 4.

## Manual cutover checklist (dashboard)

Do this only after the same release commit has passed Alpha and Beta. Keep
automatic Production deployments disabled:

1. **zeros-web → Settings → Builds**
   - Framework preset: `None`
   - Build command: `npm run build`
   - Build output directory: **`dist`** (change from `public`)
   - Root directory: `apps/web`
   - No Install command field in this UI — `npm run build` installs marketing deps itself.
2. Point the Production branch at the validated, frozen `release/X.Y.Z`. Keep
   automatic Production deployments off and trigger a protected Pages deploy
   hook for that branch (or the Pages deployment API). Confirm its commit is the
   exact Beta SHA, then confirm:
   - `https://app.zeros.build/` → sign in, then the organization dashboard
   - `https://app.zeros.build/launch` → desktop Launch handoff
   - the deployment's `pages.dev` URL → hub (unknown hosts default to app)
3. **Custom domains → Add `zeros.build`** (and `www` / `zeros.design` if used)
   - Keep the **old marketing Pages project** live until step 5
4. **Verify on apex:**
   - `https://zeros.build/` → marketing homepage (not the hub)
   - `https://zeros.build/changelog` → changelog
   - `https://zeros.build/privacy` and `/terms` → legal pages
   - `https://zeros.build/schemas/settings.schema.json` → JSON Schema
   - `https://zeros.build/auth/start` → **302** to `app.zeros.build`
   - `https://zeros.build/robots.txt` → `Allow: /`
   - `https://app.zeros.build/robots.txt` → `Disallow: /`
5. **Retire the old marketing Pages project** (remove its custom domain first, then delete/disable the project)
6. Optional: set `MARKETING_HOSTS` / `APP_ORIGIN` explicitly in Production if you want overrides without a redeploy of defaults

## Structure

```
apps/web/
  functions/_middleware.ts     → host gate + per-host CSP/robots
  functions/index.ts           → /        (hub — app host only)
  functions/launch.ts          → /launch
  functions/api/[[path]].ts    → same-origin management API proxy
  functions/invite.ts          → /invite
  functions/github/connected.ts → /github/connected
  functions/auth/*             → selectable Auth0/WorkOS browser auth + webhook
  functions/auth/desktop-revoke.ts → private Worker desktop-session broker
  functions/handoff/*          → Auth0 desktop ticket compatibility APIs
  lib/hosts.ts                 → host classification + CSP
  lib/hub.ts                   → hub HTML
  lib/dashboard.mjs            → token-based signed-in dashboard HTML
  lib/control-plane-proxy.ts   → server-side API/session boundary
  lib/oauth.ts                 → legacy Auth0 + cookies (APP_ORIGIN-aware)
  lib/session.ts               → provider-neutral browser-session facade
  lib/workos-browser.mjs       → opaque cookies + Durable Object RPC
  lib/workos-session-core.mjs  → atomic flow/session/refresh state machine
  lib/workos-webhook.mjs       → raw-body signature verification + reduction
  session-worker/worker.ts     → private WorkOS SDK Durable Object host
  public/_headers              → app CSP defaults (source; copied into dist/)
  public/robots.txt            → app Disallow (source; marketing overridden in middleware)
  public/dashboard.{css,js}    → responsive management client
  public/404.html              → static 404 for both hosts (disables Pages' implicit SPA fallback)
  dist/{LICENSE.txt,THIRD-PARTY-*} → generated distribution notices (copied at build time)
  scripts/assemble-marketing.mjs
  scripts/cf-install-marketing.mjs
  dist/                        → build output (gitignored)
```

## Edge cases covered

| Case                       | Behavior                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /` on both hosts      | Marketing → SPA via `ASSETS`; app → hub Function                                                                                                                  |
| Marketing `/auth/*`        | 302 → `app.zeros.build`                                                                                                                                           |
| Shared `_headers` CSP      | Middleware sets marketing CSP (Google Fonts) vs app CSP                                                                                                           |
| `robots.txt`               | Host-specific body from middleware                                                                                                                                |
| SPA `_redirects`           | Explicit paths only (`/changelog`, `/privacy`, `/terms`) — not `/*`; keep in sync with marketing `src/routes.tsx`                                                 |
| Unknown path (either host) | Static `404.html` with a real 404 status — without that file, Pages' implicit SPA mode would serve the marketing homepage with 200 on `app.zeros.build/<unknown>` |
| `*.pages.dev` / localhost  | Default to **app** (OAuth/hub); set `MARKETING_HOSTS` to preview marketing                                                                                        |
| Session cookies            | Still host-only on app; never widened for marketing                                                                                                               |
| Dashboard credentials      | Auth0 grants stay in compatibility KV; WorkOS sealed/refresh state stays in a Durable Object; browser boot data contains identity and organization summaries only |
| WorkOS refresh outage      | Pre-rotation transient failures preserve the exact record; a post-rotation verification outage persists the replacement seal but withholds the bearer             |
| WorkOS lifecycle event     | Exact raw-body signature is checked before only `user.updated`/`user.deleted` cross a separate broker credential; retries are idempotent                          |
| Dashboard mutations        | Same-origin JSON plus custom-header gate; route and body allowlists reject ambient-cookie form attacks                                                            |
| Personal                   | Name follows provider identity, local-only, permanent, and collaboration/billing sections are disabled                                                            |
| Schema URLs                | Still served at `zeros.build/schemas/*` after cutover                                                                                                             |
