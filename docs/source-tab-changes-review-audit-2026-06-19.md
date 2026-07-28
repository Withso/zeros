# Source Tab Audit — Changes + Review (2026-06-19)

> Scope: the Column-3 **Source** tab of the Zeros Mac app and its two sub-views, **Changes** and **Review**, plus the read-only "Local main" trunk model, the full renderer → bridge → engine git/GitHub stack, and web/relay parity.
>
> Status legend used throughout: ✅ works · 🟡 partial / fragile · 🔴 broken · ⬜ not implemented.
>
> **Work-type tags** (added 2026-06-19 — answers "what needs UI work?"): every actionable item is tagged by which layer it touches —
> **🎨 UI** = needs renderer/UI work (new component, UI change, UX affordance, or UI review/test) ·
> **⚙️ Backend** = engine / bridge / façade plumbing only, no UI ·
> **🎨⚙️ UI + Backend** = needs both layers.
> The fastest way to see all UI work is the **"UI" column in §10** and the consolidated **§10.1 UI work index**. Tags also appear inline on the §1 headline recommendations, the §12 roadmap, and the "Fix:" callouts in §3–§9.
>
> All line numbers were captured against the current working tree on `iamarunrk/electron-rebuild-abi-fix` **after** the commit-bar removal. The Source panel gained an **"All Files"** sub-tab as its new default since the original survey, so a few cited lines in `changes-tab.tsx` drift by ~10–60 lines from earlier notes — the *code paths* are unchanged. Where this matters, the current line is given.

---

## ⚠️ NEW DIRECTION (2026-06-19, evening) — read §13 first

The user has chosen a **UI/UX redesign** of the Changes + Review surfaces. It **re-homes and re-sequences** existing capability — **it does not cut features** (D7 corrected 2026-06-20: see §13.4). In one line each:

