import { describe, expect, it } from "vitest";

import {
  DESIGN_WORKSPACE_COMPACT_SIDEBAR_RATIO,
  DESIGN_WORKSPACE_SIDEBAR_RATIO_DEFAULT,
  clampDesignWorkspaceSidebarRatio,
  sanitizeDesignWorkspaceSidebarRatio,
} from "../design-workspace-width";

describe("design workspace sidebar ratio", () => {
  it("sanitizes corrupt persistence without sharing the coding-chat bounds", () => {
    expect(sanitizeDesignWorkspaceSidebarRatio(Number.NaN)).toBe(
      DESIGN_WORKSPACE_SIDEBAR_RATIO_DEFAULT,
    );
    expect(sanitizeDesignWorkspaceSidebarRatio(-1)).toBe(0.1);
    expect(sanitizeDesignWorkspaceSidebarRatio(1)).toBe(0.5);
  });

  it("reserves the canvas floor and sidebar ceiling on wide rows", () => {
    expect(clampDesignWorkspaceSidebarRatio(0, 2_000)).toBe(0.12);
    expect(clampDesignWorkspaceSidebarRatio(1, 2_000)).toBe(0.5);
    expect(clampDesignWorkspaceSidebarRatio(1, 4_000)).toBe(0.3);
  });

  it("uses the matching 34/66 compact split when both pixel floors cannot fit", () => {
    expect(clampDesignWorkspaceSidebarRatio(0.1, 600)).toBe(
      DESIGN_WORKSPACE_COMPACT_SIDEBAR_RATIO,
    );
    expect(clampDesignWorkspaceSidebarRatio(0.5, 695)).toBe(
      DESIGN_WORKSPACE_COMPACT_SIDEBAR_RATIO,
    );
  });
});
