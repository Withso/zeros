import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimAgentPrewarmForEngineSession,
  prewarmAgentOnce,
  resetAgentPrewarmForEngineSession,
} from "../agent-prewarm-singleflight";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("agent prewarm single-flight", () => {
  afterEach(() => resetAgentPrewarmForEngineSession());

  it("retains the engine-session claim across a renderer module reload", async () => {
    expect(claimAgentPrewarmForEngineSession()).toBe(true);

    vi.resetModules();
    const reloaded = await import("../agent-prewarm-singleflight");

    expect(reloaded.claimAgentPrewarmForEngineSession()).toBe(false);
    reloaded.resetAgentPrewarmForEngineSession();
  });

  it("shares overlapping warmups for the same provider", async () => {
    const pending = deferred<void>();
    const initialize = vi.fn(() => pending.promise);

    const first = prewarmAgentOnce("cursor", initialize);
    const second = prewarmAgentOnce("cursor", initialize);

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    pending.resolve();
    await Promise.all([first, second]);
  });

  it("does not serialize different providers", async () => {
    const initialize = vi.fn(async (_agentId: string) => undefined);

    await Promise.all([
      prewarmAgentOnce("claude", initialize),
      prewarmAgentOnce("codex", initialize),
      prewarmAgentOnce("cursor", initialize),
    ]);

    expect(initialize.mock.calls.map(([agentId]) => agentId).sort()).toEqual([
      "claude",
      "codex",
      "cursor",
    ]);
  });

  it("allows a retry after the shared warmup settles", async () => {
    const initialize = vi.fn(async () => undefined);

    await prewarmAgentOnce("codex", initialize);
    await prewarmAgentOnce("codex", initialize);

    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh-engine warmup without an old promise clearing it", async () => {
    const oldEngine = deferred<void>();
    const newEngine = deferred<void>();
    const initialize = vi
      .fn<(_agentId: string) => Promise<void>>()
      .mockReturnValueOnce(oldEngine.promise)
      .mockReturnValueOnce(newEngine.promise);

    void prewarmAgentOnce("claude", initialize);
    resetAgentPrewarmForEngineSession();
    const current = prewarmAgentOnce("claude", initialize);
    oldEngine.resolve();
    await oldEngine.promise;
    const overlapping = prewarmAgentOnce("claude", initialize);

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(overlapping).toBe(current);

    newEngine.resolve();
    await Promise.all([current, overlapping]);
  });

  it("clears a rejected warmup so focus can retry", async () => {
    const initialize = vi
      .fn<(_agentId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("engine restarted"))
      .mockResolvedValueOnce(undefined);

    await expect(prewarmAgentOnce("cursor", initialize)).rejects.toThrow(
      "engine restarted",
    );
    await expect(prewarmAgentOnce("cursor", initialize)).resolves.toBeUndefined();

    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
