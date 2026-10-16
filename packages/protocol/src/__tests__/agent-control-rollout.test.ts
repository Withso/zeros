import { describe, expect, it } from "vitest";

import {
  AGENT_CONTROL_FEATURES,
  AGENT_CONTROL_ROLLOUT,
  agentControlFeatureOpen,
  agentControlUnavailableReason,
  gateBrowserRouteSettings,
  gateComputerUseSettings,
  gateSimulatorSettings,
  initialAgentControlAvailability,
  readAgentControlAvailability,
  sameAgentControlAvailability,
  type AgentControlAvailability,
} from "../agent-control-rollout";
import {
  browserRouteSettings,
  resolveBrowserRoute,
} from "../browser-tools";
import {
  computerUseSettings,
  resolveComputerUseRoute,
} from "../computer-use-tools";
import { resolveDeviceToolRoute } from "../device-tools";
import { simulatorSettings } from "../simulators";

const OPEN: AgentControlAvailability = {
  zerosBrowser: true,
  computerUse: true,
  simulators: true,
};
const CLOSED: AgentControlAvailability = {
  zerosBrowser: false,
  computerUse: false,
  simulators: false,
};
const FAMILIES = ["codex", "claude", "cursor"] as const;

describe("agent control rollout", () => {
  it("starts every staged feature with staff", () => {
    expect(AGENT_CONTROL_FEATURES).toEqual([
      "zerosBrowser",
      "computerUse",
      "simulators",
    ]);
    for (const feature of AGENT_CONTROL_FEATURES) {
      expect(AGENT_CONTROL_ROLLOUT[feature]).toBe("internal");
    }
  });

  it("opens each stage only for its audience", () => {
    const nobody = { internal: false, experimental: false };
    expect(agentControlFeatureOpen("internal", nobody)).toBe(false);
    expect(
      agentControlFeatureOpen("internal", { internal: true, experimental: false }),
    ).toBe(true);
    // Opting in under Experimental does nothing while staff still test it.
    expect(
      agentControlFeatureOpen("internal", { internal: false, experimental: true }),
    ).toBe(false);
    expect(agentControlFeatureOpen("experimental", nobody)).toBe(false);
    expect(
      agentControlFeatureOpen("experimental", {
        internal: false,
        experimental: true,
      }),
    ).toBe(true);
    // One switch per stage: the Internal switch retires with the stage.
    expect(
      agentControlFeatureOpen("experimental", {
        internal: true,
        experimental: false,
      }),
    ).toBe(false);
    expect(agentControlFeatureOpen("default", nobody)).toBe(true);
  });

  it("assumes only features that are on for everyone until told otherwise", () => {
    expect(initialAgentControlAvailability()).toEqual(CLOSED);
    expect(
      initialAgentControlAvailability({
        zerosBrowser: "default",
        computerUse: "experimental",
        simulators: "internal",
      }),
    ).toEqual({ zerosBrowser: true, computerUse: false, simulators: false });
  });

  it("reads a pushed availability strictly", () => {
    expect(readAgentControlAvailability(OPEN)).toEqual(OPEN);
    expect(
      readAgentControlAvailability({ ...CLOSED, extra: "ignored" }),
    ).toEqual(CLOSED);
    for (const bad of [
      null,
      undefined,
      "open",
      [],
      {},
      { zerosBrowser: true, computerUse: true },
      { ...OPEN, simulators: "true" },
      { ...OPEN, computerUse: 1 },
    ]) {
      expect(readAgentControlAvailability(bad)).toBeNull();
    }
    expect(sameAgentControlAvailability(OPEN, { ...OPEN })).toBe(true);
    expect(
      sameAgentControlAvailability(OPEN, { ...OPEN, simulators: false }),
    ).toBe(false);
  });

  it("routes browsers as before the Zeros browser while it is closed", () => {
    const table: Array<{
      raw: Record<string, unknown>;
      open: Record<(typeof FAMILIES)[number], string>;
      closed: Record<(typeof FAMILIES)[number], string>;
    }> = [
      {
        raw: {},
        open: { codex: "codex-native", claude: "zeros", cursor: "zeros" },
        closed: { codex: "codex-native", claude: "off", cursor: "off" },
      },
      {
        raw: { codex_native: false },
        open: { codex: "zeros", claude: "zeros", cursor: "zeros" },
        // The Codex fallback to the Zeros browser goes with it.
        closed: { codex: "codex-native", claude: "off", cursor: "off" },
      },
      {
        raw: { codex_enabled: false, claude_enabled: true },
        open: { codex: "off", claude: "claude-chrome", cursor: "zeros" },
        closed: { codex: "off", claude: "claude-chrome", cursor: "off" },
      },
      {
        raw: { in_app_enabled: false },
        open: { codex: "codex-native", claude: "off", cursor: "off" },
        closed: { codex: "codex-native", claude: "off", cursor: "off" },
      },
    ];
    for (const row of table) {
      const settings = browserRouteSettings(row.raw);
      for (const family of FAMILIES) {
        expect(
          resolveBrowserRoute(family, gateBrowserRouteSettings(settings, OPEN)),
        ).toBe(row.open[family]);
        expect(
          resolveBrowserRoute(
            family,
            gateBrowserRouteSettings(settings, CLOSED),
          ),
        ).toBe(row.closed[family]);
      }
    }
  });

  it("keeps Codex's own computer use and nothing else while computer use is closed", () => {
    for (const raw of [
      {},
      { enabled: true },
      { enabled: true, codex_native: false },
      { codex_native: false },
    ]) {
      const settings = computerUseSettings(raw);
      const gated = gateComputerUseSettings(settings, CLOSED);
      expect(gated.blockedApps).toEqual(settings.blockedApps);
      expect(gated.showAgentCursor).toBe(settings.showAgentCursor);
      expect(resolveComputerUseRoute("codex", gated)).toBe("codex-native");
      expect(resolveComputerUseRoute("claude", gated)).toBe("off");
      expect(resolveComputerUseRoute("cursor", gated)).toBe("off");
      expect(gateComputerUseSettings(settings, OPEN)).toBe(settings);
    }
    const on = computerUseSettings({ enabled: true, codex_native: false });
    for (const family of FAMILIES) {
      expect(
        resolveComputerUseRoute(family, gateComputerUseSettings(on, OPEN)),
      ).toBe("zeros");
    }
  });

  it("gives no agent the simulator tools while simulators are closed", () => {
    const settings = simulatorSettings({ enabled: true });
    for (const family of FAMILIES) {
      expect(
        resolveDeviceToolRoute(family, gateSimulatorSettings(settings, OPEN)),
      ).toBe("zeros");
      expect(
        resolveDeviceToolRoute(family, gateSimulatorSettings(settings, CLOSED)),
      ).toBe("off");
    }
    expect(gateSimulatorSettings(settings, OPEN)).toBe(settings);
  });

  it("explains a closed feature without pointing at a switch the user lacks", () => {
    for (const feature of AGENT_CONTROL_FEATURES) {
      const reason = agentControlUnavailableReason(feature);
      expect(reason).toMatch(/isn't available|aren't available/);
      expect(reason).not.toMatch(/Settings/);
    }
  });
});
