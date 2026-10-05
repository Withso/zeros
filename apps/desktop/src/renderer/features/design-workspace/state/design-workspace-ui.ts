// ──────────────────────────────────────────────────────────
// Design workspace UI memory — workspace-owned canvas navigation
// ──────────────────────────────────────────────────────────
//
// Selection, viewport, code view, and the lower-panel tab belong to the design
// workspace. They survive A → B → A and reload without leaking one design's
// state into another. The persisted map is validated, bounded, and LRU-pruned.

import { DESIGN_SELECTION_NODE_LIMIT } from "@zeros/protocol/design-runtime";
import { isDesignFrameFile } from "@zeros/protocol/design-path";
import { designPageIdSchema, type DesignPageSummary } from "@zeros/protocol/design-pages";
import { create } from "zustand";
import { normalizeDesignCanvasBackground } from "../design-canvas-background";

const STORAGE_KEY = "zeros:design-workspace-ui-v1";
const MAX_WORKSPACES = 32;
const MAX_PAGE_VIEWS = 32;
const PERSIST_DEBOUNCE_MS = 150;
export const DESIGN_MIN_ZOOM = 0.01;
export const DESIGN_MAX_ZOOM = 256;

export type DesignBottomPanel = "layers" | "assets";

export interface DesignWorkspaceViewState {
  directoryId?: string;
  activePageId?: string;
  byPage?: Record<string, DesignPageViewState>;
  layersVisible: boolean;
  inspectorVisible: boolean;
  selectedFrame: string | null;
  /** True only when the frame itself is the selection target (label, Layers
   * row, or Escape from a root child). An active frame whose tree is merely
   * shown in the panel keeps this false, so empty-canvas clicks read as
   * deselection instead of re-selecting the frame. */
  frameSelected: boolean;
  selectedNodeId: string | null;
  /** Primary-first stable identities for additive canvas/layer selection. */
  selectedNodeIds: string[];
  panel: DesignBottomPanel;
  codeView: boolean;
  activeTheme: string | null;
  /** Null follows the active theme's --bg2; a concrete color is an explicit
   * workspace-owned override, including its alpha channel. */
  canvasBackground: string | null;
  zoom: number;
  panX: number;
  panY: number;
  updatedAt: number;
}

export type DesignPageViewState = Pick<DesignWorkspaceViewState,
  "selectedFrame" | "frameSelected" | "selectedNodeId" | "selectedNodeIds" |
  "codeView" | "canvasBackground" | "zoom" | "panX" | "panY" | "updatedAt"
>;

export interface DesignPageOwner {
  workspaceId: string;
  directoryId?: string;
  pageId?: string;
}

function pageView(view: DesignWorkspaceViewState): DesignPageViewState {
  const { selectedFrame, frameSelected, selectedNodeId, selectedNodeIds,
    codeView, canvasBackground, zoom, panX, panY, updatedAt } = view;
  return { selectedFrame, frameSelected, selectedNodeId, selectedNodeIds,
    codeView, canvasBackground, zoom, panX, panY, updatedAt };
}

function savedPage(views: Record<string, DesignPageViewState> | undefined, id: string) {
  return views && Object.hasOwn(views, id) ? views[id] : undefined;
}

function boundPageViews(views: Record<string, DesignPageViewState>, activePageId?: string) {
  return Object.fromEntries(Object.entries(views).sort(([leftId, left], [rightId, right]) =>
    Number(rightId === activePageId) - Number(leftId === activePageId) || right.updatedAt - left.updatedAt,
  ).slice(0, MAX_PAGE_VIEWS));
}

function samePageView(left: DesignPageViewState, right: DesignPageViewState) {
  return left.selectedFrame === right.selectedFrame && left.frameSelected === right.frameSelected &&
    left.selectedNodeId === right.selectedNodeId && left.selectedNodeIds.length === right.selectedNodeIds.length &&
    left.selectedNodeIds.every((id, index) => id === right.selectedNodeIds[index]) &&
    left.codeView === right.codeView && left.canvasBackground === right.canvasBackground &&
    left.zoom === right.zoom && left.panX === right.panX && left.panY === right.panY;
}

function validatePageSelection(view: DesignPageViewState, page: DesignPageSummary): DesignPageViewState {
  if (view.selectedFrame && page.frameFiles.includes(view.selectedFrame)) return view;
  const selectedFrame = page.frameFiles[0] ?? null;
  if (view.selectedFrame === selectedFrame) return view;
  return { ...view, selectedFrame, frameSelected: false, selectedNodeId: null,
    selectedNodeIds: [], codeView: false };
}

