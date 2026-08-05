// ──────────────────────────────────────────────────────────
// Changes-tab turn filter — per-workspace persistence
// ──────────────────────────────────────────────────────────
//
// The Changes view can be filtered to ONE recorded turn's agent-authored
// changes (the v13 turn dropdown beside the scope selector). Like the scope
// (changes-scope.ts), that choice has to survive the many ways this view
// unmounts — source-tab switch, terminal switch, workspace switch, reload — so
// it can't live in React state alone.
//
// We persist only the turn's IDENTITY ({chatId, turnId}), keyed by workspace,
// NOT the whole TurnInfo: the caller re-resolves it against the freshly-loaded
// turns list, so its files/duration stay current and a turn that was since
// reset/deleted away degrades to "No turns" instead of a stale row.

export interface TurnFilterId {
  chatId: string;
  turnId: string;
}

const STORAGE_KEY = "zeros:changes-turn-filter:v1";
const MAX_PERSISTED_TARGETS = 128;

/** Narrow an unknown blob to a valid id — defensive against a corrupt/legacy
 *  entry, which degrades to null (→ "No turns") rather than throwing. */
function asId(v: unknown): TurnFilterId | null {
  if (!v || typeof v !== "object") return null;
  const chatId = (v as { chatId?: unknown }).chatId;
  const turnId = (v as { turnId?: unknown }).turnId;
  if (
    typeof chatId === "string" &&
    chatId.length > 0 &&
    typeof turnId === "string" &&
    turnId.length > 0
  ) {
    return { chatId, turnId };
  }
  return null;
}

/** The whole `{ [workspaceId]: TurnFilterId }` map, every entry validated. */
function readMap(): Record<string, TurnFilterId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, TurnFilterId> = {};
    for (const [key, val] of Object.entries(
      parsed as Record<string, unknown>,
    ).slice(-MAX_PERSISTED_TARGETS)) {
      const id = asId(val);
      if (key.length > 0 && id) out[key] = id;
    }
    return out;
  } catch {
    return {};
  }
}

/** The persisted turn selection for `workspaceId`, or null when there's none. */
export function loadTurnFilterId(workspaceId: string): TurnFilterId | null {
  if (!workspaceId) return null;
  return readMap()[workspaceId] ?? null;
}

/** Persist (or, with `null`, clear) a workspace's selected turn. */
export function saveTurnFilterId(
  workspaceId: string,
  id: TurnFilterId | null,
): void {
  if (!workspaceId) return;
  try {
    const map = readMap();
    delete map[workspaceId];
    if (id) {
      map[workspaceId] = id;
      const keys = Object.keys(map);
      if (keys.length > MAX_PERSISTED_TARGETS) delete map[keys[0]];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode / no localStorage — just won't persist */
  }
}

/** Remove navigation memory with its deleted repository/workspace owner. */
export function clearTurnFilterId(workspaceId: string): void {
  clearTurnFilterIds([workspaceId]);
}

/** Batch owner cleanup with one storage read/write, even for a large repo. */
export function clearTurnFilterIds(workspaceIds: readonly string[]): void {
  const removed = new Set(workspaceIds.filter(Boolean));
  if (removed.size === 0) return;
  try {
    const map = readMap();
    if (!Object.keys(map).some((workspaceId) => removed.has(workspaceId))) {
      return;
    }
    for (const workspaceId of removed) delete map[workspaceId];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* best-effort cleanup */
  }
}
