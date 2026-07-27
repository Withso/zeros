// SQLite-backed state for git workspaces, detach mode, and key/value
// workspace metadata. App state now lives in the single engine-owned
// zeros.db (db/index.ts), reached by every surface through the engine
// bridge. This module is the workspace/git slice of that store:
//
//   - workspace lifecycle — the DB sits next to the worktree folders, so
//       wiping the managed worktree root wipes worktrees + DB together, and
//       we can crash-recover the DB from the app-data row seed.
//
// Crash recovery seed: each workspace drops a JSON copy of its row in the
// app-data seed dir (db/paths.ts `worktreeSeedPath` — NOT in the worktree
// working tree; the in-tree `.zeros/` was retired). If the DB is lost, scanning
// those seeds rebuilds the registry (see `seedFromDisk`). Older worktrees that
// still carry an in-tree `.zeros/workspace.json` are migrated out, and also
// recovered by the legacy scan for back-compat.

import type Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  openZerosDb,
  closeZerosDb,
  setZerosDbPathForTesting,
  zerosWorkspacesRoot,
} from "../db";
import {
  worktreeSeedPath,
  worktreeSeedsRoot,
  zerosDotDirName,
} from "../db/paths";
import type { Workspace, WorkspaceStatus, PrState } from "./types";

export const WORKSPACE_OWNERSHIP_META_KEY = "workspace.ownership.v1";

let rootOverride: string | null = null;

/** Test seam — point the DB + worktrees at a tmpdir without spawning a whole
 *  Electron app. Since Phase 0 the workspace tables live in the unified zeros.db,
 *  so this also redirects that DB. Production callers should never set this. */
export function setStateRootForTesting(root: string | null): void {
  rootOverride = root;
  setZerosDbPathForTesting(root ? path.join(root, "zeros.db") : null);
  // App-data-derived paths (worktree recovery seeds, engine runtime dir) resolve
  // via zerosDataDir() → ZEROS_DATA_DIR. Isolate them under the test root too —
  // in a subdir DISTINCT from the worktrees root — so tests never write seeds
  // into real app-data. (The DB uses the explicit override set above, which
  // wins over zerosDbPath(), so this doesn't move it.)
  if (root) process.env.ZEROS_DATA_DIR = path.join(root, ".appdata");
  else delete process.env.ZEROS_DATA_DIR;
}

/** Pick the on-disk root for git state + worktrees. Split PER CHANNEL so no
 *  channel can trample another's worktrees, state.db or detach.lock. */
export function zerosStateRoot(): string {
  if (rootOverride) return rootOverride;
  // Delegated to db/paths.ts's zerosDotDirName() so there is exactly ONE
  // implementation. This used to inline a TWO-way `isDevRuntime()` split, which
  // left Beta and Production sharing `~/.zeros` — including detach.lock, the
  // single-instance lock (see detachLockPath below and git/detach.ts:17). With
  // Beta holding that lock, Production could not enter detach mode at all.
  return path.join(homedir(), zerosDotDirName());
}

/** The visible worktrees root: ~/zeros/workspaces. Deliberately NOT a hidden
 *  dotdir — users open these checkouts in Finder and their editor.
 *  Tests still isolate under the state root override. */
export function worktreesRoot(): string {
  return rootOverride
    ? path.join(rootOverride, "worktrees")
    : zerosWorkspacesRoot();
}

/** The pre-Phase-0 hidden worktrees root (~/.zeros/worktrees). Used by the
 *  one-time relocation + as a fallback scan in seedFromDisk for any worktree the
 *  move couldn't relocate. Equals worktreesRoot() under the test override. */
export function legacyWorktreesRoot(): string {
  return path.join(zerosStateRoot(), "worktrees");
}

/** Best-effort realpath that tolerates a MISSING leaf: resolves symlinks on the
 *  deepest ancestor that still exists (e.g. macOS /var → /private/var), then
 *  re-appends the not-yet/no-longer-existing tail. A plain realpathSync throws
 *  the instant the leaf is gone and would fall back to the RAW path — leaving the
 *  /var symlink unresolved, so a comparison against a resolved root breaks (a
 *  managed worktree whose folder was deleted out-of-band then reads as foreign).
 *  Never throws — returns the input resolved as far as possible. */
