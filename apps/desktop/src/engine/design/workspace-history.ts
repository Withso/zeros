import type { DesignLocalHistoryCheckpoint } from "@zeros/design-web";
import {
  type DesignFrameChange,
  type DesignFrameRestorePoint,
} from "./document";

export type WorkspaceDesignHistoryEntry =
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
    };

export interface WorkspaceDesignHistoryState {
  undo: WorkspaceDesignHistoryEntry[];
  redo: WorkspaceDesignHistoryEntry[];
  bytes: number;
}

export const MAX_DESIGN_HISTORY_WORKSPACES = 16;
export const MAX_DESIGN_HISTORY_ENTRIES = 100;
export const MAX_DESIGN_HISTORY_BYTES = 16 * 1024 * 1024;

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
