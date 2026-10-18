// Regression: switching a provider's API key, CLI login or account fires a
// forced registry refresh. When a load had already started before the change,
// the refresh joined it and published that stale verdict, so the composer's
// pre-send check said "Sign-in required" for a connection that was fine.

import { describe, expect, it, vi } from "vitest";

import type { BridgeRegistryAgent } from "../../../platform/bridge/messages";
import { getAgentsSnapshot, loadAgents, refreshAgents } from "../agents-cache";

const claude = (authenticated: boolean): BridgeRegistryAgent =>
  ({ id: "claude", name: "Claude", installed: true, authenticated }) as unknown as BridgeRegistryAgent;

describe("agents cache — refresh after a credential change", () => {
  it("answers a forced refresh with a load that starts after the request", async () => {
    let finishStale!: (agents: BridgeRegistryAgent[]) => void;
    const stale = loadAgents(
      () => new Promise((resolve) => { finishStale = resolve; }),
    );
    // The credential change lands while that load is still running.
    const current = vi.fn(async () => [claude(true)]);
    const first = refreshAgents(current);
    const second = refreshAgents(current);
    finishStale([claude(false)]);
    await expect(stale).resolves.toEqual([claude(false)]);
    await expect(first).resolves.toEqual([claude(true)]);
    await expect(second).resolves.toEqual([claude(true)]);
    // Both requests share one trailing load.
    expect(current).toHaveBeenCalledOnce();
    expect(current).toHaveBeenCalledWith(true);
    expect(getAgentsSnapshot()).toEqual([claude(true)]);
  });

  it("still runs the trailing load when the earlier one fails", async () => {
    let failStale!: (error: Error) => void;
    const stale = refreshAgents(
      () => new Promise((_, reject) => { failStale = reject; }),
    );
    const refreshed = refreshAgents(async () => [claude(true)]);
    failStale(new Error("engine swapping"));
    await expect(stale).rejects.toThrow("engine swapping");
    await expect(refreshed).resolves.toEqual([claude(true)]);
  });

  it("starts immediately when nothing is in flight", async () => {
    const load = vi.fn(async () => [claude(false)]);
    await expect(refreshAgents(load)).resolves.toEqual([claude(false)]);
    expect(load).toHaveBeenCalledOnce();
  });
});
