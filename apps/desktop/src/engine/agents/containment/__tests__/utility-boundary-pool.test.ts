import { describe, expect, it, vi } from "vitest";

import type { BoundaryRequest, PreparedBoundary } from "../types";
import {
  UtilityBoundaryPool,
  utilityBoundaryKey,
} from "../utility-boundary-pool";

function request(overrides: Partial<BoundaryRequest> = {}): BoundaryRequest {
  return {
    executionId: "one-shot-1",
    actor: "agent-code",
    providerId: "cursor",
    cwd: "/tmp/workspace",
    workspaceRoot: "/tmp/workspace",
    backendHint: "zeros-srt",
    ...overrides,
  } as BoundaryRequest;
}

function boundary(id: string): PreparedBoundary {
  return {
    generation: `gen-${id}`,
  } as unknown as PreparedBoundary;
}

function pool(overrides: {
  prepare?: (r: BoundaryRequest) => Promise<PreparedBoundary>;
  retire?: (id: string, b: PreparedBoundary) => Promise<void>;
  assertHealthy?: () => void;
  idleMs?: number;
}) {
  let created = 0;
  const prepared: BoundaryRequest[] = [];
  const retired: string[] = [];
  const instance = new UtilityBoundaryPool({
    prepare:
      overrides.prepare ??
      (async (r) => {
        prepared.push(r);
        created += 1;
        return boundary(String(created));
      }),
    retire:
      overrides.retire ??
      (async (id) => {
        retired.push(id);
      }),
    ...(overrides.assertHealthy
      ? { assertHealthy: overrides.assertHealthy }
      : {}),
    ...(overrides.idleMs !== undefined ? { idleMs: overrides.idleMs } : {}),
  });
  return { instance, prepared, retired, created: () => created };
}

describe("utilityBoundaryKey", () => {
  it("ignores executionId and key order but not any other input", () => {
    const left = utilityBoundaryKey(request({ executionId: "a" }));
    const right = utilityBoundaryKey(request({ executionId: "b" }));
    expect(left).toBe(right);

    const reordered = utilityBoundaryKey({
      backendHint: "zeros-srt",
      workspaceRoot: "/tmp/workspace",
      cwd: "/tmp/workspace",
      providerId: "cursor",
      actor: "agent-code",
      executionId: "c",
    } as BoundaryRequest);
    expect(reordered).toBe(left);

    expect(utilityBoundaryKey(request({ providerId: "codex" }))).not.toBe(left);
    expect(utilityBoundaryKey(request({ cwd: "/tmp/other" }))).not.toBe(left);
  });

  it("treats an absent field and an explicitly-undefined field as the same", () => {
    expect(utilityBoundaryKey(request({ providerResumeId: undefined }))).toBe(
      utilityBoundaryKey(request()),
    );
  });
});

