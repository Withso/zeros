# Git & Workspace — Consolidated Reference, Status & Test Plan

> **Date:** 2026-06-30 · **Verified against:** `main` @ `430b6c54` (2026-06-29) ·
> **Status:** Single source of truth for the Git + Workspace surface.
>
> **This document consolidates and supersedes four earlier docs** (kept for history, safe to delete):
>
> - `full-git-integeration-summary.md` — full git integration (PR #31, 2026-06-02, branch `puebla`)
> - `manual-qa-open-project-and-git-model.md` — open-project perf + git model (PR #55, 2026-06-16)
> - `git-workspace-model-decision-and-fix-plan-2026-06-25.md` — audit, locked decisions, fix plan (2026-06-25)
> - `manual-qa-git-workspace-fixes-2026-06-25.md` — audit-fixes manual QA (PR #85, 2026-06-25)
>
> **Why a re-consolidation, not a merge:** the four docs were written across PRs #31→#85 and are
> **stale in load-bearing ways**. Later PRs reversed or reshaped several of their claims. Every
> status below was re-checked against the current tree (file:line cited). The biggest deltas the
> reader must internalize:
>
> - 🔁 **Read-only "Local main" trunk was REMOVED** (#74/#75). The trunk is now a **first-class,
>   fully editable workspace**. The old "main is read-only" §4 is obsolete.
> - 🔁 **Web / relay was REMOVED** (#82). The bridge is now **local-loopback, desktop-only**. All
>   web/relay/phone/pairing test cases are moot.
> - **Changes tab was reshaped** (#69/#72/#73): git is **agent-driven** — no commit footer, no
>   manual stage/unstage buttons, no inline diff pane (diffs open in the row-1 viewer).
> - **Workspace Archive + a History page** shipped after the docs (#87).
> - The audit's headline fixes (reliable create, Setup tab, Duplicate, open PR/branch, Initialize
>   Git) shipped (#85). **Cleanup update 2026-06-30:** canonical project-root identity now
>   dedupes symlinked roots at the engine DB boundary; the create abort/`provisioning`-state
>   machine remains unbuilt. See §4 and §5.
>
> **MCP is out of scope here** — it moved from "design MCP disabled" (old #31 note) to a full
> subsystem; see `mcp-consolidated-architecture-audit-and-test-plan-2026-06-30.md`.

**Legend:** ✅ shipped & code-verified · ⚠️ partial / differs from the original plan · ⛔ not built
(open gap) · 🔁 reversed / obsolete since the source doc · 🧪 manual-only test · ✅🧪 manual test with
automated coverage behind it.

---

## 1. Status at a glance

| Capability                                                |    Status     | One-line note                                                                                                                                                                  |
| --------------------------------------------------------- | :-----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace **create** (non-blocking, never times out)      |      ⚠️       | Setup off the hot path ✓, 30s budget ✓, setup-failure non-fatal ✓ — but **no abort/`provisioning`-state**; fetch bounded to **8s** (plan said ≤5s); file-copy still sync+fatal |
| **Setup tab** (background script, live output)            |      ✅       | Run/Rerun, ANSI output, status pill; rerun-race + stale-running-on-boot both handled                                                                                           |
| **Duplicate** (fork a new branch)                         |      ✅       | Calls create with `baseBranch:<source>` → new `zeros/<flower>`                                                                                                                 |
| **Open branch / Open PR** (attach PR + remote-only fetch) |      ✅       | "Use branch" attaches the existing PR; remote-only heads are fetched + tracked                                                                                                 |
| **Checked-out-elsewhere routing**                         |      ⚠️       | Pre-detects + routes to **Duplicate** + friendly toast — but **no Switch/Adopt resolution sheet** (D4 not built); `BRANCH_IN_USE` lacks `heldBy` context                       |
| **Open/add project speed** (no engine respawn)            |      ✅       | ~1s, Z-shimmer, no full-window veil, lean engine boot                                                                                                                          |
| **Project dedup** (canonical identity)                    |      ⚠️       | Engine `repos` writes canonicalize realpaths and renderer cache normalizes obvious aliases; no explicit "Already open" focus guard yet                                         |
| **Initialize Git** (non-git / no-commits)                 |      ✅       | Changes-tab panel + friendly create error; `initRepoInPlace` makes the initial commit                                                                                          |
| **Worktree base = `origin/<default>`**                    |      ✅       | Best-effort fetch (8s) → fork origin tip; local/offline fallback; explicit `git.base_branch` wins; persisted label is a plain branch name                                      |
| **Publish to GitHub**                                     |      ✅       | Local-only-repos only; inits non-git first; owner+orgs; name check; private toggle; sign-out no longer serves a stale client                                                   |
| **Changes tab**                                           | ✅ (reshaped) | Scope dropdown (All/Uncommitted/commit), flat+tree, **agent-driven git** (only Discard on hover), Initialize-Git panel, turn-filter, viewed-files flow; diffs open in row-1    |
| **Review / PR tab**                                       |      ✅       | Changes/Commits/Checks/Reviews, deploy cards, comment + Add-to-chat; **per-line comments + resolve-thread still deferred**                                                     |
| **Files tab + diff viewer + viewed flow**                 |      ✅       | Row-1 editable viewer (CodeMirror), Changes-Viewed flow                                                                                                                        |
| **Local main trunk**                                      |  🔁 editable  | Was read-only; **now a first-class editable workspace** (commit/stage/run agents all work)                                                                                     |
| **GitHub auth** (Settings → General → GitHub)             |      ✅       | gh-CLI auto-detect, paste PAT, device flow; token couriered engine-side                                                                                                        |
| **Chat diffs** (all adapters)                             |      ✅       | Adapter-agnostic extraction (snake/camel/unified-diff). Dead hover preview code was deleted in the 2026-06-30 cleanup; `tool-read.tsx` doesn't exist                           |
| **Git command coverage + Phase 0 correctness**            |      ✅       | ~22-command gap closed; C1/C4/C6 + flag-injection guard all in                                                                                                                 |
| **Terminal / worktree isolation**                         |      ✅       | cwd never falls back to main repo; env scrub; `workspaceId` threaded into PTY — but **PTY process-group kill still missing**                                                   |
| **Workspace Archive + History**                           |      ✅       | Always-succeeds restore (stash + `archived_head` anchor) — but **archive still doesn't stop live sessions/PTYs** (C7 open)                                                     |
| **Hunk-staging**                                          |      ⚠️       | Engine + IPC + native all done; **UI (line-select → patch) not built**                                                                                                         |
| **Web / relay**                                           |  🔁 removed   | Desktop-only loopback now; retired web/pairing source seams removed; generated Codex remote-control protocol remains upstream-owned                                            |

---

## 2. The model — locked decisions & architecture

### 2.1 Product model (locked decisions)

These were locked in the 2026-06-25 decision doc and remain in force, **except the trunk decision,
which was later reversed**:

- **D1 — Require "is a git repo", not GitHub.** 🔒 The blocker is git presence, not GitHub.
  Auto-offer `git init`; treat a **remote** as an enhancement that unlocks PR/Review/Publish + a
  fresher base branch. (Matches Conductor, which walked back its GitHub-first mandate; mandating
  GitHub would fix none of the bugs and exclude local-only/GitLab/self-hosted users.)
- **D2 — Three explicit support tiers** (see §2.4 matrix): git+GitHub (full), git-no-remote
  (degraded — PR/Review/Publish gated, never raw-failed), non-git (adopt-on-open with Initialize Git).
- **D3 — Never open the same folder twice; offer Duplicate.** 🔒 _partially shipped_ — canonical
  identity dedup now prevents symlink/root-string duplicates in the engine project table and
  renderer cache, but there is still no explicit "Already open" focus guard. See §5.
- **D4 — A branch checked out elsewhere is resolved, never raw-errored.** 🔒 _partially shipped_ —
  the picker pre-detects and routes to **Duplicate** with a friendly toast, but the planned
  three-action resolution sheet (**Switch / Duplicate / Adopt-in-place**) was **not** built.
- **D5 — "Duplicate" forks a new branch.** 🔒 ✅ shipped — `create({baseBranch:<source>})`.
- **D6 — Cross-tool: detect & co-exist, don't co-edit.** 🔒 Foreign (Conductor/Cursor/…) worktrees
  are detected + tagged; default action for a foreign checked-out branch is **Duplicate (fork)**,
  never a silent `git worktree add` of a branch held elsewhere.
- **D7 — Cloud-_run_ workspaces out of scope; cloud-_synced folders_ are just local folders.** 🔒
  (A `cloud-workspaces` Daytona spike exists but is inert unless `ZEROS_CLOUD_PORT` is set.)
- 🔁 **Reversed since the docs — "Local main" is no longer read-only.** PRs #74/#75 removed the
  `TRUNK_READ_ONLY` write-gate; the trunk is a full read+write target (`worktree.ts:464-469`). The
  earlier "main is read-only — Zeros runs agents in worktrees" model and its CTA are gone.

> **Open product question carried over (Q1):** D1 locks _git-required, GitHub-optional_ against the
> original instinct to mandate GitHub. If a stricter posture is ever wanted, the clean middle ground
> is a per-repo **"GitHub-only mode"** (hide local-only affordances), not a global hard requirement.

### 2.2 Architecture (current)

```
Renderer (src/zeros, src/shell)
  └─ native façade (src/native/git.ts)        workspaceCreate(), workspaceCreateFromBranch()…
       └─ bridge (src/zeros/bridge/*)          WORKSPACE_REQUEST over a LOCAL loopback WebSocket
            └─ ENGINE (src/engine, separate proc)  owns the SQLite DB + ALL git writes (single-writer)
                 └─ git worktree (src/engine/git)  git worktree add, fetch, hooks, setup PTY
```

- **Single-writer engine.** Every DB-touching git/workspace op runs on the engine over the bridge.
  The bridge is now a **local loopback only** — the E2EE relay + web/phone client were removed
  (#82); the old `isWebTarget()` source seam was removed in the 2026-06-30 cleanup.
- **RPC budget.** Default request budget is **10s**; the slow workspace ops were raised to **30s**:
  `create`, `createFromBranch`, `archive`, `restore` (`workspace-bridge.ts:330` et al.).
- **Worktree-per-agent.** Agents never edit the trunk's checkout _via a worktree row_; each workspace
  = a `git worktree` on a generated `zeros/<flower>-<hex>` branch, created
  `git worktree add -b <branch> <path> <baseRef>` (`worktree.ts:280-287`). (The trunk itself is now
  _also_ an editable target, but it's the repo root, not a per-agent worktree.)
- **Base branch.** With a remote: best-effort `git fetch` (**8s**, `default-branch.ts:71-78`) then
  fork from `origin/<default>`. No remote / offline: fork from local default/HEAD. An explicit
  caller `baseBranch` is used verbatim and **skips the fetch** (`worktree.ts:153-156`). An explicit
  `git.base_branch` repo setting wins over the remote default (`worktree.ts:166-169`). The persisted
  `baseBranch` is always a **plain branch name**; only `baseRef` carries `origin/…`.
- **Setup is non-blocking.** `createWorkspace` only _resolves_ the setup command and returns; the
  engine starts it in a **worktree-scoped background PTY after the reply** (`index.ts:2258-2272`),
  tracked by a separate `setupState: running|passed|failed` field (`types.ts:16-20`). A slow
  `pnpm install` no longer blocks or times out create.
- **Cross-tool aware.** `cross-tool.ts` detects worktrees/branches made by Cursor / Conductor /
  Superset / workmux (marker files + name heuristics) and surfaces them with a tool tag.

### 2.3 Workspace lifecycle (states)

`WorkspaceStatus = draft | active | in-review | merged | archived` (`types.ts:7-12`).

> ⚠️ Note vs the 2026-06-25 plan: the plan proposed a `provisioning → ready / setup-failed` status
> machine to gate usability during setup. That was **not** built. Instead, create returns `"draft"`
> immediately and background setup is tracked by the **independent** `setupState` field. The
> non-blocking goal is met; the lifecycle gating is not.

### 2.4 Support matrix (what to tell users)

| Capability                               | R1: git + GitHub remote |       R2: git, no remote        |    R3: non-git folder     | R4: foreign worktree (Conductor/Cursor) |
| ---------------------------------------- | :---------------------: | :-----------------------------: | :-----------------------: | :-------------------------------------: |
| Add to sidebar                           |           ✅            |               ✅                |  ✅ (offer **Init Git**)  |     ✅ (adopt at its main checkout)     |
| Run agent / chat in root                 |           ✅            |               ✅                |            ✅             |                   ✅                    |
| **Local main trunk** (commit/stage/diff) |       ✅ editable       |           ✅ editable           |    ⛔ → Initialize Git    |                   ✅                    |
| **+ New workspace (worktree)**           |           ✅            |      ✅ (forks local base)      |     ⛔ until Init Git     |         ✅ (on the parent repo)         |
| Changes tab                              |           ✅            |               ✅                | ⛔ → Initialize-Git panel |                   ✅                    |
| **Open / Duplicate a branch**            |           ✅            |               ✅                |            ⛔             |    ✅ (Duplicate / fork; no co-edit)    |
| **Create / open a PR, Review**           |   ✅ (GitHub authed)    | 🔒 "Connect a remote / Publish" |            🔒             |    ✅ if parent has a GitHub remote     |
| Publish to GitHub                        |  n/a (already remote)   |               ✅                |     ✅ (inits first)      |                   n/a                   |

✅ supported · 🔒 gated with a clear upgrade CTA · ⛔ blocked with an inline reason (never a raw error)

**Explicitly NOT supported in v1:** running the engine in the cloud; non-GitHub _Publish_
(GitLab/Bitbucket create) — a non-GitHub _remote_ still works for everything except Publish/Review;
two tools editing the **same branch** concurrently (we fork instead). Web/phone clients (removed).

---

## 3. Feature surface (current, consolidated)

### 3.1 Workspace create — reliable & non-blocking ⚠️

- Returns as soon as the worktree + DB row exist; **setup runs in the background** (§2.2). Setup
  failure keeps the workspace (`setup-runner.ts:152-154`); the old "setup failure rolls back the
  whole workspace" behavior is gone. RPC budget raised to 30s.
- **Open gaps (carried forward):** fetch is 8s not ≤5s; **no AbortController** so a client-side
  timeout still cannot trigger `safeRollback` (orphan risk is _reduced_ by the faster reply + larger
  budget, not eliminated); file-copy still runs synchronously inside create and is fatal on an
  explicit `copyPaths`/`symlinkPaths` failure (`worktree.ts:344-357`); no `provisioning` state.
- Friendly guards: not-a-repo → `NOT_A_REPO`; **no-commits (unborn HEAD)** → actionable
  "Initialize Git" message, not a cryptic `rev-parse` failure (`worktree.ts:216-222`).

### 3.2 Setup tab ✅ — `src/shell/column3-tabs/setup-tab.tsx`, `setup-runner.ts`, `setup-hooks.ts`

- Row-2 tab, sits immediately before Terminal: **All Files · Changes · Review · Setup · [Terminal ▾] · +**
  (`source-views.ts:19-24`). Opens by default while setup is running.
- Live **ANSI-colored** output in a read-only xterm, delta-appended, **polled ~900ms** while running.
  Status pill: **Running… → Setup complete / Setup failed**. **Run / Rerun setup** buttons.
- Empty states: "No setup command configured" (+ hint to add `scripts.setup`); trunk shows
  "No setup for the trunk."
- **Rerun race handled** — each run gets a monotonic `gen`/session id; a superseded run's late exit
  can't mislabel the new run (`setup-runner.ts:130-148`).
- **Stale-running reconcile** — `reconcileStaleRuns()` on engine boot clears any row stuck "running"
  from a killed process (`setup-runner.ts:77-87`, called `index.ts:927`), so the tab never spins
  forever.
- Buffer is **in-memory** (512 KB): after an engine restart the _state_ persists but the _scrollback_
  is gone — Rerun to repopulate.

### 3.3 Duplicate ✅ — `create-from-picker.tsx:219-252`

- "Duplicate" forks a **new** `zeros/<flower>` branch from the source branch's tip via
  `workspaceCreate({ repoRoot, repoSlug, baseBranch: <sourceBranch> })`. Carries committed work
  (incl. local-only commits), **not** the source's uncommitted edits. Works offline (no fetch).

### 3.4 Open branch / Open PR ✅ — `create-from-picker.tsx`, `cross-tool.ts`

- **Open** a `zeros/*` branch that's already a workspace → switches to it (no new worktree).
- **Use branch** on a PR → creates a worktree on the PR's head branch **and attaches the existing
  PR** (workspace flips to `in-review`, `prNumber`/`prUrl` set) so the Review tab loads it instead
  of offering a duplicate "Create draft PR" (which would 422) (`cross-tool.ts:237-390`).
- **Remote-only PR head** → fetches just that branch (bounded 20s) and creates a local tracking
  branch via `git worktree add --track -b <branch> <path> origin/<branch>` (`cross-tool.ts:283-307`).

### 3.5 Checked-out-elsewhere routing ⚠️ — `create-from-picker.tsx`

- The picker computes `isCheckedOut`/`worktreePath` per branch (`cross-tool.ts:198-232`) and routes
  **before** creating: a foreign checked-out branch shows **Duplicate only**; an in-use PR head
  routes to Duplicate; in-use branch rows show a "· in use" hint.
- `BRANCH_IN_USE` + `WORKSPACE_ALREADY_EXISTS` surface as **friendly toasts** with remediation
  (`create-from-picker.tsx:186-197`), not raw git strings.
- **Differs from plan (D4):** there is **no resolution sheet** offering Switch / Duplicate /
  Adopt-in-place. `adoptExistingWorktree` exists in the engine (`cross-tool.ts:423-509`) but is only
  surfaced from the add-local-project flow, not the in-use-branch picker. `BRANCH_IN_USE` carries the
  code but not a populated `context.heldBy`.

### 3.6 Open / add project — fast, no respawn ✅

- Adding a repo is ~1s with a branded **"Z" shimmer** (`ZerosSpinner`); **no engine respawn**
  (the add path uses `pickProjectFolder` which only shows the dialog + returns the path —
  `sidecar.ts:55-66`); registration happens over the bridge (`upsertProject`); the full-window
  "Loading workspaces…" veil is pre-suppressed for the new slug (`use-projects.ts:265-280`).
- Lean engine boot: the dead CSS index is skipped (`DESIGN_SURFACE_ENABLED = false`,
  `index.ts:149`) — no "Index built" line.
- ⛔ **Dedup is NOT canonical** — still exact-string `repoRoot` (`projects-store.ts:197`,
  `db/projects.ts:146`); a symlink / `/var`↔`/private/var` / trailing-slash / case difference makes
  a duplicate project. No "Already open" focus. The `bind-folder.ts:23-29` unguarded second
  open-folder entry is still present. (See §5.)

### 3.7 Initialize Git (non-git / no-commits) ✅ — `changes-tab.tsx`, `init-clone.ts`, `github.ts`

- The Changes tab inspects the folder (`workspaceInspectFolder`) and, for a non-git folder **or** a
  git repo with **zero commits**, renders a **"Repository needs initializing"** panel with
  **Initialize Git** / **Publish to GitHub** — never the raw `git diff HEAD failed`.
- **Initialize Git** → `initRepoInPlace` git-inits if needed + makes an **Initial commit**; "+ New
  workspace" then works.

### 3.8 Worktree base branch = `origin/<default>` ✅ — `resolveWorktreeBase` (`worktree.ts:150-186`)

- Remote present → fetch (8s) → fork `origin/<default>`. No remote / offline → local default/HEAD.
  Explicit `git.base_branch` repo setting wins. Explicit caller `baseBranch` verbatim + skip fetch.
  Persisted base label is plain (`main`, not `origin/main`); exported as `ZEROS_BASE_BRANCH`.

### 3.9 Publish to GitHub ✅ — `publish-to-github.tsx`, `quick-start.tsx`, `github.ts`

- Per-project **Publish** button shown **only for local-only repos** (`!originUrl`). Publishes a
  remoteless git repo; **git-inits a non-git folder first**. Owner dropdown lists **user + orgs**
  (`createInOrg`); **repo-name availability** check (debounced); **Private** toggle (default on).
- Quick Start "Create private GitHub repo" toggle (default on) chains into the Publish dialog
  pre-filled; unchecked → local-only, Publish button appears afterward.
- **Sign-out fix:** `getOctokit()` re-checks the token store every call and clears the cache on
  sign-out (`github.ts:128-159,347-364`) — a publish/`gh.*` attempt after Settings→GitHub Sign out
  now fails cleanly instead of serving a stale authed client.

### 3.10 Changes tab ✅ (reshaped) — `src/shell/column3-tabs/changes-tab.tsx`

**The shape changed substantially since the 2026-06-02 doc** (#69/#72/#73):

- **Scope dropdown** replaces the old base-branch comparison dropdown: **All changes** (committed +
  uncommitted vs fork point) / **Uncommitted** / a specific recent commit. Default = All changes.
- **Flat + folder-tree** views (toggle). Per-file status glyph + `+N −M` counts.
- **Git is agent-driven** — there is **no commit footer** and **no manual stage/unstage buttons**;
  the only per-row hover action is **Discard** (in All scope, non-trunk). Stage/unstage/commit/push
  are expected to be agent-run.
- **No inline diff pane** — clicking a file opens it in the **row-1 viewer** (see §3.12).
- **Initialize-Git panel** for non-git / no-commits (§3.7).
- **Turn-filter** dropdown (filter the list to one agent turn's authored files) and a **viewed-files
  flow** (row dimming / auto-advance / auto-unmark).
- Per-file lifecycle color (grey uncommitted → green/gold/red committed) in one mixed list.

### 3.11 Review / PR tab ✅ — `src/shell/column3-tabs/review-tab.tsx`

- Sub-tabs: **Changes** (file list + diff) · **Commits** (list + per-commit diff) · **Checks**
  (pass/fail/pending rows + **deploy-preview cards** with URLs) · **Reviews** (timeline + verdict
  badges + **Add to chat** + a repo-level comment box).
- PR header: state badge (Draft/Open/Merged/Closed), `head → base · #number`, Open-on-GitHub,
  **Mark ready** (draft) / **Merge ▾** (squash/merge/rebase).
- No-PR state → "Create draft PR"; not-authed/no-remote → "Connect GitHub in Settings".
- ⛔ **Still deferred:** per-line inline PR comments + "Resolve conversation" (needs GitHub GraphQL).

### 3.12 Files tab + diff viewer + viewed flow ✅

- Row-1 file viewer is an **editable CodeMirror** source view with a unified code-theme picker
  (#75/#76); the **Changes-Viewed** flow tracks which changed files you've reviewed. Files/git work
  for a **non-rooted** repo's trunk on desktop (routes through the bridge).

### 3.13 Local main trunk — first-class editable 🔁 (was read-only)

- The trunk ("Local main") is a full read+write git target — status/diff/log **and**
  commit/push/pull/stage/discard, exactly like any worktree (`worktree.ts:464-469`; proven by
  `worktree.test.ts:198`). The Changes/Files tabs pass `readOnly={false}` for it; the old
  "main is read-only" CTA and composer-replacement are **gone**. You can run an agent on Local main.
- The `isKnownRepoRoot` clamp remains — a **security** clamp (only repos the owner opened), not a
  read-only gate.
- _Vestigial:_ the `readOnly?` prop still exists on `ChangesView`/`FileViewer` but every caller
  passes `false`; behavior is editable.

### 3.14 GitHub auth (Settings → General → GitHub) ✅ — `src/zeros/panels/github-section.tsx`

- Three paths: **gh CLI auto-detect** (`gh auth token` → adopt), **paste PAT** (show/hide eye),
  **device flow** (inline user-code + verification URL). Token is couriered engine-side
  (single-writer); the durable copy lives in the OS keychain.

### 3.15 Chat diffs (all adapters) ✅ — `tool-edit.tsx`

- Adapter-agnostic diff extraction: reads snake_case (`old_string`/`new_string`) **and** camelCase
  (`oldString`/`newString`), MultiEdit `edits[]`, **and** reconstructs before/after from a unified-
  diff patch (Codex/Droid apply-patch) → all agents render a real diff, not just a filename.
- ✅ **Cleanup note:** orphaned `hover-preview.tsx` (`CardHoverPreview`) was deleted in the
  2026-06-30 cleanup. There is **no `tool-read.tsx`** (Read cards render via the generic event-row
  path). The 2026-06-02 doc's "hover preview on Edit/Read cards" is **not wired**.

### 3.16 Git command coverage + Phase 0 correctness ✅

- **Coverage:** the ~22-command gap is closed — generalized diff (worktree/index/head/3-dot
  base/refs + raw patch + show-commit), conflict surfacing (`status.conflicted[]` + `conflictState`),
  reset (soft/mixed/hard), discard/restore/clean, merge/cherry-pick/revert, continue/abort,
  stash list/apply/drop, deleteBranch, tags. Destructive ops (`reset --hard`, `clean`) require
  explicit `confirm:true`.
- **Phase 0 fixes (all present):** C1 NUL-delimited `-z` status parsing (`porcelain.ts`) → paths
  with spaces/non-ASCII/renames are correct; C4 `archiveWorkspace` stash uses `--include-untracked`
  (`worktree.ts:527-541`) so untracked files survive; C6 3-dot `base...HEAD` diff (`diff.ts`) so a
  base-branch advance no longer renders as deletions; C5 branch read via `rev-parse --abbrev-ref`
  (no false failure after commit / on detached HEAD); **flag-injection guard** `assertSafeGitRef`
  rejects `-`-leading refs across merge/checkout/reset/restore/cherry-pick/revert (`git-exec.ts:50-71`).

### 3.17 Terminal / worktree isolation ✅

- Terminal cwd never falls back to the main repo ($HOME fallback + tracked-worktree allow-list);
  `PWD`/`OLDPWD` scrubbed; `ZEROS_WORKTREE_PATH` / `ZEROS_WORKSPACE_ID` injected; **`workspaceId`
  threaded into PTY spawn** (`index.ts:1409,1451-1452`) for `pty_list` scoping; PTY reap on quit is
  synchronous. Agents edit files only in their own worktree (verified across adapters); a deleted
  worktree fails loud, not silently in the wrong tree.
- ⛔ **Still missing:** PTY **process-group kill** (SIGTERM→SIGKILL escalation, `killpg`) — a
  dev-server's grandchildren can reparent to launchd on quit.

### 3.18 Workspace Archive + History ✅ (newer than the docs, #87)

- **Archive** parks a workspace as a DB row (`status:"archived"`) + branch ref + a
  `git stash push --include-untracked` SHA + an **`archived_head`** recovery anchor, then removes the
  folder. It drops out of the sidebar into a full-window **History page** (`history-page.tsx`,
  day-bucketed, filter + per-row Unarchive).
- **Restore "always succeeds":** reclaims the original path, forks a sibling path if it's taken,
  recreates a deleted branch from `archived_head`, re-applies the stash, and re-runs setup in the
  background. Stale chat cwds self-heal on restore.
- ⛔ **C7 still open:** archive/delete does **not** stop live agent sessions or kill PTYs rooted in
  the worktree before removing it (`worktree.ts archive path` has no PTY/session teardown). Restore
  self-heals cwd, but archive-time coordination is absent.

### 3.19 Hunk-staging ⚠️

- **Engine + IPC + native all done:** `stageHunk`/`unstageHunk`/`discardHunk` via
  `git apply [--cached] [--reverse]` on stdin (`stage.ts:80-105`), bridge fns + service handlers +
  `native/git.ts` `Hunk` type.
- ⛔ **UI not built:** no `@pierre/diffs` line-selection → single-hunk-patch wiring; no `.tsx` calls
  the hunk bridge fns.

---

## 4. Failures that were fixed (root-cause → resolution)

The 2026-06-25 audit found four reproductions (F1–F4) plus cross-cutting gaps (F5). Condensed
status:

| #       | Symptom                                                                         | Root cause                                                                                                               | Resolution status                                                                                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1**  | `Request timeout: WORKSPACE_REQUEST` on create + an orphaned half-made worktree | Synchronous `git fetch` (20s) + `scripts.setup` (5-min) ran **inside** a 10s RPC; no abort → orphan persists             | ⚠️ **Mostly fixed.** Setup moved to a background PTY after reply; setup-failure non-fatal; fetch → 8s; RPC → 30s. **Not done:** AbortController + post-timeout reconcile (orphan reduced, not eliminated); no `provisioning` state; file-copy still sync+fatal |
| **F2**  | `A workspace for branch "…" already exists (status=draft)` on "Duplicate"       | "Duplicate" called create-for-this-exact-branch (refused by the C10 guard)                                               | ✅ **Fixed.** "Duplicate" forks a new branch via `create({baseBranch})` (D5)                                                                                                                                                                                   |
| **F3**  | `git worktree add … general-work failed`                                        | The branch was already checked out by a Conductor worktree; git forbids two checkouts; Zeros tried `worktree add` anyway | ✅/⚠️ **Routed, not raw-errored.** Picker pre-detects + routes to Duplicate. **Not done:** the Switch/Adopt resolution sheet (D4)                                                                                                                              |
| **F4**  | Raw git error in a toast                                                        | The `BRANCH_IN_USE`/`WORKSPACE_ALREADY_EXISTS` recovery UI was never built                                               | ⚠️ **Friendly toasts** with remediation shipped; the full resolution **dialog** still not built; `BRANCH_IN_USE` lacks `heldBy` context                                                                                                                        |
| **F5a** | Duplicate project rows                                                          | Exact-string dedup only — symlink/`/var`/case/trailing-slash all fragment                                                | ⛔ **Not fixed.** Canonical-identity dedup (D3) unimplemented; `bind-folder.ts` bypass still open                                                                                                                                                              |
| **F5b** | Non-git / no-commits folder runtime toast                                       | `createWorkspace` threw `NOT_A_REPO` / cryptic `rev-parse`; no pre-check                                                 | ✅ **Fixed.** Initialize-Git panel + friendly create error (§3.7)                                                                                                                                                                                              |
| **F5c** | No-remote repo silently breaks PR/Review                                        | Review gated only on GitHub _auth_, not remote presence                                                                  | ✅ **Gated.** Review shows "Connect a GitHub remote / Publish" instead of a failing create                                                                                                                                                                     |

---

## 5. Known gaps & deferred work (consolidated)

Merges the old "pending tasks" lists, the un-shipped parts of the fix plan, and the audit deviations.
Status as of `430b6c54`.

| Item                                                        |    Status    | Detail                                                                                                                                                                                                    | Effort |
| ----------------------------------------------------------- | :----------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----: |
| **Canonical-identity project dedup (D3 / P1.4)**            |      ⛔      | Highest-value open gap. Implement realpath(`show-toplevel`) + `git-common-dir` (st_dev/st_ino fallback); re-open → focus existing + "Already open" + "Duplicate"; close the `bind-folder.ts:23-29` bypass |   M    |
| **Create abort-awareness (F1.c)**                           |      ⛔      | Thread the request's abort so a client timeout triggers `safeRollback`; renderer reconciles vs `workspace.list` before re-create. (No `provisioning` state was added either)                              |   M    |
| **Resolution sheet — Switch / Duplicate / Adopt (D4 / F4)** |      ⛔      | Build the three-action sheet; carry `context.heldBy` on `BRANCH_IN_USE`; surface engine `adoptExistingWorktree` from the picker                                                                           |   M    |
| **C7 — archive/delete ↔ live session coordination**         |      ⛔      | On archive/delete, end live agent sessions + kill PTYs rooted in that worktree before removing it                                                                                                         |   M    |
| **Hunk-staging UI**                                         |      ⛔      | Engine+IPC done; wire `@pierre/diffs` line-selection → single-hunk patch → `stageHunk`/`discardHunk`                                                                                                      |   M    |
| **Per-line PR comments + resolve-thread**                   |      ⛔      | Needs GitHub **GraphQL** review-thread API; Review tab has the timeline + a top-level comment box only                                                                                                    |  M–L   |
| **E.4 auto branch-rename**                                  |      ⚠️      | Engine + bridge exist (`rename-hook.ts`, `workspace.proposeBranchName`) but **not wired into `sendPrompt`** — no caller renames `zeros/<flower>` → semantic on the first prompt                           |   S    |
| **PTY process-group kill**                                  |      ⛔      | SIGTERM→SIGKILL escalation / `killpg` so dev-server grandchildren don't reparent to launchd                                                                                                               |   S    |
| **Detach (C2/C8)**                                          | ⛔ (dormant) | `detach.ts` + bridge + service all exist; **zero UI** calls them — fix the concurrency mutex + read-only `detachStatus` before a detach pill ships                                                        |   M    |
| **File-copy off the create reply (F1.b)**                   |      ⚠️      | Setup _script_ is async; file copy/symlink still runs synchronously in create and is fatal on explicit paths                                                                                              |   S    |
| **Hot-path fetch ≤5s (F1.a)**                               |      ⚠️      | Currently 8s (plan asked ≤5s); already best-effort with a local fallback                                                                                                                                  |   S    |
| **Foreign-worktree adopt UX (D6 / P2.8)**                   |      ⛔      | Finish adopt-in-place with the co-edit warning; surface "this branch is live in Conductor" inline                                                                                                         |   M    |
| **Orphan / stale-worktree reconciliation (P1.7)**           |      ⛔      | `git worktree prune` + drop dangling DB rows on engine start / create-failure; surface `prunable`/`locked`                                                                                                |   M    |
| **Worktree maintenance (P2.9)**                             |      ⛔      | `git worktree repair` action for moved repos; lock/unlock awareness                                                                                                                                       |   S    |
| **Write-card before/after**                                 |      ⛔      | Write tool-cards render all-additions; would read pre-write content via `read_file`                                                                                                                       |   S    |
| **`hover-preview.tsx` dead code**                           |      ✅      | Deleted in the 2026-06-30 cleanup                                                                                                                                                                         |   S    |
| **Web/relay dead-code purge (Phase 2 of #82)**              |      ✅      | App-owned `web-target.ts`, web pickers, pairing module, and `isWebTarget()` source call-sites removed; generated Codex remote-control protocol untouched                                                  |   M    |

---

## 6. Test plan

### 6.1 Automated suite

| What                          | Command                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| Engine/UI test suite (vitest) | `pnpm test:git` (= `vitest run --config vitest.config.ts`) |
| Watch mode                    | `pnpm test:git:watch`                                      |
| Build (renderer)              | `pnpm build:ui` (`vite build`)                             |
| Build (engine)                | `pnpm build:engine` (`codegen-codex.mjs && tsup`)          |
| Typecheck (all)               | `pnpm typecheck` (app + electron + packages)               |
| Lint                          | `pnpm lint` (`eslint src electron`)                        |
| UI-consistency guard          | `pnpm check:ui`                                            |
| Preload-allowlist guard       | `pnpm check:preload`                                       |

- **One** vitest config (`vitest.config.ts`); despite the `test:git` name it now covers the whole
  suite (node env, `pool:"forks"`, 20s timeout) across ~30 `__tests__` globs.
- **Current scale (cheap estimate, not a full run):** ~**1,500 test cases across ~150 files**
  (trajectory in the old docs: 533 → 1175 → 1550). The git layer alone is ~**268 cases / 27 files**
  under `src/engine/git/__tests__/`.
- **Git `__tests__` coverage areas:** `branch`, `cleanup`, `cross-tool`, `detach` +
  `detach-checkpoint`, `diff` + `diff-parse`, `files-to-copy`, `gateway-cwd`, `git-exec`, `github`,
  `naming`, `ops`, **`phase0-fixes`**, **`phase1-coverage`**, `publish-github`, **`ref-guard`**,
  `rename-hook`, `repo` + `repo-scripts`, **`setup-runner`**, `stage`, `state`, `turns-git`,
  `workspace-files`, `worktree` + `worktree-seed`. _(There is no `porcelain.test.ts`; the C1 NUL-
  parsing is covered under `diff-parse` / `git-exec` / `phase0-fixes`.)_

> ✅ in the manual cases below = there is automated coverage behind it; 🧪 = manual-only.

### 6.2 Manual QA — prerequisites & fixtures

- A **dev build** running: `pnpm electron:dev`. Keep the terminal visible — watch `[engine]` lines.
- **GitHub signed in** (Settings → General → GitHub; `gh auth status` healthy) — for PR + Publish.
- Prepare fixtures up front:
  - **R1 — GitHub repo (has remote):** clone a private repo you own with a few PRs/branches. Add a
    setup script so the Setup tab has something to run: in `<repo>/.zeros/settings.toml` →
    `[scripts]`/`setup = "pnpm install"` (or `npm install`).
  - **R2 — local git, NO remote:** `mkdir -p ~/qa/r2 && cd ~/qa/r2 && git init -b main && echo hi > README.md && git add . && git -c user.email=a@b -c user.name=a commit -m init`
  - **R3 — non-git folder:** `mkdir -p ~/qa/r3 && echo "console.log(1)" > ~/qa/r3/index.js`
  - **R4 — git repo with NO commits ("Playground"):** `mkdir -p ~/qa/r4 && cd ~/qa/r4 && git init -b main` _(do NOT commit)_
  - **R5 — a repo also opened in Conductor** (so a branch like `general-work` is checked out by a
    Conductor worktree), with ≥1 open PR on that branch.
  - **R6 — a second GitHub repo** (clone elsewhere) for "non-rooted repo" tests. The **first** repo
    opened becomes the engine root; every other repo exercises the no-respawn / non-rooted paths.

### 6.3 Manual QA — functional & UI cases

#### A — Workspace create (reliable, non-blocking)

- ☐ **A.1** R1 (with `scripts.setup`) → **+ New workspace** → row appears in **~1s**; does NOT wait
  for the install. **Regression:** the toast `Couldn't create workspace: Request timeout:
WORKSPACE_REQUEST` must **not** appear. ✅🧪
- ☐ **A.2** Wi-Fi **off** → **+ New workspace** on R1 → creates quickly from the last-fetched
  `origin/main` (cached), no hang. 🧪
- ☐ **A.3** R2 (local-only) → **+ New workspace** → creates from local `main`; no fetch, no error. ✅🧪
- ☐ **A.4** Kill create mid-flight (force-quit during a long setup) → relaunch → confirm there's no
  orphaned half-made worktree lingering in the picker. _(Known gap: no abort/reconcile — flag any
  orphan you see.)_ 🧪

#### B — Setup tab

- ☐ **B.1** Open a workspace → row-2 strip reads **All Files · Changes · Review · Setup · [Terminal ▾] · +**;
  Setup sits immediately before Terminal. ✅🧪
- ☐ **B.2** R1 setup → Setup tab opens by default, shows **live ANSI-colored** output, pill goes
  **Running… → Setup complete**. 🧪
- ☐ **B.3** A repo with `setup = "exit 7"` → workspace is **created and kept** (not rolled back);
  Setup tab shows **Setup failed** + a **⟳ Rerun setup** button. **Regression:** failure must NOT
  delete the workspace. ✅🧪
- ☐ **B.4** Click **Rerun** while a slow setup is still **Running** → status **stays Running** for
  the new run (no flicker to "failed" from the killed run). ✅🧪 (`setup-runner` gen-guard)
- ☐ **B.5** Start a long setup → **⌘Q** mid-install → relaunch → that workspace's Setup tab does
  **NOT** spin "Running…" forever (stale-running reconciled on boot); empty state w/ **Run setup**. ✅🧪
- ☐ **B.6** Workspace with no `scripts.setup` → "No setup command configured" + hint; trunk → "No
  setup for the trunk." ✅🧪

#### C — Duplicate

- ☐ **C.1** Picker → Branches → a `zeros/*` row → **Duplicate** → a new workspace on a new
  `zeros/<flower>` branch opens. **Regression:** must NOT error `A workspace for branch "…" already
exists (status=draft)`. ✅🧪
- ☐ **C.2** Workspace A on `zeros/foo` with 1 committed + 1 uncommitted change → Duplicate → the
  duplicate has the **committed** change but **not** the uncommitted edit. ✅🧪
- ☐ **C.3** Wi-Fi off → Duplicate any branch → works (forks the local tip). 🧪

#### D — Open branch / Open PR

- ☐ **D.1** Picker → Pull requests → a PR whose head is your Zeros workspace → **Open** → switches
  to it (no new worktree). 🧪
- ☐ **D.2** PR whose head is **not** a workspace and **not** checked out elsewhere → **Use branch**
  → a worktree is created **and the Review tab immediately shows that PR**. **Regression:** must NOT
  show "No pull request yet → Create draft PR". 🧪 _(Fix A core)_
- ☐ **D.3** R5 — a PR on `general-work` that Conductor holds → the row's action is **Duplicate** and
  it succeeds. **Regression:** must NOT show `git worktree add … general-work failed` /
  `BRANCH_IN_USE`. Branch rows for an in-use branch show a **"· in use"** hint. ✅🧪
- ☐ **D.4** **Remote-only PR** (teammate's head branch exists only on origin) → **Use branch** →
  fetches the branch, creates a local tracking branch + worktree, attaches the PR. **Regression:**
  must NOT error "Branch … does not exist." 🧪 **(main thing to verify — no automated coverage)**
- ☐ **D.5** Friendly errors: any in-use / already-exists branch op guides you ("already checked out
  by another tool — use Duplicate" / "a workspace for this branch already exists — open it instead"),
  not a raw git string. ✅🧪

#### E — Open / add project (speed, dedup)

- ☐ **E.1** Sidebar **+ → Open project** → pick R1 → row appears in **~1s** (not 30s) with the
  branded **Z-shimmer**; no full-window "Loading workspaces…" veil; **engine log shows NO**
  `Shutting down` / `Starting engine` / `ignored SIGTERM` (no respawn). ✅🧪
- ☐ **E.2** **⌘O** → pick R6 → same fast path, no respawn. 🧪
- ☐ **E.3** From the empty/welcome state → **Open project** → R1 → fast resolve. 🧪
- ☐ **E.4** Re-open an already-registered repo (R1 again) → no duplicate row, no error. 🧪
  _(⚠️ Known gap: dedup is exact-string. Test the **same** path; a symlinked/`/private/var`/
  trailing-slash variant of R1 WILL currently create a duplicate — note it if you try.)_
- ☐ **E.5** Engine boot is lean — **no** `Index built: N selectors …` line; "ready" in <1s. ✅🧪
- ☐ **E.6** Quit (⌘Q) with an agent/Codex session active → shutdown completes ≤~3s; ideally no
  `ignored SIGTERM; SIGKILLed`. 🧪

#### F — Initialize Git (non-git / no-commits)

- ☐ **F.1** Add **R4** (git init, no commits) → **Changes** tab → shows **"Repository needs
  initializing"** + **Initialize Git** / **Publish** — NOT a raw `git … diff … HEAD failed`. Click
  **Initialize Git** → makes an Initial commit; panel clears; **+ New workspace** now works. ✅🧪
  **(the reported case)**
- ☐ **F.2** On R4 (before init) click **+ New workspace** → toast "…this repository has no commits
  yet — open the Changes tab and click Initialize Git…". **Regression:** NOT the cryptic
  `git rev-parse --abbrev-ref HEAD failed`. ✅🧪
- ☐ **F.3** Add **R3** (non-git) → Changes → **Initialize Git** → `git init` + initial commit; then
  **+ New workspace** works. ✅🧪

#### G — Worktree base branch (`origin/<default>`)

- ☐ **G.1** Make R1's local `main` behind origin (clone elsewhere, push a `remote-only.txt`) →
  **+ New workspace** → the worktree **contains `remote-only.txt`** (forked from fetched
  `origin/main`). ✅🧪
- ☐ **G.2** R2 (no remote) → **+ New workspace** → forks local `main`; no fetch attempted. ✅🧪
- ☐ **G.3** Wi-Fi off → **+ New workspace** on R1 → still creates (local fallback), no multi-second
  hang. 🧪
- ☐ **G.4** Set `git.base_branch = "<other>"` (repo settings / `.zeros/settings.toml`, branch exists
  on remote) → **+ New workspace** → forks **that** branch's remote tip. ✅🧪
- ☐ **G.5** After G.1, the Changes-tab scope/base label shows a **plain** branch name (`main`),
  never `origin/main`. ✅🧪

#### H — Publish to GitHub

- ☐ **H.1** Hover the **R2** (no remote) sidebar row → a **Publish to GitHub** button appears next
  to the gear. Hover **R1** (has remote) → **no** Publish button. 🧪
- ☐ **H.2** R2 → **Publish** → Owner = your login, Private on → **Create repo and publish** → toast
  "Published to `<owner>/<name>`"; a **private** repo with R2's history exists; `git remote -v` shows
  `origin`; the Publish button disappears for R2. ✅🧪
- ☐ **H.3** R3 (non-git) → **Publish** → R3 is git-init'd (Initial commit) + repo created + pushed. ✅🧪
- ☐ **H.4** Publish dialog → Owner dropdown lists **your login** then **orgs** ("(org)"); picking an
  org lands it under the org (`createInOrg`). ✅🧪
- ☐ **H.5** Type a name that **exists** → inline "That repository already exists." + Create disabled;
  a free name → "Repository name is available." + Create enabled. ✅🧪
- ☐ **H.6** Private **off** → publish a throwaway → the repo is **public** (then delete it). 🧪
- ☐ **H.7** Quick Start with "Create private GitHub repo" **checked** (default) → Publish dialog
  opens pre-filled → completes → private repo created + pushed. 🧪
- ☐ **H.8** Quick Start **unchecked** → local repo only; no Publish dialog; the Publish button
  appears on the project afterward. 🧪
- ☐ **H.9** **Sign out** via Settings → General → GitHub (NOT `gh auth logout`) → open Publish →
  clear "Sign in to GitHub in Settings first." (no crash); owners don't load. **Regression guard:**
  a publish attempt while signed out must **fail** (no stale authed client). ✅🧪

#### I — Changes tab (current shape)

- ☐ **I.1** Sub-nav shows `Changes (count)` matching the number of changed files + refresh. 🧪
- ☐ **I.2** **Scope dropdown** offers **All changes** / **Uncommitted** / recent commits; switching
  re-scopes the list. ✅🧪
- ☐ **I.3** **Flat ↔ tree** toggle; tree shows nested collapsible folders; long paths truncate. 🧪
- ☐ **I.4** File rows show status glyph (A/M/D/R/U/!) + `+N −M`; **hover → Discard** (All scope,
  non-trunk) reverts the file on disk. **There is NO commit footer and NO manual stage/unstage**
  (git is agent-driven). ✅🧪
- ☐ **I.5** Click a file → it opens in the **row-1 viewer** (no inline diff pane in this tab). 🧪
- ☐ **I.6** **Turn-filter** dropdown narrows the list to one agent turn's authored files; the
  **viewed-files** flow dims/auto-advances reviewed rows. 🧪
- ☐ **I.7** Path with a **space** (e.g. `my file.txt`) appears + diffs correctly (C1). ✅🧪
- ☐ **I.8** **Rename** a tracked file → shows as renamed old→new (C1). ✅🧪
- ☐ **I.9** Theme: colors/spacing match the design system; `@pierre/diffs` colors in the row-1
  viewer match the chat-card diff colors. 🧪

#### J — Review / PR tab

- ☐ **J.1** No PR → "Create draft PR" → PR header appears. 🧪
- ☐ **J.2** **Changes** sub-tab → PR file list + diff. **Commits** → list → click → commit diff. 🧪
- ☐ **J.3** **Checks** → CI rows + **deploy-preview cards** with URLs (use a PR with CI/Cloudflare). 🧪
- ☐ **J.4** **Reviews** → review/comment timeline w/ verdict badges; post a comment; **Add to chat**
  drops the text into the composer. 🧪
- ☐ **J.5** **Mark ready** (draft) / **Merge ▾** (squash/merge/rebase) act on the real PR. 🧪
- ☐ **J.6** No-remote / not-authed → Review shows "Connect a GitHub remote / Publish" / "Connect
  GitHub in Settings", never a raw failure. ✅🧪

#### K — Files tab + diff viewer + viewed flow

- ☐ **K.1** Select R6's Local main → **Files** tab → the tree lists files; the row-1 viewer shows
  content (routes through the bridge for a non-rooted repo). ✅🧪
- ☐ **K.2** Open a changed file from Changes → row-1 **Diff viewer** renders; the **Changes-Viewed**
  state marks it reviewed. 🧪
- ☐ **K.3** Code-theme picker changes syntax colors live in the viewer. 🧪

#### L — Local main trunk (now EDITABLE — replaces the old read-only tests)

- ☐ **L.1** Select R6's **Local main** → Changes shows working-tree changes **and is interactive**:
  hover-**Discard** works on the trunk. _(There is no commit footer in the Changes tab by design —
  commits are agent-driven; the trunk is NOT write-blocked at the engine.)_ ✅🧪
- ☐ **L.2** Run an agent on **Local main** → it can stage/commit against the primary checkout (the
  trunk is a first-class editable target). **Regression:** the old "main is read-only — use + New
  workspace" CTA must **NOT** appear, and writes must **not** throw `TRUNK_READ_ONLY`. ✅🧪
- ☐ **L.3** Local main → **Review** sub-tab → "create a worktree to review its pull request" (a trunk
  has no PR). 🧪
- ☐ **L.4** Local main → terminal → `git status` runs in R6's root. 🧪
- ☐ **L.5 (regression)** A real worktree still has the full git surface (discard works; agent-driven
  stage/commit/push/pull all function). 🧪

#### M — GitHub auth (Settings → General → GitHub)

- ☐ **M.1** With `gh` logged in → panel auto-shows "GitHub CLI is authenticated and ready · Signed
  in as @you". 🧪
- ☐ **M.2** Without gh → paste a PAT → verifies + connected; **Sign out** clears it. 🧪
- ☐ **M.3** "Connect with GitHub" → device code + URL appear inline; authorizing connects. 🧪
- ☐ **M.4** Bad token → inline error, not a crash. 🧪

#### N — Chat diffs (all adapters)

- ☐ **N.1** Have **each** agent (Claude, Codex, Cursor, Droid, OpenCode) edit a file → the Edit/Write
  card shows a real diff (not just a filename) — exercises snake/camel + unified-diff
  reconstruction. ✅🧪
- ☐ **N.2** _(Known gap)_ Hover an Edit card header → there is currently **no** diff popover
  (the orphaned hover preview was removed). Confirm no crash. 🧪

#### O — Terminal / worktree isolation

- ☐ **O.1** Terminal in **worktree A** → `pwd` and `echo $ZEROS_WORKTREE_PATH` both point at A
  (never the main repo). ✅🧪
- ☐ **O.2** Terminal with no/stale folder → lands in `$HOME`, not the main checkout (C3). 🧪
- ☐ **O.3** `echo $OLDPWD` in a fresh terminal → not another worktree's path (env scrub). 🧪
- ☐ **O.4** Add **R6** (non-rooted), select its Local main → terminal → `pwd` prints **R6's path**
  (NOT the engine root). ✅🧪 _(PTY allowlist fix — key thing to verify)_
- ☐ **O.5** In R6, **+ New workspace** → agent `pwd`/file-create lands inside R6's worktree. 🧪
- ☐ **O.6** Reload the window (⌘R) → terminals reattach to live sessions. 🧪
- ☐ **O.7** Quit → no orphaned `zsh -l` survives (`ps`). _(⚠️ Known gap: no process-group kill — a
  dev-server's grandchildren may survive; note any strays.)_ 🧪

#### P — Archive / restore / History (newer surface)

- ☐ **P.1** On a worktree with edits → **Archive** → it leaves the sidebar and appears in the
  **History** page (day-bucketed). Untracked files are stashed too (C4). ✅🧪
- ☐ **P.2** **Unarchive/restore** → edits return; restore succeeds even if the original path is
  taken or the branch was deleted out-of-band (always-succeeds restore). ✅🧪
- ☐ **P.3** **Delete** a worktree → row removed; no stale DB row resurrects on reload. ✅🧪
- ☐ **P.4** _(Known gap C7)_ Archive a worktree while an agent/terminal is live in it → today the
  folder is yanked out from under them (no session/PTY teardown). Note the behavior; restore
  self-heals the cwd. 🧪

#### Q — Git command coverage (engine, via agent)

- ☐ **Q.1** Ask an agent to **commit** with a message → commit lands; Changes clears; `git log`
  shows it. ✅🧪
- ☐ **Q.2** Ask an agent to **push / pull / pull-and-push** → remote updates; ahead/behind reflects. 🧪
- ☐ **Q.3** Exercise **merge / cherry-pick / revert / reset / clean / stash list·apply·drop /
  deleteBranch / tags** via an agent ("revert the last commit", "stash my changes") and confirm the
  result. Destructive `reset --hard` / `clean` require explicit confirm. ✅🧪
- ☐ **Q.4** **Conflict flow:** create a merge conflict → `status` reports `conflicted` + a banner;
  resolve + **Continue**, or **Abort** clears it. 🧪
- ☐ **Q.5** **Commit on a detached HEAD** → succeeds, no false error (C5). ✅
- ☐ **Q.6** **Branch-vs-base diff after main advances** → main's new commits do NOT show as
  deletions (C6). ✅

#### R — Model gating (git-not-GitHub)

- ☐ **R.1** R2 (local, no remote) → worktree → commits → **Review** → "connect a GitHub remote /
  Publish" state; worktree + agent + Changes all still work. ✅🧪
- ☐ **R.2** Sign out of GitHub → open Review on a worktree with a remote → clear "Connect GitHub"
  state; create / worktree / Changes still work. ✅🧪

#### S — Cross-cutting / regression

- ☐ **S.1** Full automated suite: `pnpm test:git` → green (≈1,500 passing baseline). ✅
- ☐ **S.2** Remove the last project → returns to the welcome screen cleanly; removed repos don't
  resurrect on reload. 🧪
- ☐ **S.3** Quit + relaunch with several repos open → projects restore; selecting works; no respawn
  storms in the log. 🧪
- ☐ **S.4** End-to-end PR: worktree → commits → Review → **Create draft PR** → **Mark ready** →
  **Merge** → branch pushed, PR opens, workspace flips to **in-review**; all Review sub-tabs work. 🧪

### 6.4 Engine-log red flags (watch `[engine]`)

- ❌ `Couldn't create workspace: Request timeout: WORKSPACE_REQUEST` on **+ New workspace**.
- ❌ `git rev-parse --abbrev-ref HEAD failed` / `git … diff … HEAD failed` on a no-commits repo
  (should be the Initialize-Git panel instead).
- ❌ `git worktree add … <branch> failed` when opening an in-use branch (should route to Duplicate).
- ❌ A setup-script run **blocking** the create response, or a setup failure **deleting** the workspace.
- ❌ `Shutting down` / `Starting engine` / `ignored SIGTERM` when you **add** a repo (no-respawn broke).
- ❌ `ignored SIGTERM; SIGKILLed` repeatedly (bounded-dispose regressed).
- ❌ `Index built: …` (the dead CSS index is running again).
- ❌ A terminal/agent landing in the **wrong** repo (engine root instead of the picked repo).

### 6.5 Known limitations (v1 — expected, NOT bugs)

- **Setup output buffer is in-memory:** after an engine restart the **state** persists but the
  **scrollback** is gone — Rerun to repopulate. (A still-"running" row is auto-cleared on boot.)
- **Live setup output polls ~900ms** (not instant streaming) — fine for installs.
- **"Use branch" auto-runs setup** only via the main create/Duplicate path; adopting a foreign
  branch doesn't auto-run it, but the Setup tab offers **Run setup**.
- **PRs require a GitHub remote + sign-in** (the git-optional decision); local-only repos gate
  PR/Review/Publish rather than failing.
- **No automated coverage of the remote-only PR fetch** (heavy bare-remote fixture) — hence **D.4**
  is the key manual check.
- **No commit footer in the Changes tab** by design — git is agent-driven; the trunk is editable but
  manual staging/commit UI was removed.
- **Project dedup is exact-string** — a symlinked / `/private/var` / case-variant path to the same
  repo currently creates a duplicate project (open gap, §5).
- **Non-GitHub remotes:** only the GitHub "Publish" path ships in v1 (generic "any Git URL" is a
  later follow-up).

---

## 7. Key file index

- **Create / orphan / base branch:** `src/engine/git/worktree.ts` (`createWorkspace` :202-365,
  `resolveWorktreeBase` :150-186, trunk-editable :464-469, archive/restore :489+),
  `src/engine/git/default-branch.ts` (fetch 8s :71-78, ls-remote 5s :113-118),
  `src/engine/git/setup-runner.ts`, `src/engine/git/setup-hooks.ts`,
  `src/zeros/bridge/workspace-bridge.ts` (RPC budgets :111, :330), `src/shell/column1.tsx`.
- **Duplicate / open branch / open PR / routing:** `src/shell/dialogs/create-from-picker.tsx`
  (duplicate :219-252, routing :472-493/:557-566, friendly toasts :186-197),
  `src/engine/git/cross-tool.ts` (detect :198-232, attach-PR + remote-only :237-390, adopt :423-509),
  `src/engine/git/errors.ts`, `src/engine/git/git-exec.ts` (`assertSafeGitRef` :50-71).
- **Open project / dedup / init / publish:** `src/shell/add-project-provider.tsx`,
  `src/shell/dialogs/add-local-project.tsx`, `src/shell/bind-folder.ts` (bypass :23-29),
  `src/shell/dialogs/publish-to-github.tsx`, `src/shell/dialogs/quick-start.tsx`,
  `src/engine/git/init-clone.ts`, `src/engine/git/github.ts` (octokit cache :128-159/:347-364,
  `initRepoInPlace` :740-762, publish :767-827), `src/zeros/store/projects-store.ts` (:197),
  `src/engine/db/projects.ts` (:146).
- **Column 3 tabs:** `src/shell/column3-tabs/source-views.ts` (tab order :19-24),
  `changes-tab.tsx`, `review-tab.tsx`, `setup-tab.tsx`, `files-tab.tsx`, `file-viewer.tsx`,
  `src/shell/terminal/terminal-tab-strip.tsx`.
- **Settings / auth / chat diffs:** `src/zeros/panels/github-section.tsx`,
  `src/zeros/agent/renderers/tool-edit.tsx`, `src/zeros/appearance/diff-theme.ts`.
- **Engine types / state / archive:** `src/engine/git/types.ts` (status :7-12, setupState :16-20),
  `src/engine/git/state.ts`, `src/engine/workspace/service.ts`,
  `src/zeros/panels/history-page.tsx`.
- **Hunk-staging:** `src/engine/git/stage.ts` (:80-105) + bridge/service/native (UI not built).
- **Tests:** `vitest.config.ts`, `src/engine/git/__tests__/` (27 files; `phase0-fixes`,
  `phase1-coverage`, `ref-guard`, `setup-runner`, `cross-tool`, `worktree`, `publish-github`, …).

---

## 8. What changed since the source docs (supersession log)

| Source-doc claim                                                                                                       | Now                                                                                                                                         | PR               |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| "Local main" trunk is **read-only** (composer CTA, no commit footer, write-gate)                                       | 🔁 **Editable** first-class workspace; `TRUNK_READ_ONLY` removed                                                                            | #74 / #75        |
| Web / phone clients over an **E2EE relay**; "Publish is desktop-only / web bridge refuses"                             | 🔁 **Removed**; bridge is local-loopback, desktop-only; web tests moot (inert relay code lingers)                                           | #82              |
| Changes tab: base-branch dropdown, manual **stage/unstage**, inline **@pierre diff pane**, **commit/Pull/Push footer** | 🔁 **Reshaped**: scope dropdown, **agent-driven git** (Discard-only), diffs open in row-1; + Initialize-Git panel, turn-filter, viewed flow | #69 / #72 / #73  |
| Column 3 = a single "git tab" with Changes/Review sub-nav                                                              | 🔁 **Two-row** layout; row-2 = All Files · Changes · Review · Setup · [Terminal ▾] · +                                                      | #66 / #69        |
| Design **MCP disabled** / `src/engine/mcp.ts` parked                                                                   | 🔁 Now a full MCP subsystem (`src/engine/agents/mcp-*`) — see the MCP doc                                                                   | (later)          |
| Create gets a **`provisioning → ready`** status machine + AbortController                                              | ⚠️ **Partial** — background setup via a `setupState` field; no status machine, no abort                                                     | #85              |
| Checked-out branch gets a **Switch/Duplicate/Adopt resolution sheet**                                                  | ⚠️ **Partial** — routes to Duplicate + friendly toast only                                                                                  | #85              |
| Canonical-identity project **dedup** + close `bind-folder` bypass                                                      | ⛔ **Not built** — still exact-string                                                                                                       | —                |
| **Workspace Archive + History**                                                                                        | ✅ **New** (post-docs)                                                                                                                      | #87              |
| Provider config / Settings revamp; "+ Create" workspace dispatcher                                                     | ✅ New (peripheral)                                                                                                                         | #86 / #91 / #104 |

---

_End of consolidated reference. When the open gaps in §5 land (canonical dedup, create abort, the
resolution sheet, hunk-staging UI, C7), update §1 and §5 here rather than spawning a new doc._
