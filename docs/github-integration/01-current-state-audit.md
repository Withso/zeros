# Current State — What Zeros Does Today

*Part 01 of the Zeros GitHub Integration Report · July 2026*

This is an evidence-cited teardown of the GitHub integration as it exists in the tree at
`aaed7dd`. Every code claim below was re-opened and verified at the cited `path:line` before
it was written down. External claims are tagged **verified** / **likely** / **unverified**
with links. The audit behind it is described in §11 — including what it got wrong.

## The short version

- **There is one credential slot and no record of how it was filled.** The durable store is a
  single safeStorage entry `github_oauth` in `<userData>/secrets.json`
  (`electron/main.ts:1116-1131`). The three auth paths — `gh auth token`, a pasted PAT, and the
  device flow — all write that one string. The only "which method" signal is a `viaCli` boolean
  living in an in-memory renderer cache (`src/zeros/store/read-caches.ts:19-23,49`), so a
  gh-CLI user is relabelled "Connected to GitHub" on the next launch and stays mislabelled for
  the session.
- **The stored token is REST-only. It never reaches git transport.** Not one of the engine's
  network-touching git invocations passes a credential, a helper, an askpass, or a rewritten
  remote. `runGit` merges `opts.env` over `process.env` only when a caller supplies env
  (`src/engine/git/git-exec.ts:291`), and the only callers that do are the per-turn index
  snapshot and commit-author stamping. `git push` genuinely depends on the user's own
  credential helper — the code says so: *"The push relies on the user's git credential helper
  (gh)"* (`src/engine/git/github.ts:898`).
- **gh-CLI users work by coincidence, not by design.** `detectGhCli()` shells `gh auth token`
  and adopts the result (`src/engine/git/github.ts:232-260`). A machine with `gh auth login`
  has *both* an API token Zeros can read *and* a git credential helper git can use — the two
  systems coincide only on that one path. PAT and device-flow users get a green "Connected"
  badge over a dead write path.
- **A 403 deletes the user's credential, by two independent routes.** `isAuthError()` returns
  `status === 401 || status === 403` (`src/engine/git/github.ts:393`), and both
  `getAuthStatus()` (`:209-214`) and `withAuthRetry()` (`:497-501`) respond with
  `tokenStore.clear()`. In Electron main that is `deleteSecret("github_oauth")` directly
  (`electron/main.ts:1128-1130`); in the engine it fires `GITHUB_TOKEN_CHANGED` →
  `gh_token_clear` → the same delete. A rate limit, a SAML-SSO prompt, an IP-allowlist denial
  or one missing fine-grained-PAT permission erases the token.
- **"Create PR" — the product's primary GitHub write — never touches Zeros' token.** The
  button sends the agent a text brief telling it to run `git push` and `gh pr create`
  (`src/shell/pr/create-pr-button.tsx:95-140`, `src/shell/pr/pr-instructions.ts:74-80`), and
  the same instruction is injected into the first turn of *every* chat
  (`packages/core/src/system-instructions/templates.ts:44`). `ghPrCreate`
  (`src/native/git.ts:1022`) has zero renderer callers — a dead export over a working engine op.
- **Cloud workspaces have no GitHub credential at all, and three engine mechanisms block the
  documented plan.** `GITHUB_TOKEN_SET` is accepted from `kind:"local"` clients only
  (`src/engine/index.ts:1781`); `ZEROS_GITHUB_TOKEN` is read exactly once at boot (`:1125-1127`);
  and the change notifier goes out via `broadcastLocal`, which a cloud peer never receives
  (`:1110-1119`). The spike image installs no `gh` and no credential helper
  (`scripts/cloud-spike/Dockerfile:29-32`).
- **The codebase is not starting from zero, and this report should not read as if it is.** The
  H4 token-courier threat model is real and mostly implemented (`gh_token_get` is *gone*;
  `github_oauth` is denied to the renderer keychain bridge). `review-provider.ts` is a
  correctly-shaped seam. `GitError` carries `code` + `remediation` + a `toJSON` that
  deliberately never exposes the cause object. `KeyedAsyncCache` structurally obeys the
  AGENTS.md retain-while-revalidating rule. `src/engine/git/github.ts` ships six `*ForTesting`
  injection seams. See §8.
- **Coverage is the weakest link and it is weakest exactly where the bug is.** GitHub auth has
  one real test file (23 tests, `src/engine/git/__tests__/github.test.ts`). Both push tests
  push to a **local bare repo** (`publish-github.test.ts:3`, `ops.test.ts:104`), which needs no
  credential — so the transport gap is structurally invisible to CI.

---

## 1. The shape of it: an implicit fallback chain into one slot

`src/zeros/panels/github-section.tsx:4-11` states the design in its own header comment: *"One
connection surface, three auth paths (in preference order)"* — gh CLI first (primary), pasted
PAT second, device flow third. That precedence is expressed as control flow inside a read
fetcher, not as a stored user choice.

```mermaid
flowchart TD
  R["Settings → Integrations → GitHub<br/>github-section.tsx read fetcher"] --> A["ghAuthStatus()"]
  A -->|"authenticated"| OK["render Connected<br/>viaCli = previous?.viaCli ?? false"]
  A -->|"not authenticated"| B["ghDetectCli()"]
  B -->|"gh auth token works"| ADOPT["tokenStore.set(gh token)<br/>github.ts:249 — a WRITE inside a READ"]
  B -->|"no gh / not logged in"| C["render disconnected card"]
  C --> PAT["paste PAT → ghSetToken → tokenStore.set (github.ts:270)"]
  C --> DEV["Connect with GitHub → device flow → tokenStore.set (github.ts:340)"]
  BOOT["engine boot, no couriered token<br/>src/engine/index.ts:1137-1148"] --> B2["detectGhCli() → engine in-memory set"]
  ADOPT --> SLOT[("safeStorage github_oauth<br/>ONE slot, no method, no expiry")]
  PAT --> SLOT
  DEV --> SLOT
```

Four independent writers reach that one slot, and two of them write as a side effect of a
read:

| Writer | Where | Notes |
|---|---|---|
| `detectGhCli()` from the Settings read fetcher | `github-section.tsx:100` → `github.ts:249` | Persists as a side effect of probing. No compare-and-swap. |
| `setToken()` (pasted PAT) | `github.ts:270` | Verifies via `/user` first. |
| `startDeviceFlow()` | `github.ts:340` | Unconditional `tokenStore.set` after up to ~15 min of polling. |
| `detectGhCli()` from engine boot | `src/engine/index.ts:1137-1148` | Gated on the engine store being empty; writes the engine's **in-memory** copy only. |

Consequences that matter for the picker, each confirmed:

- **Sign-out is not durable for gh-CLI users, via two independent re-adoption sites.**
  `doSignOut` clears safeStorage, then deliberately calls `refresh()` with the comment *"Re-probe:
  matches the old flow, where an authenticated gh CLI is rediscovered (and re-adopted) after an
  explicit sign-out"* (`github-section.tsx:164-179`). The fetcher's unauthenticated branch
  re-adopts. Even if that line were deleted, the engine re-adopts at every boot
  (`src/engine/index.ts:1137-1148`). There is no reachable "disconnected" state on a machine with
  `gh auth login`.
- **A PAT can be silently replaced by a different identity.** When `getAuthStatus()` sees a
  401 *or a 403* it clears the token and returns unauthenticated; the fetcher then falls
  through to `ghDetectCli()` and adopts whatever `gh` returns — frequently a different account
  with broader scope. The card *does* flip its headline from "Connected to GitHub" to "GitHub
  CLI is authenticated and ready" (`github-section.tsx:203-210`), so it is not invisible, but
  there is no consent prompt, no "your token expired" notice, and no signal outside Settings.
- **A narrow race can clobber an explicit choice.** `detectGhCli`'s `gh auth token`
  subprocess has a 5 s timeout ceiling (`github.ts:235-237`) and its `tokenStore.set` is
  unconditional, so a `ghSetToken` completing inside that window is overwritten. Reachable only
  after an explicit sign-out or a manual Refresh while signed out — but reachable.

### The baked OAuth App

