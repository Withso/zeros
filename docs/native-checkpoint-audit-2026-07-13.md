# Native per-turn checkpoint system — research, audit & review (2026-07-13)

**Context.** §3.5 of the parity doc kept three ❌ rollback rows (Codex `thread/rollback`,
Claude `enableFileCheckpointing`/`rewindFiles`, a cross-agent "revert to here" surface).
They are now marked ⏭️ **skipped** (user decision 2026-07-13): Zeros' own **native
checkpoint system** — per-turn git snapshots + "Reset to this point" — already provides
agent-agnostic turn revert. This document is the promised audit of that native system:
how it works, what it guarantees, its edge cases, and the review findings.

Verified against: `src/engine/git/turns-git.ts`, `src/engine/git/shell-authored-paths.ts`,
`src/engine/db/turns.ts`, `src/engine/db/reset-undo.ts`, `src/engine/index.ts`
(`beginTurn`/`finishTurn`/boot janitors), `src/engine/workspace/service.ts`
(`turns.reset`/`turns.undoReset`), `src/zeros/agent/turn-footer.tsx`. Test suites run
2026-07-13: `turns-git.test.ts` (19), `db/turns.test.ts` (5), `reset-undo.test.ts` (3),
`turn-footer.test.ts` (10) — **37/37 green**. Two behaviors additionally verified against
live git 2.x: the `--name-status -z` token format (`M\0path\0…`) matches the parser, and
pathspec-special filenames (`a[0].txt`) restore the literal file correctly.

---

## 1. How it works

### 1.1 Lifecycle — one checkpoint pair per turn

Every `AGENT_PROMPT` (engine/index.ts:1724) brackets the agent run:

1. **`beginTurn`** — resolves the chat folder's worktree **top-level** (a chat may sit in
   a monorepo subdir; snapshots must anchor at the top or `add -A` would capture a
   prefix-stripped subtree), takes the **pre snapshot**, and inserts a `running` row in
   the `turns` table (v13). `turnId` = the opening user message's `msg_id` — the same key
   transcript truncation uses.
2. The agent runs (`agents.prompt` — Claude, Codex, or Cursor; the mechanism never asks
   which).
3. **`finishTurn`** — takes the **post snapshot**, computes the turn's authored file set
   (below), finalizes the row (`completed`/`failed`/`cancelled`), prunes retention.
   Both halves are best-effort: any git failure degrades to `null` snapshots and must
   never disturb the live prompt.

### 1.2 Snapshots — hidden, gc-pinned, index-safe

`snapshotWorkingTree` captures the **whole working tree** (tracked + untracked-not-
ignored) with a **scratch index** (`GIT_INDEX_FILE` pointed at a throwaway file in the
gitdir): `add -A` → `write-tree` → `commit-tree` → `update-ref refs/zeros/turns/
<chat>/<turn>__{pre|post}`. Properties:

- The user's real index, branch, HEAD, and `git log`/`status` are never touched.
- `.gitignore` is respected (node_modules/dist excluded for free).
- Snapshot commits are parentless but **ref-pinned**, so `git gc` can't prune them —
  which is why the system prunes its own refs (see 1.6).
- Commit identity is a fixed `Zeros <turns@zeros.local>` (no dependence on user git config).
- Concurrent snapshots (parallel chats, same repo) can't collide: per-call scratch index
  named with pid+timestamp+random; `.git/index.lock` contention is retried with backoff
  in `runGit`.

### 1.3 Attribution — the concurrency-safe half

Which files "belong" to a turn comes from the agent's **own tool calls**, never from a
whole-tree diff — so two chats editing the same worktree never steal each other's
changes:

- File-native tools (`edit`/`write`/`delete`/`move`): paths from ACP `locations`, then
  common `rawInput` keys across all three adapters, including Codex's `changes:[{path}]`
  array and Cursor's `edits`/`files` shapes. Failed file tools are dropped (a denial is
  not authorship); pending ones too.