function canonicalizePath(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // hit the fs root; nothing resolved
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True if `p` is (or sits inside) a Zeros-managed worktrees root — the
 *  structural way to recognize our worktrees now that the in-tree `.zeros`
 *  marker is retired. Canonicalizes both sides so symlinked roots still match
 *  AND a managed worktree whose folder was deleted out-of-band is still seen as
 *  managed (not misread as an adopted/foreign worktree — which on macOS would
 *  otherwise route archive to VALIDATION_FAILED instead of WORKTREE_MISSING). */
export function isManagedWorktreePath(p: string): boolean {
  const real = canonicalizePath(p);
  for (const root of [worktreesRoot(), legacyWorktreesRoot()]) {
    const rr = canonicalizePath(root);
    if (real === rr || real.startsWith(rr + path.sep)) return true;
  }
  return false;
}

export function stateDbPath(): string {
  return path.join(zerosStateRoot(), "state.db");
}

export function detachLockPath(): string {
  return path.join(zerosStateRoot(), "detach.lock");
}

/** The workspace tables (workspaces / workspace_meta / detach_state) now live in
 *  the unified engine zeros.db (Phase 0 fold-in; created by migration 7). This
 *  just returns that shared handle — the engine is the single writer. */
function open(): Database.Database {
  return openZerosDb();
}

/** Close on app exit. Best-effort — closes the shared engine DB. */
export function closeState(): void {
  closeZerosDb();
}

// ──────────────────────────────────────────────────────────
// Workspace CRUD
// ──────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  repo_slug: string;
  repo_root: string;
  branch: string;
  base_branch: string;
  path: string;
  status: string;
  created_at: number;
  archived_at: number | null;
  stash_ref: string | null;
  archived_head: string | null;
  archive_snapshot: string | null;
  pr_number: number | null;
  pr_state: string | null;
  pr_url: string | null;
  agent_id: string | null;
  last_active_at: number | null;
  setup_state: string | null;
}

function rowToWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    repoSlug: r.repo_slug,
    repoRoot: r.repo_root,
    branch: r.branch,
    baseBranch: r.base_branch,
    path: r.path,
    status: r.status as WorkspaceStatus,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
    stashRef: r.stash_ref,
    archivedHead: r.archived_head,
    archiveSnapshot: r.archive_snapshot,
    prNumber: r.pr_number,
    prState: r.pr_state as PrState | null,
    prUrl: r.pr_url,
    agentId: r.agent_id,
    lastActiveAt: r.last_active_at,
    setupState: (r.setup_state as Workspace["setupState"]) ?? null,
  };
}

