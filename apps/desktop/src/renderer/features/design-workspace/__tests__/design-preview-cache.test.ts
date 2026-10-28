import { describe, expect, it, vi } from "vitest";

import {
  DesignPreviewCache,
  type DesignPreviewBlobImage,
  type DesignPreviewImage,
} from "../state/design-preview-cache";
import { designPreviewPng } from "./design-preview-fixture";

function image(width = 4, height = 4, seed = 0): DesignPreviewImage {
  return { dataUrl: designPreviewPng(width, height, seed), width, height };
}

function bitmapImage(seed = 0) {
  const close = vi.fn();
  return {
    ...image(4, 4, seed),
    bitmap: { width: 4, height: 4, close } as unknown as ImageBitmap,
  };
}

const smallLimits = {
  maxEntries: 2,
  maxEncodedBytes: 10_000,
  maxDecodedBytes: 256,
};

describe("design preview cache", () => {
  it("touches an unpinned entry on use rather than insertion alone", () => {
    const cache = new DesignPreviewCache(smallLimits);
    cache.put("a", image(4, 4, 1));
    cache.put("b", image(4, 4, 2));
    cache.acquire("a")!.release();
    cache.put("c", image(4, 4, 3));
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    cache.clear();
  });

  it("does not retire an invalidated image until every shown lease releases", () => {
    const cache = new DesignPreviewCache(smallLimits);
    const preview = bitmapImage();
    cache.put("a", preview);
    const first = cache.acquire("a")!;
    const second = cache.acquire("a")!;
    cache.invalidate("a");
    first.release();
    expect(preview.bitmap.close).not.toHaveBeenCalled();
    expect(cache.getUsage().entries).toBe(1);
    second.release();
    expect(preview.bitmap.close).toHaveBeenCalledTimes(1);
    expect(cache.getUsage().entries).toBe(0);
  });

  it("retains thirty unique images independently of a runtime history", () => {
    const cache = new DesignPreviewCache();
    const previews = Array.from({ length: 30 }, (_, index) =>
      image(12 + (index % 5), 8 + (index % 3), index),
    );
    expect(new Set(previews.map((preview) => preview.dataUrl)).size).toBe(30);
    for (const [index, preview] of previews.entries())
      expect(cache.put(`local/frame-${index}/paint-a`, preview)).toBe(true);
    for (const [index, preview] of previews.entries()) {
      const lease = cache.acquire(`local/frame-${index}/paint-a`)!;
      expect(lease.image).toEqual(preview);
      lease.release();
    }
    expect(cache.getUsage().entries).toBe(30);
    cache.clear();
    expect(cache.getUsage()).toEqual({
      entries: 0,
      encodedBytes: 0,
      decodedBytes: 0,
    });
  });

  it("evicts unleased least-recently-used pixels and preserves a shown lease", () => {
    const cache = new DesignPreviewCache(smallLimits);
    const a = bitmapImage(1);
    const b = bitmapImage(2);
    const c = bitmapImage(3);
    cache.put("a", a);
    cache.put("b", b);
    const shown = cache.acquire("a")!;
    expect(cache.put("c", c)).toBe(true);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(b.bitmap.close).toHaveBeenCalledTimes(1);
    expect(a.bitmap.close).not.toHaveBeenCalled();
    shown.release();
    cache.clear();
    expect(a.bitmap.close).toHaveBeenCalledTimes(1);
    expect(c.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("refuses optional admission when pins exhaust the budget without evicting", () => {
    const cache = new DesignPreviewCache(smallLimits);
    const a = bitmapImage(1);
    const b = bitmapImage(2);
    const c = bitmapImage(3);
    cache.put("a", a);
    cache.put("b", b);
    const first = cache.acquire("a")!;
    const second = cache.acquire("b")!;
    const usage = cache.getUsage();
    expect(cache.put("c", c)).toBe(false);
    expect(cache.getUsage()).toEqual(usage);
    expect(cache.has("a") && cache.has("b")).toBe(true);
    expect(c.bitmap.close).not.toHaveBeenCalled();
    first.release();
    second.release();
    cache.clear();
  });

  it("accounts for both old and new images until replacement leases release", () => {
    const cache = new DesignPreviewCache(smallLimits);
    const old = bitmapImage(1);
    const replacement = bitmapImage(2);
    cache.put("key", old);
    const shown = cache.acquire("key")!;
    expect(cache.put("key", replacement)).toBe(true);
    expect(cache.getUsage().entries).toBe(2);
    expect(cache.getUsage().decodedBytes).toBe(256);
    expect(shown.image.bitmap).toBe(old.bitmap);
    const newest = cache.acquire("key")!;
    expect(newest.image.bitmap).toBe(replacement.bitmap);
    cache.clear();
    expect(cache.has("key")).toBe(false);
    expect(old.bitmap.close).not.toHaveBeenCalled();
    shown.release();
    shown.release();
    expect(old.bitmap.close).toHaveBeenCalledTimes(1);
    expect(cache.getUsage().entries).toBe(1);
    newest.release();
    expect(replacement.bitmap.close).toHaveBeenCalledTimes(1);
    expect(cache.getUsage().decodedBytes).toBe(0);
  });

  it("keeps the previous exact key when a replacement cannot fit its overlap", () => {
    const cache = new DesignPreviewCache(smallLimits);
    const old = bitmapImage(1);
    cache.put("key", old);
    const shown = cache.acquire("key")!;
    expect(cache.put("key", image(8, 4, 2))).toBe(false);
    const retained = cache.acquire("key")!;
    expect(retained.image.bitmap).toBe(old.bitmap);
    retained.release();
    shown.release();
    cache.clear();
  });

  it("charges encoded bytes including identity keys separately from decoded estimates", () => {
    const a = image(1, 1, 1);
    const b = image(1, 1, 2);
    const encoded =
      ("a".length + a.dataUrl.length + "b".length + b.dataUrl.length) * 2;
    const cache = new DesignPreviewCache({
      ...smallLimits,
      maxEntries: 10,
      maxEncodedBytes: encoded,
    });
    expect(cache.put("a", a)).toBe(true);
    expect(cache.put("b", b)).toBe(true);
    expect(cache.getUsage()).toEqual({
      entries: 2,
      encodedBytes: encoded,
      decodedBytes: 16,
    });
    expect(cache.put("c", image(1, 1, 3))).toBe(true);
    expect(cache.has("a")).toBe(false);
    expect(cache.getUsage().encodedBytes).toBeLessThanOrEqual(encoded);
    cache.clear();
  });

  it("keeps retired pins charged after invalidation and clear", () => {
    const cache = new DesignPreviewCache(smallLimits);
    const old = bitmapImage();
    cache.put("cloud/org/ws/frame/theme-a", old);
    const lease = cache.acquire("cloud/org/ws/frame/theme-a")!;
    cache.invalidate("cloud/org/ws/frame/theme-a");
    expect(cache.acquire("cloud/org/ws/frame/theme-a")).toBeNull();
    cache.clear();
    expect(cache.getUsage().entries).toBe(1);
    expect(cache.getUsage().decodedBytes).toBe(128);
    lease.release();
    expect(cache.getUsage().entries).toBe(0);
    expect(old.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("does not admit a bitmap already owned by a different key", () => {
    const cache = new DesignPreviewCache();
    const preview = bitmapImage();
    expect(cache.put("a", preview)).toBe(true);
    expect(cache.put("a", preview)).toBe(true);
    expect(cache.put("b", preview)).toBe(false);
    expect(cache.getUsage().entries).toBe(1);
    cache.clear();
    expect(preview.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized and dishonest dimensions before evicting valid entries", () => {
    const cache = new DesignPreviewCache(smallLimits);
    const retained = bitmapImage();
    cache.put("shown", retained);
    const usage = cache.getUsage();
    for (const preview of [
      image(32, 32),
      { ...image(), width: 1 },
      { ...image(), height: Infinity },
      { ...image(), width: 0 },
      { ...image(), dataUrl: "data:image/png;base64,not-a-png" },
      { ...image(), dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
      {
        ...image(),
        bitmap: {
          width: 1,
          height: 1,
          close: vi.fn(),
        } as unknown as ImageBitmap,
      },
    ]) {
      expect(cache.put("bad", preview)).toBe(false);
      expect(cache.getUsage()).toEqual(usage);
      expect(cache.has("shown")).toBe(true);
    }
    cache.clear();
  });

  it("uses immutable owned metadata and copies the configured budgets", () => {
    const limits = { ...smallLimits };
    const cache = new DesignPreviewCache(limits);
    limits.maxEntries = 100;
    const preview = { ...image(), unusedPayload: new Uint8Array(1000) };
    cache.put("local/personal/a", preview);
    preview.dataUrl = "changed";
    const lease = cache.acquire("local/personal/a")!;
    expect(lease.image.dataUrl).not.toBe("changed");
    expect(Object.isFrozen(lease.image)).toBe(true);
    expect(lease.image).not.toHaveProperty("unusedPayload");
    expect(cache.acquire("cloud/org/ws/a")).toBeNull();
    expect(cache.acquire("local/organization/a")).toBeNull();
    lease.release();
    cache.clear();
  });

  it("has a hard entry bound even for ten thousand tiny unique requests", () => {
    const cache = new DesignPreviewCache({
      ...smallLimits,
      maxEntries: 32,
      maxDecodedBytes: 1024,
      maxEncodedBytes: 32_000,
    });
    for (let index = 0; index < 10_000; index++) {
      expect(cache.put(`frame-${index}`, image(1, 1, index))).toBe(true);
      expect(cache.getUsage().entries).toBeLessThanOrEqual(32);
      expect(cache.getUsage().decodedBytes).toBeLessThanOrEqual(1024);
      expect(cache.getUsage().encodedBytes).toBeLessThanOrEqual(32_000);
    }
    cache.clear();
    expect(cache.getUsage().encodedBytes).toBe(0);
  });

  it.each([-1, NaN, Infinity, 10_001])(
    "rejects invalid entry limits %s",
    (maxEntries) => {
      expect(
        () => new DesignPreviewCache({ ...smallLimits, maxEntries }),
      ).toThrow(RangeError);
    },
  );

  it("holds encoded Blob pictures behind object URLs, charged their encoded bytes", () => {
    const disposed: string[] = [];
    const evicted: string[] = [];
    const cache = new DesignPreviewCache<DesignPreviewBlobImage>(
      { maxEntries: 10, maxEncodedBytes: 250, maxDecodedBytes: 256 },
      { evicted: (key) => evicted.push(key), disposed: (picture) => disposed.push(picture.url) },
    );
    const picture = (url: string, bytes = 100): DesignPreviewBlobImage =>
      ({ blob: new Blob([new Uint8Array(bytes)], { type: "image/webp" }), url, width: 4, height: 4 });
    // Encoded retention alone does not reserve decoded display pixels.
    expect(cache.put("a", picture("blob:a"))).toBe(true);
    expect(cache.getUsage()).toEqual({ entries: 1, encodedBytes: 100, decodedBytes: 0 });
    const shown = cache.acquire("a")!;
    expect(shown.image.url).toBe("blob:a");
    cache.put("b", picture("blob:b"));
    // c evicts the least recently used unshown picture, b, and reports it.
    expect(cache.put("c", picture("blob:c"))).toBe(true);
    expect(evicted).toEqual(["b"]);
    expect(disposed).toEqual(["blob:b"]);
    // An invalidated shown picture keeps its URL until its lease releases.
    cache.invalidate("a");
    expect(disposed).toEqual(["blob:b"]);
    shown.release();
    expect(disposed).toEqual(["blob:b", "blob:a"]);
    expect(evicted).toEqual(["b"]);
    // A picture that cannot fit is refused without evicting anything.
    expect(cache.put("d", picture("blob:d", 300))).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.put("e", { ...picture("blob:e"), width: 0 })).toBe(false);
  });

  it("refuses a compressed Blob's display when its decoded pixels exceed the budget", () => {
    const cache = new DesignPreviewCache<DesignPreviewBlobImage>({
      maxEntries: 10, maxEncodedBytes: 1000, maxDecodedBytes: 256,
    });
    expect(cache.put("large", {
      blob: new Blob(["small encoded image"]), url: "blob:large", width: 4096, height: 4096,
    })).toBe(true);
    // Encoded residency and display residency are separate; storing a small
    // compressed picture never authorizes allocating an unbounded raster.
    expect(cache.acquire("large")).toBeNull();
    expect(cache.getUsage().decodedBytes).toBe(0);
  });

  it("counts Blob display overlap and releases pixels at the final lease", () => {
    const cache = new DesignPreviewCache<DesignPreviewBlobImage>(smallLimits);
    const picture = (url: string) => ({ blob: new Blob([url]), url, width: 4, height: 4 });
    cache.put("a", picture("blob:a"));
    const first = cache.acquire("a")!;
    const second = cache.acquire("a")!;
    expect(cache.getUsage().decodedBytes).toBe(128);
    cache.put("a", picture("blob:replacement"));
    const replacement = cache.acquire("a")!;
    expect(cache.getUsage().decodedBytes).toBe(256);
    first.release();
    expect(cache.getUsage().decodedBytes).toBe(256);
    second.release();
    second.release();
    expect(cache.getUsage().decodedBytes).toBe(128);
    replacement.release();
    expect(cache.getUsage().decodedBytes).toBe(0);
    expect(cache.has("a")).toBe(true);
  });
});
