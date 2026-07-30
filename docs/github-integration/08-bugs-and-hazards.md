# Bugs and Hazards Found in the Current Code

*Part 08 of the Zeros GitHub Integration Report · July 2026*

Every audit finding that survived adversarial refutation, grouped by area and ordered by
severity inside each. For each one: the anchor (`path:line`, re-opened and verified before it
was written down), what the code actually does, the concrete failure scenario, the fix, and the
regression test that must be written **first** — `AGENTS.md:28`: *"When fixing a bug, first
write the failing test (or smoke-harness assertion) that reproduces it, then fix it, then keep
the test. A bug without a regression test will come back."*

## The short version

- **125 findings were raised. 109 at medium-or-worse were each handed to an independent agent
  instructed to refute them. 52 survived, 57 were killed — a 52% kill rate.** That kill rate is
  the reason to trust what is left: this list has already been attacked once, item by item, by
  agents whose job was to make it go away.
- **Those 52 filings describe about 39 distinct defects.** Nine independent auditors covered
  overlapping ground, so the biggest bugs were filed two and three times from different
  anchors. That is corroboration, not padding — the 403 credential-destruction bug was found
  independently by three auditors working three different areas.
- **6 blockers, and they are only four distinct defects**: the token never reaches git
  transport; a 403 durably deletes the credential (filed 3×); "Create PR" never uses Zeros'
  token at all; and both push tests push to a local bare repo, so the credential gap cannot
  fail CI.
- **Several verifier corrections made findings worse, not better.** The 403 destruction has
  **two independent routes** to the durable secret, not one — Electron main runs its own
  safeStorage-backed `getAuthStatus`, so a single Refresh click in Settings deletes the keychain
  entry with no engine involved. And wiring "Create PR" to the engine's `createPr` would fix
  only the API half, because `createPr` calls `push()`, which carries no credential.
- **`withAuthRetry` does not retry.** Its doc comment has promised a one-shot 401 retry since
  the initial commit; the body clears the token and rethrows. Every design decision made by
  reading that comment is wrong.
- **One whole area was wiped out.** `cloud-workspace-credentials` raised 11 findings, including
  3 blockers, and **zero survived** — mostly because the auditors anchored on
  `scripts/cloud-spike/**`, which `scripts/cloud-spike/README.md:12-19` declares is not product
  code and ships in nothing.
- **The hazards section is not verified.** 16 low/info findings were never given to a refuter.
  They are listed separately and tagged as such; treat them as leads, not as facts.
- **Structural caveat, stated once:** the design panel and the report critics were cut for time.
  The severities below are the auditors' as amended by their refuters; nobody re-ranked the
  whole list against each other.

## How this list was produced, and how much to trust it

Nine code auditors worked the repo in parallel across nine areas; eight web researchers worked
the external surface (that half feeds parts 02–07, not this one). Every finding rated
medium-or-worse was then handed to **one independent agent whose only instruction was to refute
it** — read the anchored code, reproduce or fail to reproduce, and write `why_refuted` if it
did not hold.

| | Count |
|---|---|
| Findings raised | 125 |
| Sent to a refuter (medium or worse) | 109 |
| **Survived** | **52** (6 blocker, 28 high, 18 medium) |
| Killed | 57 |
| Never verified (low / info) | 16 |
| Kill rate | **52%** |

A 52% kill rate is high enough to be uncomfortable and that is the point. The killed findings
were not sloppy — most had a true mechanical observation and a false impact chain (§11 has six
instructive examples). The survivors are the ones where an agent tried to break the impact chain
and could not. Where a refuter *tightened* a finding, that correction is folded in below under
**Verifier**; where it changed the severity, both ratings are shown as `filed → re-rated`.

Confirmed findings by area:

| Area | Blocker | High | Medium | Total |
|---|---|---|---|---|
| `auth-state-machine` | 1 | 6 | 5 | 12 |
| `onboarding-and-repo-flows` | 2 | 5 | 4 | 11 |
| `github-api-layer` (`src/engine/git/github.ts`) | 1 | 4 | 2 | 7 |
| `tests-and-gates` (GitHub auth surface) | 1 | 3 | 2 | 6 |
| `settings-ui-and-state` | — | 3 | 2 | 5 |
| `git-transport-credentials` | 1 | 1 | 2 | 4 |
| `provider-abstraction` | — | 4 | — | 4 |
| `token-storage-security` | — | 2 | 1 | 3 |
| `cloud-workspace-credentials` | — | — | — | **0 of 11** |
| **Total** | **6** | **28** | **18** | **52** |

### The duplicate clusters

Ten defects were filed more than once from different anchors. Each is written up **in full
once** and cross-referenced from the other areas, so the list below is complete without being
triplicate.

| Defect | Filings | IDs |
|---|---|---|
| 403 durably deletes the credential | 3 | `403-rate-limit-destroys-credential`, `403-destroys-credential`, `403-clears-durable-token` |
| Sign out re-adopts the gh CLI token | 3 | `signout-is-a-noop-for-gh-cli-users`, `signout-silently-readopts-gh-cli`, `signout-readopts-gh-cli` |
| Plaintext token in the engine env, inherited by PTYs and agents | 3 | `token-in-spawn-env`, `github-token-in-local-subprocess-env`, `agent-gets-no-credential-token-leaks-in-pty` |
| Auth method never persisted | 2 | `viacli-not-persisted`, `no-persisted-auth-method` |
| `GITHUB_TOKEN_CHANGED` carries the token value to the renderer | 2 | `engine-broadcasts-plaintext-token-to-renderer`, `token-value-broadcast-to-renderer` |
| Settings keeps showing "Connected" after an engine-side clear | 2 | `engine-401-clear-never-refreshes-settings-ui`, `stale-connected-after-401` |
| Cold/offline probe fabricates "GitHub CLI not found" | 2 | `offline-cold-start-shows-wrong-copy`, `cold-error-fabricates-cli-missing` |
| `push()` misclassifies the no-credential failure | 2 | `push-error-misclassified`, `push-error-mapping-misses-no-credential-helper` |
| Publish leaves an orphan repo on GitHub | 2 | `publish-push-unclassified-and-hardcoded-origin`, `publish-orphan-repo` |
| No rate-limit awareness anywhere | 2 | `no-rate-limit-handling`, `pr-poll-no-ratelimit-awareness` |

### A note on how to test renderer findings

One refuted finding claimed the repo has no React component-test capability. That is false and
worth knowing before writing any of the tests prescribed below: the repo deliberately rejected
jsdom/happy-dom (`vitest.config.ts:78` sets `environment: "node"`) in favour of a **real
browser** harness — `scripts/ui-smoke-composer.mjs` boots the Vite dev server against a
standalone harness entry page, and `pnpm test:ui-smoke` is a gate. So renderer-side regressions
have two legitimate homes: extract the decision into a pure resolver and unit-test it in node
(the idiom in `src/zeros/panels/__tests__/repo-branch-catalog-cache.test.ts`), or add a harness
page plus a `test:ui-smoke` assertion. "It cannot be tested" is not available.

---

## 1. The six blockers

Four distinct defects. They form a single chain: the credential is REST-only (B1), so push
fails; the error that comes back is misclassified (B2) into deleting the credential; the
product's primary PR path never used the credential in the first place (B3); and no test can
observe any of it (B4).

| # | Defect | Filed as | Anchor |
|---|---|---|---|
| B1 | The persisted token never reaches git transport | `token-never-reaches-git-transport` | `src/engine/git/git-exec.ts:291`, `src/engine/git/ops.ts:116`, `src/engine/git/github.ts:1076` |
| B2 | `isAuthError()` treats 403 as 401 → durable credential deletion, via **two** routes | `403-rate-limit-destroys-credential`, `403-destroys-credential`, `403-clears-durable-token` | `src/engine/git/github.ts:390`, `:209`, `:497`; `src/engine/git/engine-token-store.ts:54`; `electron/ipc/commands/github.ts:54` |
| B3 | "Create PR" never uses Zeros' token — it sends the agent a brief saying `gh pr create` | `create-pr-bypasses-engine-auth` | `src/shell/pr/create-pr-button.tsx:95`, `src/shell/pr/pr-instructions.ts:78`, `packages/core/src/system-instructions/templates.ts:44` |
| B4 | Both push tests push to a local bare repo, so the credential gap cannot fail CI | `push-credential-helper-untestable-by-construction` | `src/engine/git/__tests__/publish-github.test.ts:3`, `src/engine/git/__tests__/ops.test.ts:104` |

### B1 · `token-never-reaches-git-transport` — blocker (architecture)

**Where** `src/engine/git/git-exec.ts:291`; `src/engine/git/ops.ts:116-140`;
`src/engine/git/github.ts:1076`; `src/engine/git/engine-token-store.ts:46`.

**What the code does.** `runGit` merges caller env over `process.env` only when a caller
supplies env — verified verbatim at `git-exec.ts:291`:
`...(opts.env ? { env: { ...process.env, ...opts.env } } : {})`. The only callers that pass env
are the per-turn index snapshot (`GIT_INDEX_FILE`) and commit-author stamping. Nothing anywhere
in `src/` or `electron/` sets `GIT_ASKPASS`, `core.askPass`, `credential.helper`,
`http.extraheader`, or rewrites a remote to `https://x-access-token:TOKEN@github.com` — a
repo-wide grep for those names returns only `env-names.ts` classifying them as untrusted-env
vectors, plus the comment at `github.ts:898`. The token store
(`engine-token-store.ts:46`) is read *only* by `getOctokit` / `getOptionalAuthOctokit`
(`github.ts:352`, `:379`). The code says so out loud at `github.ts:898`: *"The push relies on
the user's git credential helper (gh), same as the existing workspace push."*

**Fails when.** A user pastes a PAT (`github.ts:259`) or completes the device flow
(`github.ts:329`) on a Mac with no `gh` and no `osxkeychain` helper, on an HTTPS remote.
Settings → GitHub shows "Connected as `<login>`" and every PR read works, because those go
through Octokit. Then Push, Create PR's pre-push (`github.ts:746`), or `publishRepoToGithub`'s
raw push (`github.ts:1076`) all fail. gh-CLI users work only by coincidence: `detectGhCli`
shells `gh auth token`, and a machine with `gh auth login` happens to have *both* an API token
Zeros can read *and* a credential helper git can use.

**Verifier.** Two refinements, both narrowing scope and one making the symptom worse.
(1) SSH-cloned repos are unaffected — the blast radius is HTTPS remotes — but
`publishRepoToGithub` always wires `origin` to the HTTPS `clone_url` (`github.ts:1065`), so that
flow fails regardless of how the user normally clones. (2) The failure does **not** surface as
`NOT_AUTHENTICATED`: `ops.ts:128` matches only `/not authenticated|authentication failed|403|401/i`,
and git's real stderr in a non-tty Electron child is
`could not read Username for 'https://github.com': No such device or address`, which matches
none of it. The user gets an opaque `GIT_COMMAND_FAILED` with no re-auth remediation.

**Fix.** The credential broker (part 04): host-scoped `-c credential.https://github.com.helper=<shim>`
plus `-c credential.helper=` to reset inherited helpers, `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT=0`,
and PATH-shimmed `git`/`gh`, injected per invocation from the same store the API uses. Host
scoping is a security requirement, not tidiness — an unscoped helper offers the GitHub
credential to every remote, including an attacker-controlled one in a malicious repo's
`.gitmodules`.

**Test first.** `src/engine/git/__tests__/push-credentials.test.ts`. Serve a bare repo over
loopback HTTP via `git http-backend` behind a tiny node server that requires Basic auth. Point
`HOME` and `GIT_CONFIG_GLOBAL` at an empty temp dir, set `GIT_TERMINAL_PROMPT=0` and
`GIT_ASKPASS=/bin/false`, put **only** the injected token in the store, and assert
`push({workspaceId})` succeeds and that the server saw the token. **This test must fail today.**
A cheap seam already exists for the fix side: `setPushForTesting` (`github.ts:729`) plus
`runGit`'s assertable args/env.

### B2 · `403-destroys-credential` / `403-rate-limit-destroys-credential` / `403-clears-durable-token` — blocker (bug), filed 3×

**Where** `src/engine/git/github.ts:390-394` (the classifier), `:209-214` (`getAuthStatus`),
`:497-503` (`withAuthRetry`); `src/engine/git/engine-token-store.ts:54-57`;
`electron/ipc/commands/github.ts:54-56`; `electron/main.ts:1116-1131`.

**What the code does.** Verified verbatim:

```ts
// src/engine/git/github.ts:390
function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: number }).status;
  return status === 401 || status === 403;
}
```

Both consumers respond by destroying the credential. `getAuthStatus` (`:209-213`) does
`await tokenStore.clear(); clearOctokitCache(); return { authenticated: false }`. `withAuthRetry`
(`:498-501`), which wraps essentially every PR read and write, does `clearOctokitCache(); await tokenStore.clear()`
and rethrows. But 403 is GitHub's status for at least six non-credential conditions: primary
rate limit, secondary rate limit, org SAML/SSO enforcement, org IP-allow-list denial,
"Resource not accessible by personal access token" / "by integration", and writes to an
archived repo.

**Two independent routes to the durable secret** — this is the verifier's most important
correction, and it makes the bug worse than filed. All three auditors traced only the engine
path. But `gh_auth_status` does not run in the engine; it runs in **Electron main**
(`electron/ipc/commands/github.ts:54-56`, under the module header *"What stays here in Electron
main is everything that touches ONLY the OS keychain"*), where the injected `TokenStore` is
safeStorage-backed (`electron/main.ts:1116-1131`, `clear()` === `deleteSecret(GITHUB_OAUTH_ACCOUNT)`).
So a single 403 while the user presses **Refresh** in Settings deletes the durable secret
directly and synchronously, with no bridge hop and no renderer involvement.

```mermaid
flowchart TD
  A["403 from api.github.com<br/>(rate limit / SAML / scope / not-installed)"] --> B["isAuthError()<br/>github.ts:390 — true for 401 OR 403"]
  B --> R1["Route 1 — Electron main<br/>gh_auth_status → getAuthStatus<br/>ipc/commands/github.ts:54"]
  B --> R2["Route 2 — engine<br/>any gh.* PR op → withAuthRetry<br/>github.ts:497"]
  R1 --> S1["tokenStore.clear()<br/>= deleteSecret(github_oauth)<br/>electron/main.ts:1116-1131"]
  R2 --> S2["engineGithubTokenStore.clear()<br/>engine-token-store.ts:54 → onChange(null)"]
  S2 --> S3["GITHUB_TOKEN_CHANGED broadcastLocal<br/>src/engine/index.ts:1109-1117"]
  S3 --> S4["renderer wireGithubTokenWriteback<br/>github-token-sync.ts:33 → gh_token_clear"]
  S4 --> S1
  S1 --> X["Durable credential destroyed.<br/>PAT users: permanent until manual re-auth."]
```

**Fails when.** (a) A user pastes a fine-grained PAT — the only copy, GitHub never shows it
again — and opens a repo in a SAML-SSO org the PAT is not authorised for. The first PR poll
403s and erases the token. (b) Several workspaces poll PR checks while an agent also runs `gh`
commands; a secondary rate limit returns 403 and signs the user out for a throttle that would
have cleared in 60 s. (c) **Under the planned GitHub App this becomes routine**: 403 is also the
code for "the App is not installed on this repository", so opening one un-covered repo would
nuke the entire connection including the repos it does cover. Per-repo installation scoping
*generates* 403s by design.

**Verifier, three more corrections.** (1) `withAuthRetry` does not retry despite its name and
doc comment (see A-H1), so there is no second attempt that a transient throttle could survive.
(2) A partial mitigation exists but only for gh-CLI users: the Settings fetcher falls back to
`ghDetectCli()` and re-adopts (`github-section.tsx:98-104`), so a gh user self-heals on the next
Settings open and never sees "Not connected". PAT and device-flow users get no self-heal at all.
(3) Because `wrapApiError` returns early on `isAuthError`, the 403-specific remediation strings
at `github.ts:447-475` are **dead code for every 403** — the user gets a generic
"Re-authenticate" even when GitHub sent "Resource protected by organization SAML enforcement".
Note also that GitHub returns **404**, not 403, for a private repo a token simply cannot see, so
the genuine 403 triggers are exactly the ones named above.

**Fix (exact).** Split the classifier. `isCredentialInvalid(err)` = 401 only, plus 403 whose
`response.data.message` matches `/bad credentials|token.*(expired|revoked)/`. Add
non-destructive codes: `GITHUB_RATE_LIMITED` (403/429 with `x-ratelimit-remaining: 0` or a
`retry-after` header), `GITHUB_SSO_REQUIRED` (403 carrying `x-github-sso`),
`GITHUB_FORBIDDEN_SCOPE` ("Resource not accessible by…"), `GITHUB_REPO_NOT_INSTALLED`.
**Only `isCredentialInvalid` may call `tokenStore.clear()`.** Stop short-circuiting
`wrapApiError` on 403 so GitHub's own message survives. On SAML, handle all three shapes the
docs describe: 403 with `X-GitHub-SSO` and a one-hour authorization URL, a bare 404, and — on
list endpoints — a **200** with `X-GitHub-SSO: partial-results; organizations=…`.

**Test first.** `src/engine/git/__tests__/github-auth-classifier.test.ts`: a table of synthetic
errors — 401 "Bad credentials"; 403 secondary rate limit with `retry-after`; 403 with
`x-ratelimit-remaining: 0`; 403 with `x-github-sso`; 403 "Resource not accessible by personal
access token"; 404 — crossed with both entry points (`getAuthStatus`, and a `withAuthRetry`
caller such as `listPrs`). Assert `tokenStore.get() !== null` for every non-401 case and `null`
only for 401. Then a **second, independent** test for route 1, driving
`electron/ipc/commands/github.ts:54` against a safeStorage-backed fake store — one test cannot
cover both routes, which is precisely how three auditors missed one of them. There is currently
zero 403 evidence in the repo: the probe file the auditors cited
(`src/engine/git/__tests__/zzz-err-probe.test.ts`) does not exist in the working tree; it
survives only inside a Conductor checkpoint commit.

### B3 · `create-pr-bypasses-engine-auth` — blocker (architecture)

**Where** `src/shell/pr/create-pr-button.tsx:95-140`; `src/shell/pr/pr-instructions.ts:74-80`;
`packages/core/src/system-instructions/templates.ts:44`; `src/engine/git/github.ts:737`.

**What the code does.** `sendCreatePrompt` gathers local counts and sends
`buildPrInstructions(...)` into the active chat. That brief literally instructs the agent —
verified verbatim at `pr-instructions.ts:78-80`:

```
- Push with `git push -u '<remote>' HEAD:'<branch>'`.
- Use `gh pr create --base <base>` to create a PR onto the target branch. …
```

and the workspace preamble reinforces it for **every chat's first turn**
(`templates.ts:44`): *"Use it for actions like diffing (`git diff {TARGET_BRANCH}...`) and
creating PRs (`gh pr create --base <branch>`)"*. The engine's real API path exists — `createPr`
(`github.ts:737`) via `gh.prCreate` (`src/engine/workspace/service.ts:2432`), exposed as
`ghPrCreate` (`src/native/git.ts:1022`) — and has **zero renderer call sites**; it is a dead
export. `useWorkspacePrSync` exists only to backfill the `prNumber` afterwards, because the
agent's PR "never touches the engine".

