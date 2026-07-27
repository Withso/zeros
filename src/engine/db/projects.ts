// ──────────────────────────────────────────────────────────
// Projects — the `repos` table in the unified Zeros DB
// ──────────────────────────────────────────────────────────
//
// A "project" in the UI = a git repo the user has added (Column 1's top-level
// row). The renderer keeps a localStorage boot cache, and every mutation is
// written through here so the engine-owned `repos` table remains authoritative.
//
// Source of truth = the `repos` table. It is SEEDED from the engine's known
// workspaces (every repo that has a worktree becomes a project), and will later
// also be populated by desktop write-through for repos that have no worktree yet
// (Phase 1b). `listProjects()` is the read served by the `project.list` bridge op.
//
// Shape matches the renderer's Project (src/zeros/store/projects-store.ts) so
// the existing Column-1 components consume it unchanged.
// ──────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { openZerosDb, zerosWorkspacesRoot } from "./index";
import { zerosDotDirName } from "./paths";

/** Mirror of the renderer's Project (projects-store.ts). originUrl maps to the
 *  repos.remote_url column; addedAt to repos.added_at. */
export interface EngineProject {
  id: string;
  name: string;
  repoRoot: string;
  repoSlug: string;
  originUrl: string | null;
  addedAt: number;
}

/** Minimal slice of a workspace needed to seed a repo row. */
interface WorkspaceSeed {
  repoSlug: string;
  repoRoot: string;
}

/** Resolve a repo root to the identity path stored in the DB.
 *
 *  `path.resolve` removes lexical duplicates (`.` / `..` / trailing slash).
 *  `realpathSync.native` folds symlinks when the folder exists. Missing paths
 *  are tolerated for tests and stale DB rows, which still need stable handling.
 */
