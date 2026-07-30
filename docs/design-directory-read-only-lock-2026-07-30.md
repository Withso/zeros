# Design directory — the read-only codebase lock

_2026-07-30. **The engine mechanism is implemented, tested, and wired to
nothing.** It exists so that design mode has something to switch on when its UI
is designed; until then it has zero callers, on purpose._

_Code of record: `src/engine/files/design-lock.ts` +
`src/engine/files/__tests__/design-lock.test.ts`. Shipped companion feature
(same branch, shared helpers): `src/engine/git/sparse-checkout.ts` —
see [Working folders](#companion-working-folders-implemented-end-to-end)._

## Status at a glance

| Piece                                                          | State                        | Where                                                    |
| -------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------- |
| Lock / unlock / `withUnlocked` primitives                       | **Implemented**              | `src/engine/files/design-lock.ts`                        |
| Design-dir validation (`normalizeDesignDir`, `resolveDesignDirForLock`) | **Implemented**      | same file                                                |
| Unit tests (21)                                                 | **Implemented, passing**     | `src/engine/files/__tests__/design-lock.test.ts`          |
| Skip-worktree / sparse gate the lock depends on                 | **Implemented**              | `src/engine/git/workspace-files.ts` (`isSparseCheckout`, `collectSkipWorktree`) |
| Any caller at all                                               | **Not implemented**          | grep for `lockCodebase` outside `src/engine/files/` returns nothing |
| Design-mode state (enter/exit, persistence, per-workspace)      | **Not implemented**          | —                                                        |
| Design-folder setting (which folder is writable)                | **Not implemented**          | —                                                        |
| Engine RPC op / bridge / native façade for the lock             | **Not implemented**          | —                                                        |
| UI (mode switch, badge, hiding run/setup)                       | **Not implemented**          | —                                                        |
| `runGit` unlock wrapper                                         | **Not implemented**          | `src/engine/git/git-exec.ts:271` is the intended seam     |

Read that last block as the deliberate boundary of this work, not as an
oversight: the mode's UX was left for separate research, so only the part that
is verifiable without it was built.

## What design mode is

A **modal** state. While it is on:

- the design folder (e.g. `styles/Artifacts/Designs/`) is **writable**;
- **the entire rest of the repo is readable but not writable** — by the agent,
  the terminal, and the user's editor alike;
- run/setup scripts are not offered, so nothing needs to write tracked files
  (decided; the hiding itself is not built — see the checklist).

"Readable but not writable" is the whole requirement, and it is what rules out
the other mechanism on this branch: sparse-checkout **removes** files from the
worktree, so an agent could not read the codebase for context. Two features,
two mechanisms — they are not interchangeable.

## Why the filesystem, and not agent permissions

The first instinct was to express "this directory is read-only" through each
agent SDK. That was measured and abandoned. The capability is not there:

| Agent      | Can deny writes per path?                     | Evidence in this repo                                        |
| ---------- | --------------------------------------------- | ------------------------------------------------------------ |
| **Claude** | Yes — `permissions.deny` + sandbox `denyWrite` | plumbing exists and is unfed: `claude-sdk/adapter.ts:2049` reads `CLAUDE_DISALLOWED_TOOLS`, which nothing in the app ever sets |
| **Codex**  | No — `writableRoots` only **adds**             | `codex/app-server-adapter.ts:1838` hardcodes `writableRoots: []` |
| **Cursor** | No — no per-path API at all                    | `cursor-sdk/adapter.ts:1141` `respondToPermission` is a documented no-op |
| Terminal, run/setup, editor | n/a — no agent involved         | login shell at the worktree root                             |

So the SDK route covers one of three shipped agents, none of the terminal, and
would have to be re-implemented for every agent added later. A filesystem ACL
sits **below** all of them: nothing is consulted, so nothing can decline to
cooperate. That property is the entire reason this module exists, and it is
what makes design mode work for future agents at zero marginal cost.

The honest framing, which the UI must not overstate: **this is a guardrail, not
a security boundary.** The ACE is applied as the current user and is removable
by that same user. It stops accidental and agentic writes, not a determined one.

## What gets locked: "lock what git tracks"

`lockableFiles()` enumerates **tracked files outside the design folder** —
nothing else. Gitignored paths stay writable, deliberately.

| Path class                                          | Locked? | Why                                                             |
| --------------------------------------------------- | ------- | --------------------------------------------------------------- |
| Tracked source outside the design folder             | ✅      | the point of the feature                                        |
| Anything inside the design folder                    | ❌      | the one writable region                                         |
| Gitignored (`node_modules/`, `dist*/`, `.vite/`, …)  | ❌      | installs and dev servers write here; locking them breaks preview |
| Tracked but absent from the worktree (deleted, or sparse-excluded) | ❌ | `chmod` would fail and inflate `failed` with paths the user cannot act on |
| Untracked files                                      | ❌      | not in the index; out of the "lock what git tracks" rule         |

Consequence worth stating plainly: with this rule, `pnpm install`, `vite` and
`tsup` all keep working, because every path they write is gitignored. What the
lock **does** block is codegen and lockfile churn — the scripts that write
*tracked* files (`scripts/codegen-codex.mjs` into
`src/engine/agents/adapters/codex/generated/`, `pnpm-lock.yaml`). In design mode
that is correct rather than unfortunate: those are not design work, and run/setup
are disabled there anyway. It only matters that the error says "blocked by design
mode" and not a bare `EACCES`.

## The API

```ts
designLockSupported(): boolean                     // darwin only
normalizeDesignDir(dir): string                    // "" sentinel = exempt nothing
isInsideDir(file, dir): boolean                    // segment-boundary match
lockableFiles(cwd, designDir): Promise<string[]>
resolveDesignDirForLock(cwd, designDir): Promise<string>   // throws with UI-showable text
lockCodebase(cwd, { designDir }): Promise<DesignLockResult>
unlockCodebase(cwd): Promise<DesignLockResult>
withUnlocked(cwd, { designDir }, fn): Promise<T>
```

`DesignLockResult` is `{ changed: number; failed: string[] }`. `failed` names
the exact paths left unprotected — a partially applied lock reported as success
is worse than a refused one.

## What macOS actually does (measured during implementation, macOS 26.3)

These four findings are why the module looks the way it does. Each was
established empirically on a real Mac, because none of it is testable in a
Linux sandbox.

**① A directory ACE does not make a folder read-only.** Denying
`add_file,delete_child,…` on a directory blocks *creating, deleting and
renaming* inside it, but an **existing file stays writable in place**. macOS
also silently rewrites the ACE vocabulary (`write` becomes `add_file` on a
directory). Hence the module enumerates `git ls-files` and applies the ACE to
**every file**, rather than one ACE on the folder.

**② File-level ACLs genuinely work, agent-agnostically.** With
`deny write,delete,append,writeattr,writeextattr` applied to a file:
`python open(w)`, `sed -i`, `mv` and `rm` are all blocked. No agent
cooperation, no per-agent code.

**③ git exits 0 while silently failing to honour the lock.** This is the
hazard that shaped the whole feature:

```
git checkout other  ->  rc=0
  stderr: error: unable to unlink old 'locked/a.txt': Permission denied
          Switched to branch 'other'
branch=other   content=v1        <- HEAD moved, the file did not
```

The branch switches, the command reports success, the locked file is left
stale, and `git status` shows a phantom modification that is not a real edit.
`chflags uchg` behaves identically. **It is not safe to leave locks on across an
arbitrary git operation** — design mode must either block branch switching or
route git through `withUnlocked()`.

**④ Two `chmod` details that were silent bugs before they were fixed.**

- `chmod +a "deny write,…"` **fails outright** with `Unable to translate 'deny'
  to a UUID` — chmod parses the first token as the principal. Without an
  explicit `user:<name>` the entire module was a **no-op**. This is only
  catchable on real macOS, which is exactly why it survived review.
- `chmod` **follows symlinks** without `-h`. git tracks symlinks, including ones
  with absolute targets, so locking without `-h` writes a deny-write ACE onto a
  file **outside the repo** — and unlock only clears it while that link is still
  tracked and present. Every call site passes `-h`.

## Decisions encoded in the code, and the failure each one prevents

| Decision                                                        | Prevents                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `normalizeDesignDir` **refuses** an absolute path instead of rebasing it | `/Users/me/repo/designs` → `Users/me/repo/designs` matches no tracked file, so nothing is exempted, the design folder is locked too, and it reports clean success |
| `resolveDesignDirForLock` checks the folder **exists**, segment by segment against each parent listing | macOS is case-insensitive by default: `fs.stat` resolves `designs` for a tracked `Designs`, while git's paths are case-sensitive — same "exempt nothing" catastrophe, with a near-miss message so the user can see why |
| `unlockCodebase` re-derives the file list from git and passes `designDir: ""` | must work **cold** after a crash, with no retained state; and a file locked under a design folder that has since moved would otherwise stay locked forever |
| skip-worktree consulted **only** in a sparse checkout                | `git update-index --skip-worktree` is also the standard trick for pinning a locally-modified tracked config; that file *is* on disk, and treating it as absent leaves it writable while design mode claims the codebase is read-only |
| `withUnlocked` re-locks **outside** a `finally`                     | a failed relock thrown from `finally` replaces `fn`'s own error, hiding why the git operation failed. Tree is left unlocked — the safe direction |
| Benign `No ACL present` on `-a` is not a failure; a batch of only-benign errors skips the per-file retry | otherwise a successful unlock reports thousands of bogus failures, and a cold unlock costs one spawn per tracked file instead of a few dozen |
| Batches of 200 paths per `chmod`                                    | ARG_MAX overflow at one end, 10k spawns at the other                     |

## What is NOT implemented

Everything above is a mechanism. None of the following exists yet:

1. **Mode state.** Nothing enters or leaves design mode; there is no flag,
   no persistence, no per-workspace scoping, no restore-on-boot.
2. **The design-folder setting.** `designDir` is a parameter with no producer.
   `styles/Artifacts/Designs/` exists in this repo and is the natural detected
   default, but nothing reads or writes such a setting.
3. **Transport.** No engine op, no `workspace-bridge` wire type, no
   `src/native/` façade. The lock is not reachable from the renderer at all.
   (Contrast with Working folders, which has all three.)
4. **The `runGit` wrapper.** Finding ③ says every worktree-rewriting git
   command must run inside `withUnlocked`. `src/engine/git/git-exec.ts:271` is
   the single funnel where that belongs; it is untouched.
5. **UI.** No mode switch, no locked badge, no "blocked by design mode" error
   mapping, and no hiding of run/setup actions.
6. **Name disambiguation** — see below.

## Wiring checklist, for when the design-mode UI lands

In dependency order, with the seam for each:

1. **Settle the name** (below) before any user-visible string is written.
2. Add the design-folder setting; default to a detected
   `styles/Artifacts/Designs/`, and validate through
   `resolveDesignDirForLock` so a bad value is refused at the point of entry
   rather than at lock time.
3. Add `workspace.enterDesignMode` / `exitDesignMode` engine ops. Model them on
   `workspace.setWorkingDirectories` in `src/engine/workspace/service.ts`:
   **local-only** (off the remote allowlist), on the
   `LIFECYCLE_GATED_WORKSPACE_OPS` barrier, and listed in
   `WORKSPACE_MUTATIONS` + `LONG_LIFECYCLE_OPS` in `change-events.ts` — a
   whole-tree chmod is slow enough that the originator must receive its own
   `DB_CHANGED`, and the bridge call needs a raised timeout for the same reason
   the sparse one does.
4. Wrap `runGit` in `withUnlocked` while the mode is on — **and audit the direct
   `fs` writers that bypass it.** `turns-git.ts:948` writes a merged file
   straight into the worktree with `fs.writeFile`, and `:918` / `:1196` `fs.rm`
   worktree paths; `:341` runs `read-tree --reset -u`. A `runGit`-level wrapper
   covers the last one and **misses the first three**.
5. Persist mode state so an unlock happens on boot after a crash —
   `unlockCodebase` is already cold-callable, so this is a flag, not a journal.
6. Map `EACCES`/`EPERM` from the file API and the agents to a
   "blocked by design mode" message.
7. Hide run/setup while the mode is on.

## Hazards to carry into that work

- **Terminal git is uninterceptable.** A `git checkout` typed into the terminal
  hits finding ③ with no wrapper in the way. This is the reason the ad-hoc
  right-click file lock was **dropped** and locks were scoped to design mode
  only: modal, short-lived, no branch switching, run/setup disabled.
- **macOS only.** `designLockSupported()` is `process.platform === "darwin"`.
  `lockCodebase` throws elsewhere; `unlockCodebase` is a no-op.
- **Guardrail, not a boundary** — the owner can remove the ACE.
- **Bypass modes exist.** Claude's `allowDangerouslySkipPermissions` and the
  terminal-agent auto-approve flags defeat every *cooperative* layer; they do
  not defeat the ACL, which is the argument for keeping enforcement here.
- **Archive/restore** runs `read-tree --reset -u`, which rewrites the worktree —
  it must not run against a locked tree.
- **`failed` must reach the user.** A partial lock that looks total is the worst
  outcome this feature can produce.

## The name collision

There are already two things called "design" in this app, and this would be a
third:

| Name                         | What it is                                 | State                |
| ---------------------------- | ------------------------------------------ | -------------------- |
| **Design Mode** (⌘⇧D)        | browser-tab element picker                 | **shipped** — `src/shell/column3-tabs/browser-tab.tsx` |
| `DESIGN_SURFACE_ENABLED`     | dormant CSS-writing design surface          | `false` — `src/engine/index.ts:179` |
| Design mode (this doc)       | modal read-only codebase lock               | mechanism only       |

Pick a distinct name before shipping strings, or the settings, the shortcut and
the badge will all be ambiguous.

## Companion: Working folders (implemented end-to-end)

Separate feature, same branch, listed here because the design lock **depends on
two of its helpers** and because the two are easy to confuse.

- **Mechanism:** `git sparse-checkout` (cone mode) — `src/engine/git/sparse-checkout.ts`.
- **Effect:** deselected top-level tracked folders are *removed from the
  worktree*. Not deleted — the content stays in the object store and returns on
  reselect. Uniform across every agent, the terminal, and the editor, for the
  same below-the-agent-layer reason as the ACL.
- **UI:** `WorkingDirectoriesPopover`
  (`src/shell/column3-tabs/working-directories-popover.tsx`), a searchable
  checklist with Select all / Deselect all / Save, mounted at the right end of
  the Files tree's own filter row via the tree's `searchRowAccessory` slot.
  Draft-until-Save, because applying rewrites the working tree.
- **State:** git's own worktree config, scoped to the one worktree (verified: a
  sibling worktree of the same repo keeps every folder and a clean status). No
  new setting, no DB migration, no preload change.
