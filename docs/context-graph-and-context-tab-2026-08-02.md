# Context graph + Context tab (2026-08-02)

> Working notes for the `.context-graph/` per-workspace context store and the
> row-1 **Context** tab (canvas). Includes the audit of how the agent-harness
> `.context/` convention behaves, since the graph deliberately diverges from it.

## 1. Audit — how `.context/` works today

The `.context/` directory is the per-workspace scratch convention used by
agent harnesses (and by Zeros itself for composer images):

- **Wholly gitignored.** Harnesses ignore it via the repo `.gitignore` and/or
  `.git/info/exclude`; Zeros' own writer dropped a `.context/.gitignore`
  containing `*` on first use. Nothing under it can ever be committed or
  shared with teammates.
- **Attachments layout.** Harness-style: `attachments/<6-char-id>/<original
  filename>` — one folder per attachment, exactly one file inside. Zeros'
  pre-graph layout differed: `attachments/<chatId>/<attachmentId>-<name>`
  (folder per chat), and only images were ever written — text attachments
  were inlined into the prompt and never touched disk.
- **Survives archive elsewhere, not here.** The harness keeps every
  workspace's `.context` locally (e.g. `~/…/archived-contexts/<Repo>/<ws>/`)
  even after the workspace is archived. Zeros' archive snapshot
  (`snapshotWorkingTree`, `git add -A`) respects gitignore, so `.context/`
  contents were silently DESTROYED on archive unless files-to-copy patterns
  happened to name them.
- **One creator.** `electron/ipc/commands/agent-attachments.ts` was the only
  code that created `.context/`; no scaffold at worktree-create time.

## 2. What shipped — `.context-graph/`

A second, *shareable* context store. Key difference from `.context/`: the
graph itself is NOT gitignored — only its private half is.

```
.context-graph/
  .gitignore            # "/local/" + "/.gitignore" — self-ignoring scaffold
  local/                # private: never committed (gitignored)
    attachments/<attachmentId>/<file>
  shared/               # committed: visible to teammates
    attachments/<attachmentId>/<file>
```

- **One folder per attachment, one file inside** (harness-style ids — the
  composer's `att-<ts>-<rand>` ids satisfy the same `[a-zA-Z0-9_-]` alphabet).
- **Self-ignoring `.gitignore`** means a bare scaffold produces ZERO
  `git status` noise; each teammate's Zeros re-creates the ignore file
  locally, while anything under `shared/` shows up as normal untracked/added
  paths — exactly the deliberate-share signal we want.
- **Docs ride along:** any non-attachment file a user or agent drops under
  `local/` or `shared/` (e.g. `shared/docs/plan.md`) is a "doc" on the canvas.

### Lifecycle integration

- **Create:** `createWorkspaceInner` scaffolds the graph after provisioning
  (best-effort; never rolls back a worktree). Pre-existing workspaces get it
  lazily — first Context-tab open or first attachment write.
- **Attachments (2026-08-02(2): attach-time, not send-time):** the composer
  itself stages every attachment the moment it is added — drop, paste, pick,
  or transcript pill — by diffing the document's attachment-id set on every
  user edit (`composer-editor/context-graph-staging.ts`), so the card is on
  the canvas while the prompt is still being typed. **The graph is
  append-only (2026-08-03(3), see §7):** removing a chip (×, Backspace,
  select-all delete, transcript untoggle) leaves the staged record in place —
  only the user deleting the file on disk removes it. Undo of a removal
  re-runs the write, which the engine skips as a same-size no-op.
  `encodeAttachments` (the single staged-attachment → wire-content
  chokepoint) keeps its write as an idempotent send-time safety net — the
  engine skips same-size re-writes so mtimes (and canvas slots) hold — and
  the non-vision image path still treats the write as load-bearing (the
  prompt references the path). Writes are scope-pinned: an id already in
  `shared/` is re-written THERE, never duplicated back into `local/`.
  Reconstructed edit-in-place chips (`att-edit-` ids) never stage — their
  original send owns the graph record — with ONE deliberate exception: the
  non-vision disk-reference path writes whatever id it is given, because the
  resubmitted prompt must reference a real file (see Known edges). `chatId`
  is provenance-only/optional end to end, so staging and the non-vision disk
  path work before the first prompt creates the chat. Bubble metadata
  carries `attachmentId` as provenance back to the record. Surfaces whose
  cwd is not the attachment's workspace opt out via
  `stageIntoContextGraph: false` — the dispatcher modal composes against
  the primary checkout while its worktree doesn't exist yet, and relies on
  the seed sweep + send-path safety net instead. Validation-failed
  attachments don't stage (the send path would exclude them, so the canvas
  would assert context no agent received).
