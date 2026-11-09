import { describe, expect, it } from "vitest";

import type { DesignGpuWorkerReply, DesignGpuWorkerRequest } from "../gpu/design-gpu-protocol";
import { DESIGN_GPU_WORKER_HEAP_BYTES, DESIGN_GPU_WORKER_IDLE_MS, createDesignGpuRuntime } from "../gpu/design-gpu-runtime";
import type { DesignRecordingsSource } from "../gpu/design-recordings";

class FakeWorker extends EventTarget {
  readonly sent: DesignGpuWorkerRequest[] = [];
  terminated = false;
  postMessage(request: DesignGpuWorkerRequest) { this.sent.push(request); }
  terminate() { this.terminated = true; }
  reply(message: DesignGpuWorkerReply) { this.dispatchEvent(new MessageEvent("message", { data: message })); }
}

const source: DesignRecordingsSource = { read: () => new Promise(() => {}), render: () => new Promise(() => {}) };
const stats = (wasmHeapBytes: number) => ({ pictures: { count: 0, bytes: 0, budget: 0, evicted: 0 }, deserialize: [],
  raster: { sprite: [], tile: [] }, wasmHeapBytes, typefaces: { shared: 0, registered: 0, registeredBytes: 0 }, gpuCacheBytes: 0,
  contextLosses: 0 });

function harness() {
  const workers: FakeWorker[] = [];
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const runtime = createDesignGpuRuntime(source, () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; }, {
    setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true; },
  });
  return { runtime, workers, timers };
}

async function started(runtime: ReturnType<typeof harness>["runtime"], workers: FakeWorker[]) {
  const client = runtime.acquireClient();
  const ready = client.start();
  workers.at(-1)!.reply({ type: "ready", gpu: true, wasmHeapBytes: 1 });
  await ready;
  return client;
}

describe("Design GPU runtime", () => {
  it("retires a worker whose heap grew past its cap as soon as no canvas holds it", async () => {
    const { runtime, workers } = harness();
    await started(runtime, workers);
    runtime.releaseClient();
    const request = workers[0]!.sent.at(-1)! as Extract<DesignGpuWorkerRequest, { type: "stats" }>;
    expect(request.type).toBe("stats");
    workers[0]!.reply({ type: "stats", id: request.id, stats: stats(DESIGN_GPU_WORKER_HEAP_BYTES + 1) });
    await Promise.resolve();
    expect(workers[0]!.terminated).toBe(true);
    expect(runtime.client).toBeNull();
  });

  it("keeps a smaller worker for a quick return, then retires it after the idle delay", async () => {
    const { runtime, workers, timers } = harness();
    const client = await started(runtime, workers);
    runtime.releaseClient();
    const request = workers[0]!.sent.at(-1)! as Extract<DesignGpuWorkerRequest, { type: "stats" }>;
    workers[0]!.reply({ type: "stats", id: request.id, stats: stats(64 * 1024 * 1024) });
    await Promise.resolve();
    expect(workers[0]!.terminated).toBe(false);
    // A canvas that returns within the delay gets the same worker back.
    expect(runtime.acquireClient()).toBe(client);
    expect(timers[0]!.cleared).toBe(true);
    runtime.releaseClient();
    const idle = timers.at(-1)!;
    expect(idle.ms).toBe(DESIGN_GPU_WORKER_IDLE_MS);
    idle.callback();
    expect(workers[0]!.terminated).toBe(true);
    expect(runtime.client).toBeNull();
  });

  it("reports the recorded canvas unavailable once its raster worker fails, but not when one retires", async () => {
    const { runtime, workers, timers } = harness();
    const changes: Array<string | null> = [];
    runtime.subscribe(() => changes.push(runtime.unavailable));
    await started(runtime, workers);
    runtime.releaseClient();
    timers.at(-1)!.callback();
    expect(workers[0]!.terminated).toBe(true);
    expect(runtime.unavailable).toBeNull();
    // A worker whose CanvasKit fails to load can't draw anything: canvases
    // show pictures for the rest of the session instead of blank frames.
    const ready = runtime.acquireClient().start();
    workers[1]!.reply({ type: "failed", error: "CanvasKit failed to load." });
    await expect(ready).resolves.toBe(false);
    expect(runtime.unavailable).toBe("CanvasKit failed to load.");
    expect(runtime.stats.error).toBe("CanvasKit failed to load.");
    runtime.markUnavailable("WebGL2 is unavailable to the recorded Design canvas.");
    expect(runtime.unavailable).toBe("CanvasKit failed to load.");
    expect(changes).toEqual(["CanvasKit failed to load."]);
  });
});
