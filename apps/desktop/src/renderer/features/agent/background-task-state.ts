import type { BackgroundTasksUpdate } from "@zeros/protocol/agent-events";
import type { AgentSessionState } from "./use-agent-session";

/** A foreground result does not finish a conversation's background work.
 * Use the live process snapshot, never historical task rows in the transcript. */
export function hasBackgroundAgentWork(
  slot: Partial<Pick<AgentSessionState,
    "backgroundTasks" | "backgroundActivity" | "waitingForBackgroundTasks" | "workflows"
  >> | undefined,
): boolean {
  return (slot?.backgroundTasks?.length ?? 0) > 0 ||
    slot?.waitingForBackgroundTasks === true ||
    slot?.backgroundActivity?.state === "running" ||
    slot?.backgroundActivity?.state === "requires_action" ||
    slot?.workflows?.some(workflow => workflow.status === "running") === true;
}

/** Bounded snapshots received while the renderer is still binding a route.
 * Unlike transcript deltas, these full replacements can safely be replayed. */
export class BackgroundTaskSnapshots {
  private readonly snapshots = new Map<
    string,
    { chatId: string; snapshot: BackgroundTasksUpdate }
  >();

  remember(
    chatId: string,
    executionId: string,
    snapshot: BackgroundTasksUpdate,
  ): void {
    const key = JSON.stringify([chatId, executionId]);
    this.snapshots.delete(key);
    this.snapshots.set(key, { chatId, snapshot });
    if (this.snapshots.size > 64)
      this.snapshots.delete(this.snapshots.keys().next().value!);
  }

  take(chatId: string, executionId: string): BackgroundTasksUpdate | undefined {
    const key = JSON.stringify([chatId, executionId]);
    const snapshot = this.snapshots.get(key)?.snapshot;
    this.snapshots.delete(key);
    return snapshot;
  }

  clearChat(chatId: string): void {
    for (const [key, value] of this.snapshots)
      if (value.chatId === chatId) this.snapshots.delete(key);
  }

  clear(): void {
    this.snapshots.clear();
  }
}

/** Bind this with the execution route so reload never paints a snapshot owned
 * by the previous process. Historical task records are not live evidence. */
export function loadedBackgroundTaskState(
  snapshot?: BackgroundTasksUpdate,
): Pick<
  AgentSessionState,
  | "backgroundTasks"
  | "backgroundActivity"
  | "waitingForBackgroundTasks"
  | "backgroundTasksWaitingSince"
> {
  const tasks = snapshot?.tasks ?? [];
  const waiting = snapshot?.waiting === true && tasks.length > 0;
  return {
    backgroundTasks: tasks,
    backgroundActivity: snapshot?.activity ?? null,
    waitingForBackgroundTasks: waiting,
    backgroundTasksWaitingSince: waiting
      ? (snapshot?.activity?.startedAt ?? tasks[0]?.startedAt ?? null)
      : null,
  };
}
