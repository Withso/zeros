import { describe, expect, it } from "vitest";

import {
  LARGE_CHANGE_FILE_LIMIT,
  visibleChangeWindow,
  eagerUntrackedPaths,
} from "../large-change-set";

describe("large change sets", () => {
  it("keeps the mounted flat-list window bounded for dependency-sized trees", () => {
    const window = visibleChangeWindow({
      itemCount: 31_423,
      scrollTop: 18_000,
      viewportHeight: 700,
    });

    expect(window.start).toBeGreaterThan(0);
    expect(window.end).toBeLessThan(31_423);
    expect(window.end - window.start).toBeLessThanOrEqual(80);
  });

  it("bounds eager untracked reads and prioritizes shallow user files", () => {
    const dependencyPaths = Array.from(
      { length: LARGE_CHANGE_FILE_LIMIT + 100 },
      (_, index) => `node_modules/pkg-${index}/dist/index.js`,
    );
    const paths = [
      ...dependencyPaths.slice(0, 50),
      "london.md",
      "src/new-file.ts",
      ...dependencyPaths.slice(50),
    ];

    const eager = eagerUntrackedPaths(paths);

    expect(eager.size).toBeLessThanOrEqual(32);
    expect(eager.has("london.md")).toBe(true);
    expect(eager.has("src/new-file.ts")).toBe(true);
  });
});
