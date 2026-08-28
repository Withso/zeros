import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WarmSessionBoundaryPool } from "../warm-session-boundary-pool";
import type {
  BoundaryRequest,
  BoundaryTerritoryContributionSnapshot,
  PreparedBoundary,
  TerritoryGeneration,
} from "../types";

function request(overrides: Partial<BoundaryRequest> = {}): BoundaryRequest {
  return {
    executionId: "session-1",
    actor: "agent-code",
    providerId: "claude",
    cwd: "/ws/repo",
    workspaceRoot: "/ws/repo",
    ...overrides,
  };
}

const contributions: readonly BoundaryTerritoryContributionSnapshot[] = [
  {
    workspaceRoot: "/ws/repo",
    grants: ["/ws/repo"],
    full: true,
    identity: "identity-a",
  },
];

function fakeBoundary(label: string): PreparedBoundary {
  return {
    generation: `gen-${label}` as TerritoryGeneration,
  } as unknown as PreparedBoundary;
}

describe("WarmSessionBoundaryPool", () => {
  let prepared: string[];
  let retired: string[];
  let prepareError: Error | null;
  let pool: WarmSessionBoundaryPool;

  beforeEach(() => {
    vi.useFakeTimers();
    prepared = [];
    retired = [];
    prepareError = null;
    pool = new WarmSessionBoundaryPool({
      prepare: async (boundaryRequest) => {
        if (prepareError) throw prepareError;
        prepared.push(boundaryRequest.executionId);
        return fakeBoundary(boundaryRequest.executionId);
      },
      retire: async (executionId) => {
        retired.push(executionId);
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adopts a replenished boundary exactly once for a byte-identical request", async () => {
    await pool.replenish(request(), contributions, "auth-1");
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatch(/^warm-/);

    // A different session id is irrelevant to the key; everything else must
    // match exactly.
    const adopted = pool.adopt(
      request({ executionId: "session-2" }),
      contributions,
    );
    expect(adopted).not.toBeNull();
    expect(adopted?.boundary.territoryContributions).toBe(contributions);
    expect(adopted?.boundary.registeredDesignAuthorityIdentity).toBe("auth-1");
    expect(pool.size()).toBe(0);
    expect(
      pool.adopt(request({ executionId: "session-3" }), contributions),
    ).toBeNull();
  });

  it("misses when any request byte or the contribution snapshot differs", async () => {
    await pool.replenish(request(), contributions, "auth-1");
    expect(
      pool.adopt(request({ providerId: "codex" }), contributions),
    ).toBeNull();
    expect(
      pool.adopt(request(), [{ ...contributions[0]!, identity: "identity-b" }]),
    ).toBeNull();
    expect(pool.size()).toBe(1);
  });

  it("retires an idle entry after the idle window", async () => {
    await pool.replenish(request(), contributions, "auth-1");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(retired).toHaveLength(1);
    expect(pool.adopt(request(), contributions)).toBeNull();
  });

  it("refuses adoption and pre-admission while the workspace territory is suspended, and retires matching entries", async () => {
    await pool.replenish(request(), contributions, "auth-1");
    pool.suspendWorkspaceTerritory("/ws/repo");
    expect(pool.adopt(request(), contributions)).toBeNull();
    await pool.disposeWorkspaceTerritory("/ws/repo");
    expect(retired).toHaveLength(1);
    await pool.replenish(request(), contributions, "auth-1");
    expect(prepared).toHaveLength(1);
    pool.resumeWorkspaceTerritory("/ws/repo");
    await pool.replenish(request(), contributions, "auth-1");
    expect(prepared).toHaveLength(2);
  });

  it("retires a boundary whose admission crossed a suspension instead of pooling it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowPool = new WarmSessionBoundaryPool({
      prepare: async (boundaryRequest) => {
        await gate;
        prepared.push(boundaryRequest.executionId);
        return fakeBoundary(boundaryRequest.executionId);
      },
      retire: async (executionId) => {
        retired.push(executionId);
      },
    });
    const replenish = slowPool.replenish(request(), contributions, "auth-1");
    slowPool.suspendWorkspaceTerritory("/ws/repo");
    release();
    await replenish;
    expect(retired).toHaveLength(1);
    expect(slowPool.size()).toBe(0);
  });

  it("refuses adoption and pre-admission across a global suspension", async () => {
    await pool.replenish(request(), contributions, "auth-1");
    pool.suspendGlobal();
    expect(pool.adopt(request(), contributions)).toBeNull();
    await pool.replenish(request(), contributions, "auth-1");
    expect(prepared).toHaveLength(1);
    pool.resumeGlobal();
    expect(pool.adopt(request(), contributions)).not.toBeNull();
  });

  it("cools down after a failed background admission instead of retrying immediately", async () => {
    prepareError = new Error("provider auth is stale");
    await pool.replenish(request(), contributions, "auth-1");
    prepareError = null;
    await pool.replenish(request(), contributions, "auth-1");
    expect(prepared).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await pool.replenish(request(), contributions, "auth-1");
    expect(prepared).toHaveLength(1);
  });

  it("evicts the oldest shape beyond the cap with a proven retirement", async () => {
    for (let index = 0; index < 4; index += 1) {
      await pool.replenish(
        request({ providerId: `provider-${index}` }),
        contributions,
        "auth-1",
      );
    }
    expect(pool.size()).toBe(3);
    expect(retired).toHaveLength(1);
    expect(
      pool.adopt(request({ providerId: "provider-0" }), contributions),
    ).toBeNull();
    expect(
      pool.adopt(request({ providerId: "provider-3" }), contributions),
    ).not.toBeNull();
  });

  it("reports warm authority for the engine's live-contribution checks", async () => {
    await pool.replenish(request(), contributions, "auth-1");
    expect(pool.territoryContributionSnapshots()).toEqual([contributions]);
    expect(pool.registeredDesignAuthorityChanged("auth-1")).toBe(false);
    expect(pool.registeredDesignAuthorityChanged("auth-2")).toBe(true);
  });

  it("retires a prepared spare rejected for stale authority metadata", async () => {
    const stale = fakeBoundary("stale-authority");
    Object.defineProperty(stale, "registeredDesignAuthorityIdentity", {
      value: "old-auth",
    });
    const retire = vi.fn(async (executionId: string) => {
      retired.push(executionId);
    });
    const stalePool = new WarmSessionBoundaryPool({
      prepare: async () => stale,
      retire,
    });

    await stalePool.replenish(request(), contributions, "current-auth");

    expect(retire).toHaveBeenCalledOnce();
    expect(stalePool.size()).toBe(0);
  });

  it("dispose retires everything and permanently refuses more work", async () => {
    await pool.replenish(request(), contributions, "auth-1");
    await pool.dispose();
    expect(retired).toHaveLength(1);
    await pool.replenish(request(), contributions, "auth-1");
    expect(prepared).toHaveLength(1);
    expect(pool.adopt(request(), contributions)).toBeNull();
  });
});
