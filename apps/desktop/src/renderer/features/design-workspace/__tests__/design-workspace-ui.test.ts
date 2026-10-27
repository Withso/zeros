import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampDesignZoom,
  designWorkspaceView,
  forgetDesignWorkspaceView,
  normalizeDesignWorkspaceView,
  resetDesignWorkspaceUiForTests,
  useDesignWorkspaceUiStore,
  bindDesignWorkspacePages,
  designSelectionUnchangedSince,
} from "../state/design-workspace-ui";

describe("design workspace UI memory", () => {
  it("preserves exact nested frame selection and rejects unsafe aliases", () => {
    expect(normalizeDesignWorkspaceView({ selectedFrame: "page-1/home.html", selectedNodeId: "title" })).toMatchObject({
      selectedFrame: "page-1/home.html", selectedNodeId: "title",
    });
    for (const selectedFrame of ["page-1/sub/home.html", "meta/home.html", "page-1%2fhome.html"])
      expect(normalizeDesignWorkspaceView({ selectedFrame }).selectedFrame).toBeNull();
  });
  beforeEach(() => {
    resetDesignWorkspaceUiForTests();
    vi.restoreAllMocks();
  });

  it("treats any explicit selection made since a snapshot as a newer choice, even back to the same target", () => {
    // A deferred automatic selection (a newly created frame) must not override
    // what the person chose meanwhile, including choosing the same layer again.
    const store = useDesignWorkspaceUiStore.getState();
    store.setSelection("ws", "home.html", "heading", undefined, {});
    const before = designWorkspaceView("ws");
    expect(designSelectionUnchangedSince("ws", before)).toBe(true);
    store.setSelection("ws", "pricing.html", null, undefined, { frameSelected: true });
    store.setSelection("ws", "home.html", "heading", undefined, {});
    expect(designWorkspaceView("ws").selectedNodeId).toBe(before.selectedNodeId);
    expect(designSelectionUnchangedSince("ws", before)).toBe(false);
    // Background republication of the same selection is not a new choice.
    const settled = designWorkspaceView("ws");
    store.setSelection("ws", "home.html", "heading", undefined, { explicit: false });
    expect(designSelectionUnchangedSince("ws", settled)).toBe(true);
    store.setSelectedFrame("ws", null);
    expect(designSelectionUnchangedSince("ws", settled)).toBe(false);
  });

  it("drops retired source-view flags without resetting saved navigation", () => {
    const savedView = {
      selectedFrame: "alpha/home.html",
      selectedNodeId: "heading",
      zoom: 0.8,
      panX: 120,
      panY: 240,
    };
    const legacy = normalizeDesignWorkspaceView({
      ...savedView,
      codeView: true,
    });
    expect(legacy).toMatchObject(savedView);
    expect(legacy).not.toHaveProperty("codeView");

    const paged = normalizeDesignWorkspaceView({
      ...savedView,
      codeView: true,
      directoryId: "design_pages",
      activePageId: "page_a",
      byPage: {
        page_a: { ...savedView, codeView: true },
        page_b: { selectedFrame: "beta/home.html", zoom: 1.5, codeView: true },
      },
    });
    expect(paged).toMatchObject({
      ...savedView,
      directoryId: "design_pages",
      activePageId: "page_a",
      byPage: {
        page_a: savedView,
        page_b: { selectedFrame: "beta/home.html", zoom: 1.5 },
      },
    });
    expect(paged).not.toHaveProperty("codeView");
    for (const page of Object.values(paged.byPage!)) {
      expect(page).not.toHaveProperty("codeView");
    }
  });

  it("normalizes corrupt persisted values and clamps zoom", () => {
    expect(clampDesignZoom(Number.NaN)).toBe(0.25);
    expect(clampDesignZoom(0)).toBe(0.01);
    expect(clampDesignZoom(0.005)).toBe(0.01);
    expect(clampDesignZoom(4)).toBe(4);
    expect(clampDesignZoom(8)).toBe(8);
    expect(clampDesignZoom(8.01)).toBe(8);
    expect(clampDesignZoom(512)).toBe(8);
    expect(
      normalizeDesignWorkspaceView({
        selectedFrame: "../outside.html",
        selectedNodeId: "\u0000not-an-oid",
        selectedNodeIds: ["valid", "valid", "\u0000invalid"],
        panel: "unknown",
        activeTheme: "Not valid!",
        canvasBackground: "not a color",
        zoom: Number.POSITIVE_INFINITY,
        panX: Number.NaN,
        panY: 18,
        updatedAt: -1,
      }),
    ).toEqual({
      layersVisible: true,
      inspectorVisible: true,
      selectedFrame: null,
      frameSelected: false,
      selectedNodeId: null,
      selectedNodeIds: [],
      selectedTargets: [],
      panel: "layers",
      activeTheme: null,
      canvasBackground: null,
      zoom: 0.25,
      panX: 64,
      panY: 18,
      updatedAt: 0,
    });
  });

  it("restores old extreme cameras at 800 percent without losing the world origin", () => {
    const restored = normalizeDesignWorkspaceView({
      zoom: 256, panX: -64_000, panY: -32_000,
      directoryId: "design_pages", activePageId: "page_a",
      byPage: {
        page_a: { zoom: 256, panX: -64_000, panY: -32_000 },
        page_b: { zoom: 16, panX: 80, panY: -160 },
      },
    });
    expect(restored).toMatchObject({ zoom: 8, panX: -2000, panY: -1000 });
    expect(restored.byPage!.page_a).toMatchObject({ zoom: 8, panX: -2000, panY: -1000 });
    expect(restored.byPage!.page_b).toMatchObject({ zoom: 8, panX: 40, panY: -80 });
  });

  it.each(["personal-workspace", "organization-local-workspace"])(
    "bounds direct camera updates at 800 percent in %s", workspaceId => {
      useDesignWorkspaceUiStore.getState().setViewport(workspaceId, { zoom: 16, panX: -320, panY: 160 });
      expect(designWorkspaceView(workspaceId)).toMatchObject({ zoom: 8, panX: -160, panY: 80 });
    },
  );

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

  it("validates remembered selection only against a settled page catalog", () => {
    useDesignWorkspaceUiStore
      .getState()
      .setSelectedFrame("workspace-a", "removed.html");

    const pages = [{
      id: "main",
      title: "Page 1",
      folder: "",
      frameFiles: ["home.html", "pricing.html"],
    }];
    bindDesignWorkspacePages("workspace-a", undefined, pages, false);
    expect(designWorkspaceView("workspace-a").selectedFrame).toBe(
      "removed.html",
    );
    bindDesignWorkspacePages("workspace-a", undefined, pages);
    expect(designWorkspaceView("workspace-a").selectedFrame).toBe("home.html");
    bindDesignWorkspacePages("workspace-a", undefined, [{
      ...pages[0],
      frameFiles: [],
    }]);
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
  it("preserves panels and navigation for the same directory and clears replaced document selections", () => {
    const store = useDesignWorkspaceUiStore.getState();
    store.setSelection("workspace-a", "home.html", "hero");
    store.bindDirectory("workspace-a", "design_first");
    store.setPanels("workspace-a", { layersVisible: false, inspectorVisible: false });
    store.setViewport("workspace-a", { zoom: 0.5, panX: 20, panY: 40 });
    store.bindDirectory("workspace-a", "design_first");
    expect(designWorkspaceView("workspace-a")).toMatchObject({ selectedNodeId: "hero", layersVisible: false, inspectorVisible: false, zoom: 0.5 });
    store.bindDirectory("workspace-b", "design_second");
    expect(designWorkspaceView("workspace-b").selectedFrame).toBeNull();
    expect(designWorkspaceView("workspace-a").selectedFrame).toBe("home.html");
    store.bindDirectory("workspace-a", "design_replacement");
    expect(designWorkspaceView("workspace-a")).toMatchObject({ directoryId: "design_replacement", selectedFrame: null, selectedNodeId: null, zoom: 0.25 });
  });

});
