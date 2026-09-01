# Web hub and edge functions

One frontend codebase is deployed as five isolated Cloudflare Pages projects:
`zeros-web-alpha`, `zeros-web-beta`, `zeros-web`, `zeros-ops-alpha`, and
`zeros-ops`. Cloudflare Pages exposes
only Production plus one shared Preview configuration per project, so separate
projects are required for true Alpha/Beta/Production bindings and secrets. Ops
deliberately has only Alpha and Production; it is never deployed to Beta.

The Production project (**`zeros-web`**) serves **both**:

| Host                                        | Surface                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| **`app.zeros.build`**                       | Organization dashboard, selected browser auth (`/auth/*`), invites |
| **`zeros.build`** (+ `www`, `zeros.design`) | Marketing SPA (Vite/React from `apps/marketing`)                   |

Host routing lives in `functions/_middleware.ts` + `lib/hosts.ts`. Marketing traffic is served via `env.ASSETS.fetch()` so `functions/index.ts` never steals `/` on the marketing host. Session cookies stay **host-only** on `app.zeros.build` (never `Domain=.zeros.build`).

The two Ops projects serve only `ops-alpha.zeros.build` and `ops.zeros.build`.
They build this same source with `ZEROS_SURFACE=ops`, expose no marketing or
customer dashboard routes, and use the existing channel-matched Railway control
plane. This is a separate deployment boundary, not a separately maintained app.

See [`docs/deployment-environments.md`](../../docs/deployment-environments.md)
for project/domain/branch mappings and the promotion runbook.

> **Standalone, NOT a pnpm workspace member.** Own `package.json` / lockfile for Functions deps. Marketing is built from the monorepo via `scripts/cf-install-marketing.mjs` + `scripts/assemble-marketing.mjs`.

## Routes

### `app.zeros.build`

```text
GET  /                         → signed-in management dashboard; signed-out hub
GET  /launch                   → session-aware desktop handoff
GET  /auth/start|callback|logout → WorkOS mode forwards to Railway unchanged
GET  /auth/desktop             → bounded desktop PKCE redirect to Hosted AuthKit
GET  /auth/desktop/start       → compatibility alias; provider selectors are inert
GET  /auth/desktop/callback    → no-store exact-channel app handoff
POST /auth/workos-webhook      → compatibility pass-through to Railway
POST /auth/desktop-revoke      → compatibility pass-through for older desktops
GET  /github/connected         → GitHub App completion + Open Zeros handoff
GET  /invite?token=[&mode=web|resume] → landing, web acceptance, or post-auth resume
POST /handoff/{mint,redeem,refresh,revoke} → Auth0 compatibility only
GET|POST|PATCH|DELETE /api/v1/* → allowlisted same-origin control-plane proxy
```

### `zeros.build` (marketing)

```text
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

### `ops.zeros.build`

```text
GET  /                         → exact-code deletion recovery workspace
GET  /auth/start|callback|logout → isolated WorkOS browser session namespace
GET  /api/v1/ops/session      → current staff role and bounded developer directory
POST /api/v1/ops/deletions/ZD-.../{lookup,grants,restore,force-purge}
POST /api/v1/internal/account-recoveries/ZR-.../approve
```

Ops has no email/user/organization search, no customer data browser, and no
Beta deployment. The control plane remains the final authorization boundary;
Cloudflare Access may be added as defense in depth but cannot replace the
WorkOS reauthentication, exact support case, expiring grant, and two-person
approval checks.

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
```

The ordinary `dev` scripts keep the legacy Auth0/KV path. For a local WorkOS
end-to-end browser login, run the Railway control plane locally with a loopback
`CONTROL_PLANE_URL` and its own disposable Postgres. WorkOS credentials stay in
that control-plane process; never copy them into local Pages bindings.

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
| **Custom domains**         | Channel app or Ops domain; only Production web owns marketing       |

Disable Preview deployments on these release projects. Configure the following
in each project's Production environment:

| Name                          | Required | Notes                                                  |
| ----------------------------- | -------- | ------------------------------------------------------ |
| `ZEROS_DEPLOY_ENV`            | yes      | `alpha`, `beta`, or `production`; build fails on drift |
| `AUTH_PROVIDER`               | yes      | `auth0` until coordinated cutover, then `workos`       |
| `APP_ORIGIN`                  | yes      | matching channel app origin                            |
| `APP_HOSTS`                   | optional | comma list; defaults to hostname of `APP_ORIGIN`       |
| `MARKETING_ORIGIN`            | optional | defaults to `https://zeros.build`                      |
| `MARKETING_HOSTS`             | optional | defaults to `zeros.build,www.zeros.build,zeros.design` |
| `CONTROL_PLANE_URL`           | yes      | matching channel API origin; server-side only          |
| `ZEROS_SURFACE`               | Ops only | `ops` on the two Ops projects; omitted/`app` elsewhere |
| `WORKOS_BROWSER_ROUTE_PREFIX` | Ops only | `/ops`; isolates the upstream auth namespace           |

