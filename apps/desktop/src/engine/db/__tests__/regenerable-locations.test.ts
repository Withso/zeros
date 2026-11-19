import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEPT_LOCATIONS, regenerableLocations } from "../regenerable-locations";
import { REGENERABLE_SESSION_ENTRIES } from "../session-entries";

afterEach(() => vi.unstubAllEnvs());

describe("regenerable locations", () => {
  it("lists every regenerable root from the resolver, never durable stores", () => {
    vi.stubEnv("ZEROS_DATA_DIR", "/data");
    vi.stubEnv("ZEROS_CHANNEL", "stable");
    const locations = regenerableLocations("/caches");
    expect(locations.map((location) => location.id)).toEqual(["cache-dir", "session-caches", "engine-runtime", "design-thumbnails"]);
    expect(locations.find((location) => location.id === "cache-dir")?.path).toBe(path.join("/caches", "com.zeros"));
    expect(locations.find((location) => location.id === "session-caches")).toMatchObject({
      path: path.join("/data", "electron"), entries: REGENERABLE_SESSION_ENTRIES,
    });
    expect(locations.find((location) => location.id === "engine-runtime")?.path).toBe(path.join("/data", "engines"));
    for (const location of locations) expect(location.path).not.toMatch(/git-promotion-journal/);
    expect(locations.filter((location) => location.path.endsWith("design-storage")).map((location) => location.rule)).toEqual(["store-sweep"]);
    expect(KEPT_LOCATIONS.map((location) => location.id)).toEqual(["design-storage", "git-promotion-journal"]);
  });
});
