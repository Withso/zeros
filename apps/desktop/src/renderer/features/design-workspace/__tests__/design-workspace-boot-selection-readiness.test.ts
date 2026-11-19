// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";
import type { DesignPageSummary } from "@zeros/protocol/design-pages";

const platform = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
  readNavigation: vi.fn(async () => null),
  selectPage: vi.fn(async () => {}),
  setSelection: vi.fn(async () => {}),
  setScreenshot: vi.fn(async () => {}),
  setRuntimeAudit: vi.fn(async () => {}),
  provenance: vi.fn(),
  frameRuntime: vi.fn(),
  canvasSnapshot: undefined as unknown,
  canvasLoading: false,
}));

vi.mock("../../../platform/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform/git")>()),
  designSnapshot: platform.readSnapshot,
  designSelectPage: platform.selectPage,
  designSetSelection: platform.setSelection,
  designSetScreenshot: platform.setScreenshot,
  designSetRuntimeAudit: platform.setRuntimeAudit,
  designProvenance: platform.provenance,
}));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: platform.frameRuntime }));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => null,
  onActiveBridgeConnected: () => () => {},
}));
vi.mock("../../../shell/use-git-refresh-key", () => ({ useGitRefreshKey: () => 0 }));
vi.mock("../state/design-workspace-preparation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/design-workspace-preparation")>()),
  readDesignNavigation: platform.readNavigation,
}));
vi.mock("../../../shared/ui/primitives/elements/toast", () => ({ toast: { info: vi.fn() } }));
vi.mock("../../../shared/ui/primitives", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("../../../shared/theme/use-theme-variant", () => ({ useThemeId: () => null }));
vi.mock("../../../state/pending-workspaces", () => ({ clearWorkspaceSettling: vi.fn() }));
vi.mock("../../../state/use-document-active", () => ({ useDocumentActive: (active: boolean) => active }));
vi.mock("../../../state/design-sync-intent", () => ({ takeDesignSyncAgentRequest: () => false }));
vi.mock("../design-agent-sync", () => ({ useAskDesignAgent: () => () => {} }));
vi.mock("../state/design-history-commands", () => ({ markDesignHistoryPortal: vi.fn() }));
vi.mock("../state/design-history-presentation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/design-history-presentation")>()),
  clearDesignHistoryPresentation: vi.fn(),
  useDesignHistoryPresentation: () => null,
  useDesignHistorySelection: () => null,
}));
vi.mock("../state/use-design-style-build-presence", () => ({ useDesignStyleBuildPresence: vi.fn() }));
vi.mock("../state/design-agent-drafts", () => ({ startDesignAgentDraftEvents: () => () => {} }));
vi.mock("../state/use-design-lifecycle-feedback", () => ({ useDesignLifecycleFeedback: vi.fn() }));
vi.mock("../state/design-component-variants", () => ({ pruneDesignComponentVariantsFor: vi.fn() }));
vi.mock("../design-component-options-loader", () => ({ loadDesignComponentOptions: vi.fn(async () => {}) }));
vi.mock("../design-canvas", () => ({
  DesignCanvas: (props: { snapshot?: unknown }) => {
    platform.canvasSnapshot = props.snapshot;
    platform.canvasLoading = Boolean((props as { loading?: boolean }).loading);
    return null;
  },
  EMPTY_NODE_IDS: [],
}));
vi.mock("../design-directory-pill", () => ({ DesignDirectoryPill: () => null }));
vi.mock("../design-frame-changes-panel", () => ({ DesignFrameChangesPanel: () => null }));
vi.mock("../design-frame-delete-dialog", () => ({ DesignFrameDeleteDialog: () => null }));
vi.mock("../design-inspector", () => ({ DesignInspector: () => null }));
vi.mock("../design-workspace-sidebar-panels", () => ({ DesignWorkspaceSidebarPanels: () => null }));
vi.mock("../design-floating-panel", async () => {
  const react = await import("react");
  return {
    DesignFloatingPanel: react.forwardRef<HTMLDivElement, { inspector: import("react").ReactNode }>(
      ({ inspector }, ref) => react.createElement("div", { ref }, inspector),
    ),
  };
});

