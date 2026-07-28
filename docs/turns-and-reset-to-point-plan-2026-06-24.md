# Turns + “Reset to this point” — Research, Analysis & Implementation Plan

_2026-06-24. Author: research pass over the Zeros codebase + comparable tools (Cline, Cursor, Aider, jujutsu). Began as a design/plan; the feature was then **built and hardened** on branch `jordan/active-tab-file-open`. See “Implementation status” (below), plus **§11 UI changes shipped** and **§12 Test plan** for the as-built state. Last updated 2026-06-25._

---

## 0. TL;DR

We want every completed agent response (a **turn**) to end with a footer showing **(1)** how long the agent ran (live timer + shimmer while running, final duration when done), **(2)** a **copy** button for the output markdown, **(3)** a **“…” menu** whose first action is **Reset to this point**, and **(4)** a row of **file-change pills** (`icon name +N −M`) with a `+N more` overflow that reveals 10 at a time. The Changes tab gets a **second dropdown** next to “All changes”, defaulting to **“No turns”**; opening it lists every turn (latest first) and selecting one filters the changes view to that turn. Clicking a footer pill deep-links into that same per-turn view.

The hard part is **concurrency**: in Zeros a *workspace = one git worktree*, and a worktree can host **many chats** that all write to the **same working tree** at the same time. So the central questions are **attribution** (“which file changes belong to *this* turn of *this* chat?”) and **selective reset** (“undo this turn without clobbering another chat’s concurrent edits”).

**The recommended answer, in one line:** attribute a turn’s changes from the **agent’s own edit/write/delete tool calls** (concurrency-immune, already persisted), snapshot the **content** of those files at turn boundaries, and implement reset as a **per-file three-way merge** (reverse-apply the turn) so a clean undo applies silently and a genuine collision **surfaces as a conflict instead of silently destroying** the other chat’s work — always taking a **snapshot-before-reset** so the reset itself is undoable.

---

## Implementation status — built 2026-06-24

All phases implemented in one pass. Decisions confirmed: authored-only turns; reset scope = this turn + all later turns of the same chat; snapshots exclude `.gitignore`d paths.

**Engine**
- `turns` table — migration **v13** (`src/engine/db/migrations.ts`) + `src/engine/db/turns.ts` (start/finish/get/list/delete + `rev`).
- Snapshots + attribution + 3-way reset — `src/engine/git/turns-git.ts` (whole-tree `commit-tree` into `refs/zeros/turns/*` via a scratch `GIT_INDEX_FILE`; authored set from tool calls; binary-safe `git restore` fast path; `git merge-file` 3-way; snapshot-before-reset). `runGit` gained an `env` option (`git-exec.ts`).
- Turn lifecycle hooks — `beginTurn`/`finishTurn` in the `AGENT_PROMPT` handler (`src/engine/index.ts`); `getChatLocation` (`db/chats.ts`).
- `turns.list/get/diff/reset/undoReset` commands + allow-lists (`src/engine/workspace/service.ts`); reset nudges `["workspaces"]`.
- **Turn-id correspondence:** the renderer's user-message id is sent on `AGENT_PROMPT` (`userMessageId`) and the engine persists the user message + keys the turn under it — so `turn.userPrompt.id` matches the engine turn id in a live session (the owning desktop ignores its own re-window nudges, so ids otherwise never converge). Also tightens the existing transcript-truncation path.

**Renderer**
- Footer — `src/zeros/agent/turn-footer.tsx`, rendered in `agent-chat.tsx` after `TurnEventList`: live timer / final duration, copy output, "…" → Reset to this point, authored pills + "+N more" (10/page), pill → per-turn diff in the viewer.
- Turn filter dropdown (`TurnSelect`) + turn-scoped list in `changes-tab.tsx`; `diffScope:"turn"` threaded through `column3-tab-manager.ts` → `use-open-file-in-row1.ts` → `files-tab.tsx` → `file-viewer.tsx` (fetches `turnDiff`). Renderer facade `src/native/turns.ts` + bridge fns in `workspace-bridge.ts`.

**Tests (all green):** `src/engine/git/__tests__/turns-git.test.ts` (snapshot, attribution, linear restore, **non-overlapping concurrent merge**, **overlapping conflict**, created-file delete), `src/engine/db/__tests__/turns.test.ts`; updated `db.test.ts` (schema v13). Typecheck + lint clean.

### Post-build hardening — 2026-06-24 → 2026-06-25

Manual testing surfaced real bugs and missing polish. All fixed on the same branch; full vitest suite green (**147 files / 1544 tests**), typecheck + lint clean, preload allowlist in sync.

