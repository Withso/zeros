// ──────────────────────────────────────────────────────────
// Workspace resolution — folder path → owning Project
// ──────────────────────────────────────────────────────────
//
// Shared helper used by every Conversation pane surface (top bar, chat-tabs
// strip, EmptyComposer) to answer: "which project owns this folder?".
//
// Two cases the resolver must handle:
//
//   1. The folder IS or is UNDER the project's primary checkout.
//      Example: a chat at `/Users/dev/Documents/widgets` for the project
//      with `repoRoot = /Users/dev/Documents/widgets`. Matches via exact
//      path or path-prefix.
//
//   2. The folder is a linked git worktree managed by Zeros under the current
//      human layout `~/zeros[-dev]/workspaces/<repository>/<workspace-name>/`,
//      or the legacy `~/.zeros[-dev]/worktrees/<slug>/<workspaceId>/`. This path
//      does NOT start with `project.repoRoot`, so the prefix check fails. We
//      resolve the embedded repository directory against a unique repo basename
//      (current) or repoSlug (legacy).
//
// Without case 2 the top bar + chat-tabs surfaces fall back to
// "No workspace selected" the moment the user enters a Zeros worktree
// — the bug from screenshot 6:24:32 PM.

import type { Project } from "./projects-store";
import {
  adoptedWorktreeSlug,
  isAdoptedWorktreePath,
} from "./adopted-worktrees";

// The "<worktree-root>/<repository-directory>/" shape of a managed worktree.
// This is the ONE definition of "what a Zeros worktree path looks like" —
// projects-store.ts isWorktreePath() reuses it (so the two can never drift,
// the bug that registered worktrees as phantom top-level projects). Matches
// BOTH layouts:
//   • current visible root  ~/zeros[-<channel>][-<instance>]/workspaces/<repo>/<name>/
//   • legacy hidden root    ~/.zeros[-<channel>]/worktrees/<slug>/<wsId>/
// The engine's zerosWorkspacesRoot() (apps/desktop/src/engine/db/paths.ts) names the visible
// root `zeros-<channel>[-<instance>]` — e.g. `zeros-dev`, `zeros-beta`, and for a
// per-worktree dev instance `zeros-dev-<slug>` (like `zeros-dev-mogadishu-5486`).
// Design workspaces use the sibling `design workspaces` segment under that same
// root; both layouts carry the same repository/workspace owner segments.
// The suffix after `zeros-` / `.zeros-` is intentionally treated as the rest of
// the path segment, so per-worktree dev roots resolve without a backtracking
// regex. Keep in sync with zerosWorkspacesRoot() / legacyWorktreesRoot().
function matchesRootSegment(
  segment: string,
  bare: ".zeros" | "zeros",
): boolean {
  return (
    segment === bare ||
    (segment.startsWith(`${bare}-`) && segment.length > bare.length + 1)
  );
}

function worktreePathParts(folder: string): {
  repositoryDirectory: string;
  workspaceDirectory: string;
  kind: "code" | "design";
} | null {
  const parts = folder.split("/").filter(Boolean);
  for (let i = 0; i + 3 < parts.length; i += 1) {
    const root = parts[i] ?? "";
    const layout = parts[i + 1] ?? "";
    const matchesLegacyRoot =
      matchesRootSegment(root, ".zeros") && layout === "worktrees";
    const matchesVisibleRoot =
      matchesRootSegment(root, "zeros") &&
      (layout === "workspaces" || layout === "design workspaces");
    if (matchesLegacyRoot || matchesVisibleRoot) {
      return {
        repositoryDirectory: parts[i + 2] ?? "",
        workspaceDirectory: parts[i + 3] ?? "",
        kind:
          matchesVisibleRoot && layout === "design workspaces"
            ? "design"
            : "code",
      };
    }
  }
  return null;
}

/** Synchronous presentation identity for a cold remembered managed path. */
export function workspaceKindFromManagedPath(
  folder: string | null | undefined,
): "code" | "design" | null {
  if (!folder) return null;
  return worktreePathParts(folder)?.kind ?? null;
}

/** A confirmed Workspace row is authoritative. Pending/path hints exist only
 * to paint a prepared destination before that row arrives; they must
 * never turn a confirmed code workspace into a design surface. */
export function resolveWorkspacePresentationKind(input: {
  confirmedKind?: "code" | "design" | null;
  pendingKind?: "code" | "design" | null;
  folder?: string | null;
}): "code" | "design" {
  if (input.confirmedKind) return input.confirmedKind;
  return (
    input.pendingKind ??
    workspaceKindFromManagedPath(input.folder) ??
    "code"
  );
}

/** Extract a repoSlug from a Zeros-managed worktree path.
 *
 *  Matches both prod and dev layouts, current (`~/zeros/workspaces/…`) and
 *  legacy (`~/.zeros/worktrees/…`). Returns null when the path isn't under a
 *  worktree root — e.g. a primary checkout, or a foreign worktree adopted in
 *  place from another tool, where path-based lookup needs another path.
 */
