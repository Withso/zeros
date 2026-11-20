import { describe, expect, it } from "vitest";
import { smokeFeatureOff } from "../../config/release-channel";

describe("UI-smoke flag pinning", () => {
  it("pins a named flag off only in ui-smoke mode", () => {
    expect(smokeFeatureOff("unified-workspaces", "ui-smoke", "?create&feature-off=unified-workspaces")).toBe(true);
    expect(smokeFeatureOff("cloud-workspaces", "ui-smoke", "?feature-off=unified-workspaces")).toBe(false);
  });

  it.each(["production", "development", "test"])("is ignored in %s mode", (mode) => {
    expect(smokeFeatureOff("unified-workspaces", mode, "?feature-off=unified-workspaces")).toBe(false);
  });

  it("is ignored without a page location", () => {
    expect(smokeFeatureOff("unified-workspaces", "ui-smoke", null)).toBe(false);
  });
});