const WORKSPACE_ID = "personal-local-workspace";
const OTHER_WORKSPACE_ID = "organization-local-workspace";
const DIRECTORY_ID = "design_test";
const OTHER_DIRECTORY_ID = "design_org";
const PAGE_ID = "page4";
const OTHER_PAGE_ID = "page3";
const BASE_FRAME = "page4/card.html";
const COPY_FRAME = "page4/card-copy-copy.html";
const OTHER_FRAME = "page3/main.html";
const BOOT_STORAGE_KEY = "design-workspace-snapshots-v1";

function frame(file: string, pageId: string, frameId: string) {
  return {
    file,
    pageId,
    frameId,
    title: file.split("/").at(-1)!.replace(".html", ""),
    kind: "frame" as const,
    width: 1440,
    height: 900,
    x: 0,
    y: 0,
    z: 0,
    nodeCount: 1,
    modifiedAt: 1,
    sourceVersion: "a".repeat(24),
  };
}

function page(id: string, files: string[]): DesignPageSummary {
  return {
    id,
    title: id === PAGE_ID ? "Page 4" : "Page 3",
    folder: id,
    frameFiles: files,
    frameIds: files.map((file) => file.split("/").at(-1)!.replace(".html", "").replaceAll("-", "_")),
  };
}

function workspaceSnapshot(pages: DesignPageSummary[], directoryId = DIRECTORY_ID): DesignWorkspaceSnapshotWire {
  const frames = pages.flatMap((entry) => entry.frameFiles.map((file, index) =>
    frame(file, entry.id, entry.frameIds?.[index] ?? file.replaceAll("/", "_")),
  ));
  return {
    protocolCapability: "c".repeat(64),
    directoryId,
    directory: "/repo/design",
    pages,
    frames,
    tokens: [],
    tokenSourceVersion: "tokens",
    assets: [],
    lint: { workspacePath: "/repo", checkedFiles: [], violations: [], healedOids: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

let container: HTMLDivElement;
let root: Root;
let cacheForCleanup: { resetDesignWorkspaceCacheForTests(): void } | undefined;
let uiStoresForCleanup: Array<{ resetDesignWorkspaceUiForTests(): void }> = [];

beforeEach(() => {
  cacheForCleanup = undefined;
  uiStoresForCleanup = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetModules();
  window.localStorage.clear();
  platform.readSnapshot.mockReset();
  platform.readNavigation.mockReset().mockResolvedValue(null);
  platform.selectPage.mockReset().mockResolvedValue(undefined);
  platform.canvasSnapshot = undefined;
  platform.canvasLoading = false;
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  cacheForCleanup?.resetDesignWorkspaceCacheForTests();
  cacheForCleanup = undefined;
  for (const ui of uiStoresForCleanup) ui.resetDesignWorkspaceUiForTests();
  uiStoresForCleanup = [];
  window.localStorage.clear();
  vi.resetModules();
  vi.unstubAllGlobals();
});

async function seedRendererReload(
  boot: DesignWorkspaceSnapshotWire,
  selection: {
    frame: string;
    nodeId?: string | null;
    nodeIds?: string[];
    frameSelected?: boolean;
  } = { frame: COPY_FRAME, frameSelected: true },
) {
  const settings = await import("../../../platform/settings");
  settings.setSetting(BOOT_STORAGE_KEY, {
    version: 1,
    entries: { [WORKSPACE_ID]: { updatedAt: 1_795_099_655_920, snapshot: boot } },
  });

  const initialUi = await import("../state/design-workspace-ui");
  uiStoresForCleanup.push(initialUi);
  initialUi.bindDesignWorkspacePages(WORKSPACE_ID, DIRECTORY_ID, [
    page(OTHER_PAGE_ID, [OTHER_FRAME]),
    page(PAGE_ID, [BASE_FRAME, COPY_FRAME]),
  ]);
  initialUi.useDesignWorkspaceUiStore.getState().setActivePage(WORKSPACE_ID, PAGE_ID, DIRECTORY_ID);
  const owner = initialUi.captureDesignPageOwner(WORKSPACE_ID);
  initialUi.useDesignWorkspaceUiStore.getState().setSelection(WORKSPACE_ID, selection.frame, selection.nodeId ?? null, selection.nodeIds, {
    owner,
    frameSelected: selection.frameSelected,
  });
  initialUi.useDesignWorkspaceUiStore.getState().setViewport(WORKSPACE_ID, {
    zoom: 0.43,
    panX: 217,
    panY: 136,
  }, owner);
  window.dispatchEvent(new Event("beforeunload"));
  vi.resetModules();
}

async function mountWorkspace(workspaceId = WORKSPACE_ID) {
  const cache = await import("../state/design-workspace-cache");
  cacheForCleanup = cache;
  const ui = await import("../state/design-workspace-ui");
  uiStoresForCleanup.push(ui);
  const { DesignWorkspaceColumn } = await import("../design-workspace");
  const snapshot = cache.designWorkspaceSnapshotCache.peekSnapshot(workspaceId);
  const { isDesignWorkspaceBootPreview } = await import("../state/design-workspace-boot-cache");
  const { createDesignPageProjection } = await import("../state/design-page-projection");
  const pageProjection = snapshot.data ? createDesignPageProjection()(snapshot.data, PAGE_ID) : undefined;
  const initialReadStatus = {
    loading: snapshot.loading,
    refreshing: snapshot.refreshing,
    error: snapshot.error,
    invalidationVersion: snapshot.invalidationVersion,
  };

  const transitions: Array<{
    selectedFrame: string | null;
    activePageId?: string;
    zoom: number;
    panX: number;
    panY: number;
    loading: boolean;
    refreshing: boolean;
    invalidationVersion: number;
  }> = [];
  let last = ui.designWorkspaceView(workspaceId);
  const unsubscribe = ui.useDesignWorkspaceUiStore.subscribe((state) => {
    const current = state.byWorkspace[workspaceId];
    if (!current || current === last) return;
    last = current;
    const read = cache.designWorkspaceSnapshotCache.peekSnapshot(workspaceId);
    transitions.push({
      selectedFrame: current.selectedFrame,
      activePageId: current.activePageId,
      zoom: current.zoom,
      panX: current.panX,
      panY: current.panY,
      loading: read.loading,
      refreshing: read.refreshing,
      invalidationVersion: read.invalidationVersion,
    });
  });

  await act(async () => {
    root.render(createElement(DesignWorkspaceColumn, {
      workspace: { id: workspaceId } as never,
      folder: "/repo",
      surfaceActive: true,
    }));
  });

  return {
    cache,
    ui,
    bootSnapshot: snapshot.data,
    initialReadStatus,
    bootPreview: snapshot.data ? isDesignWorkspaceBootPreview(snapshot.data) : false,
    projectedBootPreview: pageProjection ? isDesignWorkspaceBootPreview(pageProjection) : false,
    layoutTransitions: transitions,
    unsubscribe,
  };
}

describe("Design selection validation against a boot preview", () => {
  it("does not prune a newer selected copy before the deferred live catalog resolves", async () => {
    const boot = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME]),
    ]);
    const live = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME, COPY_FRAME]),
    ]);
    const pending = deferred<DesignWorkspaceSnapshotWire>();
    platform.readSnapshot.mockImplementation(() => pending.promise);
    await seedRendererReload(boot);

    const mounted = await mountWorkspace();
    const beforePassiveLoad = mounted.layoutTransitions.find((transition) => transition.selectedFrame !== COPY_FRAME);
    expect(mounted.bootPreview).toBe(true);
    expect(mounted.projectedBootPreview).toBe(false);
    expect(mounted.initialReadStatus).toMatchObject({ loading: false, refreshing: false, error: null, invalidationVersion: 1 });
    expect(beforePassiveLoad).toBeUndefined();
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({
      directoryId: DIRECTORY_ID,
      activePageId: PAGE_ID,
      selectedFrame: COPY_FRAME,
      frameSelected: true,
      selectedTargets: [{ frame: COPY_FRAME }],
      zoom: 0.43,
      panX: 217,
      panY: 136,
    });
    expect(mounted.cache.designWorkspaceSnapshotCache.peekSnapshot(WORKSPACE_ID)).toMatchObject({
      loading: false,
      refreshing: true,
      error: null,
    });

    await act(async () => {
      pending.resolve(live);
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    mounted.unsubscribe();
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({
      selectedFrame: COPY_FRAME,
      frameSelected: true,
      selectedTargets: [{ frame: COPY_FRAME }],
    });
  });

  it("prunes a genuinely missing frame only after the authoritative read settles", async () => {
    const boot = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME, COPY_FRAME]),
    ]);
    const live = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME]),
    ]);
    const pending = deferred<DesignWorkspaceSnapshotWire>();
    platform.readSnapshot.mockImplementation(() => pending.promise);
    await seedRendererReload(boot);

    const mounted = await mountWorkspace();
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({
      activePageId: PAGE_ID,
      selectedFrame: COPY_FRAME,
      selectedTargets: [{ frame: COPY_FRAME }],
    });

    await act(async () => {
      pending.resolve(live);
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    mounted.unsubscribe();
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({
      directoryId: DIRECTORY_ID,
      activePageId: PAGE_ID,
      selectedFrame: BASE_FRAME,
      frameSelected: false,
      selectedTargets: [],
      zoom: 0.43,
      panX: 217,
      panY: 136,
    });
  });

  it("retains nested multi-node selection through stale boot and deferred live catalog", async () => {
    const boot = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME]),
    ]);
    const live = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME, COPY_FRAME]),
    ]);
    const pending = deferred<DesignWorkspaceSnapshotWire>();
    platform.readSnapshot.mockImplementation(() => pending.promise);
    await seedRendererReload(boot, {
      frame: COPY_FRAME,
      nodeId: "copy-heading",
      nodeIds: ["copy-heading", "copy-label"],
    });

    const mounted = await mountWorkspace();
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({
      activePageId: PAGE_ID,
      selectedFrame: COPY_FRAME,
      frameSelected: false,
      selectedNodeId: "copy-heading",
      selectedNodeIds: ["copy-heading", "copy-label"],
      selectedTargets: [
        { frame: COPY_FRAME, nodeId: "copy-heading" },
        { frame: COPY_FRAME, nodeId: "copy-label" },
      ],
      zoom: 0.43,
      panX: 217,
      panY: 136,
    });
    expect(mounted.layoutTransitions.find((transition) => transition.selectedFrame !== COPY_FRAME)).toBeUndefined();

    await act(async () => {
      pending.resolve(live);
      await pending.promise;
      await flushMicrotasks();
    });
    mounted.unsubscribe();
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({
      selectedFrame: COPY_FRAME,
      frameSelected: false,
      selectedNodeId: "copy-heading",
      selectedNodeIds: ["copy-heading", "copy-label"],
      selectedTargets: [
        { frame: COPY_FRAME, nodeId: "copy-heading" },
        { frame: COPY_FRAME, nodeId: "copy-label" },
      ],
    });
  });

  it("keeps a newly selected page and its viewport when the boot catalog omits that page", async () => {
    const boot = workspaceSnapshot([page(OTHER_PAGE_ID, [OTHER_FRAME])]);
    const live = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME, COPY_FRAME]),
    ]);
    const pending = deferred<DesignWorkspaceSnapshotWire>();
    platform.readSnapshot.mockImplementation(() => pending.promise);
    await seedRendererReload(boot);

    const mounted = await mountWorkspace();
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({
      directoryId: DIRECTORY_ID,
      activePageId: PAGE_ID,
      selectedFrame: COPY_FRAME,
      frameSelected: true,
      zoom: 0.43,
      panX: 217,
      panY: 136,
    });
    expect(platform.selectPage).not.toHaveBeenCalled();
    expect(platform.canvasSnapshot).toBeUndefined();

    await act(async () => {
      pending.resolve(live);
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    mounted.unsubscribe();
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({ activePageId: PAGE_ID, selectedFrame: COPY_FRAME });
    expect((platform.canvasSnapshot as DesignWorkspaceSnapshotWire).frames.map((frame) => frame.pageId)).toEqual([PAGE_ID, PAGE_ID]);
  });

  it("does not let a boot preview for an old directory reset the current exact owner", async () => {
    const boot = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME, COPY_FRAME]),
    ], "design_previous");
    const live = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME, COPY_FRAME]),
    ], "design_replacement");
    const pending = deferred<DesignWorkspaceSnapshotWire>();
    platform.readSnapshot.mockImplementation(() => pending.promise);
    await seedRendererReload(boot);

    const mounted = await mountWorkspace();
    expect(mounted.bootPreview).toBe(true);
    expect(mounted.bootSnapshot?.directoryId).toBe("design_previous");
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID).directoryId).toBe(DIRECTORY_ID);
    expect(platform.canvasSnapshot).toBeUndefined();
    expect(platform.canvasLoading).toBe(false);
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({
      directoryId: DIRECTORY_ID,
      activePageId: PAGE_ID,
      selectedFrame: COPY_FRAME,
      frameSelected: true,
      zoom: 0.43,
      panX: 217,
      panY: 136,
    });

    await act(async () => {
      pending.resolve(live);
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    mounted.unsubscribe();
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({ directoryId: "design_replacement", selectedFrame: OTHER_FRAME });
    expect((platform.canvasSnapshot as DesignWorkspaceSnapshotWire).directoryId).toBe("design_replacement");
  });

  it("clears advisory provenance when an identical authoritative snapshot reuses the boot object", async () => {
    const boot = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME]),
    ]);
    const pending = deferred<DesignWorkspaceSnapshotWire>();
    platform.readSnapshot.mockImplementation(() => pending.promise);
    await seedRendererReload(boot);

    const mounted = await mountWorkspace();
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({ selectedFrame: COPY_FRAME, frameSelected: true });
    const identicalLive = structuredClone(mounted.bootSnapshot!);

    await act(async () => {
      pending.resolve(identicalLive);
      await pending.promise;
      await flushMicrotasks();
    });
    mounted.unsubscribe();
    const resolved = mounted.cache.designWorkspaceSnapshotCache.peekSnapshot(WORKSPACE_ID);
    const { isDesignWorkspaceBootPreview } = await import("../state/design-workspace-boot-cache");
    expect(resolved).toMatchObject({ loading: false, refreshing: false, error: null });
    expect(resolved.data).not.toBe(mounted.bootSnapshot);
    expect(resolved.data?.pages).toBe(mounted.bootSnapshot?.pages);
    expect(resolved.data?.frames).toBe(mounted.bootSnapshot?.frames);
    expect(isDesignWorkspaceBootPreview(mounted.bootSnapshot!)).toBe(true);
    expect(isDesignWorkspaceBootPreview(resolved.data!)).toBe(false);
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({
      selectedFrame: BASE_FRAME,
      frameSelected: false,
      selectedTargets: [],
    });
  });

  it("does not let an invalidated read clear the cached boot preview marker", async () => {
    const boot = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME]),
    ]);
    const pending = deferred<DesignWorkspaceSnapshotWire>();
    platform.readSnapshot.mockImplementation(() => pending.promise);
    await seedRendererReload(boot);

    const cache = await import("../state/design-workspace-cache");
    const bootCache = await import("../state/design-workspace-boot-cache");
    const originalBoot = cache.designWorkspaceSnapshotCache.peekSnapshot(WORKSPACE_ID).data!;
    expect(bootCache.isDesignWorkspaceBootPreview(originalBoot)).toBe(true);
    const staleLoad = cache.designWorkspaceSnapshotCache.load(
      WORKSPACE_ID,
      () => cache.fetchDesignWorkspaceSnapshot(WORKSPACE_ID),
      { maxAgeMs: -1 },
    );
    await flushMicrotasks();
    cache.designWorkspaceSnapshotCache.invalidate(WORKSPACE_ID);
    pending.resolve(structuredClone(originalBoot));
    await staleLoad;

    expect(cache.designWorkspaceSnapshotCache.peekSnapshot(WORKSPACE_ID).data).toBe(originalBoot);
    expect(bootCache.isDesignWorkspaceBootPreview(originalBoot)).toBe(true);
  });

  it("retains the boot owner after a failed read and validates it on retry", async () => {
    const boot = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME]),
    ]);
    const live = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME, COPY_FRAME]),
    ]);
    const pending = deferred<DesignWorkspaceSnapshotWire>();
    platform.readSnapshot
      .mockImplementationOnce(() => Promise.reject(new Error("offline")))
      .mockImplementation(() => pending.promise);
    await seedRendererReload(boot);

    const mounted = await mountWorkspace();
    await act(async () => { await flushMicrotasks(); });
    expect(mounted.cache.designWorkspaceSnapshotCache.peekSnapshot(WORKSPACE_ID).error).toBeInstanceOf(Error);
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({
      directoryId: DIRECTORY_ID,
      activePageId: PAGE_ID,
      selectedFrame: COPY_FRAME,
      frameSelected: true,
    });

    await act(async () => {
      mounted.cache.invalidateDesignWorkspaceSnapshot(WORKSPACE_ID);
      await flushMicrotasks();
    });
    expect(mounted.cache.designWorkspaceSnapshotCache.peekSnapshot(WORKSPACE_ID)).toMatchObject({ refreshing: true, error: null });
    await act(async () => {
      pending.resolve(live);
      await pending.promise;
      await flushMicrotasks();
    });
    mounted.unsubscribe();
    expect(mounted.ui.designWorkspaceView(WORKSPACE_ID)).toMatchObject({
      selectedFrame: COPY_FRAME,
      frameSelected: true,
      selectedTargets: [{ frame: COPY_FRAME }],
    });
  });

  it("does not let a late read from one workspace alter the switched workspace owner", async () => {
    const boot = workspaceSnapshot([
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME, COPY_FRAME]),
    ]);
    const firstRead = deferred<DesignWorkspaceSnapshotWire>();
    const secondRead = deferred<DesignWorkspaceSnapshotWire>();
    platform.readSnapshot.mockImplementation((workspaceId: string) =>
      workspaceId === WORKSPACE_ID ? firstRead.promise : secondRead.promise,
    );
    await seedRendererReload(boot);

    const secondUi = await import("../state/design-workspace-ui");
    secondUi.bindDesignWorkspacePages(OTHER_WORKSPACE_ID, OTHER_DIRECTORY_ID, [
      page(OTHER_PAGE_ID, [OTHER_FRAME]),
      page(PAGE_ID, [BASE_FRAME, COPY_FRAME]),
    ]);
    secondUi.useDesignWorkspaceUiStore.getState().setActivePage(OTHER_WORKSPACE_ID, PAGE_ID, OTHER_DIRECTORY_ID);
    const secondOwner = secondUi.captureDesignPageOwner(OTHER_WORKSPACE_ID);
    secondUi.useDesignWorkspaceUiStore.getState().setSelection(OTHER_WORKSPACE_ID, COPY_FRAME, null, undefined, {
      owner: secondOwner,
      frameSelected: true,
    });
    window.dispatchEvent(new Event("beforeunload"));
    vi.resetModules();

    const firstMount = await mountWorkspace();
    const { DesignWorkspaceColumn } = await import("../design-workspace");
    await act(async () => {
      root.render(createElement(DesignWorkspaceColumn, {
        workspace: { id: OTHER_WORKSPACE_ID } as never,
        folder: "/repo",
        surfaceActive: true,
      }));
    });
    const { designWorkspaceView } = await import("../state/design-workspace-ui");
    expect(designWorkspaceView(OTHER_WORKSPACE_ID)).toMatchObject({
      directoryId: OTHER_DIRECTORY_ID,
      activePageId: PAGE_ID,
      selectedFrame: COPY_FRAME,
      frameSelected: true,
    });

    await act(async () => {
      firstRead.resolve(workspaceSnapshot([
        page(OTHER_PAGE_ID, [OTHER_FRAME]),
        page(PAGE_ID, [BASE_FRAME]),
      ]));
      await firstRead.promise;
      await flushMicrotasks();
    });
    expect(designWorkspaceView(OTHER_WORKSPACE_ID)).toMatchObject({
      directoryId: OTHER_DIRECTORY_ID,
      activePageId: PAGE_ID,
      selectedFrame: COPY_FRAME,
      frameSelected: true,
    });

    await act(async () => {
      secondRead.resolve(workspaceSnapshot([
        page(OTHER_PAGE_ID, [OTHER_FRAME]),
        page(PAGE_ID, [BASE_FRAME, COPY_FRAME]),
      ], OTHER_DIRECTORY_ID));
      await secondRead.promise;
      await flushMicrotasks();
    });
    firstMount.unsubscribe();
  });
});
