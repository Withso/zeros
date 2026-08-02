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
- **Attachments:** `encodeAttachments` (the single staged-attachment →
  wire-content chokepoint) now stages EVERY valid attachment into
  `local/attachments/` via the `agent_attachment_write` IPC: images (vision
  and non-vision paths) and text files / chat transcripts. For text + vision
  sends the graph copy is additive — failure never skips the attachment; the
  non-vision image path still treats the write as load-bearing (the prompt
  references the path).
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
  turn-end (which is when attachment writes land), git writes, engine
  broadcasts — and force-refreshed after a local toggle, which also
  `triggerGitRefresh()`s so the Changes tab sees the shared file appear.

## 4. Known edges / follow-ups

- Web/relay clients see a "desktop only" empty state; a remote surface would
  filter to `shared/` and needs a deliberate allowlist decision.
- Legacy `.context/attachments/<chatId>/…` files from older sends are not
  rendered on the canvas (different store, wholly private by contract).
- Listing bounds: 400 items / depth 6 / 2000 entries per dir, `truncated`
  surfaced as a footer notice.
- The share checkbox moves the attachment's whole `<id>` folder; an id
  present in BOTH scopes (hand-copied) is refused rather than clobbered.
- Canvas viewport (pan/zoom) is deliberately ephemeral, like the Browser
  tab's canvas mode — it survives tab switches (the body stays mounted) but
  not a reload.