```ts
const DEFAULT_CLIENT_ID = "Ov23lityKSllg4mxOQCl";      // src/engine/git/github.ts:90
// startDeviceFlow, github.ts:317-319
clientType: "oauth-app",
scopes: opts.scopes ?? ["repo", "read:org"],
```

`clientType: "oauth-app"` is authoritative in-repo evidence that this is a **classic OAuth
App**, not a GitHub App: there is no installation object to migrate and no per-repo consent to
inherit. (Community sources associate the `Ov23li` prefix with OAuth Apps and `Iv1.`/`Iv23li`
with GitHub Apps, but no official GitHub page documents that convention — **unverified**; the
`clientType` argument settles it anyway.) The id is overridable via `ZEROS_GITHUB_CLIENT_ID`
(`:93-97`), and a `PLACEHOLDER_RE` gate turns a stripped build into a clear
`NOT_AUTHENTICATED` instead of a confusing GitHub-side rejection (`:302-315`) — a small,
genuinely thoughtful touch.

Two properties of the scope set are load-bearing for later parts. `repo` is
all-or-nothing across every repository the user can reach, and nothing in the codebase ever
reads the `x-oauth-scopes` response header (grep: zero hits) or probes a repository. All four
validation sites — `getAuthStatus:206`, `detectGhCli:248`, `setToken:269`,
`startDeviceFlow:344` — call `users.getAuthenticated()`, an endpoint a zero-permission
fine-grained PAT passes. **"Connected to GitHub" is a claim about identity and never about
capability.**

---

## 2. The token lifecycle: the "option B / H4" courier

The courier is the part of this system that was designed rather than accreted, and it deserves
to be described precisely before it is criticised.

```mermaid
sequenceDiagram
  participant KC as macOS Keychain<br/>"&lt;AppName&gt; Safe Storage"
  participant M as Electron main<br/>(secret-store.ts)
  participant E as Engine sidecar<br/>(bun)
  participant R as Renderer

  Note over M: main is the ONLY durable owner
  M->>KC: safeStorage.encryptString → secrets.json["github_oauth"]
  M->>E: spawn env ZEROS_GITHUB_TOKEN (sidecar.ts:1191-1196)
  M->>E: stdin {"type":"host.githubToken",token} (sidecar.ts:1524-1540)
  E->>E: seedGithubToken() → in-memory only (engine-token-store.ts:38-40)
  E-->>R: GITHUB_TOKEN_CHANGED (broadcastLocal, index.ts:1109-1117)
  R->>M: gh_token_clear  (github-token-sync.ts:33-41 — only when token == null)
  M->>KC: deleteSecret("github_oauth")
```

**Where the durable secret lives.** One safeStorage-encrypted entry, account `github_oauth`,
base64 inside `<userData>/secrets.json` (`electron/secret-store.ts:11-19`). Writes are
atomic (tmp + rename) and, crucially, *merge rather than clobber*: `setSecret` re-reads under a
cross-process `O_EXCL` lockfile so a sibling dev worktree's concurrently-written keys survive
(`electron/secret-store.ts:88-152`). Channel isolation falls out of `app.getName()` being
pinned to the channel display name (`electron/main.ts:212-222`), which derives both the
keychain key and the userData path — so Dev/Alpha/Beta/Stable are four separate credential
stores.

Two limits on that store are worth naming now because a 1-hour installation token breaks the
premise they were written under. The lock **proceeds unlocked after 5 s rather than hanging**
(`secret-store.ts:115`), and its own comment justifies the whole-file read-modify-write with
*"mutations are rare (login only)"*. And the directory watcher that forwards
`auth-store-changed` to the renderer (`secret-store.ts:203-241`, wired at
`electron/main.ts:1187-1192`) fires on every rewrite, so an hourly refresh would fan a signal
into every dev worktree.

