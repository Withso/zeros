# Auth & Onboarding Audit — 2026-07-07

> **Superseded in part (2026-07-25):** "Organization" was renamed to **Team** and the nested sub-team concept was retired — one flat level now. Identifiers below (`organizations`, `teams` as a sub-table, `org_id`, `org-sync.ts`, `/v1/orgs`, "personal org + Personal team") reflect the schema as of this document's date; the auth findings themselves still stand. See [teams.md](teams.md).

**Trigger:** `jordan@example.com` signed in with GitHub, appears in Auth0's user list, but never appeared in the Railway database. Also: no GitHub consent page on what looked like a first sign-in.

**TL;DR:** Sign-in itself works. The broken link is **app → Railway control plane**: every single API call from the Mac app to `api.zeros.build` since the Auth0 migration has been rejected with **401 Unauthorized** — including 11+ calls during this morning's test session — and the app silently swallows the error. Users are created in the Railway DB *by that first API call*, so no rejected call = no user row. Consent-page behavior is normal and needs no configuration. The single sign-in flow (no separate sign-up) is correct by design.

---

## 1. How the system is designed to work (the two "user lists")

There are two different records of a user, created at different moments:

| Store | What it is | When a user appears |
|---|---|---|
| **Auth0 Users** | The identity phonebook (who can log in) | Instantly, at first login with Google/GitHub — automatic |
| **Railway DB** (`users`, `organizations`, `teams`) | The product record (your account, personal org, "Personal" team) | The **first time the Mac app calls the control plane** (`GET /v1/me` at `api.zeros.build`) after sign-in — "just-in-time provisioning" |

The full journey: **Sign in on app.zeros.build → Auth0 confirms identity (user appears in Auth0) → "Launch Zeros" hands tokens to the Mac app → the app immediately calls `/v1/me` → Railway backend verifies the token and creates user + personal org + Personal team in one transaction.**

`jordan@example.com` completed every step except the last one — the backend rejected the token.

## 2. The evidence

Railway HTTP logs for the `zeros` service (entire retained window):

```
19× GET /v1/me → 401        ← every real call, including 02:49–03:05 UTC today
                               (= 8:19–8:35 AM IST, exactly your test session)
 0× any /v1/* → 2xx         ← not one successful authenticated call
```

The database confirms it — frozen at the Supabase era:

- `users`: only `sam@example.com` + `sam.rivera@example.net`, both created **2026-07-04** (pre-Auth0-migration)
- `audit_log`: last entry **2026-07-04 13:09** — nothing since
- `user_identities`: **completely empty** (this matters — see §4)

The app never told you because `org-sync` deliberately swallows control-plane errors (`src/zeros/org/org-sync.ts` — empty `catch {}` meant for transient network blips; it also hides a permanent 401).

## 3. Why the backend rejects the tokens (root-cause analysis)

Ruled out by direct verification:

- ✅ Railway runs **current main** (`ea29b4c0`, deployed 2026-07-06 17:59 UTC) — includes all auth fixes
- ✅ Env vars correct: `AUTH_ISSUER=https://login.zeros.build/,https://zeros.eu.auth0.com/`, `AUTH_AUDIENCE=https://api.zeros.build`, `AUTH0_DOMAIN=login.zeros.build`
- ✅ JWKS (public signing keys) live at `login.zeros.build/.well-known/jwks.json`; issuer matches
- ✅ Web app always requests `audience=https://api.zeros.build` (so tokens are proper JWTs)
- ✅ Desktop → backend wiring works (the 401s prove the calls ARE arriving)

The remaining suspect — and it fits every symptom: **the Auth0 Post-Login Action is not stamping the email claims onto the access token in the live tenant.**

Background: Auth0 access tokens don't carry `email` by default. Our backend *requires* `email` + `email_verified: true` (fail-closed, an anti-account-takeover control). A Post-Login Action must stamp `https://zeros.build/email`, `…/email_verified`, `…/name` onto every access token. The **website** works regardless because it reads the *id_token*, which natively carries email — which is exactly why sign-in "looks fine" while the backend rejects everyone.

A token WAS verified as correct in jwt.ms on 2026-07-06 — but a fresh sign-in this morning still 401s. So the Action has either been detached from the Login flow, un-deployed, edited, or was deployed to a different tenant than the one `login.zeros.build` fronts (the custom-domain migration touched multiple tenants/spots).