export function insertWorkspace(w: Workspace): void {
  const handle = open();
  handle
    .prepare(
      `INSERT INTO workspaces
        (id, repo_slug, repo_root, branch, base_branch, path, status,
         created_at, archived_at, stash_ref, archived_head, archive_snapshot,
         pr_number, pr_state, pr_url,
         agent_id, last_active_at, setup_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      w.id,
      w.repoSlug,
      w.repoRoot,
      w.branch,
      w.baseBranch,
      w.path,
      w.status,
      w.createdAt,
      w.archivedAt,
      w.stashRef,
      w.archivedHead ?? null,
      w.archiveSnapshot ?? null,
      w.prNumber,
      w.prState,
      w.prUrl,
      w.agentId,
      w.lastActiveAt,
      w.setupState ?? null,
    );
}

/** Publish a workspace row and ownership/provenance metadata atomically. This
 * matters for adopted worktrees: a crash-visible row must never temporarily
 * look Zeros-owned merely because its metadata write had not happened yet. */
export function insertWorkspaceWithMetadata(
  workspace: Workspace,
  metadata: Record<string, string>,
): void {
  const handle = open();
  const tx = handle.transaction(() => {
    insertWorkspace(workspace);
    for (const [key, value] of Object.entries(metadata)) {
      setWorkspaceMeta(workspace.id, key, value);
    }
  });
  tx();
}

export function getWorkspaceById(id: string): Workspace | null {
  const handle = open();
  const row = handle
    .prepare<[string], WorkspaceRow>(`SELECT * FROM workspaces WHERE id = ?`)
    .get(id);
  return row ? rowToWorkspace(row) : null;
}

/** Look up a workspace by its on-disk worktree path. Cross-tool detection uses
 *  this to identify a Zeros-managed worktree from the registry (the in-tree
 *  `.zeros/workspace.json` marker was retired). */
export function getWorkspaceByPath(p: string): Workspace | null {
  const handle = open();
  const row = handle
    .prepare<
      [string],
      WorkspaceRow
    >(`SELECT * FROM workspaces WHERE path = ? LIMIT 1`)
    .get(p);
  return row ? rowToWorkspace(row) : null;
}

export function getWorkspaceByBranch(
  repoSlug: string,
  branch: string,
): Workspace | null {
  const handle = open();
  const row = handle
    .prepare<
      [string, string],
      WorkspaceRow
    >(`SELECT * FROM workspaces WHERE repo_slug = ? AND branch = ?`)
    .get(repoSlug, branch);
  return row ? rowToWorkspace(row) : null;
}

export function listWorkspaces(filter?: {
  repoSlug?: string;
  status?: WorkspaceStatus;
  /** true → only archived rows (History); false → only non-archived rows
   *  (sidebar + Dashboard); undefined → all rows. Archived is identified by
   *  `archived_at`, orthogonal to `status`. */
  archived?: boolean;
}): Workspace[] {
  const handle = open();
  let sql = `SELECT * FROM workspaces`;
  // A create journal is a durable reservation, not a usable workspace yet.
  // Keep it out of every renderer/remote list until the checkout and required
  // provisioning have completed and the journal commits. Recovery still reads
  // the row directly by id.
  const wheres: string[] = [
    `NOT EXISTS (
       SELECT 1 FROM workspace_lifecycle_journal lifecycle
        WHERE lifecycle.workspace_id = workspaces.id
          AND lifecycle.operation = 'create'
     )`,
  ];
  const params: Array<string> = [];
  if (filter?.repoSlug) {
    wheres.push(`repo_slug = ?`);
    params.push(filter.repoSlug);
  }
  if (filter?.status) {
    wheres.push(`status = ?`);
    params.push(filter.status);
  }
  if (filter?.archived === true) {
    wheres.push(`archived_at IS NOT NULL`);
  } else if (filter?.archived === false) {
    wheres.push(`archived_at IS NULL`);
  }
  if (wheres.length > 0) {
    sql += ` WHERE ${wheres.join(" AND ")}`;
  }
  sql += ` ORDER BY created_at DESC`;
  const rows = handle.prepare<typeof params, WorkspaceRow>(sql).all(...params);
  return rows.map(rowToWorkspace);
}

export type WorkspacePatch = Partial<{
  status: WorkspaceStatus;
  archivedAt: number | null;
  stashRef: string | null;
  archivedHead: string | null;
  archiveSnapshot: string | null;
  prNumber: number | null;
  prState: PrState | null;
  prUrl: string | null;
  agentId: string | null;
  lastActiveAt: number | null;
  branch: string;
  baseBranch: string;
  path: string;
  setupState: Workspace["setupState"];
}>;

const PATCH_COLUMN_MAP: Record<keyof WorkspacePatch, string> = {
  status: "status",
  archivedAt: "archived_at",
  stashRef: "stash_ref",
  archivedHead: "archived_head",
  archiveSnapshot: "archive_snapshot",
  prNumber: "pr_number",
  prState: "pr_state",
  prUrl: "pr_url",
  agentId: "agent_id",
  lastActiveAt: "last_active_at",
  branch: "branch",
  baseBranch: "base_branch",
  path: "path",
  setupState: "setup_state",
};

export function updateWorkspace(id: string, patch: WorkspacePatch): void {
  const keys = Object.keys(patch) as Array<keyof WorkspacePatch>;
  if (keys.length === 0) return;
  const handle = open();
  const setClause = keys.map((k) => `${PATCH_COLUMN_MAP[k]} = ?`).join(", ");
  const values = keys.map((k) => patch[k] ?? null);
  handle
    .prepare(`UPDATE workspaces SET ${setClause} WHERE id = ?`)
    .run(...values, id);
}

export function deleteWorkspaceRow(id: string): void {
  const handle = open();
  handle.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
}

// ──────────────────────────────────────────────────────────
// Durable workspace lifecycle journal
// ──────────────────────────────────────────────────────────

export type WorkspaceLifecycleOperation =
  | "create"
  | "archive"
  | "restore"
  | "delete";
export type WorkspaceLifecyclePhase =
  | "prepared"
  | "branch-created"
  | "archive-script-started"
  | "archive-script-finished"
  | "worktree-removed"
  | "worktree-created"
  | "work-applied";

export interface WorkspaceLifecycleJournal {
  workspaceId: string;
  operation: WorkspaceLifecycleOperation;
  phase: WorkspaceLifecyclePhase;
  sourcePath: string;
  targetPath: string | null;
  sourceBranch: string;
  targetBranch: string | null;
  createFrom: string | null;
  archiveSnapshot: string | null;
  archivedHead: string | null;
  adaptations: string[];
  payload: Record<string, unknown>;
  includeBranch: boolean;
  startedAt: number;
}

interface WorkspaceLifecycleJournalRow {
  workspace_id: string;
  operation: WorkspaceLifecycleOperation;
  phase: WorkspaceLifecyclePhase;
  source_path: string;
  target_path: string | null;
  source_branch: string;
  target_branch: string | null;
  create_from: string | null;
  archive_snapshot: string | null;
  archived_head: string | null;
  adaptations_json: string;
  payload_json: string;
  include_branch: number;
  started_at: number;
}

function rowToWorkspaceLifecycle(
  row: WorkspaceLifecycleJournalRow,
): WorkspaceLifecycleJournal {
  let adaptations: string[] = [];
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.adaptations_json) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "string")
    ) {
      adaptations = parsed;
    }
  } catch {
    /* A damaged user-facing note must not block lifecycle recovery. */
  }
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    /* Recovery uses conservative defaults when optional payload is damaged. */
  }
  return {
    workspaceId: row.workspace_id,
    operation: row.operation,
    phase: row.phase,
    sourcePath: row.source_path,
    targetPath: row.target_path,
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    createFrom: row.create_from,
    archiveSnapshot: row.archive_snapshot,
    archivedHead: row.archived_head,
    adaptations,
    payload,
    includeBranch: row.include_branch === 1,
    startedAt: row.started_at,
  };
}

/** Persist intent before the first destructive Git/filesystem step.  The
 * optional workspace patch and journal insert share one SQLite transaction, so
 * an archive snapshot is either discoverable from both records or neither. */
export function beginWorkspaceLifecycle(
  entry: WorkspaceLifecycleJournal,
  patch: WorkspacePatch = {},
): void {
  const handle = open();
  const tx = handle.transaction(() => {
    updateWorkspace(entry.workspaceId, patch);
    handle
      .prepare(
        `INSERT INTO workspace_lifecycle_journal
          (workspace_id, operation, phase, source_path, target_path,
           source_branch, target_branch, create_from, archive_snapshot,
           archived_head, adaptations_json, payload_json, include_branch,
           started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.workspaceId,
        entry.operation,
        entry.phase,
        entry.sourcePath,
        entry.targetPath,
        entry.sourceBranch,
        entry.targetBranch,
        entry.createFrom,
        entry.archiveSnapshot,
        entry.archivedHead,
        JSON.stringify(entry.adaptations),
        JSON.stringify(entry.payload),
        entry.includeBranch ? 1 : 0,
        entry.startedAt,
      );
  });
  tx();
}

