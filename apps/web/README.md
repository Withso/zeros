# Web hub and edge functions

One Cloudflare Pages project (**`zeros-web`**) serves **both**:

| Host                                        | Surface                                                        |
| ------------------------------------------- | -------------------------------------------------------------- |
| **`app.zeros.build`**                       | Session-aware hub, Auth0 (`/auth/*`), desktop handoff, invites |
| **`zeros.build`** (+ `www`, `zeros.design`) | Marketing SPA (Vite/React from `apps/marketing`)               |

Host routing lives in `functions/_middleware.ts` + `lib/hosts.ts`. Marketing traffic is served via `env.ASSETS.fetch()` so `functions/index.ts` never steals `/` on the marketing host. Session cookies stay **host-only** on `app.zeros.build` (never `Domain=.zeros.build`).

> **Standalone, NOT a pnpm workspace member.** Own `package.json` / lockfile for Functions deps. Marketing is built from the monorepo via `scripts/cf-install-marketing.mjs` + `scripts/assemble-marketing.mjs`.

## Routes

### `app.zeros.build`

```
GET  /   (and /launch alias)   → session-aware HUB (lib/hub.ts)
GET  /auth/start|callback|logout
GET  /github/connected         → GitHub App completion + Open Zeros handoff
GET  /invite?token=
POST /handoff/{mint,redeem,refresh,revoke}
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

App-only paths hit on a marketing host (`/auth/*`, `/handoff/*`, `/github/connected`, `/launch`, `/invite`) **302 → `app.zeros.build`**.

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
npm test               # host classification unit tests
```

## Cloudflare Pages project (`zeros-web`) — settings

The Builds UI has **no Install command field** (only Framework / Build command /
Output / Root). Marketing deps are installed inside `npm run build` via a
**standalone** `pnpm install --ignore-workspace --frozen-lockfile` from
`apps/marketing/pnpm-lock.yaml` (committed), so the CF build never downloads
Electron or compiles the monorepo's native deps (`--filter` can't narrow a
workspace install — [pnpm#8318](https://github.com/pnpm/pnpm/issues/8318)).
After changing `apps/marketing/package.json`, regenerate that lockfile:
`cd apps/marketing && pnpm install --ignore-workspace --lockfile-only`.

| Setting                    | Value                                                                        |
| -------------------------- | ---------------------------------------------------------------------------- |
| **Framework preset**       | `None`                                                                       |
| **Build command**          | `npm run build`                                                              |
| **Build output directory** | `dist` ← change from `public`                                                |
| **Root directory**         | `apps/web`                                                                   |
| **Production branch**      | `main`                                                                       |
| **KV binding**             | `SESSIONS`                                                                   |
| **Custom domains**         | `app.zeros.build` **and** `zeros.build` (+ `www` / `zeros.design` as needed) |

### Environment variables (Production + Preview)

| Name                  | Required | Notes                                                  |
| --------------------- | -------- | ------------------------------------------------------ |
| `AUTH0_DOMAIN`        | yes      | `login.zeros.build`                                    |
| `AUTH0_CLIENT_ID`     | yes      | Regular Web App client                                 |
| `AUTH0_CLIENT_SECRET` | yes      | **secret**                                             |
| `AUTH0_AUDIENCE`      | optional | defaults to `https://api.zeros.build`                  |
| `APP_ORIGIN`          | optional | defaults to `https://app.zeros.build`                  |
| `APP_HOSTS`           | optional | comma list; defaults to hostname of `APP_ORIGIN`       |
| `MARKETING_ORIGIN`    | optional | defaults to `https://zeros.build`                      |
| `MARKETING_HOSTS`     | optional | defaults to `zeros.build,www.zeros.build,zeros.design` |

`ASSETS` is provided automatically by Pages (static output). Do not add it manually.

### Auth0 (unchanged if `app.zeros.build` stays the app host)

1. Allowed Callback URLs include `https://app.zeros.build/auth/callback`
2. Allowed Logout URLs include `https://app.zeros.build/`
3. Keep social-only (Google + GitHub); database connection disabled

## Manual cutover checklist (dashboard)

Do this **after** this branch is on `main` (or a preview you trust):

1. **zeros-web → Settings → Builds**
   - Framework preset: `None`
   - Build command: `npm run build`
   - Build output directory: **`dist`** (change from `public`)
   - Root directory: `apps/web`
   - No Install command field in this UI — `npm run build` installs marketing deps itself.
2. **Trigger a production deploy** and confirm:
   - `https://app.zeros.build/` → Sign in / Launch hub
   - `https://<preview>.pages.dev/` → hub (unknown hosts default to app)
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
  functions/invite.ts          → /invite
  functions/github/connected.ts → /github/connected
  functions/auth/*             → Auth0 PKCE
  functions/handoff/*          → desktop ticket APIs
  lib/hosts.ts                 → host classification + CSP
  lib/hub.ts                   → hub HTML
  lib/oauth.ts                 → Auth0 + cookies (APP_ORIGIN-aware)
  lib/session.ts               → KV session + Env
  public/_headers              → app CSP defaults (source; copied into dist/)
  public/robots.txt            → app Disallow (source; marketing overridden in middleware)
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
| Schema URLs                | Still served at `zeros.build/schemas/*` after cutover                                                                                                             |
