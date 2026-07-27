// ──────────────────────────────────────────────────────────
// Last-confirmed per-repository workspace snapshots
// ──────────────────────────────────────────────────────────
//
// Workspace lists are engine-owned server state, but the last exact-key result
// is safe to paint while that same key revalidates. Keeping a small validated
// mirror makes a cold app reopen show the selected worktree immediately. The
// caller still treats restored rows as provisional for navigation decisions:
// only a live engine response may invalidate a remembered destination.

import type { PrState, Workspace, WorkspaceStatus } from "../../native/git";
import { getSetting, removeSetting, setSetting } from "../../native/settings";

const STORAGE_KEY = "workspace-lists:v1";
const MAX_REPOSITORIES = 32;
const MAX_ROWS_PER_REPOSITORY = 512;
/** Leave headroom in the shared origin quota for chats, drafts, and settings. */
const MAX_SERIALIZED_CHARS = 1_500_000;
const MAX_IDENTITY_CHARS = 4_096;

const VALID_STATUSES = new Set<WorkspaceStatus>([
  "backlog",
  "in-progress",
  "in-review",
  "done",
  "cancelled",
]);
const VALID_PR_STATES = new Set<PrState>([
  "draft",
  "ready",
  "merged",
  "closed",
]);
const VALID_SETUP_STATES = new Set(["running", "passed", "failed", "stopped"]);

interface PersistedWorkspaceList {
  repoSlug: string;
  savedAt: number;
  rows: Workspace[];
}

interface PersistedWorkspaceLists {
  version: 1;
  entries: PersistedWorkspaceList[];
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_IDENTITY_CHARS
    ? value
    : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return string(value) ?? undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null || (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

/** Validate and copy a row so corrupt storage cannot leak an object with the
 * wrong owner or shape into hot selectors. */
export function sanitizePersistedWorkspace(
  value: unknown,
  repoSlug: string,
): Workspace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = string(raw.id);
  const rowRepoSlug = string(raw.repoSlug);
  const repoRoot = string(raw.repoRoot);
  const branch = string(raw.branch);
  const baseBranch = string(raw.baseBranch);
  const path = string(raw.path);
  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : null;
  const archivedAt = nullableNumber(raw.archivedAt);
  const stashRef = nullableString(raw.stashRef);
  const prNumber = nullableNumber(raw.prNumber);
  const prUrl = nullableString(raw.prUrl);
  const agentId = nullableString(raw.agentId);
  const lastActiveAt = nullableNumber(raw.lastActiveAt);
  if (
    !id ||
    rowRepoSlug !== repoSlug ||
    !repoRoot ||
    branch === null ||
    baseBranch === null ||
    !path ||
    !VALID_STATUSES.has(raw.status as WorkspaceStatus) ||
    createdAt === null ||
    archivedAt === undefined ||
    stashRef === undefined ||
    prNumber === undefined ||
    prUrl === undefined ||
    agentId === undefined ||
    lastActiveAt === undefined
  ) {
    return null;
  }
  const prState = raw.prState;
  if (prState !== null && !VALID_PR_STATES.has(prState as PrState)) return null;
  if (
    raw.setupState !== undefined &&
    raw.setupState !== null &&
    !VALID_SETUP_STATES.has(raw.setupState as string)
  ) {
    return null;
  }
  if (raw.present !== undefined && typeof raw.present !== "boolean")
    return null;
  if (raw.hasChanges !== undefined && typeof raw.hasChanges !== "boolean") {
    return null;
  }

  return {
    id,
    repoSlug,
    repoRoot,
    branch,
    baseBranch,
    path,
    status: raw.status as WorkspaceStatus,
    createdAt,
    archivedAt,
    stashRef,
    prNumber,
    prState: prState as PrState | null,
    prUrl,
    agentId,
    lastActiveAt,
    ...(raw.setupState !== undefined
      ? {
          setupState: raw.setupState as Workspace["setupState"],
        }
      : {}),
    ...(typeof raw.present === "boolean" ? { present: raw.present } : {}),
    ...(typeof raw.hasChanges === "boolean"
      ? { hasChanges: raw.hasChanges }
      : {}),
  };
}

function sanitizeRows(value: unknown, repoSlug: string): Workspace[] | null {
  if (!Array.isArray(value) || value.length > MAX_ROWS_PER_REPOSITORY) {
    return null;
  }
  const rows: Workspace[] = [];
  const ids = new Set<string>();
  for (const valueRow of value) {
    const row = sanitizePersistedWorkspace(valueRow, repoSlug);
    if (!row || ids.has(row.id)) return null;
    ids.add(row.id);
    rows.push(row);
  }
  return rows;
}

function loadEntries(): PersistedWorkspaceList[] {
  const raw = getSetting<unknown>(STORAGE_KEY, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.entries)) return [];

  const bySlug = new Map<string, PersistedWorkspaceList>();
  for (const value of record.entries.slice(-MAX_REPOSITORIES)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const repoSlug = string(entry.repoSlug);
    const savedAt = entry.savedAt;
    if (!repoSlug || typeof savedAt !== "number" || !Number.isFinite(savedAt)) {
      continue;
    }
    const rows = sanitizeRows(entry.rows, repoSlug);
    if (!rows) continue;
    bySlug.delete(repoSlug);
    bySlug.set(repoSlug, { repoSlug, savedAt, rows });
  }
  return [...bySlug.values()].slice(-MAX_REPOSITORIES);
}

/** Read the bounded exact-key snapshots in MRU order. */
export function loadPersistedWorkspaceLists(): Map<string, Workspace[]> {
  return new Map(loadEntries().map((entry) => [entry.repoSlug, entry.rows]));
}

/** Store only a complete, valid result. Oversized results are deliberately not
 * truncated: a partial workspace list would be false UI. */
export function persistWorkspaceList(
  repoSlug: string,
  rows: Workspace[],
): void {
  if (!repoSlug) return;
  const confirmed = sanitizeRows(rows, repoSlug);
  if (!confirmed) return;
  const entries = loadEntries().filter((entry) => entry.repoSlug !== repoSlug);
  entries.push({ repoSlug, savedAt: Date.now(), rows: confirmed });
  const bounded = entries.slice(-MAX_REPOSITORIES);
  let payload: PersistedWorkspaceLists = { version: 1, entries: bounded };
  // Evict oldest owners until the complete JSON fits. Never truncate rows, and
  // never replace existing storage if even this single exact-key list is too
  // large—the next boot can safely cold-load that repository instead.
  while (
    payload.entries.length > 1 &&
    JSON.stringify(payload).length > MAX_SERIALIZED_CHARS
  ) {
    payload = { version: 1, entries: payload.entries.slice(1) };
  }
  if (JSON.stringify(payload).length > MAX_SERIALIZED_CHARS) return;
  setSetting(STORAGE_KEY, payload);
}

/** Prune a removed semantic owner immediately. */
export function forgetPersistedWorkspaceList(repoSlug: string): void {
  const entries = loadEntries().filter((entry) => entry.repoSlug !== repoSlug);
  if (entries.length === 0) {
    removeSetting(STORAGE_KEY);
    return;
  }
  setSetting<PersistedWorkspaceLists>(STORAGE_KEY, {
    version: 1,
    entries,
  });
}

export const workspaceListPersistenceLimits = Object.freeze({
  repositories: MAX_REPOSITORIES,
  rowsPerRepository: MAX_ROWS_PER_REPOSITORY,
  serializedChars: MAX_SERIALIZED_CHARS,
});