- **Archive:** `.context-graph` is force-added into the archive snapshot
  (`archiveIncludePaths`) when it has content, so a workspace's context now
  SURVIVES archive and comes back on restore — parity with the harness'
  archived-contexts behavior, implemented with the existing snapshot ref
  mechanism instead of a parallel folder tree.
- **Engine ops:** `context.graph.list` / `.scaffold` / `.setShared` on the
  workspace bridge (`WorkspaceService`). Desktop-only by explicit refusal
  (the `file.ignored` posture): `local/` is private material. Mutations are
  in `WORKSPACE_MUTATIONS` (DB_CHANGED → every client's canvas + git
  surfaces refresh) with no-op results suppressed, and on the lifecycle
  barrier so archive can't race a move.

## 3. The Context tab

Third pinned home tab (`Column3TabType = "context"`), after Changes and
Review — singleton, never closable, seeded/promoted by `normalizeRow1Tabs`
(old persisted slices gain it with no storage-key bump).

The body (`context-row1-tab.tsx`) renders `ContextGraphCanvas`:

- **Auto-layout, never draggable.** Pure function of the stable-sorted item
  list (mtime-ascending): banded grid — Attachments, then Docs — with
  deterministic per-path jitter. New items append; nothing reshuffles.
  A share-toggle move keeps file mtimes, so cards keep their slots.
- **Pan:** drag anywhere, two-finger trackpad scroll, or space+drag.
  **Zoom:** pinch (ctrlKey wheel) or ⌘/Ctrl+scroll, anchored at the cursor,
  0.2×–2.5×. Transforms are written directly to the content element via rAF
  — no React re-render per frame. Zoom pill (bottom-right) shows % and
  re-fits on click.
- **Cards:** images lazy-load through `readWorkspaceFile` (bounded 5 MB data
  URLs) only when scrolled into view AND the tab is active, with a small
  module LRU; md/txt render the listing's inline `previewText` (first ~480
  chars) — no per-card read. Attachment cards carry the **Shared checkbox**
  (checked = `shared/`, committed; unchecked = `local/`, gitignored). No
  other visual separation between the two scopes, by design.
- **Data:** `KeyedAsyncCache` keyed by folder (Rule 11: retained snapshots,
  deduped requests), revalidated on the shared git refresh bus — agent
  turn-end, git writes, engine broadcasts — plus the in-process
  graph-change signal (`notifyContextGraphChanged`), which every staging
  write fires, so a just-attached file appears immediately. The same
  signal is bridged onto the git refresh bus (`use-git-refresh-key.ts`,
  coalesced ~150 ms per workspace), which is what makes the FILES tab's
  tracked + ignored listings pick up `.context-graph/local/…` the moment a
  write lands. A local share toggle force-refreshes and
  `triggerGitRefresh()`s so the Changes tab sees the shared file appear.

## 3b. Files tab (2026-08-02(2))

