import type {
  SimulatorDevice,
  SimulatorHubSnapshot,
  SimulatorPlatform,
} from "@zeros/protocol/simulators";

import { createSimulatorTab, type WorkbenchTab } from "../../shell/workbench/tab-model";
import type { Action } from "../../state/workspace-store";

type TabFields = Pick<WorkbenchTab, "id" | "type" | "simulatorPlatform" | "simulatorDeviceId">;

/** Devices other Simulator tabs show, as one string so a store selector
 * returns the same value until the set itself changes. */
export function simulatorsShownElsewhere(tabs: readonly TabFields[], tabId: string): string {
  const ids = new Set<string>();
  for (const tab of tabs) {
    if (tab.type === "simulator" && tab.id !== tabId && tab.simulatorDeviceId) {
      ids.add(tab.simulatorDeviceId);
    }
  }
  return [...ids].sort().join("\n");
}

export function parseSimulatorsShownElsewhere(key: string): ReadonlySet<string> {
  return new Set(key ? key.split("\n") : []);
}

export type SimulatorTabView =
  /** The tab names a device, but the hub hasn't answered yet. */
  | { kind: "waiting" }
  | { kind: "setup" }
  | { kind: "device"; device: SimulatorDevice };

/** What a Simulator tab shows: its device, or the setup screen when it has
 * none or the device is gone. */
export function simulatorTabView(
  snapshot: SimulatorHubSnapshot | null,
  deviceId: string | undefined,
  platform: SimulatorPlatform,
): SimulatorTabView {
  if (!deviceId) return { kind: "setup" };
  if (!snapshot) return { kind: "waiting" };
  const device = snapshot.devices.find((entry) => entry.id === deviceId);
  return device && device.platform === platform ? { kind: "device", device } : { kind: "setup" };
}

/** Whether an active tab re-reads the hub itself: main already reads
 * devices while one is on screen, starting or stopping. */
export function simulatorTabFollowsHub(view: SimulatorTabView): boolean {
  return view.kind === "setup" || (view.kind === "device" && view.device.state === "shutdown");
}

/** "+ › iOS Simulator" reuses a tab that has no device yet. */
export function reusableSimulatorTab<T extends TabFields>(
  tabs: readonly T[],
  platform: SimulatorPlatform,
): T | null {
  return (
    tabs.find(
      (tab) =>
        tab.type === "simulator" &&
        tab.simulatorPlatform === platform &&
        !tab.simulatorDeviceId,
    ) ?? null
  );
}

/**
 * - `open`: the agent just took the device and its chat is on screen.
 * - `place`: it took the device in a chat that isn't on screen.
 * - `reveal`: that chat came on screen later. Only a tab still showing the
 *   device comes forward, so one the user closed stays closed.
 */
export type SimulatorAgentTabMode = "open" | "place" | "reveal";

/** Shows the device an agent uses in its chat's workspace: in the tab that
 * already shows it, else a tab with no device yet, else a new tab. */
export function planSimulatorAgentTab(
  tabs: readonly WorkbenchTab[],
  device: { deviceId: string; platform: SimulatorPlatform },
  scope: string,
  mode: SimulatorAgentTabMode,
): Action[] {
  const activate = mode !== "place";
  const showing = tabs.find(
    (tab) => tab.type === "simulator" && tab.simulatorDeviceId === device.deviceId,
  );
  if (showing) {
    return activate ? [{ type: "ACTIVATE_WORKBENCH_TAB", id: showing.id, scope }] : [];
  }
  if (mode === "reveal") return [];
  const blank = reusableSimulatorTab(tabs, device.platform);
  if (blank) {
    const attach: Action = {
      type: "UPDATE_WORKBENCH_TAB",
      id: blank.id,
      updates: { simulatorDeviceId: device.deviceId },
      scope,
    };
    return activate ? [attach, { type: "ACTIVATE_WORKBENCH_TAB", id: blank.id, scope }] : [attach];
  }
  return [
    {
      type: "ADD_WORKBENCH_TAB",
      tab: createSimulatorTab(device.platform, device.deviceId),
      ...(activate ? {} : { activate: false }),
      scope,
    },
  ];
}

/** One chat's use of one device, until that use ends. */
export function simulatorAgentKey(holder: { conversationId: string; deviceId: string }): string {
  return `${holder.conversationId}\n${holder.deviceId}`;
}

/** How far a device in use has come forward: its tab is `placed` in the
 * background, or has been `shown` once. */
export type SimulatorAgentTabProgress = "placed" | "shown";

export interface SimulatorAgentRoute {
  progress: SimulatorAgentTabProgress;
  actions: Action[];
  /** Expand the workbench so the tab shows. */
  revealWorkbench: boolean;
}

/** The next step for a device in use. Null when there is none: it was shown
 * already, or its chat still isn't on screen. */
export function routeSimulatorAgent(input: {
  device: { deviceId: string; platform: SimulatorPlatform };
  progress: SimulatorAgentTabProgress | undefined;
  /** The chat is the one on screen. */
  onScreen: boolean;
  scope: string;
  tabs: readonly WorkbenchTab[];
}): SimulatorAgentRoute | null {
  if (input.progress === "shown") return null;
  if (input.progress === "placed" && !input.onScreen) return null;
  const mode: SimulatorAgentTabMode =
    input.progress === "placed" ? "reveal" : input.onScreen ? "open" : "place";
  const actions = planSimulatorAgentTab(input.tabs, input.device, input.scope, mode);
  return {
    progress: mode === "place" ? "placed" : "shown",
    actions,
    revealWorkbench: mode === "open" || (mode === "reveal" && actions.length > 0),
  };
}
