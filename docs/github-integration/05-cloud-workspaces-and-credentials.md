# Cloud Workspaces — Getting Credentials Into a Sandbox

*Part 05 of the Zeros GitHub Integration Report · July 2026*

## The short version

- **The cloud requirement is what settles the auth design, not taste.** A rented sandbox has no Keychain, no `gh` login, and no ambient credential helper. Of the three methods in the picker, `gh CLI` cannot work in a sandbox *by construction*, PAT-forwarding works but is rejected, and a backend-minted **1-hour installation token scoped to `repository_ids: [one repo]`** is the smallest credential that does the job. Only a server holding the App private key can mint one.
- **Two independent primary sources say the same thing.** Vercel's own guide — the platform Conductor actually runs on — recommends **GitHub App installation tokens for multi-tenant platforms** and fine-grained PATs only for individuals (**verified**). Conductor's cloud docs say, verbatim, *"git and gh are already authenticated inside the sandbox. Do not copy GitHub tokens into cloud environment variables."* (**verified**).
- **Env-var delivery is the wrong seam; a credential helper is the right one.** An env var is frozen at spawn; a helper is re-invoked per git operation, so it can re-mint. This is what Codespaces, Coder, DevPod and Gitpod all do, and it is what the teardown shows Conductor doing *inside* the sandbox (`Vtr = "/conductor/bin"`, plus the publicly-reserved `CONDUCTOR_GIT_AUTH_*` env prefix — an independent confirmation of the observed broker).
- **Mid-run expiry is the normal case, not an edge case.** A 6-hour agent run outlives a 1-hour token five times; GitHub has declined to extend the lifetime (**likely**). The answer is three layers: T−60 s proactive refresh, force-refresh on a reported 401 keyed by token fingerprint, and — an addition to the spec — git's **native** `password_expiry_utc` (git ≥ 2.40), which makes git itself refuse a stale credential and re-ask the helper.
- **Attribution is fully decoupled from which token pushes.** An installation token does *not* force bot authorship for git-CLI pushes; GitHub links commits by author e-mail only. Pass `gitIdentity: { name, email }` explicitly (Conductor does — observed in the sandbox-creation payload) and build the address from the numeric id: `<id>+<login>@users.noreply.github.com`.
- **`docs/cloud-workspace/` already decided the *what* in writing** (`08-engineering-reference.md:533`), and nothing is built. This section changes the *how* in four places: helper not env var, no token in the remote URL, broker-owned refresh, and a re-scoped view of the phase-3 proxy.
- **The phase-3 "credentials never in the box" posture is closer than the plan assumes.** Daytona — Zeros' chosen provider — documents a placeholder-substituting egress proxy for Secrets; Fly Sprites shipped an OAuth gateway on 2026-03-03; Modal publishes a sidecar recipe. E2B is the only vendor with nothing. Whether Daytona's header-inspection proxy can carry git-over-HTTPS Basic auth is **unestablished** and worth a one-day spike before committing to build.
- **The backend has the right spine and none of the GitHub parts.** Auth0 JWKS verification, FORCE-RLS team scoping via `app_user_team_ids()`, and an append-only audit trail all exist (migrations 0004/0006/0007). What does not: any GitHub table, a place for the App private key (`org_secrets` was dropped in 0005), a home for a *personal* installation's audit row (`audit_log.team_id` is `NOT NULL`), and a rate limiter whose own header says it is "NOT a security boundary" — which is a problem for a credential-issuing endpoint.
- **The single load-bearing unknown: whether installation access tokens are subject to per-user SAML SSO authorization.** GitHub documents neither answer. The whole cloud value proposition assumes "no". Test it against a real SAML-enforced org before committing.

---

## 1. Why the cloud requirement drives the whole decision

Everything else in this report — three radio buttons, a health readout, a `⋮` menu — is a UX argument. The cloud requirement is a *feasibility* argument, and it eliminates options rather than ranking them.

A cloud workspace is the same Zeros engine running inside a rented sandbox (`src/engine/transport/cloud.ts:5-14`). An agent in that box has to `git clone`, `git fetch`, `git push`, and open a PR. Consider each method against that box:

| Method | Works in a sandbox? | Why |
|---|---|---|
| `gh CLI auth` | **No, structurally.** | The credential is `gh auth token` read from the user's Mac Keychain on demand. `detectGhCli()` shells `gh auth token` with a 5 s timeout (`src/engine/git/github.ts:235-252`); in a sandbox there is no `gh`, no login, and nothing to read. Even if Zeros bundled `gh` (as Conductor does — a 53 MB real GitHub CLI in `Resources/bin/gh`, observed), the *login* is what is missing, not the binary. |
| `Personal Access Token` | Yes, and rejected. | Blast radius is every repo the PAT can reach, for as long as the user set (or forever). The founder's brief rules it out for rented VMs; two vendors' own docs agree (§2.2). |
| **Zeros GitHub App** | Yes — the only one that scopes. | The backend holds the private key and mints a 1-hour token narrowed with `repository_ids` to exactly the one repo the sandbox needs. Even a fully compromised box reaches one repo for at most an hour. |

That is the whole argument, and it is short. But it has a **corollary that cuts the other way**, and honest design has to carry both: since 2025-12-01 (GA) org owners can *prevent repository admins from installing GitHub Apps*, and org policy can separately disable app *access requests* — GitHub's docs warn that with both set, "users with repository admin access will be blocked from both installing apps and requesting installations" (**verified** — [changelog](https://github.blog/changelog/2025-12-01-block-repository-admins-from-installing-github-apps-now-generally-available/), [docs](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/limiting-oauth-app-and-github-app-access-requests-and-installations); a further "control who can request apps" preview shipped [2025-12-22](https://github.blog/changelog/2025-12-22-control-who-can-request-apps-for-your-organization/)). So there exists a real and increasingly common org configuration in which the Zeros App can be neither installed nor requested.

