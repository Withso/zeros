# Auth Hardening Report — 2026-07-07

> **Superseded in part (2026-07-25):** "Organization" was renamed to **Team** and the nested sub-team concept was retired — one flat level now. Identifiers below (`organizations`, `organization_members`, `org_secrets`, `org-sync.ts`, `/v1/orgs`, "personal org + Personal team") reflect the schema as of this document's date; the hardening findings and their fixes still stand. See [teams.md](teams.md).

Follow-up to `docs/auth-audit-2026-07-07.md`. The login bug is fixed and **end-to-end auth now works** — this report answers "what else to make it strong, seamless, and secure" across all three surfaces (web, Mac app, Railway backend).

Three deep audits were run (one per surface), then **every "critical" finding was hand-verified against the code**. Two of the scariest ones did not survive verification — noted below so we don't waste a PR on non-problems.

---

## A. It's working — confirmed end-to-end

After you fixed the Post-Login Action, I checked the live system:

- Your token now carries `https://zeros.build/email = hi@arunrajkumar.com` + `email_verified: true` + `name` ✅
- Railway logs flipped from **401 → 200**: `GET /v1/me 200`, `GET …/settings 200`, `POST …/secrets/resolve 200` ✅
- The DB provisioned correctly: `hi@arunrajkumar.com` now has a user row, a personal org (`arun-raj-kumar-b3e6a8cb`), owner membership, and a "Personal" team ✅
- The two legacy accounts are backfilled into `user_identities`, so they won't lock out ✅

The single sign-in flow (no separate sign-up) is working as designed: sign in with a new provider → account + org + team created automatically.

---

## B. How it all fits together (the "how Auth0 talks to the Railway DB" you asked for)

There are **three independent identity surfaces**, joined only by the Auth0-signed token. Auth0 is the single source of *identity*; Railway is the source of *product data* (orgs/teams/secrets). They never talk to each other directly — the **token is the courier**.

```
                          ┌──────────────┐
   Google / GitHub  ───►  │    Auth0     │  login.zeros.build
                          │ (identity)   │  ── Post-Login Action stamps
                          └──────┬───────┘     email + email_verified + name
                                 │  signs a JWT (RS256)
              ┌──────────────────┼───────────────────┐
              ▼                  ▼                   ▼
        ┌───────────┐     ┌────────────┐      ┌──────────────┐
        │  WEB      │     │  MAC APP    │      │  RAILWAY     │
        │ Cloudflare│     │  Electron   │      │  backend     │
        │ Pages     │     │             │      │  api.zeros   │
        └─────┬─────┘     └──────┬──────┘      └──────┬───────┘
              │ KV session       │ keychain          │ verifies JWKS
              │ (cookie)         │ (tokens)          │ from Auth0
              │                  │                   │
              │   handoff (PKCE ticket) ──►          │ every /v1/* call:
              │                  │  Bearer token ───►│  1. verify signature
              │                  │                   │  2. require email+verified
              │                  │                   │  3. ensureUser() → DB row
              └──────────────────┴───────────────────┘
```

**The lifecycle in words:**
1. **Web login** (app.zeros.build): browser → Auth0 → provider consent (once ever) → callback stores a 30-day **KV session** keyed by an opaque cookie. The browser never calls Railway.
2. **Desktop handoff**: "Launch Zeros" mints a single-use **PKCE ticket** (90-second TTL). The Mac app redeems it, proving possession of a **verifier that never leaves the Mac**, and gets its own Auth0 token pair stored in the **macOS keychain**.
3. **Railway provisioning**: the Mac app calls `GET /v1/me` with the Bearer token. The backend verifies the signature against Auth0's public keys, requires `email` + `email_verified: true`, then **`ensureUser()` creates user + personal org + Personal team in one transaction** (just-in-time). This is the ONLY moment a Railway row is born.
4. **Org sync**: every 15 min (and on sign-in), the app pulls org settings + decrypted secrets and couriers them into the local engine. On sign-out it couriers an **empty** context, wiping secrets from memory.

**Key design property:** identity (Auth0) and authorization (Railway `organization_members.role`) are separate. A valid token proves *who you are*; the Railway `role` column decides *what you can do*.

---

## C. Findings that did NOT survive verification (don't fix these)

| Agent claim | Rated | Verdict after reading the code |
|---|---|---|
| Handoff ticket in URL can be stolen → token theft (deep-link hijack) | "Critical/High" | **False.** `redeem` requires `sha256(verifier) === challenge`; the verifier is generated on the Mac and never travels through `zeros://`. A stolen ticket alone is useless. This is textbook PKCE, correctly done. |
| Org secrets stay in memory after sign-out | "Critical" | **False.** `org-sync.ts:77` couriers an empty context (`secrets: {}`) whenever `authStatus !== "authenticated"`. Secrets are wiped on sign-out. (Engine-side belt-and-suspenders is optional, not urgent.) |
| Open redirect via `return`/`returnTo` params | implied | **False.** `safeReturn()` (oauth.ts:73) allows only `https:` + `*.zeros.build`. Everything else falls back to the app root. |
| Logout GET is a dangerous CSRF | "High" | **Overrated.** Worst case is a forced sign-out; the redirect target is `safeReturn`-sanitized so it can't phish. Genuine but **low**. |

