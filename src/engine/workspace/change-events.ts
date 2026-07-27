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
  "workspace.archive",
  "workspace.restore",
  "workspace.delete",
  "workspace.createFromBranch",
  "workspace.adoptExisting",
  "workspace.proposeBranchName",
  "workspace.continueOnNewBranch",
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
  if (WORKSPACE_MUTATIONS.has(op)) return ["workspaces"];
  return null;
}
