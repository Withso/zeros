import { describe, expect, it, vi } from "vitest";
import { acquireDesignSourceVectorImage, DesignSourceVectorBudget, DesignSourceVectorCache, type DesignSourceVectorTarget } from "../design-source-vector";

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Frame</text></svg>';
const target: DesignSourceVectorTarget = { workspaceId: "personal-local", folder: "/work/personal", directoryId: "design-one",
  capability: "a".repeat(64), file: "page/frame.html", sourceVersion: "b".repeat(24), theme: null, width: 560, height: 360 };
function setup(bytes = svg.length * 4, maxEntries = 2048) {
  let now = 0;
  const revoke = vi.fn(); let id = 0;
  const budget = new DesignSourceVectorBudget(bytes, { create: () => `blob:${++id}`, revoke });
  const cache = new DesignSourceVectorCache(budget, { now: () => now, maxEntries });
  const save = (input = target) => {
    const request = cache.open(input);
    const lease = request.publish(svg)!;
    lease.confirm(); lease.release(); request.close();
    return lease.url;
  };
  return { cache, budget, revoke, save, time: (value: number) => { now = value; } };
}

describe("completed Design source cache", () => {
  it("inspects a displayed image's exact authority without acquiring or renewing a cache lease", () => {
    const { cache, budget, time } = setup();
    const request = cache.open(target), lease = request.publish(svg)!;
    const image = { isConnected: false, removeAttribute: vi.fn() } as unknown as HTMLImageElement;
    expect(cache.hasDisplayedImage(target, image)).toBe(false);
    lease.confirm(image);
    const before = { cache: cache.usage(), budget: budget.usage() };
    expect(cache.hasDisplayedImage(target, image)).toBe(true);
    for (const delta of [{ workspaceId: "organization-local" }, { workspaceId: "cloud://org/workspace" },
      { folder: "/work/other" }, { directoryId: "other" }, { capability: "c".repeat(64) },
      { file: "page/other.html" }, { sourceVersion: "c".repeat(24) }])
      expect(cache.hasDisplayedImage({ ...target, ...delta }, image)).toBe(false);
    expect(cache.hasDisplayedImage(target, { ...image } as HTMLImageElement)).toBe(false);
    expect({ cache: cache.usage(), budget: budget.usage() }).toEqual(before);
    lease.release(); request.close();
    time(23 * 60 * 60_000);
    expect(cache.hasDisplayedImage(target, image)).toBe(false);
    time(25 * 60 * 60_000);
    const expired = cache.open(target);
    expect(expired.cached).toBeNull(); expired.close();
  });

  it("does not qualify a displayed image after its authority is retired", () => {
    const { cache } = setup();
    const request = cache.open(target), lease = request.publish(svg)!;
    const image = { isConnected: false, removeAttribute: vi.fn() } as unknown as HTMLImageElement;
    lease.confirm(image);
    cache.forgetWorkspaces([target.workspaceId]);
    expect(cache.hasDisplayedImage(target, image)).toBe(false);
    lease.release(); request.close();
  });

  it("does not lend a disconnected GPU source to a second display or replace its cached identity", () => {
    const { cache } = setup();
    const request = cache.open(target), vector = request.publish(svg)!;
    const original = { isConnected: false, removeAttribute: vi.fn() } as unknown as HTMLImageElement;
    const duplicate = { isConnected: false, removeAttribute: vi.fn() } as unknown as HTMLImageElement;
    vector.confirm(original);
    const create = vi.fn(() => duplicate);
    const first = acquireDesignSourceVectorImage(vector, create);
    const other = cache.open(target), second = acquireDesignSourceVectorImage(other.cached!, create);
    expect(first.image).toBe(original);
    expect(second.image).toBe(duplicate);
    expect(create).toHaveBeenCalledTimes(1);
    other.cached!.confirm(second.image);
    expect(vector.image).toBe(original);
    second.release(); other.cached!.release(); other.close();
    first.release(); first.release(); vector.release(); request.close();
    const back = cache.open(target), returning = acquireDesignSourceVectorImage(back.cached!, create);
    expect(returning.image).toBe(original);
    expect(create).toHaveBeenCalledTimes(1);
    returning.release(); back.cached!.release(); back.close();
  });

  it("reuses completed pixels across unmount and Personal → organization → Personal without a source load", () => {
    const { cache, save, revoke } = setup();
    const url = save();
    save({ ...target, workspaceId: "organization-local", folder: "/work/organization" });
    const back = cache.open(target);
    expect(back.cached?.url).toBe(url);
    expect(revoke).not.toHaveBeenCalled();
    back.cached!.release(); back.close();
    expect(cache.usage()).toMatchObject({ entries: 2, leases: 0, requests: 0 });
  });

  it.each([
    { workspaceId: "organization-local" }, { folder: "/work/replacement" }, { directoryId: "design-two" },
    { capability: "c".repeat(64) }, { file: "other/frame.html" }, { sourceVersion: "c".repeat(24) },
    { theme: "dark" }, { width: 640 }, { height: 480 },
  ])("does not reuse a different authority or render identity: %j", delta => {
    const { cache, save } = setup(); save();
    const request = cache.open({ ...target, ...delta });
    expect(request.cached).toBeNull(); request.close();
  });

  it("keeps warm source for 24 idle hours, renews on use, and expires lazily without timers", () => {
    const { cache, save, time, revoke } = setup(); const url = save();
    time(23 * 60 * 60_000);
    const warm = cache.open(target); expect(warm.cached?.url).toBe(url);
    warm.cached!.release(); warm.close();
    time(46 * 60 * 60_000);
    const stillWarm = cache.open(target); expect(stillWarm.cached?.url).toBe(url);
    stillWarm.cached!.release(); stillWarm.close();
    time(71 * 60 * 60_000);
    const cold = cache.open(target); expect(cold.cached).toBeNull(); cold.close();
    expect(revoke).toHaveBeenCalledWith(url);
  });

  it("evicts unleased LRU source under byte pressure without revoking displayed pixels", () => {
    const { cache, save, budget, revoke } = setup(svg.length * 2);
    const a = save(); const pinned = cache.open(target);
    const other = { ...target, file: "page/other.html" };
    const b = save(other); save({ ...target, file: "page/third.html" });
    expect(budget.usage()).toEqual({ entries: 2, bytes: svg.length * 2 });
    expect(revoke).toHaveBeenCalledWith(b); expect(revoke).not.toHaveBeenCalledWith(a);
    pinned.cached!.release(); pinned.close();
  });

  it("bounds metadata even for tiny SVGs and drops replaced generations once the old display releases", () => {
    const { cache, save, budget, revoke } = setup(svg.length * 10, 2);
    const a = save(); const old = cache.open(target);
    const next = { ...target, sourceVersion: "d".repeat(24) };
    const b = save(next);
    expect(revoke).not.toHaveBeenCalledWith(a);
    old.cached!.release(); old.close();
    expect(revoke).toHaveBeenCalledWith(a);
    save({ ...next, file: "page/b.html" }); save({ ...next, file: "page/c.html" });
    expect(budget.usage().entries).toBe(2); expect(revoke).toHaveBeenCalledWith(b);
    expect(cache.usage().entries).toBe(2);
  });

  it("never warms an uncommitted or failed decode and cannot resurrect a removed workspace", () => {
    const { cache, budget } = setup();
    const pending = cache.open(target); const lease = pending.publish(svg)!;
    lease.release(); pending.close();
    expect(budget.usage().entries).toBe(0);
    const late = cache.open(target);
    cache.forgetWorkspaces([target.workspaceId]);
    expect(late.publish(svg)).toBeNull(); late.close();
    expect(budget.usage().entries).toBe(0);
    const failed = cache.open(target); const failedLease = failed.publish(svg)!;
    failedLease.confirm(); failedLease.invalidate(); failedLease.release(); failed.close();
    const retry = cache.open(target); expect(retry.cached).toBeNull(); retry.close();
  });

  it("prunes removed frames and replaced checkouts, fences late publication, and leaves other owners alone", () => {
    const { cache, save, budget } = setup(); save();
    const other = { ...target, workspaceId: "org-local", folder: "/work/org" }; const url = save(other);
    const late = cache.open({ ...target, file: "deleted.html" });
    cache.reconcile(target, new Set([target.file]));
    expect(late.publish(svg)).toBeNull(); late.close();
    cache.reconcile({ ...target, folder: "/work/moved" }, new Set([target.file]));
    const old = cache.open(target); expect(old.cached).toBeNull(); old.close();
    const org = cache.open(other); expect(org.cached?.url).toBe(url); org.cached!.release(); org.close();
    expect(budget.usage().entries).toBe(1);
  });

  it("does not allocate Local source content for a cloud workspace", () => {
    const { cache, budget } = setup();
    const cloud = cache.open({ ...target, workspaceId: "cloud://org/workspace" });
    expect(cloud.cached).toBeNull(); expect(cloud.publish(svg)).toBeNull(); cloud.close();
    expect(budget.usage().entries).toBe(0);
  });

  it("keeps completed sibling directories when one directory publishes its authoritative membership", () => {
    const { cache, save, budget } = setup();
    const first = save();
    const sibling = { ...target, directoryId: "design-two" };
    const second = save(sibling);
    cache.reconcile(sibling, new Set([sibling.file]));
    cache.reconcile(target, new Set([target.file]));
    const back = cache.open(target);
    expect(back.cached?.url).toBe(first);
    back.cached?.release(); back.close();
    cache.reconcile(target, new Set());
    const other = cache.open(sibling);
    expect(other.cached?.url).toBe(second);
    other.cached?.release(); other.close();
    expect(budget.usage().entries).toBe(1);
  });

  it("bounds loaded warm elements separately, yields them under pressure and keeps encoded source", async () => {
    const budget = new DesignSourceVectorBudget(svg.length * 8, { create: vi.fn(() => "blob:frame"), revoke: vi.fn() });
    const cache = new DesignSourceVectorCache(budget, { maxImages: 1, maxImageBytes: svg.length * 8 });
    const elements = [0, 1].map(() => ({ isConnected: false, removeAttribute: vi.fn() }) as unknown as HTMLImageElement);
    for (const [index, element] of elements.entries()) {
      const request = cache.open({ ...target, file: `${index}.html` }); const lease = request.publish(svg)!;
      lease.confirm(element); lease.release(); request.close();
    }
    await Promise.resolve();
    expect(elements[0].removeAttribute).toHaveBeenCalledWith("src");
    expect(elements[1].removeAttribute).not.toHaveBeenCalled();
    expect(cache.usage()).toMatchObject({ entries: 2, warmImages: 1, warmImageEstimatedBytes: svg.length * 8 });
    const displayed = cache.open({ ...target, file: "1.html" });
    cache.clearWarmImages(); expect(displayed.cached?.image).toBe(elements[1]);
    displayed.cached!.release(); displayed.close(); cache.clearWarmImages(); await Promise.resolve();
    expect(elements[1].removeAttribute).toHaveBeenCalledWith("src");
    const restored = cache.open({ ...target, file: "1.html" });
    expect(restored.cached).not.toBeNull(); expect(restored.cached!.image).toBeNull(); restored.cached!.release(); restored.close();
    expect(budget.usage().entries).toBe(2);
  });

  it.each([3, 10])("charges newly displayed images against retained images before navigation can double a pool capped at %i entries", async maxImages => {
    const budget = new DesignSourceVectorBudget(svg.length * 8, { create: vi.fn(() => "blob:frame"), revoke: vi.fn() });
    const cache = new DesignSourceVectorCache(budget, { maxImages, maxImageBytes: svg.length * 8 * 3 });
    const elements = Array.from({ length: 5 }, () => ({ isConnected: false, removeAttribute: vi.fn() }) as unknown as HTMLImageElement);
    const display = (index: number) => {
      const request = cache.open({ ...target, file: `${index}.html` });
      const lease = request.publish(svg)!;
      lease.confirm(elements[index]);
      return () => { lease.release(); request.close(); };
    };
    for (let i = 0; i < 3; i++) display(i)();
    const closeA = display(3), closeB = display(4);
    await Promise.resolve();
    expect(elements[0].removeAttribute).toHaveBeenCalledWith("src");
    expect(elements[1].removeAttribute).toHaveBeenCalledWith("src");
    for (const element of elements.slice(2)) expect(element.removeAttribute).not.toHaveBeenCalled();
    // Eviction retires only the loaded DOM; the exact-generation source is
    // still cached, and neither displayed consumer loses its pixels.
    const revisit = cache.open({ ...target, file: "0.html" });
    expect(revisit.cached).not.toBeNull();
    expect(revisit.cached!.image).toBeNull();
    revisit.cached!.release(); revisit.close(); closeA(); closeB();
    expect(cache.usage()).toMatchObject({ entries: 5, warmImages: 3, images: 3, imageEstimatedBytes: svg.length * 8 * 3, leases: 0 });
  });

  it("preserves both complete 256-frame owners within the shared loaded pool", () => {
    const budget = new DesignSourceVectorBudget(svg.length * 512, { create: vi.fn(() => "blob:frame"), revoke: vi.fn() });
    const cache = new DesignSourceVectorCache(budget);
    const images: HTMLImageElement[] = [];
    const show = (workspaceId: string) => Array.from({ length: 256 }, (_, i) => {
      const request = cache.open({ ...target, workspaceId, folder: `/work/${workspaceId}`, file: `${i}.html` });
      const lease = request.cached ?? request.publish(svg)!;
      if (!lease.image) {
        const image = { isConnected: false, removeAttribute: vi.fn() } as unknown as HTMLImageElement;
        images.push(image); lease.confirm(image);
      }
      return () => { lease.release(); request.close(); };
    });
    show("personal-local").forEach(close => close());
    show("organization-local").forEach(close => close());
    const returned = show("personal-local");
    expect(images).toHaveLength(512);
    for (const image of images) expect(image.removeAttribute).not.toHaveBeenCalled();
    returned.forEach(close => close());
  });

  it("never removes an active image to meet the pool budget and retires it when its last display releases", async () => {
    const budget = new DesignSourceVectorBudget(svg.length * 4, { create: vi.fn(() => "blob:frame"), revoke: vi.fn() });
    const cache = new DesignSourceVectorCache(budget, { maxImages: 1 });
    const images = [0, 1].map(() => ({ isConnected: false, removeAttribute: vi.fn() }) as unknown as HTMLImageElement);
    const displayed = images.map((image, i) => {
      const request = cache.open({ ...target, file: `${i}.html` });
      const lease = request.publish(svg)!;
      lease.confirm(image);
      return { lease, request };
    });
    await Promise.resolve();
    for (const image of images) expect(image.removeAttribute).not.toHaveBeenCalled();
    expect(cache.usage()).toMatchObject({ images: 2, leases: 2, warmImages: 0 });
    displayed[0].lease.release(); displayed[0].request.close();
    await Promise.resolve();
    expect(images[0].removeAttribute).toHaveBeenCalledWith("src");
    expect(images[1].removeAttribute).not.toHaveBeenCalled();
    expect(cache.usage()).toMatchObject({ images: 1, leases: 1 });
    displayed[1].lease.release(); displayed[1].request.close();
  });

  it("a late old image load cannot retire the incoming generation or undo explicit removal", () => {
    const { cache, save } = setup(); save();
    const old = cache.open(target);
    const next = cache.open({ ...target, sourceVersion: "d".repeat(24) }); const incoming = next.publish(svg)!;
    old.cached!.confirm(); incoming.confirm();
    old.cached!.release(); old.close(); incoming.release(); next.close();
    const hit = cache.open({ ...target, sourceVersion: "d".repeat(24) }); expect(hit.cached).not.toBeNull();
    cache.forgetWorkspaces([target.workspaceId]); hit.cached!.confirm(); hit.cached!.release(); hit.close();
    expect(cache.usage().entries).toBe(0);
  });
});