Read together: **the App is mandatory for cloud and insufficient for everyone.** `gh CLI` and PAT are not legacy fallbacks kept for sentiment — they are the local-only path for users whose org has closed the App door. The three-radio design is a correctness requirement, and the honest UI consequence is that the `gh CLI` row must carry a visible "not available for cloud workspaces" capability marker rather than failing at launch time. Conductor learned this the expensive way: they shipped *"Cloud workspaces now honor the GitHub credential selected in Settings"* as a **fix** in 0.77.0 on 2026-07-23 — six days before this report, and a year after their App landed (**verified**, [0.77.0 changelog](https://www.conductor.build/changelog/0.77.0-early-access-multiplayer-api-background-tasks-performance)).

---

## 2. The options matrix

### 2.1 Two camps

The industry has split cleanly (this framing survived adversarial verification of 17 claims across 13 products):

- **Camp A — token-in-the-box.** Codespaces, Gitpod/Ona, Coder, DevPod, and every raw sandbox vendor put a real credential inside the VM. The good ones make it (a) short-lived, (b) scoped to specific repos, and (c) delivered through a **credential helper / `GIT_ASKPASS` shim** rather than a baked-in env var, so the value can be re-minted per operation.
- **Camp B — token-never-in-the-box.** Anthropic's Claude Code cloud runs an egress proxy holding the real token. The sandbox's git client authenticates to the proxy with a *scoped credential*; the proxy validates **the git request itself** — repo destination and target branch — before attaching the real token (**verified**, [Anthropic engineering](https://www.anthropic.com/engineering/claude-code-sandboxing), [docs](https://code.claude.com/docs/en/claude-code-on-the-web)).

Camp B is the only architecture that survives "assume the agent's box is compromised", which is the correct threat model for an agent sandbox. Zeros' decision is a *disciplined Camp A* (short-lived, per-repo, helper-delivered) with Camp B named as the phase-3 direction — matching what `docs/cloud-workspace/07-execution-plan.md:168` already files as "Long-term".

### 2.2 The five options, scored

| | (a) Forward the user's PAT / `gh` token | **(b) Backend-minted 1 h installation token** ← the decision | (c) Call-home helper → the Mac | (d) Call-home helper → the backend | (e) SSH deploy keys | (f) Full credential proxy |
|---|---|---|---|---|---|---|
| **Blast radius if the box is owned** | Every repo the credential can reach, plus (classic PAT / OAuth `repo`) settings, webhooks, deploy keys | **One repo, ≤ 1 h**, permissions down-scoped at mint | The user's full credential, for as long as the Mac is awake | One repo, ≤ 1 h | One repo, indefinitely | Nothing — the box holds a placeholder |
| **Lifetime** | User-chosen or none | 1 h, non-configurable | Whatever the Mac holds (PAT: forever; App user token: 8 h) | 1 h | Until manually rotated | n/a |
| **Rotation** | Manual | Automatic, per operation | Inherits the Mac's | Automatic | Manual, per repo | n/a |
| **Attribution** | Correct (the user) — the token *is* the user | Correct **iff** `gitIdentity` is set explicitly (§5) | Correct | Correct iff `gitIdentity` set | Per *key*, not per user | Correct |
| **SAML-enforced org** | Works only if the PAT/OAuth token was explicitly SSO-authorized for that org | **Believed unaffected** (installations are org-owner-approved, not user-session-bound) — **UNVERIFIED, see §10** | Same exposure as (a) | Same as (b) | Bypasses SSO entirely | Depends on what the proxy holds |
| **Org IP allow list** | Blocked (unpredictable sandbox egress IP) | Blocked unless the Zeros App declares its own IP allow list *and* the org enables that setting | Blocked | Same as (b) | Blocked | Blocked unless the proxy egresses from a declared IP |
| **Survives a closed laptop** | Yes | **Yes** | **No** — this is disqualifying | Yes | Yes | Yes |
| **Build cost** | ~zero | Backend mint endpoint + installation model + in-sandbox broker | In-sandbox broker + a reverse channel that does not exist | Backend mint endpoint + in-sandbox broker (shared with (b)) | Key CRUD per repo | A validating MITM proxy on the egress path |
| **Verdict** | **Reject for cloud**; permit-with-warning for local | **Ship** | Reject | **Ship** — (b) and (d) are the same mechanism | Reject except for private ssh submodules | **Phase 3** — and partly buyable (§2.4) |

Notes on each row that the table cannot carry:

**(a) PAT-forwarding.** Three independent sources point the same way. Vercel's guide recommends App installation tokens for multi-tenant platforms and fine-grained PATs only for individual developers (**verified**, [guide](https://vercel.com/kb/guide/sandbox-private-github-repositories), last updated 2026-05-26). Conductor's cloud docs instruct users not to copy GitHub tokens into cloud environment variables at all (**verified**, [cloud-beta env vars](https://www.conductor.build/docs/cloud-beta/environment-variables)). And the failure class is well documented: OWASP's *Top 10 for Agentic Applications 2026* (published 2025-12-09) ranks **ASI01 Agent Goal Hijack** first; CVE-2026-22708 in Cursor (reported 2025-08-11, fixed in Cursor 2.3, January 2026) let prompt injection poison env vars such as `PAGER` via implicitly-trusted shell built-ins so that allowlisted commands like `git branch` executed attacker code; and in July 2025 General Analysis published a **proof of concept** (not a real-world breach) in which an agent with a Supabase `service_role` key read an attacker-authored support ticket and wrote `integration_tokens` rows back into the attacker-visible thread. The honest verb is *demonstrated*, not *exploited* — but the design conclusion is unchanged, and it gives the PAT radio a real, statable capability difference rather than a silent downgrade.

**(b)/(d) The installation token.** Mint by signing an RS256 JWT with the App private key (`iss` = client ID or app ID, `exp` ≤ 10 min) and `POST /app/installations/{id}/access_tokens` (**verified**). Narrow it at mint time: `repositories` (names) or `repository_ids` (ids) — **up to 500, mutually exclusive** — plus a `permissions` object, never wider than the installation grant. Two production caveats: 500 is an upper bound, not a guarantee (scoping both repos *and* permissions can trip a token "complexity" limit and return *"Too many repositories for installation"* well below 500), and since the staged rollout beginning **2026-04-27** newly minted tokens use a stateless `ghs_APPID_JWT` format — **~520 characters, variable length, containing dots** — so every storage field must hold ≥ 600 chars and every `ghs_[A-Za-z0-9]{36}`-style regex or 40-char length assumption must go (**verified**, [changelog](https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/), [docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)).

Also decisive and easy to miss: **every endpoint that answers "which installation covers this repo?"** — `GET /repos/{owner}/{repo}/installation`, `GET /orgs/{org}/installation`, `GET /app/installations` — requires a **JWT**, i.e. the App private key (**verified**, [REST apps](https://docs.github.com/en/rest/apps/apps)). The engine can therefore *never* resolve repo → installation itself. That is not a limitation to work around; it is the reason the backend has to be on this path at all, and it keeps the "the renderer never holds the credential" invariant (`src/zeros/bridge/github-token-sync.ts`) intact for free.

**(c) Call-home to the Mac.** Technically attractive — it is the closest thing to Camp B without building a proxy, and Coder/DevPod/Gitpod all ship exactly this shape. It is disqualified by the product promise, not by security: `docs/cloud-workspace/01-cloud-workspaces-explained.md` sells *"12:30 PM — you close the laptop and go to lunch"*, and a helper that RPCs the Mac dies with the lid. There is also an existing, deliberate guard in the way: `GITHUB_TOKEN_SET` is accepted **from local clients only** (`src/engine/index.ts:1781`) and the change notifier goes out via `broadcastLocal`, which filters to `kind === "local"` (`src/engine/index.ts:1110-1119`). A cloud peer is `kind: "cloud"` (`src/engine/transport/cloud.ts:81`). **Do not relax that guard to make (c) work** — it exists so a remote peer can never inject or harvest the owner's credential.

**(e) SSH deploy keys.** Evaluated here for the first time — they appear nowhere in `docs/cloud-workspace/`, nowhere in `backend/`, and nowhere in the engine. Per-repo scoping is genuinely narrow, which is the appeal. Against: keys are long-lived unless rotated, attribution is per-key rather than per-user, a multi-repo workspace needs N keys, they bypass org SAML SSO (which a security reviewer will read as a bug, not a feature), and the operational surface — generate, upload, track, revoke — is a small product of its own. The one place they remain necessary is Netlify's documented exception: even under a GitHub App you still need a deploy key for **private git submodules linked in `ssh` form** (**verified**, [Netlify docs](https://docs.netlify.com/build/git-workflows/repo-permissions-linking/)). Ship deploy keys never; document that submodule case honestly.

### 2.3 Where the credential goes wrong even inside option (b)

Two anti-patterns are one keystroke away and both are explicitly ruled out:

- **Token in the remote URL.** `git remote set-url origin https://x-access-token:TOKEN@github.com/...` writes a credential into `.git/config`, where it surfaces in `git remote -v`, in every agent transcript, and in support-ticket pastes — and it survives the 1-hour expiry as stale garbage that produces a confusing failure. `docs/cloud-workspace/08-engineering-reference.md:533` currently spells the design as that URL form; treat it as shorthand for "the token is the HTTPS password", not as the storage mechanism.
- **The provider's built-in credential store.** Daytona's persistent git-credential endpoint carries the vendor's own warning: *"Credentials are stored in plaintext on disk"* (**verified**, [daytona.io/docs/en/git-operations](https://www.daytona.io/docs/en/git-operations/)). Plaintext on disk in a box the agent controls is the exact thing this whole section exists to avoid.

### 2.4 The phase-3 proxy is partly off-the-shelf now

This is the one place where the evidence has moved past the plan. The claim that "Daytona, E2B, Modal and Fly Sprites provide no credential-management layer beyond *pass a token*" was **refuted** on fact-check; three of the four now document the thing:

| Vendor | Credential-proxy mechanism (as of July 2026) |
|---|---|
| **Daytona** (Zeros' provider) | Org **Secrets**: the sandbox env var holds an *opaque placeholder*; an egress proxy inspects outbound HTTPS and, if a request header carries a placeholder and the destination matches the secret's host allowlist, substitutes the decrypted value. Write-only values ("never returned by the API"), per-secret host allowlists with `*.` wildcards, and rotation without sandbox recreation. The docs' worked example is a GitHub token allowlisted for `api.github.com`. (**verified**, [daytona.io/docs/en/secrets](https://www.daytona.io/docs/en/secrets/)) |
| **Fly.io Sprites** | **Connectors**, shipped 2026-03-03: a built-in OAuth gateway (GitHub among the supported providers), tokens AES-256-GCM at rest org-side, calls routed through `https://api.sprites.dev/v1/gateway/<provider>/<connection_id>/<path>` with policies by sprite-name prefix, label, or endpoint allow/block list. *"Sprites never see the token."* (**verified**, [docs.sprites.dev/concepts/connectors](https://docs.sprites.dev/concepts/connectors/)) |
| **Modal** | No proxy in core docs, but `modal-labs/credential-injection` is a first-party recipe: a Caddy reverse-proxy sidecar on the sandbox's private network where "the real credential lives in a Modal Secret mounted on the sidecar only; the sandbox never sees it." (**likely** — sample repo, not a docs guide) |
| **E2B** | Nothing. Documented pattern is `username: 'x-access-token', password: process.env.GITHUB_TOKEN`; secrets are plain env vars visible in the box; credential brokering is an open feature request ([e2b-dev/E2B#1160](https://github.com/e2b-dev/E2B/issues/1160), opened 2026-02-25). (**verified**) |

The honest caveat, and the reason this is a spike rather than a decision: Daytona's documented mechanism is **header inspection on an HTTPS request**, exemplified against `api.github.com`. Git over HTTPS presents its credential as `Authorization: Basic base64(user:password)` — the placeholder would be base64-encoded inside the header value, so it is not obvious that substitution fires. **We could not establish whether Daytona Secrets can carry git-over-HTTPS.** One day of hands-on work answers it, and the answer changes whether phase 3 is "build a validating proxy" or "configure the provider's".

---

## 3. What `docs/cloud-workspace/` already decided, and how this fits

The cloud pack is not silent on GitHub — it decided the *what*, in writing, in six places, and shipped none of it.

| Decision already in writing | Where |
|---|---|
| "**GitHub:** Zeros App installation token (1 h, auto re-mint) `https://x-access-token:TOKEN@github.com/...`; PAT fallback; engine reads `ZEROS_GITHUB_TOKEN`." | `docs/cloud-workspace/08-engineering-reference.md:533` |
| "GitHub = Zeros GitHub App or PAT" as the agent-auth line | `08-engineering-reference.md:79` |
| Phase 6 Settings panel: "**GitHub** (Zeros App *recommended* / PAT)" | `08-engineering-reference.md:528` |
| Initial clone via the Daytona SDK: `sandbox.git.clone(url, path, branch?, commit?, 'x-access-token', TOKEN)` | `08-engineering-reference.md:169` |
| Shared-box hazard acknowledged, key question left open: "every member of a shared box can read injected creds → use short-lived, workspace-scoped tokens (GitHub App 1 h; rotate); **decide whose token the box acts as**" | `08-engineering-reference.md:476` |
| "any secret injected via env/files **can be read by a context-injected agent inside the box**" | `08-engineering-reference.md:537` |
| Risk #6 *Secrets in shared boxes*: short-lived tokens now; "Long-term, copy the industry pattern: credentials live at a proxy, never in the box (Anthropic and Vercel both do this)" | `07-execution-plan.md:168` |
| "Zeros GitHub App installation tokens that expire in 1 hour" for shared workspaces | `05-sync-teams-and-collaboration.md:200` |
| Anthropic's credential proxy named as a thing to adopt | `03-cursor-and-claude-code-cloud.md:10,76,151` |

And the state of the code, verified: **Phase 6 is unbuilt.** The Phase 1 spike's credential allowlist `AGENT_CRED_ENV_VARS` is exactly `[ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY, OPENAI_BASE_URL, CURSOR_API_KEY]` (`scripts/cloud-spike/config.ts:110-117`) — deliberately no GitHub variable. The spike image clones only the *public* zeros repo at bake time (`scripts/cloud-spike/Dockerfile:17,46`). So today a sandbox has zero repo credentials. (Note for calibration: `scripts/cloud-spike/` is explicitly **non-shipping harness code** — its README says so, and nothing in the packaged app imports it. Two audit findings that treated the spike image as the product were refuted on exactly that ground.)

**Where this section changes the plan — four places:**

1. **Helper, not env var.** `ZEROS_GITHUB_TOKEN` is consumed once at engine startup (`src/engine/index.ts:1125-1127` → `seedGithubToken`), and that seeds an in-memory string with no expiry backing **Octokit only** (`src/engine/git/engine-token-store.ts`). Two mid-session re-seed channels do exist and work — the stdin host-control line `{"type":"host.githubToken"}` (`src/engine/index.ts:4048-4058`) and the `GITHUB_TOKEN_SET` bridge message (`:1778-1781`) — so "there is no re-mint channel" is *false* for the REST path. But neither touches git transport: `push()` shells a bare `git push` with no credential plumbing (`src/engine/git/ops.ts:116-142`), and the code says why out loud — *"The push relies on the user's git credential helper (gh), same as the existing workspace push"* (`src/engine/git/github.ts:898`). A helper is re-invoked per operation and can re-mint; an env var cannot reach git at all.
2. **No token in the remote URL** (§2.3).
3. **The broker owns refresh** (§4) rather than a bespoke poller, and it emits `password_expiry_utc` so git enforces freshness itself.
4. **Re-scope phase 3** in light of §2.4 before budgeting a proxy build.

---

## 4. Token expiry mid-run is the NORMAL case

### 4.1 The arithmetic

| Run shape | Token expiries to survive |
|---|---|
| 6-hour agent run (the brief's example) | **5** |
| Overnight run, 12 h | 11 |
| Vercel Sandbox's hard 24 h session cap | 23 |
| Daytona with `autoStopInterval: 0` (Zeros' setting) — no hard runtime cap | unbounded |
| Any stop → snapshot → wake cycle | the pre-sleep token is dead on wake, by construction |

GitHub has **declined** to extend the 1-hour installation-token lifetime (community discussion #120382, declined) (**likely**). So any design that mints once at sandbox boot is broken for multi-hour runs *by construction*, and — this is the part that bites — the failure is not at the start, where you would notice it in testing. It is four hours in, on the push.

### 4.2 The three-layer answer

```mermaid
sequenceDiagram
    participant G as git / gh (in sandbox)
    participant H as helper shim<br/>/opt/zeros/bin
    participant B as broker<br/>(unix socket, in sandbox)
    participant BE as backend<br/>(holds App private key)
    participant GH as github.com

    G->>H: credential get (host=github.com)
    H->>B: GET /credential?context=W&host=github.com
    Note over B: entry.expiresAtMs - now < 60_000 ?
    B->>BE: POST /v1/github/installations/:id/token<br/>{repository_ids:[R], permissions:{contents:write,...}}
    BE->>GH: JWT (RS256, App private key)
    GH-->>BE: ghs_APPID_JWT (~520 ch, exp = +1 h)
    BE-->>B: {token, expiresAt}
    B-->>H: username=x-access-token<br/>password=ghs_…<br/>password_expiry_utc=exp-300
    H-->>G: credential
    G->>GH: git push (Basic auth)
    GH-->>G: 401 (mid-transfer expiry / GitHub-side blip)
    G->>H: credential get (retry)
    H->>B: GET /report-failure?context=W&failedTokenSha256=…
    Note over B: fingerprint matches → force refresh<br/>fingerprint differs → already rotated, serve current
    B-->>H: fresh credential
```

**Layer 1 — T−60 s proactive.** Refresh when the entry has under 60 seconds of life left. This is not a guess: the teardown observed Conductor's constant directly — `Ktr = 60_000` — alongside `Nxt = 21_600_000` (6 h), `Xtr = 60_000` and `Qtr = 5_000`.

**Layer 2 — reported 401, keyed by fingerprint.** The shim reports `failedTokenSha256`; the broker force-refreshes only if that fingerprint matches what it currently holds. Without the fingerprint, two concurrent git operations that both 401 cause two mints and a rotation storm. Conductor's per-context entry carries exactly this shape (observed): `{ token, expiresAtMs, refreshUserId, tokenSha256, validity: "unknown" | "invalid", lastRefreshAttemptAtMs, lastRefreshCompletedAtMs }`.

**Layer 3 — git's native expiry protocol (an addition to the spec).** The git credential protocol has carried `password_expiry_utc` since **git 2.40** and `oauth_refresh_token` since **2.41**. `git credential fill` *ignores expired passwords* when reading from helpers (`credential.c`: `if (c->password_expiry_utc < time(NULL))`), so a helper that declares expiry causes git to request a fresh credential rather than use a stale one. On a 401 after a credential was supplied, git calls `credential_reject()`, which invokes every helper with `erase`, so the next invocation supplies fresh material. Since **2.46** a helper can be re-consulted after a subsequent 401 on an already-authenticated request — but that is gated on the helper advertising `capability[]=state` and returning `continue=1`, not on `capability[]=authtype` (a separate 2.46 capability), and Git Credential Manager has not implemented it ([git-credential-manager#2057](https://github.com/git-ecosystem/git-credential-manager/issues/2057), opened 2025-09-26). Since Zeros ships its own helper, that is not a constraint on us. (**verified**, [git-credential](https://git-scm.com/docs/git-credential), [gitcredentials](https://git-scm.com/docs/gitcredentials))

Setting `password_expiry_utc = exp − 300 s` means the 1-hour-token-across-a-6-hour-run problem needs **no polling loop, no background refresher, and no "token expired" modal**. Git re-asks; the helper re-mints. Layers 1 and 2 remain worth having: layer 1 keeps the first git operation after a lull from paying mint latency, and layer 2 covers 401s that are not about expiry at all (§8).

### 4.3 The rules the refresh path must obey

- **Never delete a credential because a refresh failed.** Coder deletes the stored external-auth token on a single refresh failure with no retry or backoff, leaving the workspace dead until manual re-auth ([coder/coder#18811](https://github.com/coder/coder/issues/18811), [#17069](https://github.com/coder/coder/issues/17069)) (**likely**). Conductor goes the other way and *serves the stale token anyway*, with an observed log line: `"Serving existing GitHub token after refresh failed; downstream git/gh may see 401"`. Serve-stale is the right default — a stale token produces one classifiable failure; a deleted credential produces a silent outage.
- **Fail fast, never hang.** Set `GIT_TERMINAL_PROMPT=0` everywhere. One nuance the audit's own refutation established: in the *engine* there is no controlling terminal, so git already exits immediately with `fatal: could not read Username for '…': No such device or address` rather than hanging. In an **agent PTY** there *is* a tty, and that is where the hang lives — so the variable is load-bearing exactly where the agent runs its own `git push`. (Empirically verified in the audit's sandbox: with a tty and no askpass, `git ls-remote` printed `Username for '…':` and hung until killed; with `GIT_TERMINAL_PROMPT=0` it exited immediately with `terminal prompts disabled`.)
- **Retry once on 401 in `push()`.** The helper is consulted at the **start** of an operation. A token valid at push start but expired mid-transfer of a large pack still fails *that* push; git calls `erase` and the next attempt succeeds. Without a retry, users see spurious one-off failures on big pushes and no pattern to report.
- **Do not read a GitHub-side 401 as "the user's credential is bad."** On **2026-05-23** (06:00–19:12 UTC) 1–5% of app-installation-token authentication requests failed — average 2.3%, peak ~5.4% — "including failures in Git operations and API calls using app installation tokens"; on **2026-02-17** (17:07–19:06 UTC) token-verification lookups intermittently returned 401s from replication lag (**likely**, [pulsetic incident record](https://pulsetic.com/status/github/incidents/3972/), [incidenthub 2025-26 history](https://blog.incidenthub.cloud/github-reliability-outage-history-2025-2026)). Today's `withAuthRetry` calls `tokenStore.clear()` on any auth error (`src/engine/git/github.ts:498-501`) and `isAuthError()` treats **403 as 401** (`:390-394`) — during the February incident, Zeros as written would have signed out a chunk of its users. Require N consecutive failures plus one successful control request before clearing anything. (The classifier split is Phase-0 blocker **B2** in the spec; it is a hard prerequisite for the App, because per-repo installation scoping *generates* 403s by design.)
- **Redact before first use, not after.** Conductor shipped *"GitHub App installation tokens in the new JWT format are now fully redacted from logs"* in 0.76.1 (July 2026) — which means theirs leaked first. Zeros' scrubber already covers `ghp|gho|ghu|ghs|ghr` prefixes (`packages/core/src/scrub.ts:81`); the JWT-shaped body after `ghs_APPID_` is the new part.

---

## 5. Commit attribution via explicit `gitIdentity`

### 5.1 The mechanism, stated precisely

An installation token is **only a push credential**. It does not attribute anything. GitHub links a commit to a profile purely by matching the **author/committer e-mail**. Auto-attribution to `<app-slug>[bot]` happens only for commits created through the REST/GraphQL APIs (Contents API, `createCommitOnBranch`), which are additionally server-signed and show *Verified*. For git-CLI pushes — which is what Zeros does — **you set the identity yourself, and the token has no say** (**likely**, community-sourced; GitHub's own docs do not cover this).

Conductor treats this as a configured input, not a side effect: the observed sandbox-creation payload carries `gitIdentity?: { name?, email? }` alongside `ghToken?`, `forgeAuth?`, `gitPullConfig?` and `sshPublicKey?`. Zeros should do the same, explicitly, per workspace.

The correct address is `{USER_ID}+{login}@users.noreply.github.com`, where `USER_ID` is the numeric id from the user access token's `GET /user`. Three ways to get this wrong:

- **Guessing the e-mail from the login.** Read the `login` from the API response; do not string-build it. (For bots: app slug `copilot-swe-agent` has login `Copilot`, id `198982749`.)
- **Using the App ID instead of the bot user id.** Produces a successful but entirely unlinked commit — `author: null`, grey default avatar, no profile link. Worse than cosmetic: App IDs are small sequential integers that collide with real account ids (Dependabot's app id `29110` is the user `wherewegonow`; the Claude app's `1236702` is `herbalnerds`), so a collision with an account whose noreply address is active attributes your agent's commits to an unrelated person. The `%5B`/`%5D` URL-encoding of `[bot]` in `https://api.github.com/users/<slug>%5Bbot%5D` is also load-bearing — unencoded brackets 404, which is [actions/create-github-app-token#172](https://github.com/actions/create-github-app-token/issues/172).
- **A grey default avatar on every agent commit** is the tell that the e-mail doesn't match a GitHub identity. Treat it as a test assertion, not a cosmetic complaint.

### 5.2 Which identity to use where

| Operation | Credential | Identity that appears |
|---|---|---|
| `clone` / `fetch` in the sandbox | installation token (`contents: read`) | n/a |
| `commit` in the sandbox | n/a | **the human** — `user.name` / `user.email` from `gitIdentity` |
| `push` from the sandbox | installation token (`contents: write`; **+ `workflows: write` if the diff touches `.github/workflows/`**) | the commit's author, i.e. the human |
| Open / update / comment on a PR (interactive, local) | the App **user** token | the human, with the app's identicon badge |
| Open a PR on the user's behalf headlessly | installation token | `Zeros[bot]` as PR author |

That split is not arbitrary: a user access token's permissions are the intersection of what the user can do and what the app was granted, and requests made with it are attributed to the **user**; installation-token requests are attributed to the **app** (**verified**, [GitHub docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)).

### 5.3 The hazards on both sides — this is a decision, not a default

Acting as a bot and acting as the user each carry a documented failure mode, and there is no option that has neither:

- **Bot identity breaks branch protection.** GitHub documents that "a rule that only allows specific commit authors can prevent Copilot cloud agent from creating or updating pull requests", and had to ship a first-party ruleset bypass-actor escape hatch **that a third party like Zeros cannot use**. This is the strongest argument for user identity by default.
- **Bot identity damages history.** Copilot's coding agent authors commits as *Copilot* on squash-merge, which disrupts `git blame` and contribution history; the community workaround is a `Co-authored-by` trailer naming the human. GitHub sets the squash commit's author from the PR's commits, so an agent-authored PR merged by squash can wipe the human from blame entirely ([community #179983](https://github.com/orgs/community/discussions/179983)).
- **User identity has its own hazard.** Anthropic's Auto-fix deliberately posts as the user and warns that repositories using comment-triggered automation — Atlantis, Terraform Cloud, custom `issue_comment` workflows — can be triggered by an agent's comment, "which can deploy infrastructure or run privileged operations". If Zeros posts PR comments on the user's behalf, that hazard transfers verbatim.
- **`Co-authored-by` trailers must default OFF.** VS Code's `git.addAICoAuthor` (enum `off | chatAndAgent | all`) appends `Co-authored-by: Copilot <copilot@github.com>`. Its default flipped to `"all"` in 1.117 (2026-04-22) with no release note; a change-detection bug attributed hand-written code to Copilot, and the trailer was appended even with `chat.disableAIFeatures` set and even after the user manually replaced the commit message. After a public backlash on consent and repo provenance, Microsoft narrowed it to `"chatAndAgent"` in 1.118 (2026-04-29) and **reverted it to `"off"` in 1.119 (2026-05-06)**, committing to explicit consent before writing any trailer ([microsoft/vscode#314311](https://github.com/microsoft/vscode/issues/314311), [community #194075](https://github.com/orgs/community/discussions/194075)) (**likely**). Ship the three-state setting, default `off`, per-repo, visible.

### 5.4 The unresolved question: whose identity in a shared box

`docs/cloud-workspace/08-engineering-reference.md:476` states the problem and leaves it open — *"decide whose token the box acts as"* — and commit-author attribution in a shared cloud box is unresolved anywhere in the pack. It is unresolved here too, but it should be *stated* rather than defaulted:

- v1 (single-user cloud workspace) is trivial: the workspace owner's `gitIdentity`, minted against the owner's installation.
- The moment a teammate joins the same live engine, every commit that teammate's agent makes carries the owner's identity unless per-connection identity lands. The pack already schedules that work — Phase 8, "every connection authenticates as its own user, the server stamps authorship (never trusts the client)" (`07-execution-plan.md:169`). Until then, **say so in the UI**: a shared cloud workspace attributes commits to its owner.
- Do not run two GitHub identities against the same repo simultaneously. CircleCI's OAuth→App transition (started August 2023, still generating support articles into 2026) produced duplicate triggers and duplicate status checks whenever both integrations were live (**likely**). Whichever identity posts Zeros' PR comments becomes permanently visible in history; switching methods changes the author of past-and-future comments. That is a fact the picker should disclose.

---

## 6. How the sandbox's git is actually configured

### 6.1 The precedents, concretely

| Product | Delivery mechanism | Notable detail |
|---|---|---|
| **GitHub Codespaces** | `credential.helper=/.codespaces/bin/gitcredential_github.sh` registered in the **system** gitconfig | The system gitconfig is at the *nonstandard* `/usr/local/etc/gitconfig`, not `/etc/gitconfig` — tooling that reads config via libgit2/pygit2/dulwich instead of shelling to `git` misses it entirely. Post-**Clone2Leak** (fixed January 2025, GMO Flatt Security / RyotaK) the script compares the requested URL against `$GITHUB_SERVER_URL` and returns nothing for non-GitHub remotes. `GITHUB_TOKEN` is still present in the environment (which is why `gh` picks it up), but git's own wiring is the helper. (**verified**) |
| **Coder** | `GIT_ASKPASS` pointed at a `coder` binary at `/tmp/coder.<random>/coder` | The OAuth token lives in Coder's **server-side** database, never on disk in the workspace; a workspace can also fetch it with `coder external-auth access-token <ID>`. Supports GitHub App external auth. (**verified**, [coder.com/docs/admin/external-auth](https://coder.com/docs/admin/external-auth)) |
| **DevPod** | A git credential helper injected **over the connection**; SSH agent-forwarding for ssh remotes; kill switch `SSH_INJECT_GIT_CREDENTIALS=false` | Does not copy tokens into the workspace at all. (**verified**) |
| **Gitpod / Ona** | `gp credential-helper get` inside the workspace | Same call-home shape. (**verified**) |
| **Conductor** | PATH-shimmed `git`, `gh` and `git-askpass` + a unix-socket broker; in-sandbox helpers dir `Vtr = "/conductor/bin"` | The public cloud docs independently reserve the `CONDUCTOR_GIT_AUTH_*` env prefix for "Conductor managed Git authentication" — a clean cross-confirmation of the binary strings observed in the teardown (`CONDUCTOR_GIT_AUTH_CONTEXT`, `CONDUCTOR_GIT_AUTH_SOCKET`). |
| **Vercel Sandbox** | `Sandbox.create({ source: { type:'git', url, username:'x-access-token', password: TOKEN } })` | Covers the **initial clone only**. Nothing in Vercel's docs states whether the token persists in the sandbox's git remote for later pushes — verify empirically before relying on push-back. (**verified**) |

The convergent lesson: **the git credential-helper protocol is the right seam, and it is already generic.** It is invoked per remote operation, it is host-keyed, and since 2.40/2.41 it carries expiry and refresh natively. Nobody needs a bespoke refresh loop; they need a helper that mints on demand and declares expiry.

### 6.2 The in-sandbox layout Zeros should write

```
/opt/zeros/bin/                      # helpers dir, prepended to PATH
  ├── git                            # shim → $ZEROS_REAL_GIT_PATH, adds -c credential.* args
  ├── gh                             # shim → $ZEROS_REAL_GH_PATH, injects GH_TOKEN from the broker
  ├── git-askpass                    # GIT_ASKPASS fallback
  └── git-credential-zeros           # the helper proper: talks to the socket
/run/zeros/git-auth.sock             # broker: HTTP over a unix socket, GET only, else 404
```

System gitconfig, written once at sandbox bootstrap by trusted engine code:

```gitconfig
[credential]
    helper =                                         # empty value RESETS the helper list
[credential "https://github.com"]
    helper = /opt/zeros/bin/git-credential-zeros     # host-scoped — ours only
```

Per-invocation env for every git/gh child the engine spawns:

```
ZEROS_GIT_AUTH_CONTEXT = <workspaceId>
ZEROS_GIT_AUTH_SOCKET  = /run/zeros/git-auth.sock
ZEROS_REAL_GIT_PATH    = /usr/bin/git
ZEROS_REAL_GH_PATH     = /usr/bin/gh
GIT_ASKPASS            = /opt/zeros/bin/git-askpass
GIT_TERMINAL_PROMPT    = 0
PATH                   = /opt/zeros/bin:$PATH
```

Five details that are load-bearing rather than cosmetic:

1. **`credential.helper=` with an empty value resets the helper list** (`gitcredentials(7)`, git ≥ 2.9; verified on git 2.50.1 — it clears both `credential.helper` and URL-scoped `credential.<url>.helper` from user config, and bypasses `GIT_ASKPASS` when the helper returns both username and password). This is what stops an inherited helper from silently winning. Note the override covers **helpers only**: `url.<base>.insteadOf`, `http.proxy` and `http.extraHeader` still apply, and `-c` propagation has known gaps for git-lfs and recursive submodules.
2. **Host-scoping is a security requirement.** An unscoped helper offers the GitHub credential to *every* remote, including an attacker-controlled one in a malicious repo's `.gitmodules`. Codespaces' post-Clone2Leak host check is the same lesson learned the hard way. Key on origin host from day one — `credential.https://gitlab.com.helper` has to be a config row, not a rewrite, or retrofitting host-keying means rewriting every gitconfig already written into every existing sandbox.
3. **PATH-shimming `git` and `gh`, not just `GIT_ASKPASS`,** is what covers the agent's *own* shell commands. This matters more than it sounds: Zeros' PR flow hands the agent the push as text — *"Push with `git push -u '<remote>' HEAD:'<branch>'`"* and *"Use `gh pr create --base <base>`"* (`src/shell/pr/pr-instructions.ts:74-80`), reinforced in the system preamble (`packages/core/src/system-instructions/templates.ts:44`). Those run in the agent PTY, outside every `runGit` guard. Shimming PATH is what fixes Phase-0 blocker **B3** without rewriting the agent flow.
4. **`ZEROS_GITHUB_TOKEN` stays, for REST only, and must be deleted from `process.env` after seeding.** Today `buildPtyEnv` copies the engine's whole environment for local (non-scrubbed) shells — `env = { ...src }` (`src/engine/pty/shell-setup.ts:175`) — deleting only `TERM_*`, `ZEROS_PTY_*`, `ELECTRON_RUN_AS_NODE` and `OLDPWD` (`:185-205`). `ZEROS_GITHUB_TOKEN` and `ZEROS_LOCAL_WS_TOKEN` (the engine's loopback `/ws` bearer) survive into every terminal and every agent subprocess. Extend that delete list, and note that the existing test at `src/engine/pty/__tests__/shell-setup.test.ts:35-42` pins "local shells keep the full env (desktop parity)" — the fix has to update that test deliberately.
5. **The env-name denylist stays intact, and there is no collision.** `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_SSH_COMMAND` and the whole `GIT_CONFIG*` prefix are class-1 code-injection names in `src/engine/settings/env-names.ts:61-73,93`, dropped from every settings layer. An implementer *will* be tempted to remove `GIT_ASKPASS` to make the Coder-style mechanism work; that reopens an arbitrary-exec vector from repo-supplied env. It is also unnecessary: the settings env table has exactly two non-test callers, both agent-CLI spawns (`src/engine/agents/gateway.ts:795,856`), and `mergeSpawnEnv` merges settings env **under** `callerEnv` (`src/engine/settings/spawn-env.ts:282-291`), so a Zeros-owned `GIT_ASKPASS` passed as caller env wins. `runGit` never consults the settings table at all — it composes `{ ...process.env, ...opts.env }` (`src/engine/git/git-exec.ts:291`), which is the natural per-invocation seam. (This is worth stating explicitly because an audit finding claiming the two *did* collide was refuted for exactly this reason.)

### 6.3 The bootstrap ordering problem

The very first `git clone` happens before the engine — and therefore the broker — is running. Two ways out:

- **(A) Use the provider's clone-with-credentials API** (`sandbox.git.clone(url, path, branch, commit, 'x-access-token', TOKEN)`, per `08-engineering-reference.md:169`) with a token that is *discarded immediately* and never written to `.git/config`. Then install the helper and let it own every subsequent operation. Simple, but the token crosses the provisioning path as a value.
- **(B) Have `start-engine.sh` install the broker and the system gitconfig *before* cloning**, and let the first clone go through the helper like everything else. One mechanism, one code path, no token in the create() payload at all.

**Recommend (B).** It costs a few lines of bootstrap ordering, it removes a whole class of "where did that token go" questions, and it is the only variant that keeps `docs/cloud-workspace/08-engineering-reference.md:537`'s own warning — *"any secret injected via env/files can be read by a context-injected agent inside the box"* — literally true rather than aspirationally true. It also matters for the *wake* path: a sandbox resumed from a snapshot has a dead token by construction, so re-mint-on-wake must be a first-class step and never a restore.

---

## 7. Teams and shared installations, against migrations 0006/0007

### 7.1 What the control plane already has (all verified in this repo)

| Capability | Where |
|---|---|
| Auth0 JWTs verified locally against a remote JWKS with issuer/audience/alg pinning | `backend/src/auth.ts:71-95` |
| Role re-read from Postgres per request, never trusted from a claim; `owner > admin > member` | `backend/src/authz.ts:1-11,34-49` |
| RLS on every tenant table via `app_user_team_ids()` (`SECURITY DEFINER`), policy shape `team_id IN (SELECT app_user_team_ids())`, plus `FORCE ROW LEVEL SECURITY` | `backend/migrations/0006_org_to_team.sql:105-160`; `0004_rls_enforce.sql` |
| Append-only, team-scoped audit trail written in the same transaction as the mutation | `backend/src/audit.ts:6-17` |
| `staff_role` as a property of the person, orthogonal to team membership, with self-promotion explicitly designed out | `backend/migrations/0007_staff_role.sql:29-66` |
| System-context escape hatch (`app.system`) for paths with no acting user | `backend/src/db.ts:67-75` |
| `/v1/*` middleware chain: wildcard CORS, 256 KB body limit, JWT auth, 240/60 s per-user rate limit — **all path-scoped to `/v1/*`** | `backend/src/index.ts:36-64` |

And what it does not have: **anything GitHub.** A grep across `backend/src` and `backend/migrations` for `github|sandbox|daytona|workspace` returns two incidental comments about GitHub as an Auth0 social login (`backend/src/auth.ts:132,236`). There is no `cloud_workspaces` table, no `workspace_members`, no installation model.

### 7.2 Five design constraints — constraints, not defects

Five audit findings in this area were **refuted**, all on the same ground: they described hypothetical future tables under hypothetical future policies rather than defects in real control flow. That refutation is correct and worth respecting. But every one of them names a decision that has to be made *before* the first row exists, so they belong here as constraints:

| Constraint | Why it matters | What to decide now |
|---|---|---|
| The default policy shape is `team_id IN (SELECT app_user_team_ids())`. A `github_installations(team_id, …)` table under it means **every teammate inherits the installation.** | That is probably right for a *team* installation and definitely wrong for a *personal* one. | Two-axis ownership: `owner_user_id` XOR `team_id`, with a CHECK constraint and two policies, not one. |
| `audit_log.team_id` is `NOT NULL` (`0001_init.sql:107-115`, renamed by `0006:54`), and users may belong to **zero teams** by design (`0005_orgs_optional.sql:8-9`; `/v1/me` returns a possibly-empty `teams` array). | A personal installation's token-mint event has nowhere to be recorded. | Pick before the first mint, because the trail is append-only: either a personal-scope sentinel row or make the column nullable with a matching partial policy. Retrofitting an audit trail is a data migration. |
| `team_settings.doc` is plaintext `jsonb` and **readable by any member** — GET requires only membership, PUT requires admin (`backend/src/routes.ts:437-471`). | It is the obvious place to stash installation metadata, and it is the wrong one. | Installation metadata gets its own table with its own policy. Nothing credential-adjacent in `team_settings`. |
| `org_secrets` — a `ciphertext bytea` + `key_version` table — was **dropped in `0005_orgs_optional.sql:26`** when the shared-secrets vault left the product. | The App private key needs a home, and a DB table is the wrong one. (The refutation is right that 0005 deleted no crypto primitive — the table held a column type, and the envelope-encryption implementation left end-to-end in the same decision.) | Keep the App private key in the platform secret store (env / KMS), read only by the mint path. Do not resurrect a DB vault to hold it. |
| The rate limiter is **per-user, in-memory, fixed-window**, with a header that calls itself "NOT a security boundary" and says "Swap for a shared store if the service ever runs multi-instance" (`backend/src/ratelimit.ts:1-51`). | `POST /v1/github/installations/:id/token` is a credential-issuing endpoint. | A shared-store limiter is a prerequisite for that route specifically, and a per-installation ceiling matters as much as a per-user one. |

Two more, on the shape of the routes:

- **A webhook route is easy and needs its own care.** `/webhooks/github` sits **outside** `/v1/*`, so it inherits none of the CORS / bodyLimit / JWT / rate-limit middleware — which is exactly what you want for HMAC verification over the raw body, and exactly why you must add your own body cap and rate limit there deliberately. Phase 1 can ship with no webhook at all: `GET /user/installations` on settings-open and on Refresh costs roughly **7 REST calls** for a user with 1 personal + 3 org installations and ~250 repos, all ETag-cacheable to zero counted requests. Webhooks (`installation`, `installation_repositories`, `github_app_authorization`) become the freshness and revocation optimisation — and even then must not be the only truth, since `installation_repositories` is reported not to fire reliably on install ([community #193487](https://github.com/orgs/community/discussions/193487)).
- **Authorization for the mint is the one place to be strict.** The caller must be a member of the workspace's team; reuse `authz.ts` + RLS rather than inventing a check; audit every mint in the same transaction. Never trust an `installation_id` supplied by a client — GitHub's own docs warn the setup-URL `installation_id` is spoofable, so re-derive it server-side from a user access token.

### 7.3 The shape to build

```mermaid
erDiagram
    users ||--o{ github_installations : "owner_user_id (personal)"
    teams ||--o{ github_installations : "team_id (shared)"
    github_installations ||--o{ github_installation_repos : "cached selection"
    github_installations ||--o{ audit_log : "every mint"
    cloud_workspaces }o--|| github_installations : "resolves via"
```

`github_installations`: `installation_id`, `account_login`, `account_type`, `target_type`, `repository_selection` (`all|selected`), `suspended_at`, `repository_count`, `last_verified_at`, and exactly one of `owner_user_id` / `team_id`. Every field except the last two is straight off the observed Conductor schema — `{ installationId, accountLogin, accountType, targetType, suspendedAt, createdAt, repositoryCount, repositoryNames[] }` — which is a useful independent signal about what a serious integration actually needs to model. Note what is *not* stored: no installation token (they last an hour; persisting them as durable credentials is a category error), and no private key.

---

## 8. Failure modes

The organising rule, from `RULES.md` and reinforced by every incident below: **never destroy usable state because one read failed.** Only a credential that is provably invalid may be cleared.

| # | Failure | How it presents | Detection | Response |
|---|---|---|---|---|
| 1 | **Sandbox compromised** (agent goal hijack, poisoned dependency, malicious `.gitmodules`) | Nothing — by design | Not detectable from inside | Containment *is* the answer: one repo, ≤ 1 h, `contents`+`pull_requests` only, host-scoped helper. This is why the blast-radius column in §2.2 is the real deliverable. |
| 2 | **Backend unreachable at mint** | First git operation in the sandbox fails | Connection error, not a GitHub status | Distinguish "Zeros backend unreachable" from "GitHub says no" in the error copy. Serve a stale-but-unexpired token if one exists; never clear. |
| 3 | **Backend unreachable at refresh** | Push fails ~1 h into a run | Refresh call fails while a token exists | Serve the stale token and log it (Conductor's exact behaviour). One classifiable 401 beats a silent outage. |
| 4 | **Installation deleted / app uninstalled mid-run** | `POST /app/installations/{id}/access_tokens` → **404** `{"message":"Not Found"}` | 404 on mint only | Terminal state **Disconnected**. Surface it on the workspace, not just in Settings, because the agent is mid-run. |
| 5 | **Installation suspended mid-run** | API calls → **403** with a suspension message | 403 + suspension text | Terminal state **Suspended**, and it is *asymmetric*: whoever suspended must unsuspend — an app owner suspends via JWT `PUT /app/installations/{id}/suspended`; an account owner who suspends in the UI cannot be unsuspended by the app owner. "Suspended by your org owner" is unfixable from inside Zeros and must say so rather than offering a Reconnect button that will never work. |
| 6 | **Repo removed from the installation's selected list** | **404** on the repo — indistinguishable from a typo, a deleted repo, or a repo the user genuinely lacks access to (GitHub returns 404 rather than 403 for private resources to avoid confirming existence) | 404 for a repo the local `origin` clearly points at | Cross-check against the cached installation repo list and render *"this repo isn't in your Zeros App installation"* + a grant affordance. **The highest-leverage UX finding in the evidence base:** `PUT /user/installations/{installation_id}/repositories/{repository_id}` adds a repo to an existing installation **with no browser trip**, using the user access token Zeros already holds — provided the user has *admin* on the repo. Fall back to the `https://github.com/settings/installations/{id}` deep link (or the org variant) only when they don't. Also note org-wide list requests return a **partial 200** listing only accessible repos, not an error. |
| 7 | **Org IP allow list blocks the sandbox** | 403 with *"Although you appear to have the correct authorization credentials, the ORG organization has an IP allow list enabled, and your IP address is not permitted…"* | REST: 403 + that body. **GraphQL: HTTP 200** with the message in `errors[].type = "FORBIDDEN"` — do not gate detection on a status code. Git-over-HTTPS: a `remote:`/stderr string GitHub does not document. | Named error, not a generic clone failure. Two structural notes: the App can declare its own IP allow list and the org can opt in to auto-adding it, but that "only affect[s] requests made by installations of the GitHub App" — it does **not** unblock the desktop user's own user-to-server calls from their home IP. So this argument works only for the cloud leg, and it makes a **stable, allowlistable egress CIDR a hard requirement** on the sandbox provider. We could not establish whether Daytona offers one. |
| 8 | **SAML SSO** | Silent, and in three shapes | 403 + `X-GitHub-SSO: required; url=…` (URL expires in **one hour**, so mint it at click time, not render time); **404** instead of 403 for private resources; and — worst — **200 OK with silently missing data** plus `X-GitHub-SSO: partial-results; organizations=21955855,20582480` on list endpoints | Parse the header on *every* response, both shapes. This directly threatens `listGithubOwners()` (`src/engine/git/github.ts:909-930`) and any repo picker: a user's work org can be silently absent from a **successful** response, which under keyed-read semantics gets cached as a valid confirmed snapshot. Render "N organizations hidden — authorize SSO", never a clean empty list. Note that a silent token refresh will **not** fix SSO-invisible org resources: the documented fix is start the SSO session, **revoke** the app authorization, then re-authorize. |
| 9 | **GitHub-side transient 401s** | Push and API failures with no local cause | Two dated incidents (§4.3) | N consecutive failures plus a successful control request before clearing anything. |
| 10 | **Rate limits** | 403 or 429, sometimes with no `Retry-After` | `x-ratelimit-remaining: 0`, `retry-after`, or *"You have exceeded a secondary rate limit"* | Installation tokens get a private budget (5,000/hr base, +50/hr per repo over 20 and +50/hr per user over 20 for non-GHEC installs, capped at 12,500; 15,000 flat for GHEC) — a real win over the user-to-server bucket, which is **shared with every other GitHub App the user has authorized**. But secondary limits bite regardless: **no more than 100 concurrent requests** shared across REST and GraphQL, 900 points/min REST, 80 content-generating requests/min. Zeros fans out `getPr`/`getPrChecks`/`getPrCommits`/`getPrReviews` per workspace across N worktrees; cap in-flight requests well under 100 and back off exponentially without depending on `Retry-After`. Conditional requests are free (a 304 doesn't count) — non-negotiable in the Octokit wrapper. |
| 11 | **Token format / length** | Storage truncation, redaction misses, regex failures | — | `ghs_APPID_JWT`, ~520 chars, variable, contains dots. Fields ≥ 600. Redaction for `ghs_`/`ghu_`/`ghr_` **and** JWT shapes shipped before first use. |
| 12 | **`workflows: write` tension** | Push rejected when the diff touches `.github/workflows/` | GitHub rejects the push | A coding agent *will* hit this — and `workflows: write` is also a predictable org-admin adoption blocker (Codex asks for it and gets refused; Devin asks for ~18 permission categories; Anthropic ships with 3 actively used and marks the rest "requested but not yet actively used"). There is no clean resolution: either request it and lose some installs, or omit it and fail some pushes with a specific, honest error. **Decide explicitly and state the choice in the permission table** — do not let it be discovered in the field. |
| 13 | **Wrong permission, not wrong repo** | 403 *"Resource not accessible by integration"* | The `X-Accepted-GitHub-Permissions` response header names exactly what the endpoint needs | Surface that header verbatim in the diagnostics view. Cheapest support-ticket deflection available: it turns "it says resource not accessible" into "your install is missing `pull_requests:write`". |

One cross-cutting warning, because it invalidates the obvious health readout: **app-level grants ≠ token-level grants.** Cursor's cloud agent injects an installation token minted narrower than the app's grants — `git push` works, `POST /issues` returns 403 "Resource not accessible by integration" even though the org granted Issues: Read & write, and Cursor staff confirmed this as a known limitation (**likely**). A "✓ All repositories accessible" line computed from the app's *declared* permissions would be a lie. Derive it from the `permissions` object returned by the mint call, or from a live probe — and for the cloud path, probe the **git** leg (mint a credential and run `git ls-remote`), not just `GET /user`. Zeros already ships the green-checkmark-but-push-fails bug locally (`src/engine/git/github.ts:898`); it should not ship a cloud version of it.

---

## 9. Industry cross-reference

| Product | Real credential in the box? | Delivery | Lifetime | Scope | Push? |
|---|---|---|---|---|---|
| **GitHub Codespaces** | Yes | Credential **helper** in the system gitconfig (`/usr/local/etc/gitconfig`) | New token per create *and* per restart; **duration unpublished** | Source repo read or read/write by default; widened by `customizations.codespaces.repositories` with an explicit consent prompt | Yes |
| **Gitpod / Ona** | Yes | `gp credential-helper get` | Session | Provider OAuth scope | Yes |
| **Coder** | Yes (in memory) | `GIT_ASKPASS` → `coder` binary; token in the **server** DB | OAuth token lifetime | External-auth provider config; supports GitHub App | Yes |
| **DevPod** | **No** | Helper injected over the connection; ssh-agent forwarding | Host's | Host's | Yes |
| **Vercel Sandbox** | Yes | `Sandbox.create({ source: { type:'git', username:'x-access-token', password } })` | Whatever you pass — **its own guide recommends App installation tokens (1 h) for multi-tenant platforms** | Yours to scope | Initial clone documented; push-back undocumented |
| **Daytona** | Yes on the `git.clone` path; **No** on the Secrets path | Per-operation username/password, or placeholder + egress-proxy substitution | Yours | Per-secret host allowlist | Yes (proxy path untested for git) |
| **Fly.io Sprites** | **No** (Connectors) | OAuth gateway at `api.sprites.dev/v1/gateway/...` | Gateway-managed | Policies by sprite prefix / label / endpoint | Via the gateway |
| **Modal** | No, on the sidecar recipe | Caddy sidecar on the private network | — | — | — |
| **E2B** | Yes | `password: process.env.GITHUB_TOKEN` | Yours | Yours | Yes |
| **Claude Code cloud** | **No** | Scoped credential + validating egress proxy | n/a | Proxy enforces repo **and** branch | Yes, **working branch only** |
| **Cursor cloud agent** | Yes | Injected installation token | 1 h | Installation, minted narrower than app grants | Yes |
| **GitHub Copilot coding agent** | Ephemeral Actions env | Actions token | Job | No org/repo Actions secrets; pushes only to `copilot/*`, never default branch | Yes |
| **Conductor** | Yes | In-sandbox broker + PATH shims (`/conductor/bin`); `CONDUCTOR_GIT_AUTH_*` reserved | 1 h installation tokens, refreshed at T−60 s | Installation | Yes |

The four cross-references that should actually change Zeros' design:

**Codespaces is the model for *how*, not *what*.** Two transferable specifics: a helper in the system gitconfig rather than an env var (because the helper is re-invoked and can re-mint), and `customizations.codespaces.repositories` as the model for per-repo scoping UX — a declarative, repo-committed permission request, an explicit one-time consent prompt, a decision GitHub *remembers* and re-prompts only when the permission set changes, and a documented "Continue without authorizing" degraded path the client must handle. Also worth internalising: even the reference implementation **refuses to promise a token lifetime**. GitHub's wording is "an automatic expiry period" sized for "a typical working day", with no number, and it reserves the right to change it. Treat sandbox credentials as opaque-lifetime and expiry-driven. (Do not confuse this with the one duration GitHub *does* publish on the same page — private forwarded ports use auth cookies with a 3-hour expiry.)

**Coder, DevPod and Gitpod prove the call-home-helper pattern in production** across three independent products. That is why option (c) is architecturally sound even though Zeros rejects it on the closed-laptop promise — and why option (d), the same mechanism pointed at the backend instead of the Mac, is low-risk rather than novel. Coder also supplies the clearest anti-pattern: deleting the stored token on a single refresh failure (§4.3).

**Vercel is direct external support for the founder's framing.** The platform Conductor actually runs on tells its own customers to use App installation tokens for multi-tenant platforms and fine-grained PATs only for individuals. That is a primary source saying "don't forward the user's PAT into a rented VM", and it is stronger evidence than any inference about what Conductor does — because Conductor's own credential-delivery mechanism inside Vercel Sandbox is **not publicly documented**.

**Claude Code is the strongest posture and the honest ceiling.** The proxy validates the git interaction itself — repository destination *and* that the push targets the session's working branch — before attaching the real token; GitHub API and release-asset requests reach only repositories attached to the session (unattached repos 403); and this operates independently of the environment's network access level. Two caveats keep it from being a free win. First, the guarantee covers **proxy-managed** credentials only: if a user sets `GH_TOKEN` or `GITHUB_TOKEN` themselves it "passes through to the container unchanged", cloud environments have no dedicated secrets store, and the config dialog warns anyone using the environment can read the values. Left unset, both variables read as the literal placeholder `"proxy-injected"`. Second, **the proxy is GitHub-only**: GitLab, Bitbucket and other non-GitHub remotes can reach a cloud session only as a local git bundle (CLI-only, ≥ 1 commit, < 100 MB, untracked files excluded), and "the session can't push results back to the remote". Even the frontier implementation has not generalised the cloud path beyond GitHub — which makes Zeros' host-neutral seam a genuine differentiator, provided the credential-delivery layer is the generic thing from day one.

One last framing borrowed from **Netlify**, the best available reference for "three providers, one surface": you do not unify the auth *mechanism*, you unify the *outcome*. Netlify uses the Netlify GitHub App for all new GitHub sites and plain OAuth2 for GitLab and Bitbucket, and publishes the rationale Zeros needs almost verbatim — App installs "handle repository access with generated, limited-scope tokens that expire after one hour", need no deploy keys or webhooks, and let bot comments post without a user PAT. GitLab and Bitbucket have **no installation concept at all**. So "per-repo scoping" is a GitHub-only capability, and the provider seam must model it as a capability flag rather than a shared concept.

---

## 10. What we could not establish

Stated plainly, because each of these is load-bearing for something above.

1. **Whether installation access tokens are subject to per-user SAML SSO authorization.** GitHub's dedicated "SAML and GitHub Apps" page covers install visibility and *user*-token authorization only, and says nothing about server-to-server tokens. The strong prior — and the reason every CI vendor uses Apps — is that they are **not** session-bound, because the installation itself was approved by an org owner. There is one unresolved counter-report ([anthropics/claude-code#28738](https://github.com/anthropics/claude-code/issues/28738), Feb 2026, closed as not planned, no maintainer reply) alleging an org-level installation acting on SSO-protected repos where the user had never SSO-authorized. **This is the single unknown that could invalidate the cloud architecture.** Test it against a real SAML-enforced org before committing. Mitigation regardless: scope every sandbox token to a single repository via `repository_ids`, so the blast radius is *provably* one repo and can be stated as such to a security reviewer.
2. **Whether Daytona's placeholder-substitution proxy can carry git-over-HTTPS.** The documented mechanism inspects request headers and the worked example is `api.github.com`; git sends its credential base64-encoded inside `Authorization: Basic`. Unknown. One-day spike (§2.4).
3. **Whether Zeros' cloud sandboxes can egress from a stable, allowlistable CIDR** on Daytona. Required for enterprise customers with org IP allow lists (§8 row 7). Not established.
4. **Where Conductor mints its sandbox token.** The teardown proves the broker runs *in* the sandbox (`Vtr = "/conductor/bin"`, `P1t = "__conductor_workspace_owner__"`) and the public docs independently reserve `CONDUCTOR_GIT_AUTH_*`. But their own env-vars page says Conductor "reads settings when it creates the cloud workspace and **sends a snapshot to the sandbox**", with local-machine secrets riding along — which points at a client-originated push, not server-side derivation. Control plane vs forwarded-from-the-Mac is **undocumented**. Do not cite Conductor as evidence for a specific minting architecture; cite Vercel's KB recommendation, which is primary and says the same thing.
5. **The Codespaces `GITHUB_TOKEN` lifetime in hours.** GitHub deliberately declines to publish it.
6. **Conductor's GitHub App slug and requested permission set.** The Tauri webview assets are compressed inside the Rust binary and no `github.com/apps/<slug>` URL appears in plaintext; `appSlug` exists as a field but its values are server-supplied.
7. **Whether Vercel Sandbox's clone credential persists in the sandbox's git remote** for later pushes. Vercel's docs are silent; verify empirically before relying on push-back.
8. **No product publicly documents OIDC-style token exchange for *git* credentials.** OIDC federation is ubiquitous for cloud APIs; for git-over-HTTPS there is no counterparty at GitHub. Zeros' "sandbox presents a per-workspace secret, backend mints an installation token" *is* a token exchange, but calling it OIDC in a design doc would be inaccurate.

---

## 11. Divergences from the authoritative spec, and how to read this evidence

Flagged here for part 10 rather than quietly absorbed.

1. **Addition, not contradiction: git's native expiry protocol.** `.context/architecture-decision.md` specifies T−60 s plus reported-401 refresh. That is correct and should ship. But `password_expiry_utc` (git ≥ 2.40) makes git itself refuse a stale credential and re-ask, which removes an entire class of race between the broker's clock and git's. The helper should emit it (`exp − 300 s`). Cost: one line.
2. **The sandbox should call the *backend*, not the Mac.** The spec says the sandbox's token is "delivered over the existing control connection". Two reasons to be precise about which connection: `GITHUB_TOKEN_SET` is local-clients-only by deliberate design (`src/engine/index.ts:1781`) and `broadcastLocal` filters out `kind: "cloud"` peers — guards that exist so a remote peer can neither inject nor harvest the owner's credential, and that a refuted audit finding proposed removing. And a Mac-sourced token dies when the laptop closes, which is the product's headline promise. Sandbox → backend, over the sandbox's own authenticated channel.
3. **Two `area_summaries` entries in `evidence-confirmed.json` are pre-refutation prose.** The `cloud-workspace-credentials` summary asserts that `ZEROS_GITHUB_TOKEN` "is read exactly once at boot so there is no re-mint channel" and that `GITHUB_TOKEN_SET`'s local-only gate blocks the Mac from couriering a token. Both were filed as findings and both were **refuted**: two live mid-session re-seed paths exist (`src/engine/index.ts:4048-4058`, `:1778-1781`), and the desktop courier does not use `GITHUB_TOKEN_SET` at all (it uses the spawn env plus a stdin control line). The *conclusion* — env delivery cannot serve git transport — survives; the stated mechanism does not. Anyone mining the summaries for design input should cross-check against `refuted_findings`.
4. **Same pattern for the `GIT_ASKPASS` "collision".** Confirmed as a fact (it is on the denylist, `src/engine/settings/env-names.ts:69-70`), refuted as a design obstacle (the settings env table was never on git's environment path). Keep the denylist; the broker does not need it lifted (§6.2, note 5).
5. **Phase 3 may be partly buyable.** The spec lists "no credential proxy that keeps tokens wholly out of the sandbox" under *what we explicitly do not build*. Given Daytona Secrets and Fly Connectors (§2.4), the honest phase-3 entry is "spike the provider's proxy for git-over-HTTPS, then decide build-vs-configure" — not "build a proxy".
6. **Deploy keys are evaluated here for the first time.** They appear nowhere in `docs/cloud-workspace/`, nowhere in `backend/`, nowhere in the engine. Rejected (§2.2), with the private-ssh-submodule exception documented.
7. **Provenance, stated because it matters.** The architecture in `.context/architecture-decision.md` is **one author's synthesis** of the verified evidence base — the design panel and the report critics were cut for time, so it is not a panel consensus. The evidence under it is stronger than that: 17 agents produced findings and claims, then 220 independent agents each tried to refute one finding or fact-check one claim. **52 of 109 verified audit findings survived (a 52% kill rate); 188 of 207 claims survived.** In this section specifically, the refutations changed four substantive things — the spike-vs-product distinction, the env-var re-seed mechanism, the `GIT_ASKPASS` non-collision, and the existence of provider-native credential proxies. Where a claim below is tagged **likely** or **unverified**, that tag is the finding, not a hedge.

---

## Sources

**GitHub — primary**

- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app — mint flow, 1 h lifetime, `repositories`/`repository_ids` ≤ 500 mutually exclusive
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation — installation token as the git HTTPS password, `x-access-token`, Contents permission
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user — user-token permission intersection, attribution to the user
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens — 8 h / 6 mo, single-use refresh token
- https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/ · https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/ — `ghs_APPID_JWT`, ~520 chars, staged from 2026-04-27
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api · https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api — installation vs user-to-server budgets, secondary limits, `X-Accepted-GitHub-Permissions`
- https://docs.github.com/en/rest/apps/apps · https://docs.github.com/en/rest/apps/installations — JWT-only installation-resolution endpoints; `PUT /user/installations/{id}/repositories/{repo_id}`
- https://docs.github.com/en/apps/maintaining-github-apps/suspending-a-github-app-installation — asymmetric suspend/unsuspend
- https://docs.github.com/en/apps/using-github-apps/saml-and-github-apps · https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/authorizing-a-personal-access-token-for-use-with-single-sign-on — SSO session semantics, `X-GitHub-SSO` shapes
- https://docs.github.com/en/enterprise-cloud@latest/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/managing-allowed-ip-addresses-for-your-organization · https://docs.github.com/en/apps/maintaining-github-apps/managing-allowed-ip-addresses-for-a-github-app — IP allow lists; installations-only effect
- https://github.blog/changelog/2025-12-01-block-repository-admins-from-installing-github-apps-now-generally-available/ · https://github.blog/changelog/2025-12-22-control-who-can-request-apps-for-your-organization/ — orgs can block install *and* request
- https://docs.github.com/en/codespaces/reference/security-in-github-codespaces · https://docs.github.com/en/codespaces/troubleshooting/troubleshooting-authentication-to-a-repository · https://docs.github.com/en/codespaces/managing-your-codespaces/managing-repository-access-for-your-codespaces — new token per create/restart, unpublished lifetime, helper wiring, `customizations.codespaces.repositories`
- https://docs.github.com/en/webhooks/webhook-events-and-payloads — `installation`, `installation_repositories`, `github_app_authorization`

**Git**

- https://git-scm.com/docs/git-credential · https://git-scm.com/docs/gitcredentials — `password_expiry_utc` (2.40), `oauth_refresh_token` (2.41), `capability[]=state` + `continue=1` (2.46), empty-value helper reset
- https://github.com/git-ecosystem/git-credential-manager/issues/2057 — GCM has not implemented `state[]`

**Sandbox and dev-environment vendors**

- https://vercel.com/kb/guide/sandbox-private-github-repositories — recommends App installation tokens for multi-tenant platforms (2026-05-26)
- https://vercel.com/docs/sandbox · https://vercel.com/docs/sandbox/concepts/persistent-sandboxes · https://vercel.com/docs/sandbox/pricing — 24 h session cap, filesystem-only snapshots, 30-day expiry
- https://www.daytona.io/docs/en/secrets/ — placeholder + egress-proxy substitution, host allowlists, rotation without recreation
- https://www.daytona.io/docs/en/git-operations/ — per-operation clone credentials; *"Credentials are stored in plaintext on disk"*
- https://docs.sprites.dev/concepts/connectors/ — Fly Sprites OAuth gateway (2026-03-03), "Sprites never see the token"
- https://github.com/modal-labs/credential-injection — Caddy sidecar recipe
- https://github.com/e2b-dev/E2B/issues/1160 · https://e2b.dev/docs/agents/codex — E2B: plain env vars, brokering unimplemented
- https://coder.com/docs/admin/external-auth — `GIT_ASKPASS` mechanism, server-side token storage, GitHub App external auth
- https://github.com/coder/coder/issues/18811 · https://github.com/coder/coder/issues/17069 · https://github.com/coder/coder/issues/26036 — refresh-failure deletes the token; git hangs; `GIT_ASKPASS` still live
- https://devpod.sh/docs/developing-in-workspaces/credentials · https://ona.com/docs/classic/payg/authentication/overview — helper over the connection; `gp credential-helper get`

**Agent products**

- https://www.anthropic.com/engineering/claude-code-sandboxing · https://code.claude.com/docs/en/claude-code-on-the-web — scoped credential + validating proxy, branch restriction, `GH_TOKEN` passthrough, GitHub-only, bundle fallback, IP-allowlist incompatibility
- https://www.conductor.build/docs/cloud-beta/environment-variables — *"git and gh are already authenticated inside the sandbox. Do not copy GitHub tokens into cloud environment variables."*; `CONDUCTOR_GIT_AUTH_*` reserved prefix
- https://www.conductor.build/changelog/0.77.0-early-access-multiplayer-api-background-tasks-performance — "Cloud workspaces now honor the GitHub credential selected in Settings" (2026-07-23)
- https://www.conductor.build/changelog/0.0.21-fine-grained-github-permissions · https://news.ycombinator.com/item?id=44628912 — the OAuth-`repo`-scope backlash and the App switch (July 2025)
- https://docs.netlify.com/build/git-workflows/repo-permissions-linking/ · https://docs.netlify.com/build/git-workflows/self-hosted-git/ — App for GitHub, OAuth2 for GitLab/Bitbucket; the 1-hour-token rationale; deploy keys still needed for private ssh submodules
- https://github.com/orgs/community/discussions/179983 · https://github.com/microsoft/vscode/issues/314311 · https://github.com/orgs/community/discussions/194075 — squash-merge attribution; the `git.addAICoAuthor` episode and its reversion
- https://github.com/actions/create-github-app-token/issues/172 — the `%5Bbot%5D` encoding trap

**Security**

- https://genai.owasp.org/ — OWASP Top 10 for Agentic Applications 2026 (2025-12-09), ASI01 Agent Goal Hijack
- CVE-2026-22708 (Cursor; reported 2025-08-11, fixed in 2.3, January 2026) — env-var poisoning via trusted shell built-ins
- https://generalanalysis.com/ · https://simonwillison.net/ — the Supabase MCP token-exfiltration **proof of concept** (July 2025)
- https://pulsetic.com/status/github/incidents/3972/ · https://blog.incidenthub.cloud/github-reliability-outage-history-2025-2026 — installation-token auth failures 2026-05-23 and 2026-02-17

**Internal**

- `.context/architecture-decision.md` (authoritative spec, 2026-07-29) · `.context/conductor-teardown-2026-07-29.md` (first-hand teardown of Conductor 0.77.5) · `.context/evidence-confirmed.json` (52 confirmed findings, 188 confirmed claims, and — read alongside them — 57 refuted findings and 19 refuted claims)
- `docs/cloud-workspace/README.md` · `01-cloud-workspaces-explained.md` · `02-how-conductor-does-it.md` · `03-cursor-and-claude-code-cloud.md` · `05-sync-teams-and-collaboration.md` · `07-execution-plan.md` · `08-engineering-reference.md`
- Code, all citations verified by opening the file: `src/engine/index.ts` · `src/engine/transport/cloud.ts` · `src/engine/git/{github,ops,git-exec,engine-token-store,init-clone}.ts` · `src/engine/pty/shell-setup.ts` · `src/engine/settings/{env-names,spawn-env}.ts` · `src/shell/pr/pr-instructions.ts` · `electron/sidecar.ts` · `backend/src/{index,auth,authz,audit,db,ratelimit,routes}.ts` · `backend/migrations/{0001,0004,0005,0006,0007}*.sql` · `scripts/cloud-spike/{config.ts,Dockerfile,README.md}`