Provider-specific Pages configuration:

| Mode                | Variables and runtime secrets                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Auth0 compatibility | `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, secret `AUTH0_CLIENT_SECRET`, and channel `AUTH0_AUDIENCE`                |
| WorkOS              | No provider-specific Pages values. `APP_ORIGIN` and `CONTROL_PLANE_URL` select the matching Railway service. |

`ASSETS` is provided automatically by Pages (static output). Do not add it manually.

The Ops projects always use `AUTH_PROVIDER=workos`, set `APP_ORIGIN` to the
exact Ops origin, and do not need a separate Railway service or database. The
matching Railway environment must set `OPS_ORIGIN` to that exact origin. Never
set either Ops variable in Beta.

`CONTROL_PLANE_URL` is never exposed to browser code. The dashboard sends
same-origin requests through `functions/api/[[path]].ts`; that proxy reads the
verified server-side session, keeps bearer and refresh material out of browser
JavaScript, permits only the organization-management route set, bounds request
and upstream JSON bodies, and returns JSON with `no-store` caching. Mutations require a
same-origin `Origin`, JSON content type, and `X-Zeros-Request: dashboard`.

### Authentication modes

Auth0 remains selectable only for the declared migration rollback window. Use a
separate Regular Web Application per channel with that environment's callback
and logout origin.

WorkOS browser sessions use authorization code plus PKCE. The browser cookie
contains only a random 256-bit lookup ID. Railway stores only its SHA-256
digest. OAuth state is also hashed; the one-time PKCE verifier and encrypted
WorkOS sealed session live in the channel-local Railway Postgres database.
Refreshes are serialized there across service replicas, and access tokens are
never stored as database columns.

Cloudflare Pages is deliberately stateless in WorkOS mode. It forwards the
app-host callback/cookie traffic to the exact `CONTROL_PLANE_URL`, which keeps
the existing `https://app-*/auth/callback` contract and host-only cookies. Set
`WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`, `WORKOS_WEBHOOK_SECRET`, public
WorkOS client/verification values, and `APP_ORIGIN` only on the matching
Railway service. Remove any retired `AUTH_SESSIONS` binding,
`WORKOS_SESSION_WORKER`, or `AUTH_BROKER_SECRET` from Pages.

The successful callback is a no-store, no-referrer `200` completion document,
not another cross-site HTTP redirect. It sets the host-only
`SameSite=Strict` session cookie and immediately performs a same-site navigation
to the already validated return URL, with a visible link as a no-script
fallback. This document boundary is required because browsers correctly
withhold Strict cookies throughout the original AuthKit redirect chain. Pages
must preserve its body and append every `Set-Cookie` field separately.

WorkOS's native invitation email uses the channel's configured custom
invitation URL and lands on `/invite?invitation_token=…`; the legacy Zeros
capability remains available as `/invite?token=…` for rollback and copyable
link compatibility. The response is no-store/no-referrer and nonce-CSP
bounded. It offers the exact channel's desktop deep link or an explicit
browser continuation. Browser acceptance
stores the opaque token only in that tab's `sessionStorage`, immediately strips
it from the address bar, and posts it only to the same-origin allowlisted JSON
facade. A 401 starts Railway's ordinary one-time state/PKCE flow with the
tokenless `/invite?mode=resume` path as the bounded return target, then retries
from the tab-scoped value. A tab permits one AuthKit attempt per freshly opened
invitation; a second 401 terminates with a fixed error instead of redirecting
again. Link scanners cannot accept an invitation because
the landing GET has no mutation and web mode still requires an authenticated
same-origin POST. Railway resolves a WorkOS token server-side and requires its
exact provider invitation ID, organization, recipient email, role, and pending
state to match an active Zeros invitation. WorkOS invitation email stays
enabled; create invitations through Zeros rather than manually in the WorkOS
Dashboard.

Register `https://<channel-api-host>/auth/workos-webhook` for the user,
session, organization, organization-membership, and invitation event set in
[`docs/workos-authentication-migration.md`](../../docs/workos-authentication-migration.md).
The old app-host webhook URL remains a byte-preserving compatibility
pass-through during cutover, but holds no signing secret.

Desktop WorkOS login also starts and returns on the channel's own app host. The
desktop keeps the PKCE verifier in Electron main and opens `/auth/desktop`.
Pages forwards only bounded state/challenge values; provider, connection, and
organization selectors are discarded. Railway creates a Desktop Application
authorization URL that always selects Hosted AuthKit and fixes the redirect to
`${APP_ORIGIN}/auth/desktop/callback`.

Hosted AuthKit owns provider choice, credentials, email verification, MFA,
recovery, and identity linking. Zeros has no verification continuation
endpoint and neither Pages nor Electron receives a pending authentication
token or verification ID. The callback never server-renders the authorization
code, strips it from browser history, and opens only the allow-listed
exact-channel scheme. Its no-store/no-referrer/nonce CSP is preserved by the
global host middleware.

