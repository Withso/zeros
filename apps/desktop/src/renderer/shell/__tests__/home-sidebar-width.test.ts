// Home nav rail width — the pure clamp behind the seam drag + persistence.

import { describe, expect, it } from "vitest";

import {
  clampHomeSidebarWidth,
  HOME_SIDEBAR_DEFAULT_PX,
  HOME_SIDEBAR_MAX_PX,
  HOME_SIDEBAR_MIN_PX,
} from "../home-sidebar-width";

describe("clampHomeSidebarWidth", () => {
  it("passes through an in-range width", () => {
    expect(clampHomeSidebarWidth(300)).toBe(300);
  });

  it("floors at the rail minimum", () => {
    expect(clampHomeSidebarWidth(50)).toBe(HOME_SIDEBAR_MIN_PX);
    expect(clampHomeSidebarWidth(-100)).toBe(HOME_SIDEBAR_MIN_PX);
  });

  it("opens a width saved under the old 200px floor wide enough for the title band", () => {
    // Traffic-light reserve, then toggle, resources, back and forward.
    expect(HOME_SIDEBAR_MIN_PX).toBe(220);
    expect(clampHomeSidebarWidth(200)).toBe(220);
  });

  it("caps at the rail maximum", () => {
    expect(clampHomeSidebarWidth(9999)).toBe(HOME_SIDEBAR_MAX_PX);
  });

  it("falls back to the default for a malformed value", () => {
    expect(clampHomeSidebarWidth(Number.NaN)).toBe(HOME_SIDEBAR_DEFAULT_PX);
    expect(clampHomeSidebarWidth(Number.POSITIVE_INFINITY)).toBe(
      HOME_SIDEBAR_DEFAULT_PX,
    );
  });

  it("keeps the default within its own bounds", () => {
    expect(HOME_SIDEBAR_DEFAULT_PX).toBeGreaterThanOrEqual(HOME_SIDEBAR_MIN_PX);
    expect(HOME_SIDEBAR_DEFAULT_PX).toBeLessThanOrEqual(HOME_SIDEBAR_MAX_PX);
  });
});
