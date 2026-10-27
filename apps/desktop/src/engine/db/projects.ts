// ──────────────────────────────────────────────────────────
// Projects — the `repos` table in the unified Zeros DB
// ──────────────────────────────────────────────────────────
//
// A "project" in the UI = a Git repository the user has added (a top-level
// row). The renderer keeps a localStorage boot cache, and every mutation is
// written through here so the engine-owned `repos` table remains authoritative.
//
// Source of truth = the `repos` table. It is SEEDED from the engine's known
// workspaces (every repo that has a worktree becomes a project). Desktop
// write-through also populates repositories that have no worktree yet.
// `listProjects()` is the read served by the `project.list` bridge operation.
//
// Shape matches the renderer's Project (apps/desktop/src/renderer/state/projects-store.ts) so
// the repository-navigation components consume it unchanged.
// ──────────────────────────────────────────────────────────

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { openZerosDb, zerosWorkspacesRoot } from "./index";
import { zerosStateRoot } from "./paths";

/** Mirror of the renderer's Project (projects-store.ts). originUrl maps to the
 *  repos.remote_url column; addedAt to repos.added_at. */
export interface EngineProject {
  id: string;
  /** Immutable cross-placement UUID. `id` remains the path-derived local
   * compatibility alias. */
  canonicalId: string;
  name: string;
  repoRoot: string;
  repoSlug: string;
  originUrl: string | null;
  /** Native revision: a stale renderer cache cannot undo a verified move. */
  originRevision: number;
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
  canonical_id: string;
  name: string | null;
  remote_url: string | null;
  origin_revision: number;
  root_path: string | null;
  repo_slug: string | null;
  added_at: number | null;
}

function toProject(r: RepoRow): EngineProject {
  const repoRoot = r.root_path ?? "";
  return {
    id: r.id,
    canonicalId: r.canonical_id,
    name: r.name ?? deriveName(repoRoot),
    repoRoot,
    repoSlug: r.repo_slug ?? "",
    originUrl: r.remote_url ?? null,
    originRevision: r.origin_revision,
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
    `INSERT INTO repos
       (id, canonical_id, name, repo_slug, root_path, added_at)
     VALUES (@id, @canonical_id, @name, @repo_slug, @root_path, @added_at)`,
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
        canonical_id: randomUUID(),
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
      "SELECT id, canonical_id, name, remote_url, origin_revision, root_path, repo_slug, added_at FROM repos WHERE hidden = 0 ORDER BY added_at ASC, name ASC",
    )
    .all() as RepoRow[];
  return rows.map(toProject);
}

// ── Write-through (desktop pushes its curated projects here) ──
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
  originRevision?: number;
}

/** Insert or update a repo by root. Preserves the existing id + added_at on
 *  update; refreshes the curated fields (name / slug / origin). New rows retain
 *  the cached Origin revision so rebuilding the registry does not reset CAS. */