The signed-in dashboard opens one authenticated EventSource through
`/api/v1/auth/events`; account/session revocation signs out, while organization
authorization/data changes revalidate scoped state. Focus, visibility,
`pageshow`, and reconnect use `/api/v1/auth/snapshot` only when the stream has
been silent for at least 60 seconds. There is no 30-second auth poll. A
transient outage retains the last confirmed dashboard snapshot, but every API
request still reauthorizes on Railway.

A successful Hosted AuthKit ceremony can still be refused by Zeros account
resolution. Reviewed recovery, a conflicting active identity, a fresh-auth
requirement, and an inactive account render separate fixed pages with sign-out
and support actions; none is labeled as an organization/network outage and raw
upstream messages never enter HTML.

A custom AuthKit domain is optional for the initial cutover and should be
evaluated independently for Production branding and anti-phishing. The
qualified issuer/JWKS contract must change only through a reviewed migration.

Do not switch `AUTH_PROVIDER=workos` until the WorkOS dashboard, Railway,
Pages, and matching desktop build are configured from the same qualified
commit. The control plane intentionally accepts one issuer at a time, so the
provider switch and channel deployment are coordinated.

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

```text
apps/web/
  functions/_middleware.ts     → host gate + per-host CSP/robots
  functions/index.ts           → /        (hub — app host only)
  functions/launch.ts          → /launch
  functions/api/[[path]].ts    → same-origin management API proxy
  functions/invite.ts          → /invite
  functions/github/connected.ts → /github/connected
  functions/auth/*             → selectable Auth0/WorkOS browser auth + webhook
  functions/auth/desktop/*     → Hosted AuthKit desktop redirect/start/callback
  functions/auth/desktop-revoke.ts → older-desktop Railway pass-through
  functions/handoff/*          → Auth0 desktop ticket compatibility APIs
  lib/hosts.ts                 → host classification + CSP
  lib/hub.ts                   → hub HTML
  lib/dashboard.mjs            → token-based signed-in dashboard HTML
  lib/control-plane-proxy.ts   → server-side API/session boundary
  lib/oauth.ts                 → legacy Auth0 + cookies (APP_ORIGIN-aware)
  lib/session.ts               → provider-neutral browser-session facade
  lib/workos-browser.mjs       → stateless Railway auth/session facade
  lib/workos-desktop-authorization.mjs → branded desktop PKCE handoff
  lib/workos-railway.mjs       → exact control-plane origin boundary
  lib/workos-webhook.mjs       → byte-preserving Railway pass-through
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

| Case                       | Behavior                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /` on both hosts      | Marketing → SPA via `ASSETS`; app → hub Function                                                                                                                     |
| Marketing `/auth/*`        | 302 → `app.zeros.build`                                                                                                                                              |
| Shared `_headers` CSP      | Middleware sets marketing CSP (Google Fonts) vs app CSP                                                                                                              |
| `robots.txt`               | Host-specific body from middleware                                                                                                                                   |
| SPA `_redirects`           | Explicit paths only (`/changelog`, `/privacy`, `/terms`) — not `/*`; keep in sync with marketing `src/routes.tsx`                                                    |
| Unknown path (either host) | Static `404.html` with a real 404 status — without that file, Pages' implicit SPA mode would serve the marketing homepage with 200 on `app.zeros.build/<unknown>`    |
| `*.pages.dev` / localhost  | Default to **app** (OAuth/hub); set `MARKETING_HOSTS` to preview marketing                                                                                           |
| Session cookies            | Still host-only on app; never widened for marketing                                                                                                                  |
| Dashboard credentials      | Auth0 grants stay in compatibility KV; WorkOS sealed/refresh state stays in Railway/Postgres; browser boot data contains identity and organization summaries only    |
| WorkOS refresh outage      | Pre-rotation transient failures preserve the exact record; a post-rotation verification outage persists the replacement seal but withholds the bearer                |
| WorkOS lifecycle event     | Pages preserves exact bytes; Railway verifies the signature before reducing the complete management event set; webhooks are idempotent and Events API repairs misses |
| Account resolution         | Recovery/conflict/fresh-auth/inactive states have dedicated fixed UI; provider text and bearer/refresh material never render                                         |
| Authorization freshness    | One SSE connection plus durable revisions; lifecycle snapshots are silence/reconnect backstops, not periodic polling                                                 |
| Dashboard mutations        | Same-origin JSON plus custom-header gate; route and body allowlists reject ambient-cookie form attacks                                                               |
| Personal                   | Name follows provider identity, local-only, permanent, and collaboration/billing sections are disabled                                                               |
| Schema URLs                | Still served at `zeros.build/schemas/*` after cutover                                                                                                                |