export const DEFAULT_DESIGN_WORKSPACE_VIEW: Readonly<DesignWorkspaceViewState> =
  Object.freeze({
    layersVisible: true,
    inspectorVisible: true,
    selectedFrame: null,
    frameSelected: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    panel: "layers",
    codeView: false,
    activeTheme: null,
    canvasBackground: null,
    zoom: 0.25,
    // A new canvas opens with its first frame and label clear of the
    // floating directory pill in the top-left corner.
    panX: 64,
    panY: 96,
    updatedAt: 0,
  });

export function clampDesignZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DESIGN_WORKSPACE_VIEW.zoom;
  return Math.min(DESIGN_MAX_ZOOM, Math.max(DESIGN_MIN_ZOOM, value));
}

export function isValidDesignNodeId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim().length === 0
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

export function normalizeDesignWorkspaceView(
  value: unknown,
): DesignWorkspaceViewState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_DESIGN_WORKSPACE_VIEW };
  }
  const record = value as Record<string, unknown>;
  const selectedFrame =
    isDesignFrameFile(record.selectedFrame)
      ? record.selectedFrame
      : null;
  const selectedNodeId =
    selectedFrame && isValidDesignNodeId(record.selectedNodeId)
      ? record.selectedNodeId
      : null;
  const selectedNodeIds = selectedNodeId
    ? [
        ...new Set([
          selectedNodeId,
          ...(Array.isArray(record.selectedNodeIds)
            ? record.selectedNodeIds.filter(isValidDesignNodeId)
            : []),
        ]),
      ].slice(0, DESIGN_SELECTION_NODE_LIMIT)
    : [];
  const normalized: DesignWorkspaceViewState = {
    ...(typeof record.directoryId === "string" && record.directoryId.length <= 128 ? { directoryId: record.directoryId } : {}),
    layersVisible: record.layersVisible !== false,
    inspectorVisible: record.inspectorVisible !== false,
    selectedFrame,
    // A remembered node selection owns the selection; the frame flag only
    // survives when the frame itself was the target.
    frameSelected:
      record.frameSelected === true &&
      selectedFrame !== null &&
      selectedNodeId === null,
    selectedNodeId,
    selectedNodeIds,
    panel: record.panel === "assets" ? "assets" : "layers",
    codeView: record.codeView === true,
    activeTheme:
      typeof record.activeTheme === "string" &&
      /^[a-z][a-z0-9_-]{0,63}$/.test(record.activeTheme)
        ? record.activeTheme
        : null,
    canvasBackground: normalizeDesignCanvasBackground(record.canvasBackground),
    zoom: clampDesignZoom(
      typeof record.zoom === "number"
        ? record.zoom
        : DEFAULT_DESIGN_WORKSPACE_VIEW.zoom,
    ),
    panX:
      typeof record.panX === "number" && Number.isFinite(record.panX)
        ? record.panX
        : DEFAULT_DESIGN_WORKSPACE_VIEW.panX,
    panY:
      typeof record.panY === "number" && Number.isFinite(record.panY)
        ? record.panY
        : DEFAULT_DESIGN_WORKSPACE_VIEW.panY,
    updatedAt:
      typeof record.updatedAt === "number" &&
      Number.isFinite(record.updatedAt) &&
      record.updatedAt >= 0
        ? record.updatedAt
        : 0,
  };
  const activePageId = designPageIdSchema.safeParse(record.activePageId);
  if (activePageId.success) normalized.activePageId = activePageId.data;
  if ((record.byPage && typeof record.byPage === "object" && !Array.isArray(record.byPage)) || activePageId.success) {
    const entries = Object.entries((record.byPage ?? {}) as Record<string, unknown>)
      .filter(([id]) => designPageIdSchema.safeParse(id).success)
      .map(([id, value]) => [id, pageView(normalizeDesignWorkspaceView({
        ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
        activePageId: undefined, byPage: undefined,
      }))] as const);
    normalized.byPage = boundPageViews(Object.fromEntries(entries), normalized.activePageId);
  }
  return normalized;
}

function loadViews(): Record<string, DesignWorkspaceViewState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([workspaceId]) => workspaceId.trim().length > 0)
        .map(
          ([workspaceId, state]) =>
            [workspaceId, normalizeDesignWorkspaceView(state)] as const,
        )
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
        .slice(0, MAX_WORKSPACES),
    );
  } catch {
    return {};
  }
}