- Shell tools: `shell-authored-paths.ts` is a deliberately *non-general* recognizer —
  quote-aware lexer, `cd` tracking, output redirections, and a whitelist of mutating
  commands (`rm`, `mv`, `cp`, `sed -i`, `tee`, `dd of=`, `git rm/mv/restore/clean/…`).
  It refuses to attribute the worktree root (`.`) — that would sweep in concurrent work.
- Everything is then **intersected with the real pre→post snapshot diff**
  (`turnFileDiffs`, restricted to the authored paths): a denied, failed, or no-op tool
  call produces no diff entry and therefore no recorded file. The footer pill is
  disk-authoritative by design — "no pill" is preferred over a convincing false one.

### 1.4 Reset — per-turn inverses, 3-way merge, never clobber

"Reset to this point" (turn footer → confirm dialog → `turns.reset`) rolls back **this
turn and every later turn of the chat**: transcript truncated at `turnId`, files unwound
via `applyTurnSpanReset`:

- Steps are per-turn `(paths, preSnapshot, postSnapshot)` triples, unwound
  **newest-first**, each path restored against **its own turn's** pre/post pair — a later
  unrelated snapshot is never used as a merge base, so an edit interleaved by another
  chat between two turns survives wherever a merge can preserve it.
- Per path: fast path when disk blob-OID == that turn's post OID (nobody touched it
  since) → exact binary-safe `git restore --source=<pre>`; target absent pre-turn →
  delete. Diverged → **3-way text merge** (`git merge-file -p`, base = post, ours = disk,
  theirs = pre); an overlap **conflicts and is reported**, never silently overwritten;
  binary/unreadable → conflict.
- **Pre-flight + rollback invariants:** a path whose chain contains any pruned snapshot
  is blocked *before* mutation (never half-reverted); if an older inverse conflicts after
  a newer one already landed, the path is rolled back to the pre-reset escape snapshot —
  a conflict must never leave a file half-reset. Both are covered by tests.
- **Escape hatch:** the whole tree is snapshotted (`refs/zeros/resets/<chat>/<ms>`)
  before any mutation; if that safety snapshot itself fails, the file reset refuses to
  run (all paths skipped) rather than run un-undoably.
- Outcomes surface honestly in the toast: `N restored · M conflicted · K skipped`, with
  explanations and an **Undo** action.

### 1.5 Undo — files *and* conversation

`turns.reset` stashes, before deleting, the exact message + turn rows it truncates
(`reset_undo` table, v14). `turns.undoReset` restores files from the pre-reset snapshot
and re-inserts the conversation **only if the chat wasn't continued past the reset**
(ord-range-free check) — otherwise files come back and the toast says the conversation
didn't. Undo records and pre-reset snapshots are capped at 5 per chat in lock-step.

### 1.6 Retention & janitors

- Per chat, the newest **100** file-changing turns keep their snapshot refs
  (`TURN_SNAPSHOT_RETENTION`); older refs are deleted and the rows' OIDs nulled — the row
  survives for the timeline, and the confirm dialog warns when the selected turn's
  checkpoint is gone.
- Turns that end with **zero recorded files** (conversational, denied, no-op) drop their
  refs immediately so chat-only turns neither consume disk nor evict useful checkpoints.
- Chat deletion drops all of a chat's turn + reset refs; boot janitors settle orphaned
  `running` rows as `failed` and prune orphaned archive refs.

### 1.7 Reuse — the same plumbing backs archive/restore and crash recovery

`archiveWorkspace` captures the whole tree into a durable `refs/zeros/archive/<wsId>`
(replacing `git stash`); restore overlays it back as uncommitted changes
(`read-tree --reset -u` + `reset --mixed HEAD`). When a worktree was archived already
orphaned (no snapshot possible), restore falls back to **the most recent per-turn post
checkpoint** for the workspace. The detach feature's checkpoints
(`zeros: detach checkpoint` commits, `git/detach.ts`) are a separate mechanism.

