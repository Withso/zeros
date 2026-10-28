import type { DesignFrameGeometryWire, DesignWorkspaceSnapshotWire } from "../../../platform/git";

export interface DesignHistorySelectionHint {
  pageId?: string;
  frame: string | null;
  frameSelected: boolean;
}

export type DesignHistoryTarget = ({
  kind: "generation";
  frame: string;
  target: string;
  geometry?: ReadonlyMap<string, DesignFrameGeometryWire>;
} | {
  kind: "geometry";
  geometry: ReadonlyMap<string, DesignFrameGeometryWire>;
  frame?: undefined;
  target?: undefined;
} | {
  kind: "catalog";
  catalog: WeakRef<DesignWorkspaceSnapshotWire>;
  frame?: undefined;
  target?: undefined;
}) & { selection?: DesignHistorySelectionHint };
interface Entry {
  before: DesignHistoryTarget;
  after: DesignHistoryTarget;
  beforeState: string;
  afterState: string;
  key?: string;
  time: number;
  bytes: number;
}
export type DesignHistoryPrediction = DesignHistoryTarget & { state: string };
interface Session {
  entries: Entry[];
  cursor: number;
  confirmedState: string;
  pending: DesignHistoryPrediction[];
}

/** Presentation only. Engine history is authoritative; unknown transitions
 * disable prediction. Metadata is bounded to 1 MiB across 16 owners / 64
 * entries each. Catalogs are weak references, not another source cache. */
export class DesignHistoryPreview {
  private sessions = new Map<string, Session>();

  record(workspace: string, frame: string, before: string, after: string,
    beforeState: string, afterState: string, key?: string, time = Date.now(),
    geometry?: { before: ReadonlyMap<string, DesignFrameGeometryWire>; after: ReadonlyMap<string, DesignFrameGeometryWire> },
  ) {
    if (before === after) return;
    this.recordTransition(workspace,
      { kind: "generation", frame, target: before, ...(geometry ? { geometry: geometry.before } : {}) },
      { kind: "generation", frame, target: after, ...(geometry ? { geometry: geometry.after } : {}) },
      beforeState, afterState, key, time);
  }

  recordTransition(workspace: string, before: DesignHistoryTarget, after: DesignHistoryTarget,
    beforeState: string, afterState: string, key?: string, time = Date.now(),
  ) {
    if (beforeState === afterState) return;
    let session = this.sessions.get(workspace);
    if (!session || session.confirmedState !== beforeState || session.pending.length) {
      session = { entries: [], cursor: 0, confirmedState: beforeState, pending: [] };
      this.sessions.set(workspace, session);
    }
    this.sessions.delete(workspace); this.sessions.set(workspace, session);
    session.entries.splice(session.cursor);
    const previous = session.entries.at(-1);
    const bytes = (beforeState.length + afterState.length) * 2 + 256 +
      ((before.selection?.frame?.length ?? 0) + (after.selection?.frame?.length ?? 0) +
        (before.selection?.pageId?.length ?? 0) + (after.selection?.pageId?.length ?? 0)) * 2 +
      ("geometry" in before ? (before.geometry?.size ?? 0) * 192 : 0) +
      ("geometry" in after ? (after.geometry?.size ?? 0) * 192 : 0);
    if (key && previous?.key === key && before.kind === "generation" &&
      previous.before.kind === "generation" && previous.before.frame === before.frame &&
      time >= previous.time && time - previous.time <= 750) {
      Object.assign(previous, { after, afterState, time, bytes: Math.max(previous.bytes, bytes) });
    } else session.entries.push({ before, after, beforeState, afterState, key, time, bytes });
    if (session.entries.length > 64) session.entries.shift();
    session.cursor = session.entries.length;
    session.confirmedState = afterState;
    while (this.sessions.size > 16 || [...this.sessions.values()].reduce((sum, value) =>
      sum + value.entries.reduce((bytes, entry) => bytes + entry.bytes, 0), 0) > 1024 * 1024)
      this.sessions.delete(this.sessions.keys().next().value!);
  }

  take(workspace: string, state: string, direction: "undo" | "redo"): DesignHistoryPrediction | null {
    const session = this.sessions.get(workspace);
    if (!session) return null;
    if (session.confirmedState !== state || session.pending.length >= 128) { this.clear(workspace); return null; }
    const entry = session.entries[direction === "undo" ? session.cursor - 1 : session.cursor];
    if (!entry) return null;
    const target = direction === "undo" ? entry.before : entry.after;
    if (target.kind === "catalog" && !target.catalog.deref()) { this.clear(workspace); return null; }
    session.cursor += direction === "undo" ? -1 : 1;
    const prediction = { ...target, state: direction === "undo" ? entry.beforeState : entry.afterState };
    session.pending.push(prediction);
    return prediction;
  }

  confirm(workspace: string, prediction: DesignHistoryPrediction, state: string) {
    const session = this.sessions.get(workspace);
    if (!session || !session.pending.includes(prediction)) return;
    session.pending = session.pending.filter(candidate => candidate !== prediction);
    session.confirmedState = state;
  }
  /** A pending edit has not entered the confirmed cursor. Further Undo can
   * still inspect an already-known inverse without advancing that cursor. */
  peek(workspace: string, state: string, direction: "undo" | "redo"): DesignHistoryPrediction | null {
    const entries = this.sessions.get(workspace)?.entries;
    const entry = direction === "undo"
      ? entries?.slice().reverse().find(entry => entry.afterState === state)
      : entries?.find(entry => entry.beforeState === state);
    if (!entry) return null;
    const target = direction === "undo" ? entry.before : entry.after;
    if (target.kind === "catalog" && !target.catalog.deref()) return null;
    return { ...target, state: direction === "undo" ? entry.beforeState : entry.afterState };
  }
  pending(workspace: string): DesignHistoryPrediction | undefined { return this.sessions.get(workspace)?.pending.at(-1); }
  pendingTarget(workspace: string, frame: string): string | undefined {
    return this.sessions.get(workspace)?.pending.filter(entry => entry.kind === "generation" && entry.frame === frame).at(-1)?.target;
  }
  clear(workspace?: string) { if (workspace) this.sessions.delete(workspace); else this.sessions.clear(); }
}