**What safeStorage does and does not guarantee.** It delegates to Chromium's OSCrypt: on
macOS a random 128-bit password in a Keychain item named `<AppName> Safe Storage`, from which
the AES-128-CBC key is derived by PBKDF2-HMAC-SHA1 (fixed salt `saltysalt`, 1003 iterations);
the IV is hardcoded to 16 spaces, so identical plaintext yields identical ciphertext under one
key — **likely** ([Electron
docs](https://www.electronjs.org/docs/latest/api/safe-storage), [May-2026
teardown](https://chenguangliang.com/en/posts/blog169_electron-credential-storage-security/)).
The protection is **inter-app, not intra-app**: child processes, dynamically loaded libraries
and injected code are all treated as the app itself, so a malicious npm dependency inside the
main process can decrypt silently — **likely**, same sources. That is the correct frame for
judging the leaks below: they are not the difference between safe and unsafe, they are the
difference between "one process holds it" and "every child does".

**The H4 invariant, and where it holds.** `src/zeros/bridge/github-token-sync.ts:7-17` states
it: the renderer no longer fetches the decrypted token, `gh_token_get` was **removed
outright**, and main couriers the value straight to the engine. That is real and verifiable —
the renderer-facing `pushGithubTokenToEngine()` is a documented no-op kept for call-site
compatibility (`:22-28`), the actual courier is the main-process function in
`electron/sidecar.ts:1524-1540`, and `github_oauth` is explicitly denied by the renderer
keychain bridge (`electron/keychain-accounts.ts:10-20`).

**Where the courier leaks.** Three holes, all confirmed, all narrower than first reported:

| Leak | Mechanism | Refined scope |
|---|---|---|
| Plaintext token in every local terminal and agent subprocess | `extraEnv.ZEROS_GITHUB_TOKEN` (`electron/sidecar.ts:1195`) lands in the engine's `process.env`; `buildPtyEnv` spreads it whole for local shells (`src/engine/pty/shell-setup.ts:166-176`, deleting only five names at `:185-205`); agents inherit via `stdio-process.ts:62` | Only for engines **spawned while a token already exists** — a mid-session sign-in arrives on stdin and does not mutate `process.env`. So "every session after the first sign-in". `ZEROS_LOCAL_WS_TOKEN` (`sidecar.ts:1188`) leaks by the identical route, unconditionally, and it is the engine's loopback `/ws` bearer. The full-env policy is *pinned by a test* (`src/engine/pty/__tests__/shell-setup.test.ts:35-42`), so the fix must update it. |
| `GITHUB_TOKEN_CHANGED` carries the token **value** to local clients | `broadcastLocal(createMessage({type:"GITHUB_TOKEN_CHANGED", token}))` (`src/engine/index.ts:1109-1117`) forwards whatever `onChange` received; `engine-token-store.ts:50-53` fires on every `set()`, not only on clear | Today the only engine-side `set()` with a real value is the boot `detectGhCli()` adopt, and the loopback WS server starts *after* that fire-and-forget IIFE (`index.ts:1350` vs `:1140`), so a cold launch usually broadcasts into an empty client map. Reproducible on an engine respawn with an empty slot. Forward-looking it is deterministic: an App re-minting hourly *inside the engine* would broadcast a live credential on a fixed cadence. |
| Setup scripts are protected; terminals are not | `setup-hooks.ts:144-158` gives setup scripts a 12-name allowlist whose comment names *"the GitHub OAuth token"* explicitly | The inconsistency is the finding: the same token the setup-script path deliberately withholds is handed to every PTY. |

The irony is documented in the tree: `pushMcpVaultToEngine` couriers the MCP OAuth vault over
**stdin specifically** to keep *"the token blob out of agent subprocess environments"*
(`electron/sidecar.ts:1543-1547`). The GitHub token did not get the same treatment. Note also
that packaged DevTools is deliberately open (`electron/devtools.ts:16-20` says plainly that
"an open console really can read live credentials out of a signed-in app"), which raises the
cost of both leaks.

**The reverse path is deliberately narrow, and that narrowness is itself a bug.** The
renderer's writeback acts only when `token == null` (`github-token-sync.ts:36-41`). So an
engine-originated *non-null* token never reaches safeStorage: after a boot-time gh adopt, the
engine is authenticated while Settings reads "not connected". And the writeback never touches
`ghAuthStatusCache`, so a 401/403 auto-clear leaves the settings card serving its last
confirmed snapshot for the remainder of the 60 s freshness window
(`read-caches.ts:31`) — bounded, not indefinite, and self-healing for gh users because the
next probe re-adopts.

---

## 3. The API-vs-transport split — the root defect

This is the finding everything else in this report hangs off, and it survived adversarial
refutation with its scope *tightened*, not weakened.

Every network-touching git invocation in the engine authenticates with whatever git resolves
ambiently — the credential helper for HTTPS, the ssh-agent for SSH:

| Call site | Command | Auth story | Error mapping |
|---|---|---|---|
| `src/engine/git/ops.ts:126` | `git push [-u] [--force-with-lease] <remote> <branch>` | ambient | `/not authenticated\|authentication failed\|403\|401/i` (`:128`) |
| `src/engine/git/ops.ts:198` | `git pull [--rebase] [--autostash]` | ambient | — |
| `src/engine/git/fetch.ts:30` | `git fetch [--prune] <remote>` | ambient | — |
| `src/engine/git/default-branch.ts:125` | `git -C <root> fetch <remote>` (8 s, failures swallowed) | ambient | — |
| `src/engine/git/default-branch.ts:193` | `git ls-remote --symref <remote> HEAD` (5 s, memoised 10 min) | ambient | — |
| `src/engine/git/branch.ts:253` | `git fetch --no-tags <remote> <base>` (8 s) | ambient | — |
| `src/engine/git/cross-tool.ts:494` | `git fetch <remote> <branch>` (20 s) | ambient | — |
| `src/engine/git/diff.ts:843` | `git fetch --no-tags <remote> <sha>` | ambient | — |
| `src/engine/git/init-clone.ts:202` | `git clone <url> <dir>` | ambient | matches `could not read username\|permission denied` (`:203-210`) |
| `src/engine/git/github.ts:1076` | `git push -u origin <branch>` (publish) | ambient | **none** |
| `branch-catalog.ts:173`, `worktree.ts:279` | delegate to `fetchRemote` | ambient | — |

Grep for `x-access-token`, `extraheader`, `credential.helper`, `GIT_ASKPASS`,
`GIT_TERMINAL_PROMPT` across `src/`, `electron/`, `backend/`: **zero product hits.** The only
occurrences are the classification lists in `src/engine/settings/env-names.ts:61-73,93`, which
class `GIT_ASKPASS`/`GIT_SSH_COMMAND`/`GIT_CONFIG*` as class-1 code-injection vectors to be
stripped from every settings layer — a collision the credential-broker work has to design
around, since the same names are the mechanism.

Three refinements from the verification pass, all of which make the picture more precise:

1. **SSH remotes are unaffected.** The blast radius is HTTPS remotes. But
   `publishRepoToGithub` always wires `origin` to the HTTPS `clone_url`
   (`github.ts:1065-1075`), guaranteeing the failure on that one flow regardless of the user's
   preference.
2. **It does not surface as `NOT_AUTHENTICATED`.** `push`'s regex catches a *present but
   invalid* credential (git prints `fatal: Authentication failed for 'https://github.com/…'`),
   but the no-credential case prints `fatal: could not read Username for 'https://github.com':
   No such device or address` — which matches nothing. The user gets `GIT_COMMAND_FAILED` with
   the description `git push -u origin zeros/my-feature failed` (built at
   `git-exec.ts:318`, surfaced via `gitErrorDescription` at `src/native/git.ts:1269` into the
   island toast at `src/shell/pr/pr-status-island.tsx:485`; the *title* is the more helpful
   "Couldn't push"). `GIT_COMMAND_FAILED` is also absent from `EXPECTED_ENGINE_ERROR_CODES`
   (`src/engine/index.ts:219`), so it is reported to error tracking as a bug.
3. **It does not hang.** An early version of this finding claimed an indefinite wedge on
   `Username for …` because no `timeoutMs` and no `GIT_TERMINAL_PROMPT=0` are set. That was
   **refuted**: the packaged app's engine child has no controlling tty
   (`electron/sidecar.ts:1225,1239`) and `runFile` pipes stdin (`git-exec.ts:111-114`), so git
   fails fast. The hang reproduces only in a dev run launched from a terminal.

### Four write paths, none of them credentialed

| Path | Entry point | What it actually does |
|---|---|---|
| Island **Push** | `pr-status-island.tsx:500` → `push()` | Plain `git push`, ambient credential |
| **Create PR** | `create-pr-button.tsx:95-140` | Sends the *agent* a brief: `git push -u '<remote>' HEAD:'<branch>'` then `gh pr create --base <base>` (`pr-instructions.ts:74-80`) |
| Engine `createPr` | `github.ts:737-760` | Calls `pushImpl(... setUpstream:true)` at `:746` **before** `pulls.create`, so it inherits every transport failure — and has zero renderer callers |
| **Publish to GitHub** | `github.ts:1024-1076` | Creates the repo via Octokit, wires `origin`, then a raw `runGit(["push","-u","origin",branch])` with **no `mapErrorCode`** |

The Create-PR design is deliberate and documented (`pr-instructions.ts:4-9`), not an
oversight. The correction that matters for the broker design: agents get **no PTY** — they are
spawned with piped stdio, detached (`stdio-process.ts:63,68`) — so `buildPtyEnv` is the
terminal pane's env, not the agent's, and the agent's credential resolution is *identical* to
`runGit`'s (both inherit `process.env` with nothing injected). The design constraint is
therefore precise: **a credential injected only into `runGit`'s per-invocation env will not
reach the agent's own `git push` or `gh pr create`.** It has to be installed where both see it.

Publish failure is worse than a bad toast. After the push fails the folder *is* a git repo, so
the `nonGit`-gated empty state that hosts the only "Publish to GitHub" entry point
(`changes-tab.tsx:481-487`) stops rendering and the affordance vanishes; reopening the dialog
finds the name "taken" and disables submit (`publish-to-github.tsx:149-155`). The user is
dead-ended with an orphan empty repo on GitHub, and `upsertProject` never ran so the project
row has no `originUrl`.

---

## 4. The error classifier: 403 read as 401

```ts
function isAuthError(err: unknown): boolean {          // src/engine/git/github.ts:390
  const status = (err as { status?: number }).status;
  return status === 401 || status === 403;             // :393
}
```

GitHub returns 403 for at least six non-credential conditions: primary rate limit, secondary
rate limit, org SAML enforcement, org IP-allowlist denial, "Resource not accessible by…" on a
missing fine-grained permission, and writes to an archived repo. Both consumers destroy the
credential:

- `getAuthStatus()` → `await tokenStore.clear()` (`:209-214`). This runs in **Electron main**
  (`electron/ipc/commands/github.ts:54-56`), where the store is `deleteSecret` — so one 403 on
  a Settings refresh deletes the durable secret synchronously, with no bridge hop.
- `withAuthRetry()` → `clearOctokitCache(); await tokenStore.clear()` (`:497-501`), wrapping
  ~25 PR read/write call sites. In the engine that fires `GITHUB_TOKEN_CHANGED` →
  `gh_token_clear` → the same delete.

Two independent durable-wipe paths. The auditor's probe against the real module returned
`{authenticated:false}` and `token after: null` for both rate-limit shapes.

Three adjacent defects on the same seam:

- **`withAuthRetry` never retries.** Its doc comment (`:487-490`) promises *"a one-shot 401
  retry … then run the function again"*; the body invokes `fn` exactly once, clears, and
  rethrows. Verified by execution (call count 1 on a 401 that would have succeeded). This is a
  naming/documentation defect with no current runtime failure — no shipping auth mode issues an
  expiring token — but every design decision made by *reading* that comment ("the layer already
  refreshes App tokens") would be wrong.
- **The 403-specific remediation strings are dead code.** `wrapApiError` returns early on
  `isAuthError` (`:428-436`) with the generic *"GitHub rejected the request (401/403).
  Re-authenticate."*, so GitHub's own precise text — e.g. *"Resource protected by organization
  SAML enforcement"* — is discarded before `githubApiMessage()` (`:411-426`) ever runs.
- **404 is systematically read as "absent".** `wrapApiError:465-468` answers a `/not found/`
  message with *"Push the branch to the remote first, then open the PR."* — which, reached via
  `createPr`, is **guaranteed-false advice**, because `createPr` pushed at `:746` before
  calling `pulls.create`. `checkRepoNameAvailable:946` reads 404 as "name is available", and
  the publish 422 that follows (`{errors:[{message:"name already exists on this account"}]}`)
  hits the earlier `/already exist/` branch and tells the user to *"open the pull request
  instead"* (rendered at `publish-to-github.tsx:176`). `syncWorkspacePr` swallows 404 as "no
  PR" (`:825-827`).
- **No rate-limit awareness anywhere.** Octokit is `new Octokit({auth})` (`:132`) with neither
  `@octokit/plugin-throttling` nor `@octokit/plugin-retry` installed (`package.json:102-103`);
  nothing reads `x-ratelimit-remaining`, `x-ratelimit-reset` or `retry-after`.

On the polling budget, honest numbers after correction: the Review slow lane is **7 REST + 1
GraphQL** per round at 60 s (`review-model.ts:213-214`; GraphQL bills a separate 5000-point
budget), the island is 4 REST at 60 s (`pr-status-refresh.ts:4`), and the checks fast lane is 3
REST at 12 s but only while `hasPendingChecks` holds *and* the Review row-1 tab is active.
Every lane re-checks `document.visibilityState` on **every tick**, so a minimised window burns
zero, and `src/native/git.ts:1085-1101` coalesces concurrent `ghPrGet`/`ghPrChecks` by
`{workspaceId, prNumber}` — so the two lanes usually dedupe. Realistic steady state with the
Review tab pinned open is ~7 REST/min (~420/hr); ~1600/hr is a ceiling requiring an hour of
continuously-pending CI. The sharpest non-speculative defect is not the aggregate: it is that
`refreshChecksOnly` swallows every error in an empty catch (`review-data.ts:334-351`) while its
arming condition is derived from the last *successful* snapshot (`:522-528`), so a failing or
rate-limited checks endpoint never clears `pending` and the same three calls reissue every 12 s
**with zero decay**.

One genuine redundancy: `getPrChecks` re-fetches the whole PR solely to read `head.sha`
(`:1335-1338`) while the island requests `ghPrGet` and `ghPrChecks` in the same
`Promise.allSettled` (`pr-status-island.tsx:380-385`) — two identical `pulls.get` per round,
~120/hr wasted, fixable with a caller-supplied `headSha` rather than by deleting the call.

---

## 5. The settings UI

The GitHub card has already moved out of General: it is Settings → **Integrations**, rendered
by `IntegrationsPanel` (`settings-page.tsx:1055-1061`, section registered at `:259-264`,
grouped under "Personal" at `:294-303`). Two user-facing copy strings still say
"Settings → General → GitHub" — the section header comment (`github-section.tsx:2`) and the
Review tab's unauth gate (`review-tab.tsx:304-305`).

Rendered states, exhaustively:

| State | Condition | Copy |
|---|---|---|
| Loading | `connection.loading` | a blank `min-h-8` box with `aria-busy` (`:195-196`) |
| Connected (gh) | `login && viaCli` | "GitHub CLI is authenticated and ready" + "Signed in as @x" + **Sign out** (`:204`) |
| Connected (other) | `login && !viaCli` | "Connected to GitHub" + "Signed in as @x" + **Sign out** (`:205`) |
| gh present, not logged in | `!login && ghAvailable` | "GitHub CLI detected but not logged in. Run \`gh auth login\`, then Refresh…" (`:226`) |
| Nothing | `!login && !ghAvailable` | "GitHub CLI not found. Paste a personal access token, or connect with GitHub." (`:227`) |
| Device code | `deviceCode != null` | inline code + verification link (`:288-306`) |
| Error | `error \|\| connection.error` | red strip *below* the card (`:316-321`) |

Specific defects the picker inherits if they are not fixed first:

- **No durable method.** `viaCli` is sourced from the in-memory snapshot as
  `previous?.viaCli ?? false` (`:95`) — and the correction sharpens this: because
  `detectGhCli()` *persists* the gh token, `ghAuthStatus()` reports authenticated on every
  later launch, so the authenticated branch is taken and `ghDetectCli()` is **never called
  again**. `viaCli` therefore stays `false` permanently after restart until an explicit sign-out
  re-probes. No amount of Refresh fixes it. There is no data to pre-select a radio button
  synchronously on first render, which RULES.md:294-297 requires for durable selections.
- **A cold error fabricates a fact.** `ghAvailable = connection.data?.ghAvailable ?? false`
  (`:115`), so a *thrown* probe (data undefined, error set) picks the "GitHub CLI not found"
  copy for a user whose `gh` is installed and authenticated. Reachable when a token is already
  stored and `getAuthStatus` throws `NETWORK_ERROR` (offline, `github.ts:215`), or when the
  preload bridge is missing. This is exactly the "cold cache is not an authoritative empty
  snapshot" failure RULES.md:298-300 names.
- **Refresh only exists while disconnected.** The `Refresh` button is inside the not-connected
  branch (`:281-288`); the connected card offers only Sign out. A user looking at a stale green
  "Connected" has no way to force a re-probe short of signing out.
- **The PAT placeholder steers to the wrong token type.** `placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"`
  (`:241`) is the *classic* PAT prefix; fine-grained (`github_pat_…`) is the 2025+ default.
- **Enter bypasses the busy lock.** `onKeyDown` calls `submitPat()` with no `busy` guard
  (`:244`), while `submitPat` checks only `!pat.trim()` (`:119-120`) — the one keyboard route
  around the ~15-minute device-flow lockout.
- **No cancel for the device flow.** `ghAuthSignin` awaits `startDeviceFlow()` with no
  AbortSignal and there is no `gh_auth_cancel` in the preload allowlist. Settings is *not* a
  dialog — panels live in retained decks (`settings-page.tsx:601-605,744-764`), so the code
  stays on screen and `busy` stays true. But `tokenStore.set` at `github.ts:340` is
  unconditional and has no compare-and-set, so a flow the user completes *after* switching
  methods overwrites the new choice.
- **`doSignOut` has no `catch`** (`:164-179`) and never calls `setError(null)`. The one genuine
  trigger is a filesystem error rewriting `secrets.json` — `deleteSecret` never touches
  safeStorage and `withSecretsLock` proceeds rather than throwing, so the commonly-cited
  triggers do not apply.

What the picker *can* build on: `Avatar`, `Badge` (with success/failure variants),
the full `DropdownMenu*` family, `Tooltip`, `Separator`, `Tile` and `Alert` all exist in
`src/zeros/ui/primitives/`. There is **no** standalone RadioGroup — only
`DropdownMenuRadioGroup` (`primitives/index.ts:55`) — though the unified `radix-ui` package is
already a dependency (`package.json:154`) and exports one, so a wrapper adds nothing.
`AuthStatusResult` is `{authenticated, login?}` (`github.ts:194-197`): no avatar, no scopes, no
expiry, no method on the wire. And Settings carries a standing decision *against* loading
remote provider avatars (`settings-page.tsx:920-923`) whose stated CSP rationale is inaccurate
— `img-src 'self' data: blob: https:` (`electron/main.ts:798`) permits them, and
`repository-icons.ts:180-190` already renders remote owner avatars. That conflict has to be
resolved before a "Connected as @x" chip with an avatar ships.

---

## 6. The `gh*` IPC surface — all 19 methods

`src/native/git.ts` exports 19 `gh*` façades. Eight sit behind `ReviewProvider`
(`src/shell/pr/review-provider.ts:61-72`); **five of those eight are bypassed anyway** by
direct calls elsewhere, leaving exactly three ops honoured only through the seam.

| # | Export (`src/native/git.ts`) | Runs in | Needs | Behind `ReviewProvider`? | Remote client? |
|---|---|---|---|---|---|
| 1 | `ghAuthStatus` :975 | **Electron main** `gh_auth_status` (`ipc/commands/github.ts:54`) | stored token | ✓ seam — **bypassed** at `github-section.tsx:91` | engine op `gh.authStatus` is `REMOTE_READABLE` (`service.ts:523`) but unreachable: `bridgeGhAuthStatus` (`workspace-bridge.ts:979`) has no callers |
| 2 | `ghRepositoryOwnerAvatar` :983 | engine `gh.repoOwnerAvatar` (`:2341`) | optional token; open checkout | ✗ | ✓ readable |
| 3 | `ghAuthSignin` :995 | **Electron main** `gh_auth_signin` (`:79`) | baked OAuth client id; ~15 min user window | ✗ | ✗ never remoted (deliberate) |
| 4 | `ghDetectCli` :1006 | **Electron main** `gh_detect_cli` (`:59`) | `gh` on PATH + `gh auth login` | ✗ | ✗ |
| 5 | `ghSetToken` :1014 | **Electron main** `gh_set_token` (`:66`) | a pasted token | ✗ | ✗ |
| 6 | `ghSignOut` :1018 | **Electron main** `gh_sign_out` (`:73`) | — | ✗ | ✗ |
| 7 | `ghPrCreate` :1022 | engine `gh.prCreate` (`:2432`, `WRITE_OPS:395`) | token **+ working git push** | ✗ | ✓ write (restriction-gated) — **zero renderer callers** |
| 8 | `ghListOwners` :1034 | engine `gh.listOwners` (`:2367`) | token (`orgs.listForAuthenticatedUser`) | ✗ | ✗ |
| 9 | `ghCheckRepoName` :1039 | engine `gh.checkRepoName` (`:2369`) | token (`repos.get`) | ✗ | ✗ |
| 10 | `ghPublishRepo` :1051 | engine `gh.publishRepo` (`:2374`, `isKnownRepoRoot` clamp) | token **+ working git push** | ✗ | ✗ |
| 11 | `ghPrMarkReady` :1072 | engine `gh.prMarkReady` (`:2446`, `WRITE_OPS`) | token | ✓ seam — **bypassed** at `pr-status-island.tsx:536` | ✓ write |
| 12 | `ghPrGet` :1090 | engine `gh.prGet` (`:2410`) | token; GitHub remote | ✓ seam — **bypassed** at `pr-status-island.tsx:384` | ✓ readable |
| 13 | `ghPrSync` :1109 | engine `gh.prSync` (`:2473`, `WRITE_OPS:404`) | token; writes the workspace row | ✗ | ✓ write |
| 14 | `ghPrList` :1124 | engine `gh.prList` (`:2732`) | token; owner/repo or originUrl | ✗ | ✗ |
| 15 | `ghPrMerge` :1133 | engine `gh.prMerge` (`:2451`, `WRITE_OPS`) | token; merge permission | ✓ seam — **bypassed** at `:555` and `dashboard-page.tsx:554` | ✓ write |
| 16 | `ghPrChecks` :1203 | engine `gh.prChecks` (`:2415`) | token; 3 REST calls | ✓ seam — **bypassed** at `pr-status-island.tsx:385` | ✓ readable |
| 17 | `ghPrCommits` :1218 | engine `gh.prCommits` (`:2420`) | token; 1 REST + 1 GraphQL | ✓ **honoured** | ✓ readable |
| 18 | `ghPrReviews` :1225 | engine `gh.prReviews` (`:2425`) | token; 2 REST | ✓ **honoured** | ✓ readable |
| 19 | `ghPrComment` :1232 | engine `gh.prComment` (`:2467`, `WRITE_OPS`) | token; non-idempotent write | ✓ **honoured** | ✓ write |

Notes that fall out of the table:

- **Auth lives in a different process from PR ops.** All five auth methods run in Electron
  main against safeStorage; every PR op runs in the engine against an in-memory working copy.
  The two are kept in sync only by five `pushGithubTokenToEngine()` calls
  (`ipc/commands/github.ts:62,70,76,89,108`) plus the spawn-env seed. A missed call yields
  "Connected" in Settings and `NOT_AUTHENTICATED` on every PR op until the next respawn —
  session-scoped drift, not permanent, since main and the courier both read the same
  safeStorage.
- **The renderer's whole GitHub IPC surface is six commands**: `gh_auth_signin`,
  `gh_auth_status`, `gh_detect_cli`, `gh_set_token`, `gh_sign_out`, `gh_token_clear`
  (`electron/preload.ts:51-56`). `gh_token_get` is gone. `scripts/check-preload-allowlist.mjs`
  treats *both* a missing and an unused entry as a hard error with `ALLOW_UNINVOKED` empty, so a
  new command cannot be allowlisted before its call site exists.
- The allowlist is enforced **in preload only** — `electron/ipc/router.ts:187-204` does not
  re-check it, so the ~115-command table is reachable on `zeros:invoke`. That is a deliberate
  reliance on `contextIsolation` + `sandbox:true`.
- `gh.prComment` — a non-idempotent write — uses the 10 s `workspaceOp` default
  (`workspace-bridge.ts:1190`) while `prCreate`/`prMerge`/`prMarkReady` pass
  `NETWORK_GIT_TIMEOUT_MS = 60_000` with a comment explaining that exact hazard. It is also
  absent from `LONG_LIFECYCLE_OPS` (`change-events.ts:107-122`), so a timed-out comment gets
  neither the raised budget nor the self-heal — and the composer restores the draft and
  refocuses, so a duplicate is one click away.

---

## 7. Cloud workspaces today: no credential, and three blockers

The design is already written down: *"**GitHub:** Zeros App installation token (1 h, auto
re-mint) `https://x-access-token:TOKEN@github.com/...`; PAT fallback; engine reads
`ZEROS_GITHUB_TOKEN`"* (`docs/cloud-workspace/08-engineering-reference.md:533`), with the
provider API recorded as `sandbox.git.clone(url, path, branch?, commit?, 'x-access-token',
TOKEN)` (`:169`) and the constraint *"Short-lived, narrowly-scoped tokens only… never bake keys
into the image"* (`07-execution-plan.md:168`). None of it is built. Phase 6 is unstarted; only
Phase 0 and Phase 1 shipped.

What exists: the Phase 1 spike clones the **public** zeros repo at image-bake time
(`scripts/cloud-spike/Dockerfile:17,46`) and injects agent API keys whose allowlist
deliberately contains no GitHub variable (`config.ts:109-116`). The image installs
`git openssh-client curl ca-certificates python3 make g++ unzip xz-utils procps` — **no `gh`,
no credential helper** (`Dockerfile:29-32`). So a sandbox today has zero repo credentials, and
the REST-only gap is strictly worse there than locally.

Three shipping mechanisms actively block the documented plan:

| Blocker | Where | Effect |
|---|---|---|
| `GITHUB_TOKEN_SET` accepted from `kind:"local"` clients only | `src/engine/index.ts:1781`; a `CloudTransport` peer is `kind:"cloud"` (`transport/cloud.ts:81`) | The Mac can never courier a token to a sandbox engine |
| `ZEROS_GITHUB_TOKEN` consumed exactly once at boot | `src/engine/index.ts:1125-1127`; the store is a bare in-memory string with no expiry (`engine-token-store.ts:24`) | No re-mint channel for a 1-hour token |
| The change notifier uses `broadcastLocal` | `src/engine/index.ts:1110-1119` → `router.broadcastLocal` filters to `kind==="local"` | A cloud client never learns its token was cleared — an expired installation token yields a permanently unauthenticated engine nobody is told about |

And `withAuthRetry` self-clearing on any auth error (`github.ts:498-501`) turns the *normal*
case for a 1-hour token in a 6-hour agent run into a sign-out.

On the backend: `backend/` has the right spine — Auth0 JWTs verified against a remote JWKS with
issuer/audience/alg pinning (`backend/src/auth.ts:71-95`), role re-read from Postgres per
request rather than trusted from a claim (`authz.ts:1-5,34-49`), `FORCE ROW LEVEL SECURITY`
with every policy `team_id IN (SELECT app_user_team_ids())`
(`migrations/0006_org_to_team.sql:105-160`, `0004_rls_enforce.sql`), an append-only
team-scoped audit trail written in the mutation's transaction (`audit.ts:6-17`), and a rate
limiter. It has **nothing GitHub-related**: a grep for `github` across `backend/src` returns
two incidental comments about Auth0 social login (`auth.ts:132,236`). Every `/v1/*` route sits
behind the JWT middleware (`index.ts:57`), so there is no unauthenticated raw-body webhook
route, and the encrypted secrets vault that would have held an App private key was dropped
(`migrations/0005_orgs_optional.sql:26`). `audit_log.team_id` is `NOT NULL`
(`0001_init.sql:107-115`), so a *personal* installation event has nowhere to be recorded, and
users may belong to zero teams by design (`0005:8-9`).

The closest existing precedent for the confidential half is not `backend/` at all: the Auth0
session refresh relay is `website/web-app/functions/handoff/refresh.ts`, a Cloudflare Pages
Function that states its purpose verbatim — *"a thin relay that holds the confidential client's
secret server-side so the desktop binary never has to"* — with rate limiting and a
terminal-vs-transient split (401 → clear session, 503 → keep tokens).

---

## 8. What already works well

This codebase has real, load-bearing strengths, and several of them are exactly the seams the
new design needs. Listing them is not politeness; it changes the plan.

### The token-courier threat model is stated, implemented, and mostly correct

H4 is not a comment aspiration. `gh_token_get` was **removed outright**, not deprecated
(`ipc/commands/github.ts:15-17`). `github_oauth` is explicitly denied by the renderer keychain
bridge, with the reasoning written down — *"A renderer compromise (e.g. XSS in rendered agent /
markdown content) could then enumerate and exfiltrate every secret if this bridge had no
allowlist"* (`electron/keychain-accounts.ts:10-20`). The renderer-side courier is a documented
no-op (`github-token-sync.ts:22-28`) so no call site can regress into holding the token. And
there is already a **private, never-logged host↔engine control channel in both directions**:
stdin for `host.githubToken` and the MCP vault seed (`src/engine/index.ts:4048-4070`), and fd 3
outbound with the comment *"DELIBERATELY not routed to console/log: the line carries plaintext
tokens"* (`electron/sidecar.ts:1200-1205`). That is the correct transport for installation
tokens in both directions, and it exists today.

Supporting hygiene: no `crashReporter` is configured anywhere, so there are no minidumps to
leak. PostHog capture is explicit-only and there is no GitHub-related `capture()` call
(`src/zeros/analytics/posthog.ts:174-178`). `redactLogSecrets` already knows
`ghp|gho|ghu|ghs|ghr` and `github_pat_` (`packages/core/src/scrub.ts:78-83`), and the generic
`\b[A-Za-z0-9_-]{32,}\b` scrub rule (`scrub.ts:34`) catches token shapes the specific rules
miss. `GitError.toJSON` exposes only `cause.message`, never the cause object
(`src/engine/git/errors.ts:71-88`), so an Octokit `RequestError`'s request headers cannot reach
the renderer through the error path — the auditors looked for a token-in-error-message leak and
found none.

### The `*ForTesting` seams

The GitHub layer ships five injection seams of its own plus the state-root seam, all
re-exported through `src/engine/git/index.ts:57,267-272`:

| Seam | Line | Injects |
|---|---|---|
| `setTokenStoreForTesting` | `github.ts:165` | the whole `TokenStore` |
| `setOctokitFactoryForTesting` | `:173` | the Octokit constructor |
| `setClientIdForTesting` | `:188` | the device-flow client id |
| `setPushForTesting` | `:733` | the push implementation `createPr` calls |
| `resetBehindByCacheForTesting` | `:1222` | the compare-cache |
| `setStateRootForTesting` | `state.ts:50` | the DB/state root |

`setPushForTesting` in particular means the token-bearing-transport fix is testable the day it
lands — the claim that "a fix would ship with no regression test" is a prediction, not a
structural limitation. The one real gap is the `TokenStore` interface itself
(`github.ts:101-105`: `get`/`set`/`clear` over a bare string, no method, no scope, no expiry,
no installation id) and the fact that the injected factories at `github.test.ts:264` and
`publish-github.test.ts:115` **discard the token argument**, so no current test can assert
*which* token a client was built with. Fixing that seam is a prerequisite for a swap test, and
it is a small change.

### `review-provider.ts` is honestly shaped

The seam is real, and its header comment states the intent precisely: *"Everything the Review
surface reads or writes goes through ONE typed interface … GitLab / Bitbucket land later by
adding a provider here and teaching `resolveReviewProvider` to pick it from the workspace's
origin host — zero changes in the UI or the live-data store."* The interface has the right
shape — an `id: "github" | "gitlab" | "bitbucket"`, a `hostLabel` used for "Open on X"
(`review-tab.tsx:304-305,359,535`), and eight methods split cleanly into reads and writes. The
Review tab genuinely consumes it. `resolveReviewProvider(_originHost?)` already takes the host
parameter it will need; it just ignores it today, and both call sites pass nothing
(`review-tab.tsx:158`, `prefetch-workspace-surface.ts:47`). This is a *start* — 11 of 19
methods sit outside it and 5 of the 8 inside are bypassed — but it is the right start, and the
new work extends it rather than replacing it.

### `GitError` with `remediation`, and the plumbing to show it

`GitErrorCode` is a closed union of 27 codes (`errors.ts:6-40`), `GitErrorOptions` carries an
optional `remediation` and a `context` bag documented for exactly this purpose (*"for
BRANCH_IN_USE we attach `{branch, heldBy:{path,tool}}` so the renderer can render the
resolution dialog without a second roundtrip"*), and `gitErrorDescription` at
`src/native/git.ts:1269` resolves `remediation ?? message` for every toast. `init-clone.ts`
shows the pattern used well: it maps `could not read username|permission denied` to
`NOT_AUTHENTICATED` (`:203-210`) and attaches a real remediation for
`WORKSPACE_ALREADY_EXISTS` (`:197`). The infrastructure for actionable GitHub errors exists;
the GitHub paths just under-use it. That is a cheap fix, not an architecture change.

### Read-cache discipline

AGENTS.md:14 binds it: *"Treat bridge/native/remote reads as keyed server state. Share
requests, retain the last confirmed exact-key snapshot while revalidating, and never clear
usable data merely because a refresh started."* `KeyedAsyncCache` obeys that **structurally**:
`load` publishes `{loading: data===undefined, refreshing: data!==undefined, error:null}` while
retaining data, the error path keeps `...entry.snapshot` so data survives a failed refresh, and
`invalidate`/`invalidateAll` bump `stale`/`generation`/`invalidationVersion` without clearing
data. The auditors' verdict was explicit: *the violation is at the call sites, not in the
cache.* Alongside it: `src/native/git.ts:1085-1101,1203-1214` coalesces concurrent
`ghPrGet`/`ghPrChecks`/`ghPrSync` by key with entries removed the moment they settle —
"concurrency coalescing, never a cache", per its own comment — and every PR poll lane is
visibility-gated on each tick with terminal PRs muted (`pr-status-refresh.ts:83-91`). The
freshness constants are reasoned, not arbitrary: 30 s for local git reads, 60 s for GitHub
because *"probing more than once a minute per key burns rate limit for no visible benefit"*
(`read-caches.ts:26-31`).

Conductor's equivalent is a *durable* keyed cache on disk
(`local-storage.entries/git-service-pr-v1/`, 244 entries keyed `{repositoryId, localBranch,
prInfo}` — **verified** by first-hand inspection). Zeros' pattern is the same shape, in memory,
and — for auth — keyed by the literal string `"auth"` with bound 1. Making it durable and
keyed by its semantic owner is an increment, not a rewrite.

### The engine's remote-client gating

`REMOTE_READABLE` (`service.ts:489-531`) and `WRITE_OPS` (`:390-404`) are hand-curated with
per-op reasoning, and the GitHub auth ops are **deliberately not remoted at all**: *"Auth-credential
mutations (sign-in / set-token / sign-out) are intentionally NOT remoted at all … so they never
appear here"* (`:391-394`). `gh.publishRepo` and `git.initInPlace` additionally require
`isKnownRepoRoot` so a bridge client cannot init git in an arbitrary directory (`:2377-2408`).
`gh.prSync` is allowed as a write with the justification that it *"writes only the workspace's
OWN row from real GitHub state (no client-supplied PR data)"*. This is the kind of allowlist
that makes a cloud credential path reviewable.

### `parseGitHubRemote` is genuinely robust

The auditors probed 27 URL shapes against the real function: scp-like SSH, `https`, `git://`,
`ssh://` with a port, trailing slash, `.git`/`.GIT`, embedded credentials, `//`-doubled paths
and whitespace all parse correctly (`github.ts:512-551`). It is not sloppy — it is *narrow*, by
design: it hard-rejects `github.mycorp.com` and `mycorp.ghe.com` with a clear
`VALIDATION_FAILED`, and Octokit is constructed with no `baseUrl`, so the layer is
structurally github.com-only. That is a scoping decision to revisit, not a bug to fix.

### The settings infrastructure the picker needs already exists

`~/.zeros/settings.toml` writes are **format-preserving and atomic** (toml-patch → tmp +
rename, `settings/files.ts:185-199,227-255,312-325`) and unknown keys survive
read-modify-write, so an older Zeros will not strip a newer `github.auth_method`. The exact
precedent for "how does this thing authenticate?" is already in the schema:
`providers.<agentId>.auth` with an enum, marked **user-layer-only** across every repo-scoped
layer precisely so a cloned repo file cannot redirect credentials
(`schema.ts:23,114-122,243-248,359-372`). The synchronous-first-render problem is already
solved too: `provider-prefs.ts:62-99` uses localStorage as the read cache with fire-and-forget
write-through into the user TOML. And the no-secrets-in-TOML rule is written down —
*"**No secret value is ever written to any settings.toml.**"*
(`docs/home-tab-and-settings-ia-2026-07-15.md:113-119`).

### Zero-config gh adoption is a real product decision that works

It is easy to read `src/engine/index.ts:1128-1148` as sloppy. Its comment explains the
problem it solves: without it, `gh.prSync` silently no-ops while the *agent's* own `gh` works
fine, so a PR the agent creates never surfaces in the app — no island, no "PR #N" pill, and the
topbar keeps offering "Create PR". That is a genuine product bug and the adoption fixes it. The
right change is to gate it behind a persisted method, not to delete it.

### By-area summary

| Audit area | Strength worth keeping | Weakest link |
|---|---|---|
| `git-transport-credentials` | `runGit`'s per-invocation `env` seam (`git-exec.ts:291`) is exactly where a credential belongs; PATH is repaired before spawn (`electron/main.ts:1093`), so `gh`/helpers are resolvable | No credential is ever passed; 13 network ops, zero of them authed |
| `auth-state-machine` | `NOT_CONFIGURED_STORE` fails loudly on write rather than dropping the token (`github.ts:111-124`) | Four writers, one slot, no persisted method |
| `token-storage-security` | merge-not-clobber writes, atomic rename, per-channel keys, fd-3 control channel | token in every child env; value on `GITHUB_TOKEN_CHANGED` |
| `github-api-layer` | `wrapApiError`'s tailored 4xx remediations; `behindByCache` with TTL + FIFO eviction | `isAuthError` conflates 403; no rate-limit awareness |
| `provider-abstraction` | `ReviewProvider` shape; `hostLabel` already threaded through the Review UI | 11/19 outside it; `repoSlug` drops the host |
| `settings-ui-and-state` | flat `SettingsSection`/`SettingsList` house style; TOML atomicity; `providers.*.auth` precedent | no durable method; cold error fabricates "gh not found" |
| `onboarding-and-repo-flows` | one canonical auth surface; deep-linkable settings sections | 9 other surfaces dead-end; no repo picker |
| `tests-and-gates` | six `*ForTesting` seams; `check:preload` bidirectional; real-Postgres backend gate with a 0-passed guard | both push tests use a local bare repo |
| `cloud-workspace-credentials` | backend spine (JWKS pinning, FORCE-RLS, append-only audit) | nothing GitHub exists in `backend/` |

---

## 9. Coverage and gates: what would catch a regression today

`pnpm test:git` is `vitest run --config vitest.config.ts` and picks up new files automatically
via include globs covering `src/engine/git/__tests__/**`, `src/shell/pr/__tests__/**`,
`src/zeros/panels/__tests__/**` and `electron/**/__tests__/**`.

The GitHub auth test surface is **one file**: `src/engine/git/__tests__/github.test.ts`, 627
lines, 23 tests, verified passing in 6.37 s. Covered: `getAuthStatus` unauthenticated /
authenticated / 401-clears-token (`:357-379`); `createPr` without a token →
`NOT_AUTHENTICATED` (`:572-577`); and a two-test `resolveClientId` precedence pair (`:580-624`).
Not covered anywhere: `detectGhCli`, `setToken`, `signOut`, the device flow's substance,
`withAuthRetry` on any status code, and a token A → token B swap.

| Gap | Evidence | Why it matters |
|---|---|---|
| **Both push tests use a local bare repo** | `publish-github.test.ts:1-4` says so outright — *"the mock's `clone_url` points at a real LOCAL bare repo so the `git push` works offline. We never hit github.com."*; `ops.test.ts:104` likewise | A `file://` push needs no credential, so the transport gap cannot fail CI. Honest framing: this is a coverage gap for behaviour that *does not exist yet* — the blocker is the product gap, the test note is its consequence |
| The whole courier is untested | no test file references `electron/secret-store.ts`, `github-token-sync.ts`, `engine-token-store.ts`, or `ipc/commands/github.ts` | The cluster is wide, not two files: `ipc/commands/secrets.ts`, `auth-session.ts`, `auth-handoff.ts` are equally uncovered. `keychain-accounts.ts` is a dependency-free pure predicate already inside the vitest include list — testable today with no scaffolding |
| The suite is non-hermetic | `github.test.ts:600` sets a fake client id and calls `startDeviceFlow` for real; `loadDeviceAuth` (`github.ts:53-58`) has no injection seam, so it POSTs to github.com on every CI run (measured: a real 404 in ~115 ms) | The file header claims *"We don't hit github.com"*. The test itself does gate a real regression and can go red — the defect is the outbound call and the untested tail (`:320-348`) |
| No renderer component tests are possible | `package.json` has no `@testing-library/react`, no jsdom, no happy-dom; `vitest.config.ts` sets `environment: "node"` | The convention is to extract pure helpers/stores and test those — which is what a three-way picker's state machine should be anyway |
| New auth test files silently skip macOS | `package.json:77` (`test:workspace-lifecycle`) and the `source-sync (macOS)` job in `preflight.yml` both name individual files | A new `github-auth.test.ts` must be added to both |
| `check:secrets` doesn't know App token prefixes | `scripts/check-secrets.mjs:59` matches only `gh[po]_` plus `github_pat_`; `ghs_`/`ghu_`/`ghr_` are unmatched, while `packages/core/src/scrub.ts:81` already knows all five | Must be reconciled *before* an App ships. The PEM rule (`:67`) does catch a private key |
| No HTTP recording fixture | no `nock`, no `msw` | The repo's two offline-HTTP idioms are a real local `http.Server` + `jose` signing (`backend/src/auth.test.ts`) and recorded-JSONL replay (`scripts/test-adapters.mjs`) — both usable templates |

Telemetry, stated accurately (the first draft of this finding said "zero", which was wrong):
the island's direct push/pull **are** instrumented via `GIT_OP_ANALYTICS`
(`workspace-bridge.ts:93-103,137-140`), and every failed `gh.*` op is relayed as
`ENGINE_ERROR` with origin, code and severity (`src/engine/index.ts:3316`,
`analytics/boot.tsx:106-110`). What is genuinely missing: the `pr_create|pr_update|pr_merge|
pr_mark_ready` enum members have **zero call sites**, and the comment justifying their
exclusion — *"review-tab tracks `pr_create` directly"* (`workspace-bridge.ts:89-91`), echoed in
`docs/posthog-analytics-integration.md:390` — is factually false. Worse, auth failures fall
through *both* channels: `NOT_AUTHENTICATED` sits in `EXPECTED_ENGINE_ERROR_CODES`
(`src/engine/index.ts:222`) on the explicit grounds that such codes "still surface in the
renderer's `git_op` funnel" — true for `git.*`, false for `gh.*`, which `GIT_OP_ANALYTICS`
drops. So today there is no way to measure how many users are connected, by which method, or
how often auth blocks a PR. The fix is cheap: `gh.prMerge`/`prMarkReady`/`prCreate`/
`publishRepo` all funnel through the same `workspaceOp` chokepoint.

---

## 10. Provider coupling, in one place

Detailed in a later part; recorded here because it is part of the current state.

- **Repo identity is `(owner, name)`, not `(host, owner, name)`.**
  `repoSlugFromOriginUrl` documents *"We intentionally drop the host"* (`repo.ts:22-30`), and
  `repo_slug` is the workspace partition key everywhere (`migrations.ts:370-372`,
  `state.ts:277,304-306`), called *"the globally unique repoSlug"* at `worktree.ts:501`. Two
  repos whose owner/name path matches collide — including a GHES clone of the same path, and two
  separate clones of the same remote (that last case is the documented *intent*). The
  cross-host collision is the unintended fallout. On disk it degrades to a hard
  "target folder is already occupied" error (`worktree.ts:971-978,1008-1015`) rather than
  silent mixing; the sharp edges are the merged sidebar, `WORKSPACE_ALREADY_EXISTS` citing
  another repo's workspace id (`cross-tool.ts:829-841`), and the branch-catalog PR-URL join at
  `cross-tool.ts:310-320` stamping repo A's `prUrl` onto repo B's identically-named branch.
- **The wire `PR` type is not provider-neutral**, despite its comment: `authorLogin`,
  `mergeableState` (documented as mirroring Octokit's `mergeable_state`, switched on in
  `pr-status.ts:295,319-365`), `behindBy` and `mergeCommitSha` are GitHub-shaped. The DB has no
  provider column (`migrations.ts:364-366`).
- **`ReviewMergeMethod = "squash" | "merge" | "rebase"`** (`review-provider.ts:33`) is invalid
  on both other hosts.
- **Lock-in lives in prose, invisible to typecheck.** `templates.ts:44` injects
  `gh pr create --base <branch>` into the first turn of *every* chat in *every* repo, and
  `pr-instructions.ts:59-61,80` hardcodes it in the Create-PR brief — and non-GitHub repos are
  fully openable. `pr-action-prompts.ts:90`'s `gh pr checks` is *latent* rather than live: it
  fires only from Review tab check rows that require a GitHub-synced `prNumber`. All three
  strings are pinned by tests (`pr-instructions.test.ts:23,57`;
  `pr-action-prompts.test.ts:86`).
- **The unsupported-host failure is silent, not signposted.** The clone dialog accepts any URL
  (`open-github-project.tsx:78`), `CreatePrButton` renders for any workspace gated only on
  `nativeReady` + `hasChanges` (`pr-status-row.tsx:67-74`), `githubCompareUrl` builds a
  GitHub-shaped compare path for whatever host it parsed (`github-url.ts:65-67`), and
  `syncWorkspacePr` swallows the non-GitHub error and returns null (`github.ts:812-814`) so the
  island never appears. Real host-awareness *does* exist — `parsePrUrl` is github.com-anchored
  with an explicit GitLab-rejection test, `parseGitHubRemote` validates the host,
  `branch-catalog.ts:102-109` computes `RepoRemote.isGitHub` — it is just thrown-and-swallowed
  or reduced to a glyph (`repositories-panel.tsx:1122-1126`) instead of surfacing "this host
  isn't supported yet".

---

## 11. Where this evidence comes from, and what it got wrong

17 parallel agents (9 code auditors over the repo, 8 web researchers) produced findings and
claims. Then **220 independent agents each tried to refute one finding or fact-check one
claim.** 52 of 109 verified audit findings survived — a **52% kill rate** — and 188 of 207
claims survived. Every finding cited above is from the surviving 52, and where a verifier
tightened one, this section states the *tightened* version.

Calibration matters, so here are four claims this report **rejected**, each of which sounds
plausible and is wrong:

1. *"A credential-less HTTPS op hangs the workspace RPC forever."* The two sub-observations
   are true (`GIT_TERMINAL_PROMPT` is never set; push/fetch/clone pass no `timeoutMs`) but the
   mechanism is not: the engine child has no controlling tty and `runFile` pipes stdin, so git
   fails fast. Reproducible only in a dev run from a terminal.
2. *"A Zeros-owned `GIT_ASKPASS` must bypass the settings env table because `env-names.ts`
   classifies exactly those names as code-injection."* Refuted as architecturally inverted: the
   denylist governs *caller/relay-supplied* env, and `mergeSpawnEnv` merges settings env **under**
   `callerEnv` without filtering it (`settings/spawn-env.ts:282-291`) — which is already the
   sanctioned channel for an engine-owned shim var.
3. *"The `ZEROS_GITHUB_TOKEN` PTY leak is unqualified."* Narrowed: it requires a token present
   in safeStorage **at engine spawn**, and the identical route leaks `ZEROS_LOCAL_WS_TOKEN`
   unconditionally — which is arguably the more serious of the two, since it authenticates a
   trusted local client to the engine.
4. *"Publish re-runs fail with 'repository already exists'."* Wrong, and the truth is worse: the
   entry point disappears and the dialog disables submit.

Three things we could not establish:

- **Conductor's GitHub App permission set and slug.** The teardown of the live 0.77.5 install
  found the `appSlug` *field* but its values are server-supplied, and the webview assets are
  compressed inside the Rust binary. Public research resolved the slug to `conductor-build`
  (the install entry point is live) but the app renders as *a private GitHub App* and is not on
  Marketplace, so the permission list has never been published — an HN commenter asked for
  exactly this and was never answered.
- **Conductor's desktop OAuth callback mechanism.** `conductor://` is registered in
  `Info.plist` (**verified**), which is suggestive but not proof; the redirect target is
  configured GitHub-side and invisible from the client. The balance of evidence points at a
  browser → GitHub → `conductor.build` web callback with a deep-link hand-back rather than a
  loopback server (**likely**).
- **Whether the repo's own `Ov23li` prefix inference is documented.** No official GitHub page
  states the OAuth-App-vs-GitHub-App client-id prefix convention (**unverified**); we rely on
  `clientType: "oauth-app"` in the code instead.

One thing worth stating plainly: **the design panel and the report critics were cut for time.**
The architecture in `.context/architecture-decision.md` is one author's synthesis of this
evidence base, not a panel consensus. This section is the part of the report that is closest to
pure observation — every claim in it is a `path:line` you can open — which is exactly why it is
Part 01.

## 12. Scorecard against the target design

| Target capability | Today | Gap |
|---|---|---|
| Three explicitly-selected methods | one implicit precedence chain (`github-section.tsx:4-11`) | no picker, no persisted selection |
| Independent per-method credential slots | one slot, `github_oauth` | `TokenStore` is `get/set/clear` over a bare string (`github.ts:101-105`); a second slot `github-pat` exists but is dead (`src/native/secrets.ts:73`) |
| Durable "which method" | `viaCli` in an in-memory cache, permanently `false` after restart | needs `[github] auth_method` in `~/.zeros/settings.toml` + migration by inference |
| Per-method health readout | one green check + `@login` | `AuthStatusResult` is `{authenticated, login?}`; no avatar, scopes, expiry, installation |
| "All repositories accessible." | nothing — no repo listing call exists in `github.ts` | needs an installation model; must probe the *minted* token, not declared grants |
| Refresh affordance | `Refresh` renders only while disconnected | move it into the connected card; revalidate without clearing |
| Per-row ⋮ overflow menu | none (the `DropdownMenu` primitives exist) | plus the nested-interactive constraint: the ⋮ and the ↗ link must be DOM **siblings** of the radio |
| "Create token ↗" link | none; `shell_open_url` exists and is scheme-allowlisted | no shared `openExternal` helper — three ad-hoc re-declarations today |
| Expiry handling | none anywhere | `getOctokit` only reads a host-pushed value; nothing mints or refreshes |
| Git transport uses Zeros' credential | never | the single root defect (§3) |
| Cloud sandbox can clone and push | no credential reaches a sandbox | plus three engine blockers (§7) |
| GitLab / Bitbucket tractable | `ReviewProvider` exists, 11/19 outside it | host-blind `repoSlug`; GitHub-shaped `PR` type; `gh` hardcoded in agent prose |