### 1.8 Shipped user flows & UI surfaces (all ✅ done)

The revert affordance lives on the **turn footer** — the strip under each settled agent
answer — not on the user-message bubble. The full flow a user walks through today:

| # | UI surface | What the user sees / does | Where | Status |
|---|---|---|---|---|
| U1 | Turn footer | Under every settled turn (all agents): run duration (tooltip "Agent run time"), copy-output button (flashes ✓), "…" turn-actions menu. Hidden while streaming (shimmer owns the live timer). | `turn-footer.tsx` | ✅ Done |
| U2 | File-change pills | One pill per authored file: type icon + basename + `+A −D` counts inside the pill; tooltip shows the full path; `+N more` reveals 10 at a time. Disk-authoritative — denied/no-op edits show no pill. | `turn-footer.tsx` | ✅ Done |
| U3 | Turn-scoped diff viewer | Clicking a pill opens that file in the row-1 viewer with `diffScope:"turn"` — the diff is exactly this turn's pre→post change (`turns.patch`), not the whole workspace diff. | `use-open-file-in-row1`, `turns.patch` | ✅ Done |
| U4 | Turn status pills | `STOPPED BY USER` (cancel) / `AGENT STOPPED` (swallowed crash) rendered above the footer row; suppressed while an auto-rebuild retries the turn. | `turn-footer.tsx` | ✅ Done |
| U5 | "Reset to this point" entry | "…" menu → Reset to this point (↺ icon). | `turn-footer.tsx` | ✅ Done |
| U6 | Confirm dialog | "Reset to this point?" — explains it rolls back this turn + every later turn (transcript truncated, files unwound from each turn's own checkpoint); **yellow warning** when this turn's checkpoint was pruned ("its file changes will be left untouched"); grey note that concurrent edits are preserved when possible and the reset is undoable. Cancel / destructive **Reset**. | `turn-footer.tsx:420-460` | ✅ Done |
| U7 | Live-turn auto-cancel | If a later turn is still streaming, Reset cancels it first (invisible; prevents zombie rows). | `turn-footer.tsx` `runReset` | ✅ Done |
| U8 | Instant truncation | The chat truncates in place on this device (in-memory + SQLite); other devices re-window via the `DB_CHANGED` nudge. | `sessions-store`, engine broadcast | ✅ Done |
| U9 | Outcome toasts | Clean: "Reset to this point — N files restored". Partial: warning toast "Reset — N restored · M conflicted · K skipped" with an explanation line (overlapping concurrent edit / no snapshot). Every variant carries an **Undo** action. | `turn-footer.tsx` | ✅ Done |
| U10 | Undo flow | Undo click restores files AND re-inserts the truncated conversation when the chat wasn't continued past the reset ("files + conversation restored", counts) — otherwise "files were restored; the conversation wasn't". Chat rehydrates in place. | `turn-footer.tsx` `doUndo`, `turns.undoReset` | ✅ Done |
| U11 | Changes-tab turn filter | Dropdown of this workspace's file-changing turns (newest first, persisted per workspace); picking one filters the Changes list to that turn's authored files; turns that were reset away drop out. | `changes-tab.tsx:609-690` | ✅ Done |

---

## 2. Why skipping the per-agent SDK rollbacks is sound

| | Native checkpoints | Claude `rewindFiles` | Codex `thread/rollback` |
|---|---|---|---|
| Agents covered | all (incl. future adapters) | Claude only | Codex only |
| Files reverted | per-turn, authored-only, 3-way merge vs concurrent chats | whole checkpoint, no concurrent-chat awareness | none (thread state only; files would still need our git plumbing) |
| Transcript | truncated + restorable | untouched | rewound natively |
| Undo | files + conversation | none | none |
| Cost | 2 hidden snapshots/turn | double-snapshotting on top of ours | extra RPC + state coupling |

The one thing the native system does **not** do is rewind the *agent's own internal
thread state*: after a reset, a resumed native session (Claude session id / Codex thread)
still "remembers" the reverted turns even though the engine transcript — which is what
gets replayed/resent — is truncated. In practice the next prompt is answered against the
truncated engine transcript and the restored files; if "agent still remembers reverted
work" ever surfaces as a real complaint, `thread/rollback` (Codex) and a fresh-session
respawn (Claude) are the targeted fixes. This is the known, accepted trade of the skip.

---

## 3. Findings (audit)

Ranked by user impact. None is a data-loss bug in the primary path; the escape-hatch and
never-clobber invariants held everywhere they were probed.

> **Implementation status (2026-07-13, same day):** F1–F8 were addressed in one pass —
> F1 full fix (boot janitor finishes attribution: `git/turn-recovery.ts`), F2 (refs kept
> unless the turn is provably a no-op: `treesIdentical` in `finishTurn`), F3 docs-only
> (user decision: no dialog copy), F4 (post-reset snapshot as undo merge base:
> migration v19 `reset_undo.post_snapshot`, `undoTurnReset(mergeBase)`, minimal toast
> note), F5 (staged copy synced when the index holds the reverted blob), F6 (engine-side
> cancel guard in the `turns.reset` dispatch), F7 (new `turns-reset-service.test.ts` +
> `turn-recovery.test.ts` + 6 new plumbing tests), F8 (`resetStamp` random suffix; the
> perf option — scratch-index reuse — deliberately deferred, see F8 note below).

### F1 — Crash-mid-turn changes are invisible to reset *(most significant edge)*
If the engine dies mid-turn, `finishTurn` never runs: the boot janitor settles the row as
`failed` with `files = []`. Any files the agent **did** write before the crash are
excluded from every later reset (the span filter keeps only `files.length > 0` turns) —
a "Reset to this point" spanning the crashed turn silently leaves those changes on disk.
The pre-snapshot ref still exists, so recovery is *possible* but manual.
*Suggestion:* the boot janitor could finish attribution for orphaned rows (post-snapshot
at boot + persisted tool calls) or at minimum stamp the row so the footer/dialog can warn.

### F2 — Attribution miss ⇒ checkpoint refs deleted immediately
`finishTurn` deletes both refs when the recorded file set is empty. Correct for genuinely
no-op turns, but if a **new agent/tool shape** slips past `pathsFromTool`/the shell
recognizer, a turn that really changed files records zero, and its checkpoints are
dropped at once — no pills, no reset coverage, no manual recovery net. The cross-adapter
fidelity contract test (`attributes an edit across EVERY adapter's tool shape`) is the
guard; it must be extended whenever an adapter adds a mutating tool shape.

### F3 — `.gitignore`d files are outside the safety net
Snapshots respect `.gitignore`, so agent edits to ignored files (`.env`, local configs,
generated-but-ignored assets) are never checkpointed and never reverted — consistently
(no pill claims otherwise), but users may expect reset to cover "everything the agent
touched." Same for **submodule interiors** and nested repos: `add -A` records only the
gitlink, so inner edits aren't captured (reset degrades to skip/conflict, never corrupts).

### F4 — Undo restores blindly (no divergence check)
`undoTurnReset` re-applies the pre-reset snapshot per path with no OID compare — edits
made *between* reset and undo (by the user or another chat) are overwritten without a
merge, unlike reset itself which 3-way-merges. Mitigated by undo being an immediate
toast action, but it's the one write path in the system without the never-clobber rule.

### F5 — Reset restores worktree only, not the index
`git restore --worktree` leaves staged copies in place: if a user staged an agent's edit
mid-turn and then resets, `git status` shows the staged (agent) version vs the restored
worktree — a confusing state where committing resurrects the reverted change.

### F6 — Engine-side reset doesn't abort a live turn
The cancel-before-reset guard lives in the **renderer** (`turn-footer.tsx` cancels a
streaming session, then resets). A reset arriving by any other route (second device,
future API) while a later turn streams would truncate rows the live turn then re-persists
(zombie rows). The engine `turns.reset` handler would be the safer home for that guard.

### F7 — No service-level tests for the reset orchestration
The git plumbing (19 tests), DB rows (5), undo capture (3), and footer (10) are covered,
but `turns.reset`/`turns.undoReset` in `workspace/service.ts` — span assembly, capture-
before-truncate ordering, the ord-range undo guard, mode variants — has no direct test.
It's the layer where an ordering regression would cause real loss (e.g. truncating before
capturing).

