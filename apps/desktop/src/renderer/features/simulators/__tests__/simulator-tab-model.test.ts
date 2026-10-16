import { describe, expect, it } from "vitest";
import type { SimulatorDevice, SimulatorHubSnapshot } from "@zeros/protocol/simulators";

import type { WorkbenchTab } from "../../../shell/workbench/tab-model";
import {
  parseSimulatorsShownElsewhere,
  planSimulatorAgentTab,
  reusableSimulatorTab,
  routeSimulatorAgent,
  simulatorAgentKey,
  simulatorTabFollowsHub,
  simulatorTabView,
  simulatorsShownElsewhere,
} from "../simulator-tab-model";

const PHONE: SimulatorDevice = {
  id: "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108",
  platform: "ios",
  name: "iPhone 17",
  osLabel: "iOS 27.0",
  formFactor: "phone",
  state: "booted",
  bootedByZeros: true,
};
const TABLET: SimulatorDevice = {
  ...PHONE,
  id: "3C744E00-0000-4000-8000-000000000001",
  name: "iPad Pro 13-inch (M5)",
  formFactor: "tablet",
  state: "shutdown",
};

const snapshot = (devices: SimulatorDevice[]): SimulatorHubSnapshot => ({
  version: 1,
  devices,
  setup: [{ platform: "ios", state: "ready", toolLabel: "Xcode 27.0", download: null }],
  idleWarnings: [],
});

describe("simulator tab model", () => {
  it("lists devices other Simulator tabs show, ignoring this tab and other tab types", () => {
    const tabs = [
      { id: "a", type: "simulator" as const, simulatorPlatform: "ios" as const, simulatorDeviceId: PHONE.id },
      { id: "b", type: "simulator" as const, simulatorPlatform: "ios" as const, simulatorDeviceId: TABLET.id },
      { id: "c", type: "simulator" as const, simulatorPlatform: "ios" as const, simulatorDeviceId: PHONE.id },
      { id: "d", type: "simulator" as const, simulatorPlatform: "ios" as const },
      { id: "e", type: "browser" as const },
    ];
    const key = simulatorsShownElsewhere(tabs, "a");
    expect(key).toBe(simulatorsShownElsewhere([...tabs].reverse(), "a"));
    expect([...parseSimulatorsShownElsewhere(key)].sort()).toEqual([TABLET.id, PHONE.id].sort());
    expect(parseSimulatorsShownElsewhere(simulatorsShownElsewhere(tabs.slice(3), "a")).size).toBe(0);
  });

  it("shows setup without a device, waits for the hub with one, and falls back when it is gone", () => {
    expect(simulatorTabView(null, undefined, "ios")).toEqual({ kind: "setup" });
    expect(simulatorTabView(null, PHONE.id, "ios")).toEqual({ kind: "waiting" });
    expect(simulatorTabView(snapshot([PHONE]), PHONE.id, "ios")).toEqual({
      kind: "device",
      device: PHONE,
    });
    expect(simulatorTabView(snapshot([TABLET]), PHONE.id, "ios")).toEqual({ kind: "setup" });
    expect(simulatorTabView(snapshot([PHONE]), PHONE.id, "android")).toEqual({ kind: "setup" });
  });

  it("follows the hub only while it shows no device that main is already reading", () => {
    expect(simulatorTabFollowsHub({ kind: "setup" })).toBe(true);
    expect(simulatorTabFollowsHub({ kind: "device", device: TABLET })).toBe(true);
    // Its own first read is on the way.
    expect(simulatorTabFollowsHub({ kind: "waiting" })).toBe(false);
    // Main reads devices while one is on screen, starting or stopping.
    for (const state of ["booted", "booting", "shutting-down"] as const) {
      expect(simulatorTabFollowsHub({ kind: "device", device: { ...PHONE, state } })).toBe(false);
    }
  });

  it("reuses only a tab of the same platform that has no device", () => {
    const attached = { id: "a", type: "simulator" as const, simulatorPlatform: "ios" as const, simulatorDeviceId: PHONE.id };
    const android = { id: "b", type: "simulator" as const, simulatorPlatform: "android" as const };
    const blank = { id: "c", type: "simulator" as const, simulatorPlatform: "ios" as const };
    expect(reusableSimulatorTab([attached, android], "ios")).toBeNull();
    expect(reusableSimulatorTab([attached, android, blank], "ios")).toBe(blank);
    expect(reusableSimulatorTab([attached, android, blank], "android")).toBe(android);
  });
});