**Attribution & pills**
- **Codex turns recorded 0 files (the "0 files" bug).** `pathsFromTool` only read scalar `rawInput` keys (`file_path`/`path`/…) + ACP `locations`. Codex's `fileChange` tool emits `kind:"edit"` but nests the path under **`rawInput.changes[].path`** with no `locations`, so attribution came back empty → the footer + the Changes-tab dropdown both showed "0 files". Now reads `changes[]`/`edits[]`/`files[]` arrays and attributes **every** path a single call touches (Codex patches can hit many). Claude (`file_path`) / Cursor (`path`) were already covered. Guarded by an **adapter-fidelity contract test**.
- **Footer pills missing `+N −M`.** When the engine record is empty (a turn recorded before the Codex fix, or one whose id hasn't reconciled), the footer falls back to `filesFromEvents`. It now computes the ± counts with the EditCard's own `resolveEditCounts(extractDiffSource(tool))`, so fallback pills show the identical `+N −M` to the edit rows above them — across Claude/Codex/Cursor (counts attributed only to the file the diff is actually for).
- **Pill styling** restyled to the tool-call `FileTag` recipe: `bg-bg1`, `border-border3`, `rounded-md`, hover `bg-bg2-hover`, file glyph 13px, counts inside the pill.

**Footer chrome**
- **Duplicate blue timer while streaming** — the footer rendered a second `LiveDuration` (blue `text-info`) directly under the existing grey `ActivityShimmer` timer (`text-fg2`). The footer now renders **nothing while live**; only the grey shimmer timer shows.
- **~20px gap above the footer** — it was a `TurnContainer` `flex-col gap-4` sibling, so it inherited the 16px container gap **plus** its own `mt`. Moved INTO `TurnEventList`'s 768 lane (where §6.1 specified) so it hugs the answer and the pills align under it.

**Reset safety & UX**
- **Confirm dialog** before reset (mirrors `discard-file.tsx` `DiscardDialog`), stating the scope and file count; when the turn has no snapshot it warns that **only the conversation** will roll back (the dialog reads `turn.preSnapshot`).
- **Skipped surfaced, never silent.** `applyTurnReset` now returns `skipped` as its own bucket (it was lumped into `applied`). The footer reports restored/conflicted/**skipped** counts through the **`toast`** surface (the foundation rule — replacing the old `console.warn`), so a snapshot-less reset that only rolled back the transcript is explicit.
- **Cancel-on-reset.** If a *later* turn is still streaming when you reset an older one, the in-flight turn is **cancelled first** (mirrors the edit-&-resubmit guard) so its trailing chunks can't re-persist into a timeline being deleted.
- **Transcript refresh on the initiating device.** After a reset the renderer truncates in-memory (`truncateMessagesFromInMemory`), so the turn + later turns visibly roll back and a stale footer can't double-reset into "unknown turn".

**Full-fidelity undo (headline addition).** Undo now restores the **files AND the full conversation** — user messages, every tool call with its inputs/outputs, the final answer — plus the turn rows. Migration **v14** `reset_undo` (`src/engine/db/reset-undo.ts`) stashes the about-to-be-deleted `chat_messages` + `turns` rows (keyed by a generated `resetId`) **just before** truncating; `turns.undoReset({resetId})` restores files (`undoTurnReset`) then re-inserts the rows at their **exact original ords** (`reinsertChatMessages`/`reinsertTurns`), rev-bumped to out-rev the truncate tombstone. **Guarded:** re-insert happens only when the chat wasn't continued past the reset (`maxChatMessageOrd(chat) < cutOrd`); otherwise files-only and the toast says so. The footer re-windows via `sessions.hydrateChat`. Capped at 5 records/chat.

**Persistence & retention**
- **Turn filter persisted.** `changes-turn-filter.ts` (mirrors `changes-scope.ts`) stores the selected turn `{chatId,turnId}` per workspace; restored against the fresh turns list (dropped if it was reset away).
- **Snapshot retention / gc.** `chats.delete` drops **all** of a chat's `refs/zeros/turns|resets/*` + its turn rows (`turns` has no FK cascade). A per-chat cap (`TURN_SNAPSHOT_RETENTION = 100`) prunes the oldest turns' refs on each new turn and nulls their OIDs (rows stay for the dropdown). Pre-reset snapshots capped at 5 (`pruneResetSnapshots`).

**Remaining limitations (intentional).** Undo of a chat that was **continued past** the reset restores files only (the original ords are taken) — the toast states this. Per-turn diff / re-reset of a turn whose snapshot was gc'd degrades to empty / skip (graceful). The turn-dropdown still lists by `workspace_id`, so the synthetic `local-main` trunk's turns may not appear (worktrees are fine). World side-effects (shell `rm`, network, installed packages) are never reverted — same as any checkpoint system.

---

## 1. How Zeros works today (grounding, with file:line)

### 1.1 Workspace / chat / turn model
- A **workspace** is a git **worktree** (own branch + own working directory). `src/engine/git/worktree.ts`. The repo trunk (“Local main”) is a synthesized workspace whose `path = repoRoot`.
- A **chat** is a conversation/agent session. **A workspace has many chats.** Table `chats` (`src/engine/db/chats.ts:58–83`): `id`, `folder` (agent cwd), `agentId` (`claude|codex|cursor`), `sessionId`, `workspace_id` (cached FK), `title`, `createdAt`… Multiple chats can run **concurrently in the same worktree**, all mutating the same files.
- A **turn** is **implicit today** — there is no `turns` table. Messages live in `chat_messages` (`src/engine/db/messages.ts:20–25`): `(chat_id, msg_id)` PK, `ord` (MAX+1), `kind` (`text|tool|…`), `payload` (JSON `AgentMessage`), `created_at`. Turns are reconstructed in the UI:
  - `groupMessagesIntoTurns()` and the `Turn { userPrompt, events[] }` shape — `src/zeros/agent/turn-container.tsx:57–125`.
  - `partitionTurn()` splits a turn into `working` (tools/thinking/narration) vs `finalOutput` (trailing agent/system text = the answer) — `src/zeros/agent/turn-partition.ts:59–74`.

### 1.2 Turn lifecycle in the engine (the snapshot hook point)
`src/engine/index.ts`, `AGENT_PROMPT` handler (~`1419–1471`):
```
1425  persistUserPrompt(sessionId, prompt, bubble)   // user turn persisted (this is the turn’s opening msg)
1430  enterPrompt()                                  // ← TURN START (busy marker)
1432  response = await agents.prompt(agentId, sessionId, prompt)  // ← TURN EXECUTION (streaming)
1437  AGENT_PROMPT_COMPLETE { stopReason: response.stopReason }    // ← TURN END (success)
1457  AGENT_PROMPT_FAILED   { error, failure }                     // ← TURN END (failure)
1468  finally { exitPrompt() }                                    // always
```
`sessionChat: Map<sessionId, chatId>` (`index.ts:259`) ties a session to its chat. Streaming chunks are folded by `applyUpdate` and persisted by `persistSessionUpdate` (`index.ts:1858`). **This handler is exactly where per-turn snapshots get created** (pre at ~1425–1430, post at ~1436).

### 1.3 Tool-call attribution is already captured
Every edit streams through as a `tool` message: `AgentToolMessage { toolKind: "edit"|"delete"|…, status, title, rawInput, … }` (`packages/core/src/agent-messages.ts:124–148`), rendered by `EditCard`/`FileTag` with `+N −M`. **These tool messages are the authoritative, per-chat, per-turn record of which files the agent itself touched** — and they’re already in `chat_messages`. This is the attribution signal that survives concurrency.

### 1.4 Changes tab & filter
- `src/shell/column3-tabs/changes-tab.tsx`. `ChangesView` (~`409`) computes the file list via `gitStatus` + `gitDiff` then `parseUnifiedDiffFiles` (`changes-parse.ts:48–100`) for `+N/−M`.
- **Scope** = `{kind:"all"} | {kind:"uncommitted"} | {kind:"commit", sha, message}` (`changes-scope.ts`), persisted in `localStorage` per workspace. Rendered by **`ScopeSelect`** (`changes-tab.tsx:818–899`) — a `DropdownMenu` listing All changes / Uncommitted / recent commits. **This is the dropdown the new “turn” dropdown sits beside.**
- Base/fork-point resolution + diff modes (`worktree-vs-base`, `base` (3-dot), `commit`) live in `src/engine/git/diff.ts` (`forkPoint` ~`320`, modes ~`217–249`).
- `Column3Tab` already carries `diffScope?: "all"|"uncommitted"|"commit"` + `diffSha?` (`column3-tab-manager.ts:25–60`) — the file viewer already renders scoped diffs, so a `turn` scope is a natural extension.

### 1.5 Primitives we can reuse (don’t reinvent)
- **Checkpoint commits, proven in-repo:** `src/engine/git/detach.ts` does `git add -u` → `git commit --allow-empty -m "zeros: detach checkpoint"` → `git read-tree --reset -u <sha>` and unwinds with `git reset --soft HEAD~N` (`trailingCheckpointCount`). It also models the safety bar: refuse mid-merge/rebase, refuse if the target tree is dirty (read-tree would destroy it), PID-lock, debounce. We mirror its discipline.
- **Transcript half of reset already exists:** `truncateChatMessagesFrom(chatId, fromMsgId)` deletes a message and everything after it, with a delta-sync tombstone (`messages.ts:149–167`). “Reset to this point” = this **+** a new file-restore step.
- **Git wrapper** (`src/engine/git/`): `diff.ts` (status/diff/log/showCommit), `restore.ts` (`reset`, `discardFiles`, `restoreFrom`, `clean`), `stage.ts` (hunk apply via `git apply`), `ops.ts` (commit/stash/revert). `runGit(cwd, args)` (`git-exec.ts`) centralizes invocation.
- **Engine command dispatch:** `git.*` cases at `index.ts:137–149`; new turn ops register here and emit a `["workspaces"]` cross-device nudge.
- **Duration UI already exists:** `LiveDuration`, `DurationChip`, `formatElapsed` (`src/zeros/agent/renderers/live-duration.tsx:43–109`) → “3m 42s”, 1 Hz tick, shimmer class `.zeros-agent-live-duration`. `RendererContext.activeTurnStartedAt` is the live start time.
- **Copy/menu patterns exist:** `UserMessageActions` (`turn-container.tsx:535–605`) already has a hover Copy + age badge; `ScopeSelect` shows the `DropdownMenu` pattern for the “…” menu.

---

## 2. Promote “turn” to a first-class, recorded entity

A turn is keyed by **`(chatId, turnId)`** where `turnId` = the `msg_id` of the user prompt that opened it (stable, already unique, already the truncation key). New table in `zeros.db` (migration v13):

```
turns(
  chat_id TEXT, turn_id TEXT,        -- (= opening user msg_id); PK (chat_id, turn_id)
  workspace_id TEXT,                 -- denormalized (like chats.workspace_id) for the Changes-tab query
  agent_id TEXT,
  ord INTEGER,                       -- ordering within chat (mirrors message ord)
  started_at INTEGER, ended_at INTEGER, stop_reason TEXT, status TEXT,  -- running|completed|failed|cancelled
  pre_snapshot TEXT, post_snapshot TEXT,   -- snapshot commit OIDs (see §4); null in Phase 0
  summary TEXT,                      -- short label for the dropdown (first line of the answer / prompt)
  rev INTEGER                        -- global nextRev() for delta sync, same pattern as messages
)
```
Optional `turn_files(chat_id, turn_id, path, old_path, change_kind, additions, deletions)` — the **authored** file set (from §1.3). Can also be derived on the fly from the turn’s tool messages; a table is just a cache/index for the dropdown + pills. **Duration = `ended_at − started_at`.**

Why a table and not pure derivation: the Changes-tab dropdown needs to list turns **across all chats in a workspace** cheaply and stably (independent of how much transcript is currently windowed in any renderer), and snapshots/labels must persist for cloud agents with no client attached — the same rationale the codebase already uses for persisting messages engine-side.

---

## 3. The concurrency problem — analysis & the core decision

### 3.1 Restating the scenario
Chat 1 and Chat 2 start together in one worktree. Chat 1 finishes editing 3 files; Chat 2 is mid-run with 2 of its 5 edits applied. At the instant Chat 1’s turn ends, the **working tree** differs from its start state by **5 files** (3 from Chat 1 + 2 from Chat 2). A naïve “diff the whole tree between turn start and turn end” would attribute **all 5** to Chat 1’s turn. The user correctly flagged this as wrong (“this is not exactly what you want to do”).

### 3.2 Why whole-tree snapshot-diffing is the wrong attribution
It **over-attributes**: it cannot tell Chat 1’s writes from Chat 2’s. It is also unstable (depends on interleaving/timing). Any feature built on it would show misleading pills and — far worse — a reset built on it would revert another chat’s work.

### 3.3 The reliable signal: the agent’s own tool calls
The authoritative “what did *this* turn change” is the set of files this turn’s **`edit`/`write`/`delete` tool calls** targeted (§1.3). It is **per-chat, per-turn, and immune to interleaving** — Chat 2’s writes never appear in Chat 1’s tool stream. Every adapter (Claude SDK / Codex / Cursor) surfaces edits as tool messages, so this is uniform.

### 3.4 **Decision: pills and reset are scoped to _authored_ changes.** (Recommended, and required for safety.)
- **Authored changes** (this turn’s tool-touched files) → drive the **pills** and are the **only** thing a reset touches.
- **Ambient changes** (everything else different in the tree right then — other chats, manual edits) → **not** this turn’s, **never** reset by this chat.

This resolves the apparent contradiction in the brief (“show only this turn’s changes” vs “we have to show the other changes too because it’s the turn”):
- The **pills** show **authored** files (so Chat 1’s turn shows its 3, not 5).
- The turn’s **detail view** (in the Changes tab) may show a **clearly-separated, read-only “also changed in the workspace during this turn”** section for transparency — but those are labeled as belonging to other chats/manual edits and are **excluded from reset**. This is opt-in visibility, not attribution.
- Chat 2’s 2 files belong to **Chat 2’s own turns** and appear there.

> **This is the single most important design decision.** Whole-tree turns are simpler but unsafe under Zeros’ multi-chat-per-worktree model. We choose authored-scoped turns.

---

## 4. Snapshot strategy (content capture for diff + reset)

We still need file **content** at turn boundaries (for per-turn diffs and for reset). Requirements: never touch the user’s real branch/index/working tree; survive with no client attached; cheap on large repos; gc-safe.

| Option | Mechanism | Pros | Cons |
|---|---|---|---|
| **(A) Whole-tree snapshot to a shadow ref via a scratch index** _(recommended)_ | `GIT_INDEX_FILE=<scratch> git add -A` (with excludes) → `git write-tree` → `git commit-tree <tree> -p <prev> -m "turn …"` → `git update-ref refs/zeros/turns/<chatId> <commit>` | Uses repo’s own object DB; trees/blobs dedupe (cheap even whole-tree); **scratch index leaves the user’s index untouched**; pinned by a ref under `refs/zeros/*` so it’s **invisible to `git log`/`status`/branches** yet gc-safe; `git show <oid>:<path>` works for any file | Whole-tree `add -A` cost on huge repos (mitigate with excludes + size/time guard); .gitignore handling needs care |
| (B) Per-file blobs | `git hash-object -w <file>` for each authored path; store OIDs in `turn_files` | Minimal work; only snapshots what we attribute | Loose objects need a pinning ref or they’re pruned after gc grace; reconstructing context (renames/deletes) is more manual |
| (C) `git stash create`/`store` | stash objects | Captures tracked+untracked together | Whole-tree only; awkward to scope per-turn/per-file; not designed as a queryable history |
| (D) Separate shadow git dir (Cline-style) | `GIT_DIR=<elsewhere> --work-tree=<repo>` | Fully isolated from user repo | Re-implements what we get free from the repo’s own ODB; this is the design that **corrupted monorepos** for Cline (see §4.2) |

**Recommendation: (A)** for the snapshot store + **tool-call attribution (§3.3)** for the authored set + optional **(B)** as a fast path when a turn touches few files. Concretely, at the engine turn hook (§1.2): take a `pre` snapshot just before `enterPrompt()` and a `post` snapshot right after `agents.prompt()` resolves, store both OIDs on the `turns` row. The per-turn **authored diff** = diff of `pre` vs `post` **restricted to the authored path set** (so ambient noise from concurrent chats is filtered out even though the snapshot is whole-tree).

**Untracked / ignored / binary / deletes:** `git add -A` captures tracked + untracked-not-ignored. Decide explicitly whether to include `.gitignore`d files (Cline excludes `node_modules/`, `dist/`, media, large binaries — we should too, plus a hard size cap per file). Deletions are captured naturally (path absent in `post` tree). Binary files: snapshot/restore by whole-blob replacement (no 3-way), see §5.

### 4.1 Where snapshots live & retention
- Ref namespace `refs/zeros/turns/<chatId>` (one advancing chain per chat), or `refs/zeros/turns/<chatId>/<turnId>`. Under `refs/zeros/*` so nothing shows in normal git UX.
- **gc safety:** because they’re ref-pinned they survive `git gc`. Set `gc.reflogExpire`-style retention ourselves: prune a chat’s turn refs when the chat is deleted, and cap history (e.g. keep last N turns or M days) with an explicit `update-ref -d`.

### 4.2 Hard lessons from Cline’s shadow-git (must-not-repeat)
Cline’s checkpoints (shadow repo under VS Code global storage, hash-of-workspace dir, `CheckpointTracker`) **corrupted real repos in a large monorepo** ([issue #9590](https://github.com/cline/cline/issues/9590)): on init timeout it **renamed the user’s `.git`→`.git_disabled`**, and its nested-`.git` handling **recursed unboundedly** into `node_modules`. Concrete guardrails we adopt:
- **Never rename or mutate the user’s `.git`.** Approach (A) never does.
- **Depth-limit / exclude** nested `.git` and `node_modules`; don’t scan into them.
- **Time/size budget** on snapshot; on exceed, **degrade gracefully** (skip the snapshot, keep attribution-only pills) — never mutate the FS to “fix” it.
- **Lock** snapshot/reset per workspace (mirror `detach.ts` PID-lock + `tryAcquire`-style single-flight).
- **Disable** in dangerous roots (`$HOME`, repo > threshold) like Cline’s `validateWorkspacePath`.

---

## 5. “Reset to this point” — semantics

Reset has **two halves**, both scoped to **one chat**:
1. **Transcript:** `truncateChatMessagesFrom(chatId, turnId)` — already exists (§1.5). Removes this turn’s user message and everything after **in this chat only**. Other chats’ transcripts are untouched.
2. **Files:** restore the **authored** files this chat changed from this turn onward — **without clobbering other chats’ concurrent edits**.

### 5.1 The file restore as a three-way merge (the safe core)
“Reset to turn _T_” means: undo the authorship of _T_ **and every later turn of the same chat**. Compute the chat’s authored path set across `T…latest`. For each path, do a **3-way merge** (per file):
- **base** = content at this chat’s state **after** turn _(T−1)_ post-snapshot (i.e., the file as it was *before* this chat’s reverted run began) — the merge ancestor.
- **ours** = **current on-disk** content (may include another chat’s edits).
- **theirs** = same as base (we are *removing* this chat’s contribution, so the target for this chat’s lane is “as if this chat never ran T…latest”).

Equivalently: **reverse-apply this chat’s `T…latest` diff onto the current tree via 3-way merge.** Use, in order of preference:
- `git merge-tree --write-tree <ours-tree> <target-tree>` with explicit `--merge-base` (Git ≥ 2.38) to compute the whole merged tree **in the object DB with no working tree**, then check conflicts from its output and the trees we constructed; or
- per file, `git merge-file` / `git apply --3way -R` of this chat’s forward patch.

Outcomes per file:
- **Clean** → write the merged content (other chat’s non-overlapping edits to the same file are preserved).
- **Conflict** (both chats edited the same hunks) → **do not write**; record the conflict and surface it (conflict markers in a quarantine view or a “couldn’t auto-reset N files” list with manual resolve). **Never silently overwrite** the other chat’s lines. This is the property the brief demands.

### 5.2 Linear / single-chat case (the common one)
When only one chat has touched these files, “ours == this chat’s state”, the 3-way merge is trivial, and reset degrades to a plain restore: `git restore --source=<pre-snapshot-of-T> -- <authored paths>` (or `read-tree`/`checkout-index` of those paths). Fast and exact. Detect this case (no other chat’s turn touched any path in the set since _T_) and take the fast path.

### 5.3 Always snapshot-before-reset (undo the undo)
Before mutating, take one more snapshot (`refs/zeros/turns/<chatId>/pre-reset-<ts>`) and record it so the “…” menu can offer **Undo reset**. Mirrors jujutsu’s operation-log philosophy (every op is reversible) without adopting jj.

### 5.4 Edge cases (enumerate & handle explicitly)
- **File created in the turn**, not since touched by others → reset deletes it. Touched by another chat since → 3-way (likely conflict/keep).
- **File deleted in the turn** → reset restores it from `pre`.
- **Renames** → treat as delete+add on the authored set; rely on `merge-tree` rename detection where possible.
- **File committed since the turn** (user ran `git commit`) → reset must operate against HEAD-relative content; if reverting would rewrite committed history, **refuse** and explain (offer “revert as new change” instead). Mirror `detach.ts`’s “refuse if mid-operation/dirty in a destructive way”.
- **Binary files** → no 3-way; if unchanged by others, replace with `pre` blob; else **conflict → skip + report**.
- **`.gitignore`d / untracked** authored files → handle per the snapshot inclusion policy (§4).
- **What reset does NOT undo:** terminal side-effects, DB writes, network calls, installed packages. State this in the UI exactly as Cursor documents (“checkpoints are not version control; they won’t revert `rm -rf` run in a shell”). Reset is about **agent file edits**, not the world.

---

## 6. UI specification

### 6.1 Turn footer
**Location:** `src/zeros/agent/turn-event-list.tsx` (~`102–115`), appended after the `finalOutput.map(...)` for a **settled** turn (when `partitionTurn` has a non-deferred boundary). A new `<TurnFooter turn={…} ctx={ctx} />`.

Contents (left→right), matching the screenshots:
1. **Duration** — reuse `LiveDuration`/`DurationChip` + `formatElapsed`. While `ctx.isStreaming` and this is the active turn: live ticking timer + shimmer (`.zeros-agent-live-duration`), start = `ctx.activeTurnStartedAt`. When settled: static final “45m, 5s”/“3m, 42.6s”, computed `ended_at − started_at`.
2. **Copy** — copy the turn’s `finalOutput` markdown (the raw `text`, not rendered HTML). Mirror `UserMessageActions` copy.
3. **“…” menu** — `DropdownMenu` (same primitive as `ScopeSelect`). Phase 1 item: **↩ Reset to this point** (with a confirm/destructive affordance). Designed to grow (Restore files only / Copy turn link / View turn diff).
4. **File-change pills** — **authored** files (§3.3). Each pill = file-type icon + name + `+N −M` (reuse `FileTag`/`EditCard` count styling). Overflow pill `+K more +A −D`; clicking increments a local `visibleCount` by 10 (matches “show another 10”). Clicking a **file** pill opens the Changes tab filtered to this turn and selects that file (deep link, §6.2). Optional trailing affordance “· N others changed” → the ambient section, clearly separated.

Live behavior: footer appears once the turn settles; while streaming, the timer + shimmer run and pills fill in as edit tools complete.

### 6.2 Changes-tab “turn” dropdown
**Location:** beside `ScopeSelect` in `ChangesView` (`changes-tab.tsx` ~`765`). New `<TurnSelect>` parallel to `ScopeSelect`.
- **Default “No turns”** → turn filter off; the existing `Scope` (All changes / Uncommitted / commit) drives the list exactly as today.
- **Open** → list **all turns in this workspace** (`turns` rows where `workspace_id = …`), **latest first**, each labeled `chatTitle · relative time · summary · N files`. (Cross-chat, since the Changes tab is per-workspace.)
- **Select a turn** → list shows that turn’s **authored** files with their per-turn diffs (`pre`-vs-`post`, restricted to authored paths). Optionally a separate “also changed during this turn” group (read-only, §3.4). An inline **Reset to this point** lives here too.
- **Precedence:** selecting a turn **overrides** the `Scope` filter (the list is now turn-scoped); pick “No turns” to return to `Scope`. Persist the selected turn per workspace in `localStorage` like `Scope`.
- **Deep link:** a footer pill click sets `TurnSelect` to that turn and focuses the file (via the existing `ADD_COLUMN3_TAB`/`UPDATE_COLUMN3_TAB` flow + a new `diffScope:"turn"` + `turnId` on `Column3Tab`).

---

## 7. Data model & engine API (new surface)

- **Migration v13:** `turns` (+ optional `turn_files`) per §2; FTS not needed; stamp `rev` via `nextRev()` for delta sync; tombstone on truncate/reset (reuse the `recordTombstone` pattern). **As built:** `turns` shipped without `turn_files` (the authored set is the JSON `files` column). **Migration v14** added `reset_undo` for full-fidelity undo (see Post-build hardening + §12).
- **Snapshot creation** is **engine-internal**, hooked in the `AGENT_PROMPT` handler (§1.2): `pre` before `enterPrompt`, `post` after `agents.prompt` resolves, plus authored-set extraction from the turn’s tool messages. Not a renderer-initiated op.
- **New engine commands** in the `index.ts` dispatch (mirror `git.*`), namespaced `turns.*`:
  - `turns.list({ workspaceId })` → turn rows (latest first) for the dropdown.
  - `turns.filesChanged({ chatId, turnId })` → authored `ChangedFile[]` for pills (icon/name/±).
  - `turns.diff({ chatId, turnId, path? })` → per-turn unified diff (feeds the file viewer; `diffScope:"turn"`).
  - `turns.reset({ chatId, turnId, mode })` → `mode: "filesAndTranscript" | "filesOnly" | "transcriptOnly"` (Cline-style trio). **As built**, returns `{ applied[], conflicts[], skipped[], preResetSnapshot, resetPaths[], truncated, resetId }` — `skipped` (no-snapshot/binary, surfaced not silent) and `resetId` (the undo handle) were added during hardening.
  - `turns.undoReset({ resetId })` → **As built**, restores files **and** re-inserts the truncated transcript (messages + turns) from the `reset_undo` capture; returns `{ restored[], transcriptRestored, messagesRestored }`. (The original `{ chatId, snapshot, paths }` files-only shape was replaced.)
- **Preload allowlist** additions (`scripts/check-preload-allowlist.mjs` enforces this) + the `["workspaces"]` cross-device nudge so other devices refresh (the same list as `git.commit` etc. at `index.ts:137`).
- Reuse `runGit`, `restore.ts`, `stage.ts`, `diff.ts`; add thin helpers `snapshotTree(cwd, {excludes})`, `showBlob(cwd, oid, path)`, `threeWayMergeFile(...)`.

---

## 8. Phased implementation (each phase shippable)

- **Phase 0 — Turns become real + footer (no snapshots).** v13 `turns` table; record start/end/duration/stop_reason at the engine hook; authored file set from tool messages. Footer ships with **duration + copy + pills**, pills not yet clickable, **no reset**. Immediately useful, near-zero risk (no FS mutation, no new git writes).
- **Phase 1 — Snapshots + per-turn diff + dropdown (read-only).** Add `pre`/`post` snapshots (§4A) behind guards (§4.2). `turns.diff`/`turns.filesChanged`. Pills clickable → Changes tab; `TurnSelect` dropdown (view-only); `diffScope:"turn"` in the file viewer.
- **Phase 2 — Reset, linear/fast path.** `turns.reset` = `truncateChatMessagesFrom` + `git restore --source=<pre>` for authored paths **when no other chat touched them since** (§5.2). Snapshot-before-reset + Undo reset. Covers the single-chat / non-overlapping case (the majority).
- **Phase 3 — Selective 3-way reset (the concurrent case).** `merge-tree --write-tree` / `apply --3way -R` per §5.1; conflict detection + “couldn’t auto-reset N files” UX; binary handling.
- **Phase 4 — Polish.** Ambient-changes group; retention/gc of `refs/zeros/turns`; size/time/`$HOME` guards; cross-device sync of turns; adapter-fidelity checks (Claude/Codex/Cursor edit metadata); perf on large repos.
- **Testing:** extend the `vitest` `test:git` harness (there’s already `detach.test.ts`, `service.test.ts`). Add a **concurrency simulation**: two chats interleaving edits to overlapping + disjoint files; assert authored attribution, clean reset preserves the other chat, overlapping reset conflicts (never clobbers). Snapshot/gc tests. Footer/dropdown component tests.

---

## 9. Open decisions (need your call)

1. **Authored-only vs whole-tree turns** — plan recommends **authored-only** for pills + reset (safe under concurrency). The whole-tree view is available only as a clearly-labeled, read-only “ambient” section. Confirm.
2. **Reset scope** — “this turn **and all later turns of this chat**” (recommended; matches “remove turn 3 + latest, go back to turn 2”). Confirm vs “this single turn only”.
3. **`.gitignore`d/untracked content** in snapshots — include with size cap, or exclude (Cline excludes). Recommend exclude `node_modules/dist/media` + hard per-file size cap.
4. **Snapshot store** — in-repo `refs/zeros/turns/*` (recommended) vs a separate shadow git dir (rejected — Cline’s corruption mode).
5. **Filter precedence** — selecting a turn overrides `Scope` (recommended). Confirm.
6. **Retention** — keep last N turns / M days per chat; prune on chat delete. Pick N/M.

---

## 10. Risks

- **Perf/monorepo** — whole-tree `add -A` cost; mitigate with excludes + budget + degrade-to-attribution-only.
- **gc pruning snapshots** — mitigated by ref-pinning + our own retention.
- **Adapter differences** — Codex/Cursor edit-tool metadata fidelity vs Claude SDK; verify the authored path + counts are reliable per adapter (there’s a `test:adapters` harness).
- **Committed-since / mid-operation** — refuse destructively-unsafe resets, mirroring `detach.ts` guards.
- **Conflict UX** — getting “we couldn’t auto-undo these N files” clear and non-scary.
- **Cross-device** — turns must delta-sync (rev/tombstone) so a reset on one device reflects on others, like messages do today.

---

## 11. UI changes shipped (renderer) — what the user sees

Everything below is live on `jordan/active-tab-file-open` (file map in parentheses).

### 11.1 Per-turn footer
Rendered under every **settled** answer, INSIDE `TurnEventList`'s 768px lane so it hugs the answer (`src/zeros/agent/turn-footer.tsx`, mounted via `turn-event-list.tsx` ← `agent-chat.tsx`). Left→right:
- **Run duration** — grey, final `ended_at − started_at` (falls back to message timestamps when a turn predates recording). While the turn streams the footer is hidden; the working group's `ActivityShimmer` shows the single live timer.
- **Copy** — copies the answer's raw markdown.
- **"…" menu** — *Reset to this point* → opens the confirm dialog.
- **File-change pills** — `glyph · basename · +N −M` for the files the agent authored, styled as the tool-call `FileTag` (`bg-bg1` / `border-border3` / `rounded-md`, glyph 13px, counts inside). Overflow pill **"+N more"** reveals 10 at a time. Clicking a pill opens that file's per-turn diff in row 1.

### 11.2 Reset confirm dialog (`turn-footer.tsx`)
"…" → Reset opens a destructive-action dialog (mirrors `discard-file.tsx`): the scope ("this turn and every later turn in this chat"), the file count, and — when the turn has no snapshot — a warning that **only the conversation** will roll back. Buttons: Cancel / **Reset**.

### 11.3 Toasts (`@/zeros/ui/primitives/elements`)
- After reset: success "Reset to this point — N files restored", or warning "Reset — N restored · M conflicted · K skipped", each with an **Undo** action.
- Undo: "Undid reset — files + conversation restored" (or files-only when the chat was continued past the reset).
All transient feedback routes through the single `toast` surface — no inline banners (foundation rule).

### 11.4 Changes-tab turn dropdown — `TurnSelect` (`changes-tab.tsx`)
Beside the existing scope selector. Default **"No turns"** → the scope filter applies. Open → every turn in the workspace, latest first, labelled `chat · relative time · summary · N files`. Select one → the list shows that turn's authored changes with their per-turn ± (inline Reset present). The selection is **persisted per workspace** (`changes-turn-filter.ts`) and restored on remount; "No turns" or any scope clears it.

### 11.5 Per-turn diff in the file viewer (`file-viewer.tsx`)
A new `diffScope:"turn"` (+ `turnChatId`/`turnId`) threaded through `column3-tab-manager.ts` → `use-open-file-in-row1.ts` → `files-tab.tsx` → `column3.tsx`. Opening a footer pill or a turn-filtered row shows the `pre`→`post` diff restricted to authored paths, and live-refreshes when the agent ends a turn.

### 11.6 Plumbing
- `src/native/turns.ts` — renderer facade (`turnsList` / `turnGet` / `turnDiff` / `turnReset` / `turnUndoReset`).
- `src/zeros/bridge/workspace-bridge.ts` — bridge fns; `turnUndoReset` takes `{resetId}` → `TurnUndoResult { restored, transcriptRestored, messagesRestored }`.
- `src/zeros/agent/sessions-provider.tsx` — sends the renderer's `userMessageId` on `AGENT_PROMPT` so `turn.userPrompt.id` == the engine turn id without a transcript re-window.

---

## 12. Test plan — user-centric workflows

Manual acceptance from the user's seat + the automated coverage backing it. A "git workspace" = a normal worktree chat; a "non-git folder" = a chat whose cwd isn't a work tree.

### 12.0 Setup
- App built from `jordan/active-tab-file-open`; a repo with a worktree workspace; at least one chat each on **Claude**, **Codex**, and **Cursor** (attribution differs per adapter).
- Handy: `git -C <worktree> for-each-ref refs/zeros/` to watch snapshot refs; inspect `zeros.db` `turns` / `chat_messages` / `reset_undo` tables.

### 12.1 Footer basics — "what did this turn do?"
| # | Steps | Expected |
|---|---|---|
| A1 | Send a prompt that edits ≥1 file; watch it run, then settle. | Streaming: ONE grey timer (shimmer), no footer, **no blue timer**. Settled: footer with grey duration + Copy + "…" + pills `glyph name +N −M`. |
| A2 | Click Copy. | Clipboard holds the answer's raw markdown; icon flips to a check briefly. |
| A3 | A turn touching >10 files. | 10 pills + "+N more"; each click reveals 10 more. |
| A4 | Click a file pill. | Row 1 opens that file's **per-turn** diff (pre→post), not the whole-tree diff. |

### 12.2 Cross-adapter attribution — regression for the "0 files" bug
| # | Steps | Expected |
|---|---|---|
| B1 | **Claude**: "create `a.md` …". | Pill `a.md +N −0`; dropdown row "N files". |
| B2 | **Codex**: "create `reset.md` …". | **Pill `reset.md +N −0` with counts** (NOT "0 files"); dropdown shows N files. *(The exact reported bug.)* |
| B3 | **Cursor**: edit an existing file. | Pill `+N −M`. |
| B4 | A turn editing several files in one Codex patch. | One pill per file. |

### 12.3 Changes-tab turn filter — "show me just this turn's changes"
| # | Steps | Expected |
|---|---|---|
| C1 | Open the turn dropdown; select a turn. | List shows only that turn's authored files with per-turn ±; inline Reset present. |
| C2 | Switch source tab → terminal → back; switch workspace and back; reload. | The selected turn is **remembered** per workspace. |
| C3 | Select "No turns" (or pick a scope). | Returns to the scope-filtered list; the turn pin clears. |
| C4 | Select a turn, then reset it away elsewhere. | On next load the stale selection silently degrades to "No turns". |

### 12.4 Reset — happy path — "undo this turn"
| # | Steps | Expected |
|---|---|---|
| D1 | "…" → Reset to this point. | **Confirm dialog**: scope + "N files restored" + "can undo". |
| D2 | Cancel. | Nothing changes. |
| D3 | Confirm. | Files revert to pre-turn state; the turn + all later turns **vanish from the transcript immediately**; toast "Reset — N files restored" with **Undo**. |
| D4 | Inspect the working tree. | Authored files match their pre-turn content (created files deleted, edits reverted). |
| D5 | Click **Undo**. | Files come back **and the conversation re-renders** — user message, tool cards *with their outputs*, the final answer; the footer returns. Toast "Undid reset — files + conversation restored". |

### 12.5 Reset — concurrency (two chats, one worktree)
| # | Steps | Expected |
|---|---|---|
| E1 | Chat A edits `x`, Chat B edits `y` (disjoint). Reset A's turn. | Only `x` reverts; `y` and B's transcript untouched. |
| E2 | A and B edit the **same** file on **different** lines. Reset A. | A's lines revert, B's kept (3-way merge); no conflict. |
| E3 | A and B edit the **same** lines. Reset A. | Toast reports "M conflicted"; the file keeps **B's** content (never clobbered); the conflicted file is listed. |

### 12.6 Reset — edge cases
| # | Steps | Expected |
|---|---|---|
| F1 | While a LATER turn is **streaming**, reset an earlier settled turn. | The in-flight turn is cancelled first; reset proceeds; no zombie messages reappear. |
| F2 | Reset a turn with **no snapshot** (non-git folder, or old/pruned turn). | Confirm warns "only the conversation will roll back"; after, toast notes "K skipped"; transcript still truncates. |
| F3 | Reset, send a NEW prompt (continue), then **Undo**. | Files restored; conversation **not** re-inserted; toast: "the conversation wasn't — this chat was continued past the reset." |
| F4 | Try to reset the same turn twice. | After the first reset the footer is gone, so there's nothing to click; if forced, a graceful error toast (no crash). |

### 12.7 Retention / gc
| # | Steps | Expected |
|---|---|---|
| G1 | Delete a chat. | `for-each-ref refs/zeros/turns/<chat>/` and `…/resets/<chat>/` are empty; its `turns` rows are gone. |
| G2 | A chat with >100 turns. | Oldest turns' snapshot refs pruned; pills still render (stored `files`), but their per-turn diff is empty and re-reset skips (warns). |
| G3 | Reset the same chat >5 times. | Only the last 5 pre-reset snapshots + undo records survive (Undo works for recent resets only). |

### 12.8 Cross-device (best-effort)
| # | Steps | Expected |
|---|---|---|
| H1 | Reset on device 1. | Device 2 re-windows the chat (truncated tail drops); Changes tab refreshes. |
| H2 | Undo on device 1. | Device 2 sees the restored messages (bumped revs). |

### 12.9 Automated coverage (`pnpm test:git`, vitest)
- **Attribution** (`turns-git.test.ts`): the **adapter-fidelity contract** — Claude `file_path`, Claude `write`, Codex `changes[]` (incl. multi-file), Cursor `{path,diff}` / `{path,content}`, ACP `locations[]`; read-only/pending tools excluded.
- **Snapshots & per-turn diff**: snapshot to a hidden ref + blob resolve; ± counts and patch restricted to authored paths.
- **Reset semantics**: linear fast-path restore; concurrent non-overlapping 3-way merge keeps the other edit; overlapping → conflict (never clobbers); created-file delete.
- **GC**: `deleteAllChatSnapshotRefs` (only the target chat); `pruneResetSnapshots` keeps newest N.
- **DB turns** (`turns.test.ts`): start/finish/list/delete; retention (`turnsWithSnapshotsBeyond` / `clearTurnSnapshots` / `deleteTurnsForChat`).
- **Reset-undo** (`reset-undo.test.ts`): full **capture → truncate → undo round-trip** (asserts order + that a tool call's `rawOutput` survives), the **continued-past-reset guard**, retention prune.
- **Schema** (`db.test.ts`): migrations apply `1…14`; `latestSchemaVersion() === 14`.
- **Changes tab** (`column3-tab-manager.test.ts`): `diffScope:"turn"` tab routing.

### 12.10 Regression checklist (the specific reports)
- ✅ No blue duplicate timer while a turn loads (only the grey shimmer timer).
- ✅ A Codex `reset.md` turn shows a pill **with** `+N −0` and a non-zero file count in the dropdown.
- ✅ The footer hugs the answer (no ~20px gap); pills carry the `FileTag` look with counts inside.
- ✅ Reset asks for confirmation; the result + an **Undo** appear as a toast.
- ✅ Undo brings back files **and** the messages / tool-calls / outputs.
- ✅ The transcript visibly rolls back on the device that reset (no "unknown turn" on a second try).

---

## Appendix — sources

- Cline checkpoints (shadow git, `CheckpointTracker`, restore modes `taskAndWorkspace|workspace|task`, per-workspace lock): https://deepwiki.com/cline/cline/10.1-checkpoints-and-snapshots ; corruption cautionary tale: https://github.com/cline/cline/issues/9590
- Cursor checkpoints (per-agent-change only; does **not** track manual edits or revert terminal/bash effects; “not a substitute for git”): https://cursor.com/docs/agent/chat/checkpoints
- `git merge-tree --write-tree` (3-way merge in the ODB, no working tree; tree OID + conflicted-file info; exit 0/1; Git ≥ 2.38): https://git-scm.com/docs/git-merge-tree
- jujutsu first-class conflicts + operation log (every op reversible; conflicts stored, not blocking) — informs snapshot-before-reset/undo: https://docs.jj-vcs.dev/latest/conflicts/
