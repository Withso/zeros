import { describe, expect, it } from "vitest";

import { diffViewVersion } from "../diff-view-version";

describe("diffViewVersion", () => {
  it("is stable for the same patch", () => {
    const patch = "@@ -1 +1 @@\n-old\n+new\n";
    expect(diffViewVersion(patch)).toBe(diffViewVersion(patch));
  });

  it("changes when an equal-length patch changes", () => {
    const before = "@@ -1 +1 @@\n-old\n+red\n";
    const after = "@@ -1 +1 @@\n-old\n+blue\n".replace("blue", "sky");

    expect(after).toHaveLength(before.length);
    expect(diffViewVersion(after)).not.toBe(diffViewVersion(before));
  });

  it("always returns a safe non-negative integer", () => {
    const version = diffViewVersion("diff --git a/a b/a\n");
    expect(Number.isSafeInteger(version)).toBe(true);
    expect(version).toBeGreaterThanOrEqual(0);
  });
});
