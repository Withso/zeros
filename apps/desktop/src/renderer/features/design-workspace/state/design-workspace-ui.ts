// ──────────────────────────────────────────────────────────
// Design workspace UI memory — workspace-owned canvas navigation
// ──────────────────────────────────────────────────────────
//
// Selection, viewport, code view, and the lower-panel tab belong to the design
// workspace. They survive A → B → A and reload without leaking one design's
// state into another. The persisted map is validated, bounded, and LRU-pruned.

import { DESIGN_SELECTION_NODE_LIMIT } from "@zeros/protocol/design-runtime";
import { create } from "zustand";

const STORAGE_KEY = "zeros:design-workspace-ui-v1";
const MAX_WORKSPACES = 32;
const PERSIST_DEBOUNCE_MS = 150;

export type DesignBottomPanel = "layers" | "assets";

export interface DesignWorkspaceViewState {
  selectedFrame: string | null;
  selectedNodeId: string | null;
  /** Primary-first stable identities for additive canvas/layer selection. */
  selectedNodeIds: string[];
  panel: DesignBottomPanel;
  codeView: boolean;
  activeTheme: string | null;
  zoom: number;
  panX: number;
  panY: number;
  updatedAt: number;
}

export const DEFAULT_DESIGN_WORKSPACE_VIEW: Readonly<DesignWorkspaceViewState> =
  Object.freeze({
    selectedFrame: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    panel: "layers",
    codeView: false,
    activeTheme: null,
    zoom: 0.25,
    panX: 64,
    panY: 64,
    updatedAt: 0,
  });

export function clampDesignZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DESIGN_WORKSPACE_VIEW.zoom;
  return Math.min(2, Math.max(0.05, value));
}

function validDesignNodeId(value: unknown): value is string {
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
    typeof record.selectedFrame === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i.test(record.selectedFrame)
      ? record.selectedFrame
      : null;
  const selectedNodeId =
    selectedFrame && validDesignNodeId(record.selectedNodeId)
      ? record.selectedNodeId
      : null;
  const selectedNodeIds = selectedNodeId
    ? [
        ...new Set([
          selectedNodeId,
          ...(Array.isArray(record.selectedNodeIds)
            ? record.selectedNodeIds.filter(validDesignNodeId)
            : []),
        ]),
      ].slice(0, DESIGN_SELECTION_NODE_LIMIT)
    : [];
  return {
    selectedFrame,
    selectedNodeId,
    selectedNodeIds,
    panel: record.panel === "assets" ? "assets" : "layers",
    codeView: record.codeView === true,
    activeTheme:
      typeof record.activeTheme === "string" &&
      /^[a-z][a-z0-9_-]{0,63}$/.test(record.activeTheme)
        ? record.activeTheme
        : null,
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
  setSelectedFrame(workspaceId: string, frame: string | null): void;
  setSelection(
    workspaceId: string,
    frame: string,
    nodeId: string | null,
    nodeIds?: readonly string[],
  ): void;
  setPanel(workspaceId: string, panel: DesignBottomPanel): void;
  setCodeView(workspaceId: string, codeView: boolean): void;
  setActiveTheme(workspaceId: string, activeTheme: string | null): void;
  setViewport(
    workspaceId: string,
    viewport: Pick<DesignWorkspaceViewState, "zoom" | "panX" | "panY">,
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
  });
  const byWorkspace = pruneViews({ ...current, [workspaceId]: next });
  persistViews(byWorkspace);
  return byWorkspace;
}

export const useDesignWorkspaceUiStore = create<DesignWorkspaceUiStore>(
  (set) => ({
    byWorkspace: loadViews(),

    setSelectedFrame(workspaceId, selectedFrame) {
      set((state) => ({
        byWorkspace: updateWorkspaceView(state.byWorkspace, workspaceId, {
          selectedFrame,
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

    setSelection(workspaceId, selectedFrame, selectedNodeId, selectedNodeIds) {
      set((state) => ({
        byWorkspace: updateWorkspaceView(state.byWorkspace, workspaceId, {
          selectedFrame,
          selectedNodeId,
          selectedNodeIds: selectedNodeId
            ? [selectedNodeId, ...(selectedNodeIds ?? [])]
            : [],
        }),
      }));
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

    setViewport(workspaceId, viewport) {
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

export function useDesignWorkspaceView(
  workspaceId: string | null | undefined,
): DesignWorkspaceViewState {
  return useDesignWorkspaceUiStore(
    (state) =>
      (workspaceId ? state.byWorkspace[workspaceId] : undefined) ??
      DEFAULT_DESIGN_WORKSPACE_VIEW,
  );
}

/** Validate only after an authoritative frame snapshot settles. Cold data must
 * never erase a remembered selection. */
export function validateDesignWorkspaceSelection(
  workspaceId: string,
  availableFrames: readonly string[],
): string | null {
  const current = designWorkspaceView(workspaceId).selectedFrame;
  if (current && availableFrames.includes(current)) return current;
  const fallback = availableFrames[0] ?? null;
  if (current === fallback) return fallback;
  useDesignWorkspaceUiStore.getState().setSelectedFrame(workspaceId, fallback);
  return fallback;
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