### F8 — Performance: two whole-tree hashes per turn, on the prompt path
Each snapshot is `add -A` into an **empty** scratch index — a full re-hash of the tree
(no cache reuse), twice per turn, and `beginTurn` is awaited **before** the prompt
starts (`finishTurn` before completion is signaled). Unnoticeable on normal repos;
on very large trees this adds real first-token latency every turn. Options if it ever
bites: reuse a per-chat scratch index across turns (git only re-hashes stat-dirty files),
or start the snapshot concurrently with the prompt's first network round-trip.

### F9 — Minor / cosmetic
- **Ref hygiene:** `refs/zeros/*` live in the user's repo; `git push --mirror` /
  `clone --mirror` would copy hidden snapshot commits (potential secret leakage from
  untracked files — mirrors are rare and Conductor shares this shape, but worth knowing).
  Uninstalling Zeros leaves the refs behind.
- **`resetRef` millisecond collision:** two resets of one chat in the same ms share a ref
  name; the second overwrites the first's escape snapshot (the undo *record* still holds
  the first OID, which then dangles for gc). Add the random suffix already used for
  `resetId`.
- **Synthetic `turnId` fallback** (`turn-<ts>-<rand>` when no user message id resolves):
  reset on such a turn truncates nothing (the id matches no message row). Defensive path,
  likely unreachable in practice.