**Fails when.** A user picks "Personal Access Token" in the new picker, sees a green Connected,
clicks Create PR — and the agent's `gh pr create` fails with *"gh: To get started with GitHub
CLI, please run: gh auth login"*, because the agent's shell has no gh login and Zeros' token was
never handed to it. Under the Zeros GitHub App the same click fails identically. In a cloud
sandbox there is no `gh` and no keychain, so Create PR cannot work by construction.

**Verifier — this correction makes the finding worse.** The finding implies the engine's
`createPr` is a ready-made fix. It is not: `createPr` calls `push()` (`ops.ts:116-143`), which
shells a plain `git push` **carrying no credential material**. So wiring the button to
`ghPrCreate` would fix only the API half; the push half would still depend on the user's own
credential helper — the same gap as B1. A complete fix needs a renderer call site for
`ghPrCreate` **and** token-bearing git transport on the engine's push path **and** brokered
credentials in any agent shell still told to push itself.

**Fix.** Both halves. (a) Route the primary Create PR through the engine `createPr` (which
already pre-pushes and stamps the workspace row), keeping the agent brief as a secondary
"let the agent do it" affordance. (b) Provision the chosen credential where the agent can use it
— the broker's PATH-shimmed `git`/`gh` is exactly this, and it is what makes the agent's own
`gh pr create` work under all three methods without rewriting the agent flow.

**Test first.** Two tests. (1) `src/engine/git/__tests__/create-pr-transport.test.ts`: assert
`createPr` reaches `runGit` with host-scoped credential args (`-c credential.https://github.com.helper=…`)
and that the injected Octokit factory received the same token — pinning that the API half and
the transport half agree. (2) Extract the button's decision into a pure
`resolveCreatePrRoute({method, hasEngineCredential})` and unit-test in node that it returns the
engine route when a credential exists; or add a `test:ui-smoke` assertion on the harness page
that the click issues a `gh.prCreate` op. Note the current strings are pinned by
`pr-instructions.test.ts:23,57` and `pr-action-prompts.test.ts:86`, so any brief change updates
those.

### B4 · `push-credential-helper-untestable-by-construction` — blocker (test-coverage)

**Where** `src/engine/git/__tests__/publish-github.test.ts:1-4`;
`src/engine/git/__tests__/ops.test.ts:104`.

**What the code does.** The test file says it outright, verified verbatim at
`publish-github.test.ts:1-4`: *"the mock's `clone_url` points at a real LOCAL bare repo so the
`git push` works offline. We never hit github.com."* `ops.test.ts:104` ("push to new remote sets
upstream and reports remoteRef") does the same. A `file://` push needs no credential at all, so
neither test exercises the path where `git push` must authenticate. Nothing in the suite asserts
that the stored Zeros token is used for git transport.

**Fails when.** A fix for B1 ships with no regression test, and a later refactor silently
reverts it. That is not hypothetical: the credential path is invisible to every existing gate,
so the revert would be green.

**Verifier — severity re-framed, not reduced.** Three corrections. (a) Only `ops.ts` `push()`
carries the `NOT_AUTHENTICATED` mapping, and only for the `/403|401|authentication failed/`
shape; `publishRepoToGithub`'s push at `github.ts:1076` passes **no `mapErrorCode` at all**, so
its failures are generic `GIT_COMMAND_FAILED`. (b) Neither push passes `timeoutMs` and
`GIT_TERMINAL_PROMPT` is never set, so where a tty is reachable git can block on a credential
prompt indefinitely — a hang, worse than an error. (c) As a *tests-and-gates* defect this is
coverage for behaviour that does not exist yet: the blocker is the product gap (token is
REST-only), with the test note a real but secondary consequence. Keep it at blocker because it
is the reason B1 could sit in shipping code unnoticed.

**Fix.** Land the B1 test (`push-credentials.test.ts`) as the new gate, and add the negative
case: with an **empty** token store and no ambient helper, `push()` must fail with a
credential-specific code and a remediation, not `GIT_COMMAND_FAILED`.

**Test first.** As B1. Additionally add `src/engine/git/__tests__/publish-github.test.ts` cases
that drive the failing-push path (today `publish-github.test.ts` only exercises the succeeding
local-bare-repo push), asserting the orphan-repo state is either rolled back or persisted with a
retry affordance — see O-H3.

---

## 2. `auth-state-machine` — 12 findings (1 blocker, 6 high, 5 medium)

The state machine's defining property is that **reads mutate the credential**. Three separate
findings below are that one property seen from three angles.

| ID | Filed → re-rated | Anchor | One line |
|---|---|---|---|
| `403-rate-limit-destroys-credential` | blocker | `github.ts:390` | → see **B2** |
| `engine-broadcasts-plaintext-token-to-renderer` | high → medium today, high once the App ships | `src/engine/index.ts:1109` | The token *value* is broadcast to the renderer |
| `engine-401-clear-never-refreshes-settings-ui` | high | `github-token-sync.ts:33` | An engine-side clear never invalidates the Settings snapshot |
| `detectghcli-persists-during-a-read` | high (scope narrowed) | `github.ts:249` | A read path writes the token store, racing an explicit sign-in |
| `signout-is-a-noop-for-gh-cli-users` | high | `github-section.tsx:164` | Sign out re-adopts the gh token — two independent routes |
| `silent-identity-swap-on-token-expiry` | high | `github-section.tsx:99` | Credential failure silently re-authenticates as a *different* identity |
| `single-token-slot-blocks-per-method-credentials` | high | `github.ts:101` | One slot, one scalar wire type, three duplicated account literals |
| `dosignout-unhandled-rejection` | medium → low-medium | `github-section.tsx:164` | No `catch`; a failing sign-out is an unhandled rejection |
| `viacli-not-persisted` | medium | `read-caches.ts:19` | The method is a per-session guess; lost on restart |
| `offline-cold-start-shows-wrong-copy` | medium | `github-section.tsx:91` | Offline cold start claims "GitHub CLI not found" without probing |
| `github-token-in-local-subprocess-env` | medium | `electron/sidecar.ts:1194` | → see **TS-H1** |
| `no-test-coverage-for-auth-transitions` | medium | `github.test.ts:356` | Only `getAuthStatus` has tests |

### A-H1 · `engine-broadcasts-plaintext-token-to-renderer` — high → medium today, high once the App ships (security)

*Also filed as `token-value-broadcast-to-renderer` (token-storage-security, high).*

**Where** `src/engine/index.ts:1109-1117`; `src/engine/git/engine-token-store.ts:50-53`;
`src/engine/git/github.ts:249`; `src/engine/transport/router.ts:86-90`;
`src/zeros/bridge/github-token-sync.ts:10-12`.

**What the code does.** Verified verbatim at `src/engine/index.ts:1108-1117`: the notifier is
wired to `this.router.broadcastLocal(createMessage({ type: "GITHUB_TOKEN_CHANGED", source: "engine", token }))`
— the raw value. `engineGithubTokenStore.set()` fires `onChange?.(token)` on **every** set, not
only on clear (`engine-token-store.ts:50-52`). `broadcastLocal` delivers to every client with
`kind === "local"`, and the renderer's websocket client *is* a local client. This contradicts the
stated design invariant at `src/zeros/bridge/github-token-sync.ts:10-12` — *"the renderer NO
LONGER fetches the decrypted token … so a renderer XSS can't read it"* — and
`electron/ipc/commands/github.ts:15-17`.

**Fails when.** The one engine-side `set()` with a real value is the zero-config boot adopt at
`src/engine/index.ts:1137-1148` (`detectGhCli` → `github.ts:249`), gated on the store being
null. So the value that can leak today is exclusively the **gh CLI's** token, never the
safeStorage OAuth/PAT token (that arrives via `seedGithubToken`, which deliberately does not
notify).

