import { describe, expect, it } from "vitest";
import { DesignStyleCache, designStyleCacheKey } from "../style-cache";

describe("the shared style cache", () => {
  it("evicts least recently used entries by size and always keeps the newest", () => {
    const cache = new DesignStyleCache(100);
    cache.set("a", "A", 40);
    cache.set("b", "B", 40);
    expect(cache.get("a")).toBe("A");
    cache.set("c", "C", 40);
    // "b" was used least recently.
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.bytes).toBe(80);
    cache.set("huge", "H", 500);
    expect(cache.size).toBe(1);
    expect(cache.get("huge")).toBe("H");
    expect(cache.bytes).toBe(500);
  });

  it("replaces an entry's size and forgets one checkout by prefix", () => {
    const cache = new DesignStyleCache(1_000);
    cache.set(designStyleCacheKey("/repo/a", "css", "app"), 1, 10);
    cache.set(designStyleCacheKey("/repo/a", "css", "app"), 2, 30);
    cache.set(designStyleCacheKey("/repo/ab", "css", "app"), 3, 20);
    expect(cache.bytes).toBe(50);
    cache.deletePrefix("/repo/a\0");
    expect(cache.get(designStyleCacheKey("/repo/a", "css", "app"))).toBeUndefined();
    expect(cache.get(designStyleCacheKey("/repo/ab", "css", "app"))).toBe(3);
    expect(cache.bytes).toBe(20);
  });
});
