// ──────────────────────────────────────────────────────────
// Projects store — Repository panel's top-level entity
// ──────────────────────────────────────────────────────────
//
// A Project = a git repo the user has opened in Zeros. Holds:
//   - `repoRoot`: absolute path of the main checkout
//   - `repoSlug`: derived from origin URL (matches engine state.db)
//   - `name`:    user-visible label (defaults to the repo's basename)
//   - `addedAt`: when the project first appeared in the sidebar
//
// Each Project is the parent of zero or more Workspaces (worktrees,
// see workspaces-cache.ts). Each Workspace is the parent of zero or
// more Chats (existing chats table, joined by chat.folder === ws.path).
//
// Persistence: localStorage under `zeros-projects-v1`. Mirrors the
// pattern in apps/desktop/src/renderer/platform/recent-projects.ts so the two stay in sync —
// recent-projects-v1 still drives "Open project" recents, projects-v1
// is the sidebar's permanent registry.
//
// Boot-time backfill (Option A): on first load after this lands,
// `ensureProjectFromFolder()` walks every existing chat's `folder`
// and registers a project for each unique repo root. Existing chats
// keep working; users just see them grouped under their project.
// ──────────────────────────────────────────────────────────

import { getSetting, setSetting } from "../platform/settings";
import { getActiveBridge } from "../platform/bridge/active-bridge";
import { isWorktreePath } from "./workspace-resolution";
import {
  bridgeProjectUpsert,
  bridgeProjectRemove,
  bridgeProjectBulkUpsert,
} from "../platform/bridge/workspace-bridge";

const STORAGE_KEY = "projects-v1";
/** Sibling key holding the last non-empty project list. Mirrors the
 *  CHATS_BACKUP_KEY pattern in app-shell.tsx — survives the "my LS
 *  got wiped by a tooling mishap" class of bugs, where the primary
 *  key disappears but the backup carries the last good state. */
const BACKUP_KEY = "projects-v1-backup";

export interface Project {
  id: string;
  name: string;
  repoRoot: string;
  repoSlug: string;
  /** GitHub origin URL when we could read it. Used by the PR picker. */
  originUrl: string | null;
  addedAt: number;
}

/** Renderer-side path normalization for the localStorage boot cache.
 *
 *  The engine performs realpath canonicalization before writing `repos`. The
 *  renderer cannot reliably realpath in the browser context, but it can still
 *  remove lexical duplicates and macOS `/private/{var,tmp,etc}` aliases so the
 *  sidebar does not create obvious duplicate projects before the engine syncs.
 */
export function normalizeProjectRoot(repoRoot: string): string {
  const trimmed = repoRoot.trim().replace(/\/+$/, "") || repoRoot.trim();
  return trimmed.replace(/^\/private(\/(?:var|tmp|etc)(?:\/|$))/, "$1");
}

function normalizeProjectList(projects: Project[]): {
  projects: Project[];
  changed: boolean;
} {
  let changed = false;
  const byRoot = new Map<string, Project>();
  for (const project of projects) {
    const root = normalizeProjectRoot(project.repoRoot);
    const existing = byRoot.get(root);
    if (root !== project.repoRoot) changed = true;
    if (!existing) {
      byRoot.set(root, { ...project, repoRoot: root });
      continue;
    }
    changed = true;
    if (!existing.originUrl && project.originUrl)
      existing.originUrl = project.originUrl;
    if (!existing.repoSlug && project.repoSlug)
      existing.repoSlug = project.repoSlug;
    if (!existing.name && project.name) existing.name = project.name;
    existing.addedAt = Math.min(existing.addedAt, project.addedAt);
  }
  return { projects: Array.from(byRoot.values()), changed };
}

// ── Storage ──────────────────────────────────────────────