- **Local-only:** both ops are off the remote allowlist and the control hides on
  a paired client.
- **Shared with the lock:** `isSparseCheckout()` and `collectSkipWorktree()` in
  `src/engine/git/workspace-files.ts`. Both features need the same non-obvious
  fact — that sparse-excluded files keep their index rows, so `git ls-files -c`
  lists files that are not on disk — and one parser keeps the Files tab and the
  lock from disagreeing about what is really there.

Why it cannot serve design mode: it deletes the files. Design mode requires
them readable.

### Two hazards this feature created elsewhere, and how they are closed

Both were found by auditing the shipped feature rather than by review of its own
code, and both are measured, not reasoned.

**① Saving stalled the engine until the host watchdog killed it.** Chokidar
subscribes per DIRECTORY (v4 has no recursive mode), so unlinking a folder makes
it re-read every surviving parent and tear down one subscription per removed
subdirectory — on the engine's single Bun thread. Measured on a synthetic repo,
watcher armed vs. not:

| tracked files | unwatched | watched | max event-loop lag |
| ------------- | --------- | ------- | ------------------ |
| 8 000         | 149 ms    | 630 ms  | 263 ms             |
| 30 000        | 387 ms    | 1 766 ms| 563 ms             |
| 60 000        | 795 ms    | 3 403 ms| 1 075 ms           |

