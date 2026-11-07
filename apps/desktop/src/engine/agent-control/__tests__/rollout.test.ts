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
  localOrchestration: true,
};
const CLOSED: AgentControlAvailability = {
  zerosBrowser: false,
  computerUse: false,
  simulators: false,
  localOrchestration: false,
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

  it("gives no agent the in-app browser while it is closed, keeping Claude's chosen Chrome", () => {
    settings({ browser: { enabled: true } });
    setAgentControlAvailability(OPEN);
    expect(browserRoutes()).toEqual(["zeros", "zeros", "zeros"]);

    setAgentControlAvailability(CLOSED);
    expect(browserRoutes()).toEqual(["off", "off", "off"]);

    settings({ browser: { enabled: true, claude_enabled: true } });
    expect(browserRoutes()).toEqual(["off", "claude-chrome", "off"]);
  });

  it("gives no agent computer use while it is closed", () => {
    settings({ computer_use: { enabled: true } });
    setAgentControlAvailability(OPEN);
    expect(computerRoutes()).toEqual(["zeros", "zeros", "zeros"]);

    setAgentControlAvailability({ ...OPEN, computerUse: false });
    expect(computerRoutes()).toEqual(["off", "off", "off"]);
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
      browser: { enabled: true },
      computer_use: { enabled: true },
      simulators: { enabled: true },
    });
    setAgentControlAvailability({ ...OPEN, zerosBrowser: false });
    expect(browserRoutes()).toEqual(["off", "off", "off"]);
    expect(computerRoutes()).toEqual(["zeros", "zeros", "zeros"]);
    expect(deviceRoutes()).toEqual(["zeros", "zeros", "zeros"]);
  });
});