function canonicalRepoRoot(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Stable, deterministic project id from the repo root (one repo per path).
 *  Stable across restarts so every caller agrees on the same id for the same
 *  canonical repo root. */
function projectIdForRoot(repoRoot: string): string {
  return `proj_${createHash("sha1").update(canonicalRepoRoot(repoRoot)).digest("hex").slice(0, 12)}`;
}

/** Leaf folder name from a repo root (matches the renderer's deriveProjectName). */
function deriveName(repoRoot: string): string {
  const trimmed = repoRoot.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const name = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  return name || repoRoot;
}

interface RepoRow {
  id: string;
  name: string | null;
  remote_url: string | null;
  root_path: string | null;
  repo_slug: string | null;
  added_at: number | null;
}

function toProject(r: RepoRow): EngineProject {
  const repoRoot = r.root_path ?? "";
  return {
    id: r.id,
    name: r.name ?? deriveName(repoRoot),
    repoRoot,
    repoSlug: r.repo_slug ?? "",
    originUrl: r.remote_url ?? null,
    addedAt: r.added_at ?? 0,
  };
}

/** Ensure a `repos` row exists for every distinct repo among the given
 *  workspaces. Idempotent (keyed on root_path) — never overwrites a row that
 *  desktop write-through may have enriched with an origin URL / custom name. */
export function ensureReposFromWorkspaces(workspaces: WorkspaceSeed[]): void {
  const db = openZerosDb();
  const seen = new Set<string>();
  const exists = db.prepare("SELECT 1 FROM repos WHERE root_path = ?");
  const insert = db.prepare(
    `INSERT INTO repos (id, name, repo_slug, root_path, added_at)
     VALUES (@id, @name, @repo_slug, @root_path, @added_at)`,
  );
  const now = Date.now();
  const tx = db.transaction((rows: WorkspaceSeed[]) => {
    for (const w of rows) {
      const root = canonicalRepoRoot(w.repoRoot);
      if (!root || seen.has(root)) continue;
      seen.add(root);
      if (exists.get(root)) continue;
      insert.run({
        id: projectIdForRoot(root),
        name: deriveName(root),
        repo_slug: w.repoSlug || "",
        root_path: root,
        added_at: now,
      });
    }
  });
  tx(workspaces);
}

/** All projects, seeded from the given workspaces first. The shape the
 *  `project.list` bridge op returns. */
export function listProjects(seedWorkspaces: WorkspaceSeed[]): EngineProject[] {
  ensureReposFromWorkspaces(seedWorkspaces);
  const db = openZerosDb();
  const rows = db
    .prepare(
      "SELECT id, name, remote_url, root_path, repo_slug, added_at FROM repos WHERE hidden = 0 ORDER BY added_at ASC, name ASC",
    )
    .all() as RepoRow[];
  return rows.map(toProject);
}

// ── Write-through (Phase 1b: desktop pushes its curated projects here) ──
//
// Keyed on root_path (one repo per path; id is derived from it). "Remove" HIDES
// the row (hidden = 1) instead of deleting it, so a repo that still has a
// worktree isn't re-seeded back into view by listProjects() on the next call —
// the removal sticks until the folder is explicitly re-added (which un-hides
// it). This is the fix for "a project I removed keeps coming back" (e.g. the
// parent repo of a worktree, or the engine's own dev source tree, which the
// user never explicitly added).

interface ProjectInput {
  repoRoot: string;
  repoSlug?: string;
  name?: string | null;
  originUrl?: string | null;
}

/** Insert or update a repo by root. Preserves the existing id + added_at on
 *  update; refreshes the curated fields (name / slug / origin). */
export function upsertRepoByRoot(p: ProjectInput): void {
  if (!p.repoRoot) return;
  const root = canonicalRepoRoot(p.repoRoot);
  openZerosDb()
    .prepare(
      `INSERT INTO repos (id, name, repo_slug, remote_url, root_path, added_at)
       VALUES (@id, @name, @repo_slug, @remote_url, @root_path, @added_at)
       ON CONFLICT(root_path) DO UPDATE SET
         name       = excluded.name,
         repo_slug  = COALESCE(NULLIF(excluded.repo_slug, ''), repos.repo_slug),
         remote_url = COALESCE(excluded.remote_url, repos.remote_url),
         hidden     = 0,
         updated_at = datetime('now')`,
    )
    .run({
      id: projectIdForRoot(root),
      name: p.name || deriveName(root),
      repo_slug: p.repoSlug ?? "",
      remote_url: p.originUrl ?? null,
      root_path: root,
      added_at: Date.now(),
    });
}

/** "Remove" a repo by root — HIDES it (hidden = 1) rather than deleting the row.
 *  Deleting didn't stick: ensureReposFromWorkspaces() re-seeds any repo that
 *  still has a worktree on the next listProjects(), so a removed parent-repo (or
 *  the engine's own worktree root) reappeared every time. Hiding survives the
 *  re-seed (the row already exists, so it's skipped) and listProjects() filters
 *  hidden = 0, so the removal sticks. Re-adding the folder un-hides it. */
export function removeRepoByRoot(repoRoot: string): void {
  if (!repoRoot) return;
  openZerosDb()
    .prepare(
      "UPDATE repos SET hidden = 1, updated_at = datetime('now') WHERE root_path = ?",
    )
    .run(canonicalRepoRoot(repoRoot));
}

/** Root paths of every open (non-hidden) project. Read-only, no seeding side
 *  effect (unlike `listProjects`) — cheap enough to call on hot paths like the
 *  PTY cwd allowlist, which must trust a freshly-added repo's root even before
 *  any worktree exists for it. */
export function listKnownRepoRoots(): string[] {
  const rows = openZerosDb()
    .prepare(
      "SELECT root_path FROM repos WHERE hidden = 0 AND root_path IS NOT NULL",
    )
    .all() as Array<{ root_path: string | null }>;
  return rows
    .map((r) => r.root_path ?? "")
    .filter((p): p is string => p.length > 0);
}

/** True when `repoRoot` is an already-open, non-hidden project. Used to FAIL
 *  CLOSED on a remote `workspace.create`: a remote device may only create a
 *  worktree in a repo the owner already opened — never an arbitrary host path
 *  (the C1 RCE gate). */
export function isKnownRepoRoot(repoRoot: string): boolean {
  if (!repoRoot) return false;
  const root = canonicalRepoRoot(repoRoot);
  return (
    openZerosDb()
      .prepare("SELECT 1 FROM repos WHERE root_path = ? AND hidden = 0")
      .get(root) != null
  );
}

/** Rename a repo by root. */
export function renameRepoByRoot(repoRoot: string, name: string): void {
  if (!repoRoot) return;
  openZerosDb()
    .prepare(
      "UPDATE repos SET name = ?, updated_at = datetime('now') WHERE root_path = ?",
    )
    .run(name, canonicalRepoRoot(repoRoot));
}

/** Bulk upsert (the desktop boot sync of its localStorage projects). Atomic. */
export function bulkUpsertRepos(projects: ProjectInput[]): void {
  const db = openZerosDb();
  const tx = db.transaction((rows: ProjectInput[]) => {
    for (const p of rows) upsertRepoByRoot(p);
  });
  tx(projects);
}

/** One-time cleanup of phantom worktree "projects". A worktree path must never
 *  be a top-level repo, but a stale renderer regex — it only knew the legacy
 *  `~/.zeros/worktrees` root, not the relocated `~/zeros/workspaces` root
 *  (Phase 0) — wrote worktrees THROUGH to this table as phantom projects (the
 *  `ws_*` W-icon rows in Column 1). Delete any repos row whose root_path sits
 *  under a worktree root. Idempotent + best-effort; a real repo lives outside
 *  the worktree roots, so this can never touch one. Returns the count removed.
 *  Runs at engine boot so the DB self-heals regardless of bridge/renderer timing. */
export function pruneWorktreeRepos(): number {
  const roots = Array.from(
    new Set([
      zerosWorkspacesRoot(),
      // Legacy hidden root (pre Phase-0 relocation), CHANNEL-aware. Was a 2-way
      // isDevRuntime() split, so Beta pruned against PRODUCTION's legacy root.
      path.join(homedir(), zerosDotDirName(), "worktrees"),
    ]),
  ).map((r) => canonicalRepoRoot(r).replace(/\/+$/, "") + "/");
  const db = openZerosDb();
  const rows = db.prepare("SELECT root_path FROM repos").all() as {
    root_path: string | null;
  }[];
  const victims = rows
    .map((r) => r.root_path)
    .filter(
      (p): p is string =>
        typeof p === "string" && roots.some((root) => p.startsWith(root)),
    );
  if (victims.length === 0) return 0;
  const del = db.prepare("DELETE FROM repos WHERE root_path = ?");
  const tx = db.transaction((paths: string[]) => {
    for (const p of paths) del.run(p);
  });
  tx(victims);
  return victims.length;
}