`.context-graph/local/` was invisible in the Files tab: the ignored-roots
listing used `git ls-files -o -i --exclude-standard --directory
--no-empty-directory` as its "which ignored dirs are non-empty" oracle, and
that flag (a) collapses at a DIFFERENT level than the plain `--directory` run
for the graph's shape (`.context-graph/` vs `.context-graph/local/`), so the
exact-path keep-set classified `local/` as empty, and (b) returns NOTHING for
a subtree whose only non-ignored content is untracked (the moment anything is
shared) — the same pathology that once ate `out/run.log`, now eating a
directory. `listIgnoredRoots` (engine `git/workspace-files.ts`) now runs ONE
git query and decides emptiness itself with concurrent readdir probes
sharing one per-listing budget (`EMPTINESS_PROBE_DIR_BUDGET`, err on
non-empty when spent). The probe skips `.git` at any depth — expansions
never show it, so a vendored checkout cleaned down to its object store
stays suppressed instead of becoming a dead row. Empty ignored dirs still
don't render; `.context-graph/shared/` appears via the tracked/untracked
listing as soon as it holds a file (git cannot list an empty untracked
dir).

## 4. Known edges / follow-ups

- Web/relay clients see a "desktop only" empty state; a remote surface would
  filter to `shared/` and needs a deliberate allowlist decision. (Attach-time
  staging silently no-ops there — the send path's inline blocks are still the
  delivery.)
- The graph only grows (§7): un-attaching a chip, deleting a queued row, and
  every other composer gesture leave staged records in place. Re-attaching
  the same file after removing its chip mints a fresh id, so a new folder
  (and canvas card) appears next to the old one — expected under the
  append-only contract; the user prunes on disk when they care.
- Edit-resubmit of an IMAGE under a non-vision agent stages a fresh
  `att-edit-…` folder per resubmit (the disk write is load-bearing — the
  prompt references the path), so repeated edits accumulate duplicate cards
  for the same bytes. Pre-existing shape; fixing it needs the sent bubble to
  keep a usable link to the original folder.
- Empty dirs can't render in a git-driven tree: `.context-graph/shared/`
  shows in the Files tab only once something is shared; `local/` only once
  something is staged. Finder shows both from scaffold time.
- Legacy `.context/attachments/<chatId>/…` files from older sends are not
  rendered on the canvas (different store, wholly private by contract).
- Listing bounds: 400 items / depth 6 / 2000 entries per dir, `truncated`
  surfaced as a footer notice.
- The share checkbox moves the attachment's whole `<id>` folder; an id
  present in BOTH scopes (hand-copied) is refused rather than clobbered.
- Canvas viewport (pan/zoom) is deliberately ephemeral, like the Browser
  tab's canvas mode — it survives tab switches (the body stays mounted) but
  not a reload.

## 5. 2026-08-03 — attach-time visibility closed for created workspaces; plain nested Files tree

Three defects reported against the 2026-08-02(2) build (fresh workspace
"Mauve": chip in the composer, Context tab "Nothing in the context graph
yet"; Files tab showing a compacted `local/attachments` row):

- **Dispatcher-created workspaces staged nothing until the first send.** The
  dispatcher surface correctly opts out of attach-time staging (its cwd is
  the trunk), and the seed's mount in the new workspace deliberately
  recorded-without-staging — so the graph stayed empty until auto-send,
  which waits on provisioning + a READY agent session (minutes, or forever
  when sign-in is pending). Now `use-composer-editor` runs a stage-only
  SWEEP (`planSeedStage` — skips `att-edit-` ids and
  byte-less chips) of the whole document (a) on seed mounts (`onCreate`) and
  seed swaps (`setContent`), and (b) the moment `useWorkspaceProvisioning`
  flips false for the composer's cwd. Writes are idempotent (same id ⇒ same
  bytes; engine skips same-size re-writes without touching mtime), so
  re-sweeping a restored draft is a no-op that doubles as self-heal.
- **Provisioning writes are refused at the source.** `executeGraphSync` now
  drops the whole plan while `isWorkspaceProvisioning(cwd)` — a stage write
  into the reserved-but-not-yet-created worktree path would mkdir into it
  and fail `git worktree add` itself. (Engine-side `isConfined` already
  fails absent-root writes cleanly; the gate saves the doomed IPCs and makes
  the contract explicit.) Everything skipped is re-covered by the
  provisioning-end sweep.
