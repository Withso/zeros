import { beforeAll, describe, expect, it } from "vitest";
import { highlightToTokens, prewarmSyntax, tokenizeSync } from "../renderers/syntax";
import { LocalTokenCache } from "../renderers/local-token-cache";

const theme = "github-dark-default";
beforeAll(() => prewarmSyntax("typescript", theme));

describe("Local syntax token retention", () => {
  it("bounds sparse source retention even when every file is just one token", () => {
    const files = Array.from({ length: 128 }, (_, index) => `// sparse-${index} ${"x".repeat(45_000)}`);
    const results = files.map(code => tokenizeSync(code, "typescript", theme, { cacheScope: "local" }));
    expect(results.every(result => result?.tokens.flat().length === 1)).toBe(true);
    // Probe newest first so misses do not evict an older hit before its probe.
    let retained = 0;
    for (let index = files.length - 1; index >= 0; index--) {
      if (tokenizeSync(files[index], "typescript", theme, { cacheScope: "local" }) === results[index]) retained++;
    }
    console.info(JSON.stringify({ sparseFiles: files.length, retained }));
    expect(retained).toBeGreaterThan(0);
    expect(retained).toBeLessThanOrEqual(64);
  });

  it("bounds line arrays and source text even when there are no syntax tokens", async () => {
    const files = Array.from({ length: 80 }, (_, index) => "\n".repeat(10_000 + index));
    const results = [];
    for (const code of files) results.push(await highlightToTokens(code, "typescript", theme, { cacheScope: "local" }));
    expect(results.every(result => result?.tokens.every(line => line.length === 0))).toBe(true);
    let retained = 0;
    for (let index = files.length - 1; index >= 0; index--) {
      if (tokenizeSync(files[index], "typescript", theme, { cacheScope: "local" }) === results[index]) retained++;
    }
    console.info(JSON.stringify({ blankFiles: files.length, retained }));
    expect(retained).toBeGreaterThan(0);
    expect(retained).toBeLessThanOrEqual(32);
  });

  it("keeps a recently used Local file synchronous and shares async results", async () => {
    const code = "const cacheOwnership = 'local';";
    const result = await highlightToTokens(code, "typescript", theme, { cacheScope: "local" });
    expect(result).not.toBeNull();
    expect(tokenizeSync(code, "typescript", theme, { cacheScope: "local" })).toBe(result);
    expect(await highlightToTokens(code, "typescript", theme, { cacheScope: "local" })).toBe(result);
  });

  it("leaves the default and cloud cache retention unchanged", () => {
    const files = Array.from({ length: 80 }, (_, index) => `// cloud-control-${index} ${"y".repeat(45_000)}`);
    const results = files.map(code => tokenizeSync(code, "typescript", theme));
    for (let index = 0; index < files.length; index++)
      expect(tokenizeSync(files[index], "typescript", theme)).toBe(results[index]);
  });

  it("bounds variants of a single source and never pins an oversized or partial result", () => {
    const cache = new LocalTokenCache();
    const value = { tokens: [[]] };
    for (let index = 0; index < 100; index++) cache.put("same source", String(index), value);
    let retained = 0;
    for (let index = 0; index < 100; index++) if (cache.get("same source", String(index))) retained++;
    expect(retained).toBeLessThanOrEqual(64);
    expect(cache.get("same source", "99")).toBe(value);
    cache.put("huge", "one", { tokens: Array.from({ length: 300_000 }, () => []) });
    cache.put("partial", "one", { tokens: [[]], partial: true });
    expect(cache.get("huge", "one")).toBeUndefined();
    expect(cache.get("partial", "one")).toBeUndefined();
  });
});
