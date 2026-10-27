import { KEEP_AWAKE_ACTIVITY_REQUEST } from "../../../../shared/keep-awake";
import { nativeInvoke, nativeListen } from "../../platform/runtime";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { agentExecutionActivity, parkedOnUser } from "../agent/agent-activity";
import { useSessionsStore, type SessionsStoreState } from "../agent/sessions-store";

/** Execution evidence across the entire app, independent of selected owner,
 * placement, tab and cloud presentation clocks. A user-blocked parent can
 * still have independent background work. Idle sessions do not count. */
export function anyAgentNeedsKeepAwake(
  state: Pick<SessionsStoreState, "sessions" | "pendingLocalTurns">,
): boolean {
  for (const [chatId, slot] of Object.entries(state.sessions)) {
    if (parkedOnUser(slot)) {
      if (slot.backgroundTasks.length > 0 && slot.lastStopReason !== "cancelled") return true;
      continue;
    }
    if (isCloudWorkspace(slot.cwd) && slot.cloudSendWait?.state === "waiting") return true;
    if (agentExecutionActivity(slot, state.pendingLocalTurns[chatId]) !== null) return true;
  }
  // A send may temporarily outlive its slot while the session is re-seeded.
  return Object.entries(state.pendingLocalTurns).some(([chatId, turn]) => !!turn && !state.sessions[chatId]);
}

/** Main requests refreshes on its own clock: hidden Chromium timers must not
 * decide whether the Mac sleeps. Token updates send IPC only on a bool change. */
export function startKeepAwakeActivityReporter(): () => void {
  let disposed = false;
  let lastReported: boolean | undefined;
  let stopListening: (() => void) | undefined;
  const report = (force = false) => {
    if (disposed) return;
    const active = anyAgentNeedsKeepAwake(useSessionsStore.getState());
    if (!force && lastReported === active) return;
    lastReported = active;
    void nativeInvoke("keep_awake_activity", { active }).catch(() => {
      if (!disposed && lastReported === active) lastReported = undefined;
    });
  };
  const unsubscribe = useSessionsStore.subscribe(() => report());
  report();
  void nativeListen(KEEP_AWAKE_ACTIVITY_REQUEST, () => report(true)).then(stop => {
    if (disposed) stop();
    else {
      stopListening = stop;
      report();
    }
  }).catch(() => {});
  return () => {
    disposed = true;
    unsubscribe();
    stopListening?.();
    void nativeInvoke("keep_awake_activity", { active: false }).catch(() => {});
  };
}