macOS is worse: each subscription is its own FSEvents stream and every ancestor
stream sees the same subtree events. Past ~15 s of blocked loop the Electron
watchdog (`electron/sidecar.ts`, 5 × 1.5 s `/health` probes) SIGKILLs the engine's
whole **process group** — taking the in-flight `git sparse-checkout` with it —
and the renderer's request rejects with `Request timeout: engine disconnected`
for work that was succeeding.

Fix: `workspace.setWorkingDirectories` now suspends the worktree watcher for the
rewrite and resumes it in a `finally`, reusing the `suspendRoot` seam
archive/delete already had for the same reason. Same measurement after: 3 403 ms
→ 1 158 ms and 1 075 ms → 248 ms of lag. The op broadcasts its own `DB_CHANGED`,
so nothing is lost by going deaf.

**② Archive → restore turned hidden folders into uncommitted deletions.**
`snapshotWorkingTree` (`turns-git.ts`) checkpoints with `git add -A` into a
scratch index, which can only stage what is **on disk** — so with an empty seed
the archive checkpoint silently omitted every sparse-excluded folder. Restore
replays it with `read-tree --reset -u` then `reset --mixed HEAD`, leaving the
index at HEAD (folder present) and the worktree at the snapshot (folder absent).
The hidden folder came back as a pending deletion of every file in it, and the
next "commit all" — a human's or an agent's — erased it from the branch.

