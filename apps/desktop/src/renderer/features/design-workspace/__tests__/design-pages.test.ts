import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignPageSummary } from "@zeros/protocol/design-pages";
import type {
  DesignCanvasFrameWire,
  DesignWorkspaceSnapshotWire,
} from "../../../platform/git";
import {
  bindDesignWorkspacePages,
  captureDesignPageOwner,
  designWorkspaceView,
  isCurrentDesignPageOwner,
  normalizeDesignWorkspaceView,
  resetDesignWorkspaceUiForTests,
  useDesignWorkspaceUiStore,
} from "../state/design-workspace-ui";
import { createDesignPageProjection } from "../state/design-page-projection";

const pages: DesignPageSummary[] = [
  {
    id: "page_a",
    title: "Alpha",
    folder: "alpha",
    frameFiles: ["alpha/home.html"],
  },
  {
    id: "page_b",
    title: "Beta",
    folder: "beta",
    frameFiles: ["beta/home.html"],
  },
];
const workspaceId = "workspace-pages";
const directoryId = "design_pages";
const bind = (catalog = pages, settled = true) =>
  bindDesignWorkspacePages(workspaceId, directoryId, catalog, settled);

describe("Design page view memory", () => {
  beforeEach(() => resetDesignWorkspaceUiForTests());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("switches A to B to A in one notification and restores camera, selection, source and background", () => {
    bind();
    const store = useDesignWorkspaceUiStore.getState();
    store.setSelection(workspaceId, "alpha/home.html", "heading", [
      "heading",
      "copy",
    ]);
    store.setViewport(workspaceId, { zoom: 0.8, panX: 120, panY: 240 });
    store.setCodeView(workspaceId, true);
    store.setCanvasBackground(workspaceId, "#336699"); // check:ui ignore-line -- authored page-color fixture.
    const notifications: string[] = [];
    const unsubscribe = useDesignWorkspaceUiStore.subscribe((state) => {
      notifications.push(state.byWorkspace[workspaceId].activePageId!);
    });
    store.setActivePage(workspaceId, "page_b", directoryId);
    expect(notifications).toEqual(["page_b"]);
    expect(designWorkspaceView(workspaceId)).toMatchObject({
      activePageId: "page_b",
      zoom: 0.25,
      canvasBackground: null,
      codeView: false,
      selectedNodeId: null,
    });
    store.setSelection(workspaceId, "beta/home.html", null, undefined, {
      frameSelected: true,
    });
    store.setViewport(workspaceId, { zoom: 1.5, panX: -20, panY: 64 });
    store.setCanvasBackground(workspaceId, "#998877"); // check:ui ignore-line -- authored page-color fixture.
    store.setActivePage(workspaceId, "page_a", directoryId);
    expect(designWorkspaceView(workspaceId)).toMatchObject({
      activePageId: "page_a",
      zoom: 0.8,
      panX: 120,
      panY: 240,
      selectedFrame: "alpha/home.html",
      selectedNodeId: "heading",
      selectedNodeIds: ["heading", "copy"],
      codeView: true,
      canvasBackground: "#336699", // check:ui ignore-line -- authored page-color fixture.
    });
    store.setActivePage(workspaceId, "page_b", directoryId);
    expect(designWorkspaceView(workspaceId)).toMatchObject({
      zoom: 1.5,
      panX: -20,
      selectedFrame: "beta/home.html",
      frameSelected: true,
      canvasBackground: "#998877", // check:ui ignore-line -- authored page-color fixture.
    }); // check:ui ignore-line -- authored page-color fixture.
    unsubscribe();
  });

  it("persists and synchronously reloads the active page and both views under the existing storage key", async () => {
    vi.useFakeTimers();
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      addEventListener: vi.fn(),
    });
    bind();
    const store = useDesignWorkspaceUiStore.getState();
    store.setViewport(workspaceId, { zoom: 0.7, panX: 80, panY: 160 });
    store.setActivePage(workspaceId, "page_b", directoryId);
    store.setViewport(workspaceId, { zoom: 2, panX: 10, panY: 20 });
    store.setSelection(workspaceId, "beta/home.html", "title");
    store.setCanvasBackground(workspaceId, "#102030"); // check:ui ignore-line -- authored page-color fixture.
    vi.advanceTimersByTime(150);
    expect(storage.has("zeros:design-workspace-ui-v1")).toBe(true);
    vi.resetModules();
    const reloaded = await import("../state/design-workspace-ui");
    expect(reloaded.designWorkspaceView(workspaceId)).toMatchObject({
      activePageId: "page_b",
      zoom: 2,
      selectedNodeId: "title",
      canvasBackground: "#102030", // check:ui ignore-line -- authored page-color fixture.
    }); // check:ui ignore-line -- authored page-color fixture.
    reloaded.useDesignWorkspaceUiStore
      .getState()
      .setActivePage(workspaceId, "page_a", directoryId);
    expect(reloaded.designWorkspaceView(workspaceId)).toMatchObject({
      zoom: 0.7,
      panX: 80,
      panY: 160,
    });
    reloaded.resetDesignWorkspaceUiForTests();
  });

  it("lifts legacy flat fields into the first confirmed page once", () => {
    const store = useDesignWorkspaceUiStore.getState();
    store.setSelection(workspaceId, "alpha/home.html", "legacy");
    store.setViewport(workspaceId, { zoom: 0.6, panX: 44, panY: 88 });
    bind(pages, false);
    expect(designWorkspaceView(workspaceId).activePageId).toBeUndefined();
    bind();
    expect(designWorkspaceView(workspaceId)).toMatchObject({
      activePageId: "page_a",
      zoom: 0.6,
      selectedNodeId: "legacy",
    });
    store.setActivePage(workspaceId, "page_b", directoryId);
    bind();
    expect(designWorkspaceView(workspaceId)).toMatchObject({
      activePageId: "page_b",
      zoom: 0.25,
      selectedNodeId: null,
    });
    store.setActivePage(workspaceId, "page_a", directoryId);
    expect(designWorkspaceView(workspaceId)).toMatchObject({
      zoom: 0.6,
      selectedNodeId: "legacy",
    });
  });

  it("keeps a remembered page through cold data and prunes/falls back only after the matching catalog settles", () => {
    bind();
    const store = useDesignWorkspaceUiStore.getState();
    store.setViewport(workspaceId, { zoom: 0.75, panX: 10, panY: 40 });
    store.setActivePage(workspaceId, "page_b", directoryId);
    store.setViewport(workspaceId, { zoom: 2, panX: 200, panY: 400 });
    const previous = designWorkspaceView(workspaceId);
    bind([], false);
    bind([pages[0]], false);
    expect(designWorkspaceView(workspaceId)).toBe(previous);
    bind([pages[0]]);
    expect(designWorkspaceView(workspaceId)).toMatchObject({
      activePageId: "page_a",
      zoom: 0.75,
      panX: 10,
      panY: 40,
    });
    expect(Object.keys(designWorkspaceView(workspaceId).byPage!)).toEqual([
      "page_a",
    ]);
  });

  it("prunes remembered frame selections against their own settled page", () => {
    bind();
    const store = useDesignWorkspaceUiStore.getState();
    store.setSelection(workspaceId, "alpha/home.html", "title");
    store.setCodeView(workspaceId, true);
    store.setActivePage(workspaceId, "page_b", directoryId);
    bind([{ ...pages[0], frameFiles: [] }, pages[1]]);
    store.setActivePage(workspaceId, "page_a", directoryId);
    expect(designWorkspaceView(workspaceId)).toMatchObject({
      selectedFrame: null,
      selectedNodeId: null,
      selectedNodeIds: [],
      codeView: false,
    });
  });

  it("bounds view memory to 32 recent pages and retains the active page", () => {
    let clock = 1;
    vi.spyOn(Date, "now").mockImplementation(() => clock++);
    const catalog = Array.from({ length: 40 }, (_, index) => ({
      id: `page_${index}`,
      title: `Page ${index}`,
      folder: `page-${index}`,
      frameFiles: [],
    }));
    bind(catalog);
    const store = useDesignWorkspaceUiStore.getState();
    for (const page of catalog)
      store.setActivePage(workspaceId, page.id, directoryId);
    const view = designWorkspaceView(workspaceId);
    expect(Object.keys(view.byPage!)).toHaveLength(32);
    expect(view.byPage).not.toHaveProperty("page_0");
    expect(view.byPage).toHaveProperty("page_39");
    store.setActivePage(workspaceId, "page_0", directoryId);
    expect(designWorkspaceView(workspaceId).activePageId).toBe("page_0");
    expect(Object.keys(designWorkspaceView(workspaceId).byPage!)).toHaveLength(
      32,
    );
  });

  it("resets page memory when the bound directory changes", () => {
    bind();
    const store = useDesignWorkspaceUiStore.getState();
    store.setActivePage(workspaceId, "page_b", directoryId);
    store.setViewport(workspaceId, { zoom: 2, panX: 200, panY: 400 });
    bindDesignWorkspacePages(workspaceId, "design_replacement", [
      { id: "other", title: "Other", folder: "other", frameFiles: [] },
    ]);
    expect(designWorkspaceView(workspaceId)).toMatchObject({
      directoryId: "design_replacement",
      activePageId: "other",
      zoom: 0.25,
      panX: 64,
      panY: 96,
    });
    expect(Object.keys(designWorkspaceView(workspaceId).byPage!)).toEqual([
      "other",
    ]);
    store.setActivePage(workspaceId, "page_a", directoryId);
    expect(designWorkspaceView(workspaceId).activePageId).toBe("other");
  });

  it("rejects late selection/camera replies belonging to a different page or directory", async () => {
    bind();
    const owner = captureDesignPageOwner(workspaceId);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      const store = useDesignWorkspaceUiStore.getState();
      store.setSelection(workspaceId, "alpha/home.html", "late", undefined, {
        owner,
      });
      store.setViewport(workspaceId, { zoom: 3, panX: 300, panY: 600 }, owner);
    });
    useDesignWorkspaceUiStore
      .getState()
      .setActivePage(workspaceId, "page_b", directoryId);
    const otherPage = designWorkspaceView(workspaceId);
    expect(isCurrentDesignPageOwner(owner)).toBe(false);
    release();
    await pending;
    expect(designWorkspaceView(workspaceId)).toBe(otherPage);
    const secondOwner = captureDesignPageOwner(workspaceId);
    bindDesignWorkspacePages(workspaceId, "design_other", pages);
    expect(isCurrentDesignPageOwner(secondOwner)).toBe(false);
    useDesignWorkspaceUiStore
      .getState()
      .setSelectedFrame(workspaceId, null, secondOwner);
    expect(designWorkspaceView(workspaceId).directoryId).toBe("design_other");
  });

  it("commits a background blur to its captured page without painting or selecting the next page", () => {
    bind();
    const owner = captureDesignPageOwner(workspaceId);
    const store = useDesignWorkspaceUiStore.getState();
    store.setActivePage(workspaceId, "page_b", directoryId);
    const before = designWorkspaceView(workspaceId);
    store.setCanvasBackground(workspaceId, "#123456", owner); // check:ui ignore-line -- authored page-color fixture.
    const after = designWorkspaceView(workspaceId);
    expect(after).toMatchObject({
      activePageId: "page_b",
      canvasBackground: null,
    });
    expect(after.byPage!.page_b).toBe(before.byPage!.page_b);
    store.setActivePage(workspaceId, "page_a", directoryId);
    expect(designWorkspaceView(workspaceId).canvasBackground).toBe("#123456"); // check:ui ignore-line -- authored page-color fixture.
  });

  it("does not accept another workspace's otherwise-current owner", () => {
    bind();
    bindDesignWorkspacePages("other", directoryId, pages);
    const owner = captureDesignPageOwner("other");
    const before = designWorkspaceView(workspaceId);
    const store = useDesignWorkspaceUiStore.getState();
    store.setSelection(workspaceId, "alpha/home.html", "wrong", undefined, {
      owner,
    });
    store.setViewport(workspaceId, { zoom: 3, panX: 3, panY: 3 }, owner);
    store.setCanvasBackground(workspaceId, "#123456", owner); // check:ui ignore-line -- authored page-color fixture.
    expect(designWorkspaceView(workspaceId)).toBe(before);
  });

  it("normalizes persisted page memory and bounds corrupt or excessive records", () => {
    const byPage = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `page_${index}`,
        { zoom: index + 1, updatedAt: index },
      ]),
    );
    byPage["../outside"] = { zoom: 2, updatedAt: 100 };
    const normalized = normalizeDesignWorkspaceView({
      activePageId: "page_0",
      byPage,
    });
    expect(Object.keys(normalized.byPage!)).toHaveLength(32);
    expect(normalized.byPage).toHaveProperty("page_0");
    expect(normalized.byPage).not.toHaveProperty("../outside");
    expect(
      normalizeDesignWorkspaceView({
        activePageId: "\u0000invalid",
        byPage: [],
      }).activePageId,
    ).toBeUndefined();
  });
});

