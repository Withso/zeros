# Recommended Architecture

*Part 04 of the Zeros GitHub Integration Report · July 2026*

## The short version

- **Three explicitly-selected, independently-stored auth methods** — `gh CLI`, **Zeros GitHub App** (recommended), `Personal Access Token` — replacing today's implicit fallback chain into one token slot. Storing them in separate slots is what makes the picker honest: switching method must not destroy the other credential.
- **One genuinely new component: a Zeros-owned git credential broker** (`src/engine/git/credential-broker.ts`) — a unix-socket HTTP server plus PATH-shimmed `git`/`gh` and a `GIT_ASKPASS` shim. It is the single fix for four confirmed problems at once: push works under every method, short-lived tokens become viable, the agent's own shell `git`/`gh` are covered, and cloud sandboxes reuse the identical code path.
- **The GitHub App is a *public* GitHub App whose client secret and private key live in `backend/`.** The Mac holds only an 8-hour user access token plus a 6-month refresh token in safeStorage. This is forced, not chosen: GitHub documents `client_secret` as **Required** on `POST /login/oauth/access_token` even with PKCE (**verified**), and minting an installation token needs the App private key.
- **Cloud sandboxes never receive a long-lived credential.** The backend mints **1-hour installation access tokens** scoped to the one repository the sandbox needs; the broker refreshes them in place at T−60 s and on a shim-reported 401. A 6-hour agent run outlives a 1-hour token five times over, so refresh is the normal path, not an edge case.
- **Six confirmed blockers ship first.** The most important is that `isAuthError()` treats **403 as 401** and durably deletes the user's credential via two independent routes (`src/engine/git/github.ts:390`, `:209`, `:497`; `electron/ipc/commands/github.ts:54`). Per-repo installation scoping *generates* 403s by design — shipping the App on today's classifier would sign users out constantly.
- **The OAuth hand-back reuses machinery Zeros already ships and has already hardened**: `zeros://auth/callback#ticket=…&nonce=…`, an opaque single-use ticket, PKCE verifier held in Electron main's safeStorage, redeemed over HTTPS from main (`electron/ipc/commands/auth-handoff.ts:11-25`, `electron/deep-link.ts:131`). The GitHub App flow is a second instance of that pattern, not a new one.
- **Durable selection lives in `~/.zeros/settings.toml` → `[github] auth_method`**, mirroring the shipped `providers.<agent>.auth` shape exactly (`src/engine/settings/schema.ts:114`, `:311`, `:359`; write-through at `src/zeros/panels/provider-prefs.ts:73-83`). Non-secret installation metadata goes in SQLite, revalidated on open — never treated as truth.
- **The migration infers, never defaults.** If `gh auth token` returns the same string that is stored, write `gh-cli`; otherwise `pat`; if no token, leave the key unset and render "no method selected". A wrong default silently signs people out.
- **The broker is also the multi-provider abstraction**, because the one thing that genuinely differs per forge at the git layer is the magic HTTPS username (`x-access-token` / `oauth2` / `x-token-auth`), and the broker is the only place that has to know it.

---

## 0. What this document is, and is not

This is the recommended architecture for Zeros' GitHub integration, expanded from `.context/architecture-decision.md` and expressed at implementation depth: interfaces, storage keys, endpoint shapes, state transitions, and the exact defects that block each piece.

Two honesty notes that belong at the top, not in a footnote:

1. **This is one author's synthesis of the verified evidence, not a panel consensus.** The evidence base behind it is unusually strong — 17 parallel agents (9 code auditors over this repo, 8 web researchers) produced findings and claims, then 220 independent agents each tried to refute exactly one finding or fact-check exactly one claim. 52 of 109 verified audit findings survived (a 52% kill rate); 188 of 207 claims survived. But the design panel and the report critics were cut for time. Where a decision below rests on judgement rather than on a surviving finding, it says so.
2. **The three-method picker itself is a product decision, not a verified competitor fact.** The claim that Conductor ships "an explicit user-selected credential, not an implicit precedence chain" was **refuted** in verification: the changelog quotes are accurate but the analytical conclusion built on them is unsupported by the cited sources. The exact strings ("All repositories accessible.", the RECOMMENDED badge, the row ordering) are tagged **unverified** — their only source is the founder's screenshot. What *is* verified from the first-hand teardown is that Conductor persists the auth method *with* the credential as a discriminated union, which is the load-bearing structural fact.

Every external claim below is tagged **verified** / **likely** / **unverified**. Every code claim is cited `path:line` and was opened before being asserted.

---

## 1. The decision, in one paragraph

Zeros ships **three explicitly-selected, independently-stored auth methods** — `gh CLI`, **Zeros GitHub App** (recommended), and `Personal Access Token` — behind a single new component that the current codebase lacks entirely: a **Zeros-owned git credential broker**. The GitHub App is a *public* GitHub App whose client secret and private key live in the existing `backend/` control plane; the desktop app never holds either. The Mac holds only a user access token (8 h) plus a refresh token (6 mo), in safeStorage. Cloud sandboxes never receive a long-lived credential: the backend mints **1-hour installation access tokens** scoped to the one repository the sandbox needs, and the broker refreshes them in-place. The broker is also what makes GitLab and Bitbucket tractable later, because the one thing that genuinely differs per provider at the git layer is the magic username, and the broker is the only place that has to know it.

---

## 2. Why this shape, and not the alternatives

### 2.1 A backend is unavoidable, so stop paying for a design that pretends otherwise

