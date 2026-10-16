import { useCallback, useSyncExternalStore } from "react";
import type { SimulatorAnnotationSnapshot } from "@zeros/protocol/simulator-captures";
import type { SimulatorDevice } from "@zeros/protocol/simulators";

import { loadSimulatorAnnotationSnapshot } from "./simulator-api";
import {
  EMPTY_ANNOTATION_HISTORY,
  MAX_ANNOTATION_MARKS,
  amendMarks,
  clearMarks,
  commitMarks,
  redoMarks,
  undoMarks,
  type AnnotationColor,
  type AnnotationHistory,
  type AnnotationMark,
  type AnnotationTool,
} from "./simulator-annotation-model";

// Each Simulator tab's annotation lives here rather than in the tab, which
// mounts only while it shows, so switching tabs keeps the marks. It ends when
// the user leaves it, adds it to a chat or closes the tab.

export interface SimulatorAnnotation {
  /** Tells this annotation from a later one in the same tab. */
  readonly serial: number;
  readonly tabId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  /** The frozen screen; null while it is captured. */
  readonly snapshot: SimulatorAnnotationSnapshot | null;
  /** When the screen froze, which names the files Add to chat sends. */
  readonly frozenAt: number;
  readonly history: AnnotationHistory;
  readonly tool: AnnotationTool;
  readonly color: AnnotationColor;
  /** Add to chat is drawing the image. */
  readonly adding: boolean;
}

/** Leaving an annotation that has marks, waiting for the user to say. */
export interface SimulatorAnnotationLeave {
  readonly tabId: string;
  readonly deviceName: string;
  readonly marks: number;
  /** What leaving was for, such as closing the tab. */
  readonly then: (() => void) | null;
}

type MarksUpdate = (marks: readonly AnnotationMark[]) => readonly AnnotationMark[];

export interface SimulatorAnnotationsOptions {
  load(deviceId: string): Promise<SimulatorAnnotationSnapshot>;
  now(): number;
}

export class SimulatorAnnotations {
  private sessions: ReadonlyMap<string, SimulatorAnnotation> = new Map();
  private leaving: SimulatorAnnotationLeave | null = null;
  private readonly listeners = new Set<() => void>();
  private serial = 0;
  /** The next annotation starts with the tool and color the last one used. */
  private tool: AnnotationTool = "pen";
  private color: AnnotationColor = "red";

  constructor(private readonly options: SimulatorAnnotationsOptions) {}

  get(tabId: string): SimulatorAnnotation | null {
    return this.sessions.get(tabId) ?? null;
  }

  any(): boolean {
    return this.sessions.size > 0;
  }