describe("Design page snapshot projection", () => {
  const frameA = {
    file: "alpha/home.html",
    pageId: "page_a",
    title: "A",
  } as DesignCanvasFrameWire;
  const frameB = {
    file: "beta/home.html",
    pageId: "page_b",
    title: "B",
  } as DesignCanvasFrameWire;
  const snapshot = {
    directoryId,
    directory: "Design",
    pages,
    frames: [frameA, frameB],
    tokens: [],
    assets: [],
    lint: { violations: [] },
  } as unknown as DesignWorkspaceSnapshotWire;

  it("retains frame and projection references across switches and unrelated frame changes", () => {
    const project = createDesignPageProjection();
    const alpha = project(snapshot, "page_a")!;
    const beta = project(snapshot, "page_b")!;
    expect(alpha.frames).toEqual([frameA]);
    expect(beta.frames).toEqual([frameB]);
    expect(project(snapshot, "page_a")).toBe(alpha);
    expect(alpha.frames[0]).toBe(frameA);
    const changed = {
      ...snapshot,
      frames: [frameA, { ...frameB, title: "Changed" }],
    };
    expect(project(changed, "page_a")!.frames).toBe(alpha.frames);
    expect(project(changed, "page_b")!.frames).not.toBe(beta.frames);
    expect(project(undefined, "page_a")).toBeUndefined();
  });

  it("normalizes an older engine to one legacy page and uses the first page for a missing remembered id", () => {
    const project = createDesignPageProjection();
    const legacy = {
      ...snapshot,
      pages: undefined,
      frames: [{ ...frameA, file: "home.html", pageId: undefined }],
    };
    expect(project(legacy, undefined)).toMatchObject({
      pages: [{ id: "main", folder: "", frameFiles: ["home.html"] }],
      frames: [{ file: "home.html", pageId: "main" }],
    });
    expect(project(snapshot, "removed")!.frames).toEqual([frameA]);
  });
});
