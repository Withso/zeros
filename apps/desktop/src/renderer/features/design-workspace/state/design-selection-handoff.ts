import { useSyncExternalStore } from "react";

/** A layer the Style panel showed, at its frame. `nodeId` null is the frame
 * itself selected. */
export type DesignSelectionSubject = { readonly frame: string; readonly nodeId: string | null };

type Handoff = { readonly from: DesignSelectionSubject; readonly to: DesignSelectionSubject };

/** Longer than a copy or move takes to read back; a target that never does
 * stops borrowing its subject's values. */
export const DESIGN_SELECTION_HANDOFF_MS = 3_000;

const handoffs = new Map<string, { handoff: Handoff; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** A duplicate or a moved layer is the subject it was made from until it
 * reads back: selecting it keeps the Style panel on the subject's values
 * instead of passing through an empty or "Nothing selected" state. One per
 * workspace; the next handoff, or the deadline, replaces it. */
export function handDesignSelectionPresentation(workspaceId: string, from: DesignSelectionSubject, to: DesignSelectionSubject): void {
  const previous = handoffs.get(workspaceId);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    if (handoffs.get(workspaceId)?.timer !== timer) return;
    handoffs.delete(workspaceId);
    notify();
  }, DESIGN_SELECTION_HANDOFF_MS);
  handoffs.set(workspaceId, { handoff: { from: { ...from }, to: { ...to } }, timer });
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useDesignSelectionHandoff(workspaceId: string | null | undefined): Handoff | null {
  const read = () => (workspaceId ? handoffs.get(workspaceId)?.handoff ?? null : null);
  return useSyncExternalStore(subscribe, read, read);
}

const same = (left: DesignSelectionSubject, right: DesignSelectionSubject) =>
  left.frame === right.frame && left.nodeId === right.nodeId;

/** The subject's last shown presentation, while the handoff from it to the
 * current target is pending. */
export function designHandedSelectionPresentation<T extends DesignSelectionSubject>(
  shown: T | null,
  handoff: Handoff | null,
  target: DesignSelectionSubject | null,
): T | null {
  return shown && handoff && target && same(handoff.from, shown) && same(handoff.to, target) ? shown : null;
}

export function resetDesignSelectionHandoffsForTests(): void {
  for (const { timer } of handoffs.values()) clearTimeout(timer);
  handoffs.clear();
  notify();
}