**Verifier — narrower today, deterministic tomorrow.** `broadcastLocal` has no buffering and no
on-connect replay, and the loopback WS server only starts at `src/engine/index.ts:1350`, after
the fire-and-forget IIFE at `:1137` and ~12 awaited boot steps. On a cold launch the frame is
frequently dropped with zero clients attached. The reliably reproducible case is an **engine
respawn mid-session** with an empty safeStorage slot while the renderer's reconnect loop is
attached; a console attacker who subscribes first and then forces a respawn gets it
deterministically. It is also defence-in-depth rather than a new capability: the same bridge
already accepts `PTY_CREATE`/`PTY_WRITE` (`src/engine/index.ts:1797-1800`), so a renderer XSS can
already shell out to `gh auth token` — the same value. Severity **today: medium**. The
**high-severity part is forward-looking and stands as written**: once the App re-mints
installation tokens inside the engine roughly hourly, every refresh calls `set()` and broadcasts
a live installation credential to the renderer on a fixed cadence. Packaged DevTools is
deliberately left open (`electron/devtools.ts:5-38`, which itself notes an open console "really
can read live credentials").

**Fix.** One line, and it must land before the App does. Change `GithubTokenChangedMessage` to
carry no value — `{ reason: "invalidated" | "adopted", login? }` or simply `{ cleared: true }`.
The only consumer already ignores every non-null value
(`src/zeros/bridge/github-token-sync.ts:36-41`), so nothing is lost. If engine→host *persistence*
is ever needed, route it over the private fd-3 control pipe (`ZEROS_CONTROL_FD`,
`electron/sidecar.ts:1200-1205`), which is documented as never logged and never relayed.
Separately, give the engine's boot probe a non-persisting variant so an engine-local adoption
never crosses a process boundary at all.

**Test first.** `src/engine/__tests__/github-token-broadcast.test.ts`: wire
`setGithubTokenChangeNotifier` to a recording sink, call
`engineGithubTokenStore.set("ghs_live_value")`, and assert the emitted message contains **no**
substring of the token. Today that fails.

### A-H2 · `engine-401-clear-never-refreshes-settings-ui` — high (bug)

*Also filed as `stale-connected-after-401` (settings-ui-and-state, medium → low).*

**Where** `src/zeros/bridge/github-token-sync.ts:32-42`; `src/zeros/store/use-cached-read.ts:63-73`;
`src/zeros/store/read-caches.ts:31`, `:99-106`; `src/zeros/panels/github-section.tsx:281-288`.

**What the code does.** `wireGithubTokenWriteback` handles `GITHUB_TOKEN_CHANGED` by calling
`nativeInvoke("gh_token_clear")` and nothing else. It never touches `ghAuthStatusCache`.
`useCachedRead`'s background revalidation effect only refires on `snapshot.invalidationVersion`,
which `setData` deliberately does not advance; the only thing that advances it for this cache is
`invalidateAllEngineReadCaches()`, called solely from a **non-initial** bridge reconnect.

**Fails when.** An engine 401 (or, per B2, a 403) inside `gh.prChecks` clears the token in the
engine and in safeStorage. Settings → Integrations keeps rendering the green check and "Signed in
as @login" from the retained snapshot while every PR op fails with `NOT_AUTHENTICATED`.

**Verifier — four tightenings, one of which is the sharpest point in the finding.**
(a) The hook is `src/zeros/store/use-cached-read.ts`, not `src/zeros/lib/`. (b) "Indefinitely"
holds only once Settings → Integrations has been mounted: the retained-view-keys policy
(`settings-page.tsx:601-605` retains all visited sections; `app-shell.tsx:940` retains the
settings page among 4) keeps `GitHubSection` mounted for the rest of the session, so the effect
never re-runs and the 60 s freshness window is never consulted again. A *first* mount after the
invalidation, or a mount after the settings page is evicted, does refetch and shows the truth.
(c) It is permanently wrong only for PAT and device-flow users; a gh-CLI user's probe re-adopts
and self-heals the card. (d) **In the stale "connected" state the card offers only "Sign out" —
the Refresh button exists only in the not-connected branch (`github-section.tsx:281-288`) — so
the user has no way to force a re-probe short of signing out.**

**Fix.** In the writeback handler, on `token == null` also invalidate the GitHub auth key. Add a
narrow `invalidateGithubAuthCaches()` next to `invalidateAllEngineReadCaches()` in
`read-caches.ts` so enrolling a future per-method health cache stays one edit in one file, as
that file's header requires. Better still: make auth status a push-driven store fed by an
engine/main event rather than a polled cache — with three method rows each carrying a health
line, one expired credential otherwise keeps showing "All repositories accessible."

**Test first.** `src/zeros/bridge/__tests__/github-token-sync.test.ts`: seed
`ghAuthStatusCache.setData("auth", {login:"x",…})`, deliver a `GITHUB_TOKEN_CHANGED(null)`
message, assert `ghAuthStatusCache.getSnapshot("auth")` is invalidated (or reports
`login: null`). Add a `test:ui-smoke` assertion that a Refresh control is present in the
connected branch.

### A-H3 · `detectghcli-persists-during-a-read` — high, scope narrowed (bug)

**Where** `src/engine/git/github.ts:246-254`; `src/zeros/panels/github-section.tsx:100`, `:176`;
`src/engine/index.ts:1140`.

**What the code does.** `detectGhCli()` unconditionally does `await tokenStore.set(token)` when
`gh auth token` yields a working token — with no compare-and-swap. It is invoked from the
Settings **read** fetcher (`github-section.tsx:100`), from `doSignOut`'s `refresh()` (`:176`),
and from the engine boot path. The renderer's `KeyedAsyncCache` generation guard protects only
the *snapshot*; it cannot undo a safeStorage write the fetcher already performed in main.

**Fails when.** Exactly one window exists. After an explicit Sign out or a manual Refresh while
signed out, a `ghSetToken` (PAT) that completes between `detectGhCli`'s `gh auth token`
subprocess starting and its `tokenStore.set` is overwritten by the gh token in safeStorage. The
UI shows the PAT identity; every GitHub call runs as the gh identity with gh's scopes.

**Verifier.** Directionally right, scope overstated. The read path reaches `detectGhCli` **only**
when `ghAuthStatus()` has already reported unauthenticated (`github-section.tsx:93-99`), and the
sign-in controls are not rendered during a first load. The 5 s figure is `runFile`'s timeout
ceiling, not the typical window (a few hundred ms plus one `/user` round trip). The device flow
cannot lose this race — its ~15-minute window means it always writes last. The engine boot call
is **not** a clobber source: it is gated on the store being null and writes only the engine's
in-memory copy. And the divergence is not silent forever: the panel re-reads past the 60 s
freshness window and on restart, then displays the gh identity.

**Fix.** Separate probe from adoption. `probeGhCli()` returns `{available, authenticated, login}`
without persisting, and is what status reads call; an explicit `adoptGhCli()` is called only by
the user's method selection. This is a hard prerequisite for the three-way radio — **a read must
never change which credential is active.** Add a compare-and-swap or generation counter on every
token write so a late writer cannot clobber a newer one.

**Test first.** `src/engine/git/__tests__/gh-cli-probe.test.ts`: assert `probeGhCli()` leaves
`tokenStore.get()` unchanged for all four `detectGhCli` outcomes (ENOENT, spawn failure, empty
stdout, verifying token), and that `adoptGhCli()` refuses to overwrite a token written after it
started (seed store generation N, resolve the fake `gh auth token` at generation N+1, assert the
newer value survives).

### A-H4 · `signout-is-a-noop-for-gh-cli-users` — high (ux)

*Also filed as `signout-silently-readopts-gh-cli` (settings-ui-and-state, high) and
`signout-readopts-gh-cli` (tests-and-gates, high). Three independent filings.*

**Where** `src/zeros/panels/github-section.tsx:164-180`; `src/engine/git/github.ts:249`;
`src/engine/index.ts:1128-1148`.

**What the code does.** Verified verbatim at `github-section.tsx:167-176`: `doSignOut` awaits
`ghSignOut()`, writes `{login:null}` into the cache, then calls `refresh()` under the comment
*"Re-probe: matches the old flow, where an authenticated gh CLI is rediscovered (and re-adopted)
after an explicit sign-out."* The refresh re-enters the fetcher's unauthenticated branch, which
calls `ghDetectCli()` → `github.ts:249` → writes back to safeStorage via
`electron/main.ts:1121-1131`.

**Fails when.** On the majority of dev machines (`gh` installed and logged in), Sign out returns
to "GitHub CLI is authenticated and ready — Signed in as @them". There is no way to reach a
disconnected state short of `gh auth logout`.

**Verifier — understated: there are TWO independent re-adoption sites, not one.** (a) The
renderer's post-sign-out `refresh()`. (b) **The engine re-adopts the gh CLI login on every boot
whenever the host couriered no token** (`src/engine/index.ts:1128-1148`) — so deleting the
renderer refresh would still not make sign-out stick across a restart. Both must be gated behind
a persisted explicit method selection. Two details in the filing are wrong but immaterial: the
card does not "blank" (it renders the full not-connected block for the round-trip duration), and
the user *can* still displace the gh token by pasting a PAT — so the accurate phrasing is "no way
to reach a disconnected state", not "no way to change credentials". A further nuance from the
tests-and-gates filing's verifier: the engine's boot re-adoption does **not** durably overwrite
safeStorage (the writeback mirrors clears only), so it produces a *separate* divergence — after
a sign-out, restarting the engine silently re-authenticates every `gh.*` op from an in-memory gh
token while safeStorage stays empty and the UI reads "signed out".

**Fix.** Persist the chosen method including an explicit `"none"` state
(`~/.zeros/settings.toml` → `[github] authMethod`), and gate **both** probe sites on it. Sign out
writes `authMethod = none` durably and stops probing. This is the single hardest blocker for the
explicit-method design: any "none / PAT / App" selection is otherwise overwritten by the CLI
probe on the very next read.

**Test first.** `src/zeros/panels/__tests__/github-connection.test.ts`: extract the fetcher into
a pure `resolveGithubConnection({getAuthStatus, detectGhCli, selectedMethod})` and assert
(1) `detectGhCli` is never called when the persisted method is `"app"`, `"pat"` or `"none"`, and
(2) after an explicit sign-out the resolver returns disconnected even when `detectGhCli` would
authenticate. Plus `src/engine/__tests__/boot-gh-adoption.test.ts`: with a persisted
`authMethod = "none"`, engine boot must not call `detectGhCli`.

### A-H5 · `silent-identity-swap-on-token-expiry` — high (bug)

**Where** `src/zeros/panels/github-section.tsx:99-104`; `src/engine/git/github.ts:210-213`,
`:249`; `src/engine/index.ts:1137-1149`.

**What the code does.** The fetcher's flow: `ghAuthStatus()` → main's `getAuthStatus()` sees
401/403 → `tokenStore.clear()` → returns `{authenticated:false}` → the fetcher falls through to
`ghDetectCli()` → adopts and persists the gh CLI token → returns `{login: ghLogin, viaCli: true}`.
The comment at `github-section.tsx:99` — verified verbatim, *"Not signed in — probe the gh CLI
and adopt its token if present"* — treats this as intended.

**Fails when.** A user deliberately connected a fine-grained PAT scoped to one org. The PAT hits
its expiry date. On the next Settings open Zeros silently swaps to whatever `gh auth token`
returns — often a different account (personal vs work) with broad `repo` scope — and reports it
as a healthy connection. Every subsequent PR create/merge/comment is attributed to the wrong
identity with wider privileges. This is the behaviour most incompatible with the "user consent,
per-repo installation scoping" goal.

**Verifier — three corrections.** (1) The trigger is broader than PAT expiry: because
`isAuthError` counts 403, a **still-valid** fine-grained PAT can be swapped out on a transient
403. (2) "No visible transition" is overstated — `github-section.tsx:203-210` does flip the
headline to "GitHub CLI is authenticated and ready" and render the new `@login`, so a user
*looking at Settings* sees the new identity. What is genuinely absent is any consent prompt, any
"your token expired" notice, and any signal outside the Settings panel. (3) The Settings fetcher
is not the only entry point: the engine's zero-config boot adopt also fires after a clear, with
no UI mounted at all. Precondition: `gh` must be installed and logged in; the "different account
with broader scope" outcome is plausible, not guaranteed.

**Fix.** On credential invalidation, transition to an explicit `needs-reauth` state that **names
the method that failed** and requires a click before adopting any other credential. Never cross
method boundaries automatically.

**Test first.** Extend `github-connection.test.ts`: given persisted method `"pat"` and a
`getAuthStatus` that reports unauthenticated, assert the resolver returns
`{state: "needs-reauth", method: "pat"}` and that `detectGhCli` was not called.

### A-H6 · `single-token-slot-blocks-per-method-credentials` — high (architecture)

**Where** `src/engine/git/github.ts:101-105`; `electron/main.ts:1116`; `electron/sidecar.ts:1520`;
`electron/ipc/commands/github.ts:38`; `packages/core/src/messages.ts:245-257`;
`src/engine/git/engine-token-store.ts:24`; `src/zeros/store/read-caches.ts:19-23`.

**What the code does.** `TokenStore` is `{ get(): Promise<string|null>; set(token: string); clear() }`
— no method, no scope, no expiry, no installation id. The durable slot is a single safeStorage
account whose name `"github_oauth"` is a literal **duplicated in three files**, the last with a
comment noting they "MUST stay in sync". The wire messages carry a bare `token: string | null`.
The renderer's `GithubConnection` has no method/health/installation fields.

**Fails when.** Adding independent per-method slots touches: the `TokenStore` interface and both
implementations, three duplicated account literals, the `GITHUB_TOKEN_SET`/`GITHUB_TOKEN_CHANGED`
schemas in `packages/core`, the env+stdin courier, the engine's module-level single `let`, and the
renderer cache shape. Today's single slot plus a non-durable `viaCli` boolean cannot represent
"switching method must not destroy the other credential", which is what makes the picker honest.

**Verifier — two corrections.** (1) The `cachedOctokitToken === token` identity check
(`github.ts:366`, duplicated at `:384`) does **not** "become insufficient" — as a
cache-invalidation rule it stays correct. What is actually missing is that **nothing mints or
refreshes on expiry**: `getOctokit` only ever reads a value pushed in from the host, so an
expiring 1 h installation token surfaces as a 401 that `withAuthRetry` converts into a full
sign-out rather than a refresh. (2) Changing the wire schemas does not by itself trigger a
preload-allowlist review — those messages travel over the engine WS bridge and the sidecar stdin
channel, not preload IPC; the allowlist is implicated only through the `gh_*` command surface and
`electron/keychain-accounts.ts`. Worth adding: **a second durable slot already exists but is
dead** — `SECRET_ACCOUNTS.GITHUB_PAT = "github-pat"` (`src/native/secrets.ts:73`),
renderer-allowlisted at `electron/keychain-accounts.ts:33`, with no reader or writer in the tree.

**Fix.** Model the credential as a discriminated union on method, end to end — exactly the shape
Conductor persists (`{authMethod: "pat", token} | {authMethod: "conductor-app", appClientId, token, expiresAt?}`,
teardown §2). Centralise the safeStorage account names in one exported constant; version the wire
messages; separate slots per method; and route git transport through the active credential so the
health readout actually predicts whether push works.

**Test first.** `electron/__tests__/keychain-accounts.test.ts` — a dependency-free pure
predicate, already in the vitest include list, so this is testable immediately: assert
`isRendererKeychainAccount` denies `github_oauth` and every new App account name, and add a
**drift check** that `VENDOR_ACCOUNTS` stays in sync with `SECRET_ACCOUNTS` (nothing enforces
that invariant today, and it is already broken in both directions). Then a store test asserting
that writing the PAT slot leaves the App slot intact.

### A-M1 · `dosignout-unhandled-rejection` — medium → low-medium (bug)

**Where** `src/zeros/panels/github-section.tsx:164-180`, `:216`.

**What the code does.** `doSignOut` is `try { await ghSignOut(); … } finally { setBusy(false) }`
— no `catch` — and is passed directly as `onClick={doSignOut}`, so React drops the returned
promise. It also never calls `setError(null)`, unlike `submitPat` and `connectDeviceFlow`.

**Verifier — most of the cited triggers are wrong; one is genuine.** "safeStorage unavailable" is
not a trigger (`ensureEncryptionAvailable()` is called only by `setSecret`; `deleteSecret` never
touches safeStorage — a dead keystore makes sign-out *succeed*). "Missing preload bridge" is
unreachable for this button, because the Sign out button renders only in the `login`-non-null
branch and `ghAuthStatusCache` is memory-only, so there is no stale connected snapshot to carry
into a browser-only session. "secrets.json locked" is not a trigger either — `withSecretsLock`
steals a stale lock and proceeds unlocked after 5 s. **The one genuine trigger is a filesystem
error while rewriting `<userData>/secrets.json`** (ENOSPC/EROFS/EACCES/EIO): unhandled rejection
surfaced only to the analytics `unhandledrejection` handler, stale "Signed in as @x" card,
re-enabled button, no message. The stale-error half is real but arrives differently than
described — the pinned error must have survived a disconnected→connected transition, and is
already visible *before* sign-out; the missing `setError(null)` keeps it pinned rather than newly
introducing it.

**Fix.** `setError(null)` at the top and `catch (e) { setError(humanError(e)) }`, matching the
other two mutations. Consider a shared `runAuthAction(fn)` so all three mutations share
busy/error handling — with three method rows each having connect/disconnect/refresh, that helper
stops being optional.

**Test first.** Unit-test the extracted `runAuthAction` in node: a rejecting action must set the
error and clear busy; a succeeding one must clear the prior error.

### A-M2 · `viacli-not-persisted` — medium (gap)

*Also filed as `no-persisted-auth-method` (settings-ui-and-state, high) — see S-H1 for the fix
detail.*

**Where** `src/zeros/store/read-caches.ts:19-23`, `:49`; `src/zeros/panels/github-section.tsx:93-97`.

**What the code does.** `GithubConnection` is `{ login, viaCli, ghAvailable }` in an in-memory
`KeyedAsyncCache(1)`. Verified verbatim at `github-section.tsx:94-96`: the authenticated branch
copies `viaCli: previous?.viaCli ?? false` and `ghAvailable: previous?.ghAvailable ?? false`;
`viaCli: true` is only ever set in the *unauthenticated* branch after `ghDetectCli()` succeeds.
Nothing in `src/engine/settings/`, `persist-ui-state.ts`, or the DB stores a GitHub auth method.
The only durable artefact is the bare token string.

**Verifier.** The method is genuinely never persisted, but the loss happens **only on process
restart** — not on cache eviction (the cache is only ever addressed with the literal key
`"auth"`, so LRU eviction at bound 1 cannot occur) and not on refresh (the authenticated branch
carries `previous?.viaCli` forward, and a bridge reconnect only marks the entry stale while
retaining data, per the `AGENTS.md:14` "never clear usable data" rule). Two things the filing
understates: `ghAvailable` is lost identically and the authenticated branch never calls
`ghDetectCli()`, so the CLI-detected hint is equally unrecoverable; and the engine's boot
adoption writes only to memory, so an engine-originated non-null token never reaches safeStorage
at all.

**Fix.** Persist `{method, login, connectedAt}` next to — not inside — the secret. It holds no
secret, so `settings.toml` is fine, and the radio's checked value then comes from a synchronous
local read on first render, as `AGENTS.md:18` requires for durable selections.

**Test first.** See S-H1.

### A-M3 · `offline-cold-start-shows-wrong-copy` — medium (bug)

*Also filed as `cold-error-fabricates-cli-missing` (settings-ui-and-state, medium).*

**Where** `src/zeros/panels/github-section.tsx:91`, `:115`, `:225-228`;
`src/engine/git/github.ts:215`, `:428-443`.

**What the code does.** `getAuthStatus` rethrows non-auth failures as `NETWORK_ERROR`. The
fetcher awaits `ghAuthStatus()` **before** the `ghDetectCli()` fallback, and any throw is caught
and rethrown, so `ghDetectCli` never runs. With no cached snapshot, `ghAvailable` is
`data?.ghAvailable ?? false` (`:115`), which selects the copy verified verbatim at `:227`:
*"GitHub CLI not found. Paste a personal access token, or connect with GitHub."*

**Fails when.** A returning user on a captive portal, or during any api.github.com outage, opens
Settings → Integrations and is told their `gh` CLI is missing when it is installed and
authenticated, and is steered toward pasting a PAT.

**Verifier — two refinements that broaden the defect.** (1) The precondition is a previously
**stored token**, not merely a cold start: a first-ever offline launch has no token, so
`getAuthStatus` returns unauthenticated with no network call and `ghDetectCli` *does* run. The
bug hits returning users — the common case, but not literally "first launch". The other filing's
verifier adds a second reachable trigger: a missing preload bridge, where `nativeInvoke` throws.
(2) **Running `ghDetectCli` first would not fix the copy** — `detectGhCli` verifies the CLI token
via `/user` and its bare catch returns `{available:true, authenticated:false}` offline, so the
card would read "GitHub CLI detected but not logged in", also wrong. The accurate framing is
broader: on any offline/API-outage cold start the panel **discards the known-good connection**
and renders the full not-connected card for an authenticated user, because the confirmed
connection verdict is never persisted across launches and the fetcher has no offline-tolerant
path.

**Fix.** Three parts. Make `ghAvailable` `boolean | null` and never derive negative capability
copy from `?? false`; gate the CLI-missing sentence on a confirmed snapshot
(`connection.data !== undefined`); and persist the last confirmed connection verdict so an
offline launch renders "couldn't check — showing last known" with a Retry, per
`docs/ui-interaction-performance.md:37-39` and `RULES.md:298-300` ("a cold cache is not an
authoritative empty snapshot").

**Test first.** In `github-connection.test.ts`: a resolver given a throwing `getAuthStatus` must
return `{ghAvailable: null}` and an `unknown` capability state, never `false`; and given a
persisted prior verdict it must return that verdict marked stale.

### A-M4 · `no-test-coverage-for-auth-transitions` — medium (test-coverage)

**Where** `src/engine/git/__tests__/github.test.ts:356-379`, `:571-578`, `:580-620`.

**What the code does.** The suite covers three `getAuthStatus` cases (no token, working token,
401 clears), a `createPr` `NOT_AUTHENTICATED` fallthrough, and two client-id-resolution cases.
There are no tests for `detectGhCli`, `setToken`, `signOut`, or the `startDeviceFlow` happy path;
no `github-section` test; no `read-caches` test touching `gh`/`auth`; nothing for
`github-token-sync.ts`, `engine-token-store.ts`, or `electron/ipc/commands/github.ts`.

**Verifier — two fixes, both worth carrying.** (a) The probe file the auditor cited as weak 403
evidence, `src/engine/git/__tests__/zzz-err-probe.test.ts`, is not "untracked" — **it does not
exist in the working tree at all** (`git status --porcelain -uall` is empty; the path survives
only inside Conductor checkpoint commit `d79c9b4`). There is therefore **zero** 403 evidence in
the repo. (b) Coverage is not literally "only `getAuthStatus`": the `TokenStore` get/set/clear
contract is indirectly exercised through the `setTokenStoreForTesting` seam in
`publish-github.test.ts:41,113,214` and `sync-workspace-pr.test.ts:139,154`, and
`github.test.ts:599` proves `startDeviceFlow` clears the placeholder gate. Neither calls the
exported `detectGhCli`, `setToken` or `signOut`. **The sharpest untested transition is
`withAuthRetry` itself** — it has no coverage on any status code, because the one 401 test covers
`getAuthStatus`'s separate inline handler.

**Fix / test first.** Before the rewrite, land assertion tests for: 403 must **not** clear; 401
must clear; `detectGhCli` adoption and its persistence side effect; sign-out then read stays
signed out; a fetcher result landing after `setData` does not win; and `withAuthRetry` on 401,
403 and 404 separately. Delete the reference to the scratch probe file — there is nothing to
promote.

---

## 3. `git-transport-credentials` — 4 findings (1 blocker, 1 high, 2 medium)

The area summary is the cleanest statement of the root defect in the whole audit: **Zeros has two
disjoint authentication systems for GitHub.** The persisted token
(safeStorage → `ZEROS_GITHUB_TOKEN` spawn env → `engineGithubTokenStore`) is used only to
construct Octokit clients; not one of the 13 network-touching git invocations passes a
credential, a helper, an askpass, or a rewritten remote URL.

| ID | Filed → re-rated | Anchor | One line |
|---|---|---|---|
| `token-never-reaches-git-transport` | blocker | `git-exec.ts:291` | → see **B1** |
| `push-error-misclassified` | high | `ops.ts:127` | The classifier matches none of git's real no-credential strings |
| `publish-push-unclassified-and-hardcoded-origin` | medium → low-medium | `github.ts:1076` | Publish's push has no error mapping at all |
| `agent-driven-push-is-a-fourth-uncontrolled-path` | medium → design constraint | `pr-instructions.ts:78` | The agent's own push/`gh` calls are a fourth network-git path |

### T-H1 · `push-error-misclassified` — high (ux)

*Also filed as `push-error-mapping-misses-no-credential-helper` (onboarding, medium).*

**Where** `src/engine/git/ops.ts:126-138`; `src/engine/git/git-exec.ts:318`;
`src/native/git.ts:1269`; `src/shell/pr/pr-status-island.tsx:485`, `:591-601`;
`src/engine/git/init-clone.ts:203-210`; `src/engine/index.ts:219-238`.

**What the code does.** Verified verbatim at `ops.ts:127-130`:

```ts
mapErrorCode: (stderr) => {
  if (/not authenticated|authentication failed|403|401/i.test(stderr)) {
    return "NOT_AUTHENTICATED";
  }
  …
  return "GIT_COMMAND_FAILED";
},
```

git's actual strings for the missing-credential cases are
`could not read Username for 'https://github.com': No such device or address` /
`Device not configured`, `could not read Password …: terminal prompts disabled` (only when
`GIT_TERMINAL_PROMPT=0` is set, which this repo never does), and for SSH
`Permission denied (publickey)`. None match. By contrast `init-clone.ts:203-210` **does** match
`could not read username|permission denied` — the two paths classify the same root cause
differently. The thrown `GitError` also carries no `remediation`, and `gitErrorDescription`
(`src/native/git.ts:1269`) falls back to `message`, which is the literal
`git push -u origin zeros/foo failed` built at `git-exec.ts:318`.

**Fails when.** The most common transport failure on a fresh Mac (PAT auth, no credential helper)
shows a toast titled "Couldn't push" whose description is the raw
`git push -u origin zeros/my-feature failed`, with no cause and no next step — and is classified
`GIT_COMMAND_FAILED`, which is **not** in `EXPECTED_ENGINE_ERROR_CODES` (`src/engine/index.ts:219-238`),
so `reportEngineError` also files it as a major-severity bug in error tracking.

**Verifier — two refinements.** (1) The toast is not fully context-free: the *title* is
"Couldn't push"; it is the *description* that is the raw git command line. The user learns push
failed and nothing else. (2) The regex is not blind to every auth failure — a **present but
invalid** credential (revoked PAT in the keychain) makes git print
`fatal: Authentication failed for 'https://github.com/…'`, which matches and correctly yields
`NOT_AUTHENTICATED`. The real gap is the **no-credential** HTTPS case and the SSH case — exactly
the fresh-Mac / PAT-only / cloud-sandbox shape. Everything else checks out, including that no
test in `ops.test.ts` covers push error classification at all. A separate refuted finding
established that the engine has **no controlling terminal by construction**, so the "hang on
`/dev/tty`" variant of this is not reachable in the packaged app (see §11.2).

**Fix.** Extend `push`'s `mapErrorCode` to cover
`could not read (Username|Password)`, `terminal prompts disabled`, `Device not configured`,
`No such device or address`, `Permission denied \(publickey\)`, `Host key verification failed`;
**unify the classifier across `ops.ts`, `init-clone.ts` and `publishRepoToGithub`** rather than
extending one of three copies. Distinguish transport-auth from API-auth in the error code, and
attach a remediation that names the actual fix ("connect a git credential in
Settings → Integrations", not "sign in"). Set `GIT_TERMINAL_PROMPT=0` so the failure is
deterministic and fast — the broker sets it anyway. Note the verifier's caveat: correct
classification **alone** changes nothing the user sees, because `GitError` attaches no per-code
remediation and the only renderer that branches on `NOT_AUTHENTICATED` does so for PR *reads*.
The regex, the remediation string and the island's routing must land together.

**Test first.** `src/engine/git/__tests__/push-error-classification.test.ts`: a table of the six
real stderr strings (captured verbatim, not paraphrased) asserting the mapped code **and** the
attached remediation for each; plus one case asserting `GIT_COMMAND_FAILED` is no longer produced
for any credential-shaped failure.

### T-M1 · `publish-push-unclassified-and-hardcoded-origin` — medium → low-medium (bug)

*Also filed as `publish-orphan-repo` (onboarding, high → medium-high) — see O-H3 for the
orphan-state consequence.*

**Where** `src/engine/git/github.ts:1076`, and the code comments at `:898` and `:1069`.

**What the code does.** Verified verbatim at `github.ts:1069-1076`:

```
// 3. Wire `origin` + push the current branch (set upstream). … The push uses
//    the user's git credentials (gh), like every other push in the app.
…
await runGit(repoRoot, ["push", "-u", "origin", branch]);
```

No `mapErrorCode`, no `timeoutMs`. This is **the only push in the app called with no
`mapErrorCode`**, so any failure — no helper, expired keychain entry, SSO, org push policy —
surfaces as the bare toast "Couldn't publish: git push -u origin main failed" with no
remediation, while the empty repo stays on GitHub with no rollback.

**Verifier — two sub-claims dropped, one added.** (a) **The literal `"origin"` is correct.** The
function creates that remote itself four lines above and the dialog promises it, so swapping in
`resolveRepoGit(repoRoot).remote` would push to a nonexistent remote whenever a repo sets
`git.remote` to something else (`settings/repo-git.ts:31-54`). Drop that half of the finding.
(b) The missing `timeoutMs` is the codebase convention for network git ops (neither `ops.ts`
`push` nor `fetch.ts` sets one), and a hang is unlikely since `runFile` ignores/pipes the child's
stdin. (c) Re-running does **not** produce an opaque collision — the dialog's availability check
marks the name "taken" and disables submit; the user is dead-ended instead, and the project row
is left without `originUrl` because `upsertProject` only runs on success. Net: real but bounded —
the local repo stays usable and the remote is recoverable by a manual push.

**Fix.** Give this push the unified classifier and remediation from T-H1 (ideally by calling
`ops.push`'s shared helper), and either pre-flight the transport credential **before** creating
the remote repo, or persist the partial state (stamp `originUrl`, offer "Retry push") instead of
throwing it away.

**Test first.** In `publish-github.test.ts`, add a case where the bare-repo push is made to fail
(point `clone_url` at a path that rejects the push) and assert: a credential-shaped
`GitError` code, a non-empty `remediation`, and that the project row records `originUrl` so the
retry affordance has something to work from.

### T-M2 · `agent-driven-push-is-a-fourth-uncontrolled-path` — medium → a design constraint, not a present failure (architecture)

**Where** `src/shell/pr/pr-instructions.ts:78`, `:80`; `src/shell/pr/pr-action-prompts.ts:36-40`.

**What the code does.** `buildPrInstructions` tells the agent literally
``- Push with `git push -u '<remote>' HEAD:'<branch>'` `` and ``- Use `gh pr create …` ``;
`buildActionPrompt`'s resolve / commit-and-push / update-from-base prompts also end in "push".
The agent executes these itself.

**Verifier — the mechanism in the filing is wrong; the constraint it implies is right and
important.** The filing claimed agents run in a PTY inheriting the full unscrubbed env and could
block on `/dev/tty`. All of that is false: agents get **no PTY** (`stdio-process.ts:63,68` —
piped stdio, detached/setsid), `buildPtyEnv` is the *terminal pane's* env and is not on the agent
path, and there is no controlling tty anywhere in the chain, so git cannot block on `/dev/tty`.
The agent path's credential resolution is **identical** to `runGit`'s — both inherit
`process.env` with no credential injection. This is also deliberate, documented design
(`pr-instructions.ts:4-9`), not an oversight, and the island's push/pull/merge actions still go
through the engine.

**The real, narrow consequence — and it is load-bearing for the whole design.** The agent's
`git`/`gh` invocations are ordinary child processes of the engine, so **any credential injected
only via `runGit`'s per-invocation `env` will not reach them.** A GitHub App credential must be
installed where *both* see it — a credential helper / gitconfig entry plus something for `gh` —
not as a `runGit`-local env var. This is exactly why Conductor PATH-shims `git` *and* `gh` rather
than only setting `GIT_ASKPASS` (teardown §4), and it is the design constraint that makes the
broker's PATH shim non-optional rather than a nicety.

**Fix.** Whatever credential mechanism is chosen must be installed into the agent's spawn env too
— helper path plus broker handle, **never the raw token** — with `GIT_TERMINAL_PROMPT=0` so an
agent's push fails readably.

**Test first.** `src/engine/agents/__tests__/agent-env-credentials.test.ts`: assert the agent
spawn env contains the broker socket/context vars and the shimmed `PATH`, and asserts it contains
**no** value matching a token shape (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`).

---

## 4. `github-api-layer` (`src/engine/git/github.ts`) — 7 findings (1 blocker, 4 high, 2 medium)

| ID | Filed → re-rated | Anchor | One line |
|---|---|---|---|
| `403-destroys-credential` | blocker | `github.ts:393` | → see **B2** |
| `withauthretry-does-not-retry` | high → medium | `github.ts:487` | The doc comment describes behaviour that has never existed |
| `no-rate-limit-handling` | high | `github.ts:132` | Zero rate-limit handling; competes with the user's own agents for one budget |
| `404-means-three-things` | high | `github.ts:465` | 404 read as "absent" when it usually means "your token can't see this" |
| `capability-not-verified` | high | `github.ts:206` | "Connected" only proves the token can call `/user` |
| `duplicate-pulls-get` | medium | `github.ts:1335` | Every island refresh issues two identical `pulls.get` |
| `comment-timeout-duplicate` | medium → understated | `workspace-bridge.ts:1190` | `gh.prComment` uses the 10 s read timeout on a non-idempotent write |

### G-H1 · `withauthretry-does-not-retry` — high → medium (bug, documentation)

**Where** `src/engine/git/github.ts:487-504`.

**What the code does.** Verified verbatim — the doc comment at `:487-490` reads *"Wrap any Octokit
call with a one-shot 401 retry: if the first call returns 401, we clear the cached token + Octokit
instance, then run the function again. The retry is opt-in (caller chooses) — most callers prefer
the explicit re-sign-in flow instead."* The body awaits `fn(oct)` exactly once and, on an auth
error, clears and rethrows. There is no second invocation. The comment has been present since the
initial commit (`de00261`).

**Fails when.** A designer reads the comment, assumes the 401 path already re-runs the request
after a refresh, and does not build the refresh loop. In reality the first call after an 8-hour
App user-token expiry hard-fails, wipes the credential (B2), and drops the user to the sign-in
gate mid-session.

**Verifier — re-scoped to medium, and the reason matters.** This is a documentation/naming defect
with **no current runtime failure**: the retry *as documented* is incoherent (the token is cleared
before the hypothetical re-run, and `getOctokit` throws `NOT_AUTHENTICATED` on an empty store, so
a literal re-run would fail worse), and **no auth mode shipping today issues an expiring token**
— gh CLI token, PAT and OAuth-App device flow are all non-expiring. The "8-hour App token"
scenario is future work, not a live bug. The genuinely load-bearing hazard on this seam is the
adjacent 403 classification (B2). Its upside is real and should be preserved: because there is no
retry, `createPr`/`mergePr`/`addPrComment` cannot double-fire from this path.

**Fix.** Two separate changes, in this order. **Now:** rename to `withAuthClassification` and
delete the false comment, so nobody designs against it. **With the App:** add an explicit
`refreshCredential()` hook and a one-shot retry *behind* it — never a blind retry, and never
without an idempotency guard for `pulls.create` / `pulls.merge` / `issues.createComment`.

**Test first.** `github.test.ts`: assert the callback is invoked exactly once on 401 today
(pinning the no-double-fire property), and — when the refresh hook lands — that a 401 triggers
exactly one refresh and exactly one retry, and that a second 401 after refresh does **not** retry
again.

### G-H2 · `no-rate-limit-handling` — high (bug)

*Also filed as `pr-poll-no-ratelimit-awareness` (onboarding, medium).*

**Where** `src/engine/git/github.ts:132`; `package.json:102-103`;
`src/shell/column3-tabs/review-data.ts:334-353`, `:505-535`; `src/shell/pr/pr-status-refresh.ts:4`;
`src/shell/column3-tabs/review-model.ts:213-214`; `src/shell/pr/pr-status-island.tsx:437-459`.

**What the code does.** Octokit is built bare (`new Octokit({auth})`) with neither
`@octokit/plugin-throttling` nor `@octokit/plugin-retry` installed. Nothing in `src/engine` or
`electron` reads `x-ratelimit-remaining`, `x-ratelimit-reset`, or `retry-after` — grep finds hits
only inside Codex agent code. Poll cadences: island slow lane 60 s, Review slow lane 60 s, checks
fast lane **12 s**, `useWorkspacePrSync` 60 s while PR-less.

**Fails when.** Budget exhaustion returns 403, and because of B2 that response **deletes the
token** rather than backing off. Even after B2 is fixed, the layer keeps hammering a rate-limited
endpoint every 12 seconds with no decay. Every agent CLI in every worktree spends the **same**
5000/hr user budget through its own `gh` commands.

**Verifier — the arithmetic is wrong, and the real anchor is somewhere else.** Corrections:
(a) The slow-lane fan-out is 7 REST + 1 GraphQL, not 8 REST, and the GraphQL call bills GitHub's
**separate** 5000-point/hr GraphQL budget. (b) The existing mitigation is stronger than the
finding credits: both lanes re-check `document.visibilityState` on **every tick**, so a
minimised/occluded window burns zero; the 900/hr fast lane additionally requires the Review row-1
tab specifically to be active, so with Changes foregrounded only the island's 240/hr runs. The
"~1600/hr" figure is a ceiling requiring an hour of continuously-pending CI with Review
foregrounded, not a steady state, and it is **unsourced** — the repo has no rate-limit
instrumentation, so nothing was measured. The second filing's verifier adds that the island and
Review lanes are not even fully additive: `src/native/git.ts:1085-1101` coalesces concurrent
`ghPrGet`/`ghPrChecks` by `{workspaceId, prNumber}`, giving ~7 REST/min rather than 11 — but that
coalescing is an **accidental timing property**, not a designed guard, and it breaks as soon as
the timers drift. (c) **The sharpest, non-speculative defect is not the aggregate budget — it is
the latched, un-backed-off fast lane.** `refreshChecksOnly` (`review-data.ts:334-351`) swallows
every error in an empty catch ("Fast-lane miss — the slow lane / event bus will repair") while its
arming condition `hasPendingChecks(snap.checks)` is derived from the last **successful** snapshot,
so a failing or rate-limited checks endpoint never clears `pending` and the same 3 REST calls are
reissued **every 12 s indefinitely with zero decay**. That loop is reachable regardless of budget
arithmetic. The finding should be anchored at `review-data.ts:349`, not `github.ts:132` alone.
(d) One nuance in the impact chain: *after* the 403 has destroyed the token the slow lane does
self-limit (`authed` flips false, `getOctokit` throws locally), so the hammering described is the
pre-clear and post-B2-fix case — which is how the finding words it.
(e) The GitHub App amplification claim ("the limit is per installation, shared by every Zeros
user in the org") is **unsupported**: for user-to-server tokens the budget is per user per app;
only server-to-server installation tokens share an installation-wide budget, and that budget
scales with installation size.

**Fix.** Four parts. (1) Add `@octokit/plugin-throttling` with `onRateLimit`/`onSecondaryRateLimit`
handlers. (2) Surface `remaining`/`reset` as engine state and let the poll lanes read it — a
visible "GitHub API budget low — slowing refresh" state, not a silent stall. (3) Give the fast
lane a decay: on error, back off and clear `pending` rather than latching on a stale successful
snapshot. (4) Note for the design: an App **installation** token has its own 5000/hr budget
independent of the user's, which is a concrete argument for the App path beyond consent scoping.

**Test first.** `src/shell/column3-tabs/__tests__/review-fast-lane.test.ts`: with a checks fetcher
that always rejects, advance fake timers 10 minutes and assert the call count is bounded by a
backoff schedule (not 50). Plus `github.test.ts`: a 403 carrying `x-ratelimit-remaining: 0` maps
to `GITHUB_RATE_LIMITED` and exposes `resetAt`.

### G-H3 · `404-means-three-things` — high (bug)

**Where** `src/engine/git/github.ts:465-468`, `:946`, `:825-827`, `:750-760`, `:453-455`;
`src/shell/dialogs/publish-to-github.tsx:176`.

**What the code does.** GitHub returns 404 (not 403) for a private resource a token lacks
visibility on. Three places take 404 at face value. (1) `wrapApiError` matches `/not found/` on
the message and attaches the remediation verified verbatim at `:468`:
`"Push the branch to the remote first, then open the PR."` (2) `checkRepoNameAvailable:946` —
`if (status === 404) return { available: true }`. (3) `syncWorkspacePr:825-827` catches everything
and returns null, which every caller reads as "this branch has no PR".

**Verifier — the call site is wrong and the corrected version is worse.** (a) A 404 from
`pulls.list` can **never** surface that remediation in `syncWorkspacePr` — the `catch {}` swallows
the wrapped `GitError` first. The user-facing path is `pulls.create` inside `createPr`
(`:750-760`) and the other `withAuthRetry` callers. **This makes the finding worse:** `createPr`
runs `pushImpl(… setUpstream: true)` at `:746` *before* calling `pulls.create`, so by the time the
404 arrives the branch is provably already pushed — "Push the branch to the remote first" is
**guaranteed-false advice at that exact point**. (b) The publish consequence is worse than "422s
on name already exists": `createInOrg`'s 422 body is
`{message:"Repository creation failed.", errors:[{message:"name already exists on this account"}]}`,
`githubApiMessage` joins both, so `lower` contains "already exists" and the **earlier** branch at
`:453-455` wins, attaching *"A pull request already exists for this branch — open it instead."*
`publish-to-github.tsx:176` renders that as the toast description — so **the publish dialog tells
the user to go open a pull request that has nothing to do with anything.** (c) One sub-point is
overstated: `withAuthRetry` does emit `GITHUB_TOKEN_CHANGED`, which the bridge mirrors to
`gh_token_clear`, so the sign-out itself is not invisible — Settings flips to disconnected on the
next auth-status read. Only the sync attempt is silent.

**Fails when.** A user whose PAT lacks `repo` (or whose fine-grained PAT omits the repo) opens a
private repo: the PR island silently never appears, Create PR fails with false advice on an
already-pushed branch, and the publish dialog reports a name as available that is actually taken
by a private org repo, then fails with unrelated PR advice.

**Fix.** Probe `repos.get` once per repo and cache the verdict; a 404 on a repo the token cannot
see must surface as a distinct `REPO_NOT_VISIBLE` with "this repository isn't visible to your
GitHub credential" plus a link to the per-repo installation/permission fix. Order the remediation
branches so the specific ones win, and make the pushed-branch remediation impossible to reach
from a path that has already pushed.

**Test first.** `github.test.ts`: (1) a 404 from `pulls.create` after a successful pre-push must
**not** produce "Push the branch to the remote first"; (2) a 422 "name already exists" from
`createInOrg` must produce a name-collision remediation, not the pull-request one; (3)
`checkRepoNameAvailable` on a 404 from an unauthenticated-for-that-org token must return
`unknown`, not `available: true`.

### G-H4 · `capability-not-verified` — high (gap)

**Where** `src/engine/git/github.ts:206`, `:248`, `:269`, `:344`; `:428-436`; `:449-478`.

**What the code does.** All three auth paths validate identically — `users.getAuthenticated()`.
Any token passes that call and yields a login: a classic PAT with **no scopes at all**, a
fine-grained PAT with zero repository permissions, an App token expiring tomorrow. Nothing reads
the `x-oauth-scopes` response header (no hits repo-wide) and no repo is probed.

**Fails when.** A user pastes a fine-grained PAT scoped to the wrong repo. Settings says
"Connected as @them". The Review tab shows a permanent auth gate, the island never appears — and,
depending on the exact status GitHub returns, the token may be deleted from the keychain with no
message ever naming the missing permission, because `wrapApiError`'s `isAuthError` branch
short-circuits before `githubApiMessage()`, discarding GitHub's own "Resource not accessible by
personal access token" text.

**Verifier — two corrections, one of which inverts the example.** (1) **The stated trigger is the
one variant that does *not* destroy the token**: a fine-grained PAT not granted the repository
returns **404** (GitHub conceals repo existence), and 404 is not in `isAuthError`, so the token
survives. Same for a zero-scope classic PAT on a private repo. The credential-destroying 403
requires a repo the token *can* see but lacks the specific permission on (e.g. Pull requests:
none), or org SAML / IP-allowlist enforcement. (2) The blast radius is understated: GitHub also
returns 403 for secondary rate limiting, so a burst of PR polling on a perfectly valid token can
wipe it. No test covers any of this — `github.test.ts` has a single `status: 401` fixture.

**Fix.** This is the finding the redesign is really about. Model auth as
`{method, credential, capability}`: after adopting any credential, read `x-oauth-scopes`
(classic), or probe `repos.get` on each known repo (fine-grained / App), and persist a per-repo
accessibility verdict with a `lastVerifiedAt`. That verdict is the data behind Conductor's
"✓ All repositories accessible." line (teardown §2 — `repositoryCount` + `repositoryNames[]`) and
behind a per-method health readout that can say "connected but can't see 2 of your 5 repos"
instead of a binary green dot.

**Test first.** `github.test.ts`: `getAuthStatus` on a token whose `/user` succeeds but whose
`repos.get` 404s must return a capability verdict of "no visible repositories", not a bare
`authenticated: true`; and the `x-oauth-scopes` header must be parsed and surfaced when present.

### G-M1 · `duplicate-pulls-get` — medium (perf)

**Where** `src/engine/git/github.ts:1335-1338`; `src/shell/pr/pr-status-island.tsx:380-384`;
`src/shell/column3-tabs/review-data.ts:269-273`.

**What the code does.** Verified verbatim at `github.ts:1334-1338`: `getPrChecks` re-fetches the
whole PR **solely to read `head.sha`**, and the island fires `ghPrGet` and `ghPrChecks`
concurrently in one `Promise.allSettled`. The Review slow lane does the same across `getPr` +
`getChecks`. There is no request-level memoisation — `getOctokit()` caches the client, never
responses.

**Verifier — real redundancy, wrong numbers.** Confirmed: 1 of the island's 4 REST calls (25%) and
1 of the Review snapshot's 8 (12.5%) are duplicated, and neither `behindByCache` nor the native
in-flight maps can reach inside `getPrChecks`. But the absolute figures are wrong: "~1600 calls/hr
measured" is unsourced (no instrumentation exists), both duplicating lanes poll at 60 s, capping
the waste at ~2 redundant calls/min (~120/hr) and **only while the island and the Review tab are
simultaneously active on the same PR**. The high-volume 12 s fast lane calls `getChecks` with no
sibling `getPr`, so *its* `pulls.get` is necessary — attributing ~200 wasted calls/hr by counting
the fast lane is the error.

**Fix.** Not "delete the `pulls.get`" — `getPrChecks` legitimately needs the head SHA standalone.
Accept an optional `headSha` from the caller, or add a short-TTL per-`(workspace, PR)` head-SHA
memo shared by the two lanes. The latter generalises to the duplicate probes when island and
Review are both mounted.

**Test first.** `github.test.ts`: with a recording Octokit factory, one island round plus one
Review round on the same PR must issue exactly one `pulls.get`.

### G-M2 · `comment-timeout-duplicate` — medium, understated (bug)

**Where** `src/zeros/bridge/workspace-bridge.ts:1186-1195`, and the contrast at `:105-113`,
`:1058-1069`, `:1151-1159`, `:1172-1183`; `src/shell/column3-tabs/review-data.ts:588-595`;
`src/shell/column3-tabs/review-timeline.tsx:378-395`; `src/engine/workspace/change-events.ts:85`,
`:107-122`.

**What the code does.** Verified: `bridgeGhPrComment` passes no timeout, so it takes `workspaceOp`'s
10 000 ms default, while the other network-bound writes — `prCreate`, `prMerge`, `prMarkReady` —
deliberately pass `NETWORK_GIT_TIMEOUT_MS = 60_000` with a comment at `:105-113` explaining that
exact hazard for merge. `issues.createComment` is a **non-idempotent write**. On timeout the
renderer rejects, `postComment` rolls the optimistic entry out of the timeline and rethrows, while
the engine's request continues and the comment lands.

**Verifier — if anything understated.** Three additions. (a) The 60 s comment's own safety net
does not apply here: `gh.prComment` is in `WORKSPACE_MUTATIONS` but **not** in
`LONG_LIFECYCLE_OPS` (which stops at `gh.prMerge`), so a timed-out `prComment` gets neither the
raised budget nor the originator-inclusive `DB_CHANGED` self-heal the comment relies on — the
renderer only learns the comment landed on the next review poll, up to ~60 s later. (b) The
duplicate is **one click away**, not a retype: `CommentComposer` restores the draft verbatim and
refocuses the textarea on failure. (c) No test covers it —
`src/zeros/bridge/__tests__/workspace-bridge.test.ts:420-437` asserts the 60 s budget only for
`gh.prCreate`/`prMarkReady`/`prMerge`.

**Fix.** Pass `NETWORK_GIT_TIMEOUT_MS` at `workspace-bridge.ts:1190` and add `gh.prComment` to
`LONG_LIFECYCLE_OPS`. For real safety, pass a client-generated idempotency key the engine can use
to de-dupe a retry — GitHub has no native idempotency key for issue comments, so match on
author + body + recent timestamp before re-posting.

**Test first.** Extend `workspace-bridge.test.ts:420-437`'s network-bound table with
`gh.prComment`; that assertion fails today. Add a case where the op times out and the engine's
write lands, asserting the retry path does not create a second comment.

---

## 5. `onboarding-and-repo-flows` — 11 findings (2 blockers, 5 high, 4 medium)

| ID | Filed → re-rated | Anchor | One line |
|---|---|---|---|
| `create-pr-bypasses-engine-auth` | blocker | `create-pr-button.tsx:98` | → see **B3** |
| `403-clears-durable-token` | blocker | `github.ts:390` | → see **B2** |
| `no-repo-picker` | high | `open-github-project.tsx:140` | There is no repo picker; nothing is half-built toward one |
| `clone-ignores-zeros-credential` | high → medium | `open-github-project.tsx:145` | `git clone` never uses the stored token; the copy promises it never will |
| `publish-orphan-repo` | high → medium-high | `github.ts:1076` | Publish failure leaves an orphan repo and an unrecoverable UI |
| `unauth-dead-ends-no-cta` | high → medium | `review-tab.tsx:301` | No "Connect GitHub" CTA outside Settings, and stale copy |
| `agent-gets-no-credential-token-leaks-in-pty` | high | `shell-setup.ts:166` | → see **TS-H1** |
| `pr-poll-no-ratelimit-awareness` | medium | `pr-status-refresh.ts:4` | → see **G-H2** |
| `engine-speak-in-user-copy` | medium | `github.ts:363` | "Call gh_auth_signin" is shown verbatim to users |
| `push-error-mapping-misses-no-credential-helper` | medium | `ops.ts:127` | → see **T-H1** |
| `no-github-telemetry` | medium → narrowed | `workspace-bridge.ts:93` | The `pr_*` analytics enum has no call sites |

### O-H1 · `no-repo-picker` — high (gap)

**Where** `src/shell/no-projects-view.tsx:75-80` → `src/shell/add-project-provider.tsx:512` →
`src/shell/dialogs/open-github-project.tsx:44`, `:140-190`; `src/engine/git/init-clone.ts:174`;
`src/engine/git/github.ts:920`, `:943`.

**What the code does.** The welcome tile reads "Open GitHub project / Clone a repository" and opens
a dialog that is a text `Input` for a URL — validated only by a shape regex at
`open-github-project.tsx:44` — plus a Browse-for-parent-folder picker. It calls `workspaceClone` →
`cloneRepo`, which shells `git clone <url>`. **`src/engine/git/github.ts` contains no
repository-listing call at all**: the only repo-shaped API uses are
`orgs.listForAuthenticatedUser` for the publish Owner dropdown and one `repos.get` for name
availability. `src/native/git.ts` exposes no repo-listing IPC. Nothing is half-built toward
browsing repos.

**Fails when.** Today: a URL the user cannot access is accepted and fails afterwards as an
opaque clone error. Under the App: a user who has just installed the Zeros GitHub App on 3 of
their 40 repos has no way to see those 3 in the app, must go to github.com and copy a URL, and
Zeros cannot tell them whether what they pasted is covered by the installation.

**Verifier.** Stands as written, with one framing note: the "3 of 40 repos covered by an
installation" scenario describes a **future** state, since no GitHub App or installation model
exists in the tree yet. Today's concrete impact is the accept-then-fail URL box.

**Fix.** Three pieces. (1) An engine `gh.listRepos` backed by
`apps.listReposAccessibleToInstallation` for the App method and `repos.listForAuthenticatedUser`
for gh-CLI/PAT. (2) Owner/org grouping reusing the existing `GithubOwner` shape and
`ghOwnersCache` pattern. (3) A clone that authenticates (O-M1). Note the pagination hazard in §12
— every existing list call is capped at one page with no truncation signal, and a repo picker is
exactly where that bites. Make `listRepos` host-neutral from the start via the `ReviewProvider`
seam precedent, and return the installation coverage verdict alongside each row so the picker can
grey out what the credential cannot reach.

**Test first.** `src/engine/git/__tests__/list-repos.test.ts`: with a paginating fake Octokit,
`gh.listRepos` must return every page (up to a hard cap) and set `truncated: true` when capped;
and for the App method it must call `apps.listReposAccessibleToInstallation`, not
`repos.listForAuthenticatedUser`.

### O-M1 · `clone-ignores-zeros-credential` — high → medium (gap)

**Where** `src/shell/dialogs/open-github-project.tsx:145-146`, `:105-112`;
`src/engine/git/init-clone.ts:197-213`, `:203-210`; `src/engine/git/git-exec.ts:316-321`;
`src/native/git.ts:1269`.

**What the code does.** The dialog's own description reads — verified verbatim at
`open-github-project.tsx:145-146` — *"Clone a remote repository — `git clone` runs locally, the
engine never proxies your credentials."* `cloneRepo` runs `git clone` with no credential
injection. Its `mapErrorCode` **does** classify auth failures to `NOT_AUTHENTICATED`
(`init-clone.ts:203-210`), but `runGit` builds the `GitError` with only `code`/`message`/`context`
and no `remediation`, so the toast shows "Couldn't clone repository: git clone
https://github.com/acme/private failed" with an empty description.

**Verifier — three corrections; the severity drops and one argument is withdrawn.**
(1) Line cites: the `NOT_AUTHENTICATED` branch is `init-clone.ts:203-210`, not `:190-195`;
`:197` is the `WORKSPACE_ALREADY_EXISTS` remediation, which **proves the file sets remediation
where it wants one**. git's stderr *is* captured at `git-exec.ts:320` in `context.stderr` — the
dialog simply ignores it. And the repo already ships the right helper: `gitErrorDescription`
(`src/native/git.ts:1269`) falls back `remediation ?? message`; this dialog is one of the callers
that does not use it. (2) **Impact is overstated as an independent high**: this `git clone` runs in
Electron main on the user's own machine and therefore inherits the user's git credential helper —
the same mechanism `git push` already depends on. A gh/osxkeychain user clones private repos
successfully today. The break is confined to PAT/device-flow users with no OS-level git
credential, i.e. the same population as B1. It is a **symptom of that one root cause plus an
error-affordance bug**, not a separate high. (3) **The "the copy contradicts the cloud-workspace
design" argument does not hold** and should be dropped:
`docs/cloud-workspace/08-engineering-reference.md:169,533` put the
`https://x-access-token:TOKEN@github.com/…` URL inside the *sandbox's* clone, a different process
on a different machine. The copy is factually accurate about the local path it describes; it is
misleading only in implying credentials are handled for you.

**Fix.** Route clone through the selected auth method (the broker's helper, not a token-in-URL),
attach a `NOT_AUTHENTICATED`-specific `remediation` plus a "Connect GitHub" action at the clone
call site, and use `gitErrorDescription` in the dialog toast. Reword the copy to name the
credential source rather than promising nothing is proxied.

**Test first.** `src/engine/git/__tests__/clone-credentials.test.ts`: a clone of a
credential-required loopback repo with an empty ambient config must succeed using only the stored
token (fails today), and a clone with no credential must produce `NOT_AUTHENTICATED` **with a
non-empty remediation**.

### O-H2 · `publish-orphan-repo` — high → medium-high (bug)

*Sibling filing of T-M1; this one carries the UI consequence.*

**Where** `src/engine/git/github.ts:1043`, `:1050-1058`, `:1071-1076`;
`src/shell/dialogs/publish-to-github.tsx:149-155`, `:161-168`;
`src/shell/column3-tabs/changes-row1-tab.tsx:136`; `src/shell/column3-tabs/changes-tab.tsx:481-487`;
`src/engine/git/errors.ts:46,56,64`.

**What the code does.** `publishRepoToGithub` git-inits, creates the repo through Octokit, wires
`origin`, then pushes with no `mapErrorCode`. The dialog only calls
`upsertProject({repoRoot, originUrl})` on success, so a push failure throws **after** the remote
repo already exists.

**Verifier — the retry narrative is wrong and the real behaviour is worse.** (1) After the failed
push the folder is now a git repo, so the `nonGit`-gated *NotAGitRepo* empty state that hosts the
**only** "Publish to GitHub" entry point stops rendering and **the affordance vanishes**. Even if
the dialog were reopened, the debounced availability check marks the name "taken" and disables the
button. The user never sees "repository already exists" — they get a dead end. (2) The trigger is
narrower than "PAT-only or device-flow-only user": it is any machine with no usable HTTPS
credential for github.com (no gh helper, no osxkeychain entry, or a stale one). A user who has
previously pushed to GitHub over HTTPS succeeds. Severity medium-high: no data loss, the empty
repo is manually deletable, but the UI state is unrecoverable and `GitError` has no default
remediation.

**Fix.** Pre-flight the transport credential **before** creating the remote repo — that is the
cheap fix and it eliminates the orphan entirely. Failing that, persist the partial state (stamp
`originUrl` so the project row knows the remote exists) and surface a "Retry push" affordance that
does not depend on the `nonGit` empty state.

**Test first.** In `publish-github.test.ts`: with a push that fails, assert (a) the project row
records `originUrl`, (b) a retry affordance predicate returns true, and (c) the error carries a
remediation. All three fail today.

### O-M2 · `unauth-dead-ends-no-cta` — high → medium (ux)

**Where** `src/shell/column3-tabs/review-tab.tsx:301-308`, `:304-305`;
`src/shell/column3-tabs/review-bits.tsx:180`, `:193`;
`src/shell/dialogs/publish-to-github.tsx:213-216`, `:288-311`;
`src/zeros/agent/pr-picker.tsx:102-105`; `src/shell/dispatcher/create-from-source.tsx:114-118`;
`src/shell/pr/use-workspace-pr-sync.ts:127-129`; `src/shell/home-sidebar.tsx:300`;
`src/zeros/panels/settings-page.tsx:258-263`.

**What the code does.** The Review tab's unauthenticated branch renders a text-only
`ReviewEmptyState` — and `ReviewEmptyState` **accepts an optional `action` node that is not
passed**. The publish dialog renders the plain sentence "{error}. Sign in to GitHub in Settings
first." The composer `#` PR mention says "Couldn't load pull requests." with no cause.
Create-workspace-from-PR degrades to branches-only silently by design. Navigation is trivially
available — `dispatch({type: "SET_ACTIVE_PAGE", page: "settings"})` — it is simply never wired.

**Verifier — the headline scenario is unreachable and the surface count is inflated.**
(1) **A brand-new, never-connected user cannot see the Review-tab sign-in gate**: `ReviewView`
only mounts when the workspace already has a PR (`review-row1-tab.tsx:51-56` short-circuits to
"No pull request" whenever `prNumber == null`), and `prNumber` is only ever stamped by an
*authenticated* `syncWorkspacePr`. So the gate is reachable essentially only for a user who **was**
authenticated and whose token was revoked/expired — the case `review-data.ts:278-285` documents as
"A revoked token mid-session". That state also self-heals: the lane re-probes auth on every
refresh while unauthed. (2) Frequency is further reduced by zero-config gh adoption at engine
boot. (3) The publish dialog is not "no button" — its footer always renders Cancel plus a disabled
"Create repo and publish"; only the owner/name/private fields are hidden. And
`use-workspace-pr-sync.ts` is a background probe with no UI, so counting it as a "surface" makes
the "five surfaces / three show an empty list" framing wrong. **The defensible version:** the
Review tab's gate carries **stale copy** — it says "Settings → General → GitHub" when the section
is now Settings → Integrations (`settings-page.tsx:258-263`) — and it, the publish dialog and the
PR picker offer no one-click route to the GitHub section even though `ReviewEmptyState` already
takes an `action` and section deep-linking already works. Medium, not high.

**Fix.** One shared `<ConnectGitHubCta>` that navigates to Integrations and pre-selects the GitHub
card, passed as `ReviewEmptyState`'s `action` and used by the publish dialog and PR picker. Fix
the stale path string. With three explicit methods the CTA should deep-link to the method picker,
and — per the re-auth framing — name the method that failed.

**Test first.** A pure `resolveUnauthenticatedCta({surface, method})` unit test asserting a
non-null action and the current section path for each surface; plus a `check:ui`-style assertion
(or a grep test) that the literal string "Settings → General" no longer appears in `src/shell/`.

### O-M3 · `engine-speak-in-user-copy` — medium (ux)

**Where** `src/engine/git/github.ts:363`, `:434`; `src/native/git.ts:1269-1272`;
`src/shell/pr/pr-status-island.tsx:484-486`; `src/zeros/panels/github-section.tsx:53-57`;
`src/engine/git/detach.ts:182`.

**What the code does.** Verified verbatim at `github.ts:360-364`:

```ts
throw new GitError({
  code: "NOT_AUTHENTICATED",
  message: "Not signed in to GitHub",
  remediation: "Call gh_auth_signin to start the device-flow.",
});
```

and `wrapApiError` uses `"Call gh_auth_signin to refresh the token."` `gitErrorDescription`
returns `err.remediation ?? err.message` — i.e. **the remediation replaces the message** — and is
the island's toast description; `humanError` in the settings panel concatenates both into the red
banner.

**Fails when.** A failed Merge or Mark-ready toasts *"Couldn't merge PR — Call gh_auth_signin to
start the device-flow."* The user has no `gh_auth_signin`. It also hardcodes **one** of the three
methods into copy that will be wrong for the other two once the picker ships.

**Verifier — scope is much wider than "a failed Merge".** 26 call sites in `github.ts` go through
`getOctokit()`/`withAuthRetry`, and the same verbatim remediation is rendered as a toast
description by `publish-to-github.tsx:176`, `open-github-project.tsx:112`, `quick-start.tsx:137`,
`add-local-project.tsx:144`, `column2-topbar.tsx:208`, `target-branch-select.tsx:150`,
`dispatcher-modal.tsx:182` and `:352`, and `review-data.ts:57` — so **first-run publish and
repo-picker onboarding show it too**. One related unflagged instance of the same class:
`src/engine/git/detach.ts:182` ("Call detach_stop first.").

**Fix.** Replace IPC-op names with user-facing remediation and make the string **method-aware**:
"Reconnect GitHub in Settings → Integrations" / "This repository isn't included in your Zeros
GitHub App installation — add it". Since `gitErrorDescription` *replaces* the message, the
remediation must be a complete sentence that stands alone.

**Test first.** A grep-style unit test over `src/engine/**` asserting no `remediation` string
matches `/\b(gh_|detach_)[a-z_]+\b/` — a gate that stays useful forever, and fails today on at
least three strings.

### O-M4 · `no-github-telemetry` — medium → narrowed and sharpened (test-coverage)

**Where** `src/zeros/analytics/agent-events.ts:155-158`; `src/zeros/bridge/workspace-bridge.ts:89-103`,
`:137-140`; `src/engine/index.ts:216-222`, `:3316`; `src/shell/pr/pr-status-island.tsx:500`, `:511`;
`docs/posthog-analytics-integration.md:390`.

**What the code does.** `trackGitOp`'s op union includes `pr_create | pr_update | pr_merge | pr_mark_ready`.
`GIT_OP_ANALYTICS` maps only `git.commit/push/pull/stage/unstage/discard`, and its comment claims
"gh.* PR ops are intentionally excluded (review-tab tracks `pr_create` directly)" — grep for
`trackGitOp`/`capture(` across `src/shell/**` returns nothing.

**Verifier — "zero telemetry" is false; the accurate finding is narrower and sharper.** Two
channels already cover part of it: (a) the island's direct push/pull flow through `workspaceOp` and
**do** emit `git_op` with a classified `error_kind` — so push-to-GitHub, the credential-helper
hazard, *is* instrumented; (b) every failed `gh.*` workspace op is relayed to PostHog error
tracking as `ENGINE_ERROR` with origin `workspace:gh.prCreate|prMerge|…`, code and severity, plus
a scrubbed `main.log` breadcrumb. The accurate finding is three-part:
(1) **no product-funnel event exists for any GitHub-specific op** — the four enum members are
genuinely dead, and both the justifying comment at `workspace-bridge.ts:89-91` and
`docs/posthog-analytics-integration.md:390` ("Wired in the Changes + Review tabs") are factually
false, so the exclusion is unjustified rather than intentional;
(2) **there is no auth-state telemetry at all** — `github-section.tsx` emits nothing on
connect/sign-out and `gh.authStatus` is an untracked read, so "how many users are connected, by
which method" is unmeasurable;
(3) most importantly, **auth failures on GitHub PR ops fall through both channels**:
`NOT_AUTHENTICATED` sits in `EXPECTED_ENGINE_ERROR_CODES` (`src/engine/index.ts:222`), excluded
from error tracking on the explicit grounds that such codes "still surface in the renderer's
`git_op` funnel" — true for `git.*` ops, **false for `gh.*` ops**, which `GIT_OP_ANALYTICS` drops.

**Fails when.** A three-method picker plus a GitHub App ships with no way to measure whether it
worked, and the one error class the whole project is about — auth failure blocking a PR — is
invisible in both funnels.

**Fix.** Cheap, not architectural. `gh.prMerge`/`prMarkReady`/`prCreate`/`publishRepo` are direct
UI calls through the same `workspaceOp` chokepoint, so adding `GIT_OP_ANALYTICS` map entries
closes (1) and (3). Add `github_connect_started/succeeded/failed` with `method = gh-cli|zeros-app|pat`
and `error_kind` from the existing safe `GitError`-code classifier for (2). Fix or delete the false
comment and the false docs line. Create PR remains the one path with no engine event, since it is
an agent prompt — instrument it via the `syncWorkspacePr` backfill.

**Test first.** Extend `workspace-bridge.test.ts` with a table asserting each `gh.*` mutation
emits `git_op` with the expected op name and, on failure, a classified `error_kind`. Fails today.

---

## 6. `provider-abstraction` — 4 findings (4 high, 0 medium)

An honest caveat on all four: **none is a live user-visible failure**, because
`resolveReviewProvider` hardcodes GitHub and no GitLab/Bitbucket implementation exists. This is
design debt that surfaces the moment a second host lands — but one of the four (`repo-slug-drops-host`)
is a real bug **today**, for a reason the auditor got wrong.

| ID | Filed → re-rated | Anchor | One line |
|---|---|---|---|
| `gh-methods-outside-seam` | high (design debt) | `src/native/git.ts:975` | 11 of 19 `gh*` methods sit outside `ReviewProvider`; 5 of the 8 inside are bypassed |
| `agent-prompts-hardcode-gh-cli` | high | `templates.ts:44` | Provider lock-in in prose, invisible to typecheck |
| `repo-slug-drops-host` | high | `repo.ts:28` | Repo identity is `(owner, name)`, not `(host, owner, name)` |
| `non-github-origin-ui-lies` | high → medium | `pr-status-row.tsx:67` | A non-GitHub origin is accepted and the UI then lies |

### P-H1 · `gh-methods-outside-seam` — high (architecture, design debt)

**Where** `src/native/git.ts:975,983,995,1006,1014,1018,1022,1034,1039,1051,1072,1090,1109,1124,1133,1203,1218,1225,1232`;
`src/shell/pr/review-provider.ts:61-72`, `:77-80`; and the bypass sites
`src/shell/pr/pr-status-island.tsx:384-385`, `:536`, `:555`; `src/shell/dashboard-page.tsx:554`;
`src/zeros/panels/github-section.tsx:91`.

**What the code does.** `src/native/git.ts` exports **19** `gh*` methods. `ReviewProvider` wraps
**8** — verified verbatim at `review-provider.ts:61-72`: `authStatus`, `getPr`, `getChecks`,
`getCommits`, `getTimeline`, `addComment`, `merge`, `markReady`. Not behind it: PR creation, PR
discovery/backfill (`ghPrSync`, used raw at three sites), PR listing, the whole publish flow
(`ghListOwners`/`ghCheckRepoName`/`ghPublishRepo`), the icon avatar, and **all five auth calls**.

**Verifier — two corrections.** (1) It is **5** of the 8 bypassed, not 6: `authStatus`, `getPr`,
`getChecks`, `markReady`, `merge`. The remaining three — `getCommits`, `getTimeline`, `addComment`
— are called *only* through the provider. So the seam is honoured exclusively for the three ops
that live in the Review tab body, and bypassed for every op that also has a non-Review call site.
(2) **`ghPrCreate` is not merely "outside the seam" — it has zero callers in `src/` or `electron/`
(a dead export).** PR creation happens as an agent prompt, so the provider abstraction cannot
capture it even in principle today; the gap is the prompt path, not an unwrapped IPC method. Minor
nuance, not an error: `ghRepositoryOwnerAvatar` at `store/repository-icons.ts:163` is already an
injectable parameter, so it has a test seam — just not a provider-selected one.

**Fix.** Route `pr-status-island.tsx` and `dashboard-page.tsx` through the same provider object,
and add a second seam (`ForgeProvider`) covering create/sync/list/publish/owners/avatar/auth so
`native/git.ts`'s `gh*` functions become the GitHub *implementation* rather than the app's API.

**Test first.** A lint rule (or a `check:*` script, matching the repo's existing gate idiom)
banning `gh*` imports outside the provider modules — that is the only regression test that
actually holds this line, because a typecheck cannot. Land it with an allowlist of today's
violations set to shrink, so the count can only go down.

### P-H2 · `agent-prompts-hardcode-gh-cli` — high (architecture)

**Where** `packages/core/src/system-instructions/templates.ts:44` (and its stale deferral note at
`:61-67`); `src/shell/pr/pr-instructions.ts:59-61`, `:80`; `src/shell/pr/pr-action-prompts.ts:90`;
`src/shell/pr/pr-status-row.tsx:68`.

**What the code does.** Verified verbatim, `templates.ts:44`: *"Use it for actions like diffing
(`git diff {TARGET_BRANCH}...`) and creating PRs (`gh pr create --base <branch>`)."* — injected into
the **first turn of every chat in every repo**; `buildFirstTurnInstructionBody` has no host
parameter and the gateway applies no host branch. The Create-PR brief builds
`gh pr create --draft --base <base>`. The `templates.ts:5-10` header asserts it is the ONE home for
hardcoded agent text; `pr-instructions.ts` and `pr-action-prompts.ts` violate that today.

**Fails when.** Non-GitHub repos **are** openable (the local-folder `openProject` path;
`src/engine/git/repo.ts:25` documents a gitlab.com slug; `repositories-panel.tsx:1001` renders a
"globe for another host" glyph), and `CreatePrButton` is rendered with no origin-host gate — only
`nativeReady` and `hasChanges`. So a GitLab user gets an agent literally told to run `gh pr create`,
which either fails or — if `gh` is installed and authed to an unrelated GitHub account — does
something wrong.

**Verifier — two of three cited sites are reachable; the third is latent.**
`buildFixCheckPrompt`'s "`gh pr checks ${prNumber}` / `gh run view --log-failed`"
(`pr-action-prompts.ts:90`) can only fire from the Review tab's failing-check rows, which require
a `workspace.prNumber` set by the GitHub sync path plus a checks list from `ghPrChecks` — a
GitLab/Bitbucket repo never gets there. That one is latent lock-in, not a live failure. Also: the
strings are pinned by `pr-instructions.test.ts:23,57` and `pr-action-prompts.test.ts:86`, so any
fix must update them, and the `templates.ts:61-67` deferral note is **stale** — it says the
Create-PR button's scaffolding "goes HERE" once that button is built; the button shipped and its
prose lives in `src/shell/pr/pr-instructions.ts`.

**Fix.** Move the PR-creation and check-investigation prose into `templates.ts` as
`[SYS-INSTR: action-create-pr]` / `[SYS-INSTR: action-fix-check]` with `{FORGE_CLI}` /
`{FORGE_CREATE_CMD}` placeholders supplied by the provider (`gh pr create --base` /
`glab mr create --target-branch` / a manual-URL fallback), plus a per-provider `reviewNoun`
("pull request" / "merge request") used by the same substitution.

**Test first.** `packages/core/src/__tests__/first-turn-instructions.test.ts`: assert the rendered
preamble for a `gitlab` forge contains no `gh ` token, and that the GitHub case is byte-identical
to today's pinned string. Update `pr-instructions.test.ts` in the same commit.

### P-H3 · `repo-slug-drops-host` — high (bug) — the one live defect in this area

**Where** `src/engine/git/repo.ts:22-30`; `src/engine/db/migrations.ts:370-372`;
`src/engine/git/state.ts:277`, `:304-306`; `src/zeros/store/use-projects.ts:215-218`, `:289-291`;
`src/engine/git/worktree.ts:501`, `:541-553`, `:790`, `:971-978`, `:1008-1015`;
`src/engine/git/cross-tool.ts:310-320`, `:545`, `:600`, `:829-841`, `:920`.

**What the code does.** Verified verbatim at `repo.ts:26-28`: *"We intentionally drop the host so
worktrees for the same logical project don't fragment if the user re-clones via SSH after HTTPS."*
`repo_slug` is then the workspace partition key **everywhere** — two SQLite indexes, the
`WHERE repo_slug = ? AND branch = ?` lookup, `listWorkspacesFromDb({repoSlug})`, the renderer's
whole workspace cache, and the managed worktree directory, which `worktree.ts:501` calls "the
globally unique repoSlug".

**Verifier — reframed, one sub-claim corrected, and the real trigger identified.**
(a) **It is not specifically a cross-forge bug.** The slug drops the host *and* the local clone
path, so any two repos whose `owner/name` matches collide — `github.com/acme/widgets` vs
self-hosted `github.acme.com/acme/widgets` is as affected as the GitLab case, and two separate
clones of the *same* remote also share one slug (that last case is the documented intent; the
cross-host case is the unintended fallout). The honest framing: **repo identity is `(owner, name)`
when it should be `(host, owner, name)`** — which makes this a repo-identity bug, not a
provider-abstraction one.
(b) The claim that the path-collision guard keeps directories distinct is **wrong**: when two
registered roots share a basename, `managedRepositoryDirectory` returns the **same** managed
directory for both (`worktree.ts:541-553`). Directories stay distinct only because the leaf segment
is the branch display name; where that also matches, `createWorkspace` hard-fails via the
`existsSync`/`getWorkspaceByPath` guards ("target folder … is already occupied"). So the on-disk
layer converts the collision into a **user-visible error**, it does not keep the repos apart.
(c) The realistic trigger is **not** Zeros-generated branches (`zeros/<adj>-<4hex>` — a cross-repo
hit is rare and costs a retry). It is the **adopt / create-from-branch flows where branch names are
user-chosen** (`main`, `develop`, `feature/x`): `adoptExistingWorktree` throws
`WORKSPACE_ALREADY_EXISTS` citing the *other* repo's workspace id and status
(`cross-tool.ts:829-841`), and the branch-catalog PR-URL join at `cross-tool.ts:310-320`
**stamps repo A's `prUrl` onto repo B's identically-named branch**. The merged-sidebar and
wrong-`prUrl` effects are certain once two same-path repos are added; the precondition is
uncommon, so "high" rests on an uncommon setup.

**Fix.** Either include a short host discriminator in the slug for non-default hosts (keeping
today's slug for `github.com` so existing rows need no migration), or stop using `repoSlug` as an
identity key and partition by `repo_root` / a repo id. **This decision must be made before GitLab
lands, because the slug is baked into on-disk worktree paths.**

**Test first.** `src/engine/git/__tests__/repo-slug-identity.test.ts`: register
`github.com/acme/widgets` and `gitlab.com/acme/widgets`, then assert (1) distinct slugs,
(2) `listWorkspacesFromDb` for one does not return the other's rows, and (3) the branch-catalog
join does not stamp repo A's `prUrl` onto repo B's `main`. All three fail today.

### P-M1 · `non-github-origin-ui-lies` — high → medium (ux)

**Where** `src/shell/pr/pr-status-row.tsx:67-74`; `src/shell/dialogs/open-github-project.tsx:78`;
`src/engine/git/init-clone.ts:155`, `:181`; `src/shell/pr/create-pr-button.tsx:116-131`, `:171-175`;
`src/shell/pr/github-url.ts:65-67`; `src/engine/git/github.ts:540-550`, `:699-704`, `:812-814`;
`src/engine/git/branch-catalog.ts:34-35`, `:102-109`; `src/zeros/panels/repositories-panel.tsx:1122-1126`.

**What the code does.** Nothing gates a repo on host. A gitlab.com URL clones fine and becomes a
project. Then: `PrStatusRow` renders `CreatePrButton` for **any** workspace; clicking it sends the
`gh pr create` brief; "Create PR manually" builds
`https://<host>/<owner>/<repo>/compare/<base>...<head>?expand=1` for whatever host was parsed — a
valid-looking but wrong URL on gitlab.com, which needs `/-/compare/`. Meanwhile the engine silently
no-ops: `workspaceRemote` throws `VALIDATION_FAILED` for a non-github.com host and
`syncWorkspacePr` swallows it and returns null, so the island never appears.

**Verifier — sub-point (d) is false and one line is overstated.** The finding claimed the Review
tab's copy points at a section that does not exist *because* `provider.hostLabel` would be wrong
for GitLab. In fact `resolveReviewProvider` is hardcoded to `githubProvider`, so `hostLabel` is
always the literal "GitHub"; the message points at the wrong *provider* for a GitLab repo, and the
section it names **does** exist (it is stale-path wording — see O-M2 — not a nonexistent section).
It also only renders when `snap.authed === false`, so a GitHub-authed user with a GitLab repo never
sees it. The "only honest host-awareness in the whole app" line is also wrong: `parsePrUrl` is
github.com-anchored with an explicit GitLab-rejection test, `parseGitHubRemote` validates the host
with its own test, and `branch-catalog.ts:102-109` computes `RepoRemote.isGitHub`. **The real
defect is that all of this host-awareness is silent** — thrown-and-swallowed in the engine, or a
decorative glyph — rather than surfacing a user-visible "this host isn't supported yet". Finally,
the claim that the compare URL "404s" on gitlab.com is **unverified** (GitLab has historically kept
legacy non-`/-/` routes redirecting); what is certain is that the URL is built for a host the app
cannot service. Medium, not high: no data loss, no corruption, and the primary Create-PR path
degrades into an agent reporting a failed `gh` invocation.

**Fix.** Short term, before any provider work: surface `RepoRemote.isGitHub` — which the catalog
already computes — up to `PrStatusRow`, disable Create PR with the reason "Zeros can only open pull
requests on GitHub remotes today", and say the same in the Review empty state. Long term, replace
the boolean with `forgeHost: 'github' | 'gitlab' | 'bitbucket' | 'unknown'` on `RepoRemote` — the
parse already knows the host. Conductor's field name for this seam is `gitForge` with a `hostname`
alongside it (teardown §5); matching that shape makes GHE, self-managed GitLab and Bitbucket Data
Center the same shape as their cloud counterparts.

**Test first.** `src/shell/pr/__tests__/pr-status-row-host-gate.test.ts` (pure predicate): for a
`gitlab.com` remote the Create-PR affordance must be disabled with a stated reason; for
`github.com` it must be enabled. Plus a `github-url.test.ts` case asserting the manual-compare URL
is **not** produced for a non-GitHub host.

---

## 7. `settings-ui-and-state` — 5 findings (3 high, 2 medium)

| ID | Filed → re-rated | Anchor | One line |
|---|---|---|---|
| `no-persisted-auth-method` | high | `github-section.tsx:93` | The method is re-derived per session and lost on restart |
| `signout-silently-readopts-gh-cli` | high | `github-section.tsx:164` | → see **A-H4** |
| `migration-inference-needed` | high | `electron/main.ts:1120` | Existing users have a credential and no method |
| `stale-connected-after-401` | medium → low | `github-token-sync.ts:32` | → see **A-H2** |
| `cold-error-fabricates-cli-missing` | medium | `github-section.tsx:225` | → see **A-M3** |

### S-H1 · `no-persisted-auth-method` — high (gap)

**Where** `src/zeros/panels/github-section.tsx:93-97`; `src/zeros/store/read-caches.ts:19-23`, `:49`;
`src/engine/git/github.ts:194-197`; `src/engine/settings/schema.ts:311-331`, `:359-364`, `:522-528`;
`src/native/settings.ts:13-39`; `src/zeros/store/provider-prefs.ts:73-99`;
`src/engine/settings/watch.ts:5-7`; `RULES.md:294-297`.

**What the code does.** The only record of "how am I authed" is `viaCli` on an in-memory
`KeyedAsyncCache(1)` snapshot, reconstructed from the *previous snapshot*. Nothing in
`~/.zeros/settings.toml` (the schema has no `github` table), nothing in localStorage, nothing on
the wire — `AuthStatusResult` is `{authenticated, login}`.

**Verifier — one mechanism correction that strengthens it materially.** It is not merely that
`viaCli` "defaults to false on cold launch and then gets repaired". Because `detectGhCli()`
persists the gh token into safeStorage and the engine re-adopts gh at startup, `ghAuthStatus()`
reports authenticated on every subsequent launch — so the fetcher takes the *authenticated* branch
and `ghDetectCli()` is **never called again**. `viaCli` therefore stays `false` **permanently**
after restart, until an explicit Sign out triggers the re-probe. A gh-CLI user is mislabelled
"Connected to GitHub" for the entire session and **no amount of Refresh fixes it**. `ghAvailable`
is lost the same way, but benignly (it is only read in the disconnected branch, where
`ghDetectCli()` supplies it fresh).

**Fails when.** Beyond the mislabelling: once this is a three-way radio group, the first paint after
every restart has **no** checked radio, or checks the wrong one, and any repair effect violates
`RULES.md:294-297` ("restore it in the destination's first render").

**Fix (concrete, with the repo's own idiom).** Add `[github] auth_method = "zeros-app" | "gh-cli" | "pat"`
to `userSettingsSchema` (`schema.ts:311-331`), list `github` in `USER_ONLY_KEYS` (`:359-364`) and in
`TABLE_SHAPES` (`:522-528`), and mirror it through the exact provider-prefs shape already in the
tree: synchronous `getSetting`/`setSetting` read cache (`native/settings.ts:13-39`) plus
fire-and-forget `bridgeSettingsWrite(bridge, "user", …)` write-through
(`provider-prefs.ts:73-99`). The radio's checked value then comes from a **synchronous local read
on first render**, with the TOML as the durable record reconciled on the
`DB_CHANGED kinds:["settings"]` broadcast. Non-secret installation metadata (installation id,
account login, target type, repo count, selected repo names, `lastVerifiedAt`) goes in SQLite and
is **revalidated on open, not treated as truth** — matching Conductor, which keeps installation
state server-side and fetches it on demand (teardown §5b).

**Test first.** `src/zeros/store/__tests__/github-auth-method-pref.test.ts`: write
`auth_method = "pat"`, simulate a cold start, and assert the synchronous first read returns `"pat"`
before any async probe resolves; then assert an A→B→A switch and a reload preserve the last value,
per `RULES.md:317-320`.

### S-H2 · `migration-inference-needed` — high (gap)

**Where** `electron/main.ts:1116-1131`; `src/engine/git/github.ts:201-217`;
`src/native/settings.ts:48-60`; `src/engine/settings/files.ts:103-140`.

**What the code does.** One token slot (`github_oauth`) shared by all three paths, and no record of
which path filled it. On upgrade the new `github.auth_method` key is simply absent for every
existing user, and there is no `viaCli`-equivalent on disk to read.

**Fails when.** Defaulting the radio to the GitHub App shows "not connected" for a working install
and invites a re-auth (a perceived logout). Defaulting to PAT shows an empty token box under a
working connection. Running the old implicit chain on first open re-adopts the gh CLI token and
silently switches method (A-H4).

**Verifier — one overstatement corrected, and the correction makes the fix cheaper.** "getAuthStatus
cannot tell a CLI-sourced token from a PAT from a device-flow token" describes the current
*function*, not the data: **the stored credential is largely self-describing.** Token prefixes
separate PAT (`ghp_` / `github_pat_`) from OAuth (`gho_`); re-running `gh auth token` and
string-comparing against the stored value deterministically identifies a CLI-sourced token; and
GitHub returns `x-oauth-client-id` on OAuth-app token responses — which `getAuthStatus` currently
discards — separating Zeros' device-flow client id (`Ov23lityKSllg4mxOQCl`) from gh CLI's
(`178c6fc778ccc68e1d6a`). So the inference is cheap and available; it just has to be written. Two
further notes: the method attribution is **already lost on every cold start today** (S-H1), and the
three-radio UI does not exist in the tree, so the specific "defaults to App / defaults to PAT"
impacts are predictions about an unwritten design.

**Fix.** One-time inference at first read, in the style of `getSettingMigrated`
(`native/settings.ts:48-60`) and `seedUserSettingsFromLegacyRoot` (`files.ts:103-140`) —
idempotent, non-destructive, presence-is-the-marker. If a token exists and validates and
`gh auth token` returns the **same** token → `auth_method = "gh-cli"`; if it exists and differs (or
`gh` is absent) → `"pat"` (device flow and PAT are indistinguishable *and behave identically*, so
collapsing them is honest). If no token, leave the key unset and render "no method selected" rather
than guessing. **Never clear the existing token as part of the migration, and never run the
adopt-side of `detectGhCli` during it.** Infer, never default — a wrong default silently signs
people out.

**Test first.** `src/engine/settings/__tests__/github-method-migration.test.ts`: a table over
`{token present + gh matches, token present + gh differs, token present + gh absent, no token}`
asserting the inferred method (or unset) **and** that `tokenStore.get()` is byte-identical
afterwards in every case. Run it twice to prove idempotence.

---

## 8. `tests-and-gates` (GitHub auth surface) — 6 findings (1 blocker, 3 high, 2 medium)

| ID | Filed → re-rated | Anchor | One line |
|---|---|---|---|
| `push-credential-helper-untestable-by-construction` | blocker | `publish-github.test.ts:3` | → see **B4** |
| `device-flow-test-makes-a-live-network-call` | high → medium | `github.test.ts:599` | The suite POSTs to github.com on every CI run |
| `no-device-flow-cancel-path` | high → medium | `electron/ipc/commands/github.ts:79` | No way to cancel an in-flight device flow |
| `signout-readopts-gh-cli` | high | `github-section.tsx:164` | → see **A-H4** |
| `octokit-cache-swap-only-half-covered` | medium | `publish-github.test.ts:205` | Cache invalidation tested for sign-out, not for a token swap |
| `no-cross-process-token-integration-test` | medium | `electron/ipc/commands/github.ts:22` | Nothing tests that main and the engine agree on the token |

### E-M1 · `device-flow-test-makes-a-live-network-call` — high → medium (test-coverage)

**Where** `src/engine/git/__tests__/github.test.ts:1-2`, `:580-624`; `src/engine/git/github.ts:53-58`,
`:315-348`; `.github/workflows/preflight.yml:148`; `vitest.config.ts:102`.

**What the code does.** `github.test.ts:580-624` is a two-test `client ID resolution` pair. The
second sets `ZEROS_GITHUB_CLIENT_ID` to a fake id and calls `startDeviceFlow()` for real;
`loadDeviceAuth` (`github.ts:53-58`) has **no injection seam**, so `@octokit/auth-oauth-device`
POSTs to `https://github.com/login/device/code`. `setOctokitFactoryForTesting` covers only the REST
client.

**Verifier — subject misidentified, two impact bullets wrong, defect narrowed but real.** The pair's
subject is `resolveClientId()` precedence, not the device flow: `:581` asserts the placeholder gate
exactly and `:600` asserts the env-var override bypasses it. **That pair does gate a real
regression and can go red.** What is genuinely true is narrower: the `:600` test makes a real
outbound POST to github.com on every CI run of `pnpm test:git`, making the suite **non-hermetic**
and green on an offline runner; and no test anywhere covers the substance of the device flow past
that call — the `DeviceVerification` mapping (`:320-327`), token persistence (`:340`),
`cacheOctokit` (`:342`), the `users.getAuthenticated` tail (`:344-348`), or
`electron/ipc/commands/github.ts:84`. Two filed impacts are wrong: a GitHub *success* would **not**
keep the test green (`.rejects` fails on resolution, and the poll loop would blow vitest's 20 s
`testTimeout`), and the ~300 ms runtime is a real GitHub **404** round trip (measured: ~115 ms),
not a DNS failure. Also worth fixing: the file header at `github.test.ts:1-2` claims "We don't hit
github.com", which is no longer accurate.

**Fix.** Add `setDeviceAuthFactoryForTesting` mirroring `setOctokitFactoryForTesting`
(`github.ts:173-185`). Keep the genuinely-offline placeholder-gate test, and make the env-override
test assert on **the client id actually handed to the factory** instead of on a network failure.
Fix the file header.

**Test first.** With the new seam, drive the whole flow: happy path (`onVerification` fires with
mapped fields → token persisted → login returned), `user_code` expiry, `access_denied`, `slow_down`,
and abandonment. All five are untestable today, which is the finding.

### E-M2 · `no-device-flow-cancel-path` — high → medium (gap)

**Where** `electron/ipc/commands/github.ts:79-90`; `electron/preload.ts:51-56`;
`src/zeros/panels/github-section.tsx:139-162`, `:244`; `src/engine/git/github.ts:339`;
`src/zeros/panels/settings-page.tsx:601-605`, `:744-764`; `src/app-shell.tsx:940`.

**What the code does.** `ghAuthSignin` awaits `startDeviceFlow()` with **no `AbortSignal` and no
cancel command**; the comment concedes "a 'wait for user to authorize' window of up to 15
minutes". `@octokit/auth-oauth-device`'s `waitForAccessToken` recurses until GitHub expires the
code. `electron/preload.ts:51-56` lists no `gh_auth_cancel`. No test covers any of it.

**Verifier — the stated failure path is wrong; two narrower routes are real.** Settings is **not a
dialog that unmounts**: `SettingsPage` and its section panels live in retained decks (inactive
panels get `className "hidden"`, not unmounted), so `GitHubSection` stays mounted, `busy` stays
true, the device code stays visible, and Save token / Connect / Refresh / Sign out are all
`disabled={busy}`. Also, a flow the user never authorizes writes no token — it just expires — so
the PAT-overwrite requires the user to complete authorization on github.com *after* switching
methods. **The overwrite is reachable via two narrower routes:** (1) `github-section.tsx:244` calls
`submitPat()` on Enter **with no busy guard**, so the keyboard bypasses the lockout; (2) a renderer
reload clears `busy` while the main-process poll survives. **The underlying missing guard is that
`startDeviceFlow`'s `tokenStore.set` at `github.ts:339` is unconditional — it never checks whether
the store changed since the flow began.**

**Fix.** Three parts: a compare-and-set (or generation counter) on the token write — which is the
same guard A-H3 needs, so build it once; `gh_auth_cancel` plus an `AbortSignal` through
`startDeviceFlow` (and the preload allowlist entry, which `check:preload` will demand); and a busy
guard on the Enter-key path at `:244`.

**Test first.** Start a fake device flow, cancel it, then resolve the fake poll **after**
cancellation; assert `tokenStore.get()` is unchanged and no `GITHUB_TOKEN_SET` is couriered. Second
case: start the flow, write a PAT, then resolve the poll; assert the PAT survives.

### E-M3 · `octokit-cache-swap-only-half-covered` — medium (test-coverage)

**Where** `src/engine/git/__tests__/publish-github.test.ts:115`, `:205`;
`src/engine/git/__tests__/github.test.ts:264-265`; `src/engine/git/github.ts:353-370`, `:378-388`;
`src/engine/git/engine-token-store.ts:38`; `src/engine/index.ts:1781`, `:4056`.

**What the code does.** `publish-github.test.ts:205` ("STOPS publishing once the token is cleared")
covers token→null. The guard in `getOctokit` is `cachedOctokit && cachedOctokitToken === token`,
repeated in `getOptionalAuthOctokit`. **No test covers token A → token B where both are non-null
and both authenticate** — which, with three selectable methods, is the *normal* operation.

**Verifier — the reasoning should be restated, and one sub-claim is wrong.** (1) The A→B case
matters not because a future refactor *might* cache on truthiness, but because the identity check
is **the only invalidation mechanism on the real production swap path**: `seedGithubToken()`
(`engine-token-store.ts:38`) replaces the engine's working copy from the host courier
(`src/engine/index.ts:1781`, `:4056`) **without clearing the octokit cache**, so `github.ts:366` is
load-bearing on its own there. (2) Closing the gap requires **changing the test seam first** — the
doubles at `github.test.ts:264` and `publish-github.test.ts:115` discard the token argument and
return one shared mock, so a swap test must inject a token-recording factory to assert anything.
(3) The `getOptionalAuthOctokit` sub-claim is **wrong**: `clearOctokitCache()` at `github.ts:381`
runs only when the store returned null, so an unauthenticated avatar read cannot evict a client
that still matches a live token — that eviction is the correct sign-out invariant.

**Fix / test first.** Replace the test factory with one that records its `token` argument, then in
`github.test.ts`: set token A, call `getAuthStatus` (caches), seed token B via `seedGithubToken`,
call a PR op, and assert the factory was invoked a second time **with B**. That is the regression
test for "switching method must not keep acting as the old identity" — the failure mode being PRs
opened under the wrong account while the Settings card shows the new login.

### E-M4 · `no-cross-process-token-integration-test` — medium (architecture)

**Where** `electron/ipc/commands/github.ts:22-29`, `:62`, `:70`, `:76`, `:89`, `:108`;
`electron/main.ts:1119-1131`; `electron/sidecar.ts:1191-1196`, `:1529-1531`;
`src/engine/index.ts:1108`, `:1125-1127`, `:1130-1148`;
`src/zeros/bridge/__tests__/workspace-bridge.test.ts`.

**What the code does.** `electron/ipc/commands/github.ts:22-29` imports
`detectGhCli`/`getAuthStatus`/`setToken`/`signOut`/`startDeviceFlow` from `../../../src/engine/git`
— the Electron main bundle's own copy of the module, with its own module-level `tokenStore`. The
engine process wires a different store. So `gh_set_token` verifies and persists in **main**, while
every `gh.*` PR op reads the **engine's** in-memory copy.

**Verifier — the mechanism is misdiagnosed; the gap is real but session-scoped.** Two module
instances are inevitable across two processes, and that is **not** what allows drift: main's
`tokenStore` is a thin safeStorage passthrough and the courier reads safeStorage directly, so there
**is** a single durable source of truth. The real gap is that **the engine's in-memory working copy
is refreshed only by the five `pushGithubTokenToEngine()` calls plus the `ZEROS_GITHUB_TOKEN` env
seed on each engine spawn**, and nothing asserts that a successful `gh_set_token` / `gh_detect_cli`
/ `gh_auth_signin` leaves the engine holding the same token. Consequence of a missed push:
`gh_auth_status` (main) reports Connected while every engine `gh.*` op reports
`NOT_AUTHENTICATED` — **until the next engine respawn re-seeds from env**, so the drift is
session-scoped, not permanent. The filing also mis-attributes the zero-config boot adopt: its
purpose is the case where the host couriered **no** token at all (fresh install / never opened
Settings) so agent-created PRs still surface; it runs once, only when the store is empty, so it
cannot mask a mid-session missed push — and it creates the **reverse** asymmetry (engine
authenticated via gh, safeStorage and Settings empty).

**Fails when.** A GitHub App adds at least connect / refresh / revoke to today's five call sites.
Forgetting one produces exactly the split-brain above, and no gate catches it.

**Fix.** Reduce the number of places that must remember. Make the courier the *only* writer of the
engine's copy and drive it from a single "credential changed" event rather than five hand-placed
calls — and, per A-H1, stop pushing values in the other direction entirely.

**Test first.** A bridge-level integration test — the pattern already exists in
`src/zeros/bridge/__tests__/workspace-bridge.test.ts`, which does request/response round-trips over
the socket. Seed the engine via the control channel, call a `gh.*` op through the bridge, and
assert the injected Octokit factory received the seeded token. **One case per auth method**, so
adding the App forces a new case.

---

## 9. `token-storage-security` — 3 findings (2 high, 1 medium)

| ID | Filed → re-rated | Anchor | One line |
|---|---|---|---|
| `token-in-spawn-env` | high | `electron/sidecar.ts:1195` | Decrypted token in the engine env, inherited by every PTY and agent |
| `token-value-broadcast-to-renderer` | high → medium today | `src/engine/index.ts:1112` | → see **A-H1** |
| `no-tests-for-secret-store` | medium → cluster-wide | `electron/secret-store.ts:88` | Zero coverage on the files that decide credential safety |

### TS-H1 · `token-in-spawn-env` — high (security)

*Also filed as `github-token-in-local-subprocess-env` (auth-state-machine, medium) and
`agent-gets-no-credential-token-leaks-in-pty` (onboarding, high). Three independent filings — the
most-corroborated finding after the 403.*

**Where** `electron/sidecar.ts:1188`, `:1191-1198`, `:1228`, `:1543-1547`;
`src/engine/index.ts:1125-1127`; `src/engine/pty/shell-setup.ts:110-112`, `:166-176`, `:185-195`,
`:113-155`; `src/engine/agents/adapters/shared/stdio-process.ts:62`;
`src/engine/pty/__tests__/shell-setup.test.ts:35-42`; `src/engine/git/setup-hooks.ts:144-158`.

**What the code does.** Verified verbatim at `electron/sidecar.ts:1190-1195`:

```ts
// H4: seed the GitHub OAuth token DIRECTLY (main → engine env), never through
// the renderer. …
const ghToken = getSecret(GITHUB_OAUTH_ACCOUNT);
if (ghToken) extraEnv.ZEROS_GITHUB_TOKEN = ghToken;
```

and the spawn at `:1228` uses `env: { ...process.env, ...extraEnv }`, so the plaintext token lives
in the engine's environment block for the process lifetime. The engine leaks it two ways.
(1) **Local PTYs**: `buildPtyEnv` builds the non-scrub env as `env = { ...src }` from
`process.env` (verified at `shell-setup.ts:175`) and the delete block at `:185-195` removes only
`TERM_PROGRAM*`, the four `ZEROS_PTY_*` vars and `ELECTRON_RUN_AS_NODE` — `ZEROS_GITHUB_TOKEN`
survives. (2) **Agent subprocesses**: `stdio-process.ts:62` spawns with
`env: opts.env ? { ...process.env, ...opts.env } : process.env`. `REMOTE_ENV_ALLOW`
(`shell-setup.ts:113-155`) correctly excludes it, so remote/relay clients are safe — local ones are
not. **The contradiction is explicit in the same file that creates the hazard**:
`electron/sidecar.ts:1543-1547` says the MCP OAuth vault is couriered over stdin precisely to keep
"the token blob out of agent subprocess environments". The token is also **not** exported as
`GH_TOKEN`/`GITHUB_TOKEN`, so `gh` and `git` cannot use it — a leak with no benefit. And
`setup-hooks.ts:144-158`'s allowlist comment names this exact secret ("the engine's full env
carries provider API keys, the GitHub OAuth token…"), so setup scripts *are* scrubbed of it while
interactive shells and agents are not.

**Fails when.** A signed-in user runs `env | grep ZEROS` in any Zeros terminal and the raw
OAuth/PAT token prints. An agent that dumps its environment persists it into `zeros.db` and, via
stdout forwarding, into `main.log`/`app.jsonl`/`engine.log`. A malicious npm postinstall, MCP
server, or repo build script executed by the agent exfiltrates it with one
`process.env.ZEROS_GITHUB_TOKEN`. This is strictly wider than the renderer-XSS surface the H4
design was written to close.

**Verifier — timing precondition, one leg downgraded, and two additions.**
(a) **Timing:** the var is present only for engines **spawned while a token already exists in
safeStorage**. A mid-session sign-in is couriered over stdin and never mutates the running engine's
environment, so a first-ever sign-in is not exposed until the next spawn/app restart — exposure is
"every session after the first sign-in", not "always immediately". gh-CLI-only users are not
affected via this path at all, because `detectGhCli` adoption stays in engine memory and the mirror
propagates only clears; **the affected population is PAT and device-flow users.**
(b) **The logging leg is speculative, not demonstrated:** nothing in the engine prints its own
environment, and the forwarder only relays what the engine writes, so persistence into
`main.log`/`zeros.db` requires an agent or tool to dump env itself — a consequence of the leak, not
an independently observed path.
(c) **Two additions.** `ZEROS_LOCAL_WS_TOKEN` (`electron/sidecar.ts:1188`) leaks by the identical
route and is **unconditional** (no token precondition); it is the engine's loopback `/ws` bearer
(`src/engine/index.ts:704`), so any local shell or agent can authenticate to the engine as a
trusted local client. Fix them together. And the leaked GitHub credential is **broad-scope**
(`repo`, `read:org`), since it is the single REST token — so this is exfiltration of a full-scope
token. Severity nuance worth keeping honest: a local shell already runs as the user, so where the
user has a gh login the *marginal* exposure is small (`gh auth token` and `~/.config/gh/hosts.yml`
are readable anyway); the genuine escalation is that a PAT or device-flow token held **encrypted in
safeStorage** becomes plaintext in every agent-visible child env.

**Fix.** Stop seeding the token via spawn env. `pushGithubTokenToEngine()` already couriers it over
stdin and is called on every auth change — call it once on engine-ready instead. If the boot race
is a concern, keep the env seed but have the engine `delete process.env.ZEROS_GITHUB_TOKEN`
immediately after `seedGithubToken(...)` at `src/engine/index.ts:1125-1127`, and add
`ZEROS_GITHUB_TOKEN`, `ZEROS_LOCAL_WS_TOKEN` and `ZEROS_CONTROL_FD` to the delete list in
`buildPtyEnv` (`shell-setup.ts:185-195`) **and** to `stdio-process.ts`. The same rule must apply to
any App installation token. Note the fix has a **prerequisite**: the exposure is locked in by an
existing test — `src/engine/pty/__tests__/shell-setup.test.ts:35-42` asserts "local shells keep the
full env (desktop parity)" — so that test must be amended in the same commit. The "desktop parity"
rationale at `shell-setup.ts:110-112` ("the operator already holds those secrets locally") does not
apply: the user's own shell has gh/keychain credentials, never a plaintext GitHub token in an env
var.

**Test first.** Amend `shell-setup.test.ts` to assert that a local shell env contains **none** of
`ZEROS_GITHUB_TOKEN` / `ZEROS_LOCAL_WS_TOKEN` / `ZEROS_CONTROL_FD` while still keeping the rest of
the env (preserving the parity intent). Add the same assertion for `stdio-process` spawns. Both
fail today, and one of them fails *because of* an existing green assertion — which is exactly the
kind of test-pinned hazard that only shows up if you write the test first.

### TS-M1 · `no-tests-for-secret-store` — medium → cluster-wide (test-coverage)

**Where** `electron/secret-store.ts:22`, `:88-118`, `:115`, `:132-139`, `:146-150`, `:159-164`,
`:177`; `electron/keychain-accounts.ts:28-34`; `src/native/secrets.ts:69-74`;
`vitest.config.ts:29`; `electron/__tests__/updater-channel-feeds.test.ts`.

**What the code does.** `electron/__tests__/` contains deep-link-open, devtools, log-coalesce,
stream-backpressure and updater-channel-feeds tests only. Nothing exercises the cross-process lock,
the stale-steal path, the unlocked fallback at `:115`, the merge-not-clobber contract at
`:146-150`, the decrypt-failure-returns-null behaviour at `:159-164`, or the renderer allowlist's
deny path.

**Verifier — one overstatement and one understatement, and they pull in opposite directions.**
(1) The claim **overstates** the existing coverage: `src/zeros/agent/__tests__/env-vault.test.ts:145`
is not an "indirect hit" — it is a **code comment beside a hand-rolled fake**
(`getSecret: async () => null, // secret-store swallows decrypt failures into null`). It never
imports the module; it hard-codes an assumption about it. Coverage is therefore **literally zero**,
not near-zero. (2) The claim **understates** the scope by framing these as uniquely bad: the
**entire credential-handling cluster** has zero direct tests —
`electron/ipc/commands/secrets.ts`, `electron/ipc/commands/github.ts`,
`electron/ipc/commands/auth-session.ts`, `electron/ipc/commands/auth-handoff.ts`, and
`src/zeros/bridge/github-token-sync.ts` all have no test importers. The remediation is larger than
the finding implies.

**Fix / test first — and note the two files are not equally hard.**
`electron/keychain-accounts.ts` is a **dependency-free pure predicate** and
`electron/__tests__/**/*.test.ts` is already in the vitest include list (`vitest.config.ts:29`), so
its deny path is testable **immediately with no scaffolding** — plus the `VENDOR_ACCOUNTS` ↔
`SECRET_ACCOUNTS` drift check that nothing enforces today. Start there. `electron/secret-store.ts`
imports `electron` at top level, so it needs `vi.mock("electron")` or the source-text pattern
already used by `updater-channel-feeds.test.ts`. Then: over a temp `ZEROS_SHARED_SECRETS_DIR` with
a stubbed `safeStorage`, assert concurrent `setSecret` from two "processes" preserves both keys;
a lock timeout does not clobber; `hasSecret` vs `getSecret` distinguish missing from
undecryptable; and `isRendererKeychainAccount` denies `github_oauth`, `auth-session:*` and every
new GitHub App account name. Adding App credentials multiplies both the write rate and the
allowlist surface, so this is a prerequisite, not a follow-up.

---

## 10. Hazards, not yet bugs

**These 16 findings were never verified.** They were rated low or info, so no refuter was assigned.
Given the 52% kill rate on the findings that *were* attacked, assume a comparable fraction of this
section would not survive. Treat every item as a lead with a citation, not as a fact. They are
included because several are cheap to fix and land directly on the App path.

### Hazards that get worse under the GitHub App

| Hazard | Where | Why it matters after the App ships |
|---|---|---|
| `startDeviceFlow` **persists before verifying** — `tokenStore.set(token)` at `:340`, then `users.getAuthenticated()` at `:344`. `setToken` (`:267-275`) and `detectGhCli` (`:246-254`) do the opposite. | `src/engine/git/github.ts:340` | A failed verification leaves a credential in safeStorage with an error on screen and **no method recorded** — exactly the half-completed state the persisted-method record must make impossible. Fix: verify then persist, and write `{method, token, login, verifiedAt}` as one atomic record. |
| Every list call is **capped at one page** with no pagination and no truncation signal: `checks.listForRef` (100, and `total_count` is fetched then ignored), `listCommitStatusesForRef` (100), `pulls.listCommits` (100 — GitHub caps this endpoint at 250), `pulls.listReviews` (100), `issues.listComments` (100), `orgs.listForAuthenticatedUser` (100), `pulls.list` (50). None use `octokit.paginate`. | `src/engine/git/github.ts:1341`, `:1344`, `:1459`, `:1548`, `:1556`, `:920`, `:1275` | A monorepo PR with >100 check runs shows a silently wrong pass/fail rollup; a long review thread loses its most recent comments; a user in >100 orgs cannot select some. A **repo picker** (O-H1) makes this user-facing. Tension worth naming: paginating multiplies calls, which is another argument for the App's separate budget. |
| `detectGhCli` runs `gh auth token` with **no `--hostname`**, so it takes gh's *default* host — the enterprise host for a GHE user — then validates it against api.github.com and reports `{available: true, authenticated: false}` on failure. The catch-all at `:252` also swallows genuine network failures as "not authenticated". | `src/engine/git/github.ts:235-238`, `:248`, `:252-254` | A GHE user with a working `gh` login is told the CLI is present but not authenticated, with no hint that Zeros only understands github.com. Fix: `gh auth token --hostname <host-of-origin>`, and a third state ("couldn't verify — offline") for the gh-CLI row. |
| `getBehindBy` **caches failures** for the full `BEHIND_BY_TTL_MS = 5 min` — the catch sets `value = null` and then writes that null with a fresh timestamp — and `signOut()` does not clear `behindByCache`. | `src/engine/git/github.ts:1209-1218`, `:279-282` | One flaky compare (or the 403 that just deleted the token) blanks "N commits behind" for five minutes after auth recovers, and the stale entry outlives a sign-out/sign-in cycle. Fix: cache only successes (or a ~15 s penalty TTL) and clear it in `signOut` alongside `clearOctokitCache`. |
| `syncWorkspacePr` lists PRs on the **configured remote only**, so **fork-based PRs are never detected** — in a fork workflow `origin` is the user's fork while the PR lives upstream. | `src/engine/git/github.ts:673-705`, `:817-823` | A fork contributor gets no island, no "PR #N" pill, and a permanent Create PR button. The exact-head-ref re-check at `:834` prevents stamping a *wrong* PR, so it degrades to invisibility rather than corruption. Worth deciding explicitly during the redesign, because **per-repo App installation scoping has to cover the base repo AND the fork.** |
| `listPrs` and `syncWorkspacePr` **discard `merged_at`** on a false premise: the comment at `:1285-1287` claims "pulls.list rows don't carry merged_at", but `@octokit/openapi-types@27`'s `pull-request-simple` includes `merged_at: string | null`. So `syncWorkspacePr` spends an extra `pulls.get` (`:850`) to recover a field it already had. | `src/engine/git/github.ts:1285-1289`, `:843`, `:850`, `:855-861` | Every sync of a closed PR costs a needless call; if that call fails, a genuinely merged PR is classified "closed" and the workspace never reaches "done". Fix the comment too, so the next reader does not re-derive the wrong constraint. |
| `isDraftUnsupported` matches on **prose**, so a 422 like "No commits between main and **draft**-**not**es" satisfies both its patterns and triggers a second doomed `pulls.create`. | `src/engine/git/github.ts:718-727`, `:768-769` | Today: one wasted round trip on a branch named `draft-notes`. **If GitHub ever returns 422 for a partially-applied create, the retry becomes a duplication risk.** Fix: match `err.response.data.errors[].message`, not the joined prose. |
| `getRepositoryOwnerAvatar` deliberately falls back to an **unauthenticated** client (`octokitFactory("")`), and unauthenticated GitHub REST is **60 requests/hour per IP** — shared across every app on the machine and, behind corporate NAT, across the office. | `src/engine/git/github.ts:376-388` | A signed-out user with several projects exhausts 60/hr; the resulting 403 propagates as `NOT_AUTHENTICATED` with "Re-authenticate" — advice that makes no sense for a deliberately unauthenticated call. Fix: cache by owner login with a long TTL and fail soft to null. |

### Hazards in the Settings surface (all land on the new picker)

| Hazard | Where | Note |
|---|---|---|
| The **retained, hidden** Integrations panel keeps probing GitHub. Visited sections stay mounted with `inert`/`display:none`, and each Panel is handed `surfaceActive`, but `IntegrationsPanel` **drops that prop** and `GitHubSection` accepts none — so its `useCachedRead` effect re-runs on every `invalidationVersion` bump, e.g. every non-initial bridge reconnect. | `src/zeros/panels/settings-page.tsx:744-764`, `:186`, `:761`, `:1055-1061`; `src/zeros/panels/github-section.tsx:65` | An engine restart while the user is on Settings → Models fires a `/user` call plus a `gh auth token` subprocess for a card nobody is looking at. With three methods plus per-method repo-access health checks, one reconnect becomes several API calls. `AGENTS.md:21` requires hidden retained surfaces to gate active-only polling. Fix: thread `surfaceActive` through and pass `key: surfaceActive ? "auth" : null` — the hook explicitly supports an inert null key while still serving the last snapshot on reopen. |
| **Five `syncToken()` calls in the GitHub card are no-ops.** `syncToken` wraps `pushGithubTokenToEngine(bridge)`, which is `async … { return; }` — *"H4: no-op kept for call-site compatibility"*. Main couriers the token itself inside each IPC handler. | `src/zeros/panels/github-section.tsx:77-79`, `:102`, `:131`, `:154`, `:173`; `src/zeros/bridge/github-token-sync.ts:22-28` | A rewrite that keeps these preserves the false impression that the renderer participates in token delivery, and invites someone adding a **fourth** method to "forget" the call and hunt a nonexistent bug. Delete it with the picker. |
| `GitHubSection` uses a **bespoke bordered card** (`SECTION_HEADING_CLS`, `CARD_CLS`, `HINT_CLS`) instead of composing `SettingsSection`/`SettingsList`/`SettingsRow`/`SettingsField`, which every other panel uses and which encodes the load-bearing type scale. | `src/zeros/panels/github-section.tsx:59-63`; `src/zeros/panels/settings-ui.tsx:19-24`, `:35-170`, `:72-73`; `src/globals.css:1053-1059` | A three-row picker built inside that ad-hoc card will not align with the Preferences/Models/Providers rows one sidebar click away, and its `text-sm` labels get shrunk to 13 px by `.settings-type-scale` while siblings stay 14 px. Rebuild as `SettingsSection` + `SettingsList` of three `SettingsRow`s, and reuse `providers-panel.tsx:1229-1250`'s `StatusBadge` recipe for the per-row health pill. |

### Hazards in logging and cloud

| Hazard | Where | Note |
|---|---|---|
| **On-disk logs are written raw.** `redactLogSecrets` runs only at export/view time; `log-store.ts` writes records verbatim and the sidecar forwards all engine stdout/stderr into it plus a raw `engine.log` side-stream. | `electron/ipc/commands/logs.ts:55`; `electron/log-store.ts`; `electron/sidecar.ts:1284-1289`, `:1311-1377` | Anything that ever prints a credential — an agent echoing `env` (TS-H1), a future App debug line, a `git remote -v` in a captured terminal — sits in plaintext under `~/Library/Logs/<channel>/` for hours to days, outside the boundary the export path advertises. `SECURITY.md:63-64` lists "tokens leaking into logs" as in scope. Fix: scrub at write time in `log-store.ts` (`redactLogSecrets` is deliberately debuggable-weak, so the cost is low) or document the gap explicitly. Note Conductor scrubs to `[REDACTED_GITHUB_TOKEN]` / `cond_[REDACTED]` / `sk-[REDACTED]` (teardown §1). |
| **The cloud panel specifies two methods, the Settings design has three** — `docs/cloud-workspace/08-engineering-reference.md:528` says "GitHub (Zeros App recommended / PAT)". gh CLI is structurally impossible in a sandbox. | `docs/cloud-workspace/08-engineering-reference.md:528`, `:79` | If method selection is one global setting, a gh-CLI user gets a green local status and a cloud workspace that cannot clone. Fix: make the method a **per-surface capability** — each method declares whether it can back local REST, local git push, and cloud sandboxes — and surface the gap in the health readout ("gh CLI auth works on this Mac; cloud workspaces need the Zeros GitHub App or a PAT") instead of discovering it at clone time. This generalises cleanly to GitLab/Bitbucket. |

### One info-level finding worth keeping: what is already provider-neutral

An inventory of what a refactor should **preserve rather than rebuild**, and the only item in this
whole document that is good news. Genuinely neutral today: `resolveWorkspaceTargetRef`
(`src/engine/git/target-branch.ts:21-35`, pure git); `TargetBranchButton`'s remote-branch listing
(`src/shell/pr/target-branch-select.tsx:16-18`, no host awareness);
`derivePrIslandState`'s local-blocker tier — conflicts / uncommitted / diverged / ahead / behind
(`src/shell/pr/pr-status.ts:219-265`, pure `gitStatus`); `PrIslandAction` / `PrIslandActionBehavior`
/ `PrIslandActionKind` (`pr-status.ts:36-64`, workflow verbs not GitHub calls); and
`PrCommitSummary` / `PrCheck` / `PrDeployment` / `PrChecksResult` (`src/native/git.ts:1145-1191`,
shaped like generic CI/commit data).

---

## 11. Notable claims we rejected

Six of the 57 killed findings, chosen because each teaches a different failure mode of code
auditing. `why_refuted` is quoted from the verifier.

### 1. "Cloud workspaces cannot push" — the whole area was anchored on non-shipping code

**Killed: `sandbox-has-no-credential-helper` (blocker), `token-set-local-only` (blocker),
`no-remint-path-for-1h-token` (blocker), `no-cloud-github-credential-code` (high), and 7 more.**
All 11 `cloud-workspace-credentials` findings died. The dominant reason:

> *"The anchored file is explicitly non-shipping harness code, not product code.
> `scripts/cloud-spike/README.md:12-19` says verbatim: 'Status — read this first. This directory is
> exploratory harness code, not product code. The engine change it exercises (`CloudTransport`)
> ships; these scripts do not — nothing in the packaged app imports them, and they are excluded from
> every build.' I verified both halves independently."*

`token-set-local-only` died differently and more instructively — it **misidentified the mechanism
and inverted the security intent**: the desktop courier does not use `GITHUB_TOKEN_SET` at all
(`pushGithubTokenToEngine` is an explicit no-op; the real courier is spawn env plus a stdin control
line), and the `kind === "local"` guard the auditor wanted removed is the thing *preventing* a token
from being broadcast to a remote client. `no-remint-path-for-1h-token` died because the token is
**not** read once at boot: there are two live mid-session re-seed paths (the stdin host control
channel and the `GITHUB_TOKEN_SET` bridge message), neither requiring a restart.
**The lesson:** the audit's confidence about cloud was manufactured by reading a spike directory.
The real cloud gap is a *product* gap — nothing provisions a credential — and it is stated in B1
and B3, not in a Dockerfile.

### 2. "A credential-less HTTPS op hangs forever" — the engine has no controlling terminal

**Killed: `no-git-terminal-prompt-hang` (high).** The auditor did real work — they reproduced the
hang in a sandbox shell:

> *"The two factual sub-observations are true, but the failure mechanism and every claimed impact
> are wrong. WHAT IS TRUE: `GIT_TERMINAL_PROMPT` genuinely appears nowhere in the repo … push, pull,
> fetch, clone and the diff-materialising fetch genuinely pass no `timeoutMs`. WHY THE CLAIM FAILS —
> the engine has NO controlling terminal, by construction."*

The reproduction was valid in a tty; the engine is not in a tty. **The lesson:** reproducing a
behaviour in a shell is not reproducing it in the product's process tree. Note the *facts* survive
and are still worth acting on — `GIT_TERMINAL_PROMPT=0` is in the broker design anyway — but as a
fast-fail/classifiability measure, not as a hang fix.

### 3. "The ReviewProvider seam is inert" — true signature, impossible failure

**Killed: `review-provider-seam-inert` (high).**

> *"The signature observation is literally true (`resolveReviewProvider` ignores `_originHost`; both
> call sites pass nothing), but the finding's impact and its supporting premises are wrong… The
> claimed failure mode is impossible. Every GitHub provider method routes through
> `workspaceRemote(workspaceId)` which calls `parseGitHubRemote`; that function hard-rejects any
> host other than github.com/www.github.com/ssh.github.com with a typed `GitError VALIDATION_FAILED`
> BEFORE any Octokit/network call."*

**The lesson:** a dead parameter is design debt, not a bug, when a downstream guard makes the wrong
dispatch unreachable. P-H1 and P-M1 survived precisely because they name consequences that *are*
reachable (a bypassed seam; an enabled button on an unsupported host).

### 4. "GitHub Enterprise is structurally impossible" — the parser is not the product

**Killed: `github-com-only` (high).** The auditor probed `parseGitHubRemote` against 27 real-world
remote forms — genuinely good work — and concluded GHE cannot work.

> *"The structural facts check out … but every claimed impact is wrong or materially overstated.
> (a) 'Cannot create a PR': the product's Create PR is agent-driven `gh pr create` … host-agnostic;
> the manual fallback uses a SEPARATE host-preserving parser (`src/shell/pr/github-url.ts:19-66`)
> that is explicitly unit-tested against a GHE host; the Octokit `createPr` has no renderer
> caller."*

**The lesson (and it is uncomfortable):** the reason GHE partly works is B3 — the product's primary
PR path bypasses the engine entirely. **Fixing B3 will *remove* an accidental GHE capability.**
That is a real cost of the fix and belongs in the plan, which is why the App spec carries an
`{key, label, clientId, appSlug, hostname}[]` variant list from day one even though no GHES App is
registered yet.

### 5. "`withAuthRetry` never retries" — same observation, opposite verdicts

**Killed in one area, survived in another.** The identical observation was filed twice.
`auth-state-machine`'s copy was killed:

> *"The observable behaviour ('fn is invoked once') is true, but every consequence the finding rests
> on is false… A retry is structurally impossible, not accidentally missing. The handler does
> `await tokenStore.clear()` and `getOctokit()` re-reads the store on every call … throwing
> NOT_AUTHENTICATED when it returns null. A second invocation after the clear would be guaranteed to
> fail, never succeed."*

`github-api-layer`'s copy survived at medium (G-H1) because it framed the defect as **the false doc
comment misleading the App design**, not as a missing retry. **The lesson:** a finding's survival
depends on the impact claim, not the observation. Two auditors saw the same three lines; the one who
claimed a runtime bug lost, and the one who claimed a documentation trap won.

### 6. "There is no radio-group primitive" — the dependency was already installed

**Killed: `no-radio-group-primitive` (medium).**

> *"Radix RadioGroup is ALREADY a vendored, installed dependency. `package.json:154` lists
> `"radix-ui": "^1.4.3"` … that unified package's barrel does
> `export * as RadioGroup from '@radix-ui/react-radio-group'` … Verified at runtime:
> `require('radix-ui').RadioGroup` exposes `Root`, `Item`, `Indicator`."*

**The lesson:** checking the barrel export is not checking the dependency tree. Four other killed
findings had this shape — a grep that stopped one hop too early. It is also why the surviving
findings' anchors were re-opened before being written into this document.

---

## 12. What this list does not cover

Honest gaps, so nobody mistakes silence for a clean bill of health.

- **The backend was audited only for cloud credentials, and all of it was killed.** Seven
  `cloud-workspace-credentials` findings touched `backend/` (no webhook route shape, no
  installation-to-team linkage, `audit_log.team_id NOT NULL` with zero-team users, an in-memory
  per-user rate limiter, the `org_secrets` vault dropped in migration `0005`). None survived as
  *defects* — most were "the feature does not exist yet", which is true but is not a bug. **That
  means the backend's readiness for the App is essentially unaudited.** Part 05 designs the
  endpoints; nothing in this evidence base tells you whether the existing RLS/authz shape fits them.
- **No dynamic testing of the auth paths.** Everything here is static reading plus small synthetic
  probes against the real modules. Nobody drove the packaged app through a device flow, a SAML org,
  or a rate-limit wall.
- **No performance measurement.** The rate-limit arithmetic in G-H2 is derived from cadences and
  fan-out, and its verifier explicitly flagged the "~1600 calls/hr" figure as unsourced. There is no
  rate-limit instrumentation in the repo, so nothing was measured.
- **The 16 hazards in §10 were never attacked.** Expect roughly half to dissolve on contact.
- **No cross-finding re-ranking.** The design panel and the report critics were cut for time, so the
  severities are per-finding as amended by per-finding refuters. Nobody sat down with all 52 and
  asked which five matter most. The blocker set in §1 is the exception: it is coherent because those
  four defects form one causal chain, not because a panel agreed on it.
- **Refuted does not mean false.** Most killed findings had a true mechanical observation. If a
  refuted claim reappears during implementation with a *reachable* impact chain, it is a new finding,
  not a settled question.

## 13. The fix order this implies

Not a plan — part 07 owns that. But the dependency structure inside this list is worth stating,
because three of the fixes are prerequisites for the others rather than parallel work.

```mermaid
flowchart LR
  T1["Write the failing tests<br/>push-credentials · 403-classifier ×2<br/>keychain-accounts drift"] --> F1["B2 · split the classifier<br/>401-only clears"]
  T1 --> F2["B1 · credential broker<br/>host-scoped helper + PATH shims"]
  F1 --> F3["Persisted auth method<br/>S-H1 + S-H2 migration"]
  F2 --> F3
  F3 --> F4["A-H3/A-H4 · probe ≠ adopt<br/>gate both re-adoption sites"]
  F2 --> F5["B3 · Create PR through the engine<br/>+ brokered agent shell"]
  F1 --> F6["G-H4 · capability verdict<br/>'All repositories accessible.'"]
  F4 --> F7["Three-method picker"]
  F6 --> F7
  F5 --> F7
  F7 --> F8["GitHub App + cloud<br/>A-H1 must land BEFORE this"]
  F1 --> F9["G-H2 · throttling + fast-lane decay"]
  T1 --> F10["TS-H1 · env delete-list<br/>(amend shell-setup.test.ts)"]
```

Three hard orderings, each from a verifier correction rather than from taste:

1. **B2 before the App.** Per-repo installation scoping *generates* 403s by design, so shipping the
   App on today's classifier would sign users out constantly. And it must be fixed on **both**
   routes — the Electron-main `getAuthStatus` route was missed by all three auditors who filed it.
2. **A-H1 before the App.** Today the token-value broadcast is a boot-time race. Once the engine
   re-mints installation tokens hourly, it becomes a live credential broadcast to the renderer on a
   fixed cadence.
3. **P-H3 before GitLab.** `repo_slug` is baked into on-disk worktree paths, so the identity
   decision cannot be deferred past the second host.

And one ordering that is a rule rather than a dependency: **B4 means the credential fix has no gate
until someone writes one.** `push-credentials.test.ts` must be red before B1 is touched. That is not
process theatre — it is the only assertion in the entire suite that would notice if the broker were
refactored away.
