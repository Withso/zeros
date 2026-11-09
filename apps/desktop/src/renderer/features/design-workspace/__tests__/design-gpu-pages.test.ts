import { describe, expect, it } from "vitest";

import { DesignGpuPages, designGpuUnitKey, type DesignGpuTextures } from "../gpu/design-gpu-pages";
import type { DesignGpuWorkerReply, DesignGpuWorkerRequest } from "../gpu/design-gpu-protocol";
import { DesignGpuWorkerClient } from "../gpu/design-gpu-worker-client";

function textures() {
  let next = 1;
  const live = new Set<number>();
  const backend: DesignGpuTextures<number> & { lost: boolean } = {
    lost: false,
    upload: () => { if (backend.lost) return null; const id = next++; live.add(id); return id; },
    release: (texture) => { live.delete(texture); },
  };
  return { backend, live };
}
const unit = (content: number, density: number, col = 0, row = 0) =>
  ({ key: designGpuUnitKey(content, density, col, row), content, density, src: { x: 0, y: 0, width: 10, height: 10 } });

describe("Design GPU pages", () => {
  it("reclaims whole least-recently-drawn pages beyond the budget, never one drawn in the current composite", () => {
    const { backend, live } = textures();
    // Each 64×64 page is 16 KiB; two fit.
    const pages = new DesignGpuPages(backend, 2 * 64 * 64 * 4);
    pages.beginFrame();
    const first = pages.adopt({}, 64, 64, [unit(1, 1), unit(2, 1)])!;
    const second = pages.adopt({}, 64, 64, [unit(3, 1)])!;
    pages.beginFrame();
    pages.touch(first);
    pages.adopt({}, 64, 64, [unit(4, 1)]);
    // The second page was not drawn this frame; it goes, with its unit.
    expect(pages.unit(designGpuUnitKey(3, 1, 0, 0))).toBeUndefined();
    expect(live.has(second.texture)).toBe(false);
    expect(pages.unit(designGpuUnitKey(1, 1, 0, 0))?.page).toBe(first);
    expect(pages.usage()).toMatchObject({ pages: 2, units: 3, evictedPages: 1 });
    // Every page is in use: the composite may run over budget, never lose pixels.
    pages.beginFrame();
    for (const key of [designGpuUnitKey(1, 1, 0, 0), designGpuUnitKey(4, 1, 0, 0)]) pages.touch(pages.unit(key)!.page);
    pages.adopt({}, 64, 64, [unit(5, 1)]);
    expect(pages.usage().pages).toBe(3);
  });

  it("indexes densities per content and replaces a re-rastered unit in place", () => {
    const { backend, live } = textures();
    const pages = new DesignGpuPages(backend);
    pages.beginFrame();
    const coarse = pages.adopt({}, 32, 32, [unit(7, 0.5)])!;
    pages.adopt({}, 32, 32, [unit(7, 1, 0, 0), unit(7, 1, 1, 0)]);
    expect([...pages.densitiesOf(7)].sort()).toEqual([0.5, 1]);
    const again = pages.adopt({}, 32, 32, [unit(7, 0.5)])!;
    expect(pages.unit(designGpuUnitKey(7, 0.5, 0, 0))?.page).toBe(again);
    // The emptied page released its texture at once.
    expect(live.has(coarse.texture)).toBe(false);
    pages.forget(7);
    expect([...pages.densitiesOf(7)]).toEqual([]);
    expect(pages.usage()).toMatchObject({ pages: 0, units: 0, bytes: 0 });
  });

  it("drops every page after a lost context without touching the dead textures", () => {
    const { backend, live } = textures();
    const pages = new DesignGpuPages(backend);
    pages.beginFrame();
    pages.adopt({}, 32, 32, [unit(1, 1)]);
    backend.lost = true;
    pages.clear(false);
    expect(pages.usage()).toMatchObject({ pages: 0, units: 0, bytes: 0 });
    expect(live.size).toBe(1);
    expect(pages.adopt({}, 32, 32, [unit(1, 1)])).toBeNull();
    backend.lost = false;
    expect(pages.adopt({}, 32, 32, [unit(1, 1)])).not.toBeNull();
  });
});

/** A worker the test answers by hand. */
class FakeWorker extends EventTarget {
  readonly sent: DesignGpuWorkerRequest[] = [];
  terminated = false;
  postMessage(request: DesignGpuWorkerRequest) { this.sent.push(request); }
  terminate() { this.terminated = true; }
  reply(message: DesignGpuWorkerReply) { this.dispatchEvent(new MessageEvent("message", { data: message })); }
  crash() { this.dispatchEvent(Object.assign(new Event("error"), { message: "worker crashed" })); }
}

describe("Design GPU worker client", () => {
  it("mirrors the worker's pictures, and fails every waiting job when the worker dies", async () => {
    const worker = new FakeWorker();
    const client = new DesignGpuWorkerClient(() => worker as unknown as Worker);
    const started = client.start();
    expect(worker.sent[0]).toMatchObject({ type: "init" });
    worker.reply({ type: "ready", gpu: true, wasmHeapBytes: 1 });
    await expect(started).resolves.toBe(true);
    client.putPictures([{ key: "a", scale: 2, width: 10, height: 10, layers: [{ x: 0, y: 0, bytes: new ArrayBuffer(4) }] }]);
    expect(client.resident.has("a")).toBe(true);
    worker.reply({ type: "pictures", added: [], failed: [{ key: "a", error: "unsupported" }], evicted: [] });
    expect(client.resident.has("a")).toBe(false);
    expect(client.unreadable.get("a")).toBe("unsupported");
    const losses: boolean[] = [];
    client.onContext((lost) => losses.push(lost));
    worker.reply({ type: "context", lost: true });
    expect(losses).toEqual([true]);
    const job = client.raster(64, 64, [], 6);
    const stats = client.requestStats();
    worker.crash();
    await expect(job).rejects.toThrow("worker crashed");
    await expect(stats).resolves.toBeNull();
    await expect(client.raster(64, 64, [], 6)).rejects.toThrow("worker crashed");
    client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("tells listeners about unreadable pictures and a failure, but a disposed worker has not failed", async () => {
    const worker = new FakeWorker();
    const client = new DesignGpuWorkerClient(() => worker as unknown as Worker);
    const unreadable: string[][] = [], failures: string[] = [];
    client.onUnreadable(() => unreadable.push([...client.unreadable.keys()]));
    client.onFailure((error) => failures.push(error));
    const started = client.start();
    worker.reply({ type: "ready", gpu: true, wasmHeapBytes: 1 });
    await started;
    worker.reply({ type: "pictures", added: [], failed: [{ key: "a", error: "unsupported" }], evicted: [] });
    worker.reply({ type: "pictures", added: ["b"], failed: [], evicted: [] });
    expect(unreadable).toEqual([["a"]]);
    client.dispose();
    expect(failures).toEqual([]);
    const crashing = new FakeWorker();
    const other = new DesignGpuWorkerClient(() => crashing as unknown as Worker);
    other.onFailure((error) => failures.push(error));
    void other.start();
    crashing.crash();
    crashing.crash();
    expect(failures).toEqual(["worker crashed"]);
  });
});