/** Create's row and recovery intent must appear together: a crash can then
 * either finish a valid checkout or remove the incomplete reservation, without
 * ever exposing a half-created workspace to list consumers. */
export function insertWorkspaceWithLifecycle(
  workspace: Workspace,
  entry: WorkspaceLifecycleJournal,
  metadata: Record<string, string> = {},
): void {
  const handle = open();
  const tx = handle.transaction(() => {
    insertWorkspace(workspace);
    beginWorkspaceLifecycle(entry);
    const setMeta = handle.prepare(
      `INSERT INTO workspace_meta (workspace_id, key, value)
       VALUES (?, ?, ?)
       ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value`,
    );
    for (const [key, value] of Object.entries(metadata)) {
      setMeta.run(workspace.id, key, value);
    }
  });
  tx();
}

export function getWorkspaceLifecycle(
  workspaceId: string,
): WorkspaceLifecycleJournal | null {
  const row = open()
    .prepare<
      [string],
      WorkspaceLifecycleJournalRow
    >(`SELECT * FROM workspace_lifecycle_journal WHERE workspace_id = ?`)
    .get(workspaceId);
  return row ? rowToWorkspaceLifecycle(row) : null;
}

export function listWorkspaceLifecycles(): WorkspaceLifecycleJournal[] {
  return open()
    .prepare<[], WorkspaceLifecycleJournalRow>(
      `SELECT * FROM workspace_lifecycle_journal
       ORDER BY started_at ASC, workspace_id ASC`,
    )
    .all()
    .map(rowToWorkspaceLifecycle);
}

export function updateWorkspaceLifecyclePhase(
  workspaceId: string,
  phase: WorkspaceLifecyclePhase,
): void {
  open()
    .prepare(
      `UPDATE workspace_lifecycle_journal SET phase = ? WHERE workspace_id = ?`,
    )
    .run(phase, workspaceId);
}