- `turnFileDiffs` passes `--no-renames`, so its `oldPath`/`renamed` handling is dead
  code; renames surface as A+D pairs (correct, just unlabelled).
- Files >64 MiB or binary → merge path degrades to `conflict` (safe, reported).
- Directory/symlink authored paths degrade to `conflict`/skip (safe; verified the
  bracket-glob filename case restores the literal file).

---

## 4. What was verified good (worth keeping tested)

- **Never-clobber invariant:** overlapping concurrent edits conflict and are left as-is;
  non-overlapping concurrent edits survive via 3-way merge — including *interleaved
  between* two of the chat's own turns (span test).
- **No partial reverts:** pruned-snapshot pre-flight blocks the path before mutation;
  conflict-after-apply rolls the path back to the escape snapshot.
- **Honest UI:** disk-authoritative pills (denied/no-op ⇒ no pill), retention warning in
  the confirm dialog, restored/conflicted/skipped counts in the toast, undo always
  offered, "AGENT STOPPED"/"STOPPED BY USER" states on the row.
- **Worktree-top anchoring** for chats opened in a subdirectory.
- **Cross-adapter attribution fidelity** contract test (Claude/Codex/Cursor tool shapes).
- **Parser correctness** against live git: `--name-status -z` framing; pathspec-special
  filenames restore the literal path.

## 5. Follow-ups — resolved 2026-07-13

All of the actionable follow-ups shipped the same day (see the implementation-status
note in §3): service-level reset tests, crash-mid-turn attribution at boot, the 3-way
merge guard in `undoTurnReset`, the engine-side cancel guard, the `resetRef` random
suffix, and the attribution-miss ref-keep. What deliberately remains open:

1. **Ignored/submodule coverage (F3)** stays a documented boundary (this doc) — user
   decision: no dialog copy, no engine change.
2. **Per-turn snapshot cost on very large repos (F8, perf half)** — unchanged; revisit
   with a per-chat reusable scratch index only if real-world latency reports appear.
3. **Hidden-ref hygiene on `push --mirror`** — unchanged; shared shape with Conductor,
   documented here.
