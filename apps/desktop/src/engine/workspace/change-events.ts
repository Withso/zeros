// ──────────────────────────────────────────────────────────
// Workspace operation → live-data invalidation classifier
// ──────────────────────────────────────────────────────────
//
// Successful bridge mutations are published to the other connected clients as
// DB_CHANGED. Filesystem watchers still cover terminal/agent/external writes;
// this map closes the immediate cross-window/device path for engine operations,
// including local-only lifecycle commands that are intentionally absent from
// the remote write allowlist.
// ──────────────────────────────────────────────────────────

const CHAT_MUTATIONS = new Set([
  "chats.upsert",
  "chats.delete",
  "chats.bulkUpsert",
]);

const PROJECT_MUTATIONS = new Set([
  "project.upsert",
  "project.remove",
  "project.rename",
  "project.bulkUpsert",
]);

const SETTINGS_MUTATIONS = new Set([
  "settings.write",
  "settings.writeRaw",
  "settings.migrateLegacy",
]);

const WORKSPACE_MUTATIONS = new Set([
  // Workspace metadata, worktree lifecycle, and local-main Git bootstrap.
  "workspace.create",
  "workspace.setStatus",
  "workspace.setRemoteRestricted",
  "workspace.reassignLocalOrganization",
  // Rewrites the worktree — folders appear/disappear on disk — so every
  // file-list and git-status consumer has to re-read.
  "workspace.setWorkingDirectories",
  "workspace.archive",
  "workspace.restore",
  "workspace.delete",
  "workspace.createFromBranch",
  "workspace.adoptExisting",
  "workspace.proposeBranchName",
  "workspace.continueOnNewBranch",
  // First-party design document writes. These mutate tracked files or the
  // app-owned canvas document, so every preview/lint consumer must advance in
  // the same exact workspace generation as Files and Changes.
  "design.frame.create",
  "design.frame.rename",
  "design.frame.duplicate",
  "design.frame.delete",
  "design.canvas.update",
  "design.node.styles",
  "design.node.text",
  "design.node.html",
  "design.asset.insert",
  "design.token.update",
  "design.save",
  "git.initInPlace",
  "detach.start",
  "detach.stop",

  // Working tree, index, refs, branches, tags, and remotes.
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.clean",
  "git.commit",
  "git.push",
  "git.pull",
  "git.rebase",
  "git.fetch",
  "git.stashSave",
  "git.stashPop",
  "git.checkoutBranch",
  "git.createBranch",
  "git.renameBranch",
  "git.changeTarget",
  "git.reset",
  "git.restore",
  "git.merge",
  "git.cherryPick",
  "git.revert",
  "git.continue",
  "git.abort",
  "git.stashApply",
  "git.stashDrop",
  "git.deleteBranch",
  "git.stageHunk",
  "git.unstageHunk",
  "git.discardHunk",
  "git.tagCreate",
  "git.tagDelete",

  // GitHub operations can change PR/Review metadata or initialize/push a repo.
  "gh.publishRepo",
  "gh.prCreate",
  "gh.prUpdate",
  "gh.prMarkReady",
  "gh.prMerge",
  "gh.prComment",
  "gh.prSync",

  // Turn restore changes both files and the transcript. Message invalidation is
  // emitted separately with its exact chat id by the engine.
  "turns.reset",
  "turns.undoReset",

  // Files-tab manual save changes content and its Git comparisons.
  "file.write",

  // Context-graph writes: scaffolding the folder skeleton and moving an
  // attachment between the gitignored `local/` and committed `shared/` scopes
  // (the latter changes git status too). No-op results are suppressed in
  // dbChangedKinds so the idempotent re-scaffold on every Context-tab open
  // doesn't broadcast a global refresh.
  "context.graph.scaffold",
  "context.graph.setShared",
]);

/** Ops whose RPC can legitimately outlive the renderer's request budget. Two
 *  families: worktree lifecycle (network fetch + full checkout / snapshot +
 *  eviction) and network-bound git/GitHub writes (push/pull/fetch/rebase and
 *  the PR create/ready/merge calls — a slow remote or the GitHub API can blow
 *  past even the raised 60s renderer budget). For these the DB_CHANGED
 *  broadcast must INCLUDE the originator: its promise may already have
 *  rejected with "Request timeout" while the engine finished the work, and
 *  without the broadcast nothing tells it the result is real (the created row,
 *  the merged PR) — e.g. a >60s "Merge PR" showed "Couldn't merge PR" and left
 *  a stale card even though GitHub merged it. */