export function updateWorkspaceLifecycleDetails(
  workspaceId: string,
  details: {
    phase: WorkspaceLifecyclePhase;
    adaptations: string[];
    payload: Record<string, unknown>;
    /** Optional target updates let restore adapt again if an unrelated folder
     * occupies its journaled destination before `git worktree add`. Presence
     * (rather than truthiness) distinguishes "leave unchanged" from null. */
    targetPath?: string | null;
    targetBranch?: string | null;
    createFrom?: string | null;
  },
): void {
  const replaceTargetPath = Object.hasOwn(details, "targetPath");
  const replaceTargetBranch = Object.hasOwn(details, "targetBranch");
  const replaceCreateFrom = Object.hasOwn(details, "createFrom");
  open()
    .prepare(
      `UPDATE workspace_lifecycle_journal
          SET phase = ?,
              adaptations_json = ?,
              payload_json = ?,
              target_path = CASE WHEN ? = 1 THEN ? ELSE target_path END,
              target_branch = CASE WHEN ? = 1 THEN ? ELSE target_branch END,
              create_from = CASE WHEN ? = 1 THEN ? ELSE create_from END
        WHERE workspace_id = ?`,
    )
    .run(
      details.phase,
      JSON.stringify(details.adaptations),
      JSON.stringify(details.payload),
      replaceTargetPath ? 1 : 0,
      details.targetPath ?? null,
      replaceTargetBranch ? 1 : 0,
      details.targetBranch ?? null,
      replaceCreateFrom ? 1 : 0,
      details.createFrom ?? null,
      workspaceId,
    );
}

/** Seal the exact post-hook tree before archive removes the checkout. The row
 * and journal advance together so recovery never observes a "safe to remove"
 * phase with stale checkpoint metadata. */
export function sealWorkspaceArchiveCheckpoint(
  workspaceId: string,
  checkpoint: {
    archiveSnapshot: string | null;
    archivedHead: string | null;
  },
): void {
  const handle = open();
  const tx = handle.transaction(() => {
    updateWorkspace(workspaceId, {
      archiveSnapshot: checkpoint.archiveSnapshot,
      archivedHead: checkpoint.archivedHead,
    });
    handle
      .prepare(
        `UPDATE workspace_lifecycle_journal
            SET phase = 'archive-script-finished',
                archive_snapshot = ?,
                archived_head = ?
          WHERE workspace_id = ?
            AND operation = 'archive'`,
      )
      .run(checkpoint.archiveSnapshot, checkpoint.archivedHead, workspaceId);
  });
  tx();
}

/** Commit the externally-visible state and clear its recovery intent in one
 * SQLite transaction.  If the process dies before this commits, startup still
 * sees the journal and rolls forward; if it dies after, readers see only the
 * final state. */
export function finishWorkspaceLifecycle(
  workspaceId: string,
  patch: WorkspacePatch,
  beforeCommit?: () => void,
): void {
  const handle = open();
  const tx = handle.transaction(() => {
    beforeCommit?.();
    updateWorkspace(workspaceId, patch);
    handle
      .prepare(`DELETE FROM workspace_lifecycle_journal WHERE workspace_id = ?`)
      .run(workspaceId);
  });
  tx();
}

/** Used only when no destructive step occurred and abandoning the intent is
 * therefore safe (for example, snapshot creation succeeded but journaling did
 * not). */
export function clearWorkspaceLifecycle(workspaceId: string): void {
  open()
    .prepare(`DELETE FROM workspace_lifecycle_journal WHERE workspace_id = ?`)
    .run(workspaceId);
}

/** Apply an AUTOMATIC lifecycle transition (create → in-progress, PR opened →
 *  in-review, PR merged → done). Two guardrails keep automation from fighting
 *  the user's explicit choices:
 *    - archived rows (archivedAt != null) are FROZEN — never auto-advanced;
 *    - a manually "cancelled" workspace is STICKY — auto-events won't revive it.
 *  Manual sets (the "workspace.setStatus" op / right-click → Set status) write
 *  `status` directly via updateWorkspace and intentionally bypass these guards.
 *  Idempotent: a no-op when the target already matches (avoids DB_CHANGED churn). */
export function advanceLifecycle(id: string, target: WorkspaceStatus): void {
  const ws = getWorkspaceById(id);
  if (!ws) return;
  if (ws.archivedAt != null) return; // frozen while archived
  if (ws.status === "cancelled") return; // respect an explicit manual cancel
  if (ws.status === target) return; // already there — skip the write
  updateWorkspace(id, { status: target });
}