1. **Changes = a plain list of changed files.** No inline diff pane (the diff *relocates* to row 1). Clicking a file opens it in **row 1** (the file viewer) **with a Diff toggle**; all diff-viewing options live in row 1.
2. **Review = two-phase (nothing cut).** *Before a PR exists:* a PR **title + description + Create PR** button (replacing the old "Create draft PR" empty state, `UV1V9F`). *After the PR is created:* the AI fills the title/description and the Review tab shows a **redesigned rich PR view** (`fyFjSF`) — header + **Changes/Commits/Checks/Review** sub-tabs — with **all current §5 capability preserved**, just re-styled and re-sequenced.
3. **Create PR = a button that auto-sends a contextual *PR-instructions* message to the open agent chat** (branch / target / uncommitted-count / upstream / user's title + description embedded); the agent commits, pushes, and runs `gh pr create`.

**The authoritative implementation plan is §13.** §1–§12 remain valid as the current-state audit (the *why*); §13 is the *what to build*, with a supersedes/reframes map in §13.8. Sections that change carry an inline pointer to §13.

---

## 0. Backend implementation status (2026-06-19)

The **backend-only (⚙️)** gaps from §10 were implemented in this branch. The 🎨 / 🎨⚙️ (UI-touching) items in §10.1 are intentionally **not** done here — they need renderer work. One nominally-backend item (#4) was deferred as a product decision (see below).

| Gap | Item | Status | What changed |
|---|---|---|---|
| **#1** | Create-draft-PR push-before-create + opaque 422 | ✅ **Implemented** | `createPr` now pushes the head branch (via the `push` op) **before** `pulls.create`, retries once as a non-draft PR on a draft-unsupported 422, and `workspaceRemote` is wrapped to throw a clear "no origin remote" `GitError` instead of a raw exit-128. `github.ts` |
| **#8** | No 422/error mapping in `wrapApiError` | ✅ **Implemented** | Added a 4xx branch + `githubApiMessage()` that surfaces GitHub's own response body (`response.data.message` + per-field `errors[]`) and a tailored remediation (push first / PR exists / draft unsupported / generic 422). `github.ts` |
| **#5** | Engine `remediation`/`code` dropped at the bridge | ✅ **Implemented** | `WorkspaceErrorLike` now carries `remediation`; `workspaceOp` throws a structured `WorkspaceOpError` (with `code` + `remediation`) so the renderer's `isGitErrorShape()` matches and `humanError()` renders the hint. Fixes the hint loss for **every** git/GitHub error, not just createPr. `workspace-bridge.ts` |
| **#24** | Trunk read-only is incidental, not asserted | ✅ **Implemented** | `resolveRepoForGitOp(id, intent)` rejects a trunk target on `"write"` with a new `TRUNK_READ_ONLY` `GitError`; `commit`/`push`/`pull`/`changeTarget`/`stage`/`unstage`/`discard` now resolve via write-intent (clear error instead of a confusing `WORKSPACE_NOT_FOUND`, and future-proof). `errors.ts`, `worktree.ts`, `ops.ts`, `stage.ts`, `restore.ts` |
| **#25** | `git_op` analytics records only `pr_create` | ✅ **Implemented** (UI-issued ops) | `trackGitOp` now fires from the renderer's single bridge choke point (`workspaceOp`) for `git.commit/push/pull/stage/unstage/discard` (desktop + web). **Caveat:** agent-shell git (the agent running `git` directly) still bypasses the bridge — the engine has no analytics client by design, so those remain out of scope without a new engine→renderer analytics channel. `workspace-bridge.ts` |
| **#18** | Commits sub-tab renders PR diffs from local store | ✅ **Implemented** | `showCommit` now calls `ensureCommitPresent()` — if the SHA is absent locally (force-push / behind) it fetches the reachable SHA from `origin` and retries; if that fails it throws a clear "pull this branch" `GitError` instead of an opaque `diff-tree` failure. `diff.ts` |
| **#35** | Dead engine surface | ✅ **Documented** | `DiffOptions.against` marked `@deprecated` (no caller — all sites pass `mode`); `worktree-vs-head` annotated as exposed-but-unexercised; the trunk no-op "All" diff was already documented. Kept (not removed) to preserve bridge back-compat. `diff.ts` |
| **#4** | Agents have no commit/push/PR prompt or tool | ⏳ **Deferred — needs product decision** | Research found this is **not** a mechanical backend change: a global "commit your work" prompt risks **unsolicited commits/pushes for every user**, is **asymmetric** across the three adapters (only Claude has a native append; Codex's instruction fields are unwired; Cursor has **no** instruction field — only a gateway prompt-prepend reaches all three), and overlaps the 🎨⚙️ decision in §7.3. Recommended plan below — **awaiting your call on wording/behavior before shipping.** |

**#4 — recommended plan (when you decide to ship it):** make the guidance **conditional** ("*When the user asks you to save/commit/push,* run git from your worktree cwd `$ZEROS_WORKTREE_PATH` with a clear message"), route it through a **single gateway prompt-prepend** (`gateway.ts` `withCwdHint` sibling, first-prompt-per-session, behind a setting) so it reaches all three agents identically, and pair it with the UI CTA + live-refresh from §7.3 (or ship the lower-risk "thin Commit button on the intact `gitCommit` façade" first). Insertion points: `gateway.ts:577-607`, `claude-sdk/adapter.ts:1102-1106`.

**Verification.** `tsc --noEmit` clean (zero new errors in the touched files; the 18 pre-existing errors are unrelated `cursor-sdk`/`pty`/`jsonrpc` Node-host typings). ESLint clean. New regression tests added (`github.test.ts`: push-before-create; draft-unsupported retry). ⚠️ The DB-dependent git suite (`test:git`) **cannot execute** in this workspace: all 197 failures are the pre-existing **`better-sqlite3` ABI mismatch** (`NODE_MODULE_VERSION 130 vs 141`) — the exact issue this `electron-rebuild-abi-fix` branch exists to fix. Zero non-ABI/assertion failures were observed, so these changes introduce no logic regressions; the new tests should be re-run once the ABI is rebuilt.

---

## 1. Executive summary

The Source tab is a single Column-3 tab (label **Source**, `FolderGit2` icon) anchored in row 2 of the terminal floating panel. It hosts one container — `SourceControlPanel` (`changes-tab.tsx:98`) — with three sub-views selectable from a 40px sub-nav: **All Files** (the workspace file tree, new default), **Changes** (working-tree + branch-vs-base diff), and **Review** (the PR surface). It addresses git through one uniform RPC: renderer façade `src/native/git.ts` → `src/zeros/bridge/workspace-bridge.ts` → engine `WorkspaceService.handle()` → the tested `src/engine/git/*` modules, every op shelling out via a single hardened `runGit` wrapper. Both desktop and web/relay ride this same bridge.

**Overall maturity: the backend is strong; the renderer surface is thin and now has a structural hole.** The engine + bridge implement and wire ~40 git/GitHub ops (commit, push, pull, stash, branch CRUD, per-hunk staging, merge/cherry-pick/revert/continue/abort, log, tags, PR update) — but the renderer façade exposes only a subset, and the UI exposes even less. Most SCM features are plumbed end-to-end yet **unreachable from the UI**.

The five most important findings:

1. **🔴 Create draft PR is broken for the common case** — `createPr` never pushes the branch before calling GitHub's `pulls.create` (`github.ts:518-540`), worktrees are created locally-only (`worktree.ts:266`), and the manual Push control was just removed. The result is an opaque GitHub 422 surfaced as the literal string **"GitHub API call failed"** (`github.ts:417`) with no remediation. This is the headline regression. Root cause + fix in §9. **✅ Fixed 2026-06-19 — see §0** (push-before-create + 422 mapping + remediation now reaches the UI).

2. **🟡 The commit-bar removal left no safety net.** Commit/push/pull are now "agent-driven," but there is **no agent prompt, tool, auto-commit, or commit-on-turn-end anywhere** (whole-tree grep of `src/engine/agents/` found zero git-commit guidance). The agent commits only if its model spontaneously runs `git commit` via its own shell. Meanwhile per-file **Stage still works** (`changes-tab.tsx:847-863`), so a user can stage files and then be stuck with no commit path and no CTA pointing to the agent. Stage-without-commit is a worse trap than the old footer.

3. **🔴 The Source tab never auto-refreshes on agent activity.** Neither `changes-tab.tsx` nor `review-tab.tsx` subscribes to `DB_CHANGED`, watches the filesystem, or polls. After the agent commits/edits, the panel shows the stale pre-commit state until the user manually clicks Refresh. This is now the *primary* post-commit path, and it silently looks like nothing happened. **✅ Fixed 2026-06-20 (#3) — see §10 row 3.** The Source panel now auto-refreshes (the manual Refresh button was removed): the renderer auto-bumps the shared `refreshKey` on `DB_CHANGED{workspaces}` + active-chat turn-end, and a bun-safe engine `.git` stat-poll watcher (`engine/git/watch.ts`) broadcasts `DB_CHANGED{workspaces}` so terminal- and agent-shell-run git (which bypass the bridge) also refresh live.

4. **🔴 The diff pane is unified-only, read-only, and patch-only.** No side-by-side, word-diff, expand-context, per-hunk/line staging, inline comments, image/binary handling, or large-diff guard — even though the `@pierre/diffs` library and the engine both support most of them. Tracked binaries leak raw `Binary files … differ` text into the renderer.

5. **🔴 Refresh is a no-op on the Review view.** The header Refresh bumps `refreshKey`, which is wired into ChangesView but **not** ReviewView (`changes-tab.tsx:191-200`, no `refreshKey` prop). A user on Review who merges/comments externally or waits on CI cannot re-poll PR state without switching sub-tabs.

> ⚠️ **Direction changed 2026-06-19 (evening) — see §13.** The recommendations below reflect the *pre-redesign* plan. The new direction **re-presents** these features with a different UI (it does **not** cut them): Changes becomes list-only with diffs in row 1, Review becomes a pre-PR create form **plus a redesigned post-PR review view** (all §5 capability retained), and Create PR routes commit/push/PR through the agent. Items below are relocated or re-sequenced — see §13.8.

**Headline recommendations** (full roadmap in §12):
- **P0:** Fix Create-draft-PR — push (or auto-push) the branch before `pulls.create`, and map 422 to actionable errors **(⚙️)**. Restore a commit path: either a thin "Commit" control wired to the intact `gitCommit` façade, or an explicit "Ask the agent to commit" CTA that prefills the composer **(🎨⚙️)**.
- **P1:** Live-refresh the Source tab on `DB_CHANGED` + agent turn-end **(🎨⚙️)**; surface the engine's structured `remediation` text (currently dropped at the bridge) **(⚙️)**; add a branch commit log **(🎨⚙️)**; wire per-hunk staging (backend already exists) **(🎨⚙️)**.
- **P2:** Wire Refresh into ReviewView **(🎨)**; add `git.listAllBranches` to the relay allowlist so the web compare-dropdown works **(🎨⚙️)**; binary/image diff handling **(🎨)**.

---

## 2. Architecture overview

### 2.1 The layers

```
┌──────────────────────────── RENDERER ────────────────────────────┐
│  Source tab (Column 3, row 2)                                     │
│  terminal-floating-panel.tsx  → lazily mounts SourceControlPanel  │
│                                                                   │
│  changes-tab.tsx  ── SourceControlPanel (container)               │
│    ├─ AllFilesView      (file tree, default sub-tab)              │
│    ├─ ChangesView       (status + diffs + stage/unstage/discard)  │
│    └─ ReviewView (review-tab.tsx)  (PR header + 4 sub-tabs)       │
│                                                                   │
│  changes-parse.ts  parseUnifiedDiffFiles / buildFileTree         │
│  diff-theme.ts     zerosDiffOptions → @pierre/diffs <PatchDiff>   │
└───────────────────────────────┬───────────────────────────────────┘
                                 │  typed facade (one fn per op)
                       src/native/git.ts
                                 │  gitStatus/gitDiff/gitStage/…/ghPr*
                                 ▼
                  src/zeros/bridge/workspace-bridge.ts
                    workspaceOp({op, params}) → WORKSPACE_REQUEST
                                 │  getActiveBridge().request()
            ┌────────────────────┴────────────────────┐
       DESKTOP                                      WEB / RELAY
   local WS to engine                       E2EE relay → engine host
            └────────────────────┬────────────────────┘
                                 ▼
                  src/engine/index.ts (handleWorkspaceMessage)
                    isRemoteAllowed() deny-by-default gate  ← relay only
                    authorizeRemoteWrite() for WRITE_OPS    ← relay only
                                 │
                  src/engine/workspace/service.ts  handle() switch
                    git.status/diff/show/log/stage/unstage/discard/
                    commit/push/pull/changeTarget/listAllBranches/…
                    gh.authStatus/prGet/prCreate/prMarkReady/prMerge/…
                                 │
            ┌────────────────────┴────────────────────┐
   src/engine/git/*.ts                        @octokit/rest
   diff.ts stage.ts restore.ts ops.ts         (github.ts)
   branch.ts cross-tool.ts worktree.ts        device-flow / PAT / gh-cli
   github.ts errors.ts git-exec.ts
            │                                          │
        runGit (execFile, no shell)            GitHub REST + GraphQL
            ▼                                          ▼
        the git binary                          api.github.com
```

### 2.2 The dispatch contract

- **Routing is by op NAME.** `workspaceOp` sends `{op, params}` (`workspace-bridge.ts:59-75`); the engine `handle()` switch is a thin pass-through to a tested git module. Op names must match the engine switch exactly.
- **Reads degrade to typed empties when the bridge is down:** `EMPTY_STATUS`, `EMPTY_PR`, `{hunks:[]}`, `[]`. The UI shows "No changes"/"Loading" rather than throwing.
- **Writes**: most host-only writes call `requireBridge()` and throw a clear "not connected" error — **but the Source tab's `gitStage`/`gitUnstage`/`gitDiscard` bypass `requireBridge` and silently no-op when the bridge is null** (`native/git.ts:506-576`). See §6 Flow B and §10.
- **Errors**: the engine serializes a structured `GitError` (`code` + `message` + `remediation`) into a `WORKSPACE_ERROR` envelope (`index.ts:1719-1721`). **The bridge then drops `code` and `remediation`** — `WorkspaceErrorLike` declares only `{code, message}` (and even `code` is never re-read) and `workspaceOp` throws `new Error(resp.message)` (`workspace-bridge.ts:49-54, 71-73`). Verified directly. Consequence: §9.

### 2.3 The worktree + read-only "Local main" trunk model

A Zeros workspace maps to a git worktree in two shapes:

| Shape | id | DB row? | Source-tab addressing | Surface |
|---|---|---|---|---|
| **Real worktree** | `ws_…` | yes (state.db) | `changesTarget = workspace.id` | full git **+** PR/Review |
| **Local main trunk** | `local:<slug>` | **no** (synthesized at render, `local-main-workspace.ts:52`) | `changesTarget = workspace.repoRoot` | read-only status/diff; **no PR surface** |

`SourceControlPanel` computes `isLocalMain` via `isLocalMainWorkspace()`, then `workspaceId = (!isLocalMain) ? workspace.id : null` and `changesTarget = isLocalMain ? workspace.repoRoot : workspaceId` (`changes-tab.tsx:105-111`).

- **Read ops** resolve their target through `resolveRepoForGitOp` (`worktree.ts:427`): `getWorkspace(id)` if it's a real id, else `trunkWorkspace()` if the path is a known repo root (`isKnownRepoRoot`), else throw. The trunk runs status/diff against the primary checkout with no DB row.
- **Write ops** (`stage/unstage/discard/commit/push/pull/changeTarget/listBranches`) resolve via `getWorkspace` only (`stage.ts:45`, `restore.ts:84`, `ops.ts:50/119/183`), so they **cannot address the trunk at all** — a trunk id throws `WORKSPACE_NOT_FOUND`. The read-only contract for main is therefore: a UI `readOnly` flag (hides write buttons, `changes-tab.tsx:180`) **plus** an incidental engine side-effect (no DB row → write ops can't target it). There is no explicit "this target is read-only" engine assertion (gap, §10).
- The trunk label `branch:'main'/baseBranch:'main'` is **hardcoded in the renderer** (`local-main-workspace.ts:61-62`) because the renderer doesn't probe HEAD. The engine's `trunkWorkspace` reads real HEAD, so only the renderer-side header label can be wrong, never the diff.
- A worktree deleted on disk surfaces `present:false`, intercepted full-screen at the shell (`app-shell.tsx:1047-1100`, WorktreeMissingPanel) before the Source tab renders. **Local main is pinned `present:true`** so the trunk can never get stuck. Note: SourceControlPanel itself has no `present:false` guard (gap, §10).

### 2.4 Web/relay vs desktop

After the single-writer migration, **desktop also rides the bridge** for git/GitHub reads+writes (a local WS to the engine). Native IPC (`nativeInvoke`) is reserved for ~6 host-only ops: `workspace_init_repo/clone/inspect_folder`, `dialog_pick_folder`, worktree `git_list_files`, and **all** gh auth mutations (`gh_auth_status/signin/detect_cli/set_token/sign_out`). The relay client uses the same façade but is gated server-side by a **deny-by-default allowlist** (`service.ts:366-401` REMOTE_READABLE / WRITE_OPS, enforced at `index.ts:1636`). Content reads are secret-filtered for relay clients. Full parity table in §8.

---

## 3. The Changes view

### 3.1 UI anatomy

ChangesView mounts when `changesTarget` resolves and the trunk is a git repo. From top to bottom:

- **Comparison bar** (`changes-tab.tsx` ~538-580): branch label · searchable **BranchSelect** base picker · **FilterSelect** (Uncommitted / All changes) · add/del/file totals · flat/tree **ViewToggle**.
- **Grouped file sections**: Conflicts / Staged / Changes / Untracked (uncommitted mode) or "Files changed" (all mode). Flat (`FileSection`) or tree (`TreeSection` via `buildFileTree`, `changes-parse.ts:100`).
- **Per-row hover actions**: Stage (`+`), Unstage (`-`), Discard (`Undo2`), each disabled/hidden per row kind and per `readOnly`.
- **Diff pane** (bottom, 50/50 flex): renders the selected file via `@pierre/diffs` `<PatchDiff>` (see §4).
- **No commit footer** — removed this session. The view now ends at the diff pane (or the file list when nothing is selected).

### 3.2 Data flow

`reload()` (`changes-tab.tsx:399-462`) branches on the filter:
- **Uncommitted**: `Promise.all([gitStatus, gitDiff(index-vs-head), gitDiff(worktree-vs-index)])`, each patch parsed by `parseUnifiedDiffFiles`. The `rawPatch` is *both* the file list (path/status/+N/−M) and the per-file diff for the pane — one round trip per section, no `--numstat`, no per-file diff call.
- **All**: a single `gitDiff(mode:'refs', base:compareBase, head:'HEAD')` (3-dot `base...HEAD`).

### 3.3 Every user action

| Action | Path | Status |
|---|---|---|
| Switch All Files / Changes / Review | `setSub(...)` (`changes-tab.tsx:124-140`) | ✅ works |
| Change-count badge on Changes | `useChangeCount(changesTarget, refreshKey)` sums staged+unstaged+untracked+conflicted (`:112`, `:281-302`) | 🟡 partial — no `.catch`; doomed `gitStatus` on a non-git trunk → unhandled rejection (§3.6) |
| Refresh | bumps `refreshKey` → re-runs reload/badge/branch-list (`:145`) | 🟡 partial — **no-op on Review** (§5); no live agent refresh (§7) |
| Pick comparison base (searchable) | BranchSelect → `gitListAllBranches` → sets `compareBase`, force-flips filter to `all` | 🟡 partial — **empty over relay** (op not allowlisted, §8); no remote-fetch affordance |
| Toggle Uncommitted / All | FilterSelect → reload branches | ✅ works |
| Toggle flat / tree | ViewToggle → FileSection vs TreeSection | ✅ works |
| Select a file → diff | composite `${kind}:${path}` key → selectedPatch effect → `<PatchDiff>` | ✅ works (see §4 for matrix) |
| Stage a file | `gitStage({workspaceId, paths})` → `git add --` (`stage.ts:44`) | ✅ works |
| Unstage a file | `gitUnstage` → `git restore --staged` (`stage.ts:52`) | ✅ works |
| Discard working-tree edits | `gitDiscard` → `git restore --worktree` (`restore.ts:84`) | 🟡 partial — **disabled for untracked** (`changes-tab.tsx:850`); no UI path to delete a new file |
| Initialize Git (non-repo trunk) | NotAGitRepo → `gitInitInPlace(repoRoot)` (`native/git.ts:685`) | ✅ works — desktop-only |
| Publish to GitHub (non-repo trunk) | `useAddProject().publishToGithub` → PublishToGithubDialog | ✅ works — desktop-only |
| **Commit / Push / Pull** | **REMOVED this session** (footer + dropdown + handlers + analytics deleted) | 🔴 no UI path — see §3.4 |
| Stage/unstage/discard during bridge startup | façade early-returns on null bridge, `act()` runs success path | 🔴 silent no-op (§6 Flow B) |

### 3.4 The removed commit bar — the new reality and the UX hole

> **→ §13.** The redesign closes this hole via the **agent-driven Create PR** flow (§13.5): the agent commits + pushes + opens the PR. The commit *capability* is not removed — it becomes the PR message, and a manual commit control remains an option in the plan (not required). The live-refresh need (§10 #3) becomes *more* important, not less.

**What was removed** (confirmed via the uncommitted diff): the commit-message `Input`, the **Commit** button, the chevron **Pull / Push / Pull and push** `DropdownMenu`, the `doCommit/pull/push/pullAndPush` handlers, the message `useState`, the `trackGitOp` analytics calls, and the `ArrowDown/ArrowUp/ArrowDownUp/GitCommit/Input/gitCommit/gitPull/gitPush` imports. A header comment now states commit/push/pull are agent-driven (`changes-tab.tsx:14-16`).

**What survives**: the `gitCommit/gitPush/gitPull` façades (`native/git.ts:524/535/546`), the bridge fns (`workspace-bridge.ts:527/544/561`), the engine handlers (`index.ts:129-131`), and the ops (`ops.ts:50/119/183`). They are **fully intact but have zero renderer callers** (grep confirms only the comment at `changes-tab.tsx:15`).

**The UX hole:**
- A user can still **Stage** files (the buttons remain) but has **no way to commit them** from this surface and **no CTA** telling them commit is agent-driven. The only in-file mention is a code comment. *Stage-without-commit is a trap worse than the old footer* — it implies a commit step that no longer exists in the UI.
- The empty states read "No changes." / "No git workspace…create a worktree" — **none mention asking the agent to commit/push**. Discoverability of the new model is zero.
- Visually the view lost its bottom anchor: previously a fixed `shrink-0 border-t` footer; now the file list or diff pane is the terminal element (cosmetic, P3).

**How a user commits/pushes now** → §7 (agent-driven git). Short version: there is no engineered path; the user must type a natural-language request and hope the model runs git via its shell. (Closing this is **🎨⚙️ UI + backend** — see §7.3 and gap #2.)

### 3.5 What's implemented and works (Changes)

- Two filter modes with single-round-trip-per-section diffing (`changes-tab.tsx:399-451`).
- Robust diff header parsing anchored on `diff --git a/(.+) b/(.+)`, preferring rename-to/`+++`, handling spaces under `core.quotePath=false` (`changes-parse.ts:58-83`; engine sets quotePath=false `diff.ts:296`).
- Composite `${kind}:${path}` selection key — a file that's both staged and re-edited resolves to the exact clicked row (documented prior first-match bug fix).
- Synthetic all-add patch for untracked files via `readWorkspaceFile` + `syntheticAddPatch` (`changes-tab.tsx:482-495`, helper `:987-996`).
- Per-target remount `key={changesTarget}` — switching the active chat to a different worktree/trunk mounts a fresh ChangesView (no stale compareBase/selection leak).
- Read-only trunk model: `readOnly` hides all per-row writes; engine `resolveRepoForGitOp` addresses the trunk by repoRoot.
- Tree view with single-child directory-chain collapse, folders-first sort.
- `StatusGlyph` maps A/M/D/R/U + conflict to colored letters; structured GitError surfacing via `isGitErrorShape`.
- Web/relay parity for every read/write except the branch picker (§8).

### 3.6 Changes gaps (see consolidated table §10)

- 🟡 No agent CTA / commit path after footer removal (P1).
- 🟡 BranchSelect empty over relay (P2).
- 🟡 Untracked files can't be discarded from UI (P3 — `git restore --worktree` doesn't remove untracked; engine `clean()` exists but no façade).
- 🟡 `useChangeCount` has no `.catch` → unhandled rejection on a connected desktop client whose trunk folder isn't a git repo yet (P3; benign, badge stays 0).
- ⬜ No bulk stage/unstage/discard-all (per-row only; `gitStage` takes `paths[]`).
- ⬜ No branch create/switch/delete (BranchSelect picks base only; engine `branch.ts:110/143/168` exists).
- ⬜ No merge-conflict resolution UI (conflicts listed but no ours/theirs, no Continue/Abort; engine ops exist).
- ⬜ No commit log / history (engine `log()` `diff.ts:394` + `git.log` handler + `bridgeGitLog` exist; **no `gitLog` façade**, no UI).

---

## 4. The diff experience (clicking a file)

> **→ §13.** The inline bottom diff pane is being **removed**; the diff now renders in **row 1** (the file viewer) behind a Diff/Source toggle (§13.3). The *location* changes, but the rendering concerns catalogued in §4.1–§4.5 (tracked-binary leak §4.3, no large-diff guard §4.4, image/Files-tab inconsistency §4.5, the missing split/word-diff/expand options §4.2) **carry over to the row-1 viewer** — they are requirements there, not throwaway.

When a file row is clicked, `onSelect('${kind}:${path}')` → the `selectedPatch` effect resolves the per-file patch from the already-parsed section (or synthesizes one for untracked) → the bottom pane renders `<PatchDiff patch={selectedPatch} options={zerosDiffOptions()} disableWorkerPool/>` (`changes-tab.tsx` ~680-684). The same `PatchDiff` + `zerosDiffOptions` path is reused in Review (`review-tab.tsx:307, 387`).

### 4.1 Capability matrix — what renders vs not

| File type | Behavior | Status |
|---|---|---|
| Tracked **modified** | per-file `git diff -U3` section → PatchDiff, syntax-highlighted | ✅ works |
| Tracked **added** | full-add section | ✅ works |
| Tracked **deleted** | full-removal section (status D) | ✅ works |
| Tracked **renamed** | status R, old→new from `rename from`/`rename to` | ✅ works |
| **Untracked** text | client-synthesized all-add patch from `readWorkspaceFile` content | ✅ works |
| **Untracked** non-text/binary | empty patch → "No textual diff (binary or empty)" | 🟡 generic message, not accurate |
| Tracked **binary** | `binary` flag parsed but **never read**; the non-empty `Binary files … differ` section is handed to PatchDiff | 🔴 broken — leaks raw text (§4.3) |
| **Image** | no inline preview (Files-tab can show images; diff pane cannot) | ⬜ not implemented |
| **Conflicted** | empty patch → "No textual diff"; no ours/theirs | 🟡 no resolution affordance |
| **Submodule** | raw `Subproject commit …` lines (engine omits `--submodule`) | 🟡 ugly but rare |
| **Large / minified** | full section to PatchDiff with `disableWorkerPool`, no cap | 🔴 risk — main-thread block (§4.4) |

### 4.2 Missing diff-viewer features

| Feature | Library/engine support | UI status |
|---|---|---|
| Side-by-side (split) | `diffStyle:'split'` plumbed in `zerosDiffOptions` (`diff-theme.ts:55-68`) | 🔴 unreachable — all call sites pass no arg, default 'unified', no toggle |
| Expand context | lib `expandUnchanged`/`expansionLineCount`; engine `-U3` fixed (`diff.ts:296`) | ⬜ never set |
| Word/intra-line diff | lib `lineDiffType` ('word'/'char') | ⬜ never set |
| Per-hunk / per-line staging | engine `git.stageHunk/unstageHunk/discardHunk` (`service.ts:1570-1588`), bridge (`workspace-bridge.ts:954-972`), lib `DiffAcceptRejectHunkConfig`/`selectedLines` | 🔴 unreachable — read-only PatchDiff, **no `native/git.ts` façade** for hunk ops |
| Inline / line-level comments | lib `lineAnnotations`/`renderAnnotation`/`selectedLines` | ⬜ never passed; Review comments are PR-level only |
| Next/prev file nav, copy, open-in-editor | — | ⬜ not implemented |
| In-diff search | only the branch-filter search exists | ⬜ not implemented |
| Diff-too-large guard / truncation | no `maxLineDiffLength`, no size cap anywhere | 🔴 absent (§4.4) |

### 4.3 🔴 Tracked binary leaks raw text — root cause

`parseUnifiedDiffFiles` sets `binary=true` on a `Binary files … differ`/`GIT binary patch` line **and** stores `patch = section` (the full non-empty `diff --git` section) (`changes-parse.ts:69-70, 83`). The `selectedPatch` resolver takes the truthy-`patch` branch (`if (f.patch) { setSelectedPatch(f.patch); return; }`, `changes-tab.tsx:533-534`) **without consulting `f.binary`**. The only "No textual diff (binary or empty)" message fires solely when `selectedPatch === ''` (`changes-tab.tsx:675-677`), which a tracked binary's non-empty section is not. So the raw `Binary files a/x and b/x differ` text is rendered inside PatchDiff. The `binary` flag is parsed but referenced nowhere in the diff pane. **Fix (🎨):** in the `selectedPatch` resolver, check `f.binary` before `f.patch` and render the placeholder (and ideally an image preview, mirroring `file-viewer.tsx:155-167`).

### 4.4 🔴 No large-diff guard

The whole-tree `git diff` stdout is fetched (capped only by `runGit`'s 16 MiB buffer), `parseUnifiedDiffFiles` re-parses the entire tree patch on every `reload()`, and the selected file's full section is handed to PatchDiff with `disableWorkerPool` (no virtualization). A single huge generated/lockfile/minified diff can freeze the renderer when clicked. **Fix (🎨):** cap section size (truncate + "diff too large, open file") and consider re-enabling the worker pool for large patches.

### 4.5 Files-tab inconsistency

`file-viewer.tsx:143-175` renders images inline, shows explicit "Binary file", "too large (N MB)", and error placeholders, and offers a markdown/code toggle. The diff pane has **none** of that. Image/asset changes (common) are invisible in the diff pane while perfectly viewable one tab over.

### 4.6 What's covered (diff)

Text add/modify/delete/rename diffs; Shiki syntax highlighting (built-in `pierre-dark`/`-light`, selectable via `ZEROS_DIFF_THEME`); add/del counts parsed per-file and shown per-row + totals; diff chrome themed to Zeros tokens via `unsafeCSS` injected into the diffs shadow DOM; robust loading/empty pane states (`null` → "Loading diff…", `''` → placeholder, else PatchDiff); `disableWorkerPool` for synchronous small-diff render; per-target remount prevents a stuck "Loading diff…" across worktree switches.

> One additional library-level crash risk noted in research: `getSingularPatch` throws on a non-single-file section inside a render `useMemo` (`@pierre/diffs/.../PatchDiff.js:42-44`), with no error boundary above the pane (`column3-tabs.tsx:74-77`). Low frequency (the app feeds single-file sections), but unguarded.

---

## 5. The Review view

> **→ §13.4. Nothing here is cut — it is redesigned and re-sequenced into two phases.** *Before a PR:* a PR title + description + Create PR form (replacing only the `UV1V9F` empty state). *After the PR is created:* this exact PR surface (header + Changes/Commits/Checks/Review sub-tabs + merge) is **kept and re-styled** to `fyFjSF` (the post-PR rich view). The §5.4/§5.5/§5.6 bugs are **fixed in place** during the re-skin (§13.8), not removed.

`ReviewView` (`review-tab.tsx`) is mounted by SourceControlPanel **only for a real worktree** (`workspaceId != null`); the read-only trunk gets a "No git workspace … to review its pull request" EmptyState (`changes-tab.tsx:190-205`). On mount it gates on `ghAuthStatus()`; unauthenticated → "Connect GitHub"; authed → load PR by `prNumber` via `ghPrGet()`. No PR → "No pull request yet" + **Create draft PR** button. With a PR → header (StateBadge, Open-on-GitHub link, MergeControls) + four sub-tabs.

### 5.1 PR header + every action

| Action | Path | Status |
|---|---|---|
| Auth gate (Connect GitHub) | `ghAuthStatus()` → `getAuthStatus` probes `/user`, clears token on 401 (`github.ts:193-209`) | ✅ works |
| **Create draft PR** | `ghPrCreate({title: branch, body:'', draft:true})` → `createPr` (`github.ts:518`) | 🔴 **broken for unpushed branches** (§9) |
| Open PR on GitHub | `<a href={prUrl ?? pr.url} target=_blank>` | ✅ works |
| Mark ready (draft → ready) | `ghPrMarkReady` → GraphQL `markPullRequestReadyForReview` (`github.ts:769`) | ✅ works |
| Merge (squash/merge/rebase) | `ghPrMerge({method})` → `oct.pulls.merge` (`github.ts:1044`) | 🟡 partial — **always enabled**; `isMergeable`/`mergeableState` fetched but never consulted |
| Switch sub-tabs | local `useState` | ✅ works |
| **Refresh** | header Refresh bumps `refreshKey` — **not passed to ReviewView** | 🔴 no-op (§5.4) |

### 5.2 Sub-tabs

| Sub-tab | Path | Status |
|---|---|---|
| **Changes** (base...HEAD) | `gitDiff({mode:'base', rawPatch:true})` → engine resolves `baseBranch` from the record (`diff.ts:209-210, 297`); list + PatchDiff (path-only selection, fine here) | ✅ works |
| **Commits** | `ghPrCommits` (Octokit) → select → `gitShowCommit({sha})` runs **local** `git diff-tree` in `ws.path` (`diff.ts:343-377`) | 🟡 partial — **renders PR commit diffs from the LOCAL object store**; force-push / worktree-behind / wrong-branch → pane errors, no fetch fallback |
| **Checks** | `ghPrChecks` → `checks.listForRef` + `repos.listCommitStatusesForRef`, deploy-like contexts split into deployment cards (`github.ts:868-926`); passed/failed/pending summary | ✅ works |
| **Reviews** | `ghPrReviews` merges `pulls.listReviews` (skips PENDING) + `issues.listComments`, oldest-first; post comment via `ghPrComment` (Cmd/Ctrl+Enter); "Add to chat" per item | ✅ works (post-comment) · 🟡 "Add to chat" silently no-ops with no active chat (§5.5) |

### 5.3 What's implemented (Review)

Auth-gated state machine; PR resolution by `prNumber`; draft-by-default create with workspace stamping (`status:in-review`, `prNumber/prState/prUrl`); StateBadge (draft/ready/merged/closed); state-aware MergeControls; per-sub-tab loading/error/empty states with cancellation guards; structured GitError surfacing via `humanError`; `trackGitOp('pr_create')` analytics; **full web/relay parity** (every gh.* read in REMOTE_READABLE, every write in WRITE_OPS).

### 5.4 🔴 Refresh is a no-op on Review — root cause

`SourceControlPanel` bumps `refreshKey` (`changes-tab.tsx:145`). ChangesView receives `refreshKey={refreshKey}` (`:181`). **ReviewView is keyed only `key={workspaceId}` and gets NO `refreshKey` prop** (`:191-200`). `ReviewView.loadPr` deps are `[workspaceId, prNumber]`; sub-component fetch effects key on `workspaceId`/`prNumber`/`baseBranch` only. Since `refreshKey` doesn't change `workspaceId`, nothing re-mounts or re-fetches. Verified: zero `refreshKey` references in `review-tab.tsx`. The view is entirely fetch-on-mount with no polling and no manual refresh. **Fix (🎨):** pass `refreshKey` into ReviewView and thread it into `loadPr` deps + each sub-component effect.

### 5.5 🟡 "Add to chat" can silently no-op — root cause

`addToChat` dispatches `ENQUEUE_COMPOSER_APPEND` with `chatId: activeChatId ?? null` and `source:'manual'` (`review-tab.tsx:482-493`). The sole consumer (`agent-chat.tsx:1866-1878`) returns early if `!chatId` or `pendingAppend.chatId !== chatId`. The store type documents the dead path explicitly: `PendingComposerAppend.chatId` "Null = the (removed) new-agent landing — no consumer" (`store.tsx:283-284`). The EmptyComposer fallback was deleted 2026-06-18. So with no active chat, the append is enqueued and never applied — the button gives positive feedback but nothing happens. **Fix (🎨):** disable "Add to chat" when `activeChatId == null`, or open a chat first.

### 5.6 Review gaps (§10)

- ⬜ No editing of PR title/body (`updatePr`/`bridgeGhPrUpdate` exist `github.ts:745`/`workspace-bridge.ts:795`; **no façade**).
- ⬜ No approve / request-changes / submit-review (**no `pulls.createReview` op anywhere** — `github.ts:962` is doc-only).
- ⬜ No inline per-line PR comment threads or resolve (explicitly deferred, `github.ts:969-972`).
- ⬜ No reviewers / assignees.
- ⬜ Cannot attach/open an existing PR (Review keys on `workspace.prNumber` only; `ghPrList` is used in the create-from-picker, not Review).
- ⬜ No React test coverage for ReviewView's state machine (only `github.test.ts` covers the Octokit layer).

---

## 6. End-to-end user flows (A–I)

Each step annotated WORKS / PARTIAL / BROKEN / MISSING.

### Flow A — Inspect a change diff
1. Open Source → Changes. **WORKS**
2. Click a tracked text file → unified diff renders. **WORKS**
3. Click a tracked **binary** → raw "Binary files … differ" text leaks into PatchDiff. **BROKEN** (§4.3)
4. Click an **image** → no preview. **MISSING**
5. Want split/word-diff/expand-context/in-diff search → none available. **MISSING**
6. Click a huge generated file → no size guard; risk of main-thread freeze. **BROKEN/risk** (§4.4)

### Flow B — Stage and discard
1. Hover a row → Stage (`+`) → file moves to Staged. **WORKS**
2. Unstage (`-`) → back to Changes. **WORKS**
3. Discard a modified file → restored. **WORKS**
4. Discard an **untracked** file → button disabled, no delete path. **PARTIAL/dead-end** (`changes-tab.tsx:850`; engine `clean()` exists, no façade)
5. Click Stage during the bridge startup window → façade early-returns on null bridge, `act()` runs its success path (reload + onChanged) → **appears to succeed, working tree unchanged**. **BROKEN** (`native/git.ts:506-576`; `active-bridge.ts:14-17`)
6. Want to stage a single hunk → no UI; whole-file only. **MISSING** (backend exists)

### Flow C — Commit your work (the new agent-driven model)
1. Stage files in Changes. **WORKS**
2. Look for a Commit button → **gone**, no CTA, no hint. **BROKEN/dead-end** (§3.4)
3. Switch to the agent composer, type "commit and push this". **PARTIAL** — depends entirely on the model spontaneously running git via its shell; no tool/prompt/forced flow (§7)
4. Agent commits. Switch back to Changes → still shows pre-commit state until manual Refresh. **BROKEN** (no live refresh, §7)
5. Click Refresh → file list updates. **WORKS** (manual only)

### Flow D — Create a draft PR
1. Open Source → Review on a real worktree. **WORKS**
2. Authed? If not, "Connect GitHub" (desktop: native gh auth; web: cannot sign in). **WORKS / web-limited**
3. No PR → click **Create draft PR**. **BROKEN for the common case** — `createPr` never pushes; GitHub 422 → "GitHub API call failed" with no remediation (§9)
4. If an agent already pushed the branch first → PR is created. **WORKS (conditional)**

### Flow E — Review an existing PR
1. Review loads the PR by `prNumber`. **WORKS**
2. Changes sub-tab → base...HEAD diff. **WORKS**
3. Commits sub-tab → per-commit local `diff-tree`. **PARTIAL** — errors if local worktree lacks the SHA (force-push/behind)
4. Checks sub-tab → CI + deployments. **WORKS**
5. Reviews sub-tab → timeline + post a comment. **WORKS**
6. Approve / request changes / comment on a line → **MISSING**
7. CI still running, click Refresh to re-poll → no-op. **BROKEN** (§5.4)

### Flow F — Merge a PR
1. Mark draft ready. **WORKS**
2. Merge (squash/merge/rebase) — button always enabled. **PARTIAL** — ignores conflicts/blocked branch protection; failure only surfaces as a raw GitHub error
3. After merge, Refresh to confirm new state → no-op. **BROKEN** (§5.4)

### Flow G — Compare against another branch
1. Changes → open BranchSelect, search, pick a base. **WORKS (desktop)**
2. Filter flips to All, refs diff renders. **WORKS (desktop)**
3. Same flow on web/relay → dropdown is empty (op not allowlisted). **BROKEN over relay** (§8)
4. A base branch created on the remote after open → not listed until refresh; no remote-fetch. **PARTIAL**

### Flow H — Initialize / publish a non-git project trunk
1. Open Source → Changes on a non-git project's Local main. **WORKS (desktop)**
2. NotAGitRepo → Initialize Git → `gitInitInPlace`. **WORKS (desktop)**
3. Publish to GitHub → PublishToGithubDialog. **WORKS (desktop)**
4. Same on web/relay → NotAGitRepo never shows (probe is native-only); generic "No changes" with no explanation. **MISSING on web** (§8)

### Flow I — Add a PR review to chat
1. Reviews sub-tab → "Add to chat" on a review with a body. **WORKS (if a chat is active)**
2. No active chat → enqueued with `chatId:null`, never consumed, no error. **BROKEN/silent** (§5.5)

---

## 7. Agent-driven git

### 7.1 How commit/push/pull/PR happen via the agent today

**There is no engineered path.** "Agent-driven commit/push/pull" is an *emergent* behavior, not a feature:

- **No git tool, no auto-commit, no commit-on-turn-end, no system-prompt scaffolding** instructing any agent to commit, push, or open a PR. Whole-tree grep of `src/engine/agents/` for git-commit guidance returns nothing.
- The agent commits **only if its model spontaneously runs `git commit`/`git push`/`git pull` via its ordinary shell/Bash tool**, executed in the worktree directory.
- The gateway sets the worktree as the agent's cwd (`resolveAgentCwd`, `gateway.ts:89`) and stamps `ZEROS_WORKTREE_PATH` (`gateway.ts:185`) — this is what makes an ad-hoc `git commit` operate on the correct tree.
- All three active agents self-report their cwd to the model (Claude via the `claude_code` preset `<env>` block `adapter.ts:1094-1106`, Codex via `thread/start.cwd`, Cursor via `workspace_root_path`) — but **none get git instructions**.
- `github.ts:715` ensures a local committer identity so a fresh-install `git commit` doesn't fail. That's the *only* git-commit-related text in `src/`.

### 7.2 What's actually wired vs assumed

| Element | Reality |
|---|---|
| Agent cwd = worktree | ✅ wired (`gateway.ts:89, 185`) |
| Committer identity bootstrap | ✅ wired (`github.ts:715`) |
| Engine commit/push/pull ops | ✅ intact (`ops.ts`), reachable via bridge, **but no agent calls them** — agents use their own shell git |
| `gitCommit/gitPush/gitPull` façades | ✅ defined, **zero callers** |
| Prompt scaffolding / git tool | ⬜ **does not exist** |
| Auto-commit / checkpoint per turn | ⬜ **does not exist** (the only `commit --allow-empty` in the tree is `detach.ts` for the design-preview feature, unrelated to persisting agent work) |
| Live refresh after agent commit | ⬜ **does not exist** |

### 7.3 The UX gap left by removing the manual bar

This is the most consequential finding of the audit. Removing the commit bar made the agent the **sole committer**, but:

1. **The agent is not reliably a committer** — without a prompt/tool, it commits only at the model's discretion (often only when explicitly asked, and not always then). Work edited across a turn sits uncommitted in the worktree with no safety net.
2. **No CTA bridges the user to the agent.** A user who staged files has no on-screen path forward.
3. **The panel doesn't reflect agent commits** until manual Refresh, so even when the agent *does* commit, it looks like nothing happened.

**Recommended close (🎨⚙️)** (P0/P1, §12): either (a) restore a thin Commit control wired to the intact `gitCommit` façade (lowest risk, immediately closes the hole — mostly 🎨), or (b) add an explicit "Ask the agent to commit" CTA that prefills the composer via `ENQUEUE_COMPOSER_APPEND` (🎨) **and** add git-commit guidance to the agent system prompt so the agent reliably acts (⚙️) — plus live-refresh so the result is visible.

### 7.4 Analytics regression

Pre-removal, `trackGitOp('commit'|'push'|'pull'|'pull_and_push')` fired from the footer. Those call-sites were deleted. Agents commit via their own shell (bypassing the engine git ops), and neither the engine nor the bridge emits a `git_op` event. **Result: the `git_op` funnel now records `pr_create` only** (`review-tab.tsx:131/133`) — commit/push/pull volume is invisible, the enum members `commit/push/pull/pull_and_push/stage/unstage/discard/pr_merge/pr_mark_ready` are all declared but uncalled (`agent-events.ts:142-152`).

---

## 8. Web / relay parity

| Capability | Desktop | Web/relay | Note |
|---|---|---|---|
| status / uncommitted diff | ✅ | ✅ | REMOTE_READABLE |
| base...HEAD ("All") diff | ✅ | ✅ | once a base is set |
| file content / untracked synthetic diff | ✅ | ✅ | `file.read` allowlisted; secret-filtered on relay |
| commit diff (Review Commits) | ✅ | ✅ | engine host's worktree must contain the SHAs (same fragility both sides) |
| stage / unstage / discard | ✅ | ✅ | `authorizeRemoteWrite`, trusted-device, no per-op prompt |
| **BranchSelect compare dropdown** | ✅ | 🔴 **empty** | `git.listAllBranches` **not in REMOTE_READABLE** → `REMOTE_OP_NOT_ALLOWED` (§8.1) |
| gh auth **status** | ✅ | ✅ | web uses `bridgeGhAuthStatus`; desktop uses native IPC |
| gh auth **sign-in / set-token / sign-out** | ✅ | ⬜ | native-only; web cannot authenticate to GitHub |
| PR get / checks / commits / reviews | ✅ | ✅ | REMOTE_READABLE |
| Create draft PR / mark-ready / merge / comment | ✅ | ✅ | WRITE_OPS; **createPr-without-push 422 affects web identically** |
| Initialize Git / Publish to GitHub | ✅ | ⬜ | host-FS ops; `workspaceInspectFolder` probe is native-only so NotAGitRepo never shows on web |
| Live cross-device refresh of Changes | ⬜ | ⬜ | `DB_CHANGED('workspaces')` refreshes only the workspace *list*, not the panel diffs — absent on both surfaces |

### 8.1 🔴 BranchSelect dead over relay — root cause

`gitListAllBranches` → `bridgeGitListAllBranches` sends op `git.listAllBranches` (`workspace-bridge.ts:996`), which is **absent from REMOTE_READABLE / WRITE_OPS / REMOTE_METADATA_OPS** (`service.ts:366-401`). `isRemoteAllowed` returns false, so the engine refuses it with `REMOTE_OP_NOT_ALLOWED` before dispatch (`index.ts:1636`). On a *connected* relay client the façade calls through, `workspaceOp` throws on the WORKSPACE_ERROR, and the branch-load `.then` (`changes-tab.tsx` ~445) has **no `.catch`** → unhandled rejection, dropdown stays empty. **Fix (🎨⚙️):** add `git.listAllBranches` to REMOTE_READABLE (it's a read-only enumeration, ⚙️) and add a `.catch` on the branch-load (🎨).

---

## 9. The "draft PR not working" root cause

> **✅ Fixed 2026-06-19 (§0).** The fixes below (push-before-create, 422 mapping, draft-unsupported retry, `workspaceRemote` wrap) and the bridge remediation-passthrough (§5) are now implemented. This section is retained as the root-cause record; the "in order" fixes in §9.4 were applied.

### 9.1 User-visible symptom

Clicking **Create draft PR** on a workspace whose branch has not been pushed to origin fails with an opaque **"GitHub API call failed"** and no remediation. No PR is created.

### 9.2 Root cause (primary)

`createPr` calls `oct.pulls.create` with `head: ws.branch` but **never pushes the branch first** (`github.ts:518-540`, verified directly). Worktrees are created locally-only via `git worktree add -b branch` (`worktree.ts:266`) and the manual Push control was just removed, so the head branch is absent on origin by default. GitHub returns **422** ("No commits between base and head" / head ref not found). This is the core bug. Confidence: high. Adversarial verdict: **partially-true** — the mechanism is confirmed, but it only fires when the branch was never pushed; if an agent pushed it first, `createPr` succeeds. Given the new agent-driven model (where push is *not* guaranteed, §7), the unpushed case is now the common one.

### 9.3 Contributing causes (why the error is also opaque)

1. **No 422 mapping.** `wrapApiError` only special-cases 401/403 (`isAuthError`) and network codes; everything else (422 no-commits, branch-not-on-origin, draft-unsupported-on-plan, PR-already-exists) falls through to `GITHUB_API_ERROR` with `withAuthRetry`'s static fallback `"GitHub API call failed"` (`github.ts:381-402, 417`, verified) — discarding GitHub's own descriptive 422 body. Confidence: high.
2. **Remediation lost at the bridge.** The engine attaches `code + message + remediation` (`index.ts:1719-1721`), but `WorkspaceErrorLike` declares only `{code, message}` and `workspaceOp` throws `new Error(resp.message)` (`workspace-bridge.ts:49-54, 71-73`, verified). `review-tab.tsx` `humanError` shows remediation only when `isGitErrorShape` is true, which requires a `code` property a plain `Error` lacks. So even well-authored remediation never reaches the UI. Confidence: high. **This is a general bug** affecting every git/gh error in the Review tab, not just createPr.
3. **`draft:true` unconditional.** No fallback for repos/plans that reject draft PRs (private repos on Free orgs → 422). `createPr:529` has no retry-without-draft. Confidence: high (design gap).
4. **`workspaceRemote` no try/catch.** It shells out `git remote get-url origin` with raw `execFile` and no error wrapping (`github.ts:499-509`, verified). A repo with no `origin` rejects with a raw child-process error (code 128) that escapes `createPr` *before* `withAuthRetry`, bypassing all classification → surfaces as an unstructured `WORKSPACE_OP_FAILED`. Confidence: high.
5. **No test coverage** for the 422 / no-push / no-origin paths (`github.test.ts` covers happy path + one NETWORK_ERROR). The exact failure the commit-bar removal makes more likely has zero regression coverage.

### 9.4 Concrete fixes (in order) — ⚙️ all backend, no UI work

1. **Push before create** (the real fix): in `createPr`, before `pulls.create`, push the head branch — call the existing `push()` op (`ops.ts:119`, `-u`, `--force-with-lease`) for `ws.branch`. Map "no commits between base and head" to a clear message. This makes Create-draft-PR work in the agent-driven model regardless of whether the agent pushed.
2. **Map 422 in `wrapApiError`**: add an `is4xx`/status-422 branch that surfaces GitHub's response body message and an appropriate `remediation` (e.g. "Push your branch first", "A PR already exists for this branch", "This plan doesn't support draft PRs").
3. **Stop dropping `remediation` at the bridge**: extend `WorkspaceErrorLike` to include `code` and `remediation`, and have `workspaceOp` throw a structured error (or attach the fields to the thrown `Error`) so `isGitErrorShape` matches and `humanError` can render the hint.
4. **Draft fallback**: on a 422 indicating draft-unsupported, retry once with `draft:false`.
5. **Wrap `workspaceRemote`**: try/catch the `execFile`, throw a `GitError` ("This repo has no GitHub remote. Publish it first.").
6. **Add tests** for: branch-not-pushed → push-then-create succeeds; no-origin → clean GitError; 422 surfaces a useful message.

---

## 10. GAPS & NOT-YET-IMPLEMENTED (prioritized, de-duplicated)

> **UI** column: 🎨 = renderer/UI work · ⚙️ = backend-only · 🎨⚙️ = both. UI-involved items (🎨 or 🎨⚙️) = **28 of 36**; consolidated in §10.1.
>
> ⚠️ **Re-presented by the redesign — see §13.8. Nothing here is dropped.** Rows are **relocated** (the diff viewer → row 1: #9/#10/#19/#29), **re-sequenced** (the Review features #11/#13/#16/#17/#21/#22/#28 re-appear in the post-PR Phase-B view), or **unchanged but more urgent** (#3 live refresh). Read §13.8 before planning from this table.

| # | P | UI | Gap | Why it matters | Effort | Suggested approach |
|---|---|---|---|---|---|---|
| 1 | **P0** | ⚙️ | Create-draft-PR fails for unpushed branches (no pre-push, opaque 422) | The primary Review entry point is broken in the now-default agent-driven flow | M | Push head branch in `createPr` before `pulls.create`; map 422 (§9.4) **— ✅ DONE (§0)** |
| 2 | **P0** | 🎨⚙️ | No in-app commit path + no agent CTA after footer removal | Stage works but commit doesn't; users get stuck / lose work | S–M | Restore a thin Commit control on the intact `gitCommit` façade, **or** add "Ask the agent to commit" CTA + agent prompt scaffolding |
| 3 | **P1 ✅** | 🎨⚙️ | ✅ **DONE (2026-06-20)** — No live refresh on agent/terminal git activity | Agent commits invisible until manual Refresh — undermines the whole model | M | **Shipped (A+B+C, verified):** renderer auto-bumps `refreshKey` on `DB_CHANGED{workspaces}` + active-chat turn-end (`terminal-floating-panel.tsx`); `ReviewView` wired with a silent re-pull (`review-tab.tsx`); manual Refresh button removed; new bun-safe engine `.git` stat-poll watcher (`engine/git/watch.ts`, wired in `index.ts` + `service.ts gitWatchRoots()`) broadcasts `DB_CHANGED{workspaces}` for terminal/agent-shell git. **NB:** engine-side changes need an app restart (no hot-reload). |
| 4 | **P1** | ⚙️ | Agents have no commit/push/PR prompt or tool | "Agent-driven" is unengineered; commits unreliable | M | Add git-commit guidance to the agent system prompt and/or a first-class commit tool **— ⏳ deferred: product decision (§0)** |
| 5 | **P1** | ⚙️ | Engine `remediation`/`code` dropped at the bridge | All git/gh error hints never reach the UI (worsens every failure incl. createPr) | S | Extend `WorkspaceErrorLike` + `workspaceOp` to preserve `code`+`remediation` **— ✅ DONE (§0)** |
| 6 | **P1 ⏳** | 🎨⚙️ | ⏳ **DEFERRED (2026-06-22)** — No per-hunk / per-line staging | Core SCM workflow; backend fully exists, UI can't reach it | M | Add `gitStageHunk/UnstageHunk/DiscardHunk` façades; wire PatchDiff accept/reject-hunk **— ⏳ deferred: won't build in UI; the workflow is already reachable via the terminal (`git add -p`/`reset -p`/`checkout -p`) and agents (`git apply --cached`). Engine + bridge layers stay as-is (no façade added, would be dead code). §13.8 also defers this.** |
| 7 | **P1** | 🎨⚙️ | No commit log / branch history | Review shows only PR commits; no local history view | M | Add `gitLog` façade (engine `log()` + `git.log` + `bridgeGitLog` exist) + a Commits/History view |
| 8 | **P1** | ⚙️ | No 422/error mapping in `wrapApiError` | Common GitHub failures all collapse to one unhelpful string | S | Add a 4xx branch surfacing GitHub's body + remediation **— ✅ DONE (§0)** |
| 9 | **P1** | 🎨 | Tracked binary leaks raw text into PatchDiff | Visible defect on any binary change | S | Check `f.binary` before `f.patch` in the selectedPatch resolver |
| 10 | **P1** | 🎨 | No diff-too-large guard | Huge/minified diff can freeze the renderer | M | Truncate large sections + "open file" affordance; reconsider worker pool |
| 11 | **P2** | 🎨 | Refresh no-op on Review view | Can't re-poll PR/checks after external change | S | Pass `refreshKey` into ReviewView + sub-effects |
| 12 | **P2** | 🎨⚙️ | `git.listAllBranches` denied over relay → empty BranchSelect | Compare-base unusable on web; unhandled rejection | S | Add to REMOTE_READABLE (⚙️) + add `.catch` (🎨) |
| 13 | **P2** | 🎨 | Merge button ignores mergeability/conflicts | User attempts doomed merge, opaque failure | S | Disable/guard merge on `mergeableState` |
| 14 | **P2** | 🎨⚙️ | No in-app conflict resolution | Conflicts listed but no ours/theirs/Continue/Abort | L | Wire engine merge/continue/abort + a conflict UI |
| 15 | **P2** | 🎨⚙️ | No branch create/switch/delete | Only base-pick exists; engine `branch.ts` ready | M | Façades + UI menu |
| 16 | **P2** | 🎨 | "Add to chat" silent no-op with no active chat | Confusing dead button | S | Disable when no active chat / open one |
| 17 | **P2** | 🎨⚙️ | No PR title/body edit | Empty body + branch-name title forces a trip to GitHub | S | `ghPrUpdate` façade (engine `updatePr`/bridge exist) + UI |
| 18 | **P2** | ⚙️ | Commits sub-tab renders PR diffs from local store | Force-push/behind → broken pane | M | Fetch the SHA or fall back to GitHub commit diff **— ✅ DONE (§0)** |
| 19 | **P2** | 🎨 | No image/binary diff in pane (vs Files tab) | Asset changes invisible in diff | M | Reuse `file-viewer` image/placeholder handling |
| 20 | **P2** | 🎨 | No bulk stage/unstage/discard-all | Tedious for many files | S | Pass all paths to existing `paths[]` ops |
| 21 | **P2** | 🎨 | No attach/open existing PR in Review | Only `workspace.prNumber` PRs surface | M | Reuse `ghPrList` + a picker in Review |
| 22 | **P2** | 🎨⚙️ | No inline per-line PR comments | Core review flow missing | L | Engine GraphQL threads + PatchDiff annotations |
| 23 | **P2** | 🎨 | SourceControlPanel has no `present:false` guard | Doomed `gitStatus` on a removed worktree → raw GitError | S | Check `workspace.present` before rendering ChangesView |
| 24 | **P2** | ⚙️ | Trunk read-only is incidental, not asserted | A future change could silently make main writable | S | Add an explicit read-only assertion on the trunk write path **— ✅ DONE (§0)** |
| 25 | **P2** | ⚙️ | git_op analytics records only `pr_create` | Commit/push/pull volume invisible | S | Emit `git_op` from engine ops, or track agent git **— ✅ DONE: UI ops (§0)** |
| 26 | **P3** | 🎨⚙️ | Untracked files can't be discarded from UI | No delete affordance for new files | S | `gitClean` façade (engine `clean()` exists) + enable the disabled row action |
| 27 | **P3** | 🎨⚙️ | No stash | Common SCM op; engine + bridge exist | M | Façades + UI |
| 28 | **P3** | 🎨⚙️ | No approve / request-changes / reviewers / assignees | Human reviewer can't record a verdict | L | New engine `pulls.createReview` + facade + UI |
| 29 | **P3** | 🎨 | No side-by-side / word-diff / expand-context / in-diff search | Reviewer preferences; lib supports most | M | Surface `diffStyle`/`lineDiffType`/`expandUnchanged` + toggles |
| 30 | **P3** | 🎨 | No keyboard shortcuts in Changes; no next/prev nav | Power-user friction | S | Add shortcuts |
| 31 | **P3** | 🎨 | Commit amend unreachable | `gitCommit` accepts `amend`, no UI | S | Surface once a commit UI exists |
| 32 | **P3** | 🎨⚙️ | Trunk branch label hardcoded "main" | Wrong header on a non-main root checkout | S | Surface engine HEAD back to the renderer |
| 33 | **P3** | 🎨 | No NotAGitRepo / Init / Publish on web | Web user gets no explanation on a non-git trunk | M | Intentional host-FS limit; add an explanatory empty state |
| 34 | **P3** | 🎨 | No ReviewView test coverage | State-machine regressions uncaught | M | Add React tests |
| 35 | **P3** | ⚙️ | Dead engine surface: `worktree-vs-head` diff mode, legacy `against` selector, no-op trunk "All" diff | Unexercised paths | — | Document or remove **— ✅ DONE: documented (§0)** |
| 36 | **P3** | 🎨 | `useChangeCount` no `.catch` on non-git trunk | Unhandled rejection (benign) | S | Add `.catch` |

---

## 10.1 UI work index — everything that needs UI work

The **28 of 36** items from §10 that touch the renderer (🎨 or 🎨⚙️), grouped by the UI surface they land on. **Type:** *New* = a new component/view/control to create · *Change* = modify an existing surface · *Fix* = small UI bugfix · *Test* = UI test coverage. (The 8 backend-only ⚙️ items — #1, #4, #5, #8, #18, #24, #25, #35 — are **not** here; they need no UI work.)

**By type:** 🆕 **15 New UI** · ✏️ **4 Change** · 🔧 **8 Fix** · 🧪 **1 Test**.
**By file (where the UI work lands):** most of A/B live in `src/shell/column3-tabs/changes-tab.tsx` + `changes-parse.ts` + `diff-theme.ts`; most of C lives in `src/shell/column3-tabs/review-tab.tsx`; new façades sit in `src/native/git.ts`.

### A. Changes view — file list + per-row actions + comparison bar
*(file: `changes-tab.tsx`)*

| # | P | UI | Type | Item |
|---|---|---|---|---|
| 2 | **P0** | 🎨⚙️ | New | **Commit control** wired to the intact `gitCommit` façade, **or** an "Ask the agent to commit" CTA (prefill composer) — closes the post-removal commit hole |
| 3 | **P1** | 🎨⚙️ | Change | Subscribe the panel to live git changes (agent/terminal commits appear without manual Refresh) |
| 15 | **P2** | 🎨⚙️ | New | Branch create / switch / delete menu (engine `branch.ts` ready) |
| 20 | **P2** | 🎨 | New | Bulk Stage-all / Unstage-all / Discard-all controls |
| 12 | **P2** | 🎨⚙️ | Fix | Populate BranchSelect over the relay (add `.catch`; backend allowlist) |
| 23 | **P2** | 🎨 | Fix | `present:false` guard before rendering ChangesView (avoid raw GitError on a removed worktree) |
| 26 | **P3** | 🎨⚙️ | Change | Enable the disabled "Discard" action for untracked files (delete new file) |
| 27 | **P3** | 🎨⚙️ | New | Stash UI |
| 30 | **P3** | 🎨 | New | Keyboard shortcuts + next/prev-file nav |
| 32 | **P3** | 🎨⚙️ | Fix | Show the trunk's real branch label (not hardcoded "main") |
| 36 | **P3** | 🎨 | Fix | `useChangeCount` `.catch` (silence the badge's unhandled rejection) |

### B. Diff pane — the file-click diff experience
*(files: `changes-tab.tsx` diff pane · `changes-parse.ts` · `diff-theme.ts`)*

| # | P | UI | Type | Item |
|---|---|---|---|---|
| 9 | **P1** | 🎨 | Fix | Stop tracked-binary raw text leak — check `f.binary` and show a placeholder/preview |
| 10 | **P1** | 🎨 | New | Diff-too-large guard (truncate + "open file" affordance) |
| 6 | **P1** | 🎨⚙️ | New | Per-hunk / per-line staging (accept/reject hunk in PatchDiff; needs façades) |
| 19 | **P2** | 🎨 | Change | Image/binary diff in the pane (reuse `file-viewer` handling) |
| 29 | **P3** | 🎨 | New | Diff view toggles: side-by-side / word-diff / expand-context / in-diff search |
| 31 | **P3** | 🎨 | Change | Surface commit "amend" (once a commit UI exists) |

### C. Review view — PR header + sub-tabs
*(file: `review-tab.tsx`; some need a new `native/git.ts` façade)*

| # | P | UI | Type | Item |
|---|---|---|---|---|
| 7 | **P1** | 🎨⚙️ | New | Commit log / branch history view (engine `log()` exists; needs `gitLog` façade) |
| 11 | **P2** | 🎨 | Fix | Wire header Refresh into ReviewView + its sub-effects (currently a no-op) |
| 13 | **P2** | 🎨 | Fix | Guard the Merge button on `mergeableState` (don't offer a doomed merge) |
| 16 | **P2** | 🎨 | Fix | Disable "Add to chat" when no chat is active (currently a silent dead button) |
| 17 | **P2** | 🎨⚙️ | New | Edit PR title/body (engine `updatePr`/bridge exist; needs façade + form) |
| 21 | **P2** | 🎨 | New | Attach / open an existing PR (picker over `ghPrList`) |
| 14 | **P2** | 🎨⚙️ | New | In-app conflict resolution UI (ours/theirs/Continue/Abort) |
| 22 | **P2** | 🎨⚙️ | New | Inline per-line PR comment threads (PatchDiff annotations) |
| 28 | **P3** | 🎨⚙️ | New | Approve / request-changes / reviewers / assignees |
| 34 | **P3** | 🎨 | Test | ReviewView state-machine React tests |

### D. Cross-surface / empty states

| # | P | UI | Type | Item |
|---|---|---|---|---|
| 33 | **P3** | 🎨 | New | Explanatory empty state for a non-git trunk on web (NotAGitRepo is desktop-only) |

> **Reading this for a UI sprint:** the P0/P1 UI work is small and high-impact — items **#2, #3** (close the commit hole + make the panel live), the diff-pane fixes **#9, #10, #6**, the commit-log view **#7**, and the Review fixes **#11, #13, #16**. Everything in C marked *New* (#14, #17, #21, #22, #28) is net-new review UI to design.

---

## 11. Verified breakage register

| Claim | Verdict | One-line reasoning |
|---|---|---|
| Refresh no-op on Review (ReviewView gets no `refreshKey`) | **confirmed-broken** | `changes-tab.tsx:191-200` keys only `workspaceId`, no `refreshKey`; zero refs in `review-tab.tsx` |
| Unhandled rejection: `useChangeCount` no `.catch` on a non-git trunk | **confirmed-broken** | `void gitStatus(repoRoot).then(...)` no catch; engine `status()` throws on a non-repo; fires only on connected desktop |
| Tracked binary leaks raw text into PatchDiff | **confirmed-broken** | `binary` parsed but never read; truthy-`patch` branch wins; placeholder fires only on `''` |
| Split (side-by-side) unreachable | **confirmed-broken** | `diffStyle` defaults 'unified'; all 3 call sites pass no arg; no toggle |
| Per-hunk/line staging unreachable | **confirmed-broken** | Read-only PatchDiff; no `native/git.ts` hunk façade; backend exists (`service.ts:1570-1588`) |
| Refresh re-fetches nothing on Review | **confirmed-broken** | Duplicate of #1; `loadPr` deps `[workspaceId, prNumber]` only |
| "Add to chat" silent no-op with no active chat | **confirmed-broken** | `chatId:null` has no consumer; EmptyComposer fallback deleted 2026-06-18 |
| Create-draft-PR fails opaquely for unpushed branches | **partially-true** | Mechanism confirmed; only when branch never pushed — agent-pushed → succeeds |
| Engine remediation never reaches the Review UI | **confirmed-broken** | Bridge `WorkspaceErrorLike` is `{code,message}` only; throws `new Error(resp.message)` (verified) |
| createPr/getPr throw a raw non-GitError when no origin | **confirmed-broken** | `workspaceRemote` raw `execFile`, no try/catch, runs before `withAuthRetry` (verified `github.ts:499-509`) |
| BranchSelect empty over relay | **confirmed-broken** | `git.listAllBranches` absent from REMOTE_READABLE → `REMOTE_OP_NOT_ALLOWED`; `.then` no `.catch` |
| Stage/unstage/discard silent no-op during bridge startup | **confirmed-broken** | Façades early-return on null bridge (not `requireBridge`); `act()` runs success path; bounded to startup window |
| Agent "commit and push" unreliable (no tool/prompt/flow) | **confirmed-broken** | Whole-tree grep of `src/engine/agents/` finds zero git guidance; preset only stamps `<env>` |
| Changes view stale after agent commit until manual Refresh | **confirmed-broken** | No `DB_CHANGED`/watch/poll/session-update subscription in `column3-tabs/` |
| No live freshness source in the Source tab | **confirmed-broken** | Only triggers: Refresh button, row `onChanged`, target remount |
| git_op funnel records `pr_create` only | **confirmed-broken** | Only call-sites `review-tab.tsx:131/133`; engine never emits `git_op`; agents bypass engine ops |

**Refuted / corrected:** none of the claims were refuted. The recurring imprecision across reports is **line-number drift** (the new "All Files" sub-tab shifted `changes-tab.tsx` lines ~10–60 down, and the Refresh button is now at `:145`, ReviewView at `:191-200`); every cited *code path* held on direct re-read.

---

## 12. Prioritized recommendations / suggested roadmap

> Each item carries its work-type tag (🎨 UI · ⚙️ backend · 🎨⚙️ both), so a UI-only sprint can lift every 🎨/🎨⚙️ line.

### Fix now (P0 / P1)

1. ⚙️ **Make Create-draft-PR work** (gaps 1, 8). Push the head branch inside `createPr` before `pulls.create`; add 422 mapping with actionable remediation; add a draft-unsupported retry; wrap `workspaceRemote`. Add tests for unpushed/no-origin/422.
2. 🎨⚙️ **Close the commit hole** (gap 2). Ship the lowest-friction option first — a thin **Commit** control wired to the intact `gitCommit` façade with a message input — *or*, if committing to the agent-driven model, add an "Ask the agent to commit" CTA (`ENQUEUE_COMPOSER_APPEND`) **plus** agent-prompt git guidance (gap 4, ⚙️). Either way, do not leave Stage live with no commit path.
3. 🎨⚙️ **Live-refresh the Source tab** (gap 3). Subscribe `changes-tab.tsx`/`review-tab.tsx` to `DB_CHANGED` and agent turn-end (🎨); emit a `git`-scoped engine broadcast after writes (⚙️). This is what makes both the agent-driven model and external git changes visible.
4. ⚙️ **Stop dropping `remediation` at the bridge** (gap 5). One small change that improves every git/gh error in the app.
5. 🎨⚙️ **Per-hunk staging + commit log** (gaps 6, 7). Both are fully plumbed in the engine/bridge — they need façades + UI. High value-per-effort.
6. 🎨 **Fix the binary diff leak + add a large-diff guard** (gaps 9, 10).

### Soon (P2)

- 🎨 Wire `refreshKey` into ReviewView (gap 11).
- 🎨⚙️ Add `git.listAllBranches` to REMOTE_READABLE (⚙️) + `.catch` (🎨) (gap 12).
- 🎨 Guard merge on mergeability (gap 13); 🎨⚙️ add branch create/switch/delete (gap 15); 🎨⚙️ PR title/body edit (gap 17); 🎨 attach existing PR (gap 21).
- ⚙️ Fix Commits-sub local-diff fragility (gap 18); 🎨 image/binary diff in pane (gap 19); 🎨 bulk stage/discard (gap 20).
- 🎨 Disable "Add to chat" with no active chat (gap 16); 🎨 `present:false` guard (gap 23); ⚙️ explicit trunk read-only assertion (gap 24).
- 🎨⚙️ In-app conflict resolution and inline PR comments (gaps 14, 22) — larger, schedule deliberately.
- ⚙️ Restore commit/push/pull (or agent-git) analytics (gap 25).

### Later (P3)

- 🎨⚙️ Untracked discard via `clean()` (gap 26); 🎨⚙️ stash (gap 27); 🎨⚙️ approve/request-changes + reviewers (gap 28).
- 🎨 Diff viewer polish: split/word-diff/expand-context/search (gap 29); 🎨 keyboard nav (gap 30); 🎨 commit amend (gap 31).
- 🎨⚙️ Trunk branch label accuracy (gap 32); 🎨 web NotAGitRepo explanation (gap 33); 🎨 ReviewView tests (gap 34); ⚙️ document/remove dead engine surface (gap 35); 🎨 `useChangeCount` `.catch` (gap 36).

### Closing note

The Source tab's backend is genuinely strong — hardened `runGit`, a complete git/GitHub op set, a clean read-only trunk model, real secret-filtering on the relay. The work is almost entirely in the **renderer surface and the agent handoff**: expose the ops that already exist, make the panel live, and either restore a commit control or actually engineer the agent-driven commit it now depends on. The single most urgent item is **Create-draft-PR**, because it is broken *today* in the default flow; the most strategically important is closing the **commit hole + live refresh**, because the commit-bar removal turned an assumption ("the agent will commit") into the product's only persistence path without building the machinery to back it.

---

## 13. REDESIGN DIRECTION (2026-06-19, evening) — list-only Changes · row-1 diff viewer · agent-driven PR

> **Authoritative plan.** Captures three user-requested changes that re-shape the Changes and Review views. It **redesigns** the inline-diff-pane *location* (§4 → diffs move to row 1) and **re-sequences** the Review PR surface (§5 → a pre-PR create form + a redesigned post-PR review view), and re-presents several §10 gaps (map in §13.8). §1–§12 stay as the current-state *why*; §13 is the *what to build*. Tags: 🎨 UI · ⚙️ backend · 🎨⚙️ both. All line refs verified against the working tree on `iamarunrk/austin`.
>
> **🔒 Nothing is cut.** This redesign changes the Source tab's **UI/UX approach and sequencing** — it **preserves every capability** in §1–§12. Features that look "removed" in the screenshots are **relocated or re-sequenced**, never dropped: the diff viewer **moves to row 1** (§13.3); the full PR review surface (checks/CI, commits, reviews, merge) **re-appears after the PR is created** (§13.4 **Phase B**). §10 items are **preserved and re-presented** (§13.8). Implementation is **step-by-step and non-destructive** — each existing feature gets its new presentation before any old surface is retired.

### 13.1 Intent (in the user's words)

1. **Changes = a plain list of changed files.** Clicking a file must **not** open a diff in a pane below the list. It opens that file **in row 1** (the file viewer at the top of Column 3) **with a Diff toggle**. The diff-viewing options ("how to show the diff") live in row 1.
2. **Review = two-phase, and nothing is cut.**
   - **Phase A — no PR yet:** a PR **title** input + a PR **description** textarea + a **Create PR** button. This replaces *only* the old "No pull request yet / Create draft PR" empty state (`UV1V9F`) with the `aVHE5c` form.
   - **Phase B — PR created:** the AI generates the PR title/description and the Review tab shows a **redesigned rich PR view** (`fyFjSF`): PR header (title + state badge + branch→base + description) and the **Changes / Commits / Checks / Review** sub-tabs. *Every §5 capability is retained* — checks/CI, commit list, review timeline + comments, mark-ready, merge — re-styled to `fyFjSF` and shown after creation.
3. **Create PR = a button that messages the agent.** Clicking **Create PR** auto-sends a contextual *PR-instructions* message into whichever agent chat is open. The message embeds the live branch, target branch, uncommitted-change count, upstream state, and the user's PR title + description; the agent then commits, pushes, and runs `gh pr create`. (Button placement is **TBD** — the user will specify later.)

This is the **Conductor model**. Attached screenshots: `f4XUkF` (file in row 1 with a Diff/Edit toggle), `ogtyVe`/`8C4rNV` (flat/tree changed-file list), `aVHE5c` (PR title + description), `Yv0qIL` ("Create a PR · 📄 PR instructions.md" pill), `di68mk`/`MNxm0j` (the PR-instructions message body) = the **target**. `nnoVIs` (current inline diff pane) and `UV1V9F` (current Create-draft-PR empty state) = what we **replace** — the diff *relocates* to row 1; the empty state *becomes* the Phase-A create form. Neither is a feature cut.

---

### 13.2 Change 1 — Changes view becomes list-only (the inline diff pane moves to row 1)

> The diff **capability is preserved** — it **relocates to row 1** (§13.3). What's removed here is the inline *pane* UI (`nnoVIs`), exactly as requested; no diff feature is lost.

**Architecture correction (vs §1/§3):** there is no `SourceControlPanel` component anymore. The three Source views are row-2 tabs owned by `TerminalFloatingPanel` (`terminal-floating-panel.tsx`); `changes-tab.tsx` exports a `SourceView` body switching on a `view` prop. Row 1 is a per-worktree multi-tab system in the **workspace store** (`column3ByScope`), already used by **All Files**.

**Delete** (all in `src/shell/column3-tabs/changes-tab.tsx`):

| What | Where | Note |
|---|---|---|
| `selectedPatch` state | `:422` | the inline-pane patch |
| `allFiles` memo + the `selectedPatch` resolver effect | `:507-538` | the memo exists only to feed this effect |
| Bottom diff-pane JSX (`{selected && …}`: "Loading diff…", "No textual diff", `<PatchDiff>`) | `:656-673` | |
| `syntheticAddPatch` helper | `:1026-1037` | only consumer is the deleted effect — **moves to row 1** (13.3) |
| Now-unused imports `PatchDiff` (`:42`), `zerosDiffOptions` (`:80`), `readWorkspaceFile` (`:57`) | | keep `diff-theme.ts`/`changes-parse.ts` — shared elsewhere |
| The list/diff flex split | `:614-674` | collapse the two-child split into one scrolling list |

**Repurpose — the file-row click.** Today `FileRow` `onClick → onSelect("${kind}:${path}")` (`:876`, props at `:633`/`:647`) drives the pane. Re-point it to **open the file in row 1**, reusing the `openInRow1` flow already proven in `AllFilesView` (`:224-247`): find the existing preview `files` tab → `UPDATE_COLUMN3_TAB { filePath, title }` → `ACTIVATE_COLUMN3_TAB`; else `ADD_COLUMN3_TAB createFilesTab(path, { preview:true })`. Pass a **diff intent** so the viewer opens in Diff mode (13.3). `ChangesView` lacks `tabs`/`dispatch` today — add `useColumn3Tabs()` + `useWorkspaceDispatch()` (already imported at `:61`) or lift `openInRow1` to a shared helper used by both views. Reusing the single preview tab means clicking through changed files swaps row-1 content in place (exactly the desired behavior).

**Keep unchanged** (not coupled to the pane): the comparison bar (`:581-612`) — branch label, **BranchSelect** base picker, **FilterSelect** (Uncommitted/All), totals, flat/tree **ViewToggle** (this *is* the `ogtyVe`/`8C4rNV` behavior); `reload()` (`:440-499`) + `parseUnifiedDiffFiles` + `buildFileTree`; per-row Stage/Unstage/Discard (`act()` `:556-577`, buttons `:887-905`, `readOnly` hides on trunk).

**Selection-as-highlight (optional):** keep a lightweight `selected` path only to highlight which row is open in row 1; the `${kind}:${path}` composite key is no longer needed to disambiguate diffs, so plain path suffices.

**Cheaper list later (optional ⚙️):** `reload()` fetches `rawPatch:true` and `parseUnifiedDiffFiles` does double duty (list metadata *and* the now-deleted inline diff). Short-term keep it (+N/−M come free; row 1 re-fetches its own single-file diff). A later optimization (drop `rawPatch`; build the list from `git status` + `--numstat`/`--name-status`) needs a **new engine numstat mode that doesn't exist yet** — out of scope for the first cut.

---

### 13.3 Change 1b — the row-1 Diff viewer (the only genuinely new piece)

**Today row 1 cannot show a diff.** `FilesTab` → `<FileViewer cwd path>` (`files-tab.tsx:27-29`) renders **content only**, read-only, with just a markdown Preview/Code toggle (`file-viewer.tsx:132-150`); no `@pierre/diffs` import in row 1.

**Plan:**

1. **Carry a diff intent on the tab.** Add optional fields to `Column3Tab` (`column3-tab-manager.ts:25-47`) and `createFilesTab` (`:83-94`) — e.g. `diff?: boolean` (open in Diff mode) + `diffBase?: string` (set only for the "All changes" filter's compare base). Opening from Changes sets `diff:true`; opening from All Files leaves it unset (Source view). Persist only `diff`+`diffBase` (not staged/unstaged kind, which changes when the user stages) so it stays robust across remounts/localStorage.
2. **Thread `workspaceId` to the viewer.** `gitDiff` needs a `workspaceId`, but `FilesTab` only gets `cwd` (`useChatCwd()`). Resolve it live from `useActiveWorkspace().workspace.id` (row 1 is per-active-workspace anyway) — don't persist a stale id on the tab.
3. **Fetch + render.** When `diff` is set, call `gitDiff({ workspaceId, filePath, mode, rawPatch:true })` (`git.ts:454-466`; `filePath` param already exists) and render `<PatchDiff patch options={zerosDiffOptions({ diffStyle })} disableWorkerPool/>` — the same primitives the old pane used. **Mode:** `worktree-vs-head` for the uncommitted case (working tree vs HEAD = staged + unstaged combined for that file — no need to track which side); `refs` with `base=diffBase, head:"HEAD"` for the "All changes" case. **Untracked** → reuse `syntheticAddPatch(path, content)` (moved here) after a `readWorkspaceFile`.
4. **The toggle.** A header chip (copy the markdown Preview/Code chip at `file-viewer.tsx:132-150`) switching **Diff ⇄ Source**. Default Diff when opened from Changes, Source from All Files. **The diff "options" the user mentioned live here:** `zerosDiffOptions` already supports `diffStyle:'split' | 'unified'` (`diff-theme.ts:55-69`), so the **unified/split** toggle (the split view in `f4XUkF`) is nearly free; word-diff/expand-context are later additions.
5. **Carry over the §4 defects as row-1 requirements** (they move, they don't vanish): the tracked-binary raw-text leak (§4.3 — check `f.binary` first), image preview (§4.5 — reuse `file-viewer`'s existing image path), and the **large-diff guard** (§4.4 — truncate + "open file").

**Label decision (D2):** `f4XUkF` shows "Diff / Edit", but in Conductor "Edit" opens an editor. **Zeros row 1 is read-only** — no editor exists. Label the non-diff side **"Source"** (or "File"), not "Edit", until an editor exists. The "Viewed" checkbox in `f4XUkF` is a Conductor mark-reviewed affordance the user didn't request — **out of scope**.

**Edits:** `files-tab.tsx` (thread workspaceId + diff intent), `file-viewer.tsx` (Diff/Source toggle + PatchDiff branch + binary/image/large handling), `column3-tab-manager.ts` (`diff?`/`diffBase?`), `changes-tab.tsx` (set intent on open). All 🎨.

---

### 13.4 Change 2 — Review view = two-phase (pre-PR create form → post-PR rich view)

> **Nothing here is removed.** An earlier draft of this section read "delete the PR state machine" — that was **wrong** (D7 corrected 2026-06-20). The current §5 Review surface is **preserved and redesigned**, split into two phases keyed on whether a PR exists. No `review-tab.tsx` capability, façade, or sub-tab is cut; the gh* façades, `PatchDiff`, sub-tab components and `MergeControls` all stay (Phase B uses them).

**Phase A — authed, no PR yet (the create form, `aVHE5c`).** Replace *only* the "No pull request yet / Create draft PR" empty state (`review-tab.tsx:149-164`, the `UV1V9F` screen) with a small form:
- **PR title** `Input` (default = branch name; today's create used `branch || "Changes"`),
- **PR description** `Textarea` (`src/zeros/ui/primitives/textarea.tsx`, **not yet imported here** — add it; same `@/zeros/ui/primitives` barrel as `Button`/`Input` at `:44-51`),
- **Create PR** `Button` → assembles + auto-sends the agent message (§13.5). The agent commits, pushes, and runs `gh pr create` (and may refine / generate the title + description).

Keep the auth gate (`:94-118`) and the read-only-trunk gating (changes-tab.tsx:184-200) exactly as they are.

**Phase B — PR created (the redesigned rich view, `fyFjSF`).** Once `prNumber` resolves (see §13.5 D8 on *how* Zeros learns it), render the **existing** PR surface, **kept in full and re-styled** to `fyFjSF`:
- **PR header:** title + state badge (draft/open/merged/closed) + branch→base + the AI-generated description. (Today's header `:168-223`, `StateBadge` `:608-621`.)
- **Sub-tabs:** **Changes / Commits / Checks / Review**, with the checks summary folded into the tab label ("✓ All Checks Passed 1/1" in `fyFjSF`). All four current sub-tab components stay: `ChangesSub` (`:262-314`), `CommitsSub` (`:318-394`), `ChecksSub` (`:398-455`), `ReviewsSub` (`:459-569`).
- **File list** (Changes sub-tab): the flat list with +N/−M and a **per-file viewed/review state** (the eye icons + New/Deleted badges in `fyFjSF`) — a UI upgrade over today's plain list (per-file "viewed" is net-new, optional). For consistency with §13.2, clicking a file here should **also open it in row 1** with the Diff toggle (§13.3) rather than an inline pane.
- **Merge / mark-ready / comment** (`MergeControls` `:573-606`, `ghPrComment`, `ghPrMarkReady`, `ghPrMerge`) — retained.

**Phase B is a re-skin, not a rebuild.** Deltas: flatter file rows + per-file viewed-state, checks summary in the tab label, cleaner header, file-click opens row 1. The §5/§10 Review bugs get **fixed in place** during the re-skin — #11 (Refresh wiring), #13 (merge-guard on `mergeableState`), #16 (add-to-chat no-op) — see §13.8.

**Persist the Phase-A draft per-workspace.** `ReviewView` force-remounts on workspace switch (`key={workspaceId}`, changes-tab.tsx:188) and on reload, so `useState` is lost. Mirror the composer-draft pattern (`chatComposerDrafts` + `persist-composer-drafts.ts`, `SET_CHAT_DRAFT`/`CLEAR_CHAT_DRAFT`, store.tsx:233 / workspace-store.ts:79-80): add `prDraftByWorkspace: Record<workspaceId, { title; body }>` with `SET_PR_DRAFT`/`CLEAR_PR_DRAFT`, keyed by `workspaceId`, cleared on successful send.

**Imports:** **none become dead** — the gh* façades, `PatchDiff`, sub-tab components and `MergeControls` are all still used by Phase B. The only addition is `Textarea` (Phase-A description) and a small "Create PR" send path (relocate `useWorkspaceStore`/`useWorkspaceDispatch` to the top level).

---

### 13.5 Change 3 — Create PR = an agent message (auto-sent)

**The send path already exists — use `ENQUEUE_CHAT_SUBMISSION` (auto-send), not `ENQUEUE_COMPOSER_APPEND` (prefill).**

- `ENQUEUE_CHAT_SUBMISSION` (store.tsx:288-318; action workspace-store.ts:89/`:405`) is consumed in `agent-chat.tsx:1835-1860` → `handleSend → sendPrompt`: the message appears as a **real sent user turn** and spawns/streams the agent. It routes by **`activeChatId === chatId` of the mounted chat** (no explicit `chatId` field), gating on `session.status === "ready"` + no pending permission. (The screenshots show a *sent* bubble, so this is the right primitive; the prefill path `:1866-1878` only stages text.)
- **Active chat:** `activeChatId` (store.tsx:184; `useActiveChatId()`). A chat stores a `folder`, not a workspace; the workspace is derived via `useActiveWorkspace()` — the **same record the Review tab already uses**. Multiple chats per workspace are allowed (the 4-tab cap was removed), so target the *active* one.
- **No active chat / not ready:** disable Create PR (or hint to open a chat). Without an `activeChatId` match the submission is dropped.

**The message template — assembled in the renderer** (all inputs are local: workspace record + a `gitStatus` count + the typed title/description). Target format (from `di68mk`/`MNxm0j`), contextualized:

```
The user likes the current state of the code.

There are {N} uncommitted change(s).
The current branch is {branch}.
The target branch is origin/{baseBranch}.
{upstreamLine}                      ← "There is no upstream branch yet." | "An upstream branch exists."

The user requested a PR.

Follow these steps to create a PR:
- If you have any skills related to creating PRs, invoke them now. Instructions there take precedence.
- Run `git diff` to review uncommitted changes.
- Commit them. Follow any commit-message instructions the user gave you.
- Push with `git push -u 'origin' HEAD:'{branch}'`.
- Run `git diff origin/{baseBranch}...HEAD` to review the full PR diff.
- Use `gh pr create --base {baseBranch} --title <title> --body <description>` to open the PR.

If any of these steps fail, ask the user for help.

## PR Title
The user has provided this PR title. Use it exactly as-is:
{title}

## PR Description
The user has provided this PR description. Use it exactly as-is:
{description}
```

> **Conditional title/description blocks.** Include the *PR Title* / *PR Description* sections **only if the user filled them**; if a field is blank, omit its block and let the agent **generate** it — mirroring the two reference messages (`di68mk` has no title/body sections; `MNxm0j` includes them). Per the user: after creation the **AI generates** the final title/description, which then populate the **Phase-B** header (§13.4).

**Field sources:**

| Field | Source | Status |
|---|---|---|
| `{branch}` | `Workspace.branch` (git.ts:108) | ✅ exists |
| `{baseBranch}` / target | `Workspace.baseBranch` (git.ts:109), prefix `origin/` | ✅ exists (name only) |
| `{N}` uncommitted | `gitStatus(workspaceId)` summed — the `useChangeCount` pattern (changes-tab.tsx:267-289) | ✅ exists |
| remote = `origin` | hardcoded default everywhere (ops.ts:121); no dynamic lookup | ✅ default |
| `{title}` / `{description}` | the form's per-workspace draft (13.4) | ✅ (this work) |
| `{upstreamLine}` upstream exists? | **no read-only op reports this** | 🔴 **needs a small new engine op** |

**The one backend gap (⚙️, optional first cut):** nothing today tells the renderer whether `origin/{branch}` exists. Add `gitUpstreamStatus(workspaceId)` (engine op + bridge + `native/git.ts` façade) running e.g. `git rev-parse --abbrev-ref --symbolic-full-name @{u}` (or `git ls-remote --heads origin {branch}`) → `{ hasUpstream: boolean }`. **Fallback if not built now:** omit the upstream sentence, or use a heuristic (a just-created worktree has no upstream). The `git push -u …` line works either way (agent instruction, not a Zeros call), so this does **not** block the feature — it only affects one sentence's accuracy.

**Drop the MCP line.** The reference says "Use `mcp__conductor__GetWorkspaceDiff`…" — **Zeros has no MCP server and no equivalent tool** (`gateway.ts:196` `mcpServers = []`, never populated). Replace that step with the plain `git diff origin/{baseBranch}...HEAD` instruction above (the agent has a Bash tool with the worktree as cwd).

**Optional Conductor-style pill (🎨, cosmetic).** To render "Create a PR · 📄 PR instructions.md" in the sent bubble (`Yv0qIL`), pass `submission.segments` (store.tsx:313-317) — e.g. `[{type:"text", text:"Create a PR"}, {type:"attachment", name:"PR instructions.md", mimeType:"text/markdown", kind:"text"}]`. `UserBubbleAttachment` (text-message.tsx:231-271) already renders an icon+filename pill. **Caveat:** an `attachment` segment contributes **empty wire text**, so the actual instructions must live in `submission.text` regardless — the pill is decorative. A *real* on-disk `PR instructions.md` the agent can `Read` would be new plumbing (generate doc → write to worktree → mention its path) — defer.

**⚠️ Learning the PR after the agent creates it (D8) — now load-bearing.** Today the engine's `createPr` stamps `status:in-review`/`prNumber`/`prState`/`prUrl` (github.ts:647-651). The **agent-driven path runs `gh` itself and bypasses that stamping**, so the workspace won't learn its PR number/URL from this flow. Because **Phase B (§13.4) needs `prNumber` to render the post-PR view**, Zeros **must reconcile** the PR after the agent reports done — e.g. poll `ghPrList` by head branch (façade exists) on send-completion / Refresh and stamp `prNumber`/`prState`/`prUrl`, and/or optimistically set `status:in-review` on send. This was wrongly called optional in the first draft; with the two-phase model it is a **required ⚙️ addition** (small).

---

### 13.6 Open decisions (need the user)

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Create PR button placement** (user said "later") | TBD — likely the Review form footer; possibly also near the Changes header |
| D2 | Non-diff toggle label: "Edit" vs "Source" | **"Source"** — row 1 is read-only; "Edit" implies an editor we don't have |
| D3 | Default row-1 view when opening a *changed* file | **Diff** (they clicked a changed file); All-Files opens **Source** |
| D4 | Auto-send vs prefill on Create PR | **Auto-send** (`ENQUEUE_CHAT_SUBMISSION`) — matches the sent-bubble screenshots |
| D5 | Cosmetic "PR instructions.md" pill | Nice-to-have; ship text-only first, add the segment pill if desired |
| D6 | Upstream sentence accuracy | Ship the small `gitUpstreamStatus` op (cheap) **or** omit the sentence initially |
| D7 | Keep in-app PR viewing? | ✅ **RESOLVED (2026-06-20) — keep all of it.** Two-phase Review: a pre-PR create form, then the redesigned rich PR view (`fyFjSF`) after creation. Checks/commits/reviews/merge all retained (§13.4 Phase B). |
| D8 | Learn `prNumber`/`prUrl` after an agent PR | **Required, not optional** (Phase B needs it): reconcile via `ghPrList` by head branch on Refresh + stamp; optionally set `status:in-review` on send |

---

### 13.7 Work breakdown & sequencing

| Step | Layer | Scope | Files |
|---|---|---|---|
| 1. Changes → list-only; re-point row click to `openInRow1` (diff pane *relocates*, not removed) | 🎨 | S | `changes-tab.tsx` |
| 2. Row-1 Diff/Source toggle + per-file `gitDiff` + binary/image/large handling | 🎨 (⚙️ only if numstat) | M | `file-viewer.tsx`, `files-tab.tsx`, `column3-tab-manager.ts`, `changes-tab.tsx` |
| 3. Review **Phase A** — pre-PR create form (title + description) + per-workspace draft slice | 🎨 (+⚙️ store) | S–M | `review-tab.tsx`, `workspace-store.ts`, `persist-*` |
| 4. Create PR → assemble + `ENQUEUE_CHAT_SUBMISSION`; disable w/o active chat | 🎨 | S | `review-tab.tsx` |
| 5. Reconcile `prNumber`/`prUrl` after the agent's PR (so Phase B can load) — `ghPrList` by head branch on Refresh + stamp | ⚙️ | S | `review-tab.tsx` / engine |
| 6. Review **Phase B** — re-skin the *existing* PR view (header + Changes/Commits/Checks/Review + merge) to `fyFjSF`; file-click opens row 1; fix §10 #11/#13/#16 in place; optional per-file viewed-state | 🎨 | M | `review-tab.tsx` |
| 7. *(optional)* `gitUpstreamStatus` engine op + bridge + façade | ⚙️ | S | `engine/git/*`, `workspace-bridge.ts`, `native/git.ts` |
| 8. *(optional)* "PR instructions.md" segment pill | 🎨 | S | `review-tab.tsx` |

**Step-by-step, non-destructive order:** ship **1+2** together (the list needs somewhere for the click to land), then **3+4** (the pre-PR create flow), then **5+6** (learn the PR, then re-skin the post-PR view). Steps **7–8** are optional (one backend op, one cosmetic pill). **Nothing old is retired until its replacement ships** — e.g. today's Review sub-tabs keep working throughout the Phase-B re-skin.

---

### 13.8 Supersedes / reframes map (vs §10)

- **Preserved & re-presented (post-PR Phase B, redesigned UI — none dropped):** #11 (Refresh — wired into Phase B), #13 (merge guard — fixed in Phase B's `MergeControls`), #16 ("Add to chat" — fixed in Phase B's Reviews sub-tab), #17 (PR title/body — the Phase-A form + Phase-B header), #21 (attach existing PR — Phase B), #22 (inline PR comments — Phase B), #28 (approve/reviewers — Phase B). The Review surface **re-appears after the PR is created** (§13.4 Phase B), so these are **re-sequenced, not removed**. #2 (commit hole) is **addressed** by the agent-driven Create PR flow (a manual commit control also remains available in the plan — not cut). The createPr 422/remediation fixes (#1/#5/#8) stay relevant: the agent runs `gh` for the create, but Zeros still reconciles + reads the PR (§13.5 D8).
- **Relocated (still required, now in the row-1 viewer):** #9 (binary leak), #10 (large-diff guard), #19 (image diff), #29 (split/word-diff/expand — the "options in row 1"). #6 (per-hunk staging) is **deferred** — read-only row-1 viewer first.
- **Still relevant, now MORE urgent:** #3 (live refresh) — the Changes *list* must refresh after the agent commits/pushes, or the list looks stale exactly when the agent-driven PR flow runs. **✅ #3 implemented + verified 2026-06-20 (Steps A+B+C) — see §10 row 3.** #12 (BranchSelect over relay), #23 (`present:false` guard), #36 (`useChangeCount` `.catch`) — unchanged.
- **New work not in §10:** the row-1 Diff/Source viewer (13.3); the per-workspace PR-draft slice (13.4); the agent-message assembly + auto-send (13.5); the optional `gitUpstreamStatus` op (13.5).

> **Net:** the redesign is **non-destructive** — it re-homes and re-sequences existing capability rather than deleting it. The inline diff pane moves to row 1; the Review PR surface splits into a pre-PR create form + a redesigned post-PR view, **both keeping every §5 feature**. Two backend pieces are load-bearing: (1) **live-refresh of the Changes list (§10 #3)** after the agent commits, and (2) **reconciling `prNumber` after the agent's `gh pr create`** (§13.5 D8) so Phase B can render. Everything else is a UI re-presentation of capability that already exists.