export function upsertRepoByRoot(p: ProjectInput): void {
  if (!p.repoRoot) return;
  const root = canonicalRepoRoot(p.repoRoot);
  openZerosDb()
    .prepare(
      `INSERT INTO repos
         (id, canonical_id, name, repo_slug, remote_url, origin_revision, root_path, added_at)
       VALUES (@id, @canonical_id, @name, @repo_slug, @remote_url, @origin_revision, @root_path, @added_at)
       ON CONFLICT(root_path) DO UPDATE SET
         name       = excluded.name,
         repo_slug  = COALESCE(NULLIF(excluded.repo_slug, ''), repos.repo_slug),
         remote_url = CASE WHEN @origin_provided = 1 AND (repos.hidden = 1 OR repos.origin_revision = @origin_revision)
           THEN excluded.remote_url ELSE repos.remote_url END,
         origin_revision = repos.origin_revision + CASE
           WHEN repos.hidden = 1 OR (repos.origin_revision = @origin_revision
             AND @origin_provided = 1 AND excluded.remote_url IS NOT repos.remote_url)
           THEN 1 ELSE 0 END,
         hidden     = 0,
         updated_at = datetime('now')`,
    )
    .run({
      id: projectIdForRoot(root),
      canonical_id: randomUUID(),
      name: p.name || deriveName(root),
      repo_slug: p.repoSlug ?? "",
      remote_url: p.originUrl ?? null,
      origin_provided: p.originUrl === undefined ? 0 : 1,
      origin_revision: p.originRevision ?? 0,
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
  const db = openZerosDb(), root = canonicalRepoRoot(repoRoot);
  db.transaction(() => {
    // Explicit re-adds may point at a replacement checkout at the same path.
    db.prepare("DELETE FROM github_repository_remotes WHERE repo_id IN (SELECT id FROM repos WHERE root_path = ?)").run(root);
    db.prepare(
      "UPDATE repos SET hidden = 1, origin_revision = origin_revision + 1, updated_at = datetime('now') WHERE root_path = ?",
    ).run(root);
  })();
}

/** Explicit re-adds reconcile old workspace history before unhiding the repo. */
export function isRemovedRepoRoot(repoRoot: string): boolean {
  return openZerosDb()
    .prepare("SELECT 1 FROM repos WHERE root_path = ? AND hidden = 1")
    .get(canonicalRepoRoot(repoRoot)) != null;
}

export function listRemovedRepoRoots(): Set<string> {
  const rows = openZerosDb().prepare<[], { root_path: string }>(
    "SELECT root_path FROM repos WHERE hidden = 1 AND root_path IS NOT NULL",
  ).all();
  return new Set(rows.map((row) => row.root_path));
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
 *  through the remote-code-execution gate. */
export function isKnownRepoRoot(repoRoot: string): boolean {
  if (!repoRoot) return false;
  const root = canonicalRepoRoot(repoRoot);
  return (
    openZerosDb()
      .prepare("SELECT 1 FROM repos WHERE root_path = ? AND hidden = 0")
      .get(root) != null
  );
}

/** Read without seeding/unhiding a removed project. */
export function projectForRoot(repoRoot: string): EngineProject | null {
  const row = openZerosDb().prepare(
    "SELECT id, canonical_id, name, remote_url, origin_revision, root_path, repo_slug, added_at FROM repos WHERE root_path = ? AND hidden = 0",
  ).get(canonicalRepoRoot(repoRoot)) as RepoRow | undefined;
  return row ? toProject(row) : null;
}

export interface GithubRemoteIdentity {
  remote: string;
  url: string;
  repositoryId: string;
  nodeId: string;
  owner: string;
  repo: string;
  /** Verified pre-rename URLs retained until native metadata commits. */
  pendingUrls?: string[];
}

/** A manual change retires the binding unless it is a verified pending move.
 * Both sides of that move must resolve by ID if a process exits mid-commit. */
export function githubRemoteIdentity(repoRoot: string, remote: string, url: string): GithubRemoteIdentity | null {
  const row = openZerosDb().prepare(`SELECT r.remote_name AS remote, r.remote_url AS url,
    r.github_repository_id AS repositoryId, r.github_node_id AS nodeId, r.owner, r.name AS repo,
    r.pending_urls AS pendingUrls
    FROM github_repository_remotes r JOIN repos p ON p.id = r.repo_id
    WHERE p.root_path = ? AND p.hidden = 0 AND r.remote_name = ? AND
      (r.remote_url = ? OR EXISTS (SELECT 1 FROM json_each(r.pending_urls) WHERE value = ?))`)
    .get(canonicalRepoRoot(repoRoot), remote, url, url) as (Omit<GithubRemoteIdentity, "pendingUrls"> & { pendingUrls: string }) | undefined;
  return row ? { ...row, pendingUrls: JSON.parse(row.pendingUrls) as string[] } : null;
}

function putGithubRemoteIdentities(db: ReturnType<typeof openZerosDb>, repoId: string, identities: GithubRemoteIdentity[]): void {
  const put = db.prepare(`INSERT INTO github_repository_remotes
    (repo_id, remote_name, remote_url, github_repository_id, github_node_id, owner, name, pending_urls)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_id, remote_name) DO UPDATE SET
    remote_url = excluded.remote_url, github_repository_id = excluded.github_repository_id,
    github_node_id = excluded.github_node_id, owner = excluded.owner, name = excluded.name, pending_urls = excluded.pending_urls`);
  for (const identity of identities) put.run(repoId, identity.remote, identity.url, identity.repositoryId,
    identity.nodeId, identity.owner, identity.repo, JSON.stringify(identity.pendingUrls ?? []));
}

/** Write the verified move sources before renaming Git config. A failed final
 * commit leaves this record available for a later ID-verified retry. */
export function prepareGithubRemoteIdentities(owner: EngineProject, identities: GithubRemoteIdentity[]): boolean {
  const db = openZerosDb();
  return db.transaction(() => {
    const current = projectForRoot(owner.repoRoot);
    if (!current || current.canonicalId !== owner.canonicalId || current.originRevision !== owner.originRevision) return false;
    putGithubRemoteIdentities(db, owner.id, identities);
    return true;
  })();
}

/** Called at the admitted Git-config commit, with no asynchronous work between
 * the final owner check, filesystem rename and this native metadata commit. */
export function saveGithubRemoteIdentities(owner: EngineProject, identities: GithubRemoteIdentity[], originUrl: string | null,
  moves: { from: string; to: string }[] = []): EngineProject | null {
  const db = openZerosDb();
  return db.transaction(() => {
    const current = projectForRoot(owner.repoRoot);
    if (!current || current.canonicalId !== owner.canonicalId || current.originRevision !== owner.originRevision) return null;
    putGithubRemoteIdentities(db, owner.id, identities);
    if (current.originUrl !== originUrl) db.prepare(`UPDATE repos SET remote_url = ?, origin_revision = origin_revision + 1,
      updated_at = datetime('now') WHERE id = ?`).run(originUrl, owner.id);
    // PR numbers are repository-scoped. Only rewrite a link that names this
    // verified source; an adopted PR from an unrelated upstream stays intact.
    for (const move of moves) db.prepare(`UPDATE workspaces SET pr_url = ? || pr_number
      WHERE repo_root = ? AND pr_number IS NOT NULL AND lower(pr_url) = lower(? || pr_number)`)
      .run(`https://github.com/${move.to}/pull/`, owner.repoRoot, `https://github.com/${move.from}/pull/`);
    return projectForRoot(owner.repoRoot);
  })();
}

/** The user-visible project name of an open (non-hidden) repo, or null when
 *  the root isn't registered. Read-only — never seeds a row — so callers that
 *  only need a display name (first-use Design folder naming) cannot create
 *  project state as a side effect. */
export function projectNameForRoot(repoRoot: string): string | null {
  if (!repoRoot) return null;
  const row = openZerosDb()
    .prepare("SELECT name FROM repos WHERE root_path = ? AND hidden = 0")
    .get(canonicalRepoRoot(repoRoot)) as { name: string | null } | undefined;
  const name = row?.name?.trim();
  return name ? name : null;
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
 *  `~/.zeros/worktrees` root, not the relocated `~/zeros/workspaces` root —
 *  wrote worktrees through to this table as phantom projects (the
 *  `ws_*` workspace rows in repository navigation). Delete any repos row whose root_path sits
 *  under a worktree root. Idempotent + best-effort; a real repo lives outside
 *  the worktree roots, so this can never touch one. Returns the count removed.
 *  Runs at engine boot so the DB self-heals regardless of bridge/renderer timing. */
export function pruneWorktreeRepos(): number {
  const roots = Array.from(
    new Set([
      zerosWorkspacesRoot(),
      // Legacy hidden root (pre Phase-0 relocation), CHANNEL-aware. Was a 2-way
      // isDevRuntime() split, so Beta pruned against PRODUCTION's legacy root.
      path.join(zerosStateRoot(), "worktrees"),
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