  leaveRequest(): SimulatorAnnotationLeave | null {
    return this.leaving;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Freezes the device's screen in the tab. Resolves once it has, or with
   * null when the annotation ended first; rejects when the screen couldn't
   * be captured, and the annotation is gone. A tab already annotating keeps
   * its annotation. */
  async begin(
    tabId: string,
    device: Pick<SimulatorDevice, "id" | "name">,
  ): Promise<SimulatorAnnotation | null> {
    if (this.sessions.has(tabId)) return null;
    this.serial += 1;
    const serial = this.serial;
    this.put({
      serial,
      tabId,
      deviceId: device.id,
      deviceName: device.name,
      snapshot: null,
      frozenAt: this.options.now(),
      history: EMPTY_ANNOTATION_HISTORY,
      tool: this.tool,
      color: this.color,
      adding: false,
    });
    let snapshot: SimulatorAnnotationSnapshot;
    try {
      snapshot = await this.options.load(device.id);
    } catch (error) {
      if (this.sessions.get(tabId)?.serial === serial) this.end(tabId);
      throw error;
    }
    const current = this.sessions.get(tabId);
    if (current?.serial !== serial) return null;
    const ready = { ...current, snapshot };
    this.put(ready);
    return ready;
  }

  setTool(tabId: string, tool: AnnotationTool): void {
    this.tool = tool;
    this.update(tabId, (session) => (session.tool === tool ? session : { ...session, tool }));
  }

  setColor(tabId: string, color: AnnotationColor): void {
    this.color = color;
    this.update(tabId, (session) => (session.color === color ? session : { ...session, color }));
  }

  /** The marks `update` makes, as a step undo takes back. */
  commit(tabId: string, update: MarksUpdate): void {
    this.changeHistory(tabId, (history) => {
      const marks = update(history.marks);
      return marks.length > MAX_ANNOTATION_MARKS ? history : commitMarks(history, marks);
    });
  }

  /** The marks `update` makes, as part of the latest step. */
  amend(tabId: string, update: MarksUpdate): void {
    this.changeHistory(tabId, (history) => amendMarks(history, update(history.marks)));
  }

  undo(tabId: string): void {
    this.changeHistory(tabId, undoMarks);
  }

  redo(tabId: string): void {
    this.changeHistory(tabId, redoMarks);
  }

  clear(tabId: string): void {
    this.changeHistory(tabId, clearMarks);
  }

  setAdding(tabId: string, serial: number, adding: boolean): void {
    this.update(tabId, (session) =>
      session.serial !== serial || session.adding === adding ? session : { ...session, adding },
    );
  }

  /** Ends the tab's annotation, marks and all. */
  end(tabId: string): void {
    const hadSession = this.sessions.has(tabId);
    const wasLeaving = this.leaving?.tabId === tabId;
    if (!hadSession && !wasLeaving) return;
    if (hadSession) {
      const next = new Map(this.sessions);
      next.delete(tabId);
      this.sessions = next;
    }
    if (wasLeaving) this.leaving = null;
    this.notify();
  }

  /** Leaves the tab's annotation, then runs `then`. Marks the user would
   * lose wait for them to say; the returned value says which happened. */
  leave(tabId: string, then?: () => void): "left" | "asking" {
    const session = this.sessions.get(tabId);
    if (!session?.snapshot || session.history.marks.length === 0) {
      this.end(tabId);
      then?.();
      return "left";
    }
    this.leaving = {
      tabId,
      deviceName: session.deviceName,
      marks: session.history.marks.length,
      then: then ?? null,
    };
    this.notify();
    return "asking";
  }

  /** The user chose to discard their marks. */
  confirmLeave(): void {
    const leaving = this.leaving;
    if (!leaving) return;
    this.end(leaving.tabId);
    leaving.then?.();
  }

  /** The user kept their marks. */
  cancelLeave(): void {
    if (!this.leaving) return;
    this.leaving = null;
    this.notify();
  }

  /** Ends the annotations of tabs that are no longer open. */
  prune(openTabIds: ReadonlySet<string>): void {
    const closed = [...this.sessions.keys()].filter((tabId) => !openTabIds.has(tabId));
    const leavingClosed = this.leaving !== null && !openTabIds.has(this.leaving.tabId);
    if (closed.length === 0 && !leavingClosed) return;
    const next = new Map(this.sessions);
    for (const tabId of closed) next.delete(tabId);
    this.sessions = next;
    if (leavingClosed) this.leaving = null;
    this.notify();
  }

  reset(): void {
    this.sessions = new Map();
    this.leaving = null;
    this.tool = "pen";
    this.color = "red";
    this.notify();
  }

  private changeHistory(
    tabId: string,
    change: (history: AnnotationHistory) => AnnotationHistory,
  ): void {
    this.update(tabId, (session) => {
      if (!session.snapshot || session.adding) return session;
      const history = change(session.history);
      return history === session.history ? session : { ...session, history };
    });
  }

  private update(
    tabId: string,
    change: (session: SimulatorAnnotation) => SimulatorAnnotation,
  ): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    const next = change(session);
    if (next !== session) this.put(next);
  }

  private put(session: SimulatorAnnotation): void {
    this.sessions = new Map(this.sessions).set(session.tabId, session);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const simulatorAnnotations = new SimulatorAnnotations({
  load: loadSimulatorAnnotationSnapshot,
  now: () => Date.now(),
});

const subscribe = (listener: () => void) => simulatorAnnotations.subscribe(listener);
const currentLeave = () => simulatorAnnotations.leaveRequest();

export function useSimulatorAnnotation(tabId: string): SimulatorAnnotation | null {
  const read = useCallback(() => simulatorAnnotations.get(tabId), [tabId]);
  return useSyncExternalStore(subscribe, read, read);
}

export function useSimulatorAnnotationLeave(): SimulatorAnnotationLeave | null {
  return useSyncExternalStore(subscribe, currentLeave, currentLeave);
}

/** Every Simulator tab open in any workspace. */
export function openSimulatorTabIds(
  workbenchByScope: Readonly<Record<string, { tabs: readonly { id: string; type: string }[] }>>,
): Set<string> {
  const ids = new Set<string>();
  for (const scope of Object.values(workbenchByScope)) {
    for (const tab of scope.tabs) if (tab.type === "simulator") ids.add(tab.id);
  }
  return ids;
}