function pruneViews(
  views: Record<string, DesignWorkspaceViewState>,
): Record<string, DesignWorkspaceViewState> {
  const entries = Object.entries(views);
  if (entries.length <= MAX_WORKSPACES) return views;
  return Object.fromEntries(
    entries
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAX_WORKSPACES),
  );
}

function writeViews(views: Record<string, DesignWorkspaceViewState>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    // Navigation persistence is best-effort in private/quota-limited storage.
  }
}

let persistTimer: number | null = null;
let persistSnapshot: Record<string, DesignWorkspaceViewState> | null = null;

function flushPersistedViews(): void {
  if (typeof window === "undefined") return;
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistSnapshot) {
    writeViews(persistSnapshot);
    persistSnapshot = null;
  }
}

function persistViews(views: Record<string, DesignWorkspaceViewState>): void {
  if (typeof window === "undefined") return;
  persistSnapshot = views;
  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    if (!persistSnapshot) return;
    writeViews(persistSnapshot);
    persistSnapshot = null;
  }, PERSIST_DEBOUNCE_MS);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushPersistedViews);
}

interface DesignWorkspaceUiStore {
  byWorkspace: Record<string, DesignWorkspaceViewState>;
  bindDirectory(workspaceId: string, directoryId: string): void;
  bindPages(workspaceId: string, directoryId: string | undefined, pages: readonly DesignPageSummary[]): void;
  setActivePage(workspaceId: string, pageId: string, directoryId?: string): void;
  setSelectedFrame(workspaceId: string, frame: string | null, owner?: DesignPageOwner): void;
  setSelection(
    workspaceId: string,
    frame: string,
    nodeId: string | null,
    nodeIds?: readonly string[],
    options?: { frameSelected?: boolean; owner?: DesignPageOwner },
  ): void;
  setPanels(workspaceId: string, panels: Partial<Pick<DesignWorkspaceViewState, "layersVisible" | "inspectorVisible">>): void;
  setPanel(workspaceId: string, panel: DesignBottomPanel): void;
  setCodeView(workspaceId: string, codeView: boolean): void;
  setActiveTheme(workspaceId: string, activeTheme: string | null): void;
  setCanvasBackground(workspaceId: string, canvasBackground: string, owner?: DesignPageOwner): void;
  setViewport(
    workspaceId: string,
    viewport: Pick<DesignWorkspaceViewState, "zoom" | "panX" | "panY">,
    owner?: DesignPageOwner,
  ): void;
  forgetWorkspace(workspaceId: string): void;
}

function updateWorkspaceView(
  current: Record<string, DesignWorkspaceViewState>,
  workspaceId: string,
  patch: Partial<DesignWorkspaceViewState>,
): Record<string, DesignWorkspaceViewState> {
  const previous =
    current[workspaceId] ??
    (DEFAULT_DESIGN_WORKSPACE_VIEW as DesignWorkspaceViewState);
  const next = normalizeDesignWorkspaceView({
    ...previous,
    ...patch,
    updatedAt: Date.now(),
    byPage: undefined,
  });
  if (next.activePageId) {
    const memory = Object.hasOwn(patch, "byPage") ? patch.byPage : previous.byPage;
    next.byPage = boundPageViews({ ...memory, [next.activePageId]: pageView(next) }, next.activePageId);
  }
  const byWorkspace = pruneViews({ ...current, [workspaceId]: next });
  persistViews(byWorkspace);
  return byWorkspace;
}