/** Normalize a status string read off a recovery seed file to a valid v18
 *  lifecycle value. Seeds written before v18 carry the old vocabulary
 *  (draft/active/merged/in-review); archived rows never have a seed (the seed is
 *  dropped at archive time), so "archived" shouldn't appear here. Anything
 *  unrecognized falls back to "in-progress". */
export function coerceLifecycleStatus(raw: unknown): WorkspaceStatus {
  switch (raw) {
    case "backlog":
    case "in-progress":
    case "in-review":
    case "done":
    case "cancelled":
      return raw;
    case "merged":
      return "done";
    default:
      return "in-progress"; // draft / active / archived / unknown
  }
}

// ──────────────────────────────────────────────────────────
// workspace_meta — opaque key/value bag per workspace. Used for things
// that don't deserve their own column (e.g. setup-script paths, last
// known model id, list of recently-touched paths).
// ──────────────────────────────────────────────────────────

export function setWorkspaceMeta(
  workspaceId: string,
  key: string,
  value: string,
): void {
  const handle = open();
  handle
    .prepare(
      `INSERT INTO workspace_meta (workspace_id, key, value)
       VALUES (?, ?, ?)
       ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value`,
    )
    .run(workspaceId, key, value);
}

export function getWorkspaceMeta(
  workspaceId: string,
  key: string,
): string | null {
  const handle = open();
  const row = handle
    .prepare<
      [string, string],
      { value: string }
    >(`SELECT value FROM workspace_meta WHERE workspace_id = ? AND key = ?`)
    .get(workspaceId, key);
  return row ? row.value : null;
}

// ──────────────────────────────────────────────────────────
// Remote-access restriction (per-workspace opt-out)
// ──────────────────────────────────────────────────────────
// Default is SHARE-ALL: a paired device sees every workspace, so remote == local.
// The desktop owner can opt a specific workspace OUT in repo settings; a
// restricted workspace is hidden from EVERY relay (web/phone) client — withheld
// from the remote workspace list and its chats withheld too. Backed by its own
// `remote_restricted_workspaces` table (NOT workspace_meta — it must also hold
// the synthetic 'local-main' id, which has no workspaces row and would trip the
// meta FK). Enforced engine-side in WorkspaceService for relay clients only —
// the local desktop is never restricted, and a relay client can never SET this
// (the setter op is off the remote allowlist), so a remote device can neither
// learn nor change what's hidden from it.

export function setWorkspaceRemoteRestricted(
  workspaceId: string,
  restricted: boolean,
): void {
  if (!workspaceId) return;
  const handle = open();
  if (restricted) {
    handle
      .prepare(
        `INSERT INTO remote_restricted_workspaces (workspace_id) VALUES (?)
         ON CONFLICT(workspace_id) DO NOTHING`,
      )
      .run(workspaceId);
  } else {
    handle
      .prepare(
        `DELETE FROM remote_restricted_workspaces WHERE workspace_id = ?`,
      )
      .run(workspaceId);
  }
}

export function isWorkspaceRemoteRestricted(workspaceId: string): boolean {
  return (
    open()
      .prepare(
        `SELECT 1 FROM remote_restricted_workspaces WHERE workspace_id = ?`,
      )
      .get(workspaceId) != null
  );
}

/** The set of workspace ids the owner has hidden from remote (relay) clients.
 *  One query for the whole batch so the remote list filter is O(1) per row;
 *  empty in the common share-all case. */
export function listRemoteRestrictedWorkspaceIds(): Set<string> {
  const rows = open()
    .prepare<
      [],
      { workspace_id: string }
    >(`SELECT workspace_id FROM remote_restricted_workspaces`)
    .all();
  return new Set(rows.map((r) => r.workspace_id));
}

// ──────────────────────────────────────────────────────────
// detach_state — singleton row (id = 1). Used by detach-mode (Phase 4).
// ──────────────────────────────────────────────────────────

export interface DetachStateRow {
  workspaceId: string;
  preRootHead: string;
  checkpointSha: string | null;
  startedAt: number;
  lockfilePid: number;
}

