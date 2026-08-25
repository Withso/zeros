import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampDesignZoom,
  designWorkspaceView,
  forgetDesignWorkspaceView,
  normalizeDesignWorkspaceView,
  resetDesignWorkspaceUiForTests,
  useDesignWorkspaceUiStore,
  validateDesignWorkspaceSelection,
} from "../state/design-workspace-ui";

describe("design workspace UI memory", () => {
  beforeEach(() => {
    resetDesignWorkspaceUiForTests();
    vi.restoreAllMocks();
  });

  it("normalizes corrupt persisted values and clamps zoom", () => {
    expect(clampDesignZoom(Number.NaN)).toBe(0.25);
    expect(clampDesignZoom(0)).toBe(0.01);
    expect(clampDesignZoom(0.005)).toBe(0.01);
    expect(clampDesignZoom(4)).toBe(4);
    expect(clampDesignZoom(512)).toBe(256);
    expect(
      normalizeDesignWorkspaceView({
        selectedFrame: "../outside.html",
        selectedNodeId: "\u0000not-an-oid",
        selectedNodeIds: ["valid", "valid", "\u0000invalid"],
        panel: "unknown",
        activeTheme: "Not valid!",
        canvasBackground: "not a color",
        codeView: "yes",
        zoom: Number.POSITIVE_INFINITY,
        panX: Number.NaN,
        panY: 18,
        updatedAt: -1,
      }),
    ).toEqual({
      selectedFrame: null,
      frameSelected: false,
      selectedNodeId: null,
      selectedNodeIds: [],
      panel: "layers",
      activeTheme: null,
      canvasBackground: null,
      codeView: false,
      zoom: 0.25,
      panX: 64,
      panY: 18,
      updatedAt: 0,
    });
  });

  it("keeps frame-selected only while the frame is the selection target", () => {
    // A persisted frame-selected flag survives only alongside its frame and
    // never together with a node selection.
    expect(
      normalizeDesignWorkspaceView({
        selectedFrame: "home.html",
        frameSelected: true,
      }),
    ).toMatchObject({ selectedFrame: "home.html", frameSelected: true });
    expect(
      normalizeDesignWorkspaceView({
        selectedFrame: "home.html",
        frameSelected: true,
        selectedNodeId: "hero",
      }),
    ).toMatchObject({ selectedNodeId: "hero", frameSelected: false });
    expect(normalizeDesignWorkspaceView({ frameSelected: true })).toMatchObject(
      { selectedFrame: null, frameSelected: false },
    );

    const store = useDesignWorkspaceUiStore.getState();
    store.setSelection("workspace-a", "home.html", null, undefined, {
      frameSelected: true,
    });
    expect(designWorkspaceView("workspace-a").frameSelected).toBe(true);
    // Selecting a node steals the selection from the frame.
    store.setSelection("workspace-a", "home.html", "hero");
    expect(designWorkspaceView("workspace-a").frameSelected).toBe(false);
    // Clearing back to activation leaves nothing selected.
    store.setSelection("workspace-a", "home.html", null);
    expect(designWorkspaceView("workspace-a").frameSelected).toBe(false);
    // Switching the active frame drops a stale frame selection.
    store.setSelection("workspace-a", "home.html", null, undefined, {
      frameSelected: true,
    });
    store.setSelectedFrame("workspace-a", "pricing.html");
    expect(designWorkspaceView("workspace-a").frameSelected).toBe(false);
  });

  it("keeps selection and viewport isolated by workspace across A to B to A", () => {
    const store = useDesignWorkspaceUiStore.getState();
    store.setSelection("workspace-a", "home.html", "hero-heading");
    store.setViewport("workspace-a", { zoom: 0.8, panX: 12, panY: 24 });
    // check:ui ignore-next -- authored workspace canvas-color fixture.
    store.setCanvasBackground("workspace-a", "rgb(51 102 153 / 0.5)");
    store.setPanel("workspace-b", "assets");
    store.setActiveTheme("workspace-b", "dark");
    store.setSelectedFrame("workspace-b", "pricing.html");

    expect(designWorkspaceView("workspace-a")).toMatchObject({
      selectedFrame: "home.html",
      selectedNodeId: "hero-heading",
      panel: "layers",
      zoom: 0.8,
      panX: 12,
      panY: 24,
      canvasBackground: "#33669980", // check:ui ignore-line -- canonical authored canvas color.
    });
    expect(designWorkspaceView("workspace-b")).toMatchObject({
      selectedFrame: "pricing.html",
      panel: "assets",
      activeTheme: "dark",
      canvasBackground: null,
    });
  });

  it("normalizes a bounded unique multi-selection around its primary node", () => {
    const normalized = normalizeDesignWorkspaceView({
      selectedFrame: "home.html",
      selectedNodeId: "heading",
      selectedNodeIds: ["copy", "heading", "copy", "cta"],
    });
    expect(normalized.selectedNodeIds).toEqual(["heading", "copy", "cta"]);

    useDesignWorkspaceUiStore
      .getState()
      .setSelection("workspace-a", "home.html", "copy", ["heading", "copy"]);
    expect(designWorkspaceView("workspace-a")).toMatchObject({
      selectedNodeId: "copy",
      selectedNodeIds: ["copy", "heading"],
    });
  });

  it("publishes frame and element identity atomically and clears the node on a frame change", () => {
    const store = useDesignWorkspaceUiStore.getState();
    const notifications: Array<{ frame: string | null; node: string | null }> =
      [];
    const unsubscribe = useDesignWorkspaceUiStore.subscribe((state) => {
      const view = state.byWorkspace["workspace-a"];
      notifications.push({
        frame: view?.selectedFrame ?? null,
        node: view?.selectedNodeId ?? null,
      });
    });

    store.setSelection("workspace-a", "home.html", "hero-heading");
    store.setSelectedFrame("workspace-a", "pricing.html");
    unsubscribe();

    expect(notifications).toEqual([
      { frame: "home.html", node: "hero-heading" },
      { frame: "pricing.html", node: null },
    ]);
  });

  it("validates remembered selection only against an authoritative frame list", () => {
    useDesignWorkspaceUiStore
      .getState()
      .setSelectedFrame("workspace-a", "removed.html");

    expect(
      validateDesignWorkspaceSelection("workspace-a", [
        "home.html",
        "pricing.html",
      ]),
    ).toBe("home.html");
    expect(designWorkspaceView("workspace-a").selectedFrame).toBe("home.html");
    expect(validateDesignWorkspaceSelection("workspace-a", [])).toBeNull();
    expect(designWorkspaceView("workspace-a").selectedFrame).toBeNull();
  });

  it("bounds persisted owners and forgets a permanently deleted workspace", () => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const store = useDesignWorkspaceUiStore.getState();
    for (let index = 0; index < 35; index += 1) {
      store.setPanel(`workspace-${index}`, "assets");
    }

    const owners = Object.keys(
      useDesignWorkspaceUiStore.getState().byWorkspace,
    );
    expect(owners).toHaveLength(32);
    expect(owners).not.toContain("workspace-0");
    expect(owners).toContain("workspace-34");

    forgetDesignWorkspaceView("workspace-34");
    expect(designWorkspaceView("workspace-34").panel).toBe("layers");
  });
});
