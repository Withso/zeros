import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("electron-builder local signing boundary", () => {
  it("disables certificate auto-discovery when CSC_LINK is absent", () => {
    const source = readFileSync("scripts/electron-builder-run.mjs", "utf8");

    expect(source).toContain("CSC_IDENTITY_AUTO_DISCOVERY");
    expect(source).toMatch(/CSC_LINK[\s\S]*CSC_IDENTITY_AUTO_DISCOVERY/);
  });
});
