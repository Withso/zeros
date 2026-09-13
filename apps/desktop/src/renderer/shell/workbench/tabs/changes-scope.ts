// ──────────────────────────────────────────────────────────
// Changes-tab scope — type + per-workspace persistence
// ──────────────────────────────────────────────────────────
//
// The Changes view can be scoped to: everything this branch changed vs its base
// (committed AND uncommitted — the default), the net uncommitted working tree,
// either side of the index (Staged / Unstaged), or a single picked commit. That
// choice has to survive every way the view
// unmounts — tab switches, workspace switches (`key={changesTarget}` remounts),
// and reloads — so it can't live in React state alone: it's persisted here,
// keyed by the git target (a worktree id, or the trunk's repo root), and read
// back through the live changes-filter-store.
//
// First visit to a workspace's Changes tab → DEFAULT_SCOPE ("Branch"); after
// the user picks a scope it's remembered per workspace until they change it.
// Branch retains the persisted "all" kind and its full-branch comparison.

import {
  changesHistoryKey,
  changesHistorySchema,
  type ChangesHistory,
} from "@zeros/protocol/changes-history";

export function isHistoryScope(scope: Scope): scope is ChangesHistory {
  return [
    "commits",
    "commit-range",
    "turns",
    "last-turn",
    "turn-range",
  ].includes(scope.kind);
}

export function scopeIdentity(scope: Scope): string {
  return isHistoryScope(scope)
    ? changesHistoryKey(scope)
    : scope.kind === "commit"
      ? scope.sha
      : scope.kind;
}

export type Scope =
  | ChangesHistory
  | { kind: "all" }
  | { kind: "uncommitted" }
  | { kind: "staged" }
  | { kind: "unstaged" }
  | { kind: "commit"; sha: string; message: string };

/** The scope a workspace's Changes tab opens on before the user picks otherwise. */
export const DEFAULT_SCOPE: Scope = { kind: "all" };

const STORAGE_KEY = "zeros:changes-scope:v1";
const MAX_PERSISTED_TARGETS = 128;

/** Narrow an unknown blob to a valid Scope. Defensive against a corrupt / legacy
 *  localStorage entry — a bad value degrades to null (→ the default), never
 *  throws or seeds a malformed scope. */
export function asScope(v: unknown): Scope | null {
  if (!v || typeof v !== "object") return null;
  const kind = (v as { kind?: unknown }).kind;
  if (kind === "all") return { kind: "all" };
  if (kind === "uncommitted") return { kind: "uncommitted" };
  if (kind === "staged") return { kind: "staged" };
  if (kind === "unstaged") return { kind: "unstaged" };
  if (kind === "commit") {
    const sha = (v as { sha?: unknown }).sha;
    const message = (v as { message?: unknown }).message;
    if (typeof sha === "string" && sha.length > 0) {
      return {
        kind: "commit",
        sha,
        message: typeof message === "string" ? message : "",
      };
    }
  }
  const history = changesHistorySchema.safeParse(v);
  return history.success ? history.data : null;
}

/** The whole `{ [target]: Scope }` map, with every entry validated. */
function readMap(): Record<string, Scope> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Record<string, Scope> = {};
    for (const [key, val] of Object.entries(
      parsed as Record<string, unknown>,
    ).slice(-MAX_PERSISTED_TARGETS)) {
      const scope = asScope(val);
      if (key.length > 0 && scope) out[key] = scope;
    }
    return out;
  } catch {
    return {};
  }
}

/** The persisted scope for `target` (worktree id / trunk repo root), or null when
 *  it has none yet — the caller then falls back to {@link DEFAULT_SCOPE}. */
export function loadChangesScope(target: string): Scope | null {
  if (!target) return null;
  return readMap()[target] ?? null;
}

/** Persist `target`'s Changes-tab scope so returning to that workspace — after a
 *  source-tab switch, a workspace switch, or a reload — restores it. "All
 *  changes" is stored explicitly too, so an EXPLICIT return to the default is
 *  remembered as a deliberate choice rather than re-defaulted on a later visit. */
export function saveChangesScope(target: string, scope: Scope): void {
  if (!target) return;
  try {
    const map = readMap();
    delete map[target];
    map[target] = scope;
    const keys = Object.keys(map);
    if (keys.length > MAX_PERSISTED_TARGETS) delete map[keys[0]];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode / no localStorage — the scope just won't persist */
  }
}

/** Remove navigation memory with its deleted repository/workspace owner. */
export function clearChangesScope(target: string): void {
  clearChangesScopes([target]);
}

/** Batch owner cleanup with one storage read/write, even for a large repo. */
export function clearChangesScopes(targets: readonly string[]): void {
  const removed = new Set(targets.filter(Boolean));
  if (removed.size === 0) return;
  try {
    const map = readMap();
    if (!Object.keys(map).some((target) => removed.has(target))) return;
    for (const target of removed) delete map[target];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* best-effort cleanup */
  }
}
