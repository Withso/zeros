# Zeros Auth: What Broke, What I Fixed, and the Simplification Plan

**Date:** 2026-07-06 · **Status:** 2 production bugs found — 1 fixed live (Railway), 1 needs a 30-second dashboard edit (Cloudflare) · **Companion:** `auth-simplification-plan.html` (visual version)

---

## Part 1 — Why nothing was working today

Your auth code is actually in good shape (the hardening from this morning's audit — PRs #136, #137, #138, #140 — is all merged). What broke today was **configuration, not code**. Two env values were wrong, and each one silently killed a different half of the system.

### Bug 1 — a one-letter-family typo took down web sign-in AND sign-out

The sign-in machinery on `auth.zeros.build` reads an env var called `AUTH0_DOMAIN` *(the address of the Auth0 server it should send people to)*. During today's custom-domain migration it was set to:

> `login.zeros.design` ← **wrong** (that domain doesn't exist in DNS)
> `login.zeros.build` ← what it should be

`.design` instead of `.build` — an easy slip, especially since you really do own `zeros.design` (it's an alias of the marketing site).

**What you experienced, explained:**

- **"Sign in with GitHub" → 'This site can't be reached'** (your 2nd screenshot). The button sends the browser to `https://login.zeros.design/authorize?...` — a nonexistent address. Sign-in is fully down for anyone not already holding a session.
- **"Sign out does nothing."** Sign-out actually does clear your browser session first, but its final step bounces through Auth0's logout endpoint — at the same nonexistent address. The browser dead-ends on a DNS error, so it *feels* like the button is broken.
- **"You're signed in" still shows** because browser sessions live in Cloudflare KV for 30 days — yours predates the typo.

**The fix (needs you — my Cloudflare token is read-only):**

1. Cloudflare dashboard → **Workers & Pages → zeros-auth → Settings → Variables and Secrets**
2. Under **Production**, edit `AUTH0_DOMAIN`: `login.zeros.design` → `login.zeros.build` → Save
3. Go to **Deployments**, open the ⋯ menu on the latest production deployment → **Retry deployment** (env changes only apply to a new deployment)

That's it. I verified every other link in the chain live, so this single edit restores both sign-in and sign-out.

### Bug 2 — the API was rejecting every logged-in user (fixed, live now)

The Railway backend (`api.zeros.build` — teams, invitations, secrets) checks who **issued** each login token *(the "issuer")*. Its `AUTH_ISSUER` variable still listed the old **Supabase** issuers from before the Auth0 migration. Auth0 tokens say "issued by `login.zeros.build`" — so the backend answered **401 Unauthorized to everyone**, even with a perfectly valid login.

**Fixed live:** I set `AUTH_ISSUER=https://login.zeros.build/,https://zeros.eu.auth0.com/` (new domain + old domain so sessions from before today keep working) and redeployed. The service restarted cleanly. In ~1 week, the old `zeros.eu.auth0.com/` entry can be dropped.

### What I verified is healthy (tested live, not assumed)

| Piece | Status |
|---|---|
| `login.zeros.build` (Auth0 custom domain) | ✅ Live, serving OIDC config, certificate OK |
| GitHub sign-in at Auth0 | ✅ Redirects to GitHub correctly |
| Google sign-in at Auth0 | ✅ Redirects to Google — **using your own Google client**, so the consent screen says "Zeros", not "auth0.com" |
| Auth0 logout return URLs | ✅ Both `auth.zeros.build` and `app.zeros.build` are allow-listed |
| `api.zeros.build` | ✅ Healthy; now accepts Auth0 tokens (after my fix) |
| Desktop handoff endpoints (`/handoff/mint·redeem·refresh·revoke`) | ✅ Deployed with rate limits + the offline-tolerance fixes |

### One more thing: rotate that Cloudflare token

You pasted a Cloudflare API token into chat. It turned out to be **read-only** (my write attempt was refused), but treat any token that's been in a chat as burned: **Cloudflare dashboard → My Profile → API Tokens → Roll/Delete it.** Same-day habit, every time.

---

## Part 2 — "Did we overcomplicate it?" Honest answer: yes, by exactly one subdomain

Here's the whole estate in one table, in plain terms:

| Domain | What it actually is | Verdict |
|---|---|---|
| `zeros.build` | Marketing site | Keep |
| `app.zeros.build` | The web app ("hub"): Launch Zeros page, desktop handoff, invites — and your future team & billing settings | **Keep — make it the center** |
| `auth.zeros.build` | A separate mini-site that only shows the Google/GitHub buttons and runs the OAuth dance | **Remove — fold into app.zeros.build** |
| `login.zeros.build` | **Not a site you host.** It's Auth0's own server wearing your domain name (a CNAME to Auth0). Exists so Google's consent screen says "zeros.build" and cookies stay first-party | **Keep — it's the identity provider itself** |
| `api.zeros.build` | Railway control plane (teams, invitations, secrets) | Keep |

**On your intuition about `login.zeros.build` "just being a callback URL":** close, but it's actually the opposite — it's the *front door of Auth0 itself*, not a page of ours. Users only ever see it for a split second in the address bar while being forwarded to Google/GitHub. The **callback URL** (where Auth0 sends people back) is the thing that moves: today it's `auth.zeros.build/auth/callback`; after the merge it becomes `app.zeros.build/auth/callback`.

**Why `auth.zeros.build` deserves to die:**

1. **It caused today's outage — structurally.** The same Auth0 settings live in *three* places (two Cloudflare Pages projects + Railway). Three copies means three chances to typo. After the merge: two.
2. **It adds a pointless hop.** Today: `app.zeros.build` → "Sign in" → `auth.zeros.build` page → "Continue with GitHub" → Auth0 → GitHub. That interstitial page does nothing a section of the hub can't.
3. **It forces a risky cookie.** Because the session is minted on `auth.` but read on `app.`, the cookie must be shared across **all** `*.zeros.build` subdomains. Merge them and the cookie can be locked to `app.zeros.build` only — strictly safer.
4. **It's a whole extra deployment** to build, monitor, and keep env-synced, for ~5 small files.

The two Pages projects already share the same session store (the same KV namespace) and the same Auth0 client — they're one app pretending to be two.

---

## Part 3 — The target: one web app, one identity door

### After the merge

```
app.zeros.build          ← THE web app (one Cloudflare Pages project)
├── /                    hub: sign-in when logged out · account home when logged in
├── /auth/start·callback·logout    the OAuth dance (moved here verbatim)
├── /handoff/*           desktop ticket machinery (unchanged)
├── /invite              invitation landing (unchanged)
└── /settings/…          future: team & billing (Traycer-style, per your screenshot)

login.zeros.build        ← Auth0 (identity door — glimpsed during redirect only)
api.zeros.build          ← Railway control plane (unchanged)
```

### The two journeys, after

**Web (future team/billing users):**
`app.zeros.build` → not signed in? The page itself shows **Continue with Google / Continue with GitHub** (no interstitial) → provider → back at the hub, signed in. Sign out returns to the same page, signed out, with a "You've been signed out" note. One domain in the user's mind, start to finish.

**Mac app (unchanged in substance, one hop shorter):**
Click Sign in → browser opens `app.zeros.build/launch` with the handoff context → sign in right there if needed → **"You're signed in — Launch Zeros"** → deep-link back to the desktop with a single-use ticket. The ticket/PKCE/refresh design underneath is genuinely good — nothing about it changes.

### Migration plan (safe, ~half a day of work, zero user disruption)

**Phase A — move the code (one PR):**
1. Copy `auth-app`'s five function files + session lib into `web-app` under `/auth/*`; change `REDIRECT_URI` to `https://app.zeros.build/auth/callback`; point the hub's Sign in/Sign out links at the local paths.
2. Render provider buttons directly in the hub's signed-out state (delete the interstitial page).
3. Switch the session cookie from `Domain=.zeros.build` to host-only, and replace the raw-text error responses ("state mismatch", etc.) with the styled shell + a Try-again button.

**Phase B — config (15 minutes, dashboards):**
4. Auth0 → Application → add `https://app.zeros.build/auth/callback` to **Allowed Callback URLs** (keep the old one during transition; `app.zeros.build` is already in Allowed Logout URLs — I tested).
5. Cloudflare → `zeros-web` project → add `AUTH0_AUDIENCE` + confirm `AUTH0_CLIENT_SECRET`/`AUTH0_DOMAIN` (it becomes the only Pages project with auth env).

**Phase C — deploy & retire (a week later):**
6. Deploy; test both journeys (web + Mac, sign-in/out, handoff).
7. Turn `auth.zeros.build` into a permanent redirect → `app.zeros.build`, leave for a week, then delete the `zeros-auth` Pages project, its DNS record, and the old callback URL in Auth0. Also drop the old `zeros.eu.auth0.com/` issuer on Railway.

**What deliberately does NOT change:** the desktop app (it already talks only to `app.zeros.build`), the handoff/ticket design, Auth0 tenant + custom domain, the Railway API.

### Env after the merge — the whole auth config fits in two boxes

| Where | Vars |
|---|---|
| Cloudflare Pages `zeros-web` | `AUTH0_DOMAIN=login.zeros.build`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_AUDIENCE=https://api.zeros.build` + `SESSIONS` KV |
| Railway `zeros` | `AUTH0_DOMAIN=login.zeros.build`, `AUTH_ISSUER=https://login.zeros.build/`, `AUTH_AUDIENCE=https://api.zeros.build` |

---

## Part 4 — Order of operations from here

1. **Now (you, 30s):** fix `AUTH0_DOMAIN` on `zeros-auth` + retry deployment → sign-in/out work again today, before any refactor.
2. **Now (you, 1min):** rotate the pasted Cloudflare token.
3. **This week (one PR):** Phase A+B merge — say the word and I'll build it.
4. **Next week:** Phase C retirement.
5. **Then:** grow `app.zeros.build/settings` into the team & billing surface (Traycer-style) on this now-single foundation.
