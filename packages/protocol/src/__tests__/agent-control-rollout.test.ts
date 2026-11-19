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
  localOrchestration: true,
};
const CLOSED: AgentControlAvailability = {
  zerosBrowser: false,
  computerUse: false,
  simulators: false,
  localOrchestration: false,
};
const FAMILIES = ["codex", "claude", "cursor"] as const;

describe("agent control rollout", () => {
  it("ships all four agent control features to everyone by default", () => {
    expect(AGENT_CONTROL_FEATURES).toEqual([
      "zerosBrowser",
      "computerUse",
      "simulators",
      "localOrchestration",
    ]);
    for (const feature of AGENT_CONTROL_FEATURES) {
      expect(AGENT_CONTROL_ROLLOUT[feature]).toBe("default");
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
    expect(initialAgentControlAvailability()).toEqual(OPEN);
    expect(
      initialAgentControlAvailability({
        zerosBrowser: "default",
        computerUse: "experimental",
        simulators: "internal",
        localOrchestration: "default",
      }),
    ).toEqual({
      zerosBrowser: true,
      computerUse: false,
      simulators: false,
      localOrchestration: true,
    });
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
      { ...OPEN, localOrchestration: "true" },
      { ...OPEN, localOrchestration: null },
    ]) {
      expect(readAgentControlAvailability(bad)).toBeNull();
    }
    // A push from a renderer that predates the Local CLI still applies and
    // keeps the Local CLI closed.
    expect(
      readAgentControlAvailability({
        zerosBrowser: true,
        computerUse: true,
        simulators: true,
      }),
    ).toEqual({ ...OPEN, localOrchestration: false });
    expect(sameAgentControlAvailability(OPEN, { ...OPEN })).toBe(true);
    expect(
      sameAgentControlAvailability(OPEN, { ...OPEN, simulators: false }),
    ).toBe(false);
  });

  it("gives no agent the in-app browser while it is closed, and keeps Claude's Chrome", () => {
    const table: Array<{
      raw: Record<string, unknown>;
      open: Record<(typeof FAMILIES)[number], string>;
      closed: Record<(typeof FAMILIES)[number], string>;
    }> = [
      {
        raw: {},
        open: { codex: "zeros", claude: "zeros", cursor: "zeros" },
        closed: { codex: "off", claude: "off", cursor: "off" },
      },
      {
        // A retired `codex_native` no longer sends Codex to its built-in.
        raw: { codex_native: true },
        open: { codex: "zeros", claude: "zeros", cursor: "zeros" },
        closed: { codex: "off", claude: "off", cursor: "off" },
      },
      {
        raw: { claude_enabled: true },
        open: { codex: "zeros", claude: "claude-chrome", cursor: "zeros" },
        closed: { codex: "off", claude: "claude-chrome", cursor: "off" },
      },
      {
        // "Enable browser use" off: no agent gets a browser, Chrome included.
        raw: { enabled: false, claude_enabled: true },
        open: { codex: "off", claude: "off", cursor: "off" },
        closed: { codex: "off", claude: "off", cursor: "off" },
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

  it("gives no agent computer use while it is closed", () => {
    for (const raw of [{}, { enabled: true }, { enabled: true, codex_native: true }]) {
      const settings = computerUseSettings(raw);
      const gated = gateComputerUseSettings(settings, CLOSED);
      expect(gated.blockedApps).toEqual(settings.blockedApps);
      expect(gated.showAgentCursor).toBe(settings.showAgentCursor);
      for (const family of FAMILIES) {
        expect(resolveComputerUseRoute(family, gated)).toBe("off");
      }
      expect(gateComputerUseSettings(settings, OPEN)).toBe(settings);
    }
    const on = computerUseSettings({ enabled: true });
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