export function loadProjects(): Project[] {
  const primary = getSetting<Project[]>(STORAGE_KEY, []);
  if (Array.isArray(primary) && primary.length > 0) {
    const normalized = normalizeProjectList(primary);
    if (normalized.changed) {
      setSetting(STORAGE_KEY, normalized.projects);
      setSetting(BACKUP_KEY, normalized.projects);
    }
    return normalized.projects;
  }
  // Primary empty → fall back to backup if it has entries. Re-seed the
  // primary so subsequent reads short-circuit on the fast path and the
  // mirror effect doesn't repeatedly trip the recovery branch.
  const backup = getSetting<Project[]>(BACKUP_KEY, []);
  if (Array.isArray(backup) && backup.length > 0) {
    const normalized = normalizeProjectList(backup);
    console.warn(
      `[Zeros] projects empty — restored ${normalized.projects.length} from backup`,
    );
    setSetting(STORAGE_KEY, normalized.projects);
    if (normalized.changed) setSetting(BACKUP_KEY, normalized.projects);
    return normalized.projects;
  }
  return [];
}

/** True when `cwd` is the root of a registered project — the synthetic
 *  "Local main" trunk. Sync localStorage read. Used by the file-read façade to
 *  route trunk reads (which have no workspace row and aren't under electron-main's
 *  trusted IPC roots) through the engine bridge instead of electron IPC. */
export function isKnownProjectRoot(cwd: string): boolean {
  if (!cwd) return false;
  const root = normalizeProjectRoot(cwd);
  return loadProjects().some((p) => p.repoRoot === root);
}

function saveProjects(projects: Project[]): void {
  setSetting(STORAGE_KEY, projects);
  // Only update the backup when we have something worth keeping. An
  // accidental wipe-then-render cycle should NOT poison the backup
  // with an empty list — that would defeat recovery.
  if (projects.length > 0) {
    setSetting(BACKUP_KEY, projects);
  }
}

// ── Engine write-through ─────────────────────────────────────
//
// localStorage stays the desktop's boot cache, but the engine's `repos` table
// is the source of truth exposed to optional remote relay clients. So every
// mutation is mirrored to the engine, keyed on repoRoot. Best-effort + fire-and-forget:
// a bridge hiccup must never break the local sidebar. No-op when no bridge is
// attached (e.g. before connect — the boot sync below re-pushes on connect).

function pushUpsert(p: Project): void {
  const bridge = getActiveBridge();
  if (!bridge) return;
  void bridgeProjectUpsert(bridge, {
    repoRoot: p.repoRoot,
    repoSlug: p.repoSlug,
    name: p.name,
    originUrl: p.originUrl,
  }).catch(() => {});
}

function pushRemove(repoRoot: string): void {
  const bridge = getActiveBridge();
  if (!bridge) return;
  void bridgeProjectRemove(bridge, repoRoot).catch(() => {});
}

/** Push ALL local projects to the engine in one shot. Captures curated projects
 *  that predate write-through (and any added while the bridge was down). Called
 *  on bridge connect by useSyncProjectsToEngine(). Best-effort. */
export function syncProjectsToEngine(): void {
  const bridge = getActiveBridge();
  if (!bridge) return;
  const projects = loadProjects();
  if (projects.length === 0) return;
  void bridgeProjectBulkUpsert(
    bridge,
    projects.map((p) => ({
      repoRoot: p.repoRoot,
      repoSlug: p.repoSlug,
      name: p.name,
      originUrl: p.originUrl,
    })),
  ).catch(() => {});
}

// ── Pure helpers ─────────────────────────────────────────

/** Derive a project name from the repo root path. Strips trailing
 *  slashes and uses the leaf folder name. */
export function deriveProjectName(repoRoot: string): string {
  const trimmed = repoRoot.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const name = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  return name || repoRoot;
}

/** Mirror of the engine's `repoSlugFromOriginUrl()`. We re-implement
 *  it here so the renderer can derive slugs without an IPC round-trip
 *  when adding a project. Keep in sync with apps/desktop/src/engine/git/repo.ts. */
