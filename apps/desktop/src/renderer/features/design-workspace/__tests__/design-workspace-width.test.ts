import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DESIGN_WORKSPACE_LAYERS_HEIGHT_DEFAULT,
  DESIGN_WORKSPACE_LAYERS_HEIGHT_KEY,
  DESIGN_WORKSPACE_LAYERS_WIDTH_DEFAULT,
  DESIGN_WORKSPACE_LAYERS_WIDTH_KEY,
  DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT,
  LEGACY_DESIGN_WORKSPACE_SIDEBAR_RATIO_KEY,
  clampDesignWorkspaceLayersHeight,
  clampDesignWorkspaceLayersWidth,
  clampDesignWorkspaceStyleWidth,
  persistDesignWorkspaceLayersHeight,
  readPersistedDesignWorkspaceLayersHeight,
  readPersistedDesignWorkspaceLayersWidth,
  sanitizeDesignWorkspaceLayersHeight,
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

  it("bounds the Layers split so the inspector below keeps its room", () => {
    expect(DESIGN_WORKSPACE_LAYERS_HEIGHT_DEFAULT).toBe(240);
    expect(sanitizeDesignWorkspaceLayersHeight(Number.NaN)).toBe(240);
    expect(sanitizeDesignWorkspaceLayersHeight(-5)).toBe(96);
    expect(sanitizeDesignWorkspaceLayersHeight(100_000)).toBe(960);
    // An 884px panel keeps 200px for the inspector below the split.
    expect(clampDesignWorkspaceLayersHeight(240, 884)).toBe(240);
    expect(clampDesignWorkspaceLayersHeight(900, 884)).toBe(684);
    expect(clampDesignWorkspaceLayersHeight(40, 884)).toBe(96);
    // A panel too short for both keeps the two-row Layers floor.
    expect(clampDesignWorkspaceLayersHeight(240, 250)).toBe(96);
    expect(clampDesignWorkspaceLayersHeight(Number.NaN, 884)).toBe(240);
    expect(clampDesignWorkspaceLayersHeight(300, 0)).toBe(300);
  });

  it("persists the Layers height apart from both width preferences", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      innerWidth: 1_600,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    expect(readPersistedDesignWorkspaceLayersHeight()).toBe(240);
    expect(persistDesignWorkspaceLayersHeight(318.6)).toBe(319);
    expect(storage.get(DESIGN_WORKSPACE_LAYERS_HEIGHT_KEY)).toBe("319");
    expect(storage.has(DESIGN_WORKSPACE_LAYERS_WIDTH_KEY)).toBe(false);
    expect(readPersistedDesignWorkspaceLayersHeight()).toBe(319);
    storage.set(DESIGN_WORKSPACE_LAYERS_HEIGHT_KEY, "garbage");
    expect(readPersistedDesignWorkspaceLayersHeight()).toBe(240);
  });
});