export function repoSlugFromWorktreePath(folder: string): string | null {
  if (!folder) return null;
  // Legacy paths embed repoSlug. Current human-readable paths embed the
  // repository folder name; findProjectForFolder accepts either identity.
  return worktreePathParts(folder)?.repositoryDirectory ?? null;
}

/** True when the path is a Zeros-managed linked worktree (either root). A
 *  worktree path must NEVER be registered as a top-level project — it belongs
 *  to the project resolved from its embedded repository directory (see
 *  findProjectForFolder). Re-exported from projects-store.ts for callers there. */
export function isWorktreePath(folder: string | null | undefined): boolean {
  if (!folder) return false;
  // A Zeros-managed worktree path OR a foreign worktree the user
  // adopted in place (recorded path) — both must NEVER become a phantom
  // top-level project; they resolve to their parent project below.
  return worktreePathParts(folder) !== null || isAdoptedWorktreePath(folder);
}

/** Extract the engine `Workspace.id` from a Zeros-managed worktree path.
 *
 * Legacy layouts encoded the opaque id in the directory name. Current layouts
 * intentionally use the human workspace name instead, so they must resolve via
 * the authoritative workspace list/path mapping and this helper returns null.
 * Tolerates a trailing subdirectory for legacy worktrees.
 */
export function workspaceIdFromWorktreePath(
  folder: string | null | undefined,
): string | null {
  if (!folder) return null;
  const directory = worktreePathParts(folder)?.workspaceDirectory;
  return directory && /^ws_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(directory)
    ? directory
    : null;
}

function managedDirectorySegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 96);
}

/** macOS symlinks /tmp, /var, /etc under /private, so a folder captured as
 *  `/private/var/…` and a workspace stored as `/var/…` (or vice versa) are
 *  the same place. Normalize the `/private` prefix before comparing paths. */
function normalizePath(p: string): string {
  const normalized = p.replace(/^\/private(\/(?:var|tmp|etc)(?:\/|$))/, "$1");
  return normalized.replace(/\/+$/, "") || "/";
}

/** Whether `folder` is `root` or one of its descendants. This is the shared
 * semantic-owner check for both resolution and explicit deletion cleanup, so
 * a chat rooted in `workspace/packages/app` cannot outlive that workspace's UI
 * memory merely because its cwd is more specific than the worktree row. */
export function folderIsWithinRoot(
  folder: string | null | undefined,
  root: string | null | undefined,
): boolean {
  if (!folder || !root) return false;
  const normalizedFolder = normalizePath(folder);
  const normalizedRoot = normalizePath(root);
  return (
    normalizedFolder === normalizedRoot ||
    (normalizedRoot === "/"
      ? normalizedFolder.startsWith("/")
      : normalizedFolder.startsWith(`${normalizedRoot}/`))
  );
}

/** Resolve the engine workspace that owns a folder: an exact match OR the
 *  folder being a subdirectory of the workspace path, with /private symlink
 *  normalization on both sides. Replaces a bare `w.path === folder`, which
 *  missed chats opened in a worktree subdir and the /private-vs-plain path
 *  forms (the "No workspace selected" flicker in a fresh worktree). */
export function findWorkspaceForFolder<T extends { path: string }>(
  folder: string | null | undefined,
  workspaces: readonly T[],
): T | null {
  if (!folder) return null;
  return workspaces.find((w) => folderIsWithinRoot(folder, w.path)) ?? null;
}

/** Resolve the exact folder allowed to own Conversation pane's first paint.
 *
 * A prepared create publishes its destination + first Untitled chat atomically
 * in the workspace store, but the authoritative workspace row and the separate
 * pending-create store can arrive on later renders. Accept that exact prepared
 * snapshot for presentation only; callers must still gate agent/PTY work on
 * authoritative provisioning state. Requiring both the matching validation key
 * and a live chat prevents a stale or unrelated folder from becoming visible.
 */
export function resolveWorkspacePresentationFolder(args: {
  activeFolder: string | null;
  hasResolvedWorkspace: boolean;
  isProvisioning: boolean;
  pendingValidationFolder: string | null;
  hasLiveChatAtActiveFolder: boolean;
}): string | null {
  const {
    activeFolder,
    hasResolvedWorkspace,
    isProvisioning,
    pendingValidationFolder,
    hasLiveChatAtActiveFolder,
  } = args;
  if (!activeFolder) return null;
  const hasPreparedDestination =
    pendingValidationFolder === activeFolder && hasLiveChatAtActiveFolder;
  return hasResolvedWorkspace || isProvisioning || hasPreparedDestination
    ? activeFolder
    : null;
}