export const useDesignWorkspaceUiStore = create<DesignWorkspaceUiStore>(
  (set) => ({
    byWorkspace: loadViews(),
    bindDirectory(workspaceId, directoryId) {
      set((state) => {
        const previous = state.byWorkspace[workspaceId];
        if (previous?.directoryId === directoryId) return state;
        return { byWorkspace: updateWorkspaceView(state.byWorkspace, workspaceId, {
          ...(previous?.directoryId ? { ...DEFAULT_DESIGN_WORKSPACE_VIEW, activePageId: undefined, byPage: undefined } : {}), directoryId,
        }) };
      });
    },

    bindPages(workspaceId, directoryId, pages) {
      if (!pages.length) return;
      set(state => {
        const previous = state.byWorkspace[workspaceId] ?? DEFAULT_DESIGN_WORKSPACE_VIEW;
        const replaced = previous.directoryId !== undefined && directoryId !== undefined && previous.directoryId !== directoryId;
        const base = replaced ? { ...DEFAULT_DESIGN_WORKSPACE_VIEW, directoryId } : previous;
        const catalog = new Map(pages.map(page => [page.id, page]));
        const activePageId = base.activePageId && catalog.has(base.activePageId) ? base.activePageId : pages[0].id;
        const memory = Object.fromEntries(Object.entries(base.byPage ?? {})
          .filter(([id]) => catalog.has(id))
          .map(([id, view]) => [id, validatePageSelection(view, catalog.get(id)!)]));
        const active = validatePageSelection(savedPage(memory, activePageId) ??
          pageView(!base.activePageId || base.activePageId === activePageId ? base : DEFAULT_DESIGN_WORKSPACE_VIEW), catalog.get(activePageId)!);
        memory[activePageId] = active;
        const bounded = boundPageViews(memory, activePageId);
        if (!replaced && (directoryId === undefined || previous.directoryId === directoryId) &&
          previous.activePageId === activePageId && samePageView(previous, active) &&
          Object.keys(previous.byPage ?? {}).length === Object.keys(bounded).length &&
          Object.entries(bounded).every(([id, view]) => savedPage(previous.byPage, id) === view)) return state;
        const next = { ...base, ...active, ...(directoryId ? { directoryId } : {}), activePageId, byPage: bounded, updatedAt: Date.now() };
        const byWorkspace = pruneViews({ ...state.byWorkspace, [workspaceId]: next });
        persistViews(byWorkspace);
        return { byWorkspace };
      });
    },

    setActivePage(workspaceId, pageId, directoryId) {
      if (!designPageIdSchema.safeParse(pageId).success) return;
      set(state => {
        const previous = state.byWorkspace[workspaceId];
        if (!previous || (directoryId !== undefined && previous.directoryId !== directoryId) || previous.activePageId === pageId) return state;
        const memory = { ...previous.byPage };
        if (previous.activePageId) memory[previous.activePageId] = pageView(previous);
        const active = savedPage(memory, pageId) ?? pageView(DEFAULT_DESIGN_WORKSPACE_VIEW);
        return { byWorkspace: updateWorkspaceView(state.byWorkspace, workspaceId, { ...active, activePageId: pageId, byPage: memory }) };
      });
    },

    setSelectedFrame(workspaceId, selectedFrame, owner) {
      if (owner && (owner.workspaceId !== workspaceId || !isCurrentDesignPageOwner(owner))) return;
      set((state) => ({
        byWorkspace: updateWorkspaceView(state.byWorkspace, workspaceId, {
          selectedFrame,
          frameSelected:
            state.byWorkspace[workspaceId]?.selectedFrame === selectedFrame
              ? state.byWorkspace[workspaceId]?.frameSelected
              : false,
          selectedNodeId:
            state.byWorkspace[workspaceId]?.selectedFrame === selectedFrame
              ? state.byWorkspace[workspaceId]?.selectedNodeId
              : null,
          selectedNodeIds:
            state.byWorkspace[workspaceId]?.selectedFrame === selectedFrame
              ? state.byWorkspace[workspaceId]?.selectedNodeIds
              : [],
          // Source belongs to the selected frame. Closing it when selection is
          // cleared prevents a blank code surface from becoming durable.
          ...(selectedFrame ? {} : { codeView: false }),
        }),
      }));
    },

    setSelection(
      workspaceId,
      selectedFrame,
      selectedNodeId,
      selectedNodeIds,
      options,
    ) {
      if (options?.owner && (options.owner.workspaceId !== workspaceId || !isCurrentDesignPageOwner(options.owner))) return;
      set((state) => ({
        byWorkspace: updateWorkspaceView(state.byWorkspace, workspaceId, {
          selectedFrame,
          frameSelected: selectedNodeId
            ? false
            : (options?.frameSelected ?? false),
          selectedNodeId,
          selectedNodeIds: selectedNodeId
            ? [selectedNodeId, ...(selectedNodeIds ?? [])]
            : [],
        }),
      }));
    },

    setPanels(workspaceId, panels) {
      set((state) => ({ byWorkspace: updateWorkspaceView(state.byWorkspace, workspaceId, panels) }));
    },
    setPanel(workspaceId, panel) {
      set((state) => ({
        byWorkspace: updateWorkspaceView(state.byWorkspace, workspaceId, {
          panel,
        }),
      }));
    },

    setCodeView(workspaceId, codeView) {
      set((state) => ({
        byWorkspace: updateWorkspaceView(state.byWorkspace, workspaceId, {
          codeView,
        }),
      }));
    },

    setActiveTheme(workspaceId, activeTheme) {
      set((state) => ({
        byWorkspace: updateWorkspaceView(state.byWorkspace, workspaceId, {
          activeTheme,
        }),
      }));
    },

    setCanvasBackground(workspaceId, canvasBackground, owner) {
      if (owner && owner.workspaceId !== workspaceId) return;
      const normalized = normalizeDesignCanvasBackground(canvasBackground);
      if (!normalized) return;
      if (owner && !isCurrentDesignPageOwner(owner)) {
        set(state => {
          const previous = state.byWorkspace[workspaceId];
          if (!previous || previous.directoryId !== owner.directoryId || !owner.pageId) return state;
          const captured = savedPage(previous.byPage, owner.pageId);
          if (!captured) return state;
          const byPage = { ...previous.byPage, [owner.pageId]: { ...captured, canvasBackground: normalized, updatedAt: Date.now() } };
          const byWorkspace = { ...state.byWorkspace, [workspaceId]: { ...previous, byPage } };
          persistViews(byWorkspace);
          return { byWorkspace };
        });
        return;
      }
      set((state) => ({
        byWorkspace: updateWorkspaceView(state.byWorkspace, workspaceId, {
          canvasBackground: normalized,
        }),
      }));
    },

    setViewport(workspaceId, viewport, owner) {
      if (owner && (owner.workspaceId !== workspaceId || !isCurrentDesignPageOwner(owner))) return;
      set((state) => ({
        byWorkspace: updateWorkspaceView(state.byWorkspace, workspaceId, {
          ...viewport,
          zoom: clampDesignZoom(viewport.zoom),
        }),
      }));
    },

    forgetWorkspace(workspaceId) {
      set((state) => {
        if (!(workspaceId in state.byWorkspace)) return state;
        const byWorkspace = { ...state.byWorkspace };
        delete byWorkspace[workspaceId];
        persistViews(byWorkspace);
        return { byWorkspace };
      });
    },
  }),
);