describe("opening the simulator an agent uses", () => {
  const SCOPE = "/Users/someone/app";
  const agentDevice = { deviceId: PHONE.id, platform: "ios" as const };
  const showing: WorkbenchTab = {
    id: "shows-phone",
    type: "simulator",
    title: "iOS Simulator",
    simulatorPlatform: "ios",
    simulatorDeviceId: PHONE.id,
  };
  const blank: WorkbenchTab = {
    id: "blank",
    type: "simulator",
    title: "iOS Simulator",
    simulatorPlatform: "ios",
  };
  const other: WorkbenchTab = { ...showing, id: "shows-tablet", simulatorDeviceId: TABLET.id };

  it("brings forward the tab already showing the device", () => {
    expect(planSimulatorAgentTab([other, showing, blank], agentDevice, SCOPE, "open")).toEqual([
      { type: "ACTIVATE_WORKBENCH_TAB", id: "shows-phone", scope: SCOPE },
    ]);
    expect(planSimulatorAgentTab([showing], agentDevice, SCOPE, "place")).toEqual([]);
  });

  it("shows the device in a tab that has none, before opening a new tab", () => {
    expect(planSimulatorAgentTab([other, blank], agentDevice, SCOPE, "open")).toEqual([
      {
        type: "UPDATE_WORKBENCH_TAB",
        id: "blank",
        updates: { simulatorDeviceId: PHONE.id },
        scope: SCOPE,
      },
      { type: "ACTIVATE_WORKBENCH_TAB", id: "blank", scope: SCOPE },
    ]);
    expect(planSimulatorAgentTab([blank], agentDevice, SCOPE, "place")).toEqual([
      {
        type: "UPDATE_WORKBENCH_TAB",
        id: "blank",
        updates: { simulatorDeviceId: PHONE.id },
        scope: SCOPE,
      },
    ]);
  });

  it("adds a tab in the chat's workspace, in the background unless the chat is on screen", () => {
    const [added] = planSimulatorAgentTab([other], agentDevice, SCOPE, "place");
    expect(added).toMatchObject({
      type: "ADD_WORKBENCH_TAB",
      activate: false,
      scope: SCOPE,
      tab: { type: "simulator", simulatorPlatform: "ios", simulatorDeviceId: PHONE.id },
    });
    const [opened] = planSimulatorAgentTab([], agentDevice, SCOPE, "open");
    expect(opened).toMatchObject({ type: "ADD_WORKBENCH_TAB", scope: SCOPE });
    expect(opened).not.toHaveProperty("activate");
  });

  it("only brings forward a tab placed earlier, so a closed one stays closed", () => {
    expect(planSimulatorAgentTab([showing], agentDevice, SCOPE, "reveal")).toEqual([
      { type: "ACTIVATE_WORKBENCH_TAB", id: "shows-phone", scope: SCOPE },
    ]);
    expect(planSimulatorAgentTab([other, blank], agentDevice, SCOPE, "reveal")).toEqual([]);
  });
});

describe("following a chat that uses a simulator", () => {
  const SCOPE = "/Users/someone/app";
  const device = { deviceId: PHONE.id, platform: "ios" as const };
  const showing: WorkbenchTab = {
    id: "shows-phone",
    type: "simulator",
    title: "iOS Simulator",
    simulatorPlatform: "ios",
    simulatorDeviceId: PHONE.id,
  };
  const route = (
    progress: "placed" | "shown" | undefined,
    onScreen: boolean,
    tabs: WorkbenchTab[] = [],
  ) => routeSimulatorAgent({ device, progress, onScreen, scope: SCOPE, tabs });

  it("keys each chat's use of each device", () => {
    const key = simulatorAgentKey({ conversationId: "chat-a", deviceId: PHONE.id });
    expect(key).not.toBe(simulatorAgentKey({ conversationId: "chat-b", deviceId: PHONE.id }));
    expect(key).not.toBe(simulatorAgentKey({ conversationId: "chat-a", deviceId: TABLET.id }));
  });

  it("opens the tab and the workbench when the chat is on screen", () => {
    const opened = route(undefined, true);
    expect(opened).toMatchObject({ progress: "shown", revealWorkbench: true });
    expect(opened?.actions).toEqual([
      expect.objectContaining({ type: "ADD_WORKBENCH_TAB", scope: SCOPE }),
    ]);
    // Already showing: it still comes forward, with a collapsed workbench opened.
    expect(route(undefined, true, [showing])).toEqual({
      progress: "shown",
      actions: [{ type: "ACTIVATE_WORKBENCH_TAB", id: "shows-phone", scope: SCOPE }],
      revealWorkbench: true,
    });
  });

  it("places the tab in the background, then brings it forward once the chat is on screen", () => {
    const placed = route(undefined, false);
    expect(placed).toMatchObject({ progress: "placed", revealWorkbench: false });
    expect(placed?.actions).toEqual([
      expect.objectContaining({ type: "ADD_WORKBENCH_TAB", activate: false }),
    ]);
    expect(route("placed", false, [showing])).toBeNull();
    expect(route("placed", true, [showing])).toEqual({
      progress: "shown",
      actions: [{ type: "ACTIVATE_WORKBENCH_TAB", id: "shows-phone", scope: SCOPE }],
      revealWorkbench: true,
    });
  });

  it("leaves a tab the user closed closed, and acts once per use", () => {
    expect(route("placed", true, [])).toEqual({
      progress: "shown",
      actions: [],
      revealWorkbench: false,
    });
    expect(route("shown", true, [showing])).toBeNull();
    expect(route("shown", false, [])).toBeNull();
  });
});