describe("UtilityBoundaryPool", () => {
  it("admits once for identical requests and retires at dispose", async () => {
    const { instance, retired, created } = pool({});

    const first = await instance.acquire(request({ executionId: "probe-1" }));
    expect(first.reused).toBe(false);
    expect(first.executionId).toBe("probe-1");
    await first.release("ok");

    const second = await instance.acquire(request({ executionId: "probe-2" }));
    expect(second.reused).toBe(true);
    // The pooled boundary keeps the id of the call that created it, so logs and
    // session directories still name real work.
    expect(second.executionId).toBe("probe-1");
    await second.release("ok");

    expect(created()).toBe(1);
    expect(retired).toEqual([]);

    await instance.disposeAll();
    expect(retired).toEqual(["probe-1"]);
  });

  it("keeps separate boundaries for requests that differ at all", async () => {
    const { instance, created } = pool({});
    const cursor = await instance.acquire(request({ providerId: "cursor" }));
    await cursor.release("ok");
    const codex = await instance.acquire(
      request({ providerId: "codex", executionId: "probe-codex" }),
    );
    await codex.release("ok");
    expect(created()).toBe(2);
    expect(codex.reused).toBe(false);
  });

  it("retires immediately after a failed operation and admits fresh next time", async () => {
    const { instance, retired, created } = pool({});
    const first = await instance.acquire(request({ executionId: "title-1" }));
    await first.release("failed");
    expect(retired).toEqual(["title-1"]);

    const second = await instance.acquire(request({ executionId: "title-2" }));
    expect(second.reused).toBe(false);
    expect(created()).toBe(2);
    await second.release("ok");
    await instance.disposeAll();
  });

  it("serializes leases for the same key", async () => {
    const { instance, created } = pool({});
    const order: string[] = [];
    const first = await instance.acquire(request());
    let secondLeased = false;
    const secondFlight = instance.acquire(request()).then(async (lease) => {
      secondLeased = true;
      order.push("second");
      await lease.release("ok");
    });
    await Promise.resolve();
    expect(secondLeased).toBe(false);
    order.push("first");
    await first.release("ok");
    await secondFlight;
    expect(order).toEqual(["first", "second"]);
    expect(created()).toBe(1);
    await instance.disposeAll();
  });

  it("coalesces identical admissions that begin before the first prepare finishes", async () => {
    let finishPrepare!: (value: PreparedBoundary) => void;
    const prepare = vi.fn(
      () =>
        new Promise<PreparedBoundary>((resolve) => {
          finishPrepare = resolve;
        }),
    );
    const { instance } = pool({ prepare });

    const firstFlight = instance.acquire(
      request({ executionId: "concurrent-first" }),
    );
    const secondFlight = instance.acquire(
      request({ executionId: "concurrent-second" }),
    );
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    finishPrepare(boundary("coalesced"));

    const first = await firstFlight;
    let secondSettled = false;
    void secondFlight.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    await first.release("ok");
    const second = await secondFlight;
    expect(second.reused).toBe(true);
    expect(second.executionId).toBe("concurrent-first");
    expect(prepare).toHaveBeenCalledOnce();
    await second.release("ok");
    await instance.disposeAll();
  });

  it("retires an idle boundary once its idle window elapses", async () => {
    vi.useFakeTimers();
    try {
      const { instance, retired } = pool({ idleMs: 50 });
      const lease = await instance.acquire(request({ executionId: "idle-1" }));
      await lease.release("ok");
      expect(retired).toEqual([]);
      await vi.advanceTimersByTimeAsync(60);
      expect(retired).toEqual(["idle-1"]);
      expect(instance.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a busy boundary before disposeAll returns", async () => {
    const { instance, retired } = pool({});
    const lease = await instance.acquire(
      request({ executionId: "busy-territory" }),
    );

    await instance.disposeAll();

    expect(retired).toEqual(["busy-territory"]);
    await lease.release("ok");
    expect(instance.size()).toBe(0);
  });

  it("invalidates an admission that finishes after disposeAll and reopen", async () => {
    let finishPrepare!: (value: PreparedBoundary) => void;
    const prepare = vi.fn(
      () =>
        new Promise<PreparedBoundary>((resolve) => {
          finishPrepare = resolve;
        }),
    );
    const retire = vi.fn(async () => undefined);
    const { instance } = pool({ prepare, retire });
    const acquiring = instance.acquire(
      request({ executionId: "crossed-transition" }),
    );
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());

    await instance.disposeAll();
    instance.reopen();
    const prepared = boundary("crossed-transition");
    finishPrepare(prepared);

    await expect(acquiring).rejects.toThrow(/invalidated.*transition/i);
    expect(retire).toHaveBeenCalledWith("crossed-transition", prepared);
    expect(instance.size()).toBe(0);
  });

  it("refuses to admit while boundary retirement is unhealthy", async () => {
    const { instance } = pool({
      assertHealthy: () => {
        throw new Error(
          "a prior execution boundary could not be proven stopped",
        );
      },
    });
    await expect(instance.acquire(request())).rejects.toThrow(
      /could not be proven stopped/,
    );
  });

  it("drops an entry whose teardown could not be proven instead of reusing it", async () => {
    const attempts: string[] = [];
    const { instance, created } = pool({
      idleMs: 10,
      retire: async (id) => {
        attempts.push(id);
        throw new Error("stop proof rejected");
      },
    });
    const lease = await instance.acquire(request({ executionId: "bad-1" }));
    // An unprovable teardown still surfaces, exactly as it did per call.
    await expect(lease.release("failed")).rejects.toThrow(
      /stop proof rejected/,
    );
    expect(attempts).toEqual(["bad-1"]);
    // Not reused: the next acquire admits a new boundary rather than handing out
    // one whose process domain was never proven empty.
    const next = await instance.acquire(request({ executionId: "bad-2" }));
    expect(next.reused).toBe(false);
    expect(created()).toBe(2);
  });
});