export const LONG_LIFECYCLE_OPS = new Set([
  // Worktree lifecycle.
  // Unlinks or materializes every file in the affected folders, so it can run
  // for many seconds. Listed here so the DB_CHANGED goes to the ORIGINATOR
  // too: if its request times out, that client is otherwise the only one left
  // with a stale tree for a change it made itself.
  "workspace.setWorkingDirectories",
  "workspace.create",
  "workspace.createFromBranch",
  "workspace.restore",
  "workspace.archive",
  "workspace.continueOnNewBranch",

  // Network-bound git/GitHub state changes.
  "git.push",
  "git.pull",
  "git.fetch",
  "git.rebase",
  "gh.prCreate",
  "gh.prMarkReady",
  "gh.prMerge",
]);

/** Should the DB_CHANGED broadcast reach the client that CAUSED it?
 *
 *  Normally no — the originator already applied the change locally, so echoing
 *  it back is a wasted refetch. Two families are exceptions:
 *
 *    • LONG_LIFECYCLE_OPS, whose RPC can outlive the renderer's request budget
 *      (see the comment on that set);
 *    • settings writes, because "already applied locally" is only half true.
 *      The write's own result carries the LAYER document, which the renderer
 *      caches — but the RESOLVED tree is a different document merged from four
 *      layers, and nothing in the response describes it. Without the echo the
 *      writer's own `useResolvedSettings` stayed stale until the settings
 *      file-watcher's 3-second poll broadcast to everyone anyway (see
 *      settings/watch.ts POLL_INTERVAL_MS). Settings → Git is where that
 *      showed: its radio group renders `checked` off the resolved tree, so a
 *      click did nothing at all for three seconds and read as a frozen pane.
 *      Every `pick(resolved, …)` provenance tag on the repo settings pages had
 *      the same lag more quietly. Echoing costs one small resolve the poll was
 *      going to force moments later regardless. */
export function dbChangedIncludesOriginator(op: string): boolean {
  return (
    LONG_LIFECYCLE_OPS.has(op) ||
    SETTINGS_MUTATIONS.has(op) ||
    // This maintenance op has no optimistic renderer mutation; the desktop
    // that requested it must refresh its workspace collections too.
    op === "workspace.reassignLocalOrganization"
  );
}

/** Which renderer server-state collections a successful operation changed. */
export function dbChangedKinds(op: string, result?: unknown): string[] | null {
  if (CHAT_MUTATIONS.has(op)) return ["chats"];
  if (PROJECT_MUTATIONS.has(op)) return ["projects"];
  if (SETTINGS_MUTATIONS.has(op)) return ["settings"];
  // Restore can adapt to a sibling path. The engine rebinds every exact and
  // descendant chat folder in the same durable operation, so peers must refresh
  // chats as well as the workspace row or they keep spawning against the old
  // missing cwd.
  if (op === "workspace.restore") return ["workspaces", "chats"];
  // The periodic PR detector is a read until it actually finds and persists a
  // PR. Avoid turning a once-per-minute null probe into a global Git refresh.
  if (op === "gh.prSync" && result == null) return null;
  if (
    op === "workspace.reassignLocalOrganization" &&
    !!result &&
    typeof result === "object" &&
    (result as { changes?: unknown }).changes === 0
  ) {
    return null;
  }
  // Context-graph mutations that changed nothing on disk (the idempotent
  // re-scaffold, an already-in-scope share toggle) don't invalidate anything.
  if (
    (op === "context.graph.scaffold" || op === "context.graph.setShared") &&
    !!result &&
    typeof result === "object" &&
    (result as { created?: boolean; moved?: boolean }).created !== true &&
    (result as { created?: boolean; moved?: boolean }).moved !== true
  ) {
    return null;
  }
  if (WORKSPACE_MUTATIONS.has(op)) return ["workspaces"];
  return null;
}