export function repoSlugFromOriginUrl(url: string): string {
  if (!url) return "";
  let rest: string;
  const sshMatch = url.match(/^[^@]+@[^:]+:(.+)$/);
  if (sshMatch) {
    rest = sshMatch[1];
  } else {
    const httpMatch = url.match(/^https?:\/\/[^/]+\/(.+)$/);
    rest = httpMatch ? httpMatch[1] : url;
  }
  rest = rest.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!rest) return "";
  return rest
    .toLowerCase()
    .replace(/[/\\]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Fallback slug when there's no origin URL — uses the path's last
 *  segment. Not as stable as origin-derived but lets folder-only
 *  projects coexist with cloned ones in the sidebar. */
export function repoSlugFromPath(repoRoot: string): string {
  const name = deriveProjectName(repoRoot);
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function projectId(): string {
  return `proj_${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── CRUD ─────────────────────────────────────────────────

/** Add (or upsert) a project by repo root. Idempotent — if a project
 *  with this root already exists, its `addedAt` is bumped to now and
 *  the existing record is returned unchanged. Returns the canonical
 *  project record. */
export function upsertProject(args: {
  repoRoot: string;
  repoSlug?: string;
  originUrl?: string | null;
  name?: string;
}): Project {
  const repoRoot = normalizeProjectRoot(args.repoRoot);
  const projects = loadProjects();
  const existing = projects.find((p) => p.repoRoot === repoRoot);
  if (existing) {
    // Bump origin / slug if we now know them and didn't before.
    let changed = false;
    if (args.originUrl && !existing.originUrl) {
      existing.originUrl = args.originUrl;
      changed = true;
    }
    if (args.repoSlug && existing.repoSlug !== args.repoSlug) {
      existing.repoSlug = args.repoSlug;
      changed = true;
    }
    // Self-heal a blank name (e.g. a no-origin repo adopted before this fix) —
    // derive it from the path on the next upsert (re-adopt, boot sync, etc.).
    if (!existing.name) {
      existing.name = deriveProjectName(existing.repoRoot);
      changed = true;
    }
    if (changed) {
      saveProjects(projects);
      pushUpsert(existing);
    }
    return existing;
  }
  const slug =
    args.repoSlug ||
    (args.originUrl ? repoSlugFromOriginUrl(args.originUrl) : "") ||
    repoSlugFromPath(repoRoot);
  const project: Project = {
    id: projectId(),
    name: args.name || deriveProjectName(repoRoot),
    repoRoot,
    repoSlug: slug,
    originUrl: args.originUrl ?? null,
    addedAt: Date.now(),
  };
  saveProjects([project, ...projects]);
  pushUpsert(project);
  return project;
}

export function removeProject(projectId: string): void {
  const projects = loadProjects();
  const target = projects.find((p) => p.id === projectId);
  const next = projects.filter((p) => p.id !== projectId);
  saveProjects(next);
  // Removing the LAST project must ALSO clear the backup. saveProjects() leaves
  // the backup untouched on an empty list (so an accidental wipe can recover),
  // but an explicit removal is intentional — and without this, loadProjects()
  // sees the empty primary, restores the just-removed repo from the stale
  // backup, and it reappears ("the only repo left won't delete").
  if (next.length === 0) setSetting(BACKUP_KEY, []);
  if (target) pushRemove(target.repoRoot);
}

// ── Worktree-path detection ──────────────────────────────

// `isWorktreePath` is defined in ./workspace-resolution — the single source of
// truth for "what a Zeros worktree path looks like" (current ~/zeros/workspaces
// root AND legacy ~/.zeros/worktrees). It's imported above for internal use and
// re-exported here so existing importers (features/repositories/repositories-panel.tsx) keep their path. A
// worktree path must never become a top-level project — that's the phantom
// W-icon row bug (root cause: this used to carry its own stale regex).
export { isWorktreePath } from "./workspace-resolution";

/** One-shot migration: walk the projects list and remove any whose
 *  `repoRoot` is a Zeros-managed worktree path. These are phantom
 *  rows that the legacy backfill created before it learned to skip
 *  worktrees. Returns the count of pruned projects so the caller can
 *  decide whether to log/toast.
 *
 *  Idempotent — re-running is a no-op once the list is clean.
 */
export function pruneWorktreePhantomProjects(): number {
  const projects = loadProjects();
  const kept: Project[] = [];
  const pruned: Project[] = [];
  for (const p of projects) {
    (isWorktreePath(p.repoRoot) ? pruned : kept).push(p);
  }
  if (pruned.length > 0) {
    saveProjects(kept);
    // Evict from the engine `repos` table too. saveProjects() only fixes the
    // local boot cache, but these phantoms were also written through to the
    // canonical repos table — leaving them there means remote relay clients keep
    // showing them. Best-effort (no-op without a bridge); the engine ALSO prunes them
    // at boot (pruneWorktreeRepos), so the DB gets cleaned either way.
    for (const p of pruned) pushRemove(p.repoRoot);
  }
  return pruned.length;
}