- **A forced Context-tab reload could be swallowed.** The attach-time write
  signal fires while the tab's activation listing (scaffold + list, two
  bridge round trips) can still be in flight, and `KeyedAsyncCache` dedups a
  forced load into a non-stale pending request — so the PRE-write listing
  satisfied the "refresh now" call AND published as fresh.
  `loadContextGraph` now invalidates the key before every forced load
  (the invalidate-before-load contract the file caches follow): the stale
  in-flight response is generation-blocked from publishing and exactly one
  follow-up fetch runs after it settles.
- **Files tab renders a plain nested tree.** `flattenEmptyDirectories` is
  off (`workspace-file-tree.tsx`): single-child chains no longer compact
  into composite rows like `local/attachments` — the graph now browses
  `.context-graph → local → attachments → <id> → <file>`, Finder-style, one
  row per directory. The ignored-side gitStatus still covers child
  directories (not just roots) so colouring stays correct under either
  configuration.

## 6. 2026-08-03(2) — the "still not working" report was renderer/main build skew; failures are now loud

Field debugging of the third "attachments never appear" report (workspace
"Jasmine", drag-drop, `.context-graph/local/attachments/` empty in Finder)
found the app's own logs full of, for every single attach attempt:

    Error occurred in handler for 'zeros:invoke':
      Error: agent_attachment: missing required string 'chatId'
    …
    [Zeros] IPC: unknown command "agent_attachment_remove".

The dev instance's MAIN process had been running since before 984d8fe
landed: Vite hot-reloads the renderer (which therefore had every fix), but
main/preload/engine are frozen at launch. The old main still had the
legacy Phase-D2 write handler (requires `chatId`, writes
`.context/attachments/<chatId>/…` — a location the canvas never reads) and
no `agent_attachment_remove` at all. So the renderer staged on every attach
and the stale main rejected or misplaced every write — for a full day, with
zero user-visible signal, across two rounds of "fixes" that were correct
but could not take effect without an app relaunch.

Two durable changes:
- **Staging failures are no longer silent.** Every failed stage write logs
  to the structured app log (greppable in app.jsonl), and the first
  failure per workspace per session raises a toast. When the error matches
  a stale-main signature (`unknown command "agent_attachment_*"` /
  `missing required string 'chatId'` — see isBuildSkewFailure), the toast
  says the one thing that fixes it: quit and relaunch. The send path's
  fire-and-forget graph copy logs too.
- **Dev-instance caveat, now written down:** any change to
  electron/ipc/*, preload, or the engine requires restarting the dev app —
  the renderer's HMR will happily run new callers against old handlers.

## 7. 2026-08-03(3) — the graph is append-only from the app

Explicit product decision: once an attachment lands in `.context-graph`,
**nothing the user does in the composer deletes it** — not removing the
still-unsent chip (×, Backspace, select-all delete), not untoggling a
transcript pill, not deleting a queued message, not the send's clear(). The
graph is the workspace's context *record*, and the record must outlive the
composer lifecycle that created it; the only way a file leaves the graph is
the user deleting it on disk (Finder, an editor, `rm`). Re-attaching a file
whose chip was removed mints a fresh id and a fresh folder — accumulation
is the intended trade.

What was DELETED to enforce this (2026-08-02(2)'s unstage machinery):
- `agent_attachment_remove` (IPC command, preload allowlist entry, router
  registration) and the renderer's `removeContextAttachment` façade;
- `removeContextGraphAttachment` in the engine (`setShared` still MOVES a
  record between scopes; no engine op destroys one);
- the `unstage` half of the composer diff (`GraphSyncPlan` is stage-only)
  and its per-id write/remove ordering chain, which only existed so a
  remove→undo flurry couldn't interleave — writes alone are idempotent
  (same id ⇒ same bytes) in any order;
- queued-message deletion's graph cleanup (`deleteQueued`).

This also dissolves the old "orphan record" edge cases (mid-edit attach then
cancel; queued-row deletion) — persistence is now the contract, not a leak.
A future canvas delete affordance, if ever wanted, must be a deliberate
user-facing act on the Context tab, not a side effect of composer editing.
