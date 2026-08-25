import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DESIGN_WORKSPACE_LAYERS_WIDTH_DEFAULT,
  DESIGN_WORKSPACE_LAYERS_WIDTH_KEY,
  DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT,
  LEGACY_DESIGN_WORKSPACE_SIDEBAR_RATIO_KEY,
  clampDesignWorkspaceLayersWidth,
  clampDesignWorkspaceStyleWidth,
  readPersistedDesignWorkspaceLayersWidth,
  sanitizeDesignWorkspaceLayersWidth,
  sanitizeDesignWorkspaceStyleWidth,
} from "../design-workspace-width";

describe("design workspace panel widths", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses designer-sized pixel defaults and sanitizes corrupt persistence", () => {
    expect(DESIGN_WORKSPACE_LAYERS_WIDTH_DEFAULT).toBe(240);
    expect(DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT).toBe(280);
    expect(sanitizeDesignWorkspaceLayersWidth(Number.NaN)).toBe(
      DESIGN_WORKSPACE_LAYERS_WIDTH_DEFAULT,
    );
    expect(sanitizeDesignWorkspaceStyleWidth(Number.NaN)).toBe(
      DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT,
    );
    expect(sanitizeDesignWorkspaceLayersWidth(-1)).toBe(180);
    expect(sanitizeDesignWorkspaceStyleWidth(10_000)).toBe(640);
  });

  it("keeps exact defaults on ordinary and wide workspaces", () => {
    expect(clampDesignWorkspaceLayersWidth(240, 1_200)).toBe(240);
    expect(clampDesignWorkspaceLayersWidth(240, 2_000)).toBe(240);
    expect(clampDesignWorkspaceStyleWidth(280, 960)).toBe(280);
    expect(clampDesignWorkspaceStyleWidth(280, 2_000)).toBe(280);
  });

  it("contracts both panels responsively while preserving room for canvas", () => {
    expect(clampDesignWorkspaceLayersWidth(240, 600)).toBe(204);
    expect(clampDesignWorkspaceLayersWidth(720, 1_000)).toBe(500);
    expect(clampDesignWorkspaceStyleWidth(280, 400)).toBe(200);
    expect(clampDesignWorkspaceStyleWidth(640, 1_000)).toBe(500);
  });

  it("migrates the former Layers ratio to a compatible pixel width once", () => {
    const storage = new Map<string, string>([
      [LEGACY_DESIGN_WORKSPACE_SIDEBAR_RATIO_KEY, "0.4"],
    ]);
    vi.stubGlobal("window", {
      innerWidth: 1_600,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });

    expect(readPersistedDesignWorkspaceLayersWidth()).toBe(640);
    expect(storage.get(DESIGN_WORKSPACE_LAYERS_WIDTH_KEY)).toBe("640");
    expect(storage.has(LEGACY_DESIGN_WORKSPACE_SIDEBAR_RATIO_KEY)).toBe(false);
  });
});
