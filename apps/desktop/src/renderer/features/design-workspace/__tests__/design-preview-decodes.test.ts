import { describe, expect, it, vi } from "vitest";
import { DesignPreviewDecodes } from "../state/design-preview-decodes";
import { DesignPreviewCache, type DesignPreviewBlobImage } from "../state/design-preview-cache";
import { DesignImageResidency } from "../state/design-image-residency";
import { designPreviewKey, type DesignPreviewPicture, type DesignPreviewTarget } from "../state/design-frame-previews";

const target = (file = "a.html", workspaceId = "/personal/a"): DesignPreviewTarget => ({
  owner: { scope: "local", workspaceId, directoryId: "design" }, file, sourceVersion: "v1", theme: null, level: "thumbnail",
});

function setup(maxWarmBytes = 256, maxDecodedBytes = 1024, now = Date.now) {
  const budget = new DesignImageResidency(maxDecodedBytes);
  const memory = new DesignPreviewCache<DesignPreviewBlobImage>({ maxEntries: 100, maxEncodedBytes: 1024, maxDecodedBytes }, {}, budget);
  const calls: { picture: DesignPreviewPicture; signal: AbortSignal; resolve(image: { dispose(): void }): void; reject(error: Error): void }[] = [];
  const confirmed = vi.fn();
  const previews = new DesignPreviewDecodes({
    hasPicture: (input) => memory.has(designPreviewKey(input)),
    acquire: (input, accept) => {
      const key = designPreviewKey(input);
      const picture: DesignPreviewPicture = { key, url: `blob:${key}`, width: 4, height: 4,
        sourceVersion: input.sourceVersion, level: input.level, current: true };
      if (accept && !accept(picture)) return null;
      const lease = memory.acquire(key);
      return lease ? {
        picture,
        confirmDecoded: confirmed, release: lease.release,
      } : null;
    },
    retain: (key) => memory.acquire(key)!.release,
    decode: (picture, signal) => new Promise((resolve, reject) => calls.push({ picture, signal, resolve, reject })),
  }, maxWarmBytes, now);
  budget.subscribePressure(() => previews.clearWarm());
  const seed = (input: DesignPreviewTarget) => memory.put(designPreviewKey(input), {
    blob: new Blob(["png"]), url: `blob:${designPreviewKey(input)}`, width: 4, height: 4,
  });
  const ready = async (index: number) => {
    await Promise.resolve();
    const dispose = vi.fn();
    calls[index].resolve({ dispose });
    return dispose;
  };
  return { budget, memory, previews, calls, confirmed, seed, ready };
}

