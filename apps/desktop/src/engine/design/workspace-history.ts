import type { DesignLocalHistoryCheckpoint } from "@zeros/design-web";
import type { DesignCatalogChange } from "./page-history";
import {
  type DesignFrameChange,
  type DesignFrameGeometry,
  type DesignFrameRestorePoint,
} from "./document";

export type WorkspaceDesignHistoryEntry =
  | {
      kind: "catalog";
      change: DesignCatalogChange;
      pageId?: string;
      beforeHistory: DesignLocalHistoryCheckpoint[];
      afterHistory: DesignLocalHistoryCheckpoint[];
      bytes: number;
    }
  | {
      kind: "transfer";
      changes: DesignFrameChange[];
      beforeHistory: DesignLocalHistoryCheckpoint[];
      afterHistory: DesignLocalHistoryCheckpoint[];
      frame: string;
      bytes: number;
    }
  | {
      kind: "document";
      frame: string;
      coalesceKey?: string;
      createdAt: number;
      bytes: number;
    }
  | {
      kind: "frame";
      before: DesignFrameRestorePoint | null;
      after: DesignFrameRestorePoint | null;
      bytes: number;
    }
  | {
      /** Several canvas frames moved in one write; only their geometry. */
      kind: "geometry";
      moves: Array<{ file: string; before: DesignFrameGeometry; after: DesignFrameGeometry }>;
      frame: string;
      bytes: number;
    };

export interface WorkspaceDesignHistoryState {
  undo: WorkspaceDesignHistoryEntry[];
  redo: WorkspaceDesignHistoryEntry[];
  bytes: number;
}

export const MAX_DESIGN_HISTORY_WORKSPACES = 16;
export const MAX_DESIGN_HISTORY_ENTRIES = 100;
export const MAX_DESIGN_HISTORY_BYTES = 16 * 1024 * 1024;

export function catalogDesignHistoryBytes(entry: Extract<WorkspaceDesignHistoryEntry, { kind: "catalog" }>): number {
  return JSON.stringify(entry.change).length * 2 +
    [...entry.beforeHistory, ...entry.afterHistory].reduce((sum, checkpoint) => sum + checkpoint.bytes, 0) + 256;
}
export function catalogDesignHistoryEntry(change: DesignCatalogChange, pageId?: string,
  beforeHistory: DesignLocalHistoryCheckpoint[] = [], complete = true): Extract<WorkspaceDesignHistoryEntry, { kind: "catalog" }> {
  const entry = { kind: "catalog" as const, change, ...(pageId ? { pageId } : {}), beforeHistory, afterHistory: [], bytes: 0 };
  entry.bytes = complete ? catalogDesignHistoryBytes(entry) : MAX_DESIGN_HISTORY_BYTES + 1;
  return entry;
}

/** Stop before checkpoints pin an entire large page beyond the shared stack
 * cap. An incomplete restore point is discarded, never kept as partial Undo. */
export async function captureCatalogDesignHistory(
  files: readonly string[],
  capture: (file: string) => Promise<DesignLocalHistoryCheckpoint | null>,
): Promise<{ checkpoints: DesignLocalHistoryCheckpoint[]; complete: boolean }> {
  const checkpoints: DesignLocalHistoryCheckpoint[] = [];
  let bytes = 0;
  for (const file of files) {
    const checkpoint = await capture(file);
    if (!checkpoint) continue;
    bytes += checkpoint.bytes;
    if (bytes > MAX_DESIGN_HISTORY_BYTES) return { checkpoints: [], complete: false };
    checkpoints.push(checkpoint);
  }
  return { checkpoints, complete: true };
}

export function transferDesignHistoryBytes(
  entry: Extract<WorkspaceDesignHistoryEntry, { kind: "transfer" }>,
): number {
  return (
    entry.changes.reduce(
      (total, change) =>
        total +
        (change.before?.source.length ?? 0) * 2 +
        (change.after?.source.length ?? 0) * 2,
      128,
    ) +
    [...entry.beforeHistory, ...entry.afterHistory].reduce(
      (total, checkpoint) => total + checkpoint.bytes,
      0,
    )
  );
}

export function pruneWorkspaceDesignHistory(
  state: WorkspaceDesignHistoryState,
): void {
  while (
    state.undo.length + state.redo.length > MAX_DESIGN_HISTORY_ENTRIES ||
    state.bytes > MAX_DESIGN_HISTORY_BYTES
  ) {
    const removed = state.undo.shift() ?? state.redo.shift();
    if (!removed) break;
    state.bytes -= removed.bytes;
  }
  state.bytes = Math.max(0, state.bytes);
}

export function pruneWorkspaceDesignFrameHistory(
  state: WorkspaceDesignHistoryState,
  files: ReadonlySet<string>,
  folder?: string,
): void {
  const deletedFile = (file: string): boolean =>
    files.has(file) || (folder !== undefined && file.startsWith(`${folder}/`));
  const keep = (entry: WorkspaceDesignHistoryEntry): boolean => {
    const deleted =
      entry.kind === "catalog"
        ? [entry.change.before.canvas, entry.change.after.canvas].some(canvas => Object.keys(canvas.frames).some(deletedFile))
        : entry.kind === "frame"
        ? [entry.before, entry.after].some(
            (point) => point && deletedFile(point.file),
          )
        : deletedFile(entry.frame) ||
          (entry.kind === "geometry" && entry.moves.some((move) => deletedFile(move.file))) ||
          (entry.kind === "transfer" &&
            (entry.changes.some((change) =>
              [change.before, change.after].some(
                (point) => point && deletedFile(point.file),
              ),
            ) ||
              [...entry.beforeHistory, ...entry.afterHistory].some(
                (checkpoint) =>
                  checkpoint.documentId.startsWith("frame:") &&
                  deletedFile(checkpoint.documentId.slice(6)),
              )));
    if (deleted) state.bytes -= entry.bytes;
    return !deleted;
  };
  state.undo = state.undo.filter(keep);
  state.redo = state.redo.filter(keep);
  state.bytes = Math.max(0, state.bytes);
}

export function geometryDesignHistoryEntry(
  moves: Array<{ file: string; before: DesignFrameGeometry; after: DesignFrameGeometry }>,
): WorkspaceDesignHistoryEntry {
  return { kind: "geometry", moves, frame: moves[0]!.file, bytes: JSON.stringify(moves).length * 2 + 64 };
}

export function documentDesignHistoryEntry(
  frame: string,
  coalesceKey?: string,
  createdAt = Date.now(),
): WorkspaceDesignHistoryEntry {
  return {
    kind: "document",
    frame,
    ...(coalesceKey ? { coalesceKey } : {}),
    createdAt,
    bytes: (frame.length + (coalesceKey?.length ?? 0) + 32) * 2,
  };
}

export function frameDesignHistoryEntry(
  before: DesignFrameRestorePoint | null,
  after: DesignFrameRestorePoint | null,
): WorkspaceDesignHistoryEntry {
  const file = before?.file ?? after?.file;
  if (!file || (before && after && before.file !== after.file)) {
    throw new Error("Design frame history requires one stable file identity.");
  }
  return {
    kind: "frame",
    before,
    after,
    bytes:
      (before ? Buffer.byteLength(before.source, "utf8") : 0) +
      (after ? Buffer.byteLength(after.source, "utf8") : 0) +
      file.length * 2 +
      128,
  };
}
