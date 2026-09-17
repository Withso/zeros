import { afterEach, describe, expect, it, vi } from "vitest";
import { DesignBackgroundWorkQueue } from "../state/design-background-work";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("design background work", () => {
  it("makes bounded progress when the browser never offers an idle period", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      requestIdleCallback: (callback: () => void, options?: { timeout: number }) => setTimeout(callback, options?.timeout ?? 3_600_000),
      cancelIdleCallback: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
    const queue = new DesignBackgroundWorkQueue(4, 0);
    const work = vi.fn(async () => "captured");
    const result = queue.schedule("workspace/frame", work);
    await vi.advanceTimersByTimeAsync(999);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toBe("captured");
    queue.reset();
  });
  it("keeps only the latest queued owner and does not rasterize during a gesture", async () => {
    vi.useFakeTimers();
    const queue = new DesignBackgroundWorkQueue(4, 150);
    const resume = queue.pause();
    const calls: string[] = [];
    const work = (value: string) => async () => {
      calls.push(value);
      return value;
    };
    const old = queue.schedule("workspace-a/frame", work("a-old"));
    const b = queue.schedule("workspace-b/frame", work("b"));
    const newest = queue.schedule("workspace-a/frame", work("a-new"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([]);
    await expect(old).resolves.toBeNull();
    resume();
    resume();
    await vi.advanceTimersByTimeAsync(149);
    expect(calls).toEqual([]);
    await vi.runAllTimersAsync();
    expect(calls).toEqual(["b", "a-new"]);
    await expect(b).resolves.toBe("b");
    await expect(newest).resolves.toBe("a-new");
    queue.reset();
  });

  it("bounds pending work, releases superseded callers, and drains after a failure", async () => {
    vi.useFakeTimers();
    const queue = new DesignBackgroundWorkQueue(4, 0);
    const resume = queue.pause();
    const promises = Array.from({ length: 20 }, (_, i) =>
      queue.schedule(String(i), async () => i),
    );
    resume();
    await vi.runAllTimersAsync();
    expect(await Promise.all(promises)).toEqual([
      ...Array(16).fill(null),
      16,
      17,
      18,
      19,
    ]);
    const failed = queue
      .schedule("bad", async () => {
        throw new Error("raster failed");
      })
      .catch((error: Error) => error.message);
    const valid = queue.schedule("good", async () => "ready");
    await vi.runAllTimersAsync();
    expect(await failed).toBe("raster failed");
    expect(await valid).toBe("ready");
    queue.reset();
  });
});