describe("decoded Design preview continuity", () => {
  it("probes ready covers without decoding cold images or evicting another frame's warm pixels", async () => {
    const { previews, seed, ready, calls, budget, confirmed } = setup(128, 128);
    const a = target(), b = target("b.html");
    seed(a); seed(b); previews.setOwner({}, a);
    const shown = previews.acquire(a)!;
    const disposed = await ready(0); await shown.whenReady; shown.release();
    expect(previews.acquireReady(b)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(disposed).not.toHaveBeenCalled();
    expect(budget.usage().decodedBytes).toBe(128);
    const cover = previews.acquireReady(a)!;
    expect(cover.ready).toBe(true);
    expect(confirmed).not.toHaveBeenCalled();
    cover.confirmDecoded(); expect(confirmed).toHaveBeenCalledTimes(1);
    cover.release(); previews.clearWarm();
    expect(budget.usage().decodedBytes).toBe(0);
  });

  it("keeps completed fallback pixels across hidden and other-owner navigation without another decode", async () => {
    const { previews, calls, seed, ready, budget } = setup();
    const a = target(), b = target("b.html", "/organization/b");
    const token = {}; seed(a); seed(b); previews.setOwner(token, a);
    const first = previews.acquire(a)!; const disposeA = await ready(0); await first.whenReady;
    first.release(); previews.setOwner(token, null); previews.setOwner({}, b);
    const org = previews.acquire(b)!; await ready(1); await org.whenReady; org.release();
    previews.setOwner(token, a);
    const returned = previews.acquire(a)!;
    expect(returned.ready).toBe(true); expect(calls).toHaveLength(2); expect(disposeA).not.toHaveBeenCalled();
    returned.release(); previews.clearWarm(); expect(budget.usage().decodedBytes).toBe(0);
  });
  it("reuses owned decoded pixels synchronously after culling without claiming an uncommitted display", async () => {
    const { previews, budget, calls, confirmed, seed, ready } = setup();
    const input = target(), token = {};
    seed(input); previews.setOwner(token, input);
    const first = previews.acquire(input)!;
    expect(first.ready).toBe(false);
    first.confirmDecoded(); expect(confirmed).not.toHaveBeenCalled();
    const dispose = await ready(0);
    await first.whenReady;
    expect(first.ready).toBe(true);
    first.confirmDecoded(); expect(confirmed).toHaveBeenCalledTimes(1);
    first.release(); first.release();
    expect(budget.usage().decodedBytes).toBe(128);
    const returning = previews.acquire(input)!;
    expect(returning.ready).toBe(true);
    expect(calls).toHaveLength(1);
    returning.release();
    previews.setOwner(token, null);
    expect(dispose).not.toHaveBeenCalled();
    previews.forgetWorkspaces([input.owner.workspaceId]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(budget.usage()).toMatchObject({ images: 0, leases: 0, decodedBytes: 0 });
  });

  it("shares pending decode, cancels the final consumer and disposes a late image exactly once", async () => {
    const { previews, budget, calls, seed, ready } = setup();
    const input = target(); seed(input); previews.setOwner({}, input);
    const a = previews.acquire(input)!, b = previews.acquire(input)!;
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    a.release(); expect(calls[0].signal.aborted).toBe(false);
    b.release(); expect(calls[0].signal.aborted).toBe(true);
    expect(budget.usage().decodedBytes).toBe(0);
    const late = await ready(0); await b.whenReady;
    expect(late).toHaveBeenCalledTimes(1);
    const again = previews.acquire(input)!;
    expect(again.ready).toBe(false);
    await ready(1); await again.whenReady;
    again.release(); previews.clearWarm();
    expect(budget.usage().decodedBytes).toBe(0);
  });

  it("bounds idle pixels by LRU while preserving active displays and yields to capture pressure", async () => {
    const { previews, budget, seed, ready } = setup(128, 512);
    const a = target("a.html"), b = target("b.html"), c = target("c.html");
    for (const input of [a, b, c]) seed(input);
    previews.setOwner({}, a);
    const shown = previews.acquire(a)!;
    const disposeA = await ready(0); await shown.whenReady;
    const idleB = previews.acquire(b)!;
    const disposeB = await ready(1); await idleB.whenReady; idleB.release();
    const idleC = previews.acquire(c)!;
    const disposeC = await ready(2); await idleC.whenReady; idleC.release();
    expect(disposeA).not.toHaveBeenCalled();
    expect(disposeB).toHaveBeenCalledTimes(1);
    expect(disposeC).not.toHaveBeenCalled();
    expect(budget.usage().decodedBytes).toBe(256);
    // A foreground viewport capture needs the idle cache's capacity now.
    const capture = budget.acquire("capture", 6, 8)!;
    expect(capture).not.toBeNull();
    expect(disposeC).toHaveBeenCalledTimes(1);
    expect(disposeA).not.toHaveBeenCalled();
    expect(budget.usage().decodedBytes).toBe(512);
    capture.release(); shown.release(); previews.clearWarm();
    expect(budget.usage().decodedBytes).toBe(0);
  });

  it("keeps Personal and organization Local owner transitions exact, including late decode and retired cleanup", async () => {
    const { previews, budget, seed, ready } = setup();
    const a = target("a.html", "/personal/a"), b = target("a.html", "/organization/b");
    const ownerA = {}, ownerB = {};
    seed(a); seed(b);
    previews.setOwner(ownerA, a);
    const held = previews.acquire(a)!;
    await Promise.resolve();
    previews.setOwner(ownerB, b);
    const visible = previews.acquire(b)!;
    const disposeB = await ready(1); await visible.whenReady; visible.release();
    previews.setOwner(ownerA, null);
    expect(disposeB).not.toHaveBeenCalled();
    const disposeA = await ready(0); await held.whenReady; held.release();
    expect(disposeA).toHaveBeenCalledTimes(1);
    previews.setOwner(ownerA, a);
    expect(disposeB).not.toHaveBeenCalled();
    const again = previews.acquire(a)!;
    expect(again.ready).toBe(false);
    await ready(2); await again.whenReady; again.release();
    previews.setOwner(ownerA, null);
    previews.clearWarm();
    expect(budget.usage().decodedBytes).toBe(0);
  });

  it("keeps small covers for returning frames before optional warm detail", async () => {
    const { previews, seed, ready } = setup(256);
    const a = target("a.html"), b = target("b.html");
    const detail = { ...a, level: "overview" as const };
    previews.setOwner({}, a);
    const disposed = [];
    for (const [index, input] of [a, b, detail].entries()) {
      seed(input);
      const lease = previews.acquire(input)!;
      disposed.push(await ready(index));
      await lease.whenReady;
      lease.release();
    }
    expect(disposed[0]).not.toHaveBeenCalled();
    expect(disposed[1]).not.toHaveBeenCalled();
    expect(disposed[2]).toHaveBeenCalledTimes(1);
    const returning = previews.acquire(a)!;
    expect(returning.ready).toBe(true);
    returning.release(); previews.clearWarm();
  });

  it("does not evict warm frames while a cold target has no encoded picture yet", async () => {
    const { previews, seed, ready } = setup();
    const input = target(); seed(input); previews.setOwner({}, input);
    const lease = previews.acquire(input)!;
    const dispose = await ready(0); await lease.whenReady; lease.release();
    expect(previews.acquire(target("uncaptured.html"))).toBeNull();
    expect(dispose).not.toHaveBeenCalled();
    const returning = previews.acquire(input)!;
    expect(returning.ready).toBe(true);
    returning.release(); previews.clearWarm();
  });

  it("never reuses decoded pixels across source, theme or directory identity", async () => {
    const { previews, budget, seed, ready } = setup();
    const initial = target();
    const inputs = [initial, { ...initial, sourceVersion: "v2" }, { ...initial, theme: "dark" },
      { ...initial, owner: { ...initial.owner, directoryId: "other-design" } },
      ...["cloud:account-a", "cloud:account-b"].map((scope) => ({ ...initial,
        owner: { ...initial.owner, scope, workspaceId: "cloud://test-owner/test-workspace" } })),
    ];
    for (const [index, input] of inputs.entries()) {
      seed(input); previews.setOwner({}, input);
      const lease = previews.acquire(input)!;
      expect(lease.ready).toBe(false);
      await ready(index); await lease.whenReady; lease.release();
    }
    previews.clearWarm();
    expect(budget.usage().decodedBytes).toBe(0);
  });

  it("releases failed decoders and permits a later retry", async () => {
    const { previews, budget, calls, seed, ready } = setup();
    const input = target(); seed(input); previews.setOwner({}, input);
    const failed = previews.acquire(input)!;
    await Promise.resolve(); calls[0].reject(new Error("invalid pixels"));
    await expect(failed.whenReady).rejects.toThrow("invalid pixels");
    failed.release(); expect(budget.usage().decodedBytes).toBe(0);
    const retry = previews.acquire(input)!;
    await ready(1); await retry.whenReady; retry.release(); previews.clearWarm();
    expect(budget.usage().decodedBytes).toBe(0);
  });

  it("expires a 24-hour idle fallback without evicting active displays or other owners on deletion", async () => {
    let now = 0;
    const { previews, seed, ready, calls, budget } = setup(512, 1024, () => now);
    const a = target(), b = target("b.html", "/organization/b"); seed(a); seed(b);
    previews.setOwner({}, a);
    const warm = previews.acquire(a)!; const disposedA = await ready(0); await warm.whenReady; warm.release();
    const active = previews.acquire(b)!; const disposedB = await ready(1); await active.whenReady;
    now = 25 * 60 * 60_000;
    const reload = previews.acquire(a)!;
    expect(reload.ready).toBe(false); expect(disposedA).toHaveBeenCalledTimes(1); expect(disposedB).not.toHaveBeenCalled();
    await Promise.resolve(); expect(calls).toHaveLength(3);
    previews.forgetWorkspaces([a.owner.workspaceId]);
    expect(calls[2].signal.aborted).toBe(true);
    const late = await ready(2); await reload.whenReady; reload.release(); expect(late).toHaveBeenCalledTimes(1);
    active.release(); previews.clearWarm(); expect(budget.usage().decodedBytes).toBe(0);
  });
});
