import { describe, expect, it, vi } from "vitest";

import type { InitializeResponse } from "@zeros/protocol/agent-events";
import type { AgentAdapter } from "../types";
import {
  advertiseAgentCapabilities,
  resolveAgentCapabilityPorts,
} from "../capabilities";

function fakeAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    agentId: "future-agent",
    initialize: async () => ({ protocolVersion: 1 }),
    newSession: async () => {
      throw new Error("not used");
    },
    loadSession: async () => {
      throw new Error("not used");
    },
    listSessions: async () => ({ sessions: [] }),
    prompt: async () => {
      throw new Error("not used");
    },
    cancel: async () => undefined,
    dispose: async () => undefined,
    ...overrides,
  } as AgentAdapter;
}

describe("engine-owned agent capability boundary", () => {
  it("binds legacy adapter methods behind narrow domain ports", async () => {
    const steer = vi.fn(function (this: AgentAdapter) {
      expect(this.agentId).toBe("future-agent");
      return Promise.resolve();
    });
    const adapter = fakeAdapter({ steer });

    const ports = resolveAgentCapabilityPorts(adapter);
    await ports.turnControl?.steer?.({ sessionId: "execution-1", prompt: [] });

    expect(steer).toHaveBeenCalledOnce();
    expect(ports.conversation).toBeUndefined();
    expect(ports.interaction).toBeUndefined();
  });

  it("advertises implemented behavior without treating method absence as support", () => {
    const initialize = advertiseAgentCapabilities(
      fakeAdapter({
        steer: async () => undefined,
        respondToQuestion: () => true,
      }),
      { protocolVersion: 1 },
    );

    expect(initialize.agentCapabilities?.loadSession).toBe(true);
    expect(initialize.agentCapabilities?.steering).toBe(true);
    expect(initialize.agentCapabilities?.domains?.turn.steering).toEqual({
      implementation: "harness-native",
      availability: "available",
      requirements: ["live-session", "active-turn"],
    });
    expect(
      initialize.agentCapabilities?.domains?.interaction.questionResponse,
    ).toEqual({
      implementation: "harness-native",
      availability: "available",
    });
    expect(
      initialize.agentCapabilities?.domains?.interaction.permissionResponse,
    ).toEqual({
      implementation: "unavailable",
      availability: "unavailable",
      reason: "This harness has no host-answerable permission channel.",
    });
    expect(initialize.agentCapabilities?.domains?.conversation.fork).toEqual({
      implementation: "unavailable",
      availability: "unavailable",
      reason: "This harness does not expose conversation fork.",
    });
  });

  it("reports dynamic model discovery as runtime-dependent until data arrives", () => {
    const adapter = fakeAdapter();
    const cold: InitializeResponse = {
      protocolVersion: 1,
      _meta: { modelEnvVar: "FUTURE_MODEL", modelsDynamic: true },
    };
    const warm: InitializeResponse = {
      ...cold,
      _meta: {
        ...cold._meta,
        models: [{ value: "future-1", label: "Future 1" }],
      },
    };

    expect(
      advertiseAgentCapabilities(adapter, cold).agentCapabilities?.domains
        ?.models.catalog,
    ).toEqual({
      implementation: "harness-native",
      availability: "runtime-dependent",
      requirements: ["live-runtime"],
    });
    expect(
      advertiseAgentCapabilities(adapter, warm).agentCapabilities?.domains
        ?.models.catalog,
    ).toEqual({
      implementation: "harness-native",
      availability: "available",
    });
  });

  it("prefers an adapter's explicit port over its compatibility method", async () => {
    const legacy = vi.fn(async () => undefined);
    const explicit = vi.fn(async () => undefined);
    const adapter = fakeAdapter({
      steer: legacy,
      capabilityPorts: { turnControl: { steer: explicit } },
    });

    await resolveAgentCapabilityPorts(adapter).turnControl?.steer?.({
      sessionId: "execution-1",
      prompt: [],
    });

    expect(explicit).toHaveBeenCalledOnce();
    expect(legacy).not.toHaveBeenCalled();
  });
});
