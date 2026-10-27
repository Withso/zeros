import { describe, expect, it, vi } from "vitest";
import { DesignImageResidency, designImageDecodedBytes } from "../state/design-image-residency";

describe("Design display image residency", () => {
  it("counts shared consumers once and incoming replacements separately", () => {
    const budget = new DesignImageResidency(256, 100);
    const a = budget.acquire("a", 4, 4, 30)!;
    const duplicate = budget.acquire("a", 4, 4, 30)!;
    const b = budget.acquire("b", 4, 4, 50)!;
    expect(budget.usage()).toMatchObject({ images: 2, leases: 3, decodedBytes: 256, encodedBytes: 80 });
    expect(budget.acquire("c", 1, 1)).toBeNull();
    a.release();
    a.release();
    expect(budget.usage().decodedBytes).toBe(256);
    duplicate.release();
    expect(budget.usage().decodedBytes).toBe(128);
    b.release();
    expect(budget.usage()).toMatchObject({ images: 0, leases: 0, decodedBytes: 0, encodedBytes: 0 });
  });

  it("bounds encoded transient captures independently of pixel reservations", () => {
    const budget = new DesignImageResidency(1024, 100);
    const shown = budget.acquire("shown", 1, 1, 80)!;
    expect(budget.acquire("incoming", 1, 1, 30)).toBeNull();
    expect(budget.acquire("shown", 2, 2, 80)).toBeNull();
    shown.release();
    expect(budget.acquire("incoming", 1, 1, 30)).not.toBeNull();
  });

  it("notifies blocked consumers only when capacity actually becomes available", async () => {
    const budget = new DesignImageResidency(128);
    const listener = vi.fn();
    const unsubscribe = budget.subscribeAvailable(listener);
    const a = budget.acquire("a", 4, 4)!;
    const b = budget.acquire("a", 4, 4)!;
    a.release();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    b.release();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("refuses unsafe dimensions and impossible policies", () => {
    for (const width of [NaN, Infinity, 0, -1, 0.5, Number.MAX_SAFE_INTEGER])
      expect(designImageDecodedBytes(width, 100)).toBeNull();
    expect(() => new DesignImageResidency(-1)).toThrow(RangeError);
  });

  it("admits one explicit replacement while the old pixels remain owned, then retires the overlap", () => {
    const budget = new DesignImageResidency(128, 100);
    const shown = budget.acquire("shown", 4, 4, 30)!;
    const incoming = budget.acquire("incoming", 4, 4, 30, shown);
    expect(incoming).not.toBeNull();
    expect(budget.usage()).toMatchObject({ images: 2, decodedBytes: 256, transitions: 1, transitionDecodedBytes: 128 });
    expect(budget.acquire("unrelated", 1, 1)).toBeNull();
    expect(budget.acquire("third", 4, 4, 30, incoming!)).toBeNull();
    shown.release();
    expect(budget.usage()).toMatchObject({ images: 1, decodedBytes: 128, transitions: 0, transitionDecodedBytes: 0 });
    incoming!.release();
    expect(budget.usage()).toMatchObject({ images: 0, leases: 0, decodedBytes: 0 });
  });

  it("requires an exclusive live lease from this pool and a replacement that fits after retirement", () => {
    const budget = new DesignImageResidency(128, 100);
    const shown = budget.acquire("shown", 4, 4, 60)!;
    const shared = budget.acquire("shown", 4, 4, 60)!;
    expect(budget.acquire("incoming", 4, 4, 60, shown)).toBeNull();
    shared.release();
    const foreign = new DesignImageResidency(128).acquire("foreign", 4, 4)!;
    expect(budget.acquire("incoming", 4, 4, 60, foreign)).toBeNull();
    expect(budget.acquire("incoming", 4, 4, 60, shared)).toBeNull();
    expect(budget.acquire("too-large", 5, 4, 60, shown)).toBeNull();
    expect(budget.acquire("too-encoded", 4, 4, 101, shown)).toBeNull();
    const incoming = budget.acquire("incoming", 4, 4, 60, shown);
    expect(incoming).not.toBeNull();
    // An independent consumer cannot pin the image whose retirement owns the swap.
    expect(budget.acquire("shown", 4, 4, 60)).toBeNull();
    expect(budget.acquire("incoming", 4, 4, 60)).toBeNull();
    incoming!.release(); shown.release(); foreign.release();
    expect(budget.usage()).toMatchObject({ images: 0, leases: 0, transitions: 0 });
  });

  it("releases a cancelled incoming image without retiring the displayed image or losing the next swap", async () => {
    const budget = new DesignImageResidency(128, 100);
    const shown = budget.acquire("shown", 4, 4, 60)!;
    const listener = vi.fn();
    const unsubscribe = budget.subscribeAvailable(listener);
    const cancelled = budget.acquire("cancelled", 4, 4, 60, shown);
    expect(cancelled).not.toBeNull();
    expect(budget.usage()).toMatchObject({ encodedBytes: 120, transitionEncodedBytes: 60, maxEncodedBytes: 100 });
    cancelled!.release(); cancelled!.release();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(budget.usage()).toMatchObject({ images: 1, decodedBytes: 128, encodedBytes: 60, transitions: 0 });
    const next = budget.acquire("next", 4, 4, 60, shown);
    expect(next).not.toBeNull();
    shown.release(); next!.release(); unsubscribe();
    expect(budget.usage()).toMatchObject({ images: 0, leases: 0, decodedBytes: 0, encodedBytes: 0, transitions: 0 });
  });

  it("shares the single overlap allowance across frames and wakes the next blocked replacement", async () => {
    const budget = new DesignImageResidency(256, 100);
    const a = budget.acquire("a", 4, 4, 20)!;
    const b = budget.acquire("b", 4, 4, 20)!;
    const nextA = budget.acquire("next-a", 4, 4, 20, a)!;
    expect(nextA).not.toBeNull();
    expect(budget.acquire("next-b", 4, 4, 20, b)).toBeNull();
    const listener = vi.fn();
    const unsubscribe = budget.subscribeAvailable(listener);
    a.release();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    const nextB = budget.acquire("next-b", 4, 4, 20, b);
    expect(nextB).not.toBeNull();
    b.release(); nextA.release(); nextB!.release(); unsubscribe();
    expect(budget.usage()).toMatchObject({ images: 0, decodedBytes: 0, transitions: 0 });
  });
});