GitHub documents `client_secret` as **Required** on `POST https://github.com/login/oauth/access_token` for the authorization-code flow — for GitHub Apps and OAuth Apps alike, **even with PKCE** (**verified**). GitHub added PKCE on 2025-07-14, S256 only (`code_challenge_method` "Must be S256 - the plain code challenge method is not supported"), and states it "is not requiring PKCE for any authentication flow at this time, as GitHub does not distinguish between public and confidential clients" ([changelog](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/), [GitHub App user-token docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)). GitHub staff put it plainly in [community discussion #15752](https://github.com/orgs/community/discussions/15752) on 2025-07-15: *"we don't have a 'public client' concept yet, so we treat all clients the same and all of them require access to the client secret."* The SPA-preview roadmap item ([github/roadmap#1153](https://github.com/github/roadmap/issues/1153)) will forbid a secret and require PKCE, with native apps "to come" — but GitHub missed its stated Q4-2025 target and the thread's latest comment (2026-06-22) is unanswered (**verified**).

Refreshing a user access token also requires the secret (**verified** — `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token` on the same endpoint; [refresh docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)). And minting an installation token requires the App **private key**, which can never ship in a desktop binary: every endpoint that answers "which installation covers this repo?" — `GET /repos/{owner}/{repo}/installation`, `GET /orgs/{org}/installation`, `GET /app/installations` — is documented "You must use a JWT to access this endpoint" (**verified**, [REST apps](https://docs.github.com/en/rest/apps/apps)).

Zeros already runs `backend/`: Hono with an Auth0 JWKS-verified JWT middleware on every `/v1/*` route (`backend/src/index.ts:56`), a 256 KB body cap (`:53`), a blanket per-user rate limit (`:63`), Postgres with `FORCE ROW LEVEL SECURITY` on every tenant table (`backend/migrations/0004_rls_enforce.sql:59-64`), team membership/role helpers (`backend/src/authz.ts:34`, `:51`) and an append-only audit log (`backend/migrations/0001_init.sql:107`). Put the secrets there.

### 2.2 Device flow is the fallback, not the primary

Device flow is the one GitHub flow needing no secret — the docs' carve-out reads "Required unless the user access token was generated using the device flow" (**verified**) — and it must stay wired, because it is what a backend outage and a self-hosted fork fall back to. Zeros' `startDeviceFlow()` already works and needs only a client-id swap.

But it must not be the *recommended* path. Device-code phishing is now a mainstream attack class: Microsoft attributed an active campaign to Storm-2372 (assessed with **moderate** confidence as aligning with Russian state interests, active since August 2024) on [2025-02-13](https://www.microsoft.com/en-us/security/blog/2025/02/13/storm-2372-conducts-device-code-phishing-campaign/), and published ["Inside an AI-enabled device code phishing campaign"](https://www.microsoft.com/en-us/security/blog/2026/04/06/ai-enabled-device-code-phishing-campaign-april-2026/) on 2026-04-06; a [CSA research note dated 2026-04-05](https://labs.cloudsecurityalliance.org/research/csa-research-note-oauth-device-code-phishing-surge-20260405/) reports a **37.5× surge** in device-code phishing pages driven by the EvilTokens phishing-as-a-service kit (**verified**). The attack works because the victim completes a *genuine* provider authorization page with real MFA, so no phishing-resistant control fires. Making "type this code into GitHub" the recommended gesture in 2026 trains users into exactly the motion the attack needs.

One correction the fact-checkers forced, worth carrying so nobody over-claims in review: **Salesforce did not remove device flow outright.** It removed it from two first-party connected apps (Data Loader, effective 2025-09-02; Salesforce CLI, 2025-08-28) and disabled the classic "Enable for Device Flow" toggle; device flow remains a documented, supported Salesforce flow (**verified**).

Also note: GitHub App device flow is **off by default** — the App owner must tick "Enable Device Flow", or the device endpoints return **400** (**verified**, [2022-03-16 changelog](https://github.blog/changelog/2022-03-16-enable-oauth-device-authentication-flow-for-apps/)). A 400 here is the single most likely day-one failure of the App registration.

### 2.3 The cloud-workspace requirement settles it

A rented sandbox has no `gh` login and no keychain. Forwarding the user's PAT into a rented VM is the one option we reject outright. A **1-hour installation token scoped to a single repository** is the smallest credential that does the job, and only a server holding the private key can mint one (**verified**: 1-hour lifetime, `repositories`/`repository_ids` down-scoping, usable as the git HTTPS password with the Contents permission — [installation-auth docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)).

The existing internal plan already assumes this in writing — `docs/cloud-workspace/08-engineering-reference.md:533` specifies "Zeros App installation token (1 h, auto re-mint) `https://x-access-token:TOKEN@github.com/...`; PAT fallback; engine reads `ZEROS_GITHUB_TOKEN`". None of it is built, and three shipped mechanisms actively block it (see §11.1).

### 2.4 Never trust the desktop binary with a secret

GitHub Desktop bundles its client secret via webpack (**verified**, [desktop OAuth doc](https://github.com/desktop/desktop/blob/development/docs/technical/oauth.md)), and `gh` embeds its own — `oauthClientID = "178c6fc778ccc68e1d6a"`, `oauthClientSecret = "34ddeff2b558a23d38fba8a6de74f086ede1cc0b"`, annotated `// This value is safe to be embedded in version control` ([cli/cli trunk](https://raw.githubusercontent.com/cli/cli/trunk/internal/authflow/flow.go), **verified** as of 2026-07-29). RFC 8252 §8.5 agrees that such a value is not a confidential secret: *"Secrets that are statically included as part of an app distributed to multiple users should not be treated as confidential secrets"* (**verified**). <!-- gitleaks:allow — gh's own value, published in cli/cli and annotated safe-to-embed there -->

Both are *precedent*, neither is *justification* — and neither ships a multi-tenant cloud product whose blast radius includes other people's repositories. Note also that `gh`'s embedded credential belongs to an **OAuth App with the broad `repo` scope**, which is precisely what a per-repo-scoped GitHub App exists to improve on.

### 2.5 Why not: backend-free, device-flow-primary

The honest version of this alternative is: keep `startDeviceFlow()` as the only browser-ish path, keep PATs, add nothing server-side. It is genuinely cheaper and it ships this month. We reject it because it fails on four independent axes:

| Requirement | Backend-free / device-flow-primary |
|---|---|
| Per-repo scoping | **Impossible.** Device flow yields a *user* token. There is no installation object, so "All repositories accessible" can only ever mean "everything this account can see". |
| Cloud workspaces | **Impossible without shipping a user credential into a rented VM.** No private key ⇒ no installation token ⇒ the only thing you can courier is the user's own 8-hour token or their PAT. |
| Token refresh | **Impossible.** `POST /login/oauth/access_token` with `grant_type=refresh_token` requires `client_secret` (**verified**). A GitHub App user token dies after 8 hours and the user re-runs the flow — five times a working day. |
| Security posture | Makes the *recommended* gesture the one with a documented 37.5× phishing surge (§2.2). |

It also does not remove the backend from the picture, only from *this* feature: Bitbucket OAuth does not support PKCE at all and requires `client_id:secret` via Basic auth (**likely**), so `backend/` becomes load-bearing the moment a second forge lands. Building it now buys the GitHub App, cloud credentials and Bitbucket in one motion.

### 2.6 Why not: ship the secret

The strongest form of this argument is that GitHub itself tells you to. `gh`, GitHub Desktop, VS Code, Visual Studio and GitHub Mobile all embed a secret, and GitHub staff said so in the same breath as the "no public client concept" quote: *"You cannot keep a secret 'secret' within a public client, but you do have to embed it there anyhow"* (**verified**).

We still reject it, for three reasons that are specific to Zeros rather than generic:

1. **It does not get you the thing you actually need.** The client secret buys the *user*-token exchange and refresh. It does not buy installation tokens — those need the **private key**, and a private key in a shipped binary is a multi-tenant compromise, not an inconvenience. Since the cloud requirement forces a server that holds the private key anyway, the secret may as well live beside it. Shipping the secret buys nothing and costs a rotation story.
2. **Rotation.** A revoked-and-rotated embedded secret breaks every installed copy until the user updates. Zeros has release channels and an updater, but the failure mode is "your app can't sign in until you update", which is exactly the class of incident a local-first product cannot absorb.
3. **The blast radius is other people's repositories.** `gh`'s secret protects an OAuth App acting for one user at a time. A Zeros App secret plus a leaked key would sit in front of every installation Zeros holds.

If the founder later decides the backend is too much operational weight, the fallback is *not* "ship the secret and keep the App": it is "device flow only, and no cloud workspaces". Those two are the honest pair.

### 2.7 Why not: forward the user's PAT into the sandbox

Rejected outright, and stated in the UI rather than only in docs. The failure class is well documented — a long-lived broad-scope credential inside a machine an LLM agent controls (**likely**; the worked examples in the evidence base are Cursor CVE-2026-22708 and the Supabase MCP token-exfiltration incident, with OWASP ranking agent goal hijacking #1 for 2026). Vercel's own guide for its Sandbox product recommends **GitHub App installation tokens for multi-tenant platforms** and fine-grained PATs only for individual developers (**verified**, [vercel.com/kb/guide/sandbox-private-github-repositories](https://vercel.com/kb/guide/sandbox-private-github-repositories)), delivered as `Sandbox.create({ source: { type: 'git', url, username: 'x-access-token', password: TOKEN } })`. Zeros' own cloud docs already carry the same warning: *"any secret injected via env/files can be read by a context-injected agent inside the box"* (`docs/cloud-workspace/08-engineering-reference.md`, Daytona warning immediately after the credential-injection bullet).

The PAT method therefore stays selectable for local work, is **permitted but warned** for cloud, and the copy says so: *"Not used in cloud workspaces. Zeros never sends your personal token to a rented sandbox."*

### 2.8 Why not (yet): the credential proxy

Anthropic's Claude Code cloud sessions are a strictly stronger posture than ours: *"All GitHub operations go through a dedicated proxy that keeps your real GitHub credentials outside the session's VM"*; the in-VM git client "uses a scoped credential, which the proxy verifies and swaps for your actual GitHub token", with **push restricted to the session's current working branch** (**verified**, [cloud-environments docs](https://code.claude.com/docs/en/cloud-environments)). That is the only architecture that survives "assume the agent's box is compromised".

Two caveats keep it out of phase 1. First, it is GitHub-only even for Anthropic — GitLab/Bitbucket remotes can only be sent as a local bundle and "the session can't push results back to the remote" (**verified**). Second, it is a second network hop on the hot path for every git operation, and Zeros' cloud design deliberately keeps the middleman *off* the live path (`docs/cloud-workspace/02-how-conductor-does-it.md`). It is the phase-3 direction, and the broker is the right place to put it, because the broker is already the only component that knows how a credential is obtained.

### 2.9 The one place the evidence pushes back: `zeros://` versus loopback

This is the single point where a careful reader of the evidence base could reasonably diverge from the spec, so it is stated in full rather than smoothed over.

**The spec's choice:** the GitHub redirect target is the **backend**, which hands control back to the app via the registered `zeros://` scheme carrying a one-time nonce bound to the `state`.

**What supports it.** RFC 8252 does not rank loopback above private-use schemes: §7 says native apps "MAY use whichever redirect option suits their needs best", and Appendix B.4 calls private-use schemes "a good redirect URI choice on macOS" (**verified**). More decisively, **Zeros already ships exactly this pattern for its own sign-in, and has already hardened it**: `zeros://auth/callback#ticket=…&nonce=…` where the ticket is "an OPAQUE, single-use, short-TTL handoff code — NOT a token", the PKCE verifier never leaves Electron main (`electron/ipc/commands/auth-handoff.ts:11-25`), the redeem target is fixed in main and never renderer-supplied, the secret rides in the URL **fragment** and is never logged (`electron/deep-link.ts:123-124`, `:131`), and each release channel registers its **own** scheme so a packaged Beta cannot steal stable's links (`electron/deep-link.ts:46-51`, `:82`). Reusing this is a smaller, better-tested change than standing up a second callback mechanism.

**What argues against it.** Apple's current guidance is verbatim: *"If multiple apps register the same scheme, the app the system targets is undefined. There's no mechanism to change the app…"* (**verified**). On macOS "undefined" means undocumented rather than random — Launch Services applies deterministic heuristics (root-level `/Applications` preferred, then higher version), so a colliding app can deliberately engineer a win (**likely**). And the standards *direction* does favour loopback: [draft-ietf-oauth-v2-1-15](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1) (March 2026, still a WG document) reorders native redirect options to claimed-https → loopback → private-use and says private-use schemes "should only be used if the previously mentioned more secure options are not available" (**verified**).

**Why the spec's choice still holds.** The scheme carries only a **single-use nonce bound to the `state`, never a token** — so a hijacking app gets a value it cannot redeem without the main-process verifier, exactly as with the shipped Auth0 handoff. Note also that a verification pass **refuted** the tidy claim that "PKCE defeats loopback interception": two of its three pillars survived, but the security conclusion was overstated and the exact-redirect-matching pillar is false for the providers at issue. So loopback is not free of failure modes either — a squatting local process still breaks the login even when it cannot redeem the code.

**Decision:** ship `zeros://` reusing the handoff machinery. Keep loopback (`http://127.0.0.1:<ephemeral>/callback`, IP literal, **never** `localhost`, bound to 127.0.0.1 only, closed immediately after the redirect, hard timeout) as the documented alternative if scheme collisions bite. One dev-ergonomics detail must not be lost: multiple dev worktrees register the *same* `zeros-dev://` scheme, so macOS delivers the callback to only one instance — the shipped `auth_peek_handoff()` command exists precisely so the receiving instance can complete a sibling's flow. The GitHub flow must reuse that or it will silently break in dev worktrees.

---

## 3. Phase 0 — the six blockers, fixed before any of the above

These are confirmed defects in shipping code and are prerequisites, not follow-ups. All six survived adversarial refutation.

| # | Defect | Where |
|---|---|---|
| **B1** | The persisted token never reaches git transport; every network git op relies on the user's ambient credential helper | `src/engine/git/git-exec.ts:291`, `src/engine/git/ops.ts:116`, `src/engine/git/github.ts:1076` |
| **B2/B4/B6** | `isAuthError()` treats **403 as 401**, so any rate limit, SAML denial, IP-allowlist denial or missing permission **durably deletes the user's credential** — via two independent routes (engine store → `GITHUB_TOKEN_CHANGED` → `gh_token_clear`, *and* Electron main's own safeStorage-backed `getAuthStatus`) | `src/engine/git/github.ts:390`, `:209`, `:497`; `src/engine/git/engine-token-store.ts:54`; `electron/ipc/commands/github.ts:54` |
| **B3** | "Create PR" never uses Zeros' token at all — it sends the agent a brief telling it to run `gh pr create` | `src/shell/pr/create-pr-button.tsx:98`, `src/shell/pr/pr-instructions.ts:74`, `packages/core/src/system-instructions/templates.ts:44` |
| **B5** | Both push tests push to a local bare repo, so the credential gap **cannot fail CI** | `src/engine/git/__tests__/publish-github.test.ts:3`, `ops.test.ts:104` |

### 3.1 B1, precisely

`runGit` forwards `opts.env` merged over `process.env` only when a caller supplies one — `...(opts.env ? { env: { ...process.env, ...opts.env } } : {})` (`src/engine/git/git-exec.ts:291`) — and the only callers that do are the per-turn snapshot (`GIT_INDEX_FILE`) and commit-tree author stamping. Nothing in the tree sets `GIT_ASKPASS`, `core.askPass`, `credential.helper`, `http.extraheader`, or an `x-access-token@` remote rewrite. The code says so out loud: *"The push relies on the user's git credential helper (gh), same as the existing workspace push"* (`src/engine/git/github.ts:898`).

The verifier added two refinements that shape the fix. (1) The blast radius is **HTTPS remotes** — SSH-cloned repos authenticate through the user's `ssh-agent` — but `publishRepoToGithub` always wires `origin` to the HTTPS `clone_url` (`src/engine/git/github.ts:1065-1076`), guaranteeing the failure for that flow. (2) The failure does **not** surface as `NOT_AUTHENTICATED`: `push`'s classifier matches only `/not authenticated|authentication failed|403|401/i` (`src/engine/git/ops.ts:128`), and git's real stderr in a non-tty Electron child is `could not read Username for 'https://github.com': terminal prompts disabled`, which matches nothing. The user gets an opaque `GIT_COMMAND_FAILED` — a code absent from `EXPECTED_ENGINE_ERROR_CODES`, so it is *also* reported as a bug.

Why `gh`-CLI users never noticed: `detectGhCli()` shells `gh auth token` and adopts the result, so a gh user has **both** the API token and `gh`'s `credential.https://github.com.helper` git-config entry (**likely**, [gh auth setup-git](https://cli.github.com/manual/gh_auth_setup-git)). The two systems coincide on exactly that one path.

### 3.2 B2, the exact fix

Split the classifier.

`isCredentialInvalid(err)` = **401 only**, plus 403 whose `response.data.message` matches `/bad credentials|token.*(expired|revoked)/`. New non-destructive codes:

| Code | Detection |
|---|---|
| `GITHUB_RATE_LIMITED` | 403 or 429 with `x-ratelimit-remaining: 0`, or any `retry-after` header |
| `GITHUB_SSO_REQUIRED` | 403 carrying `x-github-sso` |
| `GITHUB_FORBIDDEN_SCOPE` | 403 `Resource not accessible by integration` / `…by personal access token`; read `X-Accepted-GitHub-Permissions` to name the missing permission |
| `GITHUB_REPO_NOT_INSTALLED` | 404 on a repo the user can see, under an installation credential |
| `GITHUB_INSTALLATION_SUSPENDED` | 403 with a suspension message |

**Only `isCredentialInvalid` may call `tokenStore.clear()`.** This is a hard prerequisite for the App: per-repo installation scoping *generates* 403s and 404s by design, so shipping the App on today's classifier would sign users out constantly. GitHub's own troubleshooting page confirms 403 is returned for primary rate limit, secondary rate limit, SAML enforcement, `Resource not accessible by integration`, IP-allowlist denial and installation suspension (**verified**).

Two mechanism corrections from verification that change *where* the fix goes:

- The destructive path does **not** require the engine → renderer → `gh_token_clear` cascade. `ghAuthStatus` runs in **Electron main** (`electron/ipc/commands/github.ts:54`), where the injected `TokenStore` is safeStorage-backed (`electron/main.ts:1121-1131`, `clear()` = `deleteSecret("github_oauth")`). A single 403 while the user presses Refresh in Settings deletes the durable secret **directly and synchronously**. Both process copies need the split.
- `withAuthRetry` **does not retry**, despite its name and its four-line doc comment claiming a "one-shot 401 retry" (`src/engine/git/github.ts:487-505`). It clears and rethrows. Do not design on the stated contract; the retry has to be written.

### 3.3 SAML detection has three shapes, not one

The failure is **not always 403**. GitHub's docs say you "may receive a 404 Not Found or a 403 Forbidden error" (**verified**), and only the 403 carries `X-GitHub-SSO` with a one-hour authorization URL. On list endpoints GitHub instead returns **200 with silently missing data** plus `X-GitHub-SSO: partial-results; organizations=21955855,20582480` (**verified**). The exact 403 body is one sentence: `Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.` (the second clause reads "your Personal Access token" for PAT credentials). Handle all three, and model `sso_required_orgs` as a first-class field rather than an error string — the Conductor teardown found exactly that shape in the bundle (`sso_required_orgs[]`, `sso_required_org_display_names[]`), albeit in a message that is **probably Cursor's** riding along in a bundled SDK rather than Conductor's own.

**Unverified, and we will not guess:** whether a server-to-server *installation* access token is subject to SAML SSO authorization at all. GitHub's dedicated "SAML and GitHub Apps" page covers only install visibility and *user*-token authorization. This is a real gap in the cloud design and must be settled empirically against a SAML-enforced org before phase 2 ships.

### 3.4 B5, and why the test gap is structural

Both push tests push to a **local bare repo** (`src/engine/git/__tests__/publish-github.test.ts:3`, `ops.test.ts:104`), so the credential-helper dependency is invisible to CI by construction. GitHub auth has exactly one real test file (`src/engine/git/__tests__/github.test.ts`, 627 lines, 23 tests); `detectGhCli()`, `setToken()` and `signOut()` are never imported by any test in the repo; the whole Electron-main ↔ engine token courier is untested; and `@testing-library/react` is not a dependency, so component-level tests of the settings card are not currently possible — the repo's convention is to extract pure helpers/stores and test those.

Two hardcoded test lists (`package.json:77`'s `test:workspace-lifecycle`, and the `source-sync (macOS)` job in `.github/workflows/preflight.yml`) name individual files, so a new `github-auth` test file **silently does not run on macOS** unless it is added to both. Phase 0 lands: a 403-does-not-clear assertion, a 401-does-clear assertion, a broker integration test that pushes to a real HTTP git server behind a 401 challenge, and both list entries.

---

## 4. The three-method credential model

```mermaid
flowchart TB
  subgraph UI["Settings → Integrations → GitHub"]
    SEL["[github] auth_method<br/>gh-cli | zeros-app | pat<br/>~/.zeros/settings.toml"]
  end

  subgraph SLOTS["Electron main · safeStorage · secrets.json"]
    S1["(no slot)<br/>gh CLI stores nothing"]
    S2["github.app.userToken (8 h)<br/>github.app.refreshToken (6 mo)"]
    S3["github.pat"]
  end

  subgraph META["engine SQLite · zeros.db"]
    M1["github_installations<br/>id · login · targetType · repoCount<br/>repoNames · suspendedAt · lastVerifiedAt"]
  end

  subgraph BROKER["credential broker (engine)"]
    B1["envForContext / socket / shims"]
  end

  subgraph BE["backend/ · Hono + Postgres"]
    BE1["client secret + App private key"]
    BE2["mint 1 h installation token"]
  end

  SEL -->|"gh-cli"| S1
  SEL -->|"zeros-app"| S2
  SEL -->|"pat"| S3

  S1 -->|"delegate to<br/>gh auth git-credential"| BROKER
  S2 -->|"user token as password"| BROKER
  S3 -->|"PAT as password"| BROKER

  S2 -.->|"refresh needs the secret"| BE1
  BE1 --> BE2
  BE2 ==>|"repository_ids-scoped,<br/>sandbox only"| BROKER
  BE2 -.->|"metadata, revalidated"| M1

  BROKER --> G1["engine git ops<br/>push / fetch / clone / ls-remote"]
  BROKER --> G2["agent's own git / gh<br/>in the PTY"]
  BROKER --> G3["Octokit REST<br/>via the same record"]
```

| | gh CLI | **Zeros GitHub App** (recommended) | Personal Access Token |
|---|---|---|---|
| How the credential is obtained | `gh auth token` on demand | web flow: auth code + PKCE S256 in the **system browser**; backend exchanges the code | user pastes |
| Persisted on the Mac | **nothing** | user access token (8 h) + refresh token (6 mo) | the token |
| Storage | n/a | safeStorage `github.app.userToken` / `.refreshToken` | safeStorage `github.pat` |
| Git transport | broker delegates to `gh auth git-credential` | broker serves the user token as password | broker serves the PAT |
| Cloud sandbox | ✗ unsupported — no `gh` login in a sandbox | ✓ backend mints a 1 h installation token scoped to `repository_ids` | ⚠ permitted but warned |
| Per-repo scoping | none | ✓ installation-selected repositories | fine-grained PAT only |
| Revocation | `gh auth logout` | uninstall / revoke, or backend revoke | delete on GitHub |
| Expiry handling | `gh` owns it | broker refreshes at T−60 s and on reported 401 | none — PATs just die |
| REST rate limit | 5,000/hr, **shared** with every other app acting for that user | user token 5,000/hr shared; **installation token 5,000 → 12,500/hr** scaling | 5,000/hr |

Rate-limit figures are **verified** for the primary numbers ([REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)) and **likely** for the scaling rule (+50/hr per repository above 20, +50/hr per user above 20, capped at 12,500; GHEC-owned installs get a flat 15,000 and do not scale). The practical lesson is smaller than the numbers suggest: conditional requests with `ETag` are free — *"Making a conditional request does not count against your primary rate limit if a 304 response is returned"* (**verified**) — and Zeros today has **zero** rate-limit awareness anywhere (no `x-ratelimit-remaining`, no `retry-after`, no throttling plugin), while one active workspace with live CI issues roughly 1,600 REST calls/hour against the same budget the agents' own `gh` commands consume.

### 4.1 Why three separate slots, not one

Storing the three in **separate slots** is what makes the picker honest: switching method must not destroy the other credential, and today's single slot plus a non-durable `viaCli` boolean cannot represent this.

Today's shape, confirmed: one safeStorage account `"github_oauth"` whose literal name is duplicated across three files (`electron/main.ts:1116`, `electron/sidecar.ts:1520`, `electron/ipc/commands/github.ts:38` — the last carrying the comment "the two MUST stay in sync"); `TokenStore` is `{ get(): Promise<string|null>; set(token: string); clear() }` with no method, scope, expiry or installation id (`src/engine/git/github.ts:101`); the wire messages carry a bare `token: string | null`; the renderer's `GithubConnection` is `{ login, viaCli, ghAvailable }` in an in-memory `KeyedAsyncCache(1)` (`src/zeros/store/read-caches.ts:21-22`, `:49`) with a 60 s freshness window (`:31`).

The consequences of one slot are not hypothetical; four of them are confirmed findings:

- **Sign-out is a no-op for gh users, via two independent re-adoption sites.** The panel's post-sign-out `refresh()` re-enters `detectGhCli()`, which does not merely detect — it *persists* (`src/engine/git/github.ts:249`); and the engine re-adopts the gh login on **every boot** when the host couriered no token (`src/engine/index.ts:1138-1148`). Fixing the panel alone would not make sign-out stick.
- **Silent identity swap.** When a PAT is cleared (including by a transient 403), the fetcher falls through to `detectGhCli()` and adopts whatever `gh auth token` returns — often a different account with broader `repo` scope — and reports it as healthy. The headline text does change, so it is not invisible to someone staring at Settings; what is absent is any consent prompt, any "your token expired" notice, and any signal outside the panel.
- **A read mutates the active credential.** `detectGhCli()` writes the store with no compare-and-swap from a *read* path, so a PAT saved inside the window between `gh auth token` starting and `tokenStore.set` landing is overwritten. The window is narrow (after an explicit sign-out or a manual refresh while signed out) but it is exactly the window the new picker will live in.
- **The method is never persisted.** `viaCli` is sourced from the previous in-memory snapshot (`previous?.viaCli ?? false`), so after a restart a gh-CLI user renders as "Connected to GitHub" **permanently** — the authenticated branch never calls `detectGhCli()` again, so no amount of Refresh fixes it.

The teardown shows Conductor solved this by persisting the method *with* the credential as a zod discriminated union (`{ authMethod: "pat", token }` | `{ authMethod: "conductor-app", appClientId, token, expiresAt? }`), with `gh CLI` **absent from the union** because under that method nothing is stored. Zeros should adopt the same shape.

---

## 5. The storage model

Four stores, with a hard rule per store. The rule that governs all of them is already written down: *"no secret value is ever written to any settings.toml"* (`docs/home-tab-and-settings-ia-2026-07-15.md:113-119`).

| Store | Holds | Owner | Never holds |
|---|---|---|---|
| `~/.zeros/settings.toml` `[github]` | `auth_method`, and nothing else | engine (settings layer) | any token, any installation id |
| safeStorage `secrets.json` | three independent credential slots | **Electron main only** | installation metadata |
| engine SQLite `zeros.db` | non-secret installation metadata, revalidated | engine | any token |
| `backend/` Postgres | App client secret, App private key, PKCE verifiers, installation↔team links, audit rows | backend | user PATs |

### 5.1 The settings.toml key

```toml
[github]
auth_method = "zeros-app"   # "gh-cli" | "zeros-app" | "pat"; absent = no method selected
```

Implementation is a copy of the shipped provider-auth path, not a new mechanism:

1. Add `github: githubSchema.optional()` to `userSettingsSchema` (`src/engine/settings/schema.ts:311`) with `GITHUB_AUTH_METHODS = ["gh-cli", "zeros-app", "pat"] as const` beside the existing `PROVIDER_AUTH_METHODS` (`:23`).
2. List `"github"` in `USER_ONLY_KEYS` (`:359`) — like `providers`, this is per-user and per-machine, and a committed repo file must never reconfigure a teammate's credential.
3. Add `github: githubSchema.shape` to `TABLE_SHAPES` (`:522`) so a partial TOML table validates per-leaf.
4. Mirror through the exact `provider-prefs` shape: a synchronous localStorage read cache (`src/native/settings.ts:13`, `:32`) plus a fire-and-forget `bridgeSettingsWrite(bridge, "user", { github: { auth_method } })` write-through (`src/zeros/panels/provider-prefs.ts:73-83`). The synchronous read is what lets the radio restore in the destination's **first render**, which `RULES.md:294-297` requires of every durable selection.

The absent key is meaningful and must stay distinguishable from `"none"`: absent = "never chosen, infer" (§13); an explicit disconnect writes… also absent — with a companion `github.disconnected_at` timestamp so the inference in §13 does not re-run and silently re-adopt gh. This is the one place the spec is under-determined and this document makes a call: **an explicit disconnect must be durable, and the only way to make it durable against the engine's boot-time adopter (`src/engine/index.ts:1138-1148`) is a positive marker.**

### 5.2 The three safeStorage slots

```
github.app.userToken     ← GitHub App user access token, 8 h
github.app.refreshToken  ← GitHub App refresh token, 6 mo, single-use
github.pat               ← user-pasted PAT
(github_oauth)           ← legacy single slot, read-only after migration, deleted at the end of §13
```

Rules:

- **All four are main-process-only.** They must be **denied** by `isRendererKeychainAccount()` (`electron/keychain-accounts.ts`), exactly as `github_oauth` is today. There is a live trap here: `"github-pat"` is already in that file's renderer-allowlisted `VENDOR_ACCOUNTS` set (`electron/keychain-accounts.ts:33`, mirroring `SECRET_ACCOUNTS.GITHUB_PAT` at `src/native/secrets.ts:73`) — a **dead slot with no reader or writer anywhere in the tree**. Naming the new PAT slot `github.pat` (dot, not hyphen) avoids the collision; the dead `github-pat` entry should be removed from both files in the same change, or a renderer XSS gains write access to a credential the broker will happily serve to git.
- **Field width ≥ 600 characters, everywhere.** As of the staged rollout beginning 2026-04-27, installation tokens use a stateless `ghs_APPID_JWT` format: **~520 characters of variable length, containing dots** (**verified**). Every storage field, every wire schema `z.string().max(...)`, and every `ghs_[A-Za-z0-9]{36}`-style regex or 40-char length assumption must go. Also update `check:secrets`, which does not currently know the `ghs_` / `ghu_` / `ghr_` prefixes a GitHub App mints.
- **The single-writer lock is now load-bearing.** `withSecretsLock` proceeds **unlocked** after a 5 s timeout and then does a whole-file read-modify-write. That is safe today only because "mutations are rare (login only)" — a premise a 1-hour installation token destroys. Refresh must either serialise through one queue in main or the lock must stop proceeding-on-timeout for these accounts.
- **Refresh-token rotation must be crash-safe.** GitHub's refresh is **single-use with no grace period**: the moment a refresh succeeds, both the old refresh token and the old access token stop working (**verified**). Persist the new pair *before* discarding the old, or a crash mid-refresh forces a full re-auth.
- **Do not over-claim what safeStorage buys.** It is Chromium OSCrypt; on macOS the async and sync paths are both AES-128-CBC with a fixed IV (`kFixedIvForAes128Cbc`), so it is confidentiality-only and not integrity-protected (**likely**). Its guarantee is inter-app, not intra-app: *"child processes of the same app, dynamically loaded libraries, and injected code are all treated as the app itself"* (**likely**) — a malicious npm dependency in the main process can decrypt silently. This is a positive argument for short-lived credentials, not a reason to skip safeStorage.

### 5.3 The SQLite metadata table

Non-secret installation metadata goes in `zeros.db` as **migration version 24** (the list is append-only and currently ends at 23 — `src/engine/db/migrations.ts:706`, `:814`). It is a **cache with a verdict timestamp**, not a source of truth: revalidated on settings open and on any 403/404, and never used to gate an operation on its own.

```sql
-- migration 24: github_installations (non-secret installation metadata cache)
CREATE TABLE github_installations (
  installation_id   INTEGER PRIMARY KEY,   -- GitHub's numeric installation id
  app_variant       TEXT    NOT NULL,      -- 'github.com' | 'ghes:<hostname>'
  account_login     TEXT    NOT NULL,
  account_type      TEXT    NOT NULL,      -- 'User' | 'Organization'
  target_type       TEXT    NOT NULL,
  repository_count  INTEGER,               -- NULL = unknown (not 0)
  repository_names  TEXT,                  -- JSON array; NULL = 'all repositories'
  all_repositories  INTEGER NOT NULL DEFAULT 0,  -- 1 = installation grants all repos
  suspended_at      TEXT,                  -- ISO8601; non-null = suspended
  created_at        TEXT    NOT NULL,
  last_verified_at  TEXT    NOT NULL       -- when a probe last confirmed this row
);
CREATE INDEX idx_github_installations_login ON github_installations(account_login);
```

Three deliberate choices. `repository_count` is nullable because "unknown" must not render as "0 repositories accessible" — the confirmed cold-cache bug in the current card is exactly this class of error (`ghAvailable = data?.ghAvailable ?? false` renders the fabricated string "GitHub CLI not found" for an installed, logged-in `gh`). `all_repositories` is a separate boolean rather than `repository_names IS NULL`, because those two states differ. `app_variant` exists from day one so GHES is a config row rather than a fork — the teardown found `{ key, label, clientId, appSlug }[]` in Conductor's bundle, i.e. **multiple App variants supported at once**.

**No credentials in SQLite, ever.** The teardown confirms Conductor does the same: the only git-related table in its 2.98 GB `conductor.db` is `repos` (repo *config*), with no credentials and no installation rows; credentials live in the macOS Keychain under service `com.conductor.app.production.settings` — note the per-channel qualifier, the same split Zeros uses for `secrets.json`.

### 5.4 What the broker holds, in memory only

Per-context token entries are **never persisted**. The teardown's observed shape is the right one:

```ts
{ token, expiresAtMs, refreshUserId, tokenSha256,
  validity: "unknown" | "invalid",
  lastRefreshAttemptAtMs, lastRefreshCompletedAtMs }
```

`tokenSha256` is what makes `report-failure` idempotent: a shim reporting a 401 against a fingerprint the broker has already rotated past is a stale retry, not a fresh failure. Never log the token; log the fingerprint. Conductor's log redaction replaces matches with `[REDACTED_GITHUB_TOKEN]` and it shipped a specific fix for the new format — 0.76.1 "GitHub App installation tokens in the new JWT format are now fully redacted from logs" (**verified**) — which is a free lesson: the `ghs_APPID_JWT` format broke somebody's redaction regex in production.

---

## 6. The interfaces

These are the full type definitions the rest of the document refers to. They replace `TokenStore` (`src/engine/git/github.ts:101`) and `GithubConnection` (`src/zeros/store/read-caches.ts:19-23`).

### 6.1 The credential record

```ts
// packages/core/src/github-auth.ts — shared by renderer, main, engine, backend client.

export const GITHUB_AUTH_METHODS = ["gh-cli", "zeros-app", "pat"] as const;
export type GithubAuthMethod = (typeof GITHUB_AUTH_METHODS)[number];

/** Which App registration a credential belongs to. One row per host so GHES is
 *  configuration, not a fork. Mirrors Conductor's observed
 *  `{ key, label, clientId, appSlug }[]` variants array. */
export interface GithubAppVariant {
  key: string;            // "github.com" | "ghes:git.acme.dev"
  label: string;          // "GitHub.com" | "Acme Enterprise"
  clientId: string;       // Iv1.* / Ov23* — a public identifier, not a secret
  appSlug: string;        // for github.com/apps/<slug>/installations/new
  hostname: string;       // "github.com" | "git.acme.dev"
  apiBaseUrl: string;     // "https://api.github.com" | "https://git.acme.dev/api/v3"
}

/** The persisted credential. A discriminated union on the method, so the method
 *  is a property of the stored value rather than a per-session guess.
 *  `gh-cli` carries no secret: nothing is stored under that method. */
export type GithubCredential =
  | { method: "gh-cli" }
  | { method: "pat"; token: string; tokenKind: "classic" | "fine-grained" | "unknown";
      expiresAt?: string }
  | { method: "zeros-app"; appVariantKey: string; clientId: string;
      accessToken: string; accessTokenExpiresAt: string;   // ISO8601, ~now+8h
      refreshToken: string; refreshTokenExpiresAt: string; // ISO8601, ~now+6mo
      login: string };

/** Replaces TokenStore. Slot-addressed so selecting a method never destroys
 *  another method's credential. Implemented in Electron main over safeStorage;
 *  the engine holds an in-memory working copy of the ACTIVE record only. */
export interface CredentialStore {
  getSelectedMethod(): Promise<GithubAuthMethod | null>;
  setSelectedMethod(m: GithubAuthMethod | null): Promise<void>;
  get(method: GithubAuthMethod): Promise<GithubCredential | null>;
  set(cred: GithubCredential): Promise<void>;
  /** Clears ONE slot. There is no clear-everything. */
  clear(method: GithubAuthMethod): Promise<void>;
}
```

### 6.2 Health, installations, and the UI's read model

```ts
export interface GithubInstallation {
  installationId: number;
  appVariantKey: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  targetType: string;
  /** null = unknown. NEVER default to 0 — "0 repositories" is a different claim. */
  repositoryCount: number | null;
  /** null = the installation grants ALL repositories. */
  repositoryNames: string[] | null;
  allRepositories: boolean;
  suspendedAt: string | null;
  createdAt: string;
  lastVerifiedAt: string;
}

/** Why a method is not usable right now. Every member maps to exactly one
 *  Phase-0 error code, and NONE of them clears a credential except
 *  `credential-invalid`. */
export type GithubHealthProblem =
  | { kind: "credential-invalid" }                                  // 401 only
  | { kind: "rate-limited"; retryAtMs: number }                     // 403/429
  | { kind: "sso-required"; organizations: string[]; authorizeUrl?: string }
  | { kind: "forbidden-scope"; requiredPermissions: string[] }      // X-Accepted-GitHub-Permissions
  | { kind: "repo-not-installed"; owner: string; repo: string }
  | { kind: "installation-suspended"; installationId: number }
  | { kind: "org-approval-pending"; accountLogin?: string }
  | { kind: "gh-cli-absent" }
  | { kind: "gh-cli-not-logged-in" }
  | { kind: "gh-cli-no-git-helper" }        // `gh auth token` works, push helper missing
  | { kind: "expiring-soon"; expiresAt: string }
  | { kind: "expired"; expiredAt: string }
  | { kind: "unreachable"; message: string };  // network / API outage: retain last good

/** One row of the picker. `state: "unknown"` is NOT "unavailable" — a cold
 *  cache must never render negative capability copy (RULES.md:298-300). */
export interface GithubMethodHealth {
  method: GithubAuthMethod;
  state: "unknown" | "probing" | "available" | "connected" | "degraded" | "problem";
  login: string | null;
  avatarUrl: string | null;
  /** True only if a real credential proved it can push, not merely call /user. */
  pushVerified: boolean;
  installations: GithubInstallation[];
  problem: GithubHealthProblem | null;
  cloudCapable: boolean;      // gh-cli: false. pat: true but warned. zeros-app: true.
  lastVerifiedAt: string | null;
}

export interface GithubConnectionState {
  selected: GithubAuthMethod | null;
  disconnectedAt: string | null;
  methods: Record<GithubAuthMethod, GithubMethodHealth>;
}
```

Two notes on `pushVerified`. First, it exists because "Connected to GitHub" today only proves the token can call `/user` — which any zero-scope token can do. That is a claim about *identity*, never about *capability*, and it is the reason a green badge sits over a dead push path. Second, an "All repositories accessible" readout must be computed from **what the minted token can actually reach**, not from the App's declared permissions. Cursor is the worked example: its cloud agent's installation token is minted **narrower** than the app's granted permissions, so `git push` succeeds while `POST /issues` returns 403 `Resource not accessible by integration` even though the org granted Issues: Read & write — Cursor staff confirmed this as a known limitation (**likely**, [forum thread 163389](https://forum.cursor.com/t/cloud-agent-gh-git-token-missing-issues-write-despite-github-app-being-granted-issues-read-write/163389)).

### 6.3 The credential broker

```ts
// src/engine/git/credential-broker.ts — owned by the engine.

export interface GitCredential {
  username: string;      // "x-access-token" | "oauth2" | "x-token-auth" | …
  password: string;
  expiresAtMs?: number;
}

export interface CredentialBroker {
  /** Per-invocation env for any git/gh child process. */
  envForContext(contextId: string, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Extra `-c` args, host-scoped so no credential is offered to a foreign remote. */
  gitConfigArgsForHost(host: string): string[];
  setCredential(contextId: string, host: string, cred: GitCredential | null): void;
  close(): Promise<void>;
}

/** A context is "one workspace's git identity for one host". Cloud sandboxes use
 *  the same type with a sentinel refresh user — Conductor's observed
 *  `__conductor_workspace_owner__`. */
export interface BrokerContext {
  contextId: string;               // workspaceId, or "sandbox:<id>"
  host: string;                    // "github.com" | "gitlab.com" | …
  refreshUserId: string;           // or "__zeros_workspace_owner__"
  method: GithubAuthMethod;
}

/** In-memory only. Never persisted, never logged. */
interface BrokerTokenEntry {
  token: string;
  expiresAtMs?: number;
  tokenSha256: string;
  validity: "unknown" | "invalid";
  lastRefreshAttemptAtMs?: number;
  lastRefreshCompletedAtMs?: number;
}

export const BROKER_REFRESH_LEAD_MS = 60_000;   // refresh at T-60s
```

### 6.4 Wire messages

The current `GITHUB_TOKEN_SET` / `GITHUB_TOKEN_CHANGED` pair carries a bare `token: string | null`, and `GITHUB_TOKEN_CHANGED` carries the **plaintext token value** to local clients including the renderer (`src/engine/index.ts:1109-1117`, `:1112`) — which contradicts the stated H4 invariant in `src/zeros/bridge/github-token-sync.ts:10-12`. Verification narrowed the exposure (only the zero-config boot adopt broadcasts a non-null value, and the writeback consumer ignores non-null anyway) but the fix is a one-liner and belongs in this change:

```ts
/** engine → host. Carries NO secret. The host re-reads or re-mints. */
export interface GithubCredentialChangedMessage {
  type: "GITHUB_CREDENTIAL_CHANGED";
  source: "engine";
  method: GithubAuthMethod;
  reason: "invalidated" | "refreshed" | "adopted" | "cleared";
  login?: string;
}

/** host → engine. Seeds/rotates the engine's in-memory working copy.
 *  MUST be accepted from cloud peers too — see §11.1. */
export interface GithubCredentialSetMessage {
  type: "GITHUB_CREDENTIAL_SET";
  source: "host";
  credential: GithubCredential | null;
  /** For a sandbox: the pre-minted installation token and its expiry. */
  installationToken?: { token: string; expiresAt: string; installationId: number;
                        repositoryIds: number[] };
}
```

---

## 7. The credential broker — the one new mechanism

`src/engine/git/credential-broker.ts`, owned by the engine. This is the single most important new component, and it is the piece Zeros is missing outright. The teardown found Conductor's equivalent under the logger tag `github-auth-broker`: a local HTTP server on a unix socket, with shims injected into every git/gh child process.

### 7.1 The transport path, local and cloud

```mermaid
flowchart LR
  BE["backend/<br/>client secret + App private key"]
  GH["github.com"]

  subgraph MAC["Mac — local workspace"]
    ENG["engine"]
    BRK["credential broker<br/>unix socket, GET only"]
    SH["helpersDir shims<br/>git · gh · git-askpass"]
    GIT["real git / gh via<br/>ZEROS_REAL_GIT_PATH<br/>ZEROS_REAL_GH_PATH"]
    AG["agent child process<br/>runs its own git / gh"]
    ENG -->|"runGit + envForContext"| SH
    AG -->|"PATH-shimmed"| SH
    SH -->|"GET /credential?context+host"| BRK
    SH -->|"exec"| GIT
  end

  subgraph SBX["Vercel or Daytona sandbox — cloud workspace"]
    SENG["sandbox engine"]
    SBRK["same broker code,<br/>different socket"]
    SSHIM["/zeros/bin shims"]
    SENG --> SSHIM
    SSHIM -->|"GET /credential"| SBRK
  end

  BRK -.->|"refresh user token at T-60s"| BE
  SBRK -.->|"mint / re-mint 1 h installation token"| BE
  GIT -->|"https Basic x-access-token:TOKEN"| GH
  SSHIM -->|"https Basic x-access-token:TOKEN"| GH
  BE -->|"POST /app/installations/:id/access_tokens<br/>repository_ids-scoped"| GH
```

The two halves are deliberately the *same code*. Conductor's constant `Vtr = "/conductor/bin"` is the in-sandbox helpers dir, i.e. the identical shim mechanism runs inside the rented sandbox; `P1t = "__conductor_workspace_owner__"` is the sentinel refresh-user id for when the sandbox itself needs a token.

### 7.2 Socket API

HTTP over a unix socket, `GET` only, everything else 404 (non-`GET` → 404 is observed behaviour in Conductor's broker, and it is the right default: the socket is reachable by anything running as the user).

| Route | Purpose |
|---|---|
| `GET /credential?context=<id>&host=<host>` | serve `username` + `password`, refreshing first if within 60 s of expiry |
| `GET /report-failure?context=<id>&failedTokenSha256=<sha>` | a shim saw a 401 → force-refresh and return the new credential |
| `GET /pr-created?context=<id>` | the `gh` shim reports a successful `gh pr create` so the UI updates without polling |

`/pr-created` is not decoration. Today the agent's PR "never touches the engine", so `useWorkspacePrSync` exists solely to backfill the PR number afterwards by polling. A shim callback replaces a poll with an event.

Emit the same telemetry surface the teardown observed, because these six events are exactly the ones you need to debug a credential incident: `token_set`, `token_updated`, `token_cleared`, `token_failure_reported`, `token_refreshed_after_failure`, `token_served_after_refresh_failed`. Zeros currently has **zero** GitHub telemetry — `trackGitOp`'s `pr_create`/`pr_merge`/`pr_mark_ready`/`pr_update` enum members have no call sites at all.

### 7.3 Injection, per invocation

```ts
const args = [
  "-c", "credential.helper=",                                  // reset inherited helpers
  "-c", `credential.https://${host}.helper=${shimPath}`,        // host-scoped, ours only
  ...gitArgs,
];
const env = {
  ...process.env,
  ZEROS_GIT_AUTH_CONTEXT: contextId,
  ZEROS_GIT_AUTH_SOCKET:  socketPath,
  ZEROS_REAL_GIT_PATH:    realGit,
  ZEROS_REAL_GH_PATH:     realGh,
  GIT_ASKPASS:            askpassShim,
  GIT_TERMINAL_PROMPT:    "0",
  PATH:                   `${helpersDir}:${process.env.PATH}`,
};
```

### 7.4 Load-bearing details, all verified

- **`credential.helper=` with an empty value resets the helper list** (`gitcredentials(7)`, git ≥ 2.9). Verified on git 2.50.1: it clears both `credential.helper` and URL-scoped `credential.<url>.helper` from user config, and bypasses `GIT_ASKPASS` when the helper returns both username and password. This is what stops a user's stale `osxkeychain` or `gh` helper from silently winning. Note the override covers **credential helpers only** — `url.<base>.insteadOf`, `http.proxy` and `http.extraHeader` from user config still apply, and `-c` propagation has known gaps for git-lfs and recursive submodules.
- **Host-scoping is a security requirement, not tidiness.** An unscoped helper offers the GitHub credential to *every* remote, including an attacker-controlled one in a malicious repo's `.gitmodules`.
- **`GIT_TERMINAL_PROMPT=0` converts today's hang-or-cryptic-failure into a fast, classifiable error.** This was measured, not assumed: with a controlling tty and no askpass/helper, `git ls-remote` printed `Username for 'http://…':` and **hung until killed** (rc=124); with no tty it failed immediately with `could not read Username … No such device or address`; with `GIT_TERMINAL_PROMPT=0` it failed immediately with `terminal prompts disabled`. `GIT_TERMINAL_PROMPT` appears **nowhere** in `src/`, `electron/`, `backend/` or `docs/` today, and `push`/`pull`/`fetch`/`clone` pass no `timeoutMs`, so a dev run launched from a terminal can wedge a workspace RPC indefinitely.
- **PATH-shimming `git` and `gh` is what fixes B3 without rewriting the agent flow.** The agent's own `gh pr create` and `git push` in the PTY get brokered credentials. The verifier corrected the *mechanism* here in a way that matters: agents get **piped stdio, not a PTY** (`stdio-process.ts:63,68`, detached/setsid), and there is no controlling tty anywhere in the chain, so git cannot block on `/dev/tty` — but the agent's credential resolution is nonetheless **identical** to `runGit`'s (both inherit `process.env` with no credential injection). The conclusion stands and sharpens: a credential injected only via `runGit`'s per-invocation `env` will **not** reach the agent. It must be a helper/gitconfig entry plus something for `gh`, installed where both see it.
- **The `GIT_ASKPASS` denylist is a real collision to design around, not a detail.** `GIT_ASKPASS` is class-1 code-injection in Zeros' own env classifier (`src/engine/settings/env-names.ts:70`, with the comment "git runs GIT_ASKPASS on any HTTPS fetch/push/clone"), dropped from every settings layer including `user`, and `mergeSpawnEnv` merges settings env **under** caller env (`src/engine/settings/spawn-env.ts:282`). So the broker must set `GIT_ASKPASS` from **trusted engine-controlled code on the spawn path**, and the denylist must keep applying to caller/relay/settings-supplied env. Conveniently the whole `ZEROS_*` prefix is already blocked from settings env, so `ZEROS_GIT_AUTH_SOCKET` and `ZEROS_GIT_AUTH_CONTEXT` cannot be spoofed through a repo's settings file.
- **Tokens are opaque.** `ghs_APPID_JWT`, ~520 chars, variable length, containing dots. Storage ≥ 600 chars; delete every prefix/length regex.
- **On refresh failure, serve the stale token anyway and say so.** Conductor logs `"Serving existing GitHub token after refresh failed; downstream git/gh may see 401"`. That is the right behaviour: a stale token that might still work beats a hard failure, provided the log names the risk.
- **A native alternative exists and should be used where it helps.** Since git 2.40 the credential protocol carries `password_expiry_utc`, and since 2.41 `oauth_refresh_token`; `git credential fill` ignores an expired password when reading from helpers (**verified**, [git-credential docs](https://git-scm.com/docs/git-credential)). Declaring expiry from the shim means git itself will ask again rather than reuse a stale credential. Since git 2.46 a helper can also be re-consulted after a 401 on an already-authenticated request, but only if it advertises `capability[]=state` and returns `continue=1` — worth knowing, not worth depending on, since Zeros must support whatever git the user has.

### 7.5 What the broker does *not* do

It does not hold the App private key, it does not perform the OAuth code exchange, and it does not persist anything. Those three all live in `backend/`. The broker's entire job is: given a context and a host, return a credential that works right now, and refresh it when it won't.

---

## 8. The Zeros GitHub App specification

- **Public**, not private. Conductor's `conductor-build` is a *private* GitHub App — its landing page renders as "a private GitHub App" and it is not on the Marketplace (**verified**) — which per GitHub's docs can only be installed on the account that owns it, consistent with their driving installation from inside the app. Zeros needs any user or org to install, so ours must be public.
- **Permissions, each justified — do not over-request.** GitHub's own guidance and every competitor's published table converge on the principle; the specific asks are:

| Permission | Level | Why |
|---|---|---|
| Contents | Read & write | clone/fetch needs read; **push needs write** |
| Pull requests | Read & write | open/update/merge/comment |
| Metadata | Read | mandatory |
| Checks | Read | the PR status island |
| Commit statuses | Read | legacy status API still used by many CIs |
| Workflows | Write | **required to push any change under `.github/workflows/`** — a coding agent will hit this |

For calibration: Vercel ships a GitHub-App-only integration and publishes its table (Administration, Checks, Contents, Deployments, Pull Requests, Issues, Metadata, Web Hooks) (**verified**). Cursor requests **eight** permission groups including Administration and Custom repository roles (**verified**). Claude Code's App is Contents R&W, Pull requests R&W, Workflows R&W, Metadata RO, Members RO (**verified**). Conductor's set is **unpublished and we could not establish it** — an HN commenter asked for exactly this and was never answered, and the Tauri webview assets that would carry it are compressed inside the Rust binary. Zeros' list above is narrower than Cursor's and Vercel's, and the closest match to Claude Code's.

- **"Request user authorization (OAuth) during installation": on.** This is what makes install and sign-in one gesture instead of two.
- **"Expiring user authorization tokens": on** (8 h access + 6 mo refresh, **verified**: `expires_in` is always 28800, `refresh_token_expires_in` always 15897600). Note the 6 months is not a hard re-auth ceiling — each refresh returns a new refresh token, so the practical re-consent trigger is **six months of app inactivity**, not six months elapsed (**verified**).
- **"Enable Device Flow": on** — the no-backend fallback. Off by default; forgetting it yields a 400 (§2.2).
- **Setup URL** must be set and must tolerate the approval path: when org approval is required GitHub redirects with `setup_action=request`, **no `installation_id`**, no request identifier, and **`state` is not preserved** (**verified**). GitHub's docs also warn that `installation_id` on the setup URL **can be spoofed** and must not be trusted — you must mint a user access token and verify the installation belongs to that user (**verified**).
- **Webhooks:** `installation`, `installation_repositories`. Phase 1 may poll instead; phase 2 adds the endpoint so "which repos" stays fresh without a poll. Both events are **App-only** (`availability: app`) (**verified**). Note the current backend cannot host a webhook without a change: every `/v1/*` path sits behind the Auth0 JWT middleware (`backend/src/index.ts:56`), so an unauthenticated raw-body signature-verified route must be added *outside* that prefix.
- **Down-scoping a minted token:** `repositories` (names) and `repository_ids` (IDs) accept up to **500** and are **mutually exclusive** — send one or the other (**verified**). 500 is an upper bound, not a guarantee: with `permissions` also scoped down and the app installed on a subset of an org's repos, GitHub applies a token "complexity" limit and may reject with "Too many repositories for installation" **below** 500, reporting the real maximum. Never wider than the installation grant; the same rule applies to `permissions`.
- **App variants from day one.** `GithubAppVariant[]` (§6.1) with github.com registered and GHES designed-for-but-unregistered. GHES uses host-relative endpoints and a different install path shape (`/github-apps/{slug}/installations/new` rather than `/apps/{slug}/installations/new`), while GHE.com data residency uses the github.com shape — mis-detecting this shipped as a real 404 bug in Coolify (**verified**). GHES organizations also "cannot install GitHub Apps registered on GitHub.com" — each instance needs its own registration (**likely**).

### 8.1 Bot identity and commit attribution

`gitIdentity: { name, email }` is passed explicitly so commits are attributed to the human, not to the App's bot identity. This is a configured input, not a side effect — the teardown found Conductor doing exactly this in its sandbox-creation payload.

The mechanics matter because a plausible-sounding shortcut is wrong. Commits pushed **with** an installation token are **not** attributed to the bot by virtue of the token — the token is only a push credential, and GitHub links a commit to a profile purely by matching the author/committer **email** (**likely**). Auto-attribution to `<app-slug>[bot]` happens only for commits created through the REST/GraphQL APIs (Contents API, `createCommitOnBranch`), which are additionally **server-signed and shown as Verified** (**likely**). So: for git-CLI pushes, set the identity yourself. If Zeros ever wants a bot-authored commit, the correct email is `{BOT_USER_ID}+{bot-login}@users.noreply.github.com` where `BOT_USER_ID` is the `id` from `https://api.github.com/users/<app-slug>%5Bbot%5D` — URL-encoded brackets; unencoded brackets 404, which was the cause of [actions/create-github-app-token#172](https://github.com/actions/create-github-app-token/issues/172). Read `login` from that response rather than string-building `<slug>[bot]`, because they differ (app slug `copilot-swe-agent` has login `Copilot`).

The field splits on this question, which is why it must be a setting rather than a default: Copilot, Devin and Factory commit as a bot ("commits are authored by Copilot, with the human who started the task marked as the co-author", signed and Verified, pushes only to `copilot/*`, **verified**); Anthropic's Auto-fix deliberately goes the other way, posting "using your GitHub account, so they appear under your username" (**verified**), and documents the resulting hazard that this can trigger `issue_comment` automation like Atlantis.

---

## 9. The install / consent sequence

The consent screen is **always** the system browser, never a `BrowserWindow`. RFC 8252 §8.12 is categorical: *"native apps MUST NOT use embedded user-agents to perform authorization requests"*, because a host app embedding a webview "can record every keystroke… to capture usernames and passwords" and "copy session cookies" (**verified**). Open it with `shell.openExternal`.

```mermaid
sequenceDiagram
    autonumber
    participant R as Renderer (Settings)
    participant M as Electron main
    participant B as backend/ (Hono)
    participant BR as System browser
    participant GH as github.com
    participant E as Engine + broker

    R->>M: gh_app_connect_begin()
    M->>M: mint nonce (single-use, in-memory)
    M->>B: POST /v1/github/oauth/start {nonce}<br/>Authorization: Auth0 JWT
    B->>B: mint state + PKCE verifier (S256),<br/>store server-side keyed by state, 10 min TTL
    B-->>M: {authorizeUrl, state}
    M->>BR: shell.openExternal(authorizeUrl)
    BR->>GH: GET /login/oauth/authorize<br/>client_id, state, code_challenge=S256
    GH->>BR: consent + "install on which account /<br/>which repositories?"
    Note over BR,GH: three possible buttons:<br/>Install · Install and request · Request
    BR->>B: GET /v1/github/oauth/callback?code&state<br/>(&installation_id&setup_action)
    B->>GH: POST /login/oauth/access_token<br/>code + code_verifier + CLIENT_SECRET
    GH-->>B: {access_token 8h, refresh_token 6mo,<br/>expires_in 28800}
    B->>B: bind tokens to a one-time nonce, 60 s TTL<br/>verify the installation belongs to this user
    B-->>BR: 302 zeros://github/connected?nonce=…
    BR->>M: OS deep-link (per-channel scheme)
    M->>M: match nonce — if it belongs to a sibling<br/>worktree, peek + complete (auth_peek_handoff)
    M->>B: POST /v1/github/oauth/exchange {nonce}<br/>Authorization: Auth0 JWT
    B-->>M: {accessToken, expiresAt, refreshToken, login}
    M->>M: safeStorage: github.app.userToken/.refreshToken<br/>settings.toml: [github] auth_method="zeros-app"
    M->>B: GET /v1/github/installations
    B-->>M: installations[] (id, login, targetType,<br/>suspendedAt, repoCount, repoNames)
    M->>E: GITHUB_CREDENTIAL_SET (stdin control line)
    E->>E: broker.setCredential(ctx, "github.com", …)
    E-->>R: GITHUB_CREDENTIAL_CHANGED {adopted, login}
    R->>R: render "Connected as @login ·<br/>All repositories accessible."
```

### 9.1 Why the callback lands on the backend, not on the app

The redirect target is the **backend**, which then hands control back via the registered `zeros://` scheme with a **one-time nonce**. Three things follow:

1. The `client_secret` is used only where it lives. The app never sees it.
2. Custom-scheme hijacking is mitigated because the scheme carries only a single-use nonce, not a token, and the nonce is bound to the `state`. This is the same reasoning already written into the shipped Auth0 handoff, where the ticket is documented as "OPAQUE, single-use, short-TTL… NOT a token" and "an intercepted ticket is useless: the attacker lacks the verifier, which never left this process".
3. `installUrl` is **server-built**, matching the teardown's observation that Conductor's backend hands the client an `{ installUrl }` rather than the client constructing it. That keeps the app-slug, the variant selection and any `?state=` correlation in one place, and it is what makes GHES a config row.

### 9.2 The three install buttons, and the approval black hole

GitHub renders one of three buttons depending on how much of the requested access needs org-owner approval: **Install** (none), **Install and request** (some), **Request** (all) (**verified**). Org members who cannot install can still select the org; GitHub notifies the owner instead of installing.

The approval path is a genuine black hole and the UI must be honest about it:

- The setup URL gets `setup_action=request`, **no `installation_id`**, **no request identifier**, and **`state` is dropped** (**verified**).
- The only enumeration endpoint is `GET /app/installation-requests`, whose documented auth is contradictory and which has been broken/confusing since 2023 (**likely**).
- There is a documented silent-failure mode where a non-owner requesting elevated repo permissions sees the installation tab disappear entirely (**likely**).

So the row state is `org-approval-pending` with copy that names the account and offers "Remind an owner ↗" — and it is reached by *timeout plus polling `GET /user/installations`*, not by a callback, because no callback carries enough information to identify the request.

### 9.3 Repo-scope repair without a browser round trip

Under-used escape hatch, worth building: `PUT /user/installations/{installation_id}/repositories/{repository_id}` adds a repo to an existing installation with a **user access token** (or classic PAT with `repo`), provided the user has **admin** on the repository; `DELETE` removes it and returns 422 if it would remove all access (**verified**). That turns the most common cloud-workspace failure — "this repo isn't in your installation" — from a browser detour into a one-click fix inside Zeros. Fall back to the documented deep links when the user lacks admin: `https://github.com/settings/installations/{id}` for a personal account, `https://github.com/organizations/{org}/settings/installations/{id}` for an org (**verified**).

---

## 10. Backend endpoints (`backend/src/github.ts`)

All routes sit under `/v1/*`, so they inherit the shipped middleware chain: CORS, a 256 KB body cap (`backend/src/index.ts:53`), Auth0 JWT verification (`:56`) and a 240-request/60 s per-user blanket limit (`:63`). Team scoping reuses `requireMembership` / `requireRole` (`backend/src/authz.ts:34`, `:51`) plus `FORCE ROW LEVEL SECURITY` (`backend/migrations/0004_rls_enforce.sql:59-64`). Every mint is audited.

| Method | Path | Request | Response | Authz |
|---|---|---|---|---|
| POST | `/v1/github/oauth/start` | `{ variantKey: string; nonce: string; installFlow?: boolean }` | `{ authorizeUrl: string; state: string }` | Auth0 JWT; user need not be in any team |
| GET | `/v1/github/oauth/callback` | query `code`, `state`, optional `installation_id`, `setup_action` | `302 → zeros://github/connected?nonce=…` (or `?error=…`) | **no JWT** — GitHub calls this; authorised by single-use `state` |
| POST | `/v1/github/oauth/exchange` | `{ nonce: string }` | `{ accessToken, expiresAt, refreshToken, refreshTokenExpiresAt, login, installations: GithubInstallation[] }` | Auth0 JWT; nonce single-use, 60 s TTL, bound to the same `sub` that called `/start` |
| POST | `/v1/github/oauth/refresh` | `{ refreshToken: string }` | `{ accessToken, expiresAt, refreshToken, refreshTokenExpiresAt }` | Auth0 JWT; rate-limited tighter than global |
| POST | `/v1/github/oauth/revoke` | `{ }` | `{ revoked: true }` | Auth0 JWT |
| GET | `/v1/github/install-url` | query `variantKey`, optional `state` | `{ installUrl: string }` | Auth0 JWT |
| GET | `/v1/github/installations` | — | `{ installations: GithubInstallation[] }` | Auth0 JWT; scoped to the caller's own user token |
| POST | `/v1/github/installations/:id/token` | `{ repositoryIds: number[]; permissions?: Record<string,"read"\|"write">; workspaceId: string; sandboxId: string }` | `{ token: string; expiresAt: string; permissions: Record<string,string>; repositorySelection: "selected" }` | **sandboxes only.** Caller must be a member of the workspace's team (`requireMembership`); `repositoryIds` must be a subset of the installation grant; **audited** |
| POST | `/v1/github/webhook` | raw body + `X-Hub-Signature-256` | `204` | **no JWT** — HMAC-verified; must live **outside** the `/v1/*` JWT middleware or be explicitly excepted. Phase 2. |

### 10.1 Authz rules, stated as invariants

1. **`/v1/github/installations/:id/token` is the only endpoint that mints a credential Zeros does not already hold**, and it is the only one that can widen blast radius. Its rules: `repositoryIds` non-empty and ≤ 500; every id must appear in the installation's granted set (re-read from GitHub, not from a cache); `permissions` never wider than the installation grant; one row in `audit_log` per mint carrying installation id, repository ids, workspace id and actor.
2. **`audit_log.team_id` is `NOT NULL`.** It was renamed from `org_id` in `backend/migrations/0006_org_to_team.sql:54` and the original column was `NOT NULL` (`backend/migrations/0001_init.sql:107-114`). A **personal** installation event therefore has nowhere to be recorded. Either the column becomes nullable or personal installations get a synthetic team; this must be decided before the first mint ships, because "we could not audit it" is not an acceptable answer for a token-minting endpoint.
3. **There is no secrets vault in the backend today.** The encrypted `org_secrets` table that would have held an App private key was dropped in `backend/migrations/0005_orgs_optional.sql:26`. The App private key should therefore live in the platform's secret manager (env-injected at boot), not in Postgres — which is the better answer anyway, and it means no migration is needed for phase 1.
4. **Nothing links a GitHub installation to a team.** Team semantics for installations are entirely unmodelled: `team_settings.doc` is plaintext and readable by any member, and users may belong to zero teams. Phase 1 keeps installations **per-user** and defers team-shared installations; the `linked: true` shape the teardown found in Conductor's bundle (`{ installationId } -> { linked: true }`) is the eventual target, not phase 1.
5. **PKCE verifiers are server-side only**, keyed by `state`, single-use, 10-minute TTL, deleted on use or expiry. The desktop never holds a verifier for the GitHub flow (unlike the Auth0 handoff, where main holds it, because there the *website* is the confidential client).

---

## 11. Cloud workspaces

- The sandbox gets a **1-hour installation token** for exactly its repository, delivered over the existing control connection, and the **same broker** runs inside the sandbox. Never a PAT, never a refresh token, never the private key.
- `gitIdentity: { name, email }` is passed explicitly so commits are attributed to the human, not to the App's bot identity (§8.1).
- **Expiry mid-run is the normal case, not an edge case.** A 6-hour agent run outlives a 1-hour token five times over. The broker's T−60 s proactive refresh plus 401-triggered refresh is the whole answer; without it the App method is unusable for cloud.
- Reference points: Vercel's own guide recommends **GitHub App installation tokens for multi-tenant platforms** (**verified**, §2.7). Claude Code's cloud sessions go further and keep GitHub credentials out of the sandbox entirely, proxying all operations — a strictly stronger posture and the phase-3 direction (§2.8). The industry split is clean: Codespaces, Gitpod/Ona, Coder, DevPod and every raw sandbox vendor put a real credential in the box but make it short-lived, repo-scoped, and delivered through a **credential helper / `GIT_ASKPASS` shim** rather than a baked-in env var — DevPod "does not copy tokens into the workspace: for HTTPS it exposes the host's credentials through a git credential helper injected over the connection" (**verified**); Gitpod/Ona exposes `gp credential-helper get` inside the workspace (**verified**).

### 11.1 Three shipped mechanisms actively block this, and all three must change

This is the part of the cloud design that is not additive. Each of these is confirmed in code:

| Blocker | Where | Fix |
|---|---|---|
| `GITHUB_TOKEN_SET` is accepted from **local clients only** — `if (client.kind === "local") seedGithubToken(msg.token)` — so the Mac, which is a `kind:"cloud"` peer to a sandbox engine, can **never** courier a token to a sandbox | `src/engine/index.ts:1778-1781` | `GITHUB_CREDENTIAL_SET` must be accepted from the *owner* peer, authenticated by the existing owner binding, not by `kind`. This is a security-relevant change and needs its own review: the gate exists for a reason (`OWNER_SIGNED_OUT` immediately below it is gated the same way, deliberately). |
| `ZEROS_GITHUB_TOKEN` is read **exactly once at boot** — `if (process.env.ZEROS_GITHUB_TOKEN !== undefined) seedGithubToken(...)` — so there is no re-mint channel for a 1-hour token | `src/engine/index.ts:1125-1127` | The env seed stays as a cold-start convenience; rotation arrives over the control channel and updates the broker in place. |
| `withAuthRetry` self-clears the credential on any auth error and notifies via `broadcastLocal`, so an expired installation token in a sandbox yields a permanently unauthenticated engine **that nobody is told about** | `src/engine/git/github.ts:497-501`; `src/engine/index.ts:1109-1117` | Phase 0's classifier split, plus a refresh attempt before any clear, plus the token-less `GITHUB_CREDENTIAL_CHANGED` message reaching the owner rather than only local clients. |

Two further facts about the current sandbox image make the gap worse than the local one: the image installs **no `gh` and no credential helper**, and the Phase-1 spike's `AGENT_CRED_ENV_VARS` allowlist deliberately contains **no GitHub variable at all**, so a sandbox today has zero repo credentials. The spike clones only the *public* zeros repo at image-bake time.

### 11.2 The sandbox-creation payload

The teardown's observed Conductor payload is a good template and its naming is worth copying verbatim, because it already anticipates the multi-forge problem:

```ts
{
  repoUrl, repoDefaultBranch?, branchInfo: { baseBranch, newBranchName },
  forgeAuth?: { gitForge: "github"; hostname?: string; token?: string }
            | { gitForge: "local-git" },
  gitIdentity?: { name?: string; email?: string },
  gitPullConfig?: { pullRebase?: boolean; pullFf?: boolean },
  filesToSync?: { path: string; content: string }[],
  provider?: "vercel",
}
```

`gitForge` with a `hostname` field already present for GHE is the right seam name for Zeros' GitLab/Bitbucket work. Zeros' version differs in one deliberate way: **no `ghToken` / `extraEnv.GH_TOKEN` field.** Conductor passes a token into the sandbox by those routes *as well as* running the broker in-box; Zeros passes only the initial installation token to the broker and never into the process environment, because an env var is readable by every agent in the box. That is not hypothetical caution — Anthropic documents exactly this leak in the opposite direction: if a user sets `GH_TOKEN` themselves, "it passes through to the container unchanged", and left unset it reads as the literal placeholder `proxy-injected` (**verified**).

### 11.3 Installation ≠ session access control

The single most important thing to get right in the copy. Anthropic states outright that a cloud session "can access any repository the connecting GitHub account can see, not just the repositories the Claude GitHub App is installed on… it is not a session-level access control" (**verified**). If Zeros advertises per-repo scoping, the scoping must be enforced by **what the backend mints** — an installation token for that installation, down-scoped to `repository_ids` — and must **never** silently fall back to the user token. A fallback would turn a truthful "3 of 12 repositories" into a lie.

---

## 12. The settings UI state machine

Two orthogonal machines: a **section-level selection** (durable, one value in `settings.toml`) and a **per-row health** machine (ephemeral, revalidated, one instance per method). The picker is honest only if these stay separate — today's card conflates them, which is why a 403 can move the user between methods.

```mermaid
stateDiagram-v2
    direction TB

    [*] --> Booting

    Booting --> Migrating: legacy github_oauth present<br/>and no auth_method key
    Booting --> NoMethod: no credential, no key
    Booting --> Selected: auth_method present —<br/>synchronous read, first render

    Migrating --> Selected: infer per section 13,<br/>then write auth_method
    Migrating --> NoMethod: inference impossible

    NoMethod --> Selected: user picks a row (SELECT)
    Selected --> Selected: user picks another row (SELECT)<br/>other slots untouched
    Selected --> Disconnected: Disconnect… (confirmed)
    Disconnected --> Selected: SELECT
    Disconnected --> [*]

    state Selected {
        direction TB
        [*] --> Unknown

        Unknown --> Probing: mount / Re-check / 60 s stale
        Probing --> Connected: 200 /user + capability probe OK
        Probing --> Problem: 401 · 403 · 404 · suspended · approval-pending
        Probing --> Unreachable: network / API outage
        Probing --> Available: gh present, not logged in

        Connected --> Degraded: TOKEN_EXPIRING under 24 h<br/>or refresh token under 7 days
        Connected --> Probing: Re-check (retains snapshot)
        Connected --> Refreshing: T-60 s or shim 401
        Connected --> Problem: PROBE_401 (credential invalid)

        Refreshing --> Connected: REFRESH_OK (rotate both tokens)
        Refreshing --> Problem: REFRESH_FAIL<br/>(serve stale, log the risk)

        Degraded --> Connected: Reconnect / REFRESH_OK
        Degraded --> Problem: expired

        Unreachable --> Connected: retry OK<br/>(last confirmed snapshot retained throughout)
        Unreachable --> Probing: Re-check

        Problem --> Connected: remediation succeeded
        Problem --> Probing: Re-check
    }

    state Connecting_App {
        direction LR
        [*] --> WaitingBrowser: Install… → shell.openExternal
        WaitingBrowser --> Exchanging: zeros:// nonce arrives
        WaitingBrowser --> TimedOut: 10 min TTL elapsed
        WaitingBrowser --> ApprovalPending: setup_action=request
        Exchanging --> [*]: credential stored → Connected
        Exchanging --> Failed: exchange rejected
        Failed --> WaitingBrowser: Try again
        TimedOut --> WaitingBrowser: Open GitHub again
        ApprovalPending --> WaitingBrowser: poll /user/installations sees it
    }

    Selected --> Connecting_App: SELECT zeros-app with no credential
    Connecting_App --> Selected: done or cancelled
```

### 12.1 Every state, with its copy and its transitions

| State | When | Copy | Exits |
|---|---|---|---|
| `Booting` | before the first synchronous settings read resolves | render nothing negative — an `aria-busy` placeholder only | → `Migrating` / `NoMethod` / `Selected` |
| `Migrating` | legacy credential, no method key | silent; never user-visible | → `Selected` / `NoMethod` |
| `NoMethod` | nothing chosen | "Not connected. Zeros can't open pull requests or push branches yet." · App row carries **RECOMMENDED**, nothing auto-selected | `SELECT` |
| `Unknown` | cold cache, never probed | **no negative capability copy** — this is the RULES.md:298-300 rule, and violating it is a shipped bug today ("GitHub CLI not found" for an installed, logged-in `gh`) | `mount` → `Probing` |
| `Probing` | probe in flight | keep showing the last confirmed identity; busy state on the ⟳ only | → `Connected`/`Problem`/`Unreachable`/`Available` |
| `Available` | gh installed, not signed in | "Found `gh`, but it isn't signed in. Run `gh auth login`, then Re-check." | `SELECT`, `Re-check` |
| `Connected` | identity **and** capability confirmed | "Connected as @login" + avatar; "All repositories accessible." / "12 repositories accessible." / "No repositories selected yet." (warning tone, not error) | `Re-check`, `TOKEN_EXPIRING`, `PROBE_401`, `Refreshing` |
| `Refreshing` | T−60 s or shim-reported 401 | no UI change — refresh is invisible when it works | `REFRESH_OK` / `REFRESH_FAIL` |
| `Degraded` | expiring soon | "Sign-in expires in 3 days. Reconnect to avoid interruption." + `Reconnect`; amber, **inside the row, never a modal** | `Reconnect`, `expired` |
| `Problem: credential-invalid` | 401 only | "GitHub revoked this connection. Reconnect to continue." | `Reconnect` |
| `Problem: rate-limited` | 403/429 | "GitHub is rate-limiting Zeros. Retrying at 14:32." — **never** clears the credential | auto-retry |
| `Problem: sso-required` | 403 + `X-GitHub-SSO`, 404, or 200 + `partial-results` | "acme requires SAML sign-in for this token." + `Authorize on GitHub ↗` (the URL expires in one hour) | user action |
| `Problem: forbidden-scope` | 403 `Resource not accessible…` | name the permission from `X-Accepted-GitHub-Permissions` | `Reconnect` / re-consent |
| `Problem: repo-not-installed` | 404 under an installation credential | "zeros-app isn't in this installation. Add it to open pull requests here." + one-click `PUT …/repositories/{id}` (§9.3), fallback `Configure repositories ↗` | user action |
| `Problem: installation-suspended` | 403 + suspension message | "This installation is suspended." — note suspension is **asymmetric**: whoever suspended must unsuspend (**verified**) | link out |
| `Problem: org-approval-pending` | `setup_action=request`, or poll finds nothing | "Waiting for an owner of acme to approve the installation." + `Remind an owner ↗` | poll |
| `Unreachable` | network / outage | "Couldn't check — you may be offline." **Retain the last confirmed snapshot.** | `Re-check` |
| `Disconnected` | explicit, confirmed disconnect | "No method selected." | `SELECT` |

### 12.2 Non-negotiable UI mechanics

- **The Refresh affordance is `Re-check`, not `Refresh`**, and it must revalidate *without* clearing the last confirmed snapshot. Today the Refresh button exists only in the not-connected branch, so a user staring at a stale green card has no way to force a re-probe short of signing out.
- **The ⋮ overflow and the "Create token ↗" link must be DOM siblings of the radio, never descendants.** This is not a hit-target nicety: per MDN, *"browsers automatically apply role presentation to all descendant elements of any radio element"* (**verified**), so a control nested inside `role="radio"` is stripped of its name, role and state, and axe's `nested-interactive` rule flags it as WCAG 4.1.2 Level A (**verified**). Layout as a grid row: `[radio — label + description only] [trailing slot — ⋮ / ↗]`, trailing slot outside the radio's box but visually inside the card border, with its own tab stop *after* the group.
- **There is no `RadioGroup` primitive in the repo** — `src/zeros/ui/primitives/index.ts` ships only `DropdownMenuRadioGroup` — although the unified `radix-ui` package already in `package.json` provides one. The single existing `role="radiogroup"` in the app (`src/zeros/panels/providers-panel.tsx:1195-1224`) is **already broken**: three native `<button role="radio">` with no roving `tabIndex` and no arrow-key handler, so the group is 3 tab stops instead of 1 and arrows do nothing. A radio group is a **single** tab stop; arrows move focus *and* selection, wrapping (**verified**, [APG radio pattern](https://www.w3.org/WAI/ARIA/apg/patterns/radio/)). Do not copy it — extract a real primitive and fix that call site too.
- **The connected chip's avatar needs a decision first.** `AuthStatusResult` is `{ authenticated, login }` only, so avatar URL does not exist as data; and Settings carries an explicit standing decision *against* loading remote provider avatars (`settings-page.tsx:920-923`) which contradicts `repository-icons.ts:180-190`. Resolve that conflict before shipping the chip, or ship initials.
- **Placement: Settings is canonical, plus just-in-time prompts.** Every desktop precedent is JIT — VS Code prompts at the moment a git action needs GitHub (**likely**), JetBrains on share/PR/gist (**verified**) — and the permission-priming literature agrees a contextual ask converts better than an onboarding-blocking one (**likely**). Add an inline (not modal) prompt in the PR composer and the push path that deep-links to Settings → GitHub with the App row focused; do **not** add a first-run step, and do not duplicate the chooser. One trigger nobody else has: **selecting a cloud workspace**, where only the App row is a valid answer — so the chooser needs a per-context validity notion, not a global "connected" boolean. Today all ten of Zeros' GitHub entry points dead-end when unauthenticated, two of them printing engine-speak ("Call `gh_auth_signin` to start the device-flow") or stale navigation ("Settings → General → GitHub", a section renamed to Integrations).
- **Disconnect is confirmed with an itemised list, not a paragraph** (**verified** — consequences should be scannable): "Zeros will stop opening and reviewing pull requests." / "Cloud workspaces will lose push access." / "The installation stays on GitHub until you remove it there." `Cancel` takes default focus. The PAT row gets **no** dialog — removing a pasted string is trivially reversible — just `Remove token` with an undo.
- **The PAT placeholder is wrong today.** `github-section.tsx:241` uses `ghp_xxxxxxxxxxxxxxxxxxxx`, the *classic* prefix, which steers users to the wrong token type. Use `github_pat_…`, and name the **permissions** (Contents, Pull requests, Metadata) rather than classic scopes. Fine-grained PATs reached GA on 2025-03-18; classic PATs are discouraged but **not deprecated**, and there is no announced sunset (**verified**) — so both code paths stay.

---

## 13. The migration: infer, never default

Existing users have a credential and no method. The new `[github] auth_method` key is simply absent for every one of them, and `getAuthStatus` cannot today tell a CLI-sourced token from a PAT from a device-flow token.

**Defaulting is the failure mode, in both directions.** Default to the App and a working install renders "not connected", inviting a re-auth the user reads as a logout. Default to PAT and an empty token box appears under a working connection. Run the old implicit chain on first open and it re-adopts the gh CLI token and silently switches method — the confirmed `signout-silently-readopts-gh-cli` behaviour, which has **two** independent re-adoption sites.

So: **infer once, idempotently, non-destructively, presence-is-the-marker** — the same shape as the shipped `getSettingMigrated` (`src/native/settings.ts:48-60`) and `seedUserSettingsFromLegacyRoot`.

```ts
/** One-time inference at first read. Never clears the existing token. Never runs
 *  the ADOPT side of detectGhCli. Idempotent: the presence of [github]
 *  auth_method (or github.disconnected_at) is the marker that it has run. */
async function inferGithubAuthMethod(): Promise<GithubAuthMethod | null> {
  if (await settings.has("github.auth_method")) return null;      // already migrated
  const legacy = await getSecret("github_oauth");
  if (!legacy) return null;                                       // → "no method selected"

  // 1. Cheapest and most decisive: does gh hand back the SAME string?
  const ghToken = await probeGhCliToken();          // PURE probe — no tokenStore.set
  if (ghToken && timingSafeEqual(ghToken, legacy)) return "gh-cli";

  // 2. Prefix is self-describing for PATs.
  if (/^(ghp_|github_pat_)/.test(legacy)) return "pat";

  // 3. gho_ = an OAuth-app token: ours (device flow) or gh's. GitHub returns
  //    x-oauth-client-id on the /user response, which today's getAuthStatus
  //    discards — read it and compare against DEFAULT_CLIENT_ID.
  const clientId = await probeOauthClientId(legacy);
  if (clientId && clientId === DEFAULT_CLIENT_ID) return "pat";  // device flow ≡ PAT behaviour
  if (clientId && clientId === GH_CLI_CLIENT_ID) return "gh-cli";

  // 4. Unresolvable → the honest answer, not a guess.
  return "pat";  // behaves identically to device flow; never widens access
}
```

Four notes on the inference, one of which corrects the original finding:

1. **The stored credential is largely self-describing** — the verifier pushed back on "getAuthStatus cannot tell them apart", correctly: that is a property of the current *function*, not of the data. Prefixes separate PAT (`ghp_` / `github_pat_`) from OAuth (`gho_`); re-running `gh auth token` and string-comparing is deterministic; and GitHub returns `x-oauth-client-id` on OAuth-app token responses, which `getAuthStatus` currently throws away. The inference is cheap and available — it just has to be written.
2. **Collapsing device flow into `pat` is honest, not lazy.** They are indistinguishable to the user, behave identically (a bare token with no refresh path), and neither is cloud-capable without a warning. Three rows is the product decision; four would be a taxonomy.
3. **`probeGhCliToken()` must be a pure probe.** The existing `detectGhCli()` writes the store as a side effect (`src/engine/git/github.ts:249`). Splitting probe from adopt is a prerequisite for the whole design, not just the migration: a read must never change which credential is active.
4. **Never clear the legacy slot until the new slot demonstrably holds the value.** This is the same rule the repo already encodes for renamed localStorage keys: `setSetting` swallows quota and privacy failures, so removing the old copy first "can destroy the sole copy — losing exactly the selection this function exists to preserve" (`src/native/settings.ts`). Write `github.pat` (or `github.app.*`), read it back, *then* delete `github_oauth`.

Migration also has to disarm the two re-adoption sites in the same change, or it is undone on the next launch: the panel's post-sign-out `refresh()` and the engine's boot-time `detectGhCli()` (`src/engine/index.ts:1138-1148`) must both consult the persisted method (and `github.disconnected_at`) before probing.

---

## 14. Multi-provider (GitLab, Bitbucket)

The broker is the durable abstraction because **the git-over-HTTPS username differs per provider and per credential kind** — a fact no shared `PR` type can absorb:

| Provider / credential | git username | REST auth |
|---|---|---|
| GitHub (any token) | `x-access-token` (any non-empty; GitHub ignores it) | Bearer |
| GitLab OAuth token | **`oauth2`** (mandatory — the real username fails) | Bearer |
| GitLab PAT | any non-blank | `PRIVATE-TOKEN` / Bearer |
| Bitbucket Atlassian API token | `x-bitbucket-api-token-auth` (or exact case-sensitive username) | Basic `email:token` |
| Bitbucket repo/project/workspace token | `x-token-auth` | Bearer |

So `gitHttpUsername` is a **first-class field on the credential record, never inferred**. For GitHub the username is unvalidated in practice (GitHub's PAT docs state outright that "the username is not used to authenticate you", and a Sept 2025 community report confirms the same for `ghs_` installation tokens) — but it must be non-empty, the lenient behaviour is undocumented, and the leniency **does not generalise**: GitLab genuinely validates `oauth2` for OAuth tokens (**likely**). Emit `x-access-token` literally.

### 14.1 Hard constraints to design around

- **GitLab has no GitHub-App analogue** — no installation object, no per-project consent; an authorized OAuth app reaches everything the user can (**likely**). Its substitute for installation scoping is Project/Group Access Tokens, which provision non-seat-consuming bot users (**verified**). So the "recommended" row for GitLab is *OAuth + PKCE* (GitLab documents authorization-code-with-PKCE as "most secure" and also supports the Device Authorization Grant — 17.1, GA 17.9, **verified**), and per-project scoping is a **different product gesture**, not the same one. The persisted model must therefore be "a list of provider-advertised credential *kinds*, each with capabilities" — not a fixed triple.
- **Bitbucket app passwords were fully removed on 2026-07-28** — one day before this report (**verified**; phased from June 9 2025, brownouts June 9 – July 27 2026). Anything written against them is already dead. Replacement: Atlassian **API tokens** with scopes (`read:repository:bitbucket`, `write:repository:bitbucket`), or Repository/Workspace Access Tokens.
- **Bitbucket OAuth does not support PKCE** (**likely**), requires `client_id:secret` via Basic, and since 2026-05-04 mandates **rotating** refresh tokens — each use mints a new one, unused ones expire in 3 months (**verified**). No PKCE means a Bitbucket consumer cannot be done client-side at all: the secret must live in `backend/`. Atlassian Connect is retired (new Bitbucket Connect apps could no longer be registered from 2026-02-02, **likely**); Forge is the path.
- **Semantics that leak through a naive shared type.** `ReviewMergeMethod = "squash" | "merge" | "rebase"` (`src/shell/pr/review-provider.ts:33`) is invalid on **both** other hosts: Bitbucket Cloud has `merge_commit`, `squash`, `fast_forward` and **no rebase** (**verified**); GitLab's merge method is a **project-level setting**, not a per-MR caller choice (**verified**). Merge method must become a capability the provider advertises. Bitbucket also has no assignees and no labels, and cannot rename or reopen DECLINED PRs; GitLab MRs expose both `id` and project-scoped `iid` (API paths use `iid`), and GitLab has **three** distinct mechanisms in the space GitHub covers with Checks (pipelines, commit-status API, external status checks).
- **Library verdict.** `@gitbeaker/rest` for GitLab (dual CJS+ESM exports map — no `ERR_REQUIRE_ESM` repeat, **verified**); plain `fetch` for Bitbucket (the `bitbucket` npm package last shipped 2024-05-18 and predates the whole app-password transition, **verified**). And a warning for the GitHub work itself: **`@octokit/auth-app@8.2.0` is `"type": "module"`, ESM-only**, exactly like `@octokit/rest@22` (**verified**) — so it will reproduce the `ERR_REQUIRE_ESM` problem already documented at `src/engine/git/github.ts:20-27` and must get the same lazy-dynamic-import plus `tsup` `external` treatment.
- **Borrow Renovate's `Platform` interface shape** (`lib/modules/platform/types.ts`): ~35 methods with ~15 marked optional, two-phase init (`initPlatform(PlatformParams) → PlatformResult` separate from `initRepo(RepoParams) → RepoResult`), and *capability/limit* methods (`maxBodyLength()`, `labelCharLimit?()`, `massageMarkdown()`) sitting alongside data methods (**verified**). The two-phase split is exactly the "credential" vs "repo scoping" split Zeros needs, and the optionality is the honest encoding of "Bitbucket has no labels, GitLab has no rebase-merge".

### 14.2 The existing seam, honestly assessed

`src/shell/pr/review-provider.ts` is real and correctly shaped, but it is **inert**: `resolveReviewProvider(_originHost?)` ignores its argument (`:78`) and both call sites invoke it with **no argument at all**, so nothing in the app has ever asked "which host is this repo on?" on the review path. It covers 8 of the 19 `gh*` methods on `src/native/git.ts`, and **5 of those 8 are also called directly elsewhere** (the verifier corrected the original "6 of 8"), so the seam is honoured only for the three ops that live exclusively in the Review tab body. Create-PR, PR sync/discovery, PR list, publish-repo, owners list, repo-name check, avatar and **all five auth methods** sit outside it. `ghPrCreate` is a **dead export with zero callers** — PR creation is an agent prompt, so the provider abstraction cannot capture it even in principle today.

The deepest lock-in is not in TypeScript at all: the agent-facing system-instruction template hardcodes `gh pr create --base <branch>` (`packages/core/src/system-instructions/templates.ts:44`), and the PR brief and check-fix prompts hardcode `gh pr create` / `gh pr checks` / `gh run view`.

Two host-aware fixes must land before a second provider exists, or we paint into a corner:

1. **`repoSlugFromOriginUrl` deliberately drops the host** (`src/engine/git/repo.ts:21-29`, comment: "We intentionally drop the host so worktrees for the same logical project don't fragment if the user re-clones via SSH after HTTPS"). The intent is good and the consequence is that `github.com/acme/x` and `gitlab.com/acme/x` collapse to one `repo_slug` partition key. The fix keeps the SSH/HTTPS-unification intent while separating forges.
2. **The DB has no provider column** (`pr_number` / `pr_state` / `pr_url` in `src/engine/db/migrations.ts`), and the wire `PR` type is not provider-neutral despite its comment: `authorLogin`, `mergeableState` (raw Octokit strings, switched on directly), `behindBy`, `mergeCommitSha` are all GitHub-shaped.

Also worth stating plainly: **a non-GitHub origin is fully accepted today and the UI then lies at four separate points** — Create PR renders unconditionally, its brief tells the agent to run `gh pr create`, the compare-URL builder emits a GitHub-shaped path against a GitLab host, and `ghPrSync` silently returns null forever so the status island never appears. That is a confirmed finding, and it is a better argument for the provider work than any roadmap slide.

---

## 15. What we explicitly do not build

- **No self-hosted-GHES support in phase 1.** The App-variant list is designed for it — `{ key, label, clientId, appSlug, hostname, apiBaseUrl }[]` — but no GHES App is registered, and `parseGitHubRemote` hard-rejects every non-github.com host today while Octokit is constructed with **no `baseUrl`**, so the API layer is structurally github.com-only.
- **No webhook endpoint in phase 1.** Poll installation state on settings open and on 403/404. The client path with only a user token is `GET /user/installations` then `GET /user/installations/{id}/repositories` — roughly 7 REST calls for a user with 1 personal plus 3 org installs and ~250 repos, all ETag-cacheable for free revalidation (**verified**). Deletion is discoverable without webhooks because `POST /app/installations/{id}/access_tokens` returns **404**, and suspension because calls return **403** with a suspension message (**verified**).
- **No credential proxy that keeps tokens wholly out of the sandbox.** Phase-3 candidate (§2.8).
- **No GitLab/Bitbucket implementation** — only the seams and the host-aware fixes in §14.2.
- **No team-shared installations** in phase 1 (§10.1, rule 4).
- **No bundled `gh`.** Conductor bundles the real 53 MB GitHub CLI in `Resources/bin/gh`, which removes the "GitHub CLI not found" branch entirely; Zeros' `detectGhCli()` currently treats `ENOENT` as a dead end. Bundling is a packaging decision with a real size cost and it is out of scope here — but the dead-end state must go regardless, because the broker means `gh`'s absence no longer breaks push.

---

## 16. Gaps, and what we could not establish

Stated plainly, because a reference document that hides its holes is worse than a short one.

1. **Whether an *installation* access token is subject to SAML SSO authorization.** Not stated anywhere we could find; GitHub's dedicated "SAML and GitHub Apps" page covers only install visibility and *user*-token authorization (**unverified**). This is load-bearing for enterprise cloud workspaces and must be settled empirically against a SAML-enforced org.
2. **Conductor's GitHub App permission set, and its App slug's requested permissions.** Published nowhere; the Tauri webview assets are compressed inside the Rust binary and no `github.com/apps/<slug>` URL appears in plaintext. An HN commenter asked for exactly this and was never answered.
3. **Conductor's desktop callback mechanism** — `conductor://` versus loopback versus a web callback. The scheme is registered, which is suggestive but not proof; the redirect target is configured GitHub-side and invisible from the client. The balance of evidence points at browser → GitHub → `conductor.build` web callback with a deep-link hand-back, which is what §9 specifies for Zeros — but that is inference, not observation.
4. **The exact settings-screen copy** ("All repositories accessible.", "gh CLI auth", "Personal Access Token", the RECOMMENDED badge). The founder's screenshot is the only source (**unverified**). The copy deck in §12.1 is therefore *drafted for Zeros*, not quoted from any product.
5. **The `api.conductor.build` endpoint paths.** Only the bare origin appears in plaintext, so the endpoint table in §10 is designed from GitHub's requirements and Zeros' existing backend conventions, not copied from a competitor.
6. **Whether Vercel Sandbox persists the injected token in the sandbox's git remote for later pushes.** Vercel's docs do not say (**verified** that they do not say). Verify empirically before relying on push-back rather than re-mint.
7. **Fine-grained-PAT expiry as data.** GitHub's UI presents preset durations, a custom date and "No expiration" (blockable by org/enterprise policy), and the `expires_in` query parameter for prefilled creation links takes 1–366 or `none` (**verified**) — but we have not established a reliable way to read a *pasted* token's expiry date from the API, which the `expiring-soon` state for the PAT row needs. If it cannot be read, the row must ask the user or omit the date rather than invent one.

### 16.1 One divergence to record for part 10

The spec chooses `zeros://` + nonce for the OAuth hand-back. The research base, taken on its own, leans the other way: the OAuth 2.1 draft now ranks private-use schemes last and says they "should only be used if the previously mentioned more secure options are not available" (**verified**), and Apple's current guidance is that a scheme collision resolves to an *undefined* app (**verified**). §2.9 argues the spec's choice is nevertheless right for Zeros — because the nonce is not a token, and because Zeros already ships and has already hardened exactly this machinery for Auth0 sign-in — but the divergence is real, one author decided it, and no panel reviewed it. Part 10 should carry it as such.

The second thing part 10 should carry: the **three-method picker is a product decision resting on the founder's screenshot**, and the verification pass specifically **killed** the claim that Conductor's own three methods are an explicit user-selected credential rather than an implicit precedence chain. The architecture in this document does not depend on that claim being true — every argument for explicit selection above is grounded in Zeros' own confirmed defects (a single slot, a non-durable `viaCli`, two independent re-adoption sites, a silent identity swap) rather than in what a competitor ships. But the *framing* "this is what Conductor does" should not be repeated as fact.