---

## D. Real findings, prioritized

### Tier 1 — quick, high-value (recommend doing now)

**1. Add security headers to app.zeros.build** *(web — Medium)*
Verified live: the site sends only `referrer-policy`. Missing `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`. Without HSTS a first-visit downgrade is possible; without X-Frame-Options the sign-in page is clickjackable.
*Fix:* add a `website/web-app/public/_headers` file (Cloudflare Pages serves it). ~15 min.

**2. Enforce Postgres RLS for real** *(backend — High, but currently mitigated)*
Verified live: the app connects as the `postgres` superuser, which **bypasses every RLS policy** (`rolbypassrls = true`). The row-level policies in `migrations/0002_rls.sql` are currently decorative. Authorization is 100% app-layer (`authz.ts requireRole`) — which is correct and *is* the real lock in most SaaS — but the second defensive layer is off. If an app-layer check is ever missed, or a SQL-injection slips in, there's no backstop.
*Fix:* create a non-owner `zeros_app` role, connect as it, and `ALTER TABLE … FORCE ROW LEVEL SECURITY`. ~1–2 hrs + careful deploy. Do it as its own PR with the RLS test suite green.

**3. Rate-limit the un-capped backend mutations** *(backend — Medium)*
`POST /v1/orgs`, `POST …/teams`, `PATCH …/members/:user`, `POST …/secrets` have no rate limit. A logged-in user can create 100 orgs/sec or spam-rewrite secrets (audit-log flood). The three highest-risk routes (invite create/accept, secrets resolve) already are limited.
*Fix:* a global `app.use("/v1/*", rateLimit("global", 100, 60_000))`. ~30 min.

### Tier 2 — worth doing, more design

**4. Revalidate web sessions against Auth0** *(web — Medium)*
A KV session is a 30-day cache that's **never rechecked against Auth0**. If you delete/block a user in Auth0, their browser session keeps working until TTL. (The Mac app doesn't have this problem — its token refresh re-proves liveness.)
*Fix:* store `issuedAt`; on read older than ~24 h, do a refresh-grant liveness check and drop the session on terminal failure. ~2 hrs.

**5. Backpressure on JIT signups** *(backend — Medium)*
`ensureUser()` runs on every authenticated request and will create a user+org+team for any new Auth0 `sub`. Someone with many Auth0 accounts could mass-provision rows. Auth0's own anti-abuse is the first line, but there's no backend ceiling.
*Fix:* a per-hour signup counter, or lean on Auth0 attack-protection + document it. ~2 hrs.

**6. Postgres pool hardening** *(backend — Low)*
No `statement_timeout` and no explicit `sslmode`. A hung query can pin a pool slot; TLS mode is inherited from the URL rather than enforced.
*Fix:* `statement_timeout: 30_000` + assert `sslmode=require` on the public proxy. ~20 min.

### Tier 3 — accepted risk / document only

- **Refresh token stored plaintext in KV** — inherent to KV being the server-side trust boundary; encrypting with another Cloudflare secret adds marginal defense. Low. Document.
- **`SameSite=Lax` cookie** — fine for modern browsers; the state-changing endpoints require a POST body the attacker can't forge-and-read. Leave as Lax (Strict would break the Auth0 return navigation).
- **Refresh-token family revocation** (shared browser+desktop family) — an Auth0 design tradeoff, already mitigated by the single-flight refresh mutex + shared-secrets sync. Document.
- **Vault master-key rotation** — `VAULT_MASTER_KEY` rotation isn't implemented (would orphan existing secrets). Write a rotation runbook before it's ever needed.

---

## E. What shipped (all on this branch)

**PR-A — Tier 1 (commit `ebb1bd18`):** `_headers` file + backend global `/v1` rate limit + Postgres `statement_timeout`.

**PR-B — RLS enforced (this batch):** `migrations/0004_rls_enforce.sql` creates the `NOLOGIN, NOBYPASSRLS` `zeros_app` role, grants it exactly the request-path DML, closes the `user_identities` RLS gap, and `FORCE`s RLS on every table. `db.ts` runs `SET LOCAL ROLE zeros_app` at the top of every request transaction — so RLS binds **without changing the Railway credential** (no risky DB-user swap). Verified end-to-end against the live DB in a rolled-back transaction: as `zeros_app`, a user sees only their own row + shared-org members; signup inserts still succeed on the system path; a foreign org read returns zero rows.

**PR-C — session revalidation + signup ceiling (this batch):**
- Web: `getVerifiedSession()` re-proves a KV session against Auth0 once it's >24h old and clears it if the user was deleted/blocked (with a KV single-flight lock to avoid a rotation-race logout). Hub render now uses it; sessions carry a `verifiedAt` stamp.
- Backend: `ensureUser()` charges a global signup budget (200 new users/hour, tunable) before creating anything, so a flood of fresh Auth0 subs can't mass-provision rows. Existing users are never affected.

**Still open (own PRs, documented):** vault `VAULT_MASTER_KEY` rotation runbook; the Tier-3 accepted risks recorded in the backend README.

Nothing here blocks using the product today — auth works and the authorization spine is sound. These make it production-grade for real external users.