/** Resolve the engine `workspaceId` to spawn/resume an agent in for a cwd.
 *
 *  Two-step: prefer an id embedded in a legacy managed path, then look the cwd
 *  up in the supplied workspace list. The list covers current human-readable
 *  managed paths, primary checkout `local-main`, and adopted foreign worktrees.
 *  Returns null when neither resolves, so callers send no `workspaceId` and the
 *  engine falls back to `cwd`.
 *
 *  A remote relay spawn MUST carry a workspaceId (the engine rejects a bare
 *  host path), so the bridge workspace list is passed here to cover
 *  `local-main` and every managed workspace. */
export function workspaceIdForCwd<T extends { id: string; path: string }>(
  cwd: string | null | undefined,
  workspaces: T[],
): string | null {
  return (
    workspaceIdFromWorktreePath(cwd) ??
    workspaces.find((w) => w.id === cwd)?.id ??
    findWorkspaceForFolder(cwd, workspaces)?.id ??
    null
  );
}

/** Resolve the MAIN-checkout repo root that owns a cwd, from a workspace list.
 *  Used by the env-vault courier to pick the repo scope for a spawn: managed
 *  worktrees resolve via findWorkspaceForFolder (path match), and a primary
 *  checkout matches a workspace's repoRoot directly (exact or subdirectory).
 *  Null when the cwd belongs to no known workspace — plain-folder chats get
 *  user-scope vars only. */
export function repoRootForCwd<T extends { path: string; repoRoot: string }>(
  cwd: string | null | undefined,
  workspaces: T[],
): string | null {
  if (!cwd) return null;
  const byPath = findWorkspaceForFolder(cwd, workspaces);
  if (byPath) return byPath.repoRoot;
  const f = normalizePath(cwd);
  const byRoot = workspaces.find((w) => {
    const root = normalizePath(w.repoRoot);
    return f === root || f.startsWith(root + "/");
  });
  return byRoot?.repoRoot ?? null;
}

/** Resolve the project that owns the given folder.
 *
 *  Strategy:
 *    1. Exact match against project.repoRoot.
 *    2. Managed/adopted worktree identity.
 *    3. Most-specific path-prefix match (folder is under the project's repo).
 *
 *  Returns null when no project matches — e.g. the folder is an
 *  un-tracked path (chat from before backfill, foreign worktree).
 */
export function findProjectForFolder(
  folder: string | null | undefined,
  projects: readonly Project[],
): Project | null {
  if (!folder) return null;
  // Normalize the /private symlink on BOTH sides, matching
  // findWorkspaceForFolder — Finder/Electron hands us `/private/var/…`
  // while a stored repoRoot may be `/var/…` (or vice versa); a raw string
  // compare then yields project:null → "No workspace selected" inside a
  // valid checkout.
  const f = normalizePath(folder);
  const exact = projects.find((p) => normalizePath(p.repoRoot) === f);
  if (exact) return exact;
  // Managed/adopted worktree identities are more specific than a broad
  // checkout prefix. A worktree may physically live below another registered
  // repo root; its embedded/recorded owner must win before prefix matching.
  const slug = repoSlugFromWorktreePath(folder);
  if (slug) {
    // Old layout: directory === repoSlug. New layout: directory === sanitized
    // basename(repoRoot), with repoSlug as the collision fallback. Prefer the
    // exact slug because it is globally unique; only accept a basename match
    // when it identifies one project.
    const exactSlug = projects.find((p) => p.repoSlug === slug);
    if (exactSlug) return exactSlug;
    const basenameMatches = projects.filter(
      (project) =>
        managedDirectorySegment(
          normalizePath(project.repoRoot).split("/").filter(Boolean).at(-1) ??
            "",
        ) === slug,
    );
    const managed =
      basenameMatches.length === 1 ? (basenameMatches[0] ?? null) : null;
    if (managed) return managed;
  }
  // 4. Foreign worktree adopted in place: its external path matches no managed
  //    root, so resolve via the recorded path → slug map (written at "Add local
  //    project" time).
  const adoptedSlug = adoptedWorktreeSlug(folder);
  if (adoptedSlug) {
    const adopted = projects.find((p) => p.repoSlug === adoptedSlug);
    if (adopted) return adopted;
  }
  // Nested repositories are legal. Pick the most-specific checkout root, not
  // whichever parent happened to appear first in the registry.
  let prefixed: Project | null = null;
  let prefixLength = -1;
  for (const project of projects) {
    if (!folderIsWithinRoot(folder, project.repoRoot)) continue;
    const length = normalizePath(project.repoRoot).length;
    if (length <= prefixLength) continue;
    prefixed = project;
    prefixLength = length;
  }
  return prefixed;
}

/** Project-aware deletion ownership. Known nested repositories/worktrees are
 * protected; fallback roots cover stale workspace paths whose registry row is
 * already gone. Callers resolve the project list once per deletion, never on a
 * hot navigation/render path. */
export function folderIsOwnedByProject(
  folder: string,
  projectId: string,
  projects: Project[],
  fallbackRoots: readonly string[] = [],
): boolean {
  const owner = findProjectForFolder(folder, projects);
  if (owner) return owner.id === projectId;
  return fallbackRoots.some((root) => folderIsWithinRoot(folder, root));
}