export function getDetachState(): DetachStateRow | null {
  const handle = open();
  const row = handle
    .prepare<
      [],
      {
        workspace_id: string;
        pre_root_head: string;
        checkpoint_sha: string | null;
        started_at: number;
        lockfile_pid: number;
      }
    >(`SELECT * FROM detach_state WHERE id = 1`)
    .get();
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    preRootHead: row.pre_root_head,
    checkpointSha: row.checkpoint_sha,
    startedAt: row.started_at,
    lockfilePid: row.lockfile_pid,
  };
}

export function setDetachState(s: DetachStateRow): void {
  const handle = open();
  handle
    .prepare(
      `INSERT INTO detach_state (id, workspace_id, pre_root_head,
                                  checkpoint_sha, started_at, lockfile_pid)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         workspace_id   = excluded.workspace_id,
         pre_root_head  = excluded.pre_root_head,
         checkpoint_sha = excluded.checkpoint_sha,
         started_at     = excluded.started_at,
         lockfile_pid   = excluded.lockfile_pid`,
    )
    .run(
      s.workspaceId,
      s.preRootHead,
      s.checkpointSha,
      s.startedAt,
      s.lockfilePid,
    );
}

export function clearDetachState(): void {
  const handle = open();
  handle.prepare(`DELETE FROM detach_state WHERE id = 1`).run();
}

// ──────────────────────────────────────────────────────────
// Crash recovery — rebuild the registry by walking worktrees/<slug>/<id>/.zeros/workspace.json
// ──────────────────────────────────────────────────────────

/** Write a workspace's crash-recovery seed to app-data (`worktreeSeedPath`,
 *  keyed by the worktree path) — NOT into the worktree working tree. Best-effort;
 *  zeros.db is the primary registry, this is the disk recovery net. */
export function writeWorktreeSeed(ws: Workspace): void {
  try {
    const seedPath = worktreeSeedPath(ws.path);
    mkdirSync(path.dirname(seedPath), { recursive: true });
    writeFileSync(seedPath, JSON.stringify(ws, null, 2), "utf8");
  } catch {
    /* best-effort recovery net */
  }
}

/** Remove a workspace's app-data crash-recovery seed (on delete/archive), so
 *  app-data seeds don't outlive their worktree. */
export function removeWorktreeSeed(worktreePath: string): void {
  try {
    const seedPath = worktreeSeedPath(worktreePath);
    rmSync(seedPath, { force: true });
    rmdirSync(path.dirname(seedPath)); // removes the per-worktree dir if empty
  } catch {
    /* not present / non-empty — ignore */
  }
}

/** Scan the app-data seed dir for `workspace.json` seeds and re-insert any
 *  missing workspace whose worktree still exists. The current home for seeds
 *  (the in-worktree `.zeros/workspace.json` was retired). Uses each seed's own
 *  `path`; idempotent — existing ids skipped, vanished worktrees not resurrected. */
function seedFromAppData(): { inserted: number; skipped: number } {
  let inserted = 0;
  let skipped = 0;
  const root = worktreeSeedsRoot();
  let keyDirs: string[];
  try {
    keyDirs = readdirSync(root);
  } catch {
    return { inserted: 0, skipped: 0 };
  }
  for (const keyDir of keyDirs) {
    let seed: Partial<Workspace>;
    try {
      seed = JSON.parse(
        readFileSync(path.join(root, keyDir, "workspace.json"), "utf8"),
      );
    } catch {
      continue;
    }
    // C9: never reconstruct without a real repoRoot/branch/path.
    if (!seed.id || !seed.repoRoot || !seed.branch || !seed.path) {
      if (seed.id) skipped++;
      continue;
    }
    // Folder-is-truth: don't resurrect a workspace whose worktree is gone.
    if (!existsSync(seed.path)) {
      skipped++;
      continue;
    }
    if (getWorkspaceById(seed.id)) {
      skipped++;
      continue;
    }
    insertWorkspace({
      id: seed.id,
      repoSlug: seed.repoSlug ?? path.basename(path.dirname(seed.path)),
      repoRoot: seed.repoRoot,
      branch: seed.branch,
      baseBranch: seed.baseBranch ?? "main",
      path: seed.path,
      status: coerceLifecycleStatus(seed.status),
      createdAt: seed.createdAt ?? Date.now(),
      archivedAt: seed.archivedAt ?? null,
      stashRef: seed.stashRef ?? null,
      prNumber: seed.prNumber ?? null,
      prState: seed.prState ?? null,
      prUrl: seed.prUrl ?? null,
      agentId: seed.agentId ?? null,
      lastActiveAt: seed.lastActiveAt ?? null,
    });
    inserted++;
  }
  return { inserted, skipped };
}

