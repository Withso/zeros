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

function signedInAs(staffRole: "developer" | "platform_owner" | null): void {
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

const OPEN = { zerosBrowser: true, computerUse: true, simulators: true };
const CLOSED = { zerosBrowser: false, computerUse: false, simulators: false };

beforeEach(() => {
  vi.unstubAllGlobals();
  env.me = null;
  env.localDevelopment = false;
});

describe("agent control rollout gate", () => {
  it("opens every internal-stage feature for staff, who can turn each off", async () => {
    const { rollout, internal } = await fresh();
    signedInAs("developer");
    expect(rollout.agentControlAvailability()).toEqual(OPEN);
    internal.setInternalFeatureEnabled("computerUse", false);
    expect(rollout.agentControlAvailability()).toEqual({
      ...OPEN,
      computerUse: false,
    });
    signedInAs("platform_owner");
    expect(rollout.isAgentControlFeatureActive("simulators")).toBe(true);
  });

  it("stays closed for everyone else, whatever their stored flags say", async () => {
    const { rollout, internal, experimental } = await fresh();
    for (const feature of ["zerosBrowser", "computerUse", "simulators"] as const) {
      internal.setInternalFeatureEnabled(feature, true);
      experimental.setExperimentalEnabled(feature, true);
    }
    expect(rollout.agentControlAvailability()).toEqual(CLOSED);
    signedInAs(null);
    expect(rollout.agentControlAvailability()).toEqual(CLOSED);
  });

  it("opens in a local development build, which has no staff account", async () => {
    const { rollout, internal } = await fresh();
    env.localDevelopment = true;
    expect(rollout.agentControlAvailability()).toEqual(OPEN);
    internal.setInternalFeatureEnabled("zerosBrowser", false);
    expect(rollout.isAgentControlFeatureActive("zerosBrowser")).toBe(false);
  });

  it("lists each stage's switches in display order", async () => {
    const { rollout } = await fresh();
    expect(rollout.agentControlFeaturesAt("internal")).toEqual([
      "zerosBrowser",
      "computerUse",
      "simulators",
    ]);
    expect(rollout.agentControlFeaturesAt("experimental")).toEqual([]);
    for (const feature of rollout.agentControlFeaturesAt("internal")) {
      expect(rollout.AGENT_CONTROL_FEATURE_ROWS[feature].label).toBeTruthy();
    }
  });
});
