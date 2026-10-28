import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "../../team/control-plane";

type Rollout = typeof import("../agent-control-rollout");
type Internal = typeof import("../internal-features");
type Experimental = typeof import("../experimental-features");

const env = vi.hoisted(() => ({
  me: null as unknown,
  localDevelopment: false,
}));

vi.mock("../../team/team-store", () => {
  const snapshot = () => ({ me: env.me, status: "ready" as const, error: null });
  return {
    getTeamStoreState: snapshot,
    useTeams: () => ({ ...snapshot(), reload: async () => env.me }),
  };
});

vi.mock("../../../platform/runtime", () => ({
  isLocalDevelopment: () => env.localDevelopment,
}));

function signedInAs(staffRole: "developer" | "platform_owner" | "support_admin" | null): void {
  env.me = {
    user: {
      id: "00000000-0000-0000-0000-000000000001",
      email: "someone@example.test",
      displayName: null,
      staffRole,
    },
    teams: [],
  } satisfies Me;
}

async function fresh(): Promise<{
  rollout: Rollout;
  internal: Internal;
  experimental: Experimental;
}> {
  vi.resetModules();
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  });
  return {
    rollout: await import("../agent-control-rollout"),
    internal: await import("../internal-features"),
    experimental: await import("../experimental-features"),
  };
}

const OPEN = { zerosBrowser: true, computerUse: true, simulators: true, localOrchestration: true };
const FEATURES = ["zerosBrowser", "computerUse", "simulators", "localOrchestration"] as const;

beforeEach(() => {
  vi.unstubAllGlobals();
  env.me = null;
  env.localDevelopment = false;
});

describe("agent control rollout gate", () => {
  it("opens all four features without an account or an opt-in", async () => {
    const { rollout } = await fresh();
    expect(rollout.agentControlAvailability()).toEqual(OPEN);
    for (const role of [null, "developer", "platform_owner", "support_admin"] as const) {
      signedInAs(role);
      expect(rollout.agentControlAvailability()).toEqual(OPEN);
    }
  });

  it("ignores old rollout opt-outs across account changes and reloads", async () => {
    const { rollout, internal, experimental } = await fresh();
    for (const feature of FEATURES) {
      internal.setInternalFeatureEnabled(feature, false);
      experimental.setExperimentalEnabled(feature, false);
    }
    for (const role of ["developer", null, "platform_owner"] as const) {
      signedInAs(role);
      expect(rollout.agentControlAvailability()).toEqual(OPEN);
    }
    env.me = null;
    expect(rollout.agentControlAvailability()).toEqual(OPEN);
    vi.resetModules();
    const restored = await import("../agent-control-rollout");
    expect(restored.agentControlAvailability()).toEqual(OPEN);
  });

  it("keeps local development open with old Internal flags off", async () => {
    const { rollout, internal } = await fresh();
    env.localDevelopment = true;
    expect(rollout.agentControlAvailability()).toEqual(OPEN);
    internal.setInternalFeatureEnabled("zerosBrowser", false);
    expect(rollout.isAgentControlFeatureActive("zerosBrowser")).toBe(true);
  });

  it("removes public features from both rollout settings panels", async () => {
    const { rollout } = await fresh();
    expect(rollout.agentControlFeaturesAt("internal")).toEqual([]);
    expect(rollout.agentControlFeaturesAt("experimental")).toEqual([]);
    expect(rollout.agentControlFeaturesAt("default")).toEqual(FEATURES);
  });
});