/** Scan ONE worktrees root for `.zeros/workspace.json` seeds and re-insert any
 *  missing workspace. Idempotent — existing ids are skipped. */
function seedFromRoot(root: string): { inserted: number; skipped: number } {
  let inserted = 0;
  let skipped = 0;
  let repoDirs: string[];
  try {
    repoDirs = readdirSync(root);
  } catch {
    return { inserted: 0, skipped: 0 };
  }
  for (const repoSlug of repoDirs) {
    let workspaceDirs: string[];
    try {
      workspaceDirs = readdirSync(path.join(root, repoSlug));
    } catch {
      continue;
    }
    for (const wsDir of workspaceDirs) {
      const wsPath = path.join(root, repoSlug, wsDir);
      const seedPath = path.join(wsPath, ".zeros", "workspace.json");
      let raw: string;
      try {
        raw = readFileSync(seedPath, "utf8");
      } catch {
        continue;
      }
      let seed: Partial<Workspace>;
      try {
        seed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!seed.id) continue;
      // C9: never reconstruct a workspace without a real repoRoot/branch.
      // A row with repoRoot:"" makes every later git op fall back to the
      // engine's cwd (the main repo), so `worktree remove` / `branch -D`
      // could hit the WRONG repository. Skip rather than insert junk.
      if (!seed.repoRoot || !seed.branch) {
        skipped++;
        continue;
      }
      const existing = getWorkspaceById(seed.id);
      if (existing) {
        skipped++;
        continue;
      }
      const ws: Workspace = {
        id: seed.id,
        repoSlug: seed.repoSlug ?? repoSlug,
        repoRoot: seed.repoRoot,
        branch: seed.branch,
        baseBranch: seed.baseBranch ?? "main",
        path: wsPath,
        status: coerceLifecycleStatus(seed.status),
        createdAt: seed.createdAt ?? Date.now(),
        archivedAt: seed.archivedAt ?? null,
        stashRef: seed.stashRef ?? null,
        prNumber: seed.prNumber ?? null,
        prState: seed.prState ?? null,
        prUrl: seed.prUrl ?? null,
        agentId: seed.agentId ?? null,
        lastActiveAt: seed.lastActiveAt ?? null,
      };
      insertWorkspace(ws);
      inserted++;
    }
  }
  return { inserted, skipped };
}

/** Crash recovery: rebuild the registry from `.zeros/workspace.json` seeds.
 *  Scans BOTH the visible worktrees root AND the legacy hidden root (deduped if
 *  equal, e.g. under the test override), so a worktree the Phase-0 relocation
 *  couldn't move is still recovered. Idempotent — existing ids are skipped. */
export function seedFromDisk(): { inserted: number; skipped: number } {
  open(); // ensure DB exists
  // Primary: the app-data seeds (the current home). Then the legacy in-worktree
  // `.zeros/workspace.json` seeds (older worktrees, pre-retirement) so nothing
  // created before the move is lost.
  const fromApp = seedFromAppData();
  let inserted = fromApp.inserted;
  let skipped = fromApp.skipped;
  const roots = [worktreesRoot(), legacyWorktreesRoot()].filter(
    (r, i, a) => a.indexOf(r) === i,
  );
  for (const root of roots) {
    const r = seedFromRoot(root);
    inserted += r.inserted;
    skipped += r.skipped;
  }
  return { inserted, skipped };
}

/** One-time migration: move any existing in-worktree `<path>/.zeros/workspace.json`
 *  seed to app-data and delete the in-tree `.zeros/`, so Zeros leaves no `.zeros`
 *  in any worktree. Runs at boot AFTER `seedFromDisk` (registry populated).
 *  Best-effort + idempotent (no-ops once a worktree is clean). */
export function migrateLegacyWorktreeSeeds(): { migrated: number } {
  let migrated = 0;
  let workspaces: Workspace[];
  try {
    workspaces = listWorkspaces();
  } catch {
    return { migrated: 0 };
  }
  for (const ws of workspaces) {
    const legacyDir = path.join(ws.path, ".zeros");
    if (!existsSync(path.join(legacyDir, "workspace.json"))) continue;
    writeWorktreeSeed(ws); // app-data copy from the authoritative DB row
    try {
      rmSync(path.join(legacyDir, "workspace.json"), { force: true });
      rmdirSync(legacyDir); // only if empty
    } catch {
      /* non-empty / gone — leave it */
    }
    migrated++;
  }
  return { migrated };
}