Fix: seed the scratch index from HEAD first (best-effort; an unborn HEAD has no
tree). A genuine deletion is still recorded, because such an entry is
present-in-index/absent-on-disk **and not skip-worktree**; only the entries git
itself considers absent-by-design are left alone. This also closes a
pre-existing sibling bug — a **tracked file that also matches `.gitignore`** was
dropped from every checkpoint for exactly the same reason.

Both are pinned by regression tests that were confirmed to fail against the
pre-fix code (`worktree.test.ts` prints ` D hideme/keepme.txt` without ②'s fix).

## Tests and verification status

| | |
| --- | --- |
| `design-lock.test.ts` | **21 tests, passing** — validation sentinels, case-mismatch refusal, the skip-worktree gate, benign-error classification, `withUnlocked` error precedence, non-darwin refusal |
| `sparse-checkout.test.ts` | **20 tests, passing** — real git repos in temp dirs: exclude/restore, dirty-file left-behind, `.github`, C-quoted names, non-cone refusal, no-commit repos, per-reason unsupported copy, sibling-worktree isolation, concurrent-save serialization |
| `service.test.ts` | **4 new** — the watcher is suspended for the rewrite and resumed even on failure; the op works with no watcher wired; a non-array payload is refused |
| `worktree.test.ts` | **1 new** — archive → restore of a workspace with hidden folders leaves them intact and unstaged |
| Run on 2026-07-30 | vitest 2.1.9, git 2.50.1, Linux sandbox — full suite 3 429/3 429 pass (309 files) |

**Not verified, and it matters:**

- `lockCodebase` / `unlockCodebase` have **never run end-to-end against a real
  repo.** The macOS primitives they compose (ACL semantics, symlink handling,
  git's silent failure) were verified individually on a Mac; the composed flow
  was not.
- ACL behaviour **cannot** be tested in CI or in a Linux sandbox. This sandbox
  additionally grants `cap_dac_override`, which bypasses permission checks
  entirely and will report writes succeeding through a read-only file — an
  early test was wrong for exactly this reason. Treat any Linux-side permission
  result as meaningless.
- The Working folders popover has **never been rendered** — the app is macOS-only.
  Its logic and wiring are tested; its visuals are not.
