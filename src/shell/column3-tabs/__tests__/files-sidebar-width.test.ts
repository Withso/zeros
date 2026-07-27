// Files-tab sidebar width — the pure clamp/sanitize math behind the seam drag.

import { describe, expect, it } from "vitest";

import {
  clampFilesSidebarFraction,
  clampFilesSidebarWidth,
  sanitizeFilesSidebarFraction,
  FILES_SIDEBAR_DEFAULT_FRACTION,
  FILES_SIDEBAR_MAX_FRACTION,
  FILES_SIDEBAR_MIN_FRACTION,
  FILES_SIDEBAR_MIN_PX,
  FILES_VIEWER_MIN_PX,
} from "../files-sidebar-width";

describe("clampFilesSidebarWidth", () => {
  it("passes through an in-range width", () => {
    expect(clampFilesSidebarWidth(240, 800)).toBe(240);
  });

  it("floors at the sidebar minimum", () => {
    expect(clampFilesSidebarWidth(10, 800)).toBe(FILES_SIDEBAR_MIN_PX);
    expect(clampFilesSidebarWidth(-50, 800)).toBe(FILES_SIDEBAR_MIN_PX);
  });

  it("reserves the viewer's minimum column", () => {
    expect(clampFilesSidebarWidth(700, 800)).toBe(800 - FILES_VIEWER_MIN_PX);
  });

  it("keeps the sidebar floor when the container can't fit both minimums", () => {
    // 200px column (column 3's own floor): floor wins over the viewer
    // reservation — flex absorbs the squeeze, the clamp must not go below
    // the usable tree width (or negative).
    expect(clampFilesSidebarWidth(500, 200)).toBe(FILES_SIDEBAR_MIN_PX);
    expect(clampFilesSidebarWidth(10, 200)).toBe(FILES_SIDEBAR_MIN_PX);
  });
});

describe("clampFilesSidebarFraction", () => {
  it("converts an in-range drag position to its share of the container", () => {
    expect(clampFilesSidebarFraction(240, 800)).toBeCloseTo(0.3);
  });

  it("floors at the sidebar's pixel minimum", () => {
    expect(clampFilesSidebarFraction(10, 800)).toBeCloseTo(
      FILES_SIDEBAR_MIN_PX / 800,
    );
  });

  it("caps at the CSS max-w share even when the viewer reservation would allow more", () => {
    // 1000px container: the viewer reservation alone allows 780px (0.78) —
    // the 70% share cap must win so the live drag matches the render.
    expect(clampFilesSidebarFraction(900, 1000)).toBe(
      FILES_SIDEBAR_MAX_FRACTION,
    );
  });

  it("reserves the viewer's minimum column below the share-cap crossover", () => {
    // 600px container: cw - 220 = 380 (0.633) is tighter than the 70% cap.
    expect(clampFilesSidebarFraction(500, 600)).toBeCloseTo(380 / 600);
  });

  it("falls back to the default on a degenerate container", () => {
    expect(clampFilesSidebarFraction(240, 0)).toBe(
      FILES_SIDEBAR_DEFAULT_FRACTION,
    );
    expect(clampFilesSidebarFraction(240, Number.NaN)).toBe(
      FILES_SIDEBAR_DEFAULT_FRACTION,
    );
  });
});

describe("sanitizeFilesSidebarFraction", () => {
  it("passes through an in-range fraction", () => {
    expect(sanitizeFilesSidebarFraction(0.3)).toBe(0.3);
  });

  it("clamps to the global bounds", () => {
    expect(sanitizeFilesSidebarFraction(0)).toBe(FILES_SIDEBAR_MIN_FRACTION);
    expect(sanitizeFilesSidebarFraction(2)).toBe(FILES_SIDEBAR_MAX_FRACTION);
  });

  it("falls back to the default for a malformed persisted value", () => {
    expect(sanitizeFilesSidebarFraction(Number.NaN)).toBe(
      FILES_SIDEBAR_DEFAULT_FRACTION,
    );
    expect(sanitizeFilesSidebarFraction(Number.POSITIVE_INFINITY)).toBe(
      FILES_SIDEBAR_DEFAULT_FRACTION,
    );
  });
});
