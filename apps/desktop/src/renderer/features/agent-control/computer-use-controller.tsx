import { useEffect } from "react";

import { nativeInvoke, nativeListen } from "../../platform/runtime";
import { useResolvedSettings } from "../settings/use-settings";
import { useAgentControlFeatureActive } from "../settings/agent-control-rollout";
import { computerUsePreferencesFromEffective } from "../settings/computer-use-settings";
import {
  clearComputerUseState,
  publishComputerUseState,
} from "./computer-use-state-store";

/** Keeps Electron main's enforcement copy of the Computer use settings current
 * and mirrors who uses the computer into the renderer, so tool rows can say
 * which chat they wait behind. */
export function ComputerUseController() {
  const resolved = useResolvedSettings();
  const effective = resolved.resolved?.effective;
  const computerUse = useAgentControlFeatureActive("computerUse");

  // Main enforces these on every tool call; the resolved document is local
  // (a settings.resolve request never targets a cloud engine), so this push
  // cannot leak another workspace's settings onto this Mac.
  useEffect(() => {
    if (!effective) return;
    void nativeInvoke("computer_use_preferences_update", {
      ...computerUsePreferencesFromEffective(effective, { computerUse }),
    }).catch(() => {});
  }, [computerUse, effective]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // A live event beats the recovery read: main emits on every change, so an
    // older snapshot must not overwrite one that arrived while it loaded.
    let liveEventSeen = false;
    const acceptState = (value: unknown) => {
      liveEventSeen = true;
      publishComputerUseState(value);
    };
    void nativeListen<unknown>("computer-use-state", acceptState)
      .then(async (dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        const snapshot = await nativeInvoke<unknown>("computer_use_state");
        if (!disposed && !liveEventSeen) publishComputerUseState(snapshot);
      })
      .catch(() => {
        clearComputerUseState();
      });
    return () => {
      disposed = true;
      unlisten?.();
      clearComputerUseState();
    };
  }, []);

  return null;
}