**2-minute check (Auth0 dashboard):** Actions → Triggers → `post-login` → is the custom Action present in the flow and marked Deployed? Then sign in fresh and paste the access token into jwt.ms — does it contain `https://zeros.build/email`?

## 4. Second bug found: the two existing accounts will lock out AFTER the fix

The backend links logins to users via the `user_identities` table (`github|000000000` → user row). That table is **empty** — the two existing users predate it.

Current logic (`backend/src/auth.ts` `ensureUser`): unknown identity + email already exists → **409 "account exists from a different sign-in method"** (a deliberate anti-takeover guard). So once tokens verify again:

- `jordan@example.com` → fine (new email, gets user + org + team)
- `sam@example.com` and `sam.rivera@example.net` → **rejected on every call**

One-time backfill fix (subs taken from the Auth0 Users screen):

```sql
INSERT INTO user_identities (user_id, provider, provider_sub) VALUES
  ('00000000-0000-0000-0000-000000000000', 'auth0', 'github|000000000'),          -- sam@example.com
  ('11111111-1111-1111-1111-111111111111', 'auth0', 'google-oauth2|111111111'); -- sam.rivera@example.net
```

## 5. Consent pages — nothing is wrong, nothing to configure

- The consent screens are **GitHub's and Google's own pages**, not Auth0's. Auth0's extra "Authorize App" interstitial is deliberately suppressed (PR #140 + "Allow Skipping User Consent") — that's the standard first-party UX.
- Providers show consent **once per (account × OAuth app), ever** — the first-ever authorization — then silently approve forever.
- Why you saw none for `hi@`: that GitHub identity shows **6 logins** in Auth0 — today was not its first authorization. Consent appeared at its true first login (earlier testing) and never again. If the browser is already logged into GitHub, the redirect completes in under a second — it feels like "nothing happened."
- **Google will show consent** (account picker + "wants access to your email & profile") the first time a *new* Google account signs in — then never again.
- Verified live by tracing the real sign-in redirect chain: both connections use **your own OAuth apps** (GitHub client `Ov000000000000000000`, Google client `000000000000-….apps.googleusercontent.com`) — **not** Auth0 developer keys. So the Google page brands as your app, not "auth0.com". The earlier dev-keys concern from the 07-06 audit is resolved.

## 6. Sign in vs sign up

The current single-flow design is correct and industry-standard (same as Linear, Vercel, Notion):

- One "Continue with GitHub / Continue with Google" flow.
- First-timers: account auto-created (Auth0 identity instantly; Railway user + personal org + Personal team on the app's first API call). The landing page already says *"New here? Signing in creates your account."*
- Returning users: same buttons just sign in.
- No separate sign-up screen needed — and none should be added.

It will work properly end-to-end once §3 (and §4) are fixed.

## 7. Is the org/team/user DB working with the new auth flow?

**No — not for anyone, since the Auth0 migration (2026-07-05).** Every feature behind the control plane is silently non-functional: user provisioning, orgs, teams, invitations, org-settings, org-secrets sync. What still works: web sign-in, desktop handoff, session refresh, and everything local to the app. The failure is invisible because org-sync retries silently every 15 minutes and hides errors.

## 8. Fix list (ordered)

1. **Auth0 dashboard:** verify the Post-Login Action is deployed AND attached to the `post-login` trigger in the tenant that `login.zeros.build` fronts; confirm with a fresh jwt.ms decode. Re-login after (old tokens keep the old claims).
2. **Railway DB:** run the two-row `user_identities` backfill (§4).
3. **Backend (small PR):** log the 401 reason (`missing-email` vs `bad-signature` vs `email-unverified`…) so Railway logs diagnose this class of failure instantly.
4. **App (small PR):** surface control-plane failure instead of silent `catch {}` — e.g. a "couldn't sync your organization" state in Settings → Organization.
5. **Optional:** alert on sustained 100% 401 rate on `/v1/*`.

---
*Method: live Railway DB + HTTP-log inspection, Railway deploy/env verification, JWKS/issuer probes, live OAuth redirect-chain trace, and two parallel code audits (backend provisioning path; web-app sign-in flow). All findings verified against current `main`.*
