import {
  initialAgentControlAvailability,
  type AgentControlAvailability,
} from "@zeros/protocol/agent-control-rollout";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserRouteForWorkspace } from "../../browser/browser-tool-client";
import { opSettingsResolve } from "../../settings/ops";
import {
  agentControlAvailability,
  agentControlFeatureAvailable,
  setAgentControlAvailability,
} from "../availability";
import { computerUseRouteForWorkspace } from "../computer-use-settings";
import { deviceToolRouteForWorkspace } from "../simulator-settings";

vi.mock("../../settings/ops", () => ({ opSettingsResolve: vi.fn() }));

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

function settings(effective: Record<string, unknown>): void {
  vi.mocked(opSettingsResolve).mockReturnValue({
    effective,
    sources: {},
    warnings: [],
  } as unknown as ReturnType<typeof opSettingsResolve>);
}

function browserRoutes() {
  return FAMILIES.map((family) =>
    browserRouteForWorkspace(family, "/tmp/project"),
  );
}

function computerRoutes() {
  return FAMILIES.map((family) =>
    computerUseRouteForWorkspace(family, "/tmp/project"),
  );
}

function deviceRoutes() {
  return FAMILIES.map((family) =>
    deviceToolRouteForWorkspace(family, "/tmp/project"),
  );
}

describe("agent control rollout in the engine", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() =>
    setAgentControlAvailability(initialAgentControlAvailability()),
  );

  it("starts with only the features that are on for everyone", () => {
    expect(agentControlAvailability()).toEqual(
      initialAgentControlAvailability(),
    );
    setAgentControlAvailability({ ...CLOSED, simulators: true });
    expect(agentControlFeatureAvailable("simulators")).toBe(true);
    expect(agentControlFeatureAvailable("zerosBrowser")).toBe(false);
  });

  it("routes browsers as they were before the Zeros browser while it is closed", () => {
    settings({
      browser: {
        codex_native: false,
        in_app_enabled: true,
        provider: "isolated",
      },
    });
    setAgentControlAvailability(OPEN);
    expect(browserRoutes()).toEqual(["zeros", "zeros", "zeros"]);

    setAgentControlAvailability(CLOSED);
    expect(browserRoutes()).toEqual(["codex-native", "off", "off"]);

    // The switches that predate the Zeros browser keep working.
    settings({
      browser: {
        codex_enabled: false,
        claude_enabled: true,
        provider: "isolated",
      },
    });
    expect(browserRoutes()).toEqual(["off", "claude-chrome", "off"]);
  });

  it("keeps Codex's built-in computer use and gives no one else any while it is closed", () => {
    settings({ computer_use: { enabled: true, codex_native: false } });
    setAgentControlAvailability(OPEN);
    expect(computerRoutes()).toEqual(["zeros", "zeros", "zeros"]);

    setAgentControlAvailability({ ...OPEN, computerUse: false });
    expect(computerRoutes()).toEqual(["codex-native", "off", "off"]);
  });

  it("gives no agent the simulator tools while simulators are closed", () => {
    settings({ simulators: { enabled: true } });
    setAgentControlAvailability(OPEN);
    expect(deviceRoutes()).toEqual(["zeros", "zeros", "zeros"]);

    setAgentControlAvailability({ ...OPEN, simulators: false });
    expect(deviceRoutes()).toEqual(["off", "off", "off"]);
  });

  it("closes each feature on its own", () => {
    settings({
      browser: { codex_native: false, provider: "isolated" },
      computer_use: { enabled: true, codex_native: false },
      simulators: { enabled: true },
    });
    setAgentControlAvailability({ ...OPEN, zerosBrowser: false });
    expect(browserRoutes()).toEqual(["codex-native", "off", "off"]);
    expect(computerRoutes()).toEqual(["zeros", "zeros", "zeros"]);
    expect(deviceRoutes()).toEqual(["zeros", "zeros", "zeros"]);
  });
});
