import { describe, expect, it } from "vitest";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";

describe("read-cache growth behind a slow request", () => {
  it.each(["cloud://org/workspace", "/personal/repo", "/organization/repo"])(
    "bounds settled inactive snapshots while an older %s read stays pending",
    async (owner) => {
      const cache = new KeyedAsyncCache<string>({
        maxEntries: 4,
        maxWeight: 32,
        weightOf: (text) => text.length,
      });
      let finish!: (text: string) => void;
      const slow = cache.load(
        `${owner}/slow`,
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      );
      await Promise.resolve();
      try {
        for (let i = 0; i < 128; i++)
          cache.setData(`${owner}/preview-${i}`, String(i).padStart(8, "0"));
        const inactive = cache.keys().filter((key) => key !== `${owner}/slow`);
        expect(inactive.length).toBeLessThanOrEqual(4);
        expect(
          inactive.reduce(
            (bytes, key) => bytes + (cache.peekSnapshot(key).data?.length ?? 0),
            0,
          ),
        ).toBeLessThanOrEqual(32);
        expect(cache.peekSnapshot(`${owner}/preview-127`).data).toBe(
          "00000127",
        );
        expect(cache.peekSnapshot(`${owner}/slow`).loading).toBe(true);
      } finally {
        finish("slow result");
        await slow;
      }
      expect(cache.keys().length).toBeLessThanOrEqual(4);
    },
  );

  it("enforces bytes independently of entry count while a preview read is pending", async () => {
    const cache = new KeyedAsyncCache<string>({
      maxEntries: 64,
      maxWeight: 16,
      weightOf: (text) => text.length,
    });
    let finish!: (text: string) => void;
    const slow = cache.load(
      "slow",
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    try {
      for (let i = 0; i < 32; i++)
        await cache.load(`preview-${i}`, async () =>
          String(i).padStart(8, "0"),
        );
      const bytes = cache
        .keys()
        .reduce(
          (total, key) => total + (cache.peekSnapshot(key).data?.length ?? 0),
          0,
        );
      expect(bytes).toBeLessThanOrEqual(16);
      expect(cache.peekSnapshot("preview-31").data).toBe("00000031");
    } finally {
      finish("done");
      await slow;
    }
  });

  it("keeps a subscribed exact-owner snapshot through churn and releases it on unsubscribe", async () => {
    const cache = new KeyedAsyncCache<string>({
      maxEntries: 2,
      maxWeight: 8,
      weightOf: (text) => text.length,
    });
    const release = cache.subscribe("visible", () => {});
    cache.setData("visible", "confirmed visible content");
    const before = cache.peekSnapshot("visible");
    for (let i = 0; i < 128; i++)
      await cache.load(`other-${i}`, async () => "new data");
    expect(cache.peekSnapshot("visible")).toBe(before);
    release();
    expect(cache.keys().length).toBeLessThanOrEqual(2);
    expect(cache.peekSnapshot("visible").data).toBeUndefined();
  });

  it("does not recreate removed history from a held reader after other-owner churn", async () => {
    const cache = new KeyedAsyncCache<string>(2);
    let finish!: (text: string) => void;
    const slow = cache.load(
      "deleted",
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    cache.forget("deleted");
    for (let i = 0; i < 128; i++) cache.setData(`other-${i}`, "other owner");
    finish("retired data");
    await slow;
    expect(cache.keys()).toHaveLength(2);
    expect(cache.peekSnapshot("deleted").data).toBeUndefined();
  });
});