export function designWorkspaceView(
  workspaceId: string | null | undefined,
): DesignWorkspaceViewState {
  if (!workspaceId) {
    return DEFAULT_DESIGN_WORKSPACE_VIEW as DesignWorkspaceViewState;
  }
  return (
    useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId] ??
    (DEFAULT_DESIGN_WORKSPACE_VIEW as DesignWorkspaceViewState)
  );
}

export function captureDesignPageOwner(workspaceId: string): DesignPageOwner {
  const view = designWorkspaceView(workspaceId);
  return { workspaceId, directoryId: view.directoryId, pageId: view.activePageId };
}

export function isCurrentDesignPageOwner(owner: DesignPageOwner): boolean {
  const current = designWorkspaceView(owner.workspaceId);
  return current.directoryId === owner.directoryId && current.activePageId === owner.pageId;
}

/** Cold/revalidating catalogs must never prune remembered page identity. */
export function bindDesignWorkspacePages(
  workspaceId: string,
  directoryId: string | undefined,
  pages: readonly DesignPageSummary[],
  settled = true,
): string | undefined {
  if (settled) useDesignWorkspaceUiStore.getState().bindPages(workspaceId, directoryId, pages);
  return designWorkspaceView(workspaceId).activePageId;
}

export function useDesignWorkspaceView(
  workspaceId: string | null | undefined,
): DesignWorkspaceViewState {
  return useDesignWorkspaceUiStore(
    (state) =>
      (workspaceId ? state.byWorkspace[workspaceId] : undefined) ??
      DEFAULT_DESIGN_WORKSPACE_VIEW,
  );
}

export function forgetDesignWorkspaceView(workspaceId: string): void {
  useDesignWorkspaceUiStore.getState().forgetWorkspace(workspaceId);
}

export function resetDesignWorkspaceUiForTests(): void {
  useDesignWorkspaceUiStore.setState({ byWorkspace: {} });
  if (typeof window !== "undefined") {
    if (persistTimer !== null) window.clearTimeout(persistTimer);
    persistTimer = null;
    persistSnapshot = null;
    window.localStorage.removeItem(STORAGE_KEY);
  }
}
