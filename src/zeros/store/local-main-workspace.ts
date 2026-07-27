// ──────────────────────────────────────────────────────────
// Synthetic "Local main" workspace per project
// ──────────────────────────────────────────────────────────
//
// Every Project shows a permanent first workspace called "Local main"
// representing the project's primary checkout (the `repoRoot`, not a
// linked git worktree). It is:
//   - synthesized at render time (never persisted to state.db)
//   - undeletable (Column 1 hides delete/archive affordances for it)
//   - always the first workspace under its project
//   - the owning workspace for any chat whose `folder === repoRoot`
//
// Pre-roadmap-03a chats were authored before worktrees existed and
// always carried `folder = repoRoot`. Surfacing them as children of
// the Local main row keeps those chats visible in the new tree
// without forcing the user to migrate them into a worktree.
//
// The id format `local:<repoSlug>` is intentionally not a valid
// engine workspace id (no `ws_` prefix). Any IPC call that receives
// this id will fail — callers should branch on `isLocalMainWorkspace()`
// first and fall back to "no engine workspace exists for this row".

import type { Workspace } from "../../native/git";
import type { Project } from "./projects-store";

/** Prefix on the synthetic Local-main workspace id. */
export const LOCAL_MAIN_ID_PREFIX = "local:";

/** Build the synthetic id for a given project's Local main row. */
export function localMainWorkspaceId(repoSlug: string): string {
  return `${LOCAL_MAIN_ID_PREFIX}${repoSlug}`;
}

/** Display label shown in the sidebar + tab strip + breadcrumb.
 *  2026-05-28: shortened from "Local main" to "main" per design pass.
 *  The row is still differentiated from real branches by its
 *  `laptop-minimal` icon (rendered in WorkspaceRow), not the label. */
export const LOCAL_MAIN_LABEL = "main";

/** Test whether a workspace id (or full Workspace) refers to the
 *  synthetic Local main row. Use this before sending the workspace id
 *  to any engine IPC — synthetic ids will fail with WORKSPACE_NOT_FOUND. */
export function isLocalMainWorkspace(idOrWorkspace: string | Workspace): boolean {
  const id =
    typeof idOrWorkspace === "string" ? idOrWorkspace : idOrWorkspace.id;
  return id.startsWith(LOCAL_MAIN_ID_PREFIX);
}

/** Synthesize the Local main workspace record from a Project. The
 *  resulting object has the same shape as an engine-managed Workspace
 *  so the sidebar + tab strip can render it uniformly. */
export function buildLocalMainWorkspace(project: Project): Workspace {
  return {
    id: localMainWorkspaceId(project.repoSlug),
    repoSlug: project.repoSlug,
    repoRoot: project.repoRoot,
    // Branch is unknown at the renderer layer (we'd need a git IPC
    // probe to find HEAD). "main" is the common case and the label
    // is shown verbatim in the breadcrumb. The tab strip uses the
    // sidebar label below, not the branch field.
    branch: "main",
    baseBranch: "main",
    path: project.repoRoot,
    status: "in-progress",
    createdAt: project.addedAt,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    // Local main mirrors the project repo root, which is verified at
    // project-add time. We don't re-stat per render (the project list
    // itself drops projects whose root has gone away). Treat as
    // always-present so the "Worktree missing" placeholder never
    // fires here — that surface is worktree-only.
    present: true,
  };
}

/** Merge the synthetic Local main row with the engine-managed
 *  workspace list, always placing Local main first. Filters archived
 *  rows so they don't show in the sidebar by default. */
export function withLocalMainWorkspace(
  project: Project,
  engineWorkspaces: Workspace[],
): Workspace[] {
  const live = engineWorkspaces.filter((w) => w.archivedAt == null);
  return [buildLocalMainWorkspace(project), ...live];
}
