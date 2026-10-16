import { useEffect, useRef } from "react";

import { toast } from "../../shared/ui/primitives/elements";
import { useResolvedSettings } from "../settings/use-settings";
import { useAgentControlFeatureActive } from "../settings/agent-control-rollout";
import { simulatorPreferencesFromEffective } from "../settings/simulator-settings";
import { followSimulatorAnnotationTabs } from "./simulator-annotation-actions";
import { SimulatorAnnotationLeaveDialog } from "./simulator-annotation-dialog";
import { keepSimulatorRunning, updateSimulatorPreferences } from "./simulator-api";
import { showRecordingEnd } from "./simulator-capture-actions";
import { SimulatorCaptureStack } from "./simulator-capture-stack";
import { followSimulatorCaptures } from "./simulator-capture-store";
import { listenToSimulatorHub, useSimulatorHubSnapshot } from "./simulator-hub-store";
import {
  SimulatorIdleNoticeSync,
  simulatorErrorMessage,
  type SimulatorIdleToasts,
} from "./simulator-notices";

const idleToastId = (deviceId: string) => `simulator-idle:${deviceId}`;

const idleToasts: SimulatorIdleToasts = {
  show(notice, durationMs) {
    toast.warning(notice.title, {
      id: idleToastId(notice.deviceId),
      description: notice.description,
      duration: durationMs,
      action: {
        label: "Keep running",
        onClick: () => {
          void keepSimulatorRunning(notice.deviceId).catch((error: unknown) => {
            toast.error(simulatorErrorMessage(error, "Couldn't keep the simulator running."));
          });
        },
      },
    });
  },
  dismiss(deviceId) {
    toast.dismiss(idleToastId(deviceId));
  },
};

/** Keeps DeviceHub's copy of the Simulators settings current, and shows the
 * idle-shutdown toasts, recordings that ended on their own, the capture
 * thumbnails and the question before annotations are discarded, whichever
 * tab is open. */
export function SimulatorController() {
  const resolved = useResolvedSettings();
  const effective = resolved.resolved?.effective;
  const simulators = useAgentControlFeatureActive("simulators");

  // The resolved document is the Mac's own (settings never resolve against a
  // cloud engine), and DeviceHub only ever runs devices on this Mac.
  useEffect(() => {
    if (!effective) return;
    void updateSimulatorPreferences(
      simulatorPreferencesFromEffective(effective, { simulators }),
    ).catch(() => {});
  }, [effective, simulators]);

  // Listening is free; the first Simulator tab does the first read, which is
  // what starts DeviceHub's device tools.
  useEffect(() => {
    void listenToSimulatorHub();
  }, []);

  // A recording outlives its tab, so its end is shown here.
  useEffect(() => followSimulatorCaptures(showRecordingEnd), []);

  useEffect(() => followSimulatorAnnotationTabs(), []);

  const snapshot = useSimulatorHubSnapshot();
  const notices = useRef<SimulatorIdleNoticeSync | null>(null);
  useEffect(() => {
    const sync = new SimulatorIdleNoticeSync(idleToasts);
    notices.current = sync;
    return () => {
      sync.dispose();
      notices.current = null;
    };
  }, []);
  useEffect(() => {
    notices.current?.sync(snapshot);
  }, [snapshot]);

  return (
    <>
      <SimulatorCaptureStack />
      <SimulatorAnnotationLeaveDialog />
    </>
  );
}
