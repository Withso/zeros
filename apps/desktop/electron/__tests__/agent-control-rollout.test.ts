import { afterEach, describe, expect, it } from "vitest";
import {
  initialAgentControlAvailability,
  readAgentControlAvailability,
} from "@zeros/protocol/agent-control-rollout";
import {
  agentControlAvailability,
  setAgentControlAvailability,
} from "../agent-control/rollout";

afterEach(() => setAgentControlAvailability(initialAgentControlAvailability()));

describe("main's agent control availability", () => {
  it("applies a new renderer push and observes a Local CLI-only change", () => {
    const next = readAgentControlAvailability({
      zerosBrowser: false,
      computerUse: false,
      simulators: false,
      localOrchestration: true,
    });
    expect(next).not.toBeNull();
    expect(setAgentControlAvailability(next!)).toBe(true);
    expect(agentControlAvailability().localOrchestration).toBe(true);
    expect(setAgentControlAvailability(next!)).toBe(false);
  });

  it("applies an older push while closing the omitted Local CLI feature", () => {
    setAgentControlAvailability({
      ...initialAgentControlAvailability(),
      localOrchestration: true,
    });
    const next = readAgentControlAvailability({
      zerosBrowser: true,
      computerUse: false,
      simulators: true,
    });
    expect(next).not.toBeNull();
    expect(setAgentControlAvailability(next!)).toBe(true);
    expect(agentControlAvailability()).toEqual({
      zerosBrowser: true,
      computerUse: false,
      simulators: true,
      localOrchestration: false,
    });
  });

  it("rejects a malformed push without partially applying its features", () => {
    const before = agentControlAvailability();
    const next = readAgentControlAvailability({
      zerosBrowser: true,
      computerUse: true,
      simulators: true,
      localOrchestration: "true",
    });
    expect(next).toBeNull();
    expect(agentControlAvailability()).toBe(before);
  });
});
