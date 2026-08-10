import { useEffect, useState, useSyncExternalStore } from "react";

export const BROWSER_AGENT_POINTER_LINGER_MS = 1_800;

export interface BrowserAgentPointer {
  x: number;
  y: number;
  action: "move" | "click" | "type";
  updatedAt: number;
}

export interface BrowserSessionActivity {
  taskId: string;
  url: string;
  title: string;
  loading: boolean;
  status: "working" | "awaiting-confirmation" | "ready" | "closed";
  tool?: string;
  actor?: "agent" | "user";
  pointer?: BrowserAgentPointer;
  provider?:
    | "isolated"
    | "shared-chrome"
    | "managed-cloud"
    | "system-computer-use";
}

const activityByTask = new Map<string, BrowserSessionActivity>();
const listeners = new Set<() => void>();

export function publishBrowserSessionActivity(
  activity: BrowserSessionActivity,
): void {
  if (activity.status === "closed") activityByTask.delete(activity.taskId);
  else activityByTask.set(activity.taskId, activity);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBrowserSessionActivity(
  taskId: string | undefined,
): BrowserSessionActivity | null {
  return useSyncExternalStore(
    subscribe,
    () => (taskId ? (activityByTask.get(taskId) ?? null) : null),
    () => null,
  );
}

export function browserSessionIsAgentActive(
  activity: BrowserSessionActivity | null,
  now = Date.now(),
): boolean {
  if (!activity || activity.actor === "user") return false;
  if (activity.status === "working" || activity.loading) return true;
  return Boolean(
    activity.pointer &&
    now - activity.pointer.updatedAt < BROWSER_AGENT_POINTER_LINGER_MS,
  );
}

/** Retain the last exact task-keyed event and only tick once when the pointer's
 * short visibility window ends. No polling is needed while the Browser is idle. */
export function useBrowserSessionAgentPresence(taskId: string | undefined): {
  activity: BrowserSessionActivity | null;
  active: boolean;
} {
  const activity = useBrowserSessionActivity(taskId);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const pointer = activity?.pointer;
    if (!pointer || activity?.actor === "user") return;
    setNow(Date.now());
    const remaining =
      pointer.updatedAt + BROWSER_AGENT_POINTER_LINGER_MS - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 1);
    return () => window.clearTimeout(timer);
  }, [activity?.actor, activity?.pointer]);

  return {
    activity,
    active: browserSessionIsAgentActive(activity, now),
  };
}
