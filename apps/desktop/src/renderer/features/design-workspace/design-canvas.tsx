import {
  DESIGN_CANVAS_INVERSE_ZOOM,
  designCanvasCameraStyle,
  designCanvasScreenPixels,
  paintDesignCanvasCamera,
} from "./design-canvas-camera";
import {
  DESIGN_CANVAS_DEFAULT_TEXT_COLOR,
  DesignInlineTextEditor,
  type ExistingInlineTextEdit,
  type InlineTextEdit,
} from "./design-inline-text-editor";
// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas and structured design inspector
// USED IN: MainShellBody in place of the code workspace's Workbench
// ============================================

// --- IMPORTS ---

import {
  Code2,
  Diamond,
  Frame,
  MousePointer2,
  Palette,
  Type,
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { type DesignOperation } from "@zeros/design-core";
import type { DesignAuthoredKeyframes } from "@zeros/design-web";
import type {
  DesignRuntimeNodeDetails,
  DesignRuntimeNodeGeometry,
  DesignRuntimeTreeNode,
} from "@zeros/protocol/design-runtime";

import { designFrameRuntime } from "../../platform/bridge/design-frame-runtime";
import {
  type DesignCanvasFrameWire,
  type DesignFrameGeometryWire,
} from "../../platform/git";
import { cn } from "../../shared/ui/cn";
import {
  createMenuAnchor,
  type MenuAnchor,
} from "../../shared/ui/menu-anchor";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "../../shared/ui/primitives/context-menu";
import {
  Button,
  CodeBlock,
  Input,
  ScrollArea,
  Toolbar,
  Tooltip,
  toast,
} from "../../shared/ui/primitives";
import { isEditableHotkeyTarget } from "../../shell/editable-target";
import { hasDesignAssetDrag, readDesignAssetDrag } from "./design-assets";
import { designSizingStyles } from "./design-auto-layout-values";
import {
  designAuthoredResizeAxis,
  designCanvasPointFromClient,
  designCanvasRectFromPoints,
  designConstraintSides,
  designCssSizeAfterResize,
  designHighResolutionViewportTile,
  designInlineGapDistributionStyles,
  designInlineSpacingValue,
  designLocalDelta,
  designOriginFraction,
  designPointerRotation,
  designResizeAnchor,
  designResizeLayoutOffset,
  designResizeStyleAxes,
  designRotatedResizeOrigin,
  designRotationCursor,
  designSelectionBox,
  designSelectionBoxBounds,
  designSelectionClickIntent,
  designSelectionOverlayFrame,
  designSelectionPivot,
  designWheelDeltaPixels,
  designWheelZoomFactor,
  fitDesignRects,
  resizeDesignRect,
  resizeDesignRectWithinBounds,
  retainLiveDesignFrameFiles,
  selectLiveDesignFrameFiles,
  snapDesignRect,
  snapDesignResizeRect,
  zoomDesignViewportAtPoint,
  type DesignHighResolutionViewportTile,
  type DesignResizeHandle,
  type DesignViewport,
} from "./design-canvas-math";
import { createDesignDragPresentation } from "./design-drag-presentation";
import {
  formatDesignTransform,
  parseDesignTransform,
} from "./design-effect-values";
import {
  canInsertDesignFrame,
  designFrameInsertionOperations,
} from "./design-frame-insertion";
import {
  createDesignGestureLoop,
  sameDesignGestureStyles,
} from "./design-gesture-loop";
import {
  beginInlineTextCommit,
  cancelInlineTextCommit,
  createInlineTextCommitGuard,
  finishInlineTextCommit,
} from "./design-inline-text-commit";
import {
  designFrameLayerChildren,
  designLayerChildId,
  designLayerParentId,
  designLayerPathIds,
  designLayerPeerIds,
  designLayerSiblingId,
  designLayerTopLevelSelectionIds,
  flattenDesignLayerTree,
} from "./design-layer-tree";
import { startDesignLayoutDrag } from "./design-layout-drag-gesture";
import { transferDesignLayerOnCanvas } from "./design-layout-transfer";
import {
  designLayoutTransform,
  preserveDesignLayoutPins,
} from "./design-layout-values";
import {
  DesignMotionTimeline,
  designMotionPreviewInput,
  type DesignMotionSeekRequest,
  type DesignMotionTimelineDraft,
} from "./design-motion-timeline";
import { canEditDesignNodeText } from "./design-node-capabilities";
import { resolveDesignSelectionShortcut } from "./design-selection-shortcuts";
import {
  createDesignTextMarkup,
  createDesignTextNodeId,
} from "./design-text-editing";
import { DesignThemeEditor } from "./design-theme-editor";
import { useDesignWorkspaceDisclosure } from "./state/design-layer-disclosure";
import {
  designLivePreviewValue,
  publishDesignGestureLivePreview,
} from "./state/design-live-preview";
import { publishDesignMotionPlayhead } from "./state/design-motion-playhead";
import { useDesignRuntimeStore } from "./state/design-runtime-store";
import {
  clearDesignNodeStylePreviewTransient,
  clearDesignNodeTextPreviewTransient,
  hoverDesignNode,
  hoverDesignNodeAtLocation,
  inspectDesignNode,
  inspectDesignNodeAtLocation,
  inspectDesignNodesInRect,
  previewDesignNodeGeometry,
  previewDesignNodeMotionTransient,
  previewDesignNodeStylesTransient,
  previewDesignNodeTextTransient,
  selectDesignFrame,
  selectDesignFrameBodyAtLocation,
  selectDesignNode,
  selectDesignNodeAtLocation,
  selectDesignNodes,
  toggleDesignNodeSelection,
} from "./state/design-selection";
import {
  appendDesignNodeHtmlCached,
  applyDesignEditCached,
  applyDesignTransactionCached,
  createDesignFrameAndRefresh,
  designFoundationCache,
  designFoundationKey,
  designWorkspaceSnapshotCache,
  duplicateDesignFrameCached,
  fetchDesignFoundation,
  insertDesignAssetCached,
  renameDesignFrameAndRefresh,
  updateDesignFrameGeometryCached,
  updateDesignNodeStylesCached,
  warmDesignFrameDocument,
} from "./state/design-workspace-cache";
import {
  designWorkspaceView,
  useDesignWorkspaceUiStore,
  useDesignWorkspaceView,
} from "./state/design-workspace-ui";
import { useDesignFoundation } from "./state/use-design-foundation";
import { useDesignFrameDocument } from "./state/use-design-frame-document";

import { DesignFrameRenderSurface } from "./design-frame-render-surface";
import { errorMessage } from "./design-workspace-error";
import {
  DESIGN_RESIZE_HANDLES,
  DesignConstraintGuides,
  DesignLayerHoverOverlay,
  DesignMeasureOverlay,
  DesignMotionCanvasOverlay,
  DesignOriginAnchors,
  DesignOriginHandle,
  DesignResizeHandles,
  DesignRotationHandles,
  DesignSelectionMeasurements,
  designGesturePixelBase,
  designOriginStyles,
  designPixelValue,
  designSelectionOverlayStyle,
  frameGeometry,
  paintDesignConstraintGuides,
  paintDesignInlineGapHandles,
  paintDesignInlinePaddingGeometry,
  paintDesignLabelText,
  paintDesignNodeOverlayGeometry,
  paintFrameGeometry,
  type DesignInlineSpacingControl,
  type DesignMotionOverlayState,
  type DesignPaintedChild,
  type DesignPaintedNode,
} from "./design-workspace-overlays";
import {
  type DesignCanvasProps,
  type DesignCanvasZoomActions,
} from "./design-workspace-types";


type FrameGestureMode = "move" | DesignResizeHandle;
type DesignCanvasTool = "select" | "frame" | "text";

interface CanvasHitStackMenu {
  frame: DesignCanvasFrameWire;
  workspaceId: string;
  anchor: MenuAnchor;
  layers: Array<{ oid: string; name: string; tag: string }>;
}
const MIN_FRAME_WIDTH = 1;
const MIN_FRAME_HEIGHT = 1;
const COLD_BUSY_DELAY_MS = 180;
const MAX_LIVE_DESIGN_FRAMES = 12;
/** Chromium stops re-rasterizing magnified iframe textures at device fidelity
 * around 600% on Retina displays; viewport tiles take over from there. */
const HIGH_RESOLUTION_ZOOM_THRESHOLD = 6;
const MAX_HIGH_RESOLUTION_TILES = 2;
/** Extra rasterized margin keeps small settled pans inside the previous tile
 * instead of revealing compositor-magnified iframe pixels at the edges. */
const HIGH_RESOLUTION_TILE_OVERSCAN = 96;
const EMPTY_DESIGN_TREE: readonly DesignRuntimeTreeNode[] = Object.freeze([]);
const EMPTY_DESIGN_KEYFRAME_DEFINITIONS: readonly DesignAuthoredKeyframes[] =
  Object.freeze([]);
const EMPTY_NODE_DETAILS: readonly DesignRuntimeNodeDetails[] = Object.freeze(
  [],
);
export const EMPTY_NODE_IDS: readonly string[] = Object.freeze([]);
/** The origin marker keeps a constant screen size, so on a selection only a few
 * marker-widths across it stops reading as a pivot and starts covering the
 * element. Below six times its own hit box — roughly 108 screen pixels, or a
 * 48×30 element under ~2.5× zoom — the marker is not drawn at all, and zooming
 * out far enough always retires it. */
const DESIGN_ORIGIN_HANDLE_MINIMUM = 108;
/** Snap distance, in screen pixels, from a dragged origin to a box anchor. */
const DESIGN_ORIGIN_SNAP_DISTANCE = 6;

function blocksDesignCanvasDoubleClick(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest("[data-design-controls]");
  return Boolean(
    control && control.closest("[data-design-inline-spacing]") === null,
  );
}

/** A genuine cold load gets a delayed label; warm snapshots never disappear. */
function useDelayedColdBusy(loading: boolean): boolean {
  // Tracks whether the cold request has outlasted the anti-flicker window.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!loading) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), COLD_BUSY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);
  return visible;
}

// ============================================
// COMPONENT: DesignCanvas
// PURPOSE: Pan, zoom, select, create, move, resize, rename, and inspect source
// USED IN: DesignWorkspaceColumn
// ============================================

export function DesignCanvas({
  workspaceId,
  folder,
  snapshot,
  loading,
  active,
  canvasBackground,
  motionTimelineOpen,
  motionPropertyRequest,
  onMotionTimelineOpenChange,
  onMotionPropertyRequestHandled,
  onMotionPropertiesChange,
  onDeleteFrame,
  zoomActionsRef,
}: DesignCanvasProps) {
  const view = useDesignWorkspaceView(workspaceId);
  const setCodeView = useDesignWorkspaceUiStore((state) => state.setCodeView);
  const setActiveTheme = useDesignWorkspaceUiStore(
    (state) => state.setActiveTheme,
  );
  const setViewport = useDesignWorkspaceUiStore((state) => state.setViewport);
  const selectedFrame =
    snapshot?.frames.find((frame) => frame.file === view.selectedFrame) ??
    snapshot?.frames[0] ??
    null;
  const canvasFoundation = useDesignFoundation(
    workspaceId,
    selectedFrame?.file,
    selectedFrame?.sourceVersion,
    active && Boolean(selectedFrame),
  );
  const selectedFrameDocument = useDesignFrameDocument(
    workspaceId ?? "",
    selectedFrame?.file ?? "",
    selectedFrame?.sourceVersion ?? "",
    active && Boolean(workspaceId && selectedFrame),
  );
  const warmSelectedFrameDocument = useCallback(() => {
    if (!active || !workspaceId || !selectedFrame) return;
    warmDesignFrameDocument(
      workspaceId,
      selectedFrame.file,
      selectedFrame.sourceVersion,
    );
  }, [active, selectedFrame, workspaceId]);
  const selectedNodeDetails = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame || !view.selectedNodeId) return null;
    return (
      state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.detailsByNode[
        view.selectedNodeId
      ] ?? null
    );
  });
  const selectedNodeDetailsList = useDesignRuntimeStore(
    useShallow((state) => {
      if (!workspaceId || !selectedFrame || view.selectedNodeIds.length === 0) {
        return EMPTY_NODE_DETAILS;
      }
      const detailsByNode =
        state.byWorkspace[workspaceId]?.frames[selectedFrame.file]
          ?.detailsByNode;
      if (!detailsByNode) return EMPTY_NODE_DETAILS;
      return view.selectedNodeIds.flatMap((nodeId) => {
        const details = detailsByNode[nodeId];
        return details ? [details] : [];
      });
    }),
  );
  const selectedRuntimeTree = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame) return EMPTY_DESIGN_TREE;
    return (
      state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.snapshot
        ?.tree ?? EMPTY_DESIGN_TREE
    );
  });
  const selectedFrameHasFlow = useMemo(() => {
    const hasFlow = (nodes: readonly DesignRuntimeTreeNode[]): boolean =>
      nodes.some(
        (node) =>
          ["flex", "inline-flex", "grid", "inline-grid"].includes(
            node.display ?? "",
          ) || hasFlow(node.children),
      );
    return hasFlow(selectedRuntimeTree);
  }, [selectedRuntimeTree]);
  const selectedRuntimeRevision = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame) return 0;
    return (
      state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.snapshot
        ?.revision ?? 0
    );
  });
  const selectedFrameRootId = useDesignRuntimeStore((state) =>
    workspaceId && selectedFrame
      ? state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.snapshot
          ?.frame.oid
      : undefined,
  );
  const selectedNavigationTree = useMemo(
    () => designFrameLayerChildren(selectedRuntimeTree, selectedFrameRootId),
    [selectedRuntimeTree, selectedFrameRootId],
  );
  const selectedParentId = useMemo(
    () =>
      view.selectedNodeId
        ? designLayerParentId(selectedRuntimeTree, view.selectedNodeId)
        : null,
    [selectedRuntimeTree, view.selectedNodeId],
  );
  const parentOutlineSelectionOwner = `${selectedFrame?.file ?? ""}\u0000${selectedParentId ?? ""}`;
  const parentOutlineOwner = `${parentOutlineSelectionOwner}\u0000${selectedFrame?.sourceVersion ?? ""}`;
  const [parentOutlineState, setParentOutlineState] = useState<{
    owner: string;
    selectionOwner: string;
    details: DesignRuntimeNodeDetails | null;
  }>({ owner: "", selectionOwner: "", details: null });
  const parentOutlineDetails =
    parentOutlineState.selectionOwner === parentOutlineSelectionOwner
      ? parentOutlineState.details
      : null;
  const selectedPeerIds = useMemo(
    () =>
      view.selectedNodeId
        ? designLayerPeerIds(selectedRuntimeTree, view.selectedNodeId)
        : [],
    [selectedRuntimeTree, view.selectedNodeId],
  );
  const peerGeometrySelectionOwner = `${selectedFrame?.file ?? ""}\u0000${view.selectedNodeId ?? ""}\u0000${selectedPeerIds.join("\u0001")}`;
  const peerGeometryOwner = `${peerGeometrySelectionOwner}\u0000${selectedFrame?.sourceVersion ?? ""}`;
  const [peerGeometryState, setPeerGeometryState] = useState<{
    owner: string;
    selectionOwner: string;
    details: readonly DesignRuntimeNodeGeometry[];
  }>({ owner: "", selectionOwner: "", details: [] });
  const peerGeometryDetails =
    peerGeometryState.selectionOwner === peerGeometrySelectionOwner
      ? peerGeometryState.details
      : EMPTY_NODE_DETAILS;
  const childGeometrySelectionOwner = `${selectedFrame?.file ?? ""}\u0000${view.selectedNodeId ?? ""}\u0000${view.activeTheme ?? ""}`;
  const childGeometryOwner = `${childGeometrySelectionOwner}\u0000${selectedFrame?.sourceVersion ?? ""}`;
  const [childGeometryState, setChildGeometryState] = useState<{
    owner: string;
    selectionOwner: string;
    details: readonly DesignPaintedChild[];
  }>({ owner: "", selectionOwner: "", details: [] });
  const childGeometryDetails =
    childGeometryState.selectionOwner === childGeometrySelectionOwner
      ? childGeometryState.details
      : EMPTY_NODE_DETAILS;

  useEffect(() => {
    if (!active || !workspaceId || !selectedFrame || !selectedParentId) {
      return;
    }
    let cancelled = false;
    const owner = parentOutlineOwner;
    void inspectDesignNode({
      workspaceId,
      frame: selectedFrame,
      nodeId: selectedParentId,
    })
      .then((details) => {
        if (!cancelled) {
          setParentOutlineState({
            owner,
            selectionOwner: parentOutlineSelectionOwner,
            details,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setParentOutlineState({
            owner,
            selectionOwner: parentOutlineSelectionOwner,
            details: null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    parentOutlineOwner,
    parentOutlineSelectionOwner,
    selectedFrame,
    selectedParentId,
    workspaceId,
  ]);

  // One aggregate runtime read supplies the selected layout container's direct
  // child boxes. This avoids a per-layer waterfall and lets gap hit targets sit
  // in actual rendered spaces, including wrapped rows and grid columns.
  useEffect(() => {
    const display = selectedNodeDetails?.styles.display;
    if (
      !active ||
      !workspaceId ||
      !selectedFrame ||
      !view.selectedNodeId ||
      !selectedNodeDetails ||
      !["flex", "inline-flex", "grid", "inline-grid"].includes(display ?? "")
    ) {
      return;
    }
    let cancelled = false;
    const owner = childGeometryOwner;
    void previewDesignNodeGeometry({
      workspaceId,
      frame: selectedFrame,
      nodeId: view.selectedNodeId,
      children: true,
    })
      .then((geometry) => {
        if (cancelled) return;
        setChildGeometryState({
          owner,
          selectionOwner: childGeometrySelectionOwner,
          details: geometry.children,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setChildGeometryState({
            owner,
            selectionOwner: childGeometrySelectionOwner,
            details: [],
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    childGeometryOwner,
    childGeometrySelectionOwner,
    selectedFrame,
    selectedNodeDetails,
    selectedRuntimeRevision,
    view.selectedNodeId,
    workspaceId,
  ]);

  // Sibling geometry powers snapping and Option-distance feedback. Reads are
  // parallel, generation-owned, and bounded so deeply generated documents do
  // not turn one selection into an unbounded runtime request burst.
  useEffect(() => {
    if (
      !active ||
      !workspaceId ||
      !selectedFrame ||
      !view.selectedNodeId ||
      selectedPeerIds.length === 0
    ) {
      return;
    }
    let cancelled = false;
    const owner = peerGeometryOwner;
    const ids = selectedPeerIds.slice(0, 64);
    void Promise.all(
      ids.map((nodeId) =>
        previewDesignNodeGeometry({
          workspaceId,
          frame: selectedFrame,
          nodeId,
        }).catch(() => null),
      ),
    ).then((geometries) => {
      if (cancelled) return;
      setPeerGeometryState({
        owner,
        selectionOwner: peerGeometrySelectionOwner,
        details: geometries.filter(
          (candidate): candidate is DesignRuntimeNodeGeometry =>
            Boolean(
              candidate &&
              candidate.rect.width > 0 &&
              candidate.rect.height > 0,
            ),
        ),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    peerGeometryOwner,
    peerGeometrySelectionOwner,
    selectedFrame,
    selectedPeerIds,
    view.selectedNodeId,
    workspaceId,
  ]);

  const showColdBusy = useDelayedColdBusy(loading && !snapshot);
  const availableThemes = useMemo(
    () =>
      new Set(
        snapshot?.tokens.flatMap((token) => Object.keys(token.themeValues)) ??
          [],
      ),
    [snapshot?.tokens],
  );

  useEffect(() => {
    if (!workspaceId || !snapshot || !view.activeTheme) return;
    if (availableThemes.has(view.activeTheme)) return;
    setActiveTheme(workspaceId, null);
  }, [
    availableThemes,
    setActiveTheme,
    snapshot,
    view.activeTheme,
    workspaceId,
  ]);

  useEffect(() => {
    if (motionTimelineOpen && !view.selectedNodeId) {
      onMotionTimelineOpenChange(false);
    }
  }, [motionTimelineOpen, onMotionTimelineOpenChange, view.selectedNodeId]);

  // DOM owner for viewport bounds, focus scoping, and pointer-relative zoom.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Direct transform target keeps panning gesture paints out of React.
  const worldRef = useRef<HTMLDivElement | null>(null);
  const frameGeometryPreviewsRef = useRef(
    new Map<
      string,
      {
        geometry: DesignFrameGeometryWire;
        settled: boolean;
      }
    >(),
  );
  const marqueeRef = useRef<HTMLDivElement | null>(null);
  const creationDraftRef = useRef<HTMLDivElement | null>(null);
  const verticalGuideRef = useRef<HTMLDivElement | null>(null);
  const horizontalGuideRef = useRef<HTMLDivElement | null>(null);
  // Space state is mirrored in a ref so pointer handlers read the current key.
  const spacePressedRef = useRef(false);
  // Drives the grab cursor without publishing transient state globally.
  const [spacePressed, setSpacePressed] = useState(false);
  // Option/Alt reveals exact sibling spacing without permanently cluttering
  // the selection overlay.
  const [measurePressed, setMeasurePressed] = useState(false);
  // Every pointer and key event carries the live modifier, so the overlay is
  // driven from that fact rather than from one keydown that focus could have
  // swallowed. The ref keeps pointer movement off React's render path.
  const measurePressedRef = useRef(false);
  const syncMeasureModifier = useCallback((pressed: boolean) => {
    if (measurePressedRef.current === pressed) return;
    measurePressedRef.current = pressed;
    setMeasurePressed(pressed);
  }, []);
  // Current viewport pixels drive the bounded live-iframe window.
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  // Disables duplicate frame-create mutations while the exact request runs.
  const [creatingFrame, setCreatingFrame] = useState(false);
  const creatingFrameRef = useRef(false);
  // Owns the one inline rename editor; the filename remains stable.
  const [renamingFrame, setRenamingFrame] = useState<string | null>(null);
  // Keeps the draft isolated from the authoritative frame title.
  const [renameDraft, setRenameDraft] = useState("");
  // Tool choice is interaction-local; only semantic frame/node selection is durable.
  const [activeTool, setActiveTool] = useState<DesignCanvasTool>("select");
  const activeToolRef = useRef<DesignCanvasTool>("select");
  activeToolRef.current = activeTool;
  const activateTool = useCallback((tool: DesignCanvasTool) => {
    activeToolRef.current = tool;
    setActiveTool(tool);
  }, []);
  // The theme matrix is a persistent non-modal tool window launched from the
  // canvas toolbar, so it may coexist with canvas and inspector work.
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);
  const motionOverlayOwner = `${workspaceId ?? ""}\u0000${selectedFrame?.file ?? ""}\u0000${selectedNodeDetails?.oid ?? ""}`;
  const [motionOverlayState, setMotionOverlayState] =
    useState<DesignMotionOverlayState>({
      owner: "",
      draft: null,
    });
  const currentMotionOverlay =
    motionOverlayState.owner === motionOverlayOwner ? motionOverlayState : null;
  const motionSeekIdRef = useRef(0);
  const [motionSeekState, setMotionSeekState] = useState<{
    owner: string;
    request: DesignMotionSeekRequest | null;
  }>({ owner: "", request: null });
  const currentMotionSeekRequest =
    motionSeekState.owner === motionOverlayOwner
      ? motionSeekState.request
      : null;
  const publishMotionDraft = useCallback(
    (draft: DesignMotionTimelineDraft | null) => {
      setMotionOverlayState((current) =>
        current.owner === motionOverlayOwner && current.draft === draft
          ? current
          : {
              owner: motionOverlayOwner,
              draft,
            },
      );
    },
    [motionOverlayOwner],
  );
  const publishMotionPlayhead = useCallback(
    (playhead: number) => {
      publishDesignMotionPlayhead(motionOverlayOwner, playhead);
    },
    [motionOverlayOwner],
  );
  const seekMotionFromCanvas = useCallback(
    (offset: number) => {
      const request = { id: ++motionSeekIdRef.current, offset };
      setMotionSeekState({ owner: motionOverlayOwner, request });
    },
    [motionOverlayOwner],
  );
  const finishMotionSeekRequest = useCallback((id: number) => {
    setMotionSeekState((current) =>
      current.request?.id === id ? { ...current, request: null } : current,
    );
  }, []);
  const themeEditorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusThemeEditorTrigger = useCallback(() => {
    // Radix Slot may own the outer Tooltip ref. The scoped data hook keeps
    // controlled-dialog restoration deterministic without a global selector.
    const trigger =
      themeEditorTriggerRef.current ??
      viewportRef.current?.querySelector<HTMLButtonElement>(
        "[data-design-theme-trigger]",
      );
    trigger?.focus();
  }, []);
  const setThemeEditorOpenWithFocus = useCallback(
    (open: boolean) => {
      setThemeEditorOpen(open);
      if (open) return;
      // Controlled dialogs have no Radix DialogTrigger to restore. Wait until
      // FocusScope has unmounted, then return keyboard users to the canvas tool.
      window.requestAnimationFrame(focusThemeEditorTrigger);
    },
    [focusThemeEditorTrigger],
  );
  const changeActiveTheme = useCallback(
    (theme: string | null) => {
      if (workspaceId) setActiveTheme(workspaceId, theme);
    },
    [setActiveTheme, workspaceId],
  );
  const [hitStackMenu, setHitStackMenu] = useState<CanvasHitStackMenu | null>(
    null,
  );
  const hitStackGenerationRef = useRef(0);
  useEffect(() => {
    hitStackGenerationRef.current += 1;
    setHitStackMenu(null);
  }, [workspaceId, active]);
  const nodeActionRef = useRef(false);
  const [selectionOverlaySuppressed, setSelectionOverlaySuppressed] =
    useState(false);
  const nudgeGestureRef = useRef<
    | {
        mode: "move";
        frame: DesignCanvasFrameWire;
        selectionKey: string;
        nodes: Array<{
          nodeId: string;
          details: DesignRuntimeNodeDetails;
          position: string;
          left: number;
          top: number;
        }>;
        dx: number;
        dy: number;
      }
    | {
        mode: "resize";
        details: DesignRuntimeNodeDetails;
        frame: DesignCanvasFrameWire;
        nodeId: string;
        width: number;
        height: number;
        dw: number;
        dh: number;
      }
    | null
  >(null);
  // Inline text drafts are ephemeral and remain owned by their exact source key.
  const [inlineTextEdit, setInlineTextEdit] = useState<InlineTextEdit | null>(
    null,
  );
  // The browser-owned contenteditable is intentionally uncontrolled. Drafts
  // and preview coalescing stay in refs so one keystroke cannot rerender every
  // frame, selection overlay, Layers row, and inspector field.
  const inlineTextDraftRef = useRef("");
  const inlineTextEditRef = useRef<InlineTextEdit | null>(null);
  inlineTextEditRef.current = inlineTextEdit;
  const inlineTextPreviewRef = useRef<{
    active: Promise<void> | null;
    pending: { edit: ExistingInlineTextEdit; text: string } | null;
  }>({ active: null, pending: null });
  // Orders Escape/blur cancellation and Enter/blur commit deduplication.
  const textCommitGuardRef = useRef(
    createInlineTextCommitGuard<InlineTextEdit>(),
  );
  // Cancels whichever direct-DOM pointer gesture owns global listeners.
  const gestureCancelRef = useRef<(() => void) | null>(null);
  const canvasHoverFrameRef = useRef<number | null>(null);
  // One full computed-style hit test runs at a time; pointer motion replaces
  // the queued sample instead of creating an unbounded runtime waterfall.
  const canvasHoverRequestRef = useRef<Promise<void> | null>(null);
  const canvasHoverOwnerRef = useRef<{
    workspaceId: string;
    folder: string;
    frame: DesignCanvasFrameWire;
  } | null>(null);
  const canvasHoverSampleRef = useRef<{
    workspaceId: string;
    folder: string;
    frame: DesignCanvasFrameWire;
    x: number;
    y: number;
  } | null>(null);
  const wheelViewportRef = useRef<DesignViewport | null>(null);
  const wheelSettleTimerRef = useRef<number | null>(null);
  /** The zoom the camera is actually painted at. A wheel or pinch keeps the
   * store 80ms behind while it paints the world directly, so a gesture that
   * divided pointer travel by the store's number would track the pointer at the
   * wrong rate for the rest of the drag. */
  const liveDesignZoom = useCallback(
    () => wheelViewportRef.current?.zoom ?? view.zoom,
    [view.zoom],
  );
  const cancelPendingWheelGesture = useCallback(() => {
    if (wheelSettleTimerRef.current !== null) {
      window.clearTimeout(wheelSettleTimerRef.current);
      wheelSettleTimerRef.current = null;
    }
    wheelViewportRef.current = null;
    worldRef.current?.removeAttribute("data-design-camera-gesture");
  }, []);
  // A retained canvas may change workspace owner before an 80ms trackpad
  // settle fires. Never let that old gesture publish into a hidden owner.
  useEffect(
    () => () => cancelPendingWheelGesture(),
    [cancelPendingWheelGesture, workspaceId],
  );
  useLayoutEffect(() => {
    if (wheelViewportRef.current) return;
    paintDesignCanvasCamera(
      worldRef.current,
      { zoom: view.zoom, panX: view.panX, panY: view.panY },
      false,
    );
  }, [view.panX, view.panY, view.zoom]);
  const liveFrameFilesRef = useRef<{
    owner: string;
    files: ReadonlySet<string>;
  }>({ owner: "", files: new Set() });
  const liveFrameOwner = `${workspaceId ?? ""}\0${folder ?? ""}`;
  // Layers reads each open frame's runtime tree, so an open frame is a demand
  // for a live runtime exactly like the selection is.
  const layerDisclosures = useDesignWorkspaceDisclosure(workspaceId);
  const layersOpenFiles = useMemo(
    () =>
      Object.entries(layerDisclosures)
        .filter(([, disclosure]) => disclosure.treeExpanded)
        .map(([file]) => file),
    [layerDisclosures],
  );
  const liveFrameFiles = useMemo(() => {
    const previous =
      liveFrameFilesRef.current.owner === liveFrameOwner
        ? liveFrameFilesRef.current.files
        : new Set<string>();
    const frames = snapshot?.frames ?? [];
    const next =
      active && snapshot
        ? selectLiveDesignFrameFiles({
            frames,
            viewport: viewportSize,
            view,
            selectedFrame: selectedFrame?.file ?? null,
            maxLive: MAX_LIVE_DESIGN_FRAMES,
            requiredFiles: layersOpenFiles,
          })
        : new Set<string>();
    const files = retainLiveDesignFrameFiles({
      previous,
      available: frames.map((frame) => frame.file),
      active,
      maxLive: MAX_LIVE_DESIGN_FRAMES,
      next,
    });
    return files;
  }, [
    active,
    layersOpenFiles,
    liveFrameOwner,
    selectedFrame?.file,
    snapshot,
    view,
    viewportSize,
  ]);
  useLayoutEffect(() => {
    liveFrameFilesRef.current = {
      owner: liveFrameOwner,
      files: liveFrameFiles,
    };
  }, [liveFrameFiles, liveFrameOwner]);
  const highResolutionTiles = useMemo(() => {
    const result = new Map<string, DesignHighResolutionViewportTile>();
    if (
      !active ||
      view.codeView ||
      view.zoom < HIGH_RESOLUTION_ZOOM_THRESHOLD ||
      viewportSize.width <= 0 ||
      viewportSize.height <= 0
    ) {
      return result;
    }
    const devicePixelRatio =
      typeof window === "undefined" ? 1 : window.devicePixelRatio;
    const candidates = (snapshot?.frames ?? [])
      .map((frame) => ({
        frame,
        tile: designHighResolutionViewportTile({
          frame,
          view: {
            zoom: view.zoom,
            panX: view.panX,
            panY: view.panY,
          },
          viewport: viewportSize,
          devicePixelRatio,
          overscan: HIGH_RESOLUTION_TILE_OVERSCAN,
        }),
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          frame: DesignCanvasFrameWire;
          tile: DesignHighResolutionViewportTile;
        } => candidate.tile !== null,
      )
      .sort(
        (left, right) =>
          Number(right.frame.file === selectedFrame?.file) -
            Number(left.frame.file === selectedFrame?.file) ||
          right.frame.z - left.frame.z ||
          left.frame.file.localeCompare(right.frame.file),
      )
      .slice(0, MAX_HIGH_RESOLUTION_TILES);
    for (const candidate of candidates) {
      result.set(candidate.frame.file, candidate.tile);
    }
    return result;
  }, [
    active,
    selectedFrame?.file,
    snapshot?.frames,
    view.codeView,
    view.panX,
    view.panY,
    view.zoom,
    viewportSize,
  ]);
  /** Clears any node selection and makes `frame` the active frame. Passing
   * `selected: true` additionally marks the frame itself as the selection
   * target (label click, hit-stack, Escape) — the only paths that show frame
   * chrome. Everything else is activation, the "nothing selected" state. */
  const publishSelection = useCallback(
    (frame: DesignCanvasFrameWire | null, options?: { selected?: boolean }) => {
      if (!workspaceId) return;
      void selectDesignFrame(workspaceId, frame, options).catch(
        (selectionError) => {
          toast.error("Couldn't update the design selection", {
            description: errorMessage(selectionError),
          });
        },
      );
    },
    [workspaceId],
  );

  // The first authoritative fallback is a real activation too: publish it so
  // get_selection agrees with the inspector before the user clicks anything.
  // The user's frame-selected state survives snapshot republication verbatim.
  useEffect(() => {
    if (!active || !snapshot) return;
    if (view.selectedNodeId) return;
    publishSelection(selectedFrame, { selected: view.frameSelected });
  }, [
    active,
    publishSelection,
    selectedFrame,
    snapshot,
    view.frameSelected,
    view.selectedNodeId,
  ]);

  useLayoutEffect(() => {
    if (!active) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const publish = () => {
      const bounds = viewport.getBoundingClientRect();
      const next = {
        width: Math.max(0, Math.round(bounds.width)),
        height: Math.max(0, Math.round(bounds.height)),
      };
      setViewportSize((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [active]);

  /** Fit a stable frame set from current DOM bounds without awaiting data. */
  const fitFrames = useCallback(
    (frames: readonly DesignCanvasFrameWire[]) => {
      if (!workspaceId || frames.length === 0) return;
      const bounds = viewportRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const next = fitDesignRects(
        frames.map((frame) => ({
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
        })),
        { width: bounds.width, height: bounds.height },
      );
      if (!next) return;
      // Toolbar intent wins over any wheel burst that has painted but not yet
      // settled into the store; otherwise its old timer snaps the canvas back.
      cancelPendingWheelGesture();
      paintDesignCanvasCamera(worldRef.current, next, false);
      setViewport(workspaceId, next);
    },
    [cancelPendingWheelGesture, setViewport, workspaceId],
  );

  /** Zoom about a screen point so the content beneath it does not jump. */
  const zoomAt = useCallback(
    (
      nextZoom: number | ((currentZoom: number) => number),
      point?: { x: number; y: number },
    ) => {
      if (!workspaceId) return;
      const bounds = viewportRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const anchor = point ?? {
        x: bounds.width / 2,
        y: bounds.height / 2,
      };
      const current = wheelViewportRef.current ?? view;
      const targetZoom =
        typeof nextZoom === "function" ? nextZoom(current.zoom) : nextZoom;
      const next = zoomDesignViewportAtPoint(current, targetZoom, anchor);
      cancelPendingWheelGesture();
      paintDesignCanvasCamera(worldRef.current, next, false);
      setViewport(workspaceId, next);
    },
    [cancelPendingWheelGesture, setViewport, view, workspaceId],
  );

  useLayoutEffect(() => {
    if (!active) return;
    const actions: DesignCanvasZoomActions = {
      zoomIn: () => zoomAt((currentZoom) => currentZoom * 1.2),
      zoomOut: () => zoomAt((currentZoom) => currentZoom / 1.2),
    };
    zoomActionsRef.current = actions;
    return () => {
      if (zoomActionsRef.current === actions) zoomActionsRef.current = null;
    };
  }, [active, zoomActionsRef, zoomAt]);

  /** Frame creation returns the aggregate snapshot, avoiding a follow-up read.
   * Drawn geometry is authored in that same mutation, so no default-size frame
   * can flash before a second resize write. */
  const createFrame = useCallback(
    async (geometry?: DesignFrameGeometryWire) => {
      if (!workspaceId || creatingFrameRef.current) return null;
      creatingFrameRef.current = true;
      setCreatingFrame(true);
      try {
        const result = await createDesignFrameAndRefresh(
          workspaceId,
          undefined,
          geometry,
        );
        const created = result.snapshot.frames.find(
          (frame) => frame.file === result.frame.file,
        );
        if (created) {
          publishSelection(created, { selected: true });
          if (!geometry) fitFrames([created]);
        }
        return created ?? null;
      } catch (createError) {
        toast.error("Couldn't create a design frame", {
          description: errorMessage(createError),
        });
        return null;
      } finally {
        creatingFrameRef.current = false;
        setCreatingFrame(false);
      }
    },
    [fitFrames, publishSelection, workspaceId],
  );

  /** Title edits are surgical source splices; filenames remain Git-stable. */
  const commitRename = useCallback(
    async (frame: DesignCanvasFrameWire) => {
      const title = renameDraft.trim();
      setRenamingFrame(null);
      if (!workspaceId || !title || title === frame.title) return;
      try {
        await renameDesignFrameAndRefresh(workspaceId, frame.file, title);
      } catch (renameError) {
        toast.error("Couldn't rename the design frame", {
          description: errorMessage(renameError),
        });
      }
    },
    [renameDraft, workspaceId],
  );

  const commitInlineText = useCallback(
    async (
      edit: InlineTextEdit,
      measured: { width: number; height: number },
    ) => {
      const key = `${edit.frame ?? "canvas"}\u0000${edit.nodeId}\u0000${edit.sourceVersion ?? "draft"}`;
      if (!beginInlineTextCommit(textCommitGuardRef.current, edit, key)) return;
      const draft = inlineTextDraftRef.current.slice(0, 10_000);
      if (!workspaceId) {
        setInlineTextEdit(null);
        finishInlineTextCommit(textCommitGuardRef.current, key);
        return;
      }
      if (edit.kind === "new" && draft.trim().length === 0) {
        if (edit.previousFrame) {
          useDesignWorkspaceUiStore
            .getState()
            .setSelection(
              workspaceId,
              edit.previousFrame,
              edit.previousNodeId,
              edit.previousNodeIds,
            );
        }
        setInlineTextEdit(null);
        finishInlineTextCommit(textCommitGuardRef.current, key);
        return;
      }
      if (edit.kind === "existing" && draft === edit.initialText) {
        void clearDesignNodeTextPreviewTransient({
          workspaceId,
          frame: edit.frame,
          sourceVersion: edit.sourceVersion,
          nodeId: edit.nodeId,
        }).catch(() => {});
        setInlineTextEdit(null);
        finishInlineTextCommit(textCommitGuardRef.current, key);
        return;
      }
      setInlineTextEdit((current) =>
        current?.id === edit.id
          ? { ...current, status: "committing" }
          : current,
      );
      try {
        if (edit.kind === "existing") {
          const foundation = await designFoundationCache.load(
            designFoundationKey(workspaceId, edit.frame, edit.sourceVersion),
            () =>
              fetchDesignFoundation(
                designFoundationKey(
                  workspaceId,
                  edit.frame,
                  edit.sourceVersion,
                ),
              ),
            { maxAgeMs: Number.POSITIVE_INFINITY },
          );
          const preserveLineBreaks =
            draft.includes("\n") &&
            !["pre", "pre-wrap", "pre-line", "break-spaces"].includes(
              edit.whiteSpace,
            );
          const result = await applyDesignTransactionCached(
            workspaceId,
            edit.frame,
            {
              schemaVersion: 1,
              transactionId: `desktop:${crypto.randomUUID()}`,
              documentId: foundation.summary.documentId,
              baseRevision: foundation.summary.revision,
              actor: { kind: "human", id: "desktop" },
              intent: `Edit text in ${edit.nodeId}`,
              createdAt: Date.now(),
              operations: [
                {
                  operationId: `text:${crypto.randomUUID()}`,
                  type: "node.set-text",
                  nodeId: edit.nodeId,
                  text: draft,
                },
                ...(preserveLineBreaks
                  ? ([
                      {
                        operationId: `text-wrap:${crypto.randomUUID()}`,
                        type: "node.set-styles",
                        nodeId: edit.nodeId,
                        styles: { "white-space": "pre-wrap" },
                        scope: "auto",
                        responsiveContext: "base",
                        stateContext: "default",
                      },
                    ] as const)
                  : []),
              ],
            },
          );
          const nextFrame = result.snapshot?.frames.find(
            (frame) => frame.file === edit.frame,
          );
          if (!nextFrame) {
            throw new Error("The edited text frame is no longer available.");
          }
          // Keep the host glyphs and clean editing boundary mounted over the
          // paint-suppressed outgoing runtime until the exact incoming source
          // generation has laid out. This prevents the old/new text blink.
          setInlineTextEdit((current) =>
            current?.id === edit.id
              ? {
                  ...edit,
                  sourceVersion: nextFrame.sourceVersion,
                  status: "settling",
                }
              : current,
          );
        } else {
          if (edit.owner === "canvas" && !edit.frame) {
            const width = Math.min(
              16_384,
              Math.max(1, Math.ceil(edit.width ?? measured.width)),
            );
            const height = Math.min(
              16_384,
              Math.max(1, Math.ceil(edit.height ?? measured.height)),
            );
            const result = await createDesignFrameAndRefresh(
              workspaceId,
              draft.trim().split(/\r?\n/, 1)[0]?.slice(0, 48) || "Text",
              {
                x: edit.canvasX,
                y: edit.canvasY,
                w: width,
                h: height,
                z: Math.min(
                  256,
                  Math.max(
                    0,
                    ...(snapshot?.frames.map((frame) => frame.z + 1) ?? [0]),
                  ),
                ),
              },
              {
                kind: "text",
                nodeId: edit.nodeId,
                text: draft,
                fixedSize: edit.width !== undefined,
              },
            );
            const created = result.snapshot.frames.find(
              (frame) => frame.file === result.frame.file,
            );
            if (!created) {
              throw new Error("The created canvas text is unavailable.");
            }
            useDesignWorkspaceUiStore
              .getState()
              .setSelection(workspaceId, created.file, edit.nodeId);
            setInlineTextEdit((current) =>
              current?.id === edit.id
                ? {
                    ...edit,
                    frame: created.file,
                    sourceVersion: created.sourceVersion,
                    canvasX: 0,
                    canvasY: 0,
                    width,
                    height,
                    status: "settling",
                  }
                : current,
            );
            return;
          }
          if (!edit.frame || !edit.sourceVersion || !edit.parentNodeId) {
            throw new Error("The text insertion owner is no longer available.");
          }
          const result = await appendDesignNodeHtmlCached(workspaceId, {
            frame: edit.frame,
            nodeId: edit.parentNodeId,
            sourceVersion: edit.sourceVersion,
            html: createDesignTextMarkup({
              nodeId: edit.nodeId,
              text: draft,
              x: edit.x,
              y: edit.y,
              placement: edit.placement,
              ...(edit.width === undefined
                ? {}
                : { width: edit.width, height: edit.height }),
            }),
          });
          const nextFrame = result.snapshot.frames.find(
            (frame) => frame.file === edit.frame,
          );
          if (!nextFrame) {
            throw new Error("The created text frame is no longer available.");
          }
          const currentSelection = designWorkspaceView(workspaceId);
          const editorStillOwnsSelection =
            currentSelection.selectedFrame === edit.frame &&
            currentSelection.selectedNodeId === null;
          if (editorStillOwnsSelection) {
            useDesignWorkspaceUiStore
              .getState()
              .setSelection(workspaceId, edit.frame, edit.nodeId);
          }
          setInlineTextEdit((current) => {
            if (current?.id !== edit.id) return current;
            return editorStillOwnsSelection
              ? {
                  ...edit,
                  sourceVersion: nextFrame.sourceVersion,
                  status: "settling",
                }
              : null;
          });
        }
      } catch (textError) {
        if (edit.kind === "existing") {
          void clearDesignNodeTextPreviewTransient({
            workspaceId,
            frame: edit.frame,
            sourceVersion: edit.sourceVersion,
            nodeId: edit.nodeId,
          }).catch(() => {});
        }
        setInlineTextEdit((current) =>
          current?.id === edit.id ? { ...edit, status: "editing" } : current,
        );
        toast.error("Couldn't edit the design text", {
          description: errorMessage(textError),
        });
      } finally {
        finishInlineTextCommit(textCommitGuardRef.current, key);
      }
    },
    [snapshot?.frames, workspaceId],
  );

  /** Text targeting is one-shot. Once an editable leaf is found, return to
   * Select while the independent inline editor owns keyboard input. */
  const finishInlineTextTool = useCallback(
    (frame: DesignCanvasFrameWire, details: DesignRuntimeNodeDetails) => {
      const initialText = details.text ?? "";
      inlineTextDraftRef.current = initialText;
      activateTool("select");
      setInlineTextEdit({
        id: crypto.randomUUID(),
        kind: "existing",
        frame: frame.file,
        nodeId: details.oid,
        sourceVersion: frame.sourceVersion,
        initialText,
        whiteSpace: details.styles.whiteSpace ?? "normal",
        status: "editing",
        initialDetails: details,
      });
    },
    [activateTool],
  );

  /** Runtime glyph paint is suppressed only after the host editor has
   * actually mounted with the same text. Requesting suppression before the
   * editor exists made the node invisible whenever selection readback was
   * slow or failed; in the worst remaining case identical glyphs briefly
   * double-paint instead. */
  const suppressInlineTextGlyphs = useCallback(
    (edit: InlineTextEdit) => {
      if (edit.kind !== "existing" || !workspaceId) return;
      void previewDesignNodeTextTransient({
        workspaceId,
        frame: edit.frame,
        sourceVersion: edit.sourceVersion,
        nodeId: edit.nodeId,
        text: inlineTextDraftRef.current || edit.initialText,
      }).catch(() => {
        // The host editor is still authoritative if a source handoff wins
        // this speculative paint-suppression request.
      });
    },
    [workspaceId],
  );

  const previewInlineTextDraft = useCallback(
    (edit: InlineTextEdit, text: string) => {
      const draft = text.slice(0, 10_000);
      inlineTextDraftRef.current = draft;
      if (
        edit.kind !== "existing" ||
        edit.status !== "editing" ||
        !workspaceId
      ) {
        return;
      }
      const queue = inlineTextPreviewRef.current;
      queue.pending = { edit, text: draft };
      if (queue.active) return;
      const request = (async () => {
        while (queue.pending) {
          const pending = queue.pending;
          queue.pending = null;
          if (inlineTextEditRef.current?.id !== pending.edit.id) continue;
          await previewDesignNodeTextTransient({
            workspaceId,
            frame: pending.edit.frame,
            sourceVersion: pending.edit.sourceVersion,
            nodeId: pending.edit.nodeId,
            text: pending.text,
          }).catch(() => {
            // A source handoff or cancellation invalidates the speculative
            // preview. The uncontrolled editor still owns the visible draft.
          });
        }
      })().finally(() => {
        if (queue.active === request) queue.active = null;
      });
      queue.active = request;
    },
    [workspaceId],
  );

  const cancelInlineTextEditing = useCallback(
    (edit: InlineTextEdit) => {
      cancelInlineTextCommit(textCommitGuardRef.current, edit);
      if (inlineTextPreviewRef.current.pending?.edit.id === edit.id) {
        inlineTextPreviewRef.current.pending = null;
      }
      if (workspaceId && edit.kind === "existing") {
        void clearDesignNodeTextPreviewTransient({
          workspaceId,
          frame: edit.frame,
          sourceVersion: edit.sourceVersion,
          nodeId: edit.nodeId,
        }).catch(() => {});
      }
      if (workspaceId && edit.kind === "new") {
        const store = useDesignWorkspaceUiStore.getState();
        if (edit.previousFrame) {
          store.setSelection(
            workspaceId,
            edit.previousFrame,
            edit.previousNodeId,
            edit.previousNodeIds,
          );
        } else {
          store.setSelectedFrame(workspaceId, null);
        }
      }
      setInlineTextEdit((current) =>
        current?.id === edit.id ? null : current,
      );
      activateTool("select");
      window.requestAnimationFrame(() => {
        // A rapid double-click can already have opened a new editor. The
        // cancelled edit must not steal its focus and trigger an immediate blur.
        if (!inlineTextEditRef.current) {
          viewportRef.current?.focus({ preventScroll: true });
        }
      });
    },
    [activateTool, workspaceId],
  );

  // Created and edited text settles only when the exact committed document is
  // the *displayed* buffer, not merely when its incoming runtime reports ready.
  // Runtime readback intentionally precedes the two-frame compositor swap. If
  // editor teardown follows that early readback it creates a blank interval;
  // if it follows a durable selection request it can leave host + iframe glyphs
  // painted together. Observe the actual buffer handoff, hide the host glyph in
  // the same microtask, then unmount and persist selection independently.
  useLayoutEffect(() => {
    const edit = inlineTextEdit;
    if (
      !workspaceId ||
      !folder ||
      !edit ||
      edit.status !== "settling" ||
      !selectedFrame ||
      selectedFrame.file !== edit.frame ||
      selectedFrame.sourceVersion !== edit.sourceVersion
    ) {
      return;
    }
    const viewport = viewportRef.current;
    const frameElement = viewport?.querySelector<HTMLElement>(
      `[data-design-frame="${CSS.escape(edit.frame)}"]`,
    );
    if (!frameElement) return;
    let settled = false;
    const settleDisplayedText = () => {
      if (settled) return true;
      const displayed = frameElement.querySelector<HTMLIFrameElement>(
        'iframe[data-design-document-buffer="displayed"]',
      );
      if (
        displayed?.dataset.designDocumentSourceVersion !== edit.sourceVersion
      ) {
        return false;
      }
      settled = true;
      const editor = frameElement.querySelector<HTMLElement>(
        "[data-design-inline-text-editor]",
      );
      if (editor) {
        editor.style.visibility = "hidden";
        editor.style.pointerEvents = "none";
      }
      setInlineTextEdit((current) =>
        current?.id === edit.id ? null : current,
      );
      const exactDetails =
        selectedNodeDetails?.oid === edit.nodeId &&
        selectedNodeDetails.sourceVersion === edit.sourceVersion
          ? selectedNodeDetails
          : undefined;
      void selectDesignNode({
        workspaceId,
        folder,
        frame: selectedFrame,
        nodeId: edit.nodeId,
        ...(exactDetails
          ? { details: exactDetails }
          : { forceRuntimeRead: true }),
      }).catch(() => {
        // Local semantic selection remains authoritative. A later exact ready
        // event republishes it if this generation changes again mid-request.
      });
      return true;
    };
    if (settleDisplayedText()) return;
    const observer = new MutationObserver(settleDisplayedText);
    observer.observe(frameElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "data-design-document-buffer",
        "data-design-document-source-version",
      ],
    });
    return () => {
      observer.disconnect();
    };
  }, [folder, inlineTextEdit, selectedFrame, selectedNodeDetails, workspaceId]);

  const insertAsset = useCallback(
    async (
      frame: DesignCanvasFrameWire,
      assetPath: string,
      point: { x: number; y: number },
    ) => {
      if (!workspaceId) return;
      try {
        await insertDesignAssetCached(workspaceId, {
          frame: frame.file,
          sourceVersion: frame.sourceVersion,
          assetPath,
          x: point.x,
          y: point.y,
        });
      } catch (assetError) {
        toast.error("Couldn't insert the design asset", {
          description: errorMessage(assetError),
        });
      }
    },
    [workspaceId],
  );

  const applyCanvasNodeOperation = useCallback(
    async (
      action: "duplicate" | "delete",
      nodeIds: readonly string[],
      duplicateNodeIds: readonly string[] = [],
      duplicateMode: "copy" | "duplicate" = "duplicate",
    ) => {
      if (
        !workspaceId ||
        !folder ||
        !selectedFrame ||
        nodeActionRef.current ||
        nodeIds.length === 0
      ) {
        return;
      }
      if (
        action === "duplicate" &&
        duplicateNodeIds.length !== nodeIds.length
      ) {
        throw new Error("Every selected element needs a duplicate identity.");
      }
      nodeActionRef.current = true;
      try {
        const foundation =
          canvasFoundation.data ??
          (await designFoundationCache.load(
            designFoundationKey(
              workspaceId,
              selectedFrame.file,
              selectedFrame.sourceVersion,
            ),
            () =>
              fetchDesignFoundation(
                designFoundationKey(
                  workspaceId,
                  selectedFrame.file,
                  selectedFrame.sourceVersion,
                ),
              ),
            { maxAgeMs: Number.POSITIVE_INFINITY },
          ));
        const operations: DesignOperation[] = nodeIds.map((nodeId, index) =>
          action === "duplicate"
            ? {
                operationId: `duplicate:${crypto.randomUUID()}`,
                type: "node.duplicate",
                nodeId,
                duplicateNodeId: duplicateNodeIds[index]!,
              }
            : {
                operationId: `delete:${crypto.randomUUID()}`,
                type: "node.delete",
                nodeId,
              },
        );
        const result = await applyDesignTransactionCached(
          workspaceId,
          selectedFrame.file,
          {
            schemaVersion: 1,
            transactionId: `desktop:${crypto.randomUUID()}`,
            documentId: foundation.summary.documentId,
            baseRevision: foundation.summary.revision,
            actor: { kind: "human", id: "desktop" },
            intent:
              action === "duplicate"
                ? `${duplicateMode === "copy" ? "Copy" : "Duplicate"} ${nodeIds.length} selected ${nodeIds.length === 1 ? "layer" : "layers"}`
                : `Delete ${nodeIds.length} selected ${nodeIds.length === 1 ? "layer" : "layers"}`,
            createdAt: Date.now(),
            operations,
          },
        );
        if (action === "duplicate") {
          const currentFrame =
            result.snapshot?.frames.find(
              (candidate) => candidate.file === selectedFrame.file,
            ) ?? selectedFrame;
          await selectDesignFrame(workspaceId, currentFrame);
          void selectDesignNodes({
            workspaceId,
            folder,
            frame: currentFrame,
            nodeIds: duplicateNodeIds,
            primaryNodeId: duplicateNodeIds[0],
          }).catch(() => {
            // The replacement iframe's ready snapshot retries the semantic
            // selection after it owns the duplicate source generation.
          });
          toast.success(
            nodeIds.length === 1
              ? duplicateMode === "copy"
                ? "Element copied"
                : "Element duplicated"
              : duplicateMode === "copy"
                ? "Elements copied"
                : "Elements duplicated",
          );
        } else {
          const currentFrame =
            result.snapshot?.frames.find(
              (candidate) => candidate.file === selectedFrame.file,
            ) ?? selectedFrame;
          // The deletion is already durable. Keep selection persistence off
          // its critical path so a transient selection write cannot turn a
          // successful delete into an error toast.
          void selectDesignFrame(workspaceId, currentFrame).catch(() => {});
        }
      } finally {
        nodeActionRef.current = false;
      }
    },
    [canvasFoundation.data, folder, selectedFrame, workspaceId],
  );

  const duplicateSelectedNode = useCallback(
    async (duplicateMode: "copy" | "duplicate" = "duplicate") => {
      const nodeIds = designLayerTopLevelSelectionIds(
        selectedRuntimeTree,
        view.selectedNodeIds,
      );
      if (nodeIds.length === 0) return;
      const duplicateNodeIds = nodeIds.map((nodeId) => {
        const suffix = crypto.randomUUID().slice(0, 8);
        return `${nodeId.slice(0, Math.max(1, 242 - suffix.length))}-copy-${suffix}`;
      });
      try {
        await applyCanvasNodeOperation(
          "duplicate",
          nodeIds,
          duplicateNodeIds,
          duplicateMode,
        );
      } catch (error) {
        toast.error(
          duplicateMode === "copy"
            ? "Couldn't copy the element"
            : "Couldn't duplicate the element",
          { description: errorMessage(error) },
        );
      }
    },
    [applyCanvasNodeOperation, selectedRuntimeTree, view.selectedNodeIds],
  );

  const duplicateSelectedFrame = useCallback(
    async (duplicateMode: "copy" | "duplicate" = "duplicate") => {
      if (!workspaceId || !selectedFrame || nodeActionRef.current) return;
      nodeActionRef.current = true;
      try {
        const result = await duplicateDesignFrameCached(
          workspaceId,
          selectedFrame.file,
        );
        const duplicate = result.snapshot.frames.find(
          (candidate) => candidate.file === result.frame.file,
        );
        if (duplicate) {
          await selectDesignFrame(workspaceId, duplicate, { selected: true });
        }
        toast.success(
          duplicateMode === "copy" ? "Frame copied" : "Frame duplicated",
        );
      } catch (error) {
        toast.error(
          duplicateMode === "copy"
            ? "Couldn't copy the frame"
            : "Couldn't duplicate the frame",
          { description: errorMessage(error) },
        );
      } finally {
        nodeActionRef.current = false;
      }
    },
    [selectedFrame, workspaceId],
  );

  const deleteSelectedNode = useCallback(async () => {
    if (selectedFrame?.kind === "text") {
      await onDeleteFrame(selectedFrame);
      return;
    }
    const nodeIds = designLayerTopLevelSelectionIds(
      selectedRuntimeTree,
      view.selectedNodeIds,
    );
    if (nodeIds.length === 0) return;
    try {
      await applyCanvasNodeOperation("delete", nodeIds);
    } catch (error) {
      toast.error("Couldn't delete the element", {
        description: errorMessage(error),
      });
    }
  }, [
    applyCanvasNodeOperation,
    onDeleteFrame,
    selectedFrame,
    selectedRuntimeTree,
    view.selectedNodeIds,
  ]);

  const navigateToNode = useCallback(
    (nodeId: string) => {
      if (!workspaceId || !folder || !selectedFrame) return;
      void selectDesignNode({
        workspaceId,
        folder,
        frame: selectedFrame,
        nodeId,
      }).catch((selectionError) => {
        toast.error("Couldn't navigate to that design layer", {
          description: errorMessage(selectionError),
        });
      });
    },
    [folder, selectedFrame, workspaceId],
  );

  const previewMotion = useCallback(
    async (
      draft: DesignMotionTimelineDraft,
      currentTime: number,
      playing: boolean,
    ) => {
      if (
        !motionTimelineOpen ||
        !workspaceId ||
        !selectedFrame ||
        !selectedNodeDetails
      ) {
        return;
      }
      await previewDesignNodeMotionTransient({
        workspaceId,
        frame: selectedFrame.file,
        sourceVersion: selectedFrame.sourceVersion,
        nodeId: selectedNodeDetails.oid,
        motion: designMotionPreviewInput(draft, currentTime, playing),
      });
    },
    [motionTimelineOpen, selectedFrame, selectedNodeDetails, workspaceId],
  );

  const clearMotionPreview = useCallback(async () => {
    if (!workspaceId || !selectedFrame || !selectedNodeDetails) return;
    await clearDesignNodeStylePreviewTransient({
      workspaceId,
      frame: selectedFrame.file,
      sourceVersion: selectedFrame.sourceVersion,
      nodeId: selectedNodeDetails.oid,
    });
  }, [selectedFrame, selectedNodeDetails, workspaceId]);

  const saveMotion = useCallback(
    async (draft: DesignMotionTimelineDraft) => {
      const foundation = canvasFoundation.data;
      if (
        !workspaceId ||
        !selectedFrame ||
        !selectedNodeDetails ||
        !foundation
      ) {
        throw new Error(
          "The selected element is not ready for motion editing.",
        );
      }
      await applyDesignTransactionCached(workspaceId, selectedFrame.file, {
        schemaVersion: 1,
        transactionId: `desktop:${crypto.randomUUID()}`,
        documentId: foundation.summary.documentId,
        baseRevision: foundation.summary.revision,
        actor: { kind: "human", id: "desktop" },
        intent: `Set ${draft.name} motion`,
        createdAt: Date.now(),
        operations: [
          {
            operationId: `keyframes:${crypto.randomUUID()}`,
            type: "keyframes.set",
            file: draft.file,
            name: draft.name,
            keyframes: draft.keyframes.map((keyframe) => ({
              offset: keyframe.offset,
              styles: { ...keyframe.styles },
            })),
          },
          {
            operationId: `animation:${crypto.randomUUID()}`,
            type: "node.set-styles",
            nodeId: selectedNodeDetails.oid,
            styles: {
              "animation-name": draft.name,
              "animation-duration": draft.duration,
              "animation-timing-function": draft.easing,
              "animation-delay": draft.delay,
              "animation-iteration-count": draft.iterations,
              "animation-direction": draft.direction,
              "animation-fill-mode": draft.fillMode,
            },
            scope: "auto",
            responsiveContext: "base",
            stateContext: "default",
          },
        ],
      });
    },
    [canvasFoundation.data, selectedFrame, selectedNodeDetails, workspaceId],
  );

  const deleteMotion = useCallback(async () => {
    const foundation = canvasFoundation.data;
    if (!workspaceId || !selectedFrame || !selectedNodeDetails || !foundation) {
      throw new Error("The selected element is not ready for motion editing.");
    }
    await applyDesignTransactionCached(workspaceId, selectedFrame.file, {
      schemaVersion: 1,
      transactionId: `desktop:${crypto.randomUUID()}`,
      documentId: foundation.summary.documentId,
      baseRevision: foundation.summary.revision,
      actor: { kind: "human", id: "desktop" },
      intent: `Remove motion from ${selectedNodeDetails.name}`,
      createdAt: Date.now(),
      operations: [
        {
          operationId: `animation:${crypto.randomUUID()}`,
          type: "node.set-styles",
          nodeId: selectedNodeDetails.oid,
          styles: {
            animation: null,
            "animation-name": "none",
            "animation-duration": null,
            "animation-timing-function": null,
            "animation-delay": null,
            "animation-iteration-count": null,
            "animation-direction": null,
            "animation-fill-mode": null,
            "animation-play-state": null,
          },
          scope: "auto",
          responsiveContext: "base",
          stateContext: "default",
        },
      ],
    });
  }, [canvasFoundation.data, selectedFrame, selectedNodeDetails, workspaceId]);

  const nudgeSelectedNode = useCallback(
    (deltaX: number, deltaY: number) => {
      if (!workspaceId || !selectedFrame || !selectedNodeDetails) return false;
      const pixel = (value: string | undefined) => {
        const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value?.trim() ?? "");
        return match?.[1] ? Number(match[1]) : 0;
      };
      const topLevelIds = designLayerTopLevelSelectionIds(
        selectedRuntimeTree,
        view.selectedNodeIds,
      );
      const detailsById = new Map(
        selectedNodeDetailsList.map((details) => [details.oid, details]),
      );
      const nodes = topLevelIds.flatMap((nodeId) => {
        const details = detailsById.get(nodeId);
        return details
          ? [
              {
                nodeId,
                details,
                position:
                  details.styles.position === "static"
                    ? "relative"
                    : details.styles.position || "relative",
                left: pixel(details.styles.left),
                top: pixel(details.styles.top),
              },
            ]
          : [];
      });
      if (nodes.length === 0) return false;
      const selectionKey = nodes.map((node) => node.nodeId).join("\u0000");
      const current = nudgeGestureRef.current;
      const gesture =
        current?.mode === "move" &&
        current.frame.file === selectedFrame.file &&
        current.selectionKey === selectionKey
          ? current
          : {
              mode: "move" as const,
              frame: selectedFrame,
              selectionKey,
              nodes,
              dx: 0,
              dy: 0,
            };
      gesture.dx += deltaX;
      gesture.dy += deltaY;
      nudgeGestureRef.current = gesture;
      setSelectionOverlaySuppressed(true);
      void Promise.all(
        gesture.nodes.map((node) =>
          previewDesignNodeStylesTransient({
            workspaceId,
            frame: gesture.frame.file,
            sourceVersion: gesture.frame.sourceVersion,
            nodeId: node.nodeId,
            styles: preserveDesignLayoutPins(node.details, {
              position: node.position,
              left: `${Math.round(node.left + gesture.dx)}px`,
              top: `${Math.round(node.top + gesture.dy)}px`,
            }),
          }),
        ),
      ).catch(() => {});
      return true;
    },
    [
      selectedFrame,
      selectedNodeDetails,
      selectedNodeDetailsList,
      selectedRuntimeTree,
      view.selectedNodeIds,
      workspaceId,
    ],
  );

  const resizeSelectedNode = useCallback(
    (deltaWidth: number, deltaHeight: number) => {
      if (
        !workspaceId ||
        !selectedFrame ||
        !selectedNodeDetails ||
        view.selectedNodeIds.length > 1
      ) {
        return false;
      }
      const current = nudgeGestureRef.current;
      const gesture =
        current?.mode === "resize" &&
        current.frame.file === selectedFrame.file &&
        current.nodeId === selectedNodeDetails.oid
          ? current
          : {
              mode: "resize" as const,
              details: selectedNodeDetails,
              frame: selectedFrame,
              nodeId: selectedNodeDetails.oid,
              // The element's own box, not the larger bounding box a rotation
              // grows around it, or the first keypress would resize by the
              // difference between them.
              width: Math.max(1, designSelectionBox(selectedNodeDetails).width),
              height: Math.max(
                1,
                designSelectionBox(selectedNodeDetails).height,
              ),
              dw: 0,
              dh: 0,
            };
      gesture.dw += deltaWidth;
      gesture.dh += deltaHeight;
      nudgeGestureRef.current = gesture;
      setSelectionOverlaySuppressed(true);
      void previewDesignNodeStylesTransient({
        workspaceId,
        frame: gesture.frame.file,
        sourceVersion: gesture.frame.sourceVersion,
        nodeId: gesture.nodeId,
        styles: preserveDesignLayoutPins(gesture.details, {
          width: `${Math.max(1, Math.round(gesture.width + gesture.dw))}px`,
          height: `${Math.max(1, Math.round(gesture.height + gesture.dh))}px`,
        }),
      }).catch(() => {});
      return true;
    },
    [
      selectedFrame,
      selectedNodeDetails,
      view.selectedNodeIds.length,
      workspaceId,
    ],
  );

  const finishNodeNudge = useCallback(() => {
    const gesture = nudgeGestureRef.current;
    nudgeGestureRef.current = null;
    if (!gesture || !workspaceId) {
      setSelectionOverlaySuppressed(false);
      return;
    }
    const updates =
      gesture.mode === "move"
        ? gesture.nodes.map((node) => ({
            nodeId: node.nodeId,
            styles: preserveDesignLayoutPins(node.details, {
              position: node.position,
              left: `${Math.round(node.left + gesture.dx)}px`,
              top: `${Math.round(node.top + gesture.dy)}px`,
            }),
          }))
        : [
            {
              nodeId: gesture.nodeId,
              styles: preserveDesignLayoutPins(gesture.details, {
                width: `${Math.max(1, Math.round(gesture.width + gesture.dw))}px`,
                height: `${Math.max(1, Math.round(gesture.height + gesture.dh))}px`,
              }),
            },
          ];
    const commit =
      updates.length === 1
        ? updateDesignNodeStylesCached(workspaceId, {
            frame: gesture.frame.file,
            nodeId: updates[0]!.nodeId,
            sourceVersion: gesture.frame.sourceVersion,
            styles: updates[0]!.styles,
          })
        : applyDesignEditCached(workspaceId, gesture.frame, {
            schemaVersion: 1,
            transactionId: `desktop:${crypto.randomUUID()}`,
            actor: { kind: "human", id: "desktop" },
            intent: `Move ${updates.length} selected layers`,
            createdAt: Date.now(),
            operations: updates.map((update) => ({
              operationId: `move:${crypto.randomUUID()}`,
              type: "node.set-styles" as const,
              nodeId: update.nodeId,
              styles: update.styles,
              scope: "auto" as const,
              responsiveContext: "base",
              stateContext: "default",
            })),
          });
    void commit
      .catch((error) => {
        void Promise.all(
          updates.map((update) =>
            clearDesignNodeStylePreviewTransient({
              workspaceId,
              frame: gesture.frame.file,
              sourceVersion: gesture.frame.sourceVersion,
              nodeId: update.nodeId,
            }),
          ),
        ).catch(() => {});
        toast.error("Couldn't nudge the design element", {
          description: errorMessage(error),
        });
      })
      .finally(() => setSelectionOverlaySuppressed(false));
  }, [workspaceId]);

  /** Move/resize previews paint one node; release publishes one engine write. */
  const startFrameGesture = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      frame: DesignCanvasFrameWire,
      mode: FrameGestureMode,
    ) => {
      if (
        !workspaceId ||
        !active ||
        spacePressedRef.current ||
        activeTool !== "select" ||
        !event.isPrimary ||
        event.button !== 0
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Labels move the whole frame; body drags retain scoped marquee.
      viewportRef.current?.focus({ preventScroll: true });
      publishSelection(frame, { selected: true });
      const element = event.currentTarget.closest<HTMLElement>(
        "[data-design-frame]",
      );
      if (!element) return;
      const previewKey = `${workspaceId}\0${frame.file}`;
      const previousPreview = frameGeometryPreviewsRef.current.get(previewKey);
      const start = previousPreview?.geometry ?? frameGeometry(frame);
      const preview = { geometry: start, settled: false };
      const startX = event.clientX;
      const startY = event.clientY;
      let latest = start;
      let moved = false;
      const peers =
        snapshot?.frames
          .filter((candidate) => candidate.file !== frame.file)
          .map((candidate) => ({
            x: candidate.x,
            y: candidate.y,
            width: candidate.width,
            height: candidate.height,
          })) ?? [];
      const paintGuides = (guides: { x?: number; y?: number }) => {
        if (verticalGuideRef.current) {
          verticalGuideRef.current.style.display =
            guides.x === undefined ? "none" : "block";
          if (guides.x !== undefined) {
            verticalGuideRef.current.style.left = `${guides.x}px`;
          }
        }
        if (horizontalGuideRef.current) {
          horizontalGuideRef.current.style.display =
            guides.y === undefined ? "none" : "block";
          if (guides.y !== undefined) {
            horizontalGuideRef.current.style.top = `${guides.y}px`;
          }
        }
      };

      const move = (pointerEvent: PointerEvent) => {
        // A trackpad pinch repaints the camera up to 80ms before the store
        // learns the new zoom, so travel divides by what is on screen now.
        const zoom = liveDesignZoom();
        const dx = (pointerEvent.clientX - startX) / zoom;
        const dy = (pointerEvent.clientY - startY) / zoom;
        if (!moved && Math.hypot(dx, dy) < 3 / zoom) return;
        moved = true;
        if (mode === "move") document.body.style.cursor = "grabbing";
        latest =
          mode === "move"
            ? (() => {
                const moving = {
                  x: start.x + dx,
                  y: start.y + dy,
                  width: start.w,
                  height: start.h,
                };
                const snapped =
                  pointerEvent.metaKey || pointerEvent.ctrlKey
                    ? { rect: moving, guides: {} }
                    : snapDesignRect(moving, peers, 6 / zoom);
                paintGuides(snapped.guides);
                return {
                  ...start,
                  x: Math.round(snapped.rect.x),
                  y: Math.round(snapped.rect.y),
                };
              })()
            : (() => {
                const resized = resizeDesignRect(
                  { x: start.x, y: start.y, width: start.w, height: start.h },
                  dx,
                  dy,
                  mode,
                  {
                    minWidth: MIN_FRAME_WIDTH,
                    minHeight: MIN_FRAME_HEIGHT,
                    keepAspect: pointerEvent.shiftKey,
                    fromCenter: pointerEvent.altKey,
                  },
                );
                const snapped =
                  pointerEvent.metaKey ||
                  pointerEvent.ctrlKey ||
                  pointerEvent.shiftKey ||
                  pointerEvent.altKey
                    ? { rect: resized, guides: {} }
                    : snapDesignResizeRect(resized, mode, peers, 6 / zoom);
                paintGuides(snapped.guides);
                const rect = snapped.rect;
                return {
                  ...start,
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  w: Math.round(rect.width),
                  h: Math.round(rect.height),
                };
              })();
        preview.geometry = latest;
        frameGeometryPreviewsRef.current.set(previewKey, preview);
        paintFrameGeometry(element, latest);
      };

      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        paintGuides({});
        gestureCancelRef.current = null;
        if (!moved) return;
        const persist = async () => {
          const root =
            useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
              frame.file
            ]?.snapshot?.frame;
          if (
            mode === "move" &&
            folder &&
            root?.oid &&
            !root.oid.startsWith("::")
          ) {
            const presentation = createDesignDragPresentation(
              workspaceId,
              frame,
              root,
              element,
            );
            presentation?.paint({
              x: latest.x - frame.x,
              y: latest.y - frame.y,
            });
            try {
              if (
                await transferDesignLayerOnCanvas({
                  workspaceId,
                  folder,
                  frame,
                  details: root,
                  frames: snapshot?.frames ?? [],
                  origin: { x: latest.x, y: latest.y },
                  detach: false,
                  presented: (target) =>
                    presentation?.handoff(target) ?? Promise.resolve(),
                })
              )
                return latest;
            } finally {
              presentation?.remove();
            }
          }
          return updateDesignFrameGeometryCached(
            workspaceId,
            frame.file,
            latest,
          );
        };
        const settle = (geometry: DesignFrameGeometryWire) => {
          preview.geometry = geometry;
          preview.settled = true;
          if (frameGeometryPreviewsRef.current.get(previewKey) !== preview)
            return;
          frameGeometryPreviewsRef.current.delete(previewKey);
          if (element.isConnected) paintFrameGeometry(element, geometry);
        };
        void persist()
          .then(settle)
          .catch((geometryError) => {
            const confirmed = designWorkspaceSnapshotCache
              .peekSnapshot(workspaceId)
              .data?.frames.find((candidate) => candidate.file === frame.file);
            settle(confirmed ? frameGeometry(confirmed) : start);
            toast.error("Couldn't update the frame geometry", {
              description: errorMessage(geometryError),
            });
          });
      };

      const cancel = () => {
        if (frameGeometryPreviewsRef.current.get(previewKey) === preview) {
          if (previousPreview && !previousPreview.settled)
            frameGeometryPreviewsRef.current.set(previewKey, previousPreview);
          else frameGeometryPreviewsRef.current.delete(previewKey);
          paintFrameGeometry(element, previousPreview?.geometry ?? start);
        }
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        paintGuides({});
        gestureCancelRef.current = null;
      };

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      document.body.style.cursor =
        mode === "move"
          ? "default"
          : (DESIGN_RESIZE_HANDLES.find((item) => item.handle === mode)
              ?.cursor ?? "nwse-resize");
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
    },
    [
      active,
      activeTool,
      folder,
      liveDesignZoom,
      publishSelection,
      snapshot?.frames,
      workspaceId,
    ],
  );

  /** Rotate one authored element about its own origin with RAF-coalesced
   * runtime preview and one provenance-aware source transaction at release.
   * The gesture measures pointer angles about the pivot, which the browser also
   * turns the element about, so the element tracks the pointer exactly. */
  const startNodeRotation = useCallback(
    (
      event: React.PointerEvent<HTMLButtonElement>,
      frame: DesignCanvasFrameWire,
      details: DesignRuntimeNodeDetails,
    ) => {
      if (
        !workspaceId ||
        !active ||
        activeTool !== "select" ||
        !event.isPrimary ||
        event.button !== 0
      ) {
        return;
      }
      const overlay = event.currentTarget.closest<HTMLElement>(
        "[data-design-element-overlay]",
      );
      if (!overlay) return;
      event.preventDefault();
      event.stopPropagation();
      const pointerOwner = event.currentTarget;
      const pointerId = event.pointerId;
      pointerOwner.setPointerCapture?.(pointerId);
      const box = designSelectionBox(details);
      const overlayFrame = designSelectionOverlayFrame(box);
      // Angles are measured about the same point the browser turns the element
      // about, so the element tracks the pointer exactly however far the pivot
      // sits from the box. The frame element carries the camera transform.
      const frameElement = overlay.closest<HTMLElement>("[data-design-frame]");
      const frameBounds = frameElement?.getBoundingClientRect();
      const pivot = designSelectionPivot(box);
      const scale =
        frameBounds && frame.width > 0 ? frameBounds.width / frame.width : 1;
      const bounds = overlay.getBoundingClientRect();
      const center = frameBounds
        ? {
            x: frameBounds.left + pivot.x * scale,
            y: frameBounds.top + pivot.y * scale,
          }
        : {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
          };
      const start = { x: event.clientX, y: event.clientY };
      const base = parseDesignTransform(details.styles.transform ?? "none");
      // Independent CSS scale is outside transform's rotation. Reflecting one
      // axis reverses the angle authored inside it, while two flips cancel.
      // A just-clicked flip can still be awaiting its confirmed detail read.
      const previewScale = designLivePreviewValue(
        workspaceId,
        frame.file,
        details.oid,
        "scale",
      );
      const scales = (
        previewScale === undefined
          ? (details.styles.scale ?? "none")
          : (previewScale ?? "none")
      )
        .split(/\s+/)
        .map(Number);
      const rotationDirection =
        scales[0]! * (scales[1] ?? scales[0]!) < 0 ? -1 : 1;
      const feedback = overlay.querySelector<HTMLElement>(
        "[data-design-rotation-feedback]",
      );
      let latestTransform = formatDesignTransform(base);
      let latestRotation = overlayFrame.rotation;
      let latestCursor = designRotationCursor(overlayFrame.rotation - 45);
      let moved = false;
      const previewInput = {
        workspaceId,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
        nodeId: details.oid,
      };
      // A rotation is a pure transform: the angle painted on the overlay is the
      // angle authored, so nothing has to be measured back. What matters is that
      // the element turns in the same frame the outline does, which is why this
      // asks for geometry instead of the full node details — no animation frame
      // between the write and the answer.
      const loop = createDesignGestureLoop<DesignRuntimeNodeGeometry>({
        request: (styles) => {
          publishDesignGestureLivePreview(
            workspaceId,
            frame.file,
            details.oid,
            styles,
          );
          return previewDesignNodeGeometry({
            workspaceId,
            frame,
            nodeId: details.oid,
            styles,
          });
        },
      });
      const move = (pointerEvent: PointerEvent) => {
        const delta = designPointerRotation(
          center,
          start,
          { x: pointerEvent.clientX, y: pointerEvent.clientY },
          pointerEvent.shiftKey ? 15 : 0,
        );
        if (!moved && Math.abs(delta) < 0.2) return;
        moved = true;
        const rotate =
          Math.round((base.rotate + delta * rotationDirection) * 10) / 10;
        latestTransform = formatDesignTransform({ ...base, rotate });
        // Paint the angle that is actually being authored, so the outline and
        // the element never disagree by a rounding step.
        latestRotation =
          overlayFrame.rotation + (rotate - base.rotate) * rotationDirection;
        // The overlay is already anchored on the pivot, so turning it further
        // about that same point needs no reflow and no repositioning.
        overlay.style.transform = `rotate(${latestRotation}deg)`;
        overlay.style.transformOrigin = `${overlayFrame.pivotX}px ${overlayFrame.pivotY}px`;
        // The cursor keeps pointing the way the drag turns, but each distinct
        // value decodes an SVG image; only assign one the pointer earned.
        const cursor = designRotationCursor(latestRotation - 45);
        if (cursor !== latestCursor) {
          latestCursor = cursor;
          document.body.style.cursor = cursor;
        }
        if (feedback) {
          feedback.style.display = "block";
          paintDesignLabelText(feedback, `${rotate}°`);
        }
        loop.author({ transform: latestTransform });
      };
      /** Hold one exact angle on the overlay. Only the pivot-anchored transform
       * changes, so no reflow and no repositioning are involved. */
      const settle = (rotation: number) => {
        paintDesignNodeOverlayGeometry(overlay, { ...overlayFrame, rotation });
      };
      const cleanup = () => {
        loop.stop();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        if (pointerOwner.hasPointerCapture?.(pointerId)) {
          pointerOwner.releasePointerCapture(pointerId);
        }
        if (feedback) feedback.style.display = "none";
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
      };
      const restore = () => {
        settle(overlayFrame.rotation);
        void clearDesignNodeStylePreviewTransient(previewInput).catch(() => {});
      };
      const finish = () => {
        cleanup();
        if (!moved) {
          settle(overlayFrame.rotation);
          return;
        }
        // Release must hold the released angle. The transient preview keeps the
        // element turned until the committed generation republishes it, so
        // repainting the pre-gesture angle here is what snapped the outline
        // upright for one frame and then jumped it back.
        settle(latestRotation);
        publishDesignGestureLivePreview(
          workspaceId,
          frame.file,
          details.oid,
          { transform: latestTransform },
          { settle: true },
        );
        void updateDesignNodeStylesCached(workspaceId, {
          frame: frame.file,
          nodeId: details.oid,
          sourceVersion: frame.sourceVersion,
          styles: { transform: latestTransform },
        }).catch((rotationError) => {
          restore();
          toast.error("Couldn't rotate the design element", {
            description: errorMessage(rotationError),
          });
        });
      };
      const cancel = () => {
        cleanup();
        restore();
      };

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      document.body.style.cursor = latestCursor;
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
    },
    [active, activeTool, workspaceId],
  );

  /** Move the pivot every rotation turns about. The origin is authored CSS, not
   * editor state, so it survives reloads and shows up in the inspector — and
   * moving it on an already-transformed element authors the compensating
   * translation that keeps the element itself from jumping. */
  const startNodeOriginGesture = useCallback(
    (
      event: React.PointerEvent<HTMLButtonElement>,
      frame: DesignCanvasFrameWire,
      details: DesignRuntimeNodeDetails,
    ) => {
      if (
        !workspaceId ||
        !active ||
        activeTool !== "select" ||
        !event.isPrimary ||
        event.button !== 0
      ) {
        return;
      }
      const overlay = event.currentTarget.closest<HTMLElement>(
        "[data-design-element-overlay]",
      );
      if (!overlay) return;
      event.preventDefault();
      event.stopPropagation();
      const pointerOwner = event.currentTarget;
      const pointerId = event.pointerId;
      pointerOwner.setPointerCapture?.(pointerId);
      const box = designSelectionBox(details);
      const overlayFrame = designSelectionOverlayFrame(box);
      const base = parseDesignTransform(details.styles.transform ?? "none");
      const anchors = overlay.querySelector<HTMLElement>(
        "[data-design-origin-anchors]",
      );
      const startX = event.clientX;
      const startY = event.clientY;
      let latest = { originX: box.originX, originY: box.originY };
      let latestStyles: Record<string, string> = {};
      let moved = false;
      const previewInput = {
        workspaceId,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
        nodeId: details.oid,
      };
      // Moving the pivot authors a compensating translate, so the element must
      // not visibly shift. That only holds if the write lands in the same frame
      // as the marker paint.
      const loop = createDesignGestureLoop<DesignRuntimeNodeGeometry>({
        request: (styles) => {
          publishDesignGestureLivePreview(
            workspaceId,
            frame.file,
            details.oid,
            styles,
          );
          return previewDesignNodeGeometry({
            workspaceId,
            frame,
            nodeId: details.oid,
            styles,
          });
        },
      });
      const paintOrigin = (origin: { originX: number; originY: number }) => {
        const marker = overlay.querySelector<HTMLElement>(
          "[data-design-origin-handle]",
        );
        if (!marker) return;
        marker.dataset.designOriginX = `${origin.originX}`;
        marker.dataset.designOriginY = `${origin.originY}`;
        marker.style.left = `${origin.originX * overlayFrame.width}px`;
        marker.style.top = `${origin.originY * overlayFrame.height}px`;
      };
      const move = (pointerEvent: PointerEvent) => {
        // Pointer travel is screen-space; the pivot lives in the element's own
        // rotated axes, so the delta rotates back before it becomes a fraction.
        const zoom = liveDesignZoom();
        const local = designLocalDelta(
          {
            x: (pointerEvent.clientX - startX) / zoom,
            y: (pointerEvent.clientY - startY) / zoom,
          },
          overlayFrame.rotation,
        );
        if (!moved && Math.hypot(local.x, local.y) < 2 / zoom) return;
        moved = true;
        const next = designOriginFraction(
          box,
          {
            x: overlayFrame.pivotX + local.x,
            y: overlayFrame.pivotY + local.y,
          },
          pointerEvent.metaKey || pointerEvent.ctrlKey
            ? 0
            : DESIGN_ORIGIN_SNAP_DISTANCE / zoom,
        );
        latest = { originX: next.originX, originY: next.originY };
        latestStyles = designOriginStyles(box, base, latest);
        paintOrigin(latest);
        loop.author(latestStyles);
      };
      const cleanup = () => {
        loop.stop();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        if (pointerOwner.hasPointerCapture?.(pointerId)) {
          pointerOwner.releasePointerCapture(pointerId);
        }
        if (anchors) anchors.style.display = "";
        overlay.removeAttribute("data-design-origin-dragging");
        // A drag that ended outside the selection missed its own pointerleave.
        if (!overlay.matches(":hover")) {
          overlay.removeAttribute("data-design-origin-armed");
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
      };
      const restore = () => {
        paintOrigin({ originX: box.originX, originY: box.originY });
        void clearDesignNodeStylePreviewTransient(previewInput).catch(() => {});
      };
      const finish = () => {
        cleanup();
        if (!moved) return;
        publishDesignGestureLivePreview(
          workspaceId,
          frame.file,
          details.oid,
          latestStyles,
          { settle: true },
        );
        void updateDesignNodeStylesCached(workspaceId, {
          frame: frame.file,
          nodeId: details.oid,
          sourceVersion: frame.sourceVersion,
          styles: latestStyles,
        }).catch((originError) => {
          restore();
          toast.error("Couldn't move the rotation origin", {
            description: errorMessage(originError),
          });
        });
      };
      const cancel = () => {
        cleanup();
        restore();
      };

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      if (anchors) anchors.style.display = "block";
      overlay.setAttribute("data-design-origin-dragging", "");
      document.body.style.cursor = "move";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
    },
    [active, activeTool, liveDesignZoom, workspaceId],
  );

  /** Return one element's pivot to its center, the CSS default. */
  const centerNodeOrigin = useCallback(
    async (frame: DesignCanvasFrameWire, details: DesignRuntimeNodeDetails) => {
      if (!workspaceId || !active) return;
      const box = designSelectionBox(details);
      if (box.originX === 0.5 && box.originY === 0.5) return;
      try {
        await updateDesignNodeStylesCached(workspaceId, {
          frame: frame.file,
          nodeId: details.oid,
          sourceVersion: frame.sourceVersion,
          styles: designOriginStyles(
            box,
            parseDesignTransform(details.styles.transform ?? "none"),
            { originX: 0.5, originY: 0.5 },
          ),
        });
      } catch (originError) {
        toast.error("Couldn't center the rotation origin", {
          description: errorMessage(originError),
        });
      }
    },
    [active, workspaceId],
  );

  /** Direct canvas padding/gap editing. Pointer moves paint the active line,
   * hatch, and value immediately. Sandboxed layout previews stay coalesced to
   * one in-flight request; gap regions reconcile from one aggregate child-box
   * read and pointer release creates a single source transaction. */
  const startInlineSpacingGesture = useCallback(
    (
      event: React.PointerEvent<HTMLButtonElement>,
      frame: DesignCanvasFrameWire,
      details: DesignRuntimeNodeDetails,
      control: DesignInlineSpacingControl,
    ) => {
      if (!workspaceId || !active || !event.isPrimary || event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const pointerOwner = event.currentTarget;
      const pointerId = event.pointerId;
      pointerOwner.setPointerCapture?.(pointerId);
      const frameElement = pointerOwner.closest<HTMLElement>(
        "[data-design-frame]",
      );
      const startCoordinate =
        control.axis === "x" ? event.clientX : event.clientY;
      const previewInput = {
        workspaceId,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
        nodeId: details.oid,
      };
      const paddingOriginalValues: Record<string, number> = {
        "padding-top": designPixelValue(details.styles.paddingTop),
        "padding-right": designPixelValue(details.styles.paddingRight),
        "padding-bottom": designPixelValue(details.styles.paddingBottom),
        "padding-left": designPixelValue(details.styles.paddingLeft),
      };
      const fixedGapDistributionStyles = control.property.includes("gap")
        ? designInlineGapDistributionStyles({
            display: details.styles.display,
            flexDirection: details.styles.flexDirection,
            flexWrap: details.styles.flexWrap,
            axis: control.axis,
            justifyContent: details.styles.justifyContent,
            alignContent: details.styles.alignContent,
          })
        : {};
      let latestValue = control.value;
      let latestCommitStyles: Record<string, string> = {
        [control.property]: `${control.value}px`,
      };
      let latestPreviewStyles = { ...latestCommitStyles };
      let latestMirrorMode: "none" | "opposite" | "all" = "none";
      let moved = false;
      /** The clamp base for the padding hatch. Both paint paths have to use one
       * source: clamping the sync path against the pre-gesture rect while the
       * async path clamped against the measured one made the hatch alternate
       * between two depths at exactly the round-trip frequency. */
      let measuredRect = details.rect;

      const currentOverlay = () =>
        frameElement?.querySelector<HTMLElement>(
          `[data-design-element-overlay="${CSS.escape(details.oid)}"]`,
        ) ?? null;
      const currentSpacingRoot = () =>
        currentOverlay()?.querySelector<HTMLElement>(
          "[data-design-inline-spacing-root]",
        ) ?? null;
      const paintOverlayGeometry = (geometry: DesignPaintedNode | null) => {
        const overlay = currentOverlay();
        if (!overlay || !geometry) return;
        paintDesignNodeOverlayGeometry(
          overlay,
          designSelectionOverlayFrame(designSelectionBox(geometry)),
        );
      };
      const currentControl = () => {
        const selector = control.regionKey
          ? `[data-design-inline-gap-region="${CSS.escape(control.regionKey)}"]`
          : `[data-design-inline-spacing="${CSS.escape(control.property)}"]`;
        return (
          currentSpacingRoot()?.querySelector<HTMLButtonElement>(selector) ??
          null
        );
      };
      const paintPropertyLabel = (property: string, value: number) => {
        const root = currentSpacingRoot();
        if (!root) return;
        const handles =
          property === control.property && control.regionKey
            ? root.querySelectorAll<HTMLElement>(
                `[data-design-inline-gap-region="${CSS.escape(control.regionKey)}"]`,
              )
            : root.querySelectorAll<HTMLElement>(
                `[data-design-inline-spacing="${CSS.escape(property)}"]`,
              );
        for (const handle of handles) {
          paintDesignLabelText(
            handle.querySelector<HTMLElement>(
              `[data-design-inline-spacing-value="${CSS.escape(property)}"]`,
            ),
            `${Math.round(value * 10) / 10}`,
          );
        }
      };
      const paintPaddingStyles = (
        styles: Record<string, string>,
        geometry = measuredRect,
      ) => {
        const root = currentSpacingRoot();
        if (!root) return;
        for (const [property, rawValue] of Object.entries(styles)) {
          if (!property.startsWith("padding-")) continue;
          const value = designPixelValue(rawValue);
          const maximum =
            property === "padding-left" || property === "padding-right"
              ? geometry.width / 2
              : geometry.height / 2;
          root.style.setProperty(
            `--design-inline-${property}`,
            `${Math.min(maximum, value)}px`,
          );
          root.style.setProperty(
            `--design-inline-${property}-center`,
            `${Math.min(maximum, value) / 2}px`,
          );
          paintPropertyLabel(property, value);
        }
      };
      const paintGapGeometry = (
        containerDetails: DesignPaintedNode,
        childDetails: readonly DesignPaintedChild[],
      ) => {
        const root = currentSpacingRoot();
        if (!root) return;
        paintDesignInlineGapHandles(
          root,
          containerDetails,
          childDetails,
          liveDesignZoom(),
        );
      };
      const paintGestureState = (mirroredProperties: readonly string[]) => {
        const root = currentSpacingRoot();
        if (!root) return;
        for (const handle of root.querySelectorAll<HTMLElement>(
          "[data-design-inline-spacing]",
        )) {
          handle.removeAttribute("data-dragging");
          handle.removeAttribute("data-mirrored");
        }
        currentControl()?.setAttribute("data-dragging", "true");
        for (const property of mirroredProperties) {
          root
            .querySelector<HTMLElement>(
              `[data-design-inline-spacing="${CSS.escape(property)}"]`,
            )
            ?.setAttribute("data-mirrored", "true");
        }
      };

      /** Spacing has no honest prediction: only the flex or grid algorithm knows
       * where the children land once a gap or a padding changes. So layout stays
       * the single authority here, and the whole fix is latency — one lean round
       * trip per frame, measured in the same task as the write, instead of two
       * that waited for an animation frame each. */
      const loop = createDesignGestureLoop<DesignRuntimeNodeGeometry>({
        request: (styles) => {
          publishDesignGestureLivePreview(
            workspaceId,
            frame.file,
            details.oid,
            styles,
          );
          return previewDesignNodeGeometry({
            workspaceId,
            frame,
            nodeId: details.oid,
            styles,
            children: true,
          });
        },
        measured: (geometry) => {
          measuredRect = geometry.rect;
          paintOverlayGeometry(geometry);
          paintPaddingStyles(latestPreviewStyles, geometry.rect);
          paintGapGeometry(geometry, geometry.children);
          paintPropertyLabel(control.property, latestValue);
        },
      });
      const move = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        const coordinate =
          control.axis === "x" ? pointerEvent.clientX : pointerEvent.clientY;
        const delta = (coordinate - startCoordinate) / liveDesignZoom();
        const value = designInlineSpacingValue(
          control.value,
          delta,
          control.direction,
          pointerEvent.shiftKey ? 10 : 1,
        );
        const mirrorMode = pointerEvent.altKey
          ? pointerEvent.shiftKey
            ? "all"
            : "opposite"
          : "none";
        if (!moved && value === control.value) return;
        if (moved && value === latestValue && mirrorMode === latestMirrorMode) {
          return;
        }
        moved = true;
        latestValue = value;
        latestMirrorMode = mirrorMode;
        latestCommitStyles = { [control.property]: `${value}px` };
        latestPreviewStyles = { ...latestCommitStyles };
        const mirroredProperties: string[] = [];
        if (control.property.startsWith("padding-")) {
          latestPreviewStyles = Object.fromEntries(
            Object.entries(paddingOriginalValues).map(
              ([property, original]) => [property, `${original}px`],
            ),
          );
          latestPreviewStyles[control.property] = `${value}px`;
          if (mirrorMode === "all") {
            for (const property of Object.keys(paddingOriginalValues)) {
              latestCommitStyles[property] = `${value}px`;
              latestPreviewStyles[property] = `${value}px`;
              if (property !== control.property)
                mirroredProperties.push(property);
            }
          } else if (mirrorMode === "opposite" && control.oppositeProperty) {
            latestCommitStyles[control.oppositeProperty] = `${value}px`;
            latestPreviewStyles[control.oppositeProperty] = `${value}px`;
            mirroredProperties.push(control.oppositeProperty);
          }
        }
        Object.assign(latestCommitStyles, fixedGapDistributionStyles);
        Object.assign(latestPreviewStyles, fixedGapDistributionStyles);
        paintPropertyLabel(control.property, value);
        paintPaddingStyles(latestPreviewStyles);
        paintGestureState(mirroredProperties);
        loop.author(latestPreviewStyles);
      };
      const cleanup = () => {
        loop.stop();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        if (pointerOwner.hasPointerCapture?.(pointerId)) {
          pointerOwner.releasePointerCapture(pointerId);
        }
        for (const handle of currentSpacingRoot()?.querySelectorAll<HTMLElement>(
          "[data-design-inline-spacing]",
        ) ?? []) {
          handle.removeAttribute("data-dragging");
          handle.removeAttribute("data-mirrored");
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
      };
      const restore = () => {
        paintOverlayGeometry(details);
        paintPaddingStyles(
          Object.fromEntries(
            Object.entries(paddingOriginalValues).map(([property, value]) => [
              property,
              `${value}px`,
            ]),
          ),
        );
        paintGapGeometry(details, childGeometryDetails);
        paintPropertyLabel(control.property, control.value);
        void clearDesignNodeStylePreviewTransient(previewInput).catch(() => {});
      };
      const finish = (pointerEvent?: PointerEvent) => {
        if (pointerEvent && pointerEvent.pointerId !== pointerId) return;
        cleanup();
        if (!moved) {
          // A modifier-click selects through spacing chrome. Keep modifier
          // drags on the existing spacing path, including their preview/undo.
          if (!(event.metaKey || event.ctrlKey) || !folder || !frameElement)
            return;
          const bounds = frameElement.getBoundingClientRect();
          if (bounds.width <= 0 || bounds.height <= 0) return;
          viewportRef.current?.focus({ preventScroll: true });
          void selectDesignFrameBodyAtLocation({
            workspaceId,
            folder,
            frame,
            x: ((event.clientX - bounds.left) * frame.width) / bounds.width,
            y: ((event.clientY - bounds.top) * frame.height) / bounds.height,
            intent: "deepest",
            additive: event.shiftKey,
          }).catch(() => {});
          return;
        }
        publishDesignGestureLivePreview(
          workspaceId,
          frame.file,
          details.oid,
          latestCommitStyles,
          { settle: true },
        );
        void updateDesignNodeStylesCached(workspaceId, {
          frame: frame.file,
          nodeId: details.oid,
          sourceVersion: frame.sourceVersion,
          styles: latestCommitStyles,
        }).catch((spacingError) => {
          restore();
          toast.error("Couldn't update canvas spacing", {
            description: errorMessage(spacingError),
          });
        });
      };
      const cancel = (pointerEvent?: Event) => {
        if (
          pointerEvent instanceof PointerEvent &&
          pointerEvent.pointerId !== pointerId
        ) {
          return;
        }
        cleanup();
        restore();
      };

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      paintPropertyLabel(control.property, latestValue);
      paintGestureState([]);
      document.body.style.cursor =
        control.axis === "x" ? "ew-resize" : "ns-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
    },
    [active, childGeometryDetails, folder, liveDesignZoom, workspaceId],
  );

  const startNodeGroupMove = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      frame: DesignCanvasFrameWire,
      nodes: readonly DesignRuntimeNodeDetails[],
      clickedNode: DesignRuntimeNodeDetails,
    ) => {
      const foundationAtStart = canvasFoundation.data;
      if (
        !workspaceId ||
        !active ||
        !event.isPrimary ||
        event.button !== 0 ||
        nodes.length < 2
      ) {
        return false;
      }
      const article = event.currentTarget.closest<HTMLElement>(
        "[data-design-frame]",
      );
      if (!article) return false;
      event.preventDefault();
      event.stopPropagation();
      const pointerOwner = event.currentTarget;
      const pointerId = event.pointerId;
      pointerOwner.setPointerCapture?.(pointerId);
      const overlays = new Map(
        Array.from(
          article.querySelectorAll<HTMLElement>(
            "[data-design-element-overlay]",
          ),
        ).flatMap((overlay) => {
          const nodeId = overlay.dataset.designElementOverlay;
          return nodeId ? [[nodeId, overlay] as const] : [];
        }),
      );
      const starts = nodes.map((details) => ({
        details,
        overlay: overlays.get(details.oid) ?? null,
        // A rotated member's overlay is anchored on its pivot, so a group move
        // has to translate that placement rather than its bounding box.
        overlayFrame: designSelectionOverlayFrame(designSelectionBox(details)),
        position:
          details.styles.position === "static"
            ? "relative"
            : details.styles.position || "relative",
        left: designGesturePixelBase(
          { workspaceId, frame: frame.file, nodeId: details.oid },
          "left",
          details.styles.left,
        ),
        top: designGesturePixelBase(
          { workspaceId, frame: frame.file, nodeId: details.oid },
          "top",
          details.styles.top,
        ),
      }));
      const groupBounds = {
        x: Math.min(...starts.map(({ details }) => details.rect.x)),
        y: Math.min(...starts.map(({ details }) => details.rect.y)),
        width: 0,
        height: 0,
      };
      groupBounds.width =
        Math.max(
          ...starts.map(({ details }) => details.rect.x + details.rect.width),
        ) - groupBounds.x;
      groupBounds.height =
        Math.max(
          ...starts.map(({ details }) => details.rect.y + details.rect.height),
        ) - groupBounds.y;
      const selectedIds = new Set(starts.map(({ details }) => details.oid));
      const peerRects = [
        ...peerGeometryDetails
          .filter((details) => !selectedIds.has(details.oid))
          .map((details) => details.rect),
        ...(parentOutlineDetails ? [parentOutlineDetails.rect] : []),
      ];
      const startX = event.clientX;
      const startY = event.clientY;
      let delta = { x: 0, y: 0 };
      let moved = false;
      const paintGuides = (guides: { x?: number; y?: number }) => {
        if (verticalGuideRef.current) {
          verticalGuideRef.current.style.display =
            guides.x === undefined ? "none" : "block";
          if (guides.x !== undefined) {
            verticalGuideRef.current.style.left = `${frame.x + guides.x}px`;
          }
        }
        if (horizontalGuideRef.current) {
          horizontalGuideRef.current.style.display =
            guides.y === undefined ? "none" : "block";
          if (guides.y !== undefined) {
            horizontalGuideRef.current.style.top = `${frame.y + guides.y}px`;
          }
        }
      };
      const updates = () =>
        starts.map((start) => ({
          nodeId: start.details.oid,
          styles: preserveDesignLayoutPins(start.details, {
            position: start.position,
            left: `${Math.round(start.left + delta.x)}px`,
            top: `${Math.round(start.top + delta.y)}px`,
          }),
        }));
      // The whole group is one flight: its members must never land a frame apart.
      const loop = createDesignGestureLoop<unknown>({
        request: () =>
          Promise.all(
            updates().map((update) => {
              publishDesignGestureLivePreview(
                workspaceId,
                frame.file,
                update.nodeId,
                update.styles,
              );
              return previewDesignNodeGeometry({
                workspaceId,
                frame,
                nodeId: update.nodeId,
                styles: update.styles,
              });
            }),
          ),
      });
      const paint = () => {
        for (const start of starts) {
          if (!start.overlay) continue;
          start.overlay.style.left = `${start.overlayFrame.left + delta.x}px`;
          start.overlay.style.top = `${start.overlayFrame.top + delta.y}px`;
        }
      };
      const restore = () => {
        for (const start of starts) {
          if (start.overlay) {
            start.overlay.style.left = `${start.overlayFrame.left}px`;
            start.overlay.style.top = `${start.overlayFrame.top}px`;
          }
        }
        void Promise.all(
          starts.map((start) =>
            clearDesignNodeStylePreviewTransient({
              workspaceId,
              frame: frame.file,
              sourceVersion: frame.sourceVersion,
              nodeId: start.details.oid,
            }),
          ),
        ).catch(() => {});
      };
      const move = (pointerEvent: PointerEvent) => {
        // A trackpad pinch repaints the camera up to 80ms before the store
        // learns the new zoom, so travel divides by what is on screen now.
        const zoom = liveDesignZoom();
        const rawX = (pointerEvent.clientX - startX) / zoom;
        const rawY = (pointerEvent.clientY - startY) / zoom;
        if (!moved && Math.hypot(rawX, rawY) < 3 / zoom) return;
        moved = true;
        const moving = {
          ...groupBounds,
          x: groupBounds.x + rawX,
          y: groupBounds.y + rawY,
        };
        const snapped =
          pointerEvent.metaKey || pointerEvent.ctrlKey
            ? { rect: moving, guides: {} }
            : snapDesignRect(moving, peerRects, 6 / zoom);
        delta = {
          x: snapped.rect.x - groupBounds.x,
          y: snapped.rect.y - groupBounds.y,
        };
        paintGuides(snapped.guides);
        paint();
        loop.author({});
      };
      const cleanup = () => {
        loop.stop();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        if (pointerOwner.hasPointerCapture?.(pointerId)) {
          pointerOwner.releasePointerCapture(pointerId);
        }
        paintGuides({});
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
      };
      const finish = () => {
        cleanup();
        if (!moved) {
          if (!folder) return;
          const intent = designSelectionClickIntent(event);
          if (intent === "toggle") {
            void toggleDesignNodeSelection({
              workspaceId,
              folder,
              frame,
              nodeId: clickedNode.oid,
              details: clickedNode,
            }).catch(() => {});
            return;
          }
          if (intent === "primary") {
            void selectDesignNode({
              workspaceId,
              folder,
              frame,
              nodeId: clickedNode.oid,
              details: clickedNode,
            }).catch(() => {});
            return;
          }
          const bounds = article.getBoundingClientRect();
          if (bounds.width <= 0 || bounds.height <= 0) return;
          void selectDesignNodeAtLocation({
            workspaceId,
            folder,
            frame,
            x: ((event.clientX - bounds.left) * frame.width) / bounds.width,
            y: ((event.clientY - bounds.top) * frame.height) / bounds.height,
            mode: intent,
            selectedNodeId: clickedNode.oid,
          })
            .then((selected) => {
              if (activeTool !== "text" || !canEditDesignNodeText(selected)) {
                return;
              }
              finishInlineTextTool(frame, selected);
            })
            .catch(() => {});
          return;
        }
        const finalUpdates = updates();
        for (const update of finalUpdates) {
          publishDesignGestureLivePreview(
            workspaceId,
            frame.file,
            update.nodeId,
            update.styles,
            { settle: true },
          );
        }
        void (async () => {
          const foundation =
            foundationAtStart ??
            (await designFoundationCache.load(
              designFoundationKey(workspaceId, frame.file, frame.sourceVersion),
              () =>
                fetchDesignFoundation(
                  designFoundationKey(
                    workspaceId,
                    frame.file,
                    frame.sourceVersion,
                  ),
                ),
              { maxAgeMs: Number.POSITIVE_INFINITY },
            ));
          await applyDesignTransactionCached(workspaceId, frame.file, {
            schemaVersion: 1,
            transactionId: `desktop:${crypto.randomUUID()}`,
            documentId: foundation.summary.documentId,
            baseRevision: foundation.summary.revision,
            actor: { kind: "human", id: "desktop" },
            intent: `Move ${finalUpdates.length} selected layers`,
            createdAt: Date.now(),
            operations: finalUpdates.map((update) => ({
              operationId: `move:${crypto.randomUUID()}`,
              type: "node.set-styles",
              nodeId: update.nodeId,
              styles: update.styles,
              scope: "auto",
              responsiveContext: "base",
              stateContext: "default",
            })),
          });
        })().catch((error) => {
          restore();
          toast.error("Couldn't move the selected elements", {
            description: errorMessage(error),
          });
        });
      };
      const cancel = () => {
        cleanup();
        restore();
      };

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      document.body.style.cursor = "move";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
      return true;
    },
    [
      active,
      activeTool,
      canvasFoundation.data,
      finishInlineTextTool,
      folder,
      liveDesignZoom,
      parentOutlineDetails,
      peerGeometryDetails,
      workspaceId,
    ],
  );

  /** Resize a multi-selection as one visual box while authoring one atomic
   * source transaction. Each top-level selected layer is projected through
   * the group box so nested descendants are never transformed twice. */
  const startNodeGroupResize = useCallback(
    (
      event: React.PointerEvent<HTMLButtonElement>,
      frame: DesignCanvasFrameWire,
      nodes: readonly DesignRuntimeNodeDetails[],
      handle: DesignResizeHandle,
    ) => {
      const foundationAtStart = canvasFoundation.data;
      if (
        !workspaceId ||
        !active ||
        !event.isPrimary ||
        event.button !== 0 ||
        nodes.length === 0
      ) {
        return;
      }
      const groupOverlay = event.currentTarget.closest<HTMLElement>(
        "[data-design-multi-selection]",
      );
      const article = event.currentTarget.closest<HTMLElement>(
        "[data-design-frame]",
      );
      if (!groupOverlay || !article) return;
      event.preventDefault();
      event.stopPropagation();
      groupOverlay.dataset.designGesture = "resize";
      const pointerOwner = event.currentTarget;
      const pointerId = event.pointerId;
      pointerOwner.setPointerCapture?.(pointerId);
      const overlays = new Map(
        Array.from(
          article.querySelectorAll<HTMLElement>(
            "[data-design-element-overlay]",
          ),
        ).flatMap((overlay) => {
          const nodeId = overlay.dataset.designElementOverlay;
          return nodeId ? [[nodeId, overlay] as const] : [];
        }),
      );
      const starts = nodes.map((details) => ({
        details,
        overlay: overlays.get(details.oid) ?? null,
        position:
          details.styles.position === "static"
            ? "relative"
            : details.styles.position || "relative",
        left: designGesturePixelBase(
          { workspaceId, frame: frame.file, nodeId: details.oid },
          "left",
          details.styles.left,
        ),
        top: designGesturePixelBase(
          { workspaceId, frame: frame.file, nodeId: details.oid },
          "top",
          details.styles.top,
        ),
        width: `${designGesturePixelBase(
          { workspaceId, frame: frame.file, nodeId: details.oid },
          "width",
          details.styles.width,
          details.rect.width,
        )}px`,
        height: `${designGesturePixelBase(
          { workspaceId, frame: frame.file, nodeId: details.oid },
          "height",
          details.styles.height,
          details.rect.height,
        )}px`,
      }));
      const startBounds = {
        x: Math.min(...starts.map(({ details }) => details.rect.x)),
        y: Math.min(...starts.map(({ details }) => details.rect.y)),
        width: 0,
        height: 0,
      };
      startBounds.width =
        Math.max(
          ...starts.map(({ details }) => details.rect.x + details.rect.width),
        ) - startBounds.x;
      startBounds.height =
        Math.max(
          ...starts.map(({ details }) => details.rect.y + details.rect.height),
        ) - startBounds.y;
      const selectedIds = new Set(starts.map(({ details }) => details.oid));
      const peerRects = [
        ...peerGeometryDetails
          .filter((details) => !selectedIds.has(details.oid))
          .map((details) => details.rect),
        ...(parentOutlineDetails ? [parentOutlineDetails.rect] : []),
      ];
      const startX = event.clientX;
      const startY = event.clientY;
      let latestBounds = startBounds;
      let latestRects = new Map(
        starts.map(({ details }) => [details.oid, details.rect] as const),
      );
      let moved = false;
      const sizeFeedback = groupOverlay.querySelector<HTMLElement>(
        "[data-design-group-size]",
      );
      const paintGuides = (guides: { x?: number; y?: number }) => {
        if (verticalGuideRef.current) {
          verticalGuideRef.current.style.display =
            guides.x === undefined ? "none" : "block";
          if (guides.x !== undefined) {
            verticalGuideRef.current.style.left = `${frame.x + guides.x}px`;
          }
        }
        if (horizontalGuideRef.current) {
          horizontalGuideRef.current.style.display =
            guides.y === undefined ? "none" : "block";
          if (guides.y !== undefined) {
            horizontalGuideRef.current.style.top = `${frame.y + guides.y}px`;
          }
        }
      };
      const updates = () =>
        starts.map((start) => {
          const rect = latestRects.get(start.details.oid) ?? start.details.rect;
          return {
            nodeId: start.details.oid,
            styles: preserveDesignLayoutPins(start.details, {
              position: start.position,
              left: `${Math.round(
                start.left + rect.x - start.details.rect.x,
              )}px`,
              top: `${Math.round(start.top + rect.y - start.details.rect.y)}px`,
              width: `${Math.round(
                designCssSizeAfterResize(
                  start.width,
                  start.details.rect.width,
                  rect.width,
                ),
              )}px`,
              height: `${Math.round(
                designCssSizeAfterResize(
                  start.height,
                  start.details.rect.height,
                  rect.height,
                ),
              )}px`,
            }),
          };
        });
      // The whole group is one flight: its members must never land a frame apart.
      const loop = createDesignGestureLoop<unknown>({
        request: () =>
          Promise.all(
            updates().map((update) => {
              publishDesignGestureLivePreview(
                workspaceId,
                frame.file,
                update.nodeId,
                update.styles,
              );
              return previewDesignNodeGeometry({
                workspaceId,
                frame,
                nodeId: update.nodeId,
                styles: update.styles,
              });
            }),
          ),
      });
      const paint = () => {
        groupOverlay.style.left = `${latestBounds.x}px`;
        groupOverlay.style.top = `${latestBounds.y}px`;
        groupOverlay.style.width = `${latestBounds.width}px`;
        groupOverlay.style.height = `${latestBounds.height}px`;
        if (sizeFeedback) {
          sizeFeedback.textContent = `${Math.round(latestBounds.width)} × ${Math.round(latestBounds.height)}`;
        }
        for (const start of starts) {
          const rect = latestRects.get(start.details.oid);
          if (!start.overlay || !rect) continue;
          // Group resize projects bounding boxes, which is approximate for a
          // rotated member; its overlay still keeps that member's own rotation
          // so the preview never contradicts what the canvas shows.
          const box = designSelectionBox(start.details);
          paintDesignNodeOverlayGeometry(
            start.overlay,
            designSelectionOverlayFrame({
              ...box,
              x: rect.x,
              y: rect.y,
              width: rect.width / box.scaleX,
              height: rect.height / box.scaleY,
            }),
          );
        }
      };
      const restore = () => {
        latestBounds = startBounds;
        latestRects = new Map(
          starts.map(({ details }) => [details.oid, details.rect] as const),
        );
        paint();
        void Promise.all(
          starts.map((start) =>
            clearDesignNodeStylePreviewTransient({
              workspaceId,
              frame: frame.file,
              sourceVersion: frame.sourceVersion,
              nodeId: start.details.oid,
            }),
          ),
        ).catch(() => {});
      };
      const move = (pointerEvent: PointerEvent) => {
        // A trackpad pinch repaints the camera up to 80ms before the store
        // learns the new zoom, so travel divides by what is on screen now.
        const zoom = liveDesignZoom();
        const dx = (pointerEvent.clientX - startX) / zoom;
        const dy = (pointerEvent.clientY - startY) / zoom;
        if (!moved && Math.hypot(dx, dy) < 3 / zoom) return;
        moved = true;
        const raw = resizeDesignRect(startBounds, dx, dy, handle, {
          minWidth: 1,
          minHeight: 1,
          keepAspect: pointerEvent.shiftKey,
          fromCenter: pointerEvent.altKey,
        });
        const snappingDisabled =
          pointerEvent.metaKey ||
          pointerEvent.ctrlKey ||
          pointerEvent.shiftKey ||
          pointerEvent.altKey;
        const snapped = snappingDisabled
          ? { rect: raw, guides: {} }
          : snapDesignResizeRect(raw, handle, peerRects, 6 / zoom);
        latestBounds = snapped.rect;
        latestRects = new Map(
          starts.map(({ details }) => [
            details.oid,
            resizeDesignRectWithinBounds(
              details.rect,
              startBounds,
              latestBounds,
            ),
          ]),
        );
        paintGuides(snapped.guides);
        paint();
        loop.author({});
      };
      const cleanup = () => {
        loop.stop();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        if (pointerOwner.hasPointerCapture?.(pointerId)) {
          pointerOwner.releasePointerCapture(pointerId);
        }
        paintGuides({});
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        delete groupOverlay.dataset.designGesture;
        gestureCancelRef.current = null;
      };
      const finish = () => {
        cleanup();
        if (!moved) return;
        const finalUpdates = updates();
        for (const update of finalUpdates) {
          publishDesignGestureLivePreview(
            workspaceId,
            frame.file,
            update.nodeId,
            update.styles,
            { settle: true },
          );
        }
        void (async () => {
          const foundation =
            foundationAtStart ??
            (await designFoundationCache.load(
              designFoundationKey(workspaceId, frame.file, frame.sourceVersion),
              () =>
                fetchDesignFoundation(
                  designFoundationKey(
                    workspaceId,
                    frame.file,
                    frame.sourceVersion,
                  ),
                ),
              { maxAgeMs: Number.POSITIVE_INFINITY },
            ));
          await applyDesignTransactionCached(workspaceId, frame.file, {
            schemaVersion: 1,
            transactionId: `desktop:${crypto.randomUUID()}`,
            documentId: foundation.summary.documentId,
            baseRevision: foundation.summary.revision,
            actor: { kind: "human", id: "desktop" },
            intent: `Resize ${finalUpdates.length} selected layers`,
            createdAt: Date.now(),
            operations: finalUpdates.map((update) => ({
              operationId: `resize:${crypto.randomUUID()}`,
              type: "node.set-styles",
              nodeId: update.nodeId,
              styles: update.styles,
              scope: "auto",
              responsiveContext: "base",
              stateContext: "default",
            })),
          });
        })().catch((error) => {
          restore();
          toast.error("Couldn't resize the selected elements", {
            description: errorMessage(error),
          });
        });
      };
      const cancel = () => {
        cleanup();
        restore();
      };

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      document.body.style.cursor =
        DESIGN_RESIZE_HANDLES.find((item) => item.handle === handle)?.cursor ??
        "nwse-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
    },
    [
      active,
      canvasFoundation.data,
      liveDesignZoom,
      parentOutlineDetails,
      peerGeometryDetails,
      workspaceId,
    ],
  );

  const startNodeGesture = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      frame: DesignCanvasFrameWire,
      details: DesignRuntimeNodeDetails,
      gestureMode: "move" | DesignResizeHandle,
    ) => {
      if (
        !workspaceId ||
        !active ||
        activeTool !== "select" ||
        !event.isPrimary ||
        event.button !== 0
      ) {
        return;
      }
      if (gestureMode === "move") {
        viewportRef.current?.focus({ preventScroll: true });
      }
      if (gestureMode === "move" && view.selectedNodeIds.length > 1) {
        const topLevelIds = designLayerTopLevelSelectionIds(
          selectedRuntimeTree,
          view.selectedNodeIds,
        );
        const detailsById = new Map(
          selectedNodeDetailsList.map((candidate) => [
            candidate.oid,
            candidate,
          ]),
        );
        const group = topLevelIds.flatMap((nodeId) => {
          const candidate = detailsById.get(nodeId);
          return candidate ? [candidate] : [];
        });
        if (startNodeGroupMove(event, frame, group, details)) return;
      }
      const overlay = event.currentTarget.closest<HTMLElement>(
        "[data-design-element-overlay]",
      );
      if (!overlay) return;
      const finishClickSelection = () => {
        if (gestureMode !== "move" || !folder) return;
        if (
          event.detail > 1 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey
        )
          return;
        if (event.shiftKey) {
          void toggleDesignNodeSelection({
            workspaceId,
            folder,
            frame,
            nodeId: details.oid,
            details,
          }).catch(() => {});
          return;
        }
        const bounds = overlay
          .closest<HTMLElement>("[data-design-frame]")
          ?.getBoundingClientRect();
        if (!bounds) return;
        void selectDesignFrameBodyAtLocation({
          workspaceId,
          folder,
          frame,
          x: ((event.clientX - bounds.left) * frame.width) / bounds.width,
          y: ((event.clientY - bounds.top) * frame.height) / bounds.height,
          intent: event.metaKey || event.ctrlKey ? "deepest" : "plain",
        }).catch(() => {});
      };
      if (
        gestureMode === "move" &&
        view.selectedNodeIds.length <= 1 &&
        !details.box?.rotation
      ) {
        if (
          ["flex", "inline-flex", "grid", "inline-grid"].includes(
            details.layout?.parentDisplay ?? "",
          ) ||
          selectedFrameHasFlow
        ) {
          gestureCancelRef.current?.();
          const cancel = startDesignLayoutDrag({
            event,
            workspaceId,
            frame,
            details,
            zoom: liveDesignZoom,
            paint: (geometry, parentRect) => {
              const box =
                "styles" in geometry
                  ? designSelectionBox(geometry)
                  : { ...designSelectionBox(details), ...geometry.rect };
              paintDesignNodeOverlayGeometry(
                overlay,
                designSelectionOverlayFrame(box),
              );
              const guides =
                overlay.parentElement?.querySelector<HTMLElement>(
                  `[data-design-parent-guides="${CSS.escape(details.oid)}"]`,
                ) ?? null;
              if (guides && parentRect) {
                guides.dataset.parentX = String(parentRect.x);
                guides.dataset.parentY = String(parentRect.y);
                guides.dataset.parentWidth = String(parentRect.width);
                guides.dataset.parentHeight = String(parentRect.height);
              }
              paintDesignConstraintGuides(
                guides,
                designSelectionBoxBounds(box),
              );
            },
            detach: folder
              ? async (origin, movedDetails, presented) => {
                  return transferDesignLayerOnCanvas({
                    workspaceId,
                    folder,
                    frame,
                    details: movedDetails,
                    frames: snapshot?.frames ?? [],
                    origin: { x: frame.x + origin.x, y: frame.y + origin.y },
                    detach: true,
                    presented,
                  });
                }
              : undefined,
            finished: () => {
              gestureCancelRef.current = null;
            },
            clicked: finishClickSelection,
            failed: (error) =>
              toast.error("Couldn't move the layer", {
                description: errorMessage(error),
              }),
          });
          if (cancel) {
            gestureCancelRef.current = cancel;
            return;
          }
        }
      }
      event.preventDefault();
      event.stopPropagation();
      const pointerOwner = event.currentTarget;
      const pointerId = event.pointerId;
      pointerOwner.setPointerCapture?.(pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const box = designSelectionBox(details);
      const startOverlay = designSelectionOverlayFrame(box);
      const ownTransform = designLayoutTransform(details);
      // A rotated or scaled chain needs gesture math of its own: pointer travel
      // maps through the element's own axes, the held anchor has to be kept
      // still by hand, and peer snapping would align a bounding box the user
      // cannot see. Upright elements keep the exact path they always had.
      const turned =
        Math.abs(box.rotation) > 0.001 ||
        box.scaleX !== 1 ||
        box.scaleY !== 1 ||
        Math.abs(ownTransform.skewX) > 0.001 ||
        Math.abs(ownTransform.skewY) > 0.001;
      const ancestorRotation = box.rotation - ownTransform.rotate;
      const ancestorScaleX = box.scaleX / (Math.abs(ownTransform.scaleX) || 1);
      const ancestorScaleY = box.scaleY / (Math.abs(ownTransform.scaleY) || 1);
      const start = turned
        ? {
            x: box.x,
            y: box.y,
            width: Math.max(1, startOverlay.width),
            height: Math.max(1, startOverlay.height),
          }
        : {
            x: details.rect.x,
            y: details.rect.y,
            width: Math.max(1, details.rect.width),
            height: Math.max(1, details.rect.height),
          };
      /** Painted geometry for one gesture step, in frame coordinates. */
      const overlayFrameFor = (painted: typeof start) =>
        designSelectionOverlayFrame({
          ...box,
          x: painted.x,
          y: painted.y,
          width: painted.width / box.scaleX,
          height: painted.height / box.scaleY,
        });
      let latest = start;
      let latestStyles: Record<string, string> = {};
      let moved = false;
      const previewInput = {
        workspaceId,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
        nodeId: details.oid,
      };
      const spacingRoot = overlay.querySelector<HTMLElement>(
        "[data-design-inline-spacing-root]",
      );
      // Constraint guides live in frame space beside the overlay, because they
      // stay screen-aligned while the element itself may be turned.
      const constraintGuides =
        overlay.parentElement?.querySelector<HTMLElement>(
          `[data-design-parent-guides="${CSS.escape(details.oid)}"]`,
        ) ?? null;
      const layoutContainer = [
        "flex",
        "inline-flex",
        "grid",
        "inline-grid",
      ].includes(details.styles.display ?? "");
      const computedPosition = details.styles.position || "static";
      const baseLeft = designGesturePixelBase(
        previewInput,
        "left",
        details.styles.left,
      );
      const baseTop = designGesturePixelBase(
        previewInput,
        "top",
        details.styles.top,
      );
      // The authored size this gesture edits. `designCssSizeAfterResize` bases
      // its result on the same computed value, so quantizing here and authoring
      // there cannot disagree.
      const baseWidth = designGesturePixelBase(
        previewInput,
        "width",
        details.styles.width,
        start.width / box.scaleX,
      );
      const baseHeight = designGesturePixelBase(
        previewInput,
        "height",
        details.styles.height,
        start.height / box.scaleY,
      );
      const peerRects = [
        ...peerGeometryDetails.map((peer) => peer.rect),
        ...(parentOutlineDetails ? [parentOutlineDetails.rect] : []),
      ];
      const paintGuides = (guides: { x?: number; y?: number }) => {
        if (verticalGuideRef.current) {
          verticalGuideRef.current.style.display =
            guides.x === undefined ? "none" : "block";
          if (guides.x !== undefined) {
            verticalGuideRef.current.style.left = `${frame.x + guides.x}px`;
          }
        }
        if (horizontalGuideRef.current) {
          horizontalGuideRef.current.style.display =
            guides.y === undefined ? "none" : "block";
          if (guides.y !== undefined) {
            horizontalGuideRef.current.style.top = `${frame.y + guides.y}px`;
          }
        }
      };
      /** Authored offset for one gesture step. A transformed element grows away
       * from its own top-left corner and turns about a pivot that scales with
       * its size, so its position has to absorb both effects; without any
       * transform this is the plain difference the rect already carries. */
      const offsetForRect = (rect: typeof start) => {
        if (!turned) return { x: rect.x - start.x, y: rect.y - start.y };
        if (gestureMode === "move") {
          const parent = designLocalDelta(
            { x: rect.x - start.x, y: rect.y - start.y },
            ancestorRotation,
          );
          return { x: parent.x / ancestorScaleX, y: parent.y / ancestorScaleY };
        }
        return designResizeLayoutOffset({
          anchor: designResizeAnchor(start, rect),
          originX: box.originX,
          originY: box.originY,
          deltaWidth: (rect.width - start.width) / box.scaleX,
          deltaHeight: (rect.height - start.height) / box.scaleY,
          transform: ownTransform,
        });
      };
      /** The styles this step authors, and the geometry those exact integers
       * produce. A gesture writes whole pixels; painting the pointer's own
       * fractional rectangle instead is what left the overlay half a pixel from
       * the element and made an anchored edge oscillate. */
      const authoredForRect = (rect: typeof start) => {
        const axes =
          gestureMode === "move"
            ? { width: false, height: false }
            : designResizeStyleAxes(gestureMode);
        const offset = offsetForRect(rect);
        const flowChild =
          ["flex", "inline-flex", "grid", "inline-grid"].includes(
            details.layout?.parentDisplay ?? "",
          ) && !["absolute", "fixed"].includes(computedPosition);
        const authorsLeft =
          !flowChild && (gestureMode === "move" || Math.abs(offset.x) > 0.01);
        const authorsTop =
          !flowChild && (gestureMode === "move" || Math.abs(offset.y) > 0.01);
        const horizontal = designAuthoredResizeAxis({
          offset: baseLeft,
          size: baseWidth,
          startTravel: offset.x,
          endTravel: offset.x + (rect.width - start.width) / box.scaleX,
          authorsOffset: authorsLeft,
          authorsSize: axes.width,
        });
        const vertical = designAuthoredResizeAxis({
          offset: baseTop,
          size: baseHeight,
          startTravel: offset.y,
          endTravel: offset.y + (rect.height - start.height) / box.scaleY,
          authorsOffset: authorsTop,
          authorsSize: axes.height,
        });
        const styles: Record<string, string> = {};
        if (axes.width)
          Object.assign(styles, designSizingStyles(details, "x", "fixed"), {
            width: `${horizontal.size}px`,
          });
        if (axes.height)
          Object.assign(styles, designSizingStyles(details, "y", "fixed"), {
            height: `${vertical.size}px`,
          });
        if (authorsLeft) {
          styles.position =
            computedPosition === "static" ? "relative" : computedPosition;
          styles.left = `${horizontal.offset}px`;
        }
        if (authorsTop) {
          styles.position =
            computedPosition === "static" ? "relative" : computedPosition;
          styles.top = `${vertical.offset}px`;
        }
        Object.assign(styles, preserveDesignLayoutPins(details, styles));
        const width = start.width + horizontal.sizeTravel * box.scaleX;
        const height = start.height + vertical.sizeTravel * box.scaleY;
        // A rotated element grows away from its own top-left and turns about a
        // size-relative pivot, so its painted corner is recovered from the box
        // rather than from the authored offset.
        if (turned && gestureMode !== "move") {
          return {
            styles,
            rect: {
              width,
              height,
              ...designRotatedResizeOrigin({
                box,
                anchor: designResizeAnchor(start, rect),
                width: width / box.scaleX,
                height: height / box.scaleY,
              }),
            },
          };
        }
        const painted = designLocalDelta(
          {
            x: horizontal.offsetTravel * ancestorScaleX,
            y: vertical.offsetTravel * ancestorScaleY,
          },
          -ancestorRotation,
        );
        return {
          styles,
          rect: {
            x: start.x + painted.x,
            y: start.y + painted.y,
            width,
            height,
          },
        };
      };

      const paintPredicted = (rect: typeof start) => {
        paintDesignNodeOverlayGeometry(overlay, overlayFrameFor(rect));
        paintDesignConstraintGuides(
          constraintGuides,
          designSelectionBoxBounds({
            ...box,
            x: rect.x,
            y: rect.y,
            width: rect.width / box.scaleX,
            height: rect.height / box.scaleY,
          }),
        );
      };
      /** Whether the runtime has answered yet. Until it has — and again if it
       * ever stops — the pointer's prediction paints, so a grab is never left
       * waiting on a round trip. Once measurements are arriving, the element is
       * the only thing the outline is allowed to describe. */
      let measuring = false;

      /** One in-flight measurement, newest styles always next. */
      const loop = createDesignGestureLoop<DesignRuntimeNodeGeometry>({
        request: (styles) => {
          publishDesignGestureLivePreview(
            workspaceId,
            frame.file,
            details.oid,
            styles,
          );
          return previewDesignNodeGeometry({
            workspaceId,
            frame,
            nodeId: details.oid,
            styles,
            children:
              gestureMode !== "move" && Boolean(spacingRoot) && layoutContainer,
          });
        },
        failed: () => {
          // No answer means no truth to settle onto; keep the pointer's.
          measuring = false;
          paintPredicted(latest);
        },
        measured: (geometry) => {
          // The outline describes the element, so it is painted from what the
          // element actually became — never from where the pointer has reached.
          // Single flight makes that safe: nothing has written to the element
          // since this request applied its styles. Leading it instead is what
          // made the box and the content look detached mid-drag.
          measuring = true;
          const measuredBox = designSelectionBox(geometry);
          paintDesignNodeOverlayGeometry(
            overlay,
            designSelectionOverlayFrame(measuredBox),
          );
          paintDesignConstraintGuides(
            constraintGuides,
            designSelectionBoxBounds(measuredBox),
          );
          if (!spacingRoot) return;
          paintDesignInlinePaddingGeometry(spacingRoot, geometry);
          if (geometry.children.length > 0) {
            paintDesignInlineGapHandles(
              spacingRoot,
              geometry,
              geometry.children,
              liveDesignZoom(),
            );
          }
        },
      });

      const move = (pointerEvent: PointerEvent) => {
        // The camera can move under a gesture (pinch, trackpad zoom), and the
        // store learns 80ms later; travel has to divide by what is painted.
        const zoom = liveDesignZoom();
        const screenX = (pointerEvent.clientX - startX) / zoom;
        const screenY = (pointerEvent.clientY - startY) / zoom;
        if (!moved && Math.hypot(screenX, screenY) < 3 / zoom) return;
        moved = true;
        // A resize runs along the element's own edges, so its pointer travel
        // rotates into the element's axes first. A move stays screen-aligned.
        const local =
          turned && gestureMode !== "move"
            ? designLocalDelta({ x: screenX, y: screenY }, box.rotation)
            : { x: screenX, y: screenY };
        const raw =
          gestureMode === "move"
            ? { ...start, x: start.x + local.x, y: start.y + local.y }
            : resizeDesignRect(start, local.x, local.y, gestureMode, {
                minWidth: 1,
                minHeight: 1,
                keepAspect: pointerEvent.shiftKey,
                fromCenter: pointerEvent.altKey,
              });
        const snappingDisabled =
          turned ||
          pointerEvent.metaKey ||
          pointerEvent.ctrlKey ||
          (gestureMode !== "move" &&
            (pointerEvent.shiftKey || pointerEvent.altKey));
        const snapped = snappingDisabled
          ? { rect: raw, guides: {} }
          : gestureMode === "move"
            ? snapDesignRect(raw, peerRects, 6 / zoom)
            : snapDesignResizeRect(raw, gestureMode, peerRects, 6 / zoom);
        const authored = authoredForRect(snapped.rect);
        latest = authored.rect;
        paintGuides(snapped.guides);
        if (!measuring) paintPredicted(latest);
        // At 8× a screen pixel is an eighth of a CSS one, so most samples author
        // the integers the element already carries. Those cost a round trip and
        // a layout flush to be told nothing moved.
        if (sameDesignGestureStyles(latestStyles, authored.styles)) return;
        latestStyles = authored.styles;
        loop.author(latestStyles);
      };

      const cleanup = () => {
        loop.stop();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        if (pointerOwner.hasPointerCapture?.(pointerId)) {
          pointerOwner.releasePointerCapture(pointerId);
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        paintGuides({});
        gestureCancelRef.current = null;
      };

      const restorePreview = () => {
        paintDesignNodeOverlayGeometry(overlay, startOverlay);
        paintDesignConstraintGuides(
          constraintGuides,
          designSelectionBoxBounds(box),
        );
        if (spacingRoot) {
          paintDesignInlinePaddingGeometry(spacingRoot, details);
          if (layoutContainer) {
            paintDesignInlineGapHandles(
              spacingRoot,
              details,
              childGeometryDetails,
              liveDesignZoom(),
            );
          }
        }
        void clearDesignNodeStylePreviewTransient(previewInput).catch(() => {});
      };

      const finish = () => {
        cleanup();
        if (!moved) {
          finishClickSelection();
          return;
        }
        publishDesignGestureLivePreview(
          workspaceId,
          frame.file,
          details.oid,
          latestStyles,
          { settle: true },
        );
        void updateDesignNodeStylesCached(workspaceId, {
          frame: frame.file,
          nodeId: details.oid,
          sourceVersion: frame.sourceVersion,
          styles: latestStyles,
        }).catch((gestureError) => {
          restorePreview();
          toast.error(
            `Couldn't ${gestureMode === "move" ? "move" : "resize"} the design element`,
            {
              description: errorMessage(gestureError),
            },
          );
        });
      };

      const cancel = () => {
        cleanup();
        restorePreview();
      };

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      document.body.style.cursor =
        gestureMode === "move"
          ? "move"
          : (DESIGN_RESIZE_HANDLES.find((item) => item.handle === gestureMode)
              ?.cursor ?? "nwse-resize");
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
    },
    [
      active,
      activeTool,
      childGeometryDetails,
      folder,
      liveDesignZoom,
      parentOutlineDetails,
      peerGeometryDetails,
      selectedNodeDetailsList,
      snapshot?.frames,
      selectedFrameHasFlow,
      selectedRuntimeTree,
      startNodeGroupMove,
      view.selectedNodeId,
      view.selectedNodeIds,
      workspaceId,
    ],
  );

  /** Space-drag pans by directly painting the world, then persists on release. */
  const startPan = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        !workspaceId ||
        !active ||
        (event.button !== 1 && !spacePressedRef.current)
      ) {
        return false;
      }
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const start = view;
      let latest: DesignViewport = start;

      const move = (pointerEvent: PointerEvent) => {
        latest = {
          ...start,
          panX: start.panX + pointerEvent.clientX - startX,
          panY: start.panY + pointerEvent.clientY - startY,
        };
        paintDesignCanvasCamera(worldRef.current, latest, true);
      };

      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
        paintDesignCanvasCamera(worldRef.current, latest, false);
        setViewport(workspaceId, latest);
      };

      const cancel = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
        paintDesignCanvasCamera(worldRef.current, start, false);
      };

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
      return true;
    },
    [active, setViewport, view, workspaceId],
  );

  // Canvas shortcuts are focus-scoped and attach only while the visible design
  // surface is active, protecting other inputs and retained Home shells.
  useEffect(() => {
    if (!active) return;
    const keyDown = (event: KeyboardEvent) => {
      // A held pointer gesture is modal, so it owns the keyboard for as long as
      // it runs — wherever focus happens to sit, since a drag is as often
      // started from a selection made in Layers as on the canvas. Escape aborts
      // it; nothing else may retarget, delete, duplicate, or resize the element
      // the pointer is still holding. Escape used to fall through to the
      // selection stack instead, so a drag both jumped the selection to the
      // parent — unmounting the overlay the gesture was painting — and
      // committed anyway on release.
      if (gestureCancelRef.current) {
        if (event.key === "Escape") {
          event.preventDefault();
          gestureCancelRef.current();
          // Aborting an insertion drag hands the tool back too, exactly as
          // Escape does when one is armed but not yet dragging.
          if (activeTool !== "select") activateTool("select");
        }
        return;
      }
      const viewport = viewportRef.current;
      if (!viewport) return;
      const editableTarget = isEditableHotkeyTarget(event.target);
      // Option measures; it never types, moves, or deletes anything. Reading it
      // outside the canvas's own focus scope is what makes the overlay appear
      // right after a Layers row click, where focus lives in the sidebar.
      if (!editableTarget) syncMeasureModifier(event.altKey);
      const activeElement = document.activeElement;
      const designSurfaceFocused =
        activeElement instanceof Element &&
        Boolean(activeElement.closest("[data-design-workspace-surface]"));
      const selectedNodeIsTarget = Boolean(
        selectedFrame && view.selectedNodeId,
      );
      const selectedFrameIsTarget = Boolean(
        selectedFrame &&
        view.frameSelected &&
        view.selectedFrame === selectedFrame.file,
      );
      const selectionShortcut = resolveDesignSelectionShortcut(
        event,
        editableTarget,
        designSurfaceFocused && (selectedNodeIsTarget || selectedFrameIsTarget),
      );
      if (selectionShortcut) {
        event.preventDefault();
        if (selectionShortcut === "delete") {
          if (selectedNodeIsTarget) void deleteSelectedNode();
          else if (selectedFrame) void onDeleteFrame(selectedFrame);
        } else {
          const duplicateMode =
            selectionShortcut === "copy" ? "copy" : "duplicate";
          if (selectedFrame?.kind === "text" || !selectedNodeIsTarget) {
            void duplicateSelectedFrame(duplicateMode);
          } else {
            void duplicateSelectedNode(duplicateMode);
          }
        }
        return;
      }
      if (editableTarget) return;
      if (!viewport.contains(document.activeElement)) return;
      if (event.key === "Escape" && hitStackMenu) {
        event.preventDefault();
        setHitStackMenu(null);
        return;
      }
      if (event.key === "Escape" && activeTool !== "select") {
        event.preventDefault();
        activateTool("select");
        return;
      }
      if (event.code === "Space" && !event.repeat) {
        event.preventDefault();
        spacePressedRef.current = true;
        setSpacePressed(true);
        return;
      }
      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        event.key.toLowerCase() === "t"
      ) {
        event.preventDefault();
        setThemeEditorOpen((current) => !current);
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "a"
      ) {
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        const step = event.shiftKey ? 10 : 1;
        const handled = resizeSelectedNode(
          event.key === "ArrowLeft"
            ? -step
            : event.key === "ArrowRight"
              ? step
              : 0,
          event.key === "ArrowUp"
            ? -step
            : event.key === "ArrowDown"
              ? step
              : 0,
        );
        if (handled) event.preventDefault();
        return;
      }
      if (event.key === "Escape" && view.selectedNodeId && selectedFrame) {
        event.preventDefault();
        const parentId = designLayerParentId(
          selectedNavigationTree,
          view.selectedNodeId,
        );
        if (parentId) navigateToNode(parentId);
        else {
          void selectDesignFrame(workspaceId!, selectedFrame, {
            selected: true,
          });
        }
        return;
      }
      if (event.key === "Escape" && view.frameSelected && selectedFrame) {
        event.preventDefault();
        void selectDesignFrame(workspaceId!, selectedFrame);
        return;
      }
      if (
        event.key === "Enter" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (view.selectedNodeId || view.frameSelected)
      ) {
        event.preventDefault();
        if (!view.selectedNodeId) {
          if (!event.shiftKey) {
            const child = selectedNavigationTree.find((node) => node.visible);
            if (child) navigateToNode(child.oid);
          }
          return;
        }
        if (event.shiftKey) {
          const parentId = designLayerParentId(
            selectedNavigationTree,
            view.selectedNodeId,
          );
          if (parentId) navigateToNode(parentId);
          else if (selectedFrame) {
            void selectDesignFrame(workspaceId!, selectedFrame, {
              selected: true,
            });
          }
          return;
        }
        const childId = designLayerChildId(
          selectedNavigationTree,
          view.selectedNodeId,
        );
        if (childId) navigateToNode(childId);
        else if (selectedFrame && canEditDesignNodeText(selectedNodeDetails)) {
          finishInlineTextTool(selectedFrame, selectedNodeDetails);
        }
        return;
      }
      if (
        event.key === "Tab" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        view.selectedNodeId
      ) {
        const siblingId = designLayerSiblingId(
          selectedNavigationTree,
          view.selectedNodeId,
          event.shiftKey ? -1 : 1,
        );
        if (!siblingId) return;
        event.preventDefault();
        navigateToNode(siblingId);
        return;
      }
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        const step = event.shiftKey ? 10 : 1;
        const handled = nudgeSelectedNode(
          event.key === "ArrowLeft"
            ? -step
            : event.key === "ArrowRight"
              ? step
              : 0,
          event.key === "ArrowUp"
            ? -step
            : event.key === "ArrowDown"
              ? step
              : 0,
        );
        if (handled) event.preventDefault();
        return;
      }
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        if (event.key.toLowerCase() === "v") {
          event.preventDefault();
          activateTool("select");
          return;
        }
        if (event.key.toLowerCase() === "t") {
          event.preventDefault();
          activateTool("text");
          return;
        }
        if (
          event.key.toLowerCase() === "f" ||
          event.key.toLowerCase() === "a"
        ) {
          event.preventDefault();
          activateTool("frame");
          return;
        }
      }
      if (
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "a" &&
        view.selectedNodeId
      ) {
        event.preventDefault();
        onMotionTimelineOpenChange(!motionTimelineOpen);
        return;
      }
      if (!event.shiftKey) return;
      if (event.code === "Digit1") {
        event.preventDefault();
        fitFrames(snapshot?.frames ?? []);
      } else if (event.code === "Digit2" && selectedFrame) {
        event.preventDefault();
        fitFrames([selectedFrame]);
      } else if (event.code === "Digit0") {
        event.preventDefault();
        zoomAt(1);
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
          event.key,
        ) &&
        nudgeGestureRef.current
      ) {
        finishNodeNudge();
      }
      if (event.code === "Space") {
        spacePressedRef.current = false;
        setSpacePressed(false);
      }
      syncMeasureModifier(
        event.altKey && !isEditableHotkeyTarget(event.target),
      );
    };
    const blur = () => {
      spacePressedRef.current = false;
      setSpacePressed(false);
      syncMeasureModifier(false);
      if (nudgeGestureRef.current) finishNodeNudge();
    };
    // A hidden window cannot deliver the release, so leaving the app must not
    // strand the measurement overlay on the canvas.
    const visibility = () => {
      if (document.visibilityState !== "visible") blur();
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [
    active,
    activeTool,
    activateTool,
    deleteSelectedNode,
    duplicateSelectedFrame,
    duplicateSelectedNode,
    finishInlineTextTool,
    finishNodeNudge,
    fitFrames,
    hitStackMenu,
    nudgeSelectedNode,
    motionTimelineOpen,
    navigateToNode,
    onMotionTimelineOpenChange,
    onDeleteFrame,
    resizeSelectedNode,
    selectedFrame,
    selectedNodeDetails,
    selectedNavigationTree,
    selectedRuntimeTree,
    snapshot?.frames,
    syncMeasureModifier,
    view.frameSelected,
    view.selectedFrame,
    view.selectedNodeId,
    workspaceId,
    zoomAt,
  ]);

  // Navigation/collapse during a drag must release window listeners and restore
  // the pre-gesture DOM geometry before the retained surface becomes inert.
  useEffect(
    () => () => {
      gestureCancelRef.current?.();
      gestureCancelRef.current = null;
      if (canvasHoverFrameRef.current !== null) {
        window.cancelAnimationFrame(canvasHoverFrameRef.current);
        canvasHoverFrameRef.current = null;
      }
      canvasHoverSampleRef.current = null;
      const hoverOwner = canvasHoverOwnerRef.current;
      canvasHoverOwnerRef.current = null;
      if (hoverOwner) {
        void hoverDesignNode({
          workspaceId: hoverOwner.workspaceId,
          folder: hoverOwner.folder,
          frame: hoverOwner.frame.file,
          sourceVersion: hoverOwner.frame.sourceVersion,
          nodeId: null,
        });
      }
      if (wheelSettleTimerRef.current !== null) {
        window.clearTimeout(wheelSettleTimerRef.current);
        wheelSettleTimerRef.current = null;
      }
      wheelViewportRef.current = null;
    },
    [active, folder, workspaceId],
  );

  // --- EVENT HANDLERS ---

  const descendAtCanvasPoint = useCallback(
    (
      frame: DesignCanvasFrameWire,
      frameElement: HTMLElement,
      clientX: number,
      clientY: number,
    ) => {
      if (
        !active ||
        !workspaceId ||
        !folder ||
        activeTool !== "select" ||
        spacePressedRef.current
      )
        return;
      const bounds = frameElement.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      void selectDesignFrameBodyAtLocation({
        workspaceId,
        folder,
        frame,
        x: ((clientX - bounds.left) * frame.width) / bounds.width,
        y: ((clientY - bounds.top) * frame.height) / bounds.height,
        intent: "descend",
        preferText: true,
        onLocalSelection: (details) => {
          if (canEditDesignNodeText(details) && details.text !== null) {
            finishInlineTextTool(frame, details);
          }
        },
      }).catch((selectionError) => {
        toast.error("Couldn't inspect that nested element", {
          description: errorMessage(selectionError),
        });
      });
    },
    [active, activeTool, finishInlineTextTool, folder, workspaceId],
  );

  const scheduleCanvasHover = useCallback(
    (event: React.PointerEvent<HTMLElement>, frame: DesignCanvasFrameWire) => {
      if (
        !workspaceId ||
        !folder ||
        !active ||
        gestureCancelRef.current ||
        spacePressedRef.current
      ) {
        return;
      }
      const bounds = event.currentTarget.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      canvasHoverSampleRef.current = {
        workspaceId,
        folder,
        frame,
        x: ((event.clientX - bounds.left) * frame.width) / bounds.width,
        y: ((event.clientY - bounds.top) * frame.height) / bounds.height,
      };
      if (
        canvasHoverFrameRef.current !== null ||
        canvasHoverRequestRef.current
      ) {
        return;
      }
      canvasHoverFrameRef.current = window.requestAnimationFrame(() => {
        canvasHoverFrameRef.current = null;
        const initialSample = canvasHoverSampleRef.current;
        canvasHoverSampleRef.current = null;
        if (!initialSample) return;
        const drain = async () => {
          let sample: typeof initialSample | null = initialSample;
          while (sample) {
            canvasHoverOwnerRef.current = {
              workspaceId: sample.workspaceId,
              folder: sample.folder,
              frame: sample.frame,
            };
            await hoverDesignNodeAtLocation(sample);
            sample = canvasHoverSampleRef.current;
            canvasHoverSampleRef.current = null;
          }
        };
        const request = drain().finally(() => {
          if (canvasHoverRequestRef.current === request) {
            canvasHoverRequestRef.current = null;
          }
        });
        canvasHoverRequestRef.current = request;
      });
    },
    [active, folder, workspaceId],
  );

  const clearCanvasHover = useCallback(
    (frame: DesignCanvasFrameWire) => {
      if (!workspaceId || !folder) return;
      canvasHoverSampleRef.current = null;
      if (canvasHoverFrameRef.current !== null) {
        window.cancelAnimationFrame(canvasHoverFrameRef.current);
        canvasHoverFrameRef.current = null;
      }
      canvasHoverOwnerRef.current = null;
      void hoverDesignNode({
        workspaceId,
        folder,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
        nodeId: null,
      });
    },
    [folder, workspaceId],
  );

  const openHitStack = useCallback(
    (event: React.MouseEvent<HTMLElement>, frame: DesignCanvasFrameWire) => {
      if (!workspaceId || !active) return;
      event.preventDefault();
      event.stopPropagation();
      const frameBounds = event.currentTarget.getBoundingClientRect();
      const viewportBounds = viewportRef.current?.getBoundingClientRect();
      if (
        !viewportBounds ||
        frameBounds.width <= 0 ||
        frameBounds.height <= 0
      ) {
        return;
      }
      const generation = ++hitStackGenerationRef.current;
      const clientX = event.clientX;
      const clientY = event.clientY;
      const anchor = createMenuAnchor(
        event.currentTarget,
        { x: clientX, y: clientY },
        { scaleWithElement: true },
      );
      const x =
        ((clientX - frameBounds.left) * frame.width) / frameBounds.width;
      const y =
        ((clientY - frameBounds.top) * frame.height) / frameBounds.height;
      void inspectDesignNodeAtLocation({ workspaceId, frame, x, y })
        .then((details) => {
          if (hitStackGenerationRef.current !== generation) return;
          const runtimeSnapshot =
            useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
              frame.file
            ]?.snapshot;
          const rawTree = runtimeSnapshot?.tree ?? EMPTY_DESIGN_TREE;
          const tree =
            frame.kind === "text"
              ? rawTree
              : designFrameLayerChildren(rawTree, runtimeSnapshot?.frame.oid);
          const path = details ? designLayerPathIds(tree, details.oid) : [];
          const byId = new Map(
            flattenDesignLayerTree(tree).map((layer) => [
              layer.node.oid,
              layer.node,
            ]),
          );
          const layers = [...path].reverse().flatMap((oid) => {
            const node = byId.get(oid);
            return node ? [{ oid, name: node.name, tag: node.tag }] : [];
          });
          setHitStackMenu({
            frame,
            workspaceId,
            anchor,
            layers,
          });
        })
        .catch(() => {
          // A source reload can invalidate a speculative context hit.
        });
    },
    [active, workspaceId],
  );

  const paintCreationDraft = useCallback(
    (
      rect: { x: number; y: number; width: number; height: number },
      kind: "frame" | "text",
      zoom: number,
    ) => {
      const draft = creationDraftRef.current;
      if (!draft) return;
      draft.dataset.designCreationDraft = kind;
      draft.style.display = "block";
      draft.style.left = `${rect.x}px`;
      draft.style.top = `${rect.y}px`;
      draft.style.width = `${Math.max(1, rect.width)}px`;
      draft.style.height = `${Math.max(1, rect.height)}px`;
      draft.style.outlineWidth = `${1 / zoom}px`;
      const label = draft.querySelector<HTMLElement>(
        "[data-design-creation-size]",
      );
      if (label) {
        label.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
        label.style.transform = `translateY(${-6 / zoom}px) scale(${1 / zoom})`;
      }
    },
    [],
  );

  const hideCreationDraft = useCallback(() => {
    if (creationDraftRef.current) {
      creationDraftRef.current.style.display = "none";
    }
  }, []);

  /** A frame drawn inside a document belongs to its nearest frame container. */
  const createChildFrame = useCallback(
    async (
      owner: DesignCanvasFrameWire,
      start: { x: number; y: number },
      end?: { x: number; y: number },
    ) => {
      if (!workspaceId || !folder || creatingFrameRef.current) return;
      creatingFrameRef.current = true;
      setCreatingFrame(true);
      const selection = designWorkspaceView(workspaceId);
      try {
        const runtime = designFrameRuntime(workspaceId, owner.file);
        if (!runtime)
          throw new Error("The frame is still preparing its editable surface.");
        let parent = await runtime.getElementAtLoc(start.x, start.y, {
          mode: "deepest",
        });
        // Text and images can be hit while drawing; insert beside them inside
        // their nearest frame, never inside a text node or a void element.
        for (
          let depth = 0;
          parent && !canInsertDesignFrame(parent) && depth < 32;
          depth++
        ) {
          parent = parent.layout?.parentId
            ? await runtime.getNodeDetails(parent.layout.parentId)
            : null;
        }
        if (!parent) {
          const snapshot = await runtime.getSnapshot();
          parent = snapshot.frame.oid
            ? await runtime.getNodeDetails(snapshot.frame.oid)
            : null;
        }
        if (!parent || !canInsertDesignFrame(parent))
          throw new Error("Select a drawable frame for the new child.");
        const nodeId = `frame-${crypto.randomUUID()}`;
        const operations = designFrameInsertionOperations(
          parent,
          nodeId,
          start,
          end,
        );
        const key = designFoundationKey(
          workspaceId,
          owner.file,
          parent.sourceVersion,
        );
        const foundation = await designFoundationCache.load(
          key,
          () => fetchDesignFoundation(key),
          { maxAgeMs: Number.POSITIVE_INFINITY },
        );
        const result = await applyDesignTransactionCached(
          workspaceId,
          owner.file,
          {
            schemaVersion: 1,
            transactionId: `desktop:${crypto.randomUUID()}`,
            documentId: foundation.summary.documentId,
            baseRevision: foundation.summary.revision,
            actor: { kind: "human", id: "desktop" },
            intent: "Create child frame",
            createdAt: Date.now(),
            operations,
          },
        );
        const current = designWorkspaceView(workspaceId);
        const nextFrame = result.snapshot?.frames.find(
          (frame) => frame.file === owner.file,
        );
        if (
          nextFrame &&
          current.selectedFrame === selection.selectedFrame &&
          current.selectedNodeId === selection.selectedNodeId
        ) {
          // Publish identity immediately; the incoming runtime's ready snapshot
          // completes details for the newly authored node.
          void selectDesignNode({
            workspaceId,
            folder,
            frame: nextFrame,
            nodeId,
          }).catch(() => {});
        }
      } catch (error) {
        toast.error("Couldn't create the child frame", {
          description: errorMessage(error),
        });
      } finally {
        creatingFrameRef.current = false;
        setCreatingFrame(false);
      }
    },
    [folder, workspaceId],
  );

  /** Pointer-down captures one canvas owner and inverse-zoom drag. */
  const startFrameCreation = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (
        !workspaceId ||
        !active ||
        activeTool !== "frame" ||
        creatingFrameRef.current ||
        !event.isPrimary ||
        event.button !== 0 ||
        spacePressedRef.current
      ) {
        return false;
      }
      const viewport = viewportRef.current;
      if (!viewport) return false;
      const viewportBounds = viewport.getBoundingClientRect();
      const gestureViewport = wheelViewportRef.current ?? view;
      const start = designCanvasPointFromClient(
        { x: event.clientX, y: event.clientY },
        viewportBounds,
        gestureViewport,
      );
      const pointerOwner = event.currentTarget;
      const ownerFile = pointerOwner.closest<HTMLElement>("[data-design-frame]")
        ?.dataset.designFrame;
      const owner = snapshot?.frames.find(
        (frame) => frame.file === ownerFile && frame.kind !== "text",
      );
      const pointerId = event.pointerId;
      let latest = start;
      let moved = false;
      event.preventDefault();
      event.stopPropagation();
      pointerOwner.setPointerCapture?.(pointerId);

      const move = (pointerEvent: PointerEvent) => {
        latest = designCanvasPointFromClient(
          { x: pointerEvent.clientX, y: pointerEvent.clientY },
          viewportBounds,
          gestureViewport,
        );
        if (
          !moved &&
          Math.hypot(
            pointerEvent.clientX - event.clientX,
            pointerEvent.clientY - event.clientY,
          ) < 3
        ) {
          return;
        }
        moved = true;
        paintCreationDraft(
          designCanvasRectFromPoints(start, latest),
          "frame",
          gestureViewport.zoom,
        );
      };
      const cleanup = (hide = true) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        if (pointerOwner.hasPointerCapture?.(pointerId)) {
          pointerOwner.releasePointerCapture(pointerId);
        }
        if (hide) hideCreationDraft();
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
      };
      const finish = () => {
        const rect = moved
          ? designCanvasRectFromPoints(start, latest)
          : { x: start.x, y: start.y, width: 100, height: 100 };
        const geometry = {
          x: rect.x,
          y: rect.y,
          w: Math.max(1, rect.width),
          h: Math.max(1, rect.height),
          z: Math.min(
            256,
            Math.max(
              0,
              ...(snapshot?.frames.map((frame) => frame.z + 1) ?? [0]),
            ),
          ),
        };
        paintCreationDraft(
          {
            x: geometry.x,
            y: geometry.y,
            width: geometry.w,
            height: geometry.h,
          },
          "frame",
          gestureViewport.zoom,
        );
        cleanup(false);
        activateTool("select");
        const creation = owner
          ? createChildFrame(
              owner,
              { x: start.x - owner.x, y: start.y - owner.y },
              moved
                ? { x: latest.x - owner.x, y: latest.y - owner.y }
                : undefined,
            )
          : createFrame(geometry);
        void creation.finally(hideCreationDraft);
      };
      const cancel = () => cleanup();

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      document.body.style.cursor = "crosshair";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
      return true;
    },
    [
      active,
      activeTool,
      activateTool,
      createFrame,
      createChildFrame,
      hideCreationDraft,
      paintCreationDraft,
      snapshot?.frames,
      view,
      workspaceId,
    ],
  );

  /** Loose text still needs durable source ownership. The host editor begins
   * immediately at the world point; on commit the engine atomically creates a
   * transparent text-backed frame, so no orphan overlay or placeholder frame
   * can flash between typing and persistence. */
  const startCanvasTextInsertion = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (
        !workspaceId ||
        !active ||
        activeTool !== "text" ||
        !event.isPrimary ||
        event.button !== 0 ||
        spacePressedRef.current
      ) {
        return false;
      }
      const viewport = viewportRef.current;
      if (!viewport) return false;
      const viewportBounds = viewport.getBoundingClientRect();
      const gestureViewport = wheelViewportRef.current ?? view;
      const point = (clientX: number, clientY: number) =>
        designCanvasPointFromClient(
          { x: clientX, y: clientY },
          viewportBounds,
          gestureViewport,
        );
      const start = point(event.clientX, event.clientY);
      const pointerOwner = event.currentTarget;
      const pointerId = event.pointerId;
      let latest = start;
      let moved = false;
      event.preventDefault();
      event.stopPropagation();
      pointerOwner.setPointerCapture?.(pointerId);

      const move = (pointerEvent: PointerEvent) => {
        latest = point(pointerEvent.clientX, pointerEvent.clientY);
        if (
          !moved &&
          Math.hypot(
            pointerEvent.clientX - event.clientX,
            pointerEvent.clientY - event.clientY,
          ) < 3
        ) {
          return;
        }
        moved = true;
        paintCreationDraft(
          designCanvasRectFromPoints(start, latest),
          "text",
          gestureViewport.zoom,
        );
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        if (pointerOwner.hasPointerCapture?.(pointerId)) {
          pointerOwner.releasePointerCapture(pointerId);
        }
        hideCreationDraft();
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
      };
      const finish = () => {
        cleanup();
        const rect = moved
          ? designCanvasRectFromPoints(start, latest)
          : { x: start.x, y: start.y, width: undefined, height: undefined };
        const previousSelection = designWorkspaceView(workspaceId);
        const nodeId = createDesignTextNodeId();
        inlineTextDraftRef.current = "";
        setInlineTextEdit({
          id: crypto.randomUUID(),
          kind: "new",
          owner: "canvas",
          frame: null,
          sourceVersion: null,
          parentNodeId: null,
          previousFrame: previousSelection.selectedFrame,
          previousNodeId: previousSelection.selectedNodeId,
          previousNodeIds: previousSelection.selectedNodeIds,
          nodeId,
          initialText: "",
          status: "editing",
          canvasX: rect.x,
          canvasY: rect.y,
          x: 0,
          y: 0,
          placement: "absolute",
          inheritedStyles: {
            color: DESIGN_CANVAS_DEFAULT_TEXT_COLOR,
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            fontSize: "16px",
            fontWeight: "400",
            lineHeight: "24px",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          },
          ...(rect.width === undefined
            ? {}
            : {
                width: Math.max(1, rect.width),
                height: Math.max(1, rect.height ?? 1),
              }),
        });
        activateTool("select");
      };
      const cancel = () => cleanup();

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      document.body.style.cursor = "crosshair";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
      return true;
    },
    [
      active,
      activeTool,
      activateTool,
      hideCreationDraft,
      paintCreationDraft,
      view,
      workspaceId,
    ],
  );

  /** Text click targets existing text; an empty hit creates auto-width text.
   * A drag always creates a fixed text box at the exact frame-local rect. */
  const startTextInsertion = useCallback(
    (event: React.PointerEvent<HTMLElement>, frame: DesignCanvasFrameWire) => {
      if (
        !workspaceId ||
        !folder ||
        !active ||
        activeTool !== "text" ||
        !event.isPrimary ||
        event.button !== 0 ||
        spacePressedRef.current
      ) {
        return false;
      }
      const article = event.currentTarget;
      const bounds = article.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      const localPoint = (clientX: number, clientY: number) => ({
        x: Math.min(
          frame.width,
          Math.max(0, ((clientX - bounds.left) * frame.width) / bounds.width),
        ),
        y: Math.min(
          frame.height,
          Math.max(0, ((clientY - bounds.top) * frame.height) / bounds.height),
        ),
      });
      const start = localPoint(event.clientX, event.clientY);
      const pointerId = event.pointerId;
      let latest = start;
      let moved = false;
      event.preventDefault();
      event.stopPropagation();
      article.setPointerCapture?.(pointerId);

      const move = (pointerEvent: PointerEvent) => {
        latest = localPoint(pointerEvent.clientX, pointerEvent.clientY);
        if (
          !moved &&
          Math.hypot(
            pointerEvent.clientX - event.clientX,
            pointerEvent.clientY - event.clientY,
          ) < 3
        ) {
          return;
        }
        moved = true;
        const rect = designCanvasRectFromPoints(start, latest);
        paintCreationDraft(
          { ...rect, x: frame.x + rect.x, y: frame.y + rect.y },
          "text",
          view.zoom,
        );
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        if (article.hasPointerCapture?.(pointerId)) {
          article.releasePointerCapture(pointerId);
        }
        hideCreationDraft();
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
      };
      const openNewText = (
        point: { x: number; y: number },
        size?: { width: number; height: number },
        hitDetails?: DesignRuntimeNodeDetails | null,
      ) => {
        const runtimeFrame =
          useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
            frame.file
          ];
        const tree = runtimeFrame?.snapshot?.tree ?? EMPTY_DESIGN_TREE;
        const rootNodeId = runtimeFrame?.snapshot?.frame.oid || tree[0]?.oid;
        const layoutDisplay = (details: DesignRuntimeNodeDetails | null) =>
          details &&
          ["flex", "inline-flex", "grid", "inline-grid"].includes(
            details.styles.display ?? "",
          );
        const containsPoint = (details: DesignRuntimeNodeDetails | null) =>
          Boolean(
            details &&
            point.x >= details.rect.x &&
            point.x <= details.rect.x + details.rect.width &&
            point.y >= details.rect.y &&
            point.y <= details.rect.y + details.rect.height,
          );
        const rootDetails = rootNodeId
          ? (runtimeFrame?.detailsByNode[rootNodeId] ??
            (runtimeFrame?.snapshot?.frame.oid === rootNodeId
              ? runtimeFrame.snapshot.frame
              : null))
          : null;
        const selectedLayout =
          layoutDisplay(selectedNodeDetails) &&
          containsPoint(selectedNodeDetails)
            ? selectedNodeDetails
            : null;
        const parentDetails =
          (layoutDisplay(hitDetails ?? null) ? hitDetails : null) ??
          selectedLayout ??
          rootDetails;
        const parentNodeId = parentDetails?.oid ?? rootNodeId;
        if (!parentNodeId) {
          toast.error("The frame is still preparing its editable root");
          return;
        }
        const nodeId = createDesignTextNodeId();
        const placement = layoutDisplay(parentDetails) ? "flow" : "absolute";
        // Authored data-oid roots are positioned containers. Store coordinates
        // in that exact containing block while the gesture remains frame-local.
        const parentPoint = {
          x: point.x - (parentDetails?.rect.x ?? 0),
          y: point.y - (parentDetails?.rect.y ?? 0),
        };
        inlineTextDraftRef.current = "";
        const previousSelection = designWorkspaceView(workspaceId);
        useDesignWorkspaceUiStore
          .getState()
          .setSelection(workspaceId, frame.file, null);
        setInlineTextEdit({
          id: crypto.randomUUID(),
          kind: "new",
          owner: "frame",
          frame: frame.file,
          parentNodeId,
          previousFrame: previousSelection.selectedFrame ?? frame.file,
          previousNodeId: previousSelection.selectedNodeId,
          previousNodeIds: previousSelection.selectedNodeIds,
          nodeId,
          sourceVersion: frame.sourceVersion,
          initialText: "",
          status: "editing",
          canvasX: point.x,
          canvasY: point.y,
          x: parentPoint.x,
          y: parentPoint.y,
          ...(size ? size : {}),
          placement,
          inheritedStyles: parentDetails?.styles ?? {
            color: DESIGN_CANVAS_DEFAULT_TEXT_COLOR,
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            fontSize: "16px",
            fontWeight: "400",
            lineHeight: "24px",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          },
        });
        activateTool("select");
      };
      const finish = () => {
        cleanup();
        if (moved) {
          const rect = designCanvasRectFromPoints(start, latest);
          openNewText(
            { x: rect.x, y: rect.y },
            {
              width: Math.max(1, rect.width),
              height: Math.max(1, rect.height),
            },
          );
          return;
        }
        void inspectDesignNodeAtLocation({
          workspaceId,
          frame,
          x: start.x,
          y: start.y,
          mode: "deepest",
        })
          .then((details) => {
            if (activeToolRef.current !== "text") return;
            if (canEditDesignNodeText(details) && details.text !== null) {
              void selectDesignNode({
                workspaceId,
                folder,
                frame,
                nodeId: details.oid,
                details,
              }).catch(() => {});
              finishInlineTextTool(frame, details);
              return;
            }
            openNewText(start, undefined, details);
          })
          .catch((selectionError) => {
            toast.error("Couldn't start text editing", {
              description: errorMessage(selectionError),
            });
          });
      };
      const cancel = () => cleanup();

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      document.body.style.cursor = "crosshair";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
      return true;
    },
    [
      active,
      activeTool,
      activateTool,
      finishInlineTextTool,
      folder,
      hideCreationDraft,
      paintCreationDraft,
      selectedNodeDetails,
      view.zoom,
      workspaceId,
    ],
  );

  /** Empty-canvas drag selects rendered direct children in the current
   * nesting context. Geometry stays in a direct DOM overlay during movement;
   * the sandbox performs one authoritative bounded hit query on release. */
  const startMarquee = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      options?: {
        frame?: DesignCanvasFrameWire;
        onClick?: () => void;
      },
    ) => {
      if (
        !workspaceId ||
        !folder ||
        !active ||
        activeTool !== "select" ||
        !event.isPrimary ||
        event.button !== 0
      ) {
        return false;
      }
      const viewport = viewportRef.current;
      if (!viewport) return false;
      const viewportBounds = viewport.getBoundingClientRect();
      const pointerOwner = event.currentTarget;
      const pointerId = event.pointerId;
      const start = {
        x: event.clientX - viewportBounds.left,
        y: event.clientY - viewportBounds.top,
      };
      const additive = event.shiftKey;
      let latest = start;
      let moved = false;
      event.preventDefault();
      event.stopPropagation();
      pointerOwner.setPointerCapture?.(pointerId);

      const paint = () => {
        const marquee = marqueeRef.current;
        if (!marquee) return;
        const left = Math.min(start.x, latest.x);
        const top = Math.min(start.y, latest.y);
        marquee.style.display = moved ? "block" : "none";
        marquee.style.left = `${left}px`;
        marquee.style.top = `${top}px`;
        marquee.style.width = `${Math.abs(latest.x - start.x)}px`;
        marquee.style.height = `${Math.abs(latest.y - start.y)}px`;
      };
      const move = (pointerEvent: PointerEvent) => {
        latest = {
          x: pointerEvent.clientX - viewportBounds.left,
          y: pointerEvent.clientY - viewportBounds.top,
        };
        if (!moved && Math.hypot(latest.x - start.x, latest.y - start.y) < 3) {
          return;
        }
        moved = true;
        paint();
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        if (pointerOwner.hasPointerCapture?.(pointerId)) {
          pointerOwner.releasePointerCapture(pointerId);
        }
        if (marqueeRef.current) marqueeRef.current.style.display = "none";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
      };
      const finish = () => {
        cleanup();
        if (!moved) {
          if (options?.onClick) options.onClick();
          else if (!additive) publishSelection(selectedFrame);
          return;
        }
        const screenRect = {
          x: Math.min(start.x, latest.x),
          y: Math.min(start.y, latest.y),
          width: Math.abs(latest.x - start.x),
          height: Math.abs(latest.y - start.y),
        };
        const worldRect = {
          x: (screenRect.x - view.panX) / view.zoom,
          y: (screenRect.y - view.panY) / view.zoom,
          width: screenRect.width / view.zoom,
          height: screenRect.height / view.zoom,
        };
        const overlapArea = (frame: DesignCanvasFrameWire) => {
          const left = Math.max(worldRect.x, frame.x);
          const top = Math.max(worldRect.y, frame.y);
          const right = Math.min(
            worldRect.x + worldRect.width,
            frame.x + frame.width,
          );
          const bottom = Math.min(
            worldRect.y + worldRect.height,
            frame.y + frame.height,
          );
          return Math.max(0, right - left) * Math.max(0, bottom - top);
        };
        const frame =
          options?.frame ??
          [...(snapshot?.frames ?? [])]
            .map((candidate) => ({ candidate, area: overlapArea(candidate) }))
            .filter(({ area }) => area > 0)
            .sort(
              (left, right) =>
                Number(right.candidate.file === selectedFrame?.file) -
                  Number(left.candidate.file === selectedFrame?.file) ||
                right.area - left.area,
            )[0]?.candidate;
        if (!frame) {
          if (!additive) publishSelection(selectedFrame);
          return;
        }
        const scopeNodeId =
          frame.file === selectedFrame?.file && view.selectedNodeId
            ? designLayerParentId(selectedRuntimeTree, view.selectedNodeId)
            : null;
        void inspectDesignNodesInRect({
          workspaceId,
          frame,
          rect: {
            x: worldRect.x - frame.x,
            y: worldRect.y - frame.y,
            width: worldRect.width,
            height: worldRect.height,
          },
          scopeNodeId,
        })
          .then(async (details) => {
            const existing =
              additive && view.selectedFrame === frame.file
                ? view.selectedNodeIds
                : EMPTY_NODE_IDS;
            const nodeIds = [
              ...existing,
              ...details.map((candidate) => candidate.oid),
            ];
            if (nodeIds.length === 0) {
              if (!additive) await selectDesignFrame(workspaceId, frame);
              return;
            }
            await selectDesignNodes({
              workspaceId,
              folder,
              frame,
              nodeIds,
              primaryNodeId: details[0]?.oid ?? existing[0],
              details,
            });
          })
          .catch((selectionError) => {
            toast.error("Couldn't select layers in that area", {
              description: errorMessage(selectionError),
            });
          });
      };
      const cancel = () => cleanup();

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
      return true;
    },
    [
      active,
      activeTool,
      folder,
      publishSelection,
      selectedFrame,
      selectedRuntimeTree,
      snapshot?.frames,
      view.panX,
      view.panY,
      view.selectedFrame,
      view.selectedNodeId,
      view.selectedNodeIds,
      view.zoom,
      workspaceId,
    ],
  );

  const handleViewportPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      hitStackGenerationRef.current += 1;
      setHitStackMenu(null);
      viewportRef.current?.focus({ preventScroll: true });
      if (
        event.target instanceof Element &&
        event.target.closest("[data-design-controls]")
      ) {
        return;
      }
      if (startPan(event)) return;
      if (startFrameCreation(event)) return;
      if (
        event.target === event.currentTarget &&
        startCanvasTextInsertion(event)
      ) {
        return;
      }
      if (event.target === event.currentTarget && startMarquee(event)) return;
      if (event.target === event.currentTarget) publishSelection(selectedFrame);
    },
    [
      publishSelection,
      selectedFrame,
      startFrameCreation,
      startCanvasTextInsertion,
      startMarquee,
      startPan,
    ],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!active || !workspaceId) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      const current = wheelViewportRef.current ?? view;
      let latest: DesignViewport;
      if (event.metaKey || event.ctrlKey) {
        const factor = designWheelZoomFactor({
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          pageHeight: bounds.height,
        });
        latest = zoomDesignViewportAtPoint(current, current.zoom * factor, {
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        });
      } else {
        latest = {
          ...current,
          panX:
            current.panX -
            designWheelDeltaPixels(event.deltaX, event.deltaMode, bounds.width),
          panY:
            current.panY -
            designWheelDeltaPixels(
              event.deltaY,
              event.deltaMode,
              bounds.height,
            ),
        };
      }
      wheelViewportRef.current = latest;
      paintDesignCanvasCamera(worldRef.current, latest, true);
      if (wheelSettleTimerRef.current !== null) {
        window.clearTimeout(wheelSettleTimerRef.current);
      }
      wheelSettleTimerRef.current = window.setTimeout(() => {
        wheelSettleTimerRef.current = null;
        const settled = wheelViewportRef.current;
        wheelViewportRef.current = null;
        if (settled) setViewport(workspaceId, settled);
      }, 80);
    },
    [active, setViewport, view, workspaceId],
  );

  // --- RENDER ---

  return (
    <div className="relative min-h-0 min-w-[min(320px,50%)] flex-1 overflow-hidden">
      <div
        ref={viewportRef}
        data-design-canvas-viewport=""
        data-design-active-tool={activeTool}
        tabIndex={0}
        className={cn(
          "bg-bg2 relative size-full overflow-hidden outline-none",
          spacePressed
            ? "cursor-grab"
            : activeTool === "frame" || activeTool === "text"
              ? "cursor-crosshair"
              : "cursor-default",
        )}
        style={{
          // Runtime user color is an intentional canvas boundary.
          backgroundColor: canvasBackground,
        }}
        onPointerDown={handleViewportPointerDown}
        // Pointer movement carries the authoritative modifier state, so a
        // keydown lost to another focus owner (or pressed before the window was
        // focused) still resolves the moment the pointer enters the canvas.
        onPointerMove={(event) => syncMeasureModifier(event.altKey)}
        onWheel={handleWheel}
        aria-label="Design canvas"
      >
        <div
          ref={worldRef}
          data-design-canvas-world=""
          className="pointer-events-none absolute inset-0 origin-top-left"
          style={designCanvasCameraStyle(view)}
        >
          {snapshot?.frames.map((frame) => {
            const paintedFrame = frameGeometryPreviewsRef.current.get(
              `${workspaceId}\0${frame.file}`,
            )?.geometry;
            const selected = selectedFrame?.file === frame.file;
            // Keep the last confirmed semantic selection over the last painted
            // pixels while a structural generation revalidates. Exact new
            // details replace these nodes in place after the runtime is ready.
            const selectedElements = selected
              ? selectedNodeDetailsList
              : EMPTY_NODE_DETAILS;
            const selectedElement =
              selectedElements.find(
                (details) => details.oid === view.selectedNodeId,
              ) ?? null;
            const parentElement =
              selected && selectedElement ? parentOutlineDetails : null;
            // Frame chrome follows the semantic selection shared by body,
            // label, Layers, and keyboard navigation.
            const frameSelectedOnly =
              selected && view.frameSelected && !selectedElement;
            // Guides and Option/Alt measurements anchor on the primary
            // selection's parent; a root-level selection measures against the
            // frame itself. Null while a nested parent's rect is still loading.
            const parentGuideRect =
              selected && selectedElement
                ? selectedParentId
                  ? (parentElement?.rect ?? null)
                  : { x: 0, y: 0, width: frame.width, height: frame.height }
                : null;
            const transformElementIds = new Set(
              designLayerTopLevelSelectionIds(
                selectedRuntimeTree,
                selectedElements.map((details) => details.oid),
              ),
            );
            const transformElements = selectedElements.filter((details) =>
              transformElementIds.has(details.oid),
            );
            const multiSelectionBounds =
              selectedElements.length > 1
                ? {
                    x: Math.min(
                      ...transformElements.map((details) => details.rect.x),
                    ),
                    y: Math.min(
                      ...transformElements.map((details) => details.rect.y),
                    ),
                    right: Math.max(
                      ...transformElements.map(
                        (details) => details.rect.x + details.rect.width,
                      ),
                    ),
                    bottom: Math.max(
                      ...transformElements.map(
                        (details) => details.rect.y + details.rect.height,
                      ),
                    ),
                  }
                : null;
            const overlayElements = selectedElements;
            return (
              <article
                key={`${workspaceId ?? "pending"}:${frame.file}`}
                data-design-frame={frame.file}
                data-design-frame-kind={frame.kind ?? "frame"}
                className={cn(
                  "pointer-events-auto absolute outline",
                  frame.kind === "text" ? "bg-transparent" : "bg-bg1",
                  frameSelectedOnly
                    ? "zd-design-selection-outline"
                    : frame.kind === "text"
                      ? "outline-transparent"
                      : "outline-border2",
                )}
                style={{
                  left: paintedFrame?.x ?? frame.x,
                  top: paintedFrame?.y ?? frame.y,
                  width: paintedFrame?.w ?? frame.width,
                  height: paintedFrame?.h ?? frame.height,
                  zIndex: paintedFrame?.z ?? frame.z,
                  outlineWidth: frameSelectedOnly
                    ? designCanvasScreenPixels(2)
                    : frame.kind === "text"
                      ? 0
                      : designCanvasScreenPixels(1),
                }}
                onPointerDown={(event) => {
                  if (
                    !active ||
                    !event.isPrimary ||
                    event.button !== 0 ||
                    spacePressedRef.current
                  ) {
                    return;
                  }
                  if (
                    event.target instanceof Element &&
                    event.target.closest("[data-design-controls]")
                  ) {
                    return;
                  }
                  viewportRef.current?.focus({ preventScroll: true });
                  if (startFrameCreation(event)) return;
                  if (startTextInsertion(event, frame)) return;
                  if (!workspaceId || !folder) {
                    publishSelection(frame);
                    return;
                  }
                  event.preventDefault();
                  const article = event.currentTarget;
                  const pointer = {
                    clientX: event.clientX,
                    clientY: event.clientY,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    detail: event.detail,
                  };
                  const selectAtPoint = () => {
                    const bounds = article.getBoundingClientRect();
                    const scaleX =
                      bounds.width > 0 ? frame.width / bounds.width : 1;
                    const scaleY =
                      bounds.height > 0 ? frame.height / bounds.height : 1;
                    // The double-click handler owns descent exactly once. Its
                    // second pointer-up must not start a competing hit request.
                    if (
                      pointer.detail > 1 &&
                      !pointer.metaKey &&
                      !pointer.ctrlKey &&
                      !pointer.shiftKey
                    )
                      return;
                    const selection = selectDesignFrameBodyAtLocation({
                      workspaceId,
                      folder,
                      frame,
                      x: (pointer.clientX - bounds.left) * scaleX,
                      y: (pointer.clientY - bounds.top) * scaleY,
                      intent:
                        activeTool === "text" ||
                        pointer.metaKey ||
                        pointer.ctrlKey
                          ? "deepest"
                          : "plain",
                      additive: pointer.shiftKey,
                    });
                    void selection
                      .then((details) => {
                        if (
                          pointer.shiftKey ||
                          activeTool !== "text" ||
                          !canEditDesignNodeText(details)
                        ) {
                          return;
                        }
                        finishInlineTextTool(frame, details);
                      })
                      .catch((selectionError) => {
                        toast.error("Couldn't inspect that design element", {
                          description: errorMessage(selectionError),
                        });
                      });
                  };
                  if (
                    activeTool === "select" &&
                    startMarquee(event, { frame, onClick: selectAtPoint })
                  ) {
                    return;
                  }
                  selectAtPoint();
                }}
                onDoubleClick={(event) => {
                  if (
                    event.shiftKey ||
                    event.metaKey ||
                    event.ctrlKey ||
                    blocksDesignCanvasDoubleClick(event.target)
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  descendAtCanvasPoint(
                    frame,
                    event.currentTarget,
                    event.clientX,
                    event.clientY,
                  );
                }}
                onPointerMove={(event) => scheduleCanvasHover(event, frame)}
                onPointerLeave={() => clearCanvasHover(frame)}
                onContextMenu={(event) => openHitStack(event, frame)}
                onDragOver={(event) => {
                  if (!hasDesignAssetDrag(event.dataTransfer)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(event) => {
                  const assetPath = readDesignAssetDrag(event.dataTransfer);
                  if (!assetPath) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const scaleX =
                    bounds.width > 0 ? frame.width / bounds.width : 1;
                  const scaleY =
                    bounds.height > 0 ? frame.height / bounds.height : 1;
                  void insertAsset(frame, assetPath, {
                    x: (event.clientX - bounds.left) * scaleX,
                    y: (event.clientY - bounds.top) * scaleY,
                  });
                }}
              >
                {frame.kind !== "text" ? (
                  <div
                    data-design-controls
                    className="absolute bottom-full left-0 flex origin-bottom-left items-center"
                    style={
                      {
                        "--design-frame-label-max-width": `calc(${frame.width}px * var(--design-canvas-zoom))`,
                        maxWidth: "var(--design-frame-label-max-width)",
                        transform: `translateY(${designCanvasScreenPixels(-8)}) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
                      } as React.CSSProperties
                    }
                  >
                    {renamingFrame === frame.file ? (
                      <Input
                        autoFocus
                        value={renameDraft}
                        className="h-6 w-48"
                        aria-label={`Rename ${frame.title}`}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onPointerDown={(event) => event.stopPropagation()}
                        onBlur={() => setRenamingFrame(null)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void commitRename(frame);
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setRenamingFrame(null);
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        data-design-frame-label=""
                        title={frame.title}
                        className={cn(
                          "text-2xxs block max-w-full min-w-0 cursor-default overflow-hidden border-0 bg-transparent p-0 text-left leading-4 font-medium whitespace-nowrap outline-none",
                          frameSelectedOnly
                            ? "text-[var(--design-selection-stroke)]"
                            : "text-muted-fg",
                        )}
                        onPointerDown={(event) =>
                          startFrameGesture(event, frame, "move")
                        }
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          setRenameDraft(frame.title);
                          setRenamingFrame(frame.file);
                        }}
                      >
                        <span
                          data-design-frame-name=""
                          className="block max-w-full overflow-hidden text-ellipsis"
                        >
                          {frame.title}
                        </span>
                      </button>
                    )}
                  </div>
                ) : null}

                {workspaceId && folder ? (
                  <DesignFrameRenderSurface
                    workspaceId={workspaceId}
                    protocolCapability={snapshot.protocolCapability}
                    folder={folder}
                    frame={frame}
                    active={active}
                    selected={selected}
                    selectedNodeIds={
                      selected ? view.selectedNodeIds : EMPTY_NODE_IDS
                    }
                    live={liveFrameFiles.has(frame.file)}
                    theme={view.activeTheme}
                    highResolutionTile={
                      highResolutionTiles.get(frame.file) ?? null
                    }
                    highResolutionDisabled={
                      inlineTextEdit?.frame === frame.file
                    }
                  />
                ) : (
                  <div className="bg-bg2 text-muted-fg flex size-full items-center justify-center text-xs">
                    Preparing {frame.title}…
                  </div>
                )}

                {multiSelectionBounds ? (
                  <div
                    data-design-multi-selection=""
                    data-design-resize-roots={transformElements.length}
                    className="zd-design-selection-outline pointer-events-none absolute z-[2] outline"
                    style={{
                      left: multiSelectionBounds.x,
                      top: multiSelectionBounds.y,
                      width:
                        multiSelectionBounds.right - multiSelectionBounds.x,
                      height:
                        multiSelectionBounds.bottom - multiSelectionBounds.y,
                      outlineWidth: designCanvasScreenPixels(2),
                    }}
                  >
                    <span
                      data-design-group-size=""
                      className="zd-design-selection-label absolute top-full left-1/2 rounded-sm px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap"
                      style={{
                        marginTop: designCanvasScreenPixels(4),
                        transform: `translateX(-50%) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
                        transformOrigin: "top center",
                      }}
                    >
                      {Math.round(
                        multiSelectionBounds.right - multiSelectionBounds.x,
                      )}{" "}
                      ×{" "}
                      {Math.round(
                        multiSelectionBounds.bottom - multiSelectionBounds.y,
                      )}
                    </span>
                    <DesignResizeHandles
                      label={`${selectedElements.length} selected layers`}
                      onPointerDown={(event, handle) =>
                        startNodeGroupResize(
                          event,
                          frame,
                          transformElements,
                          handle,
                        )
                      }
                    />
                  </div>
                ) : null}

                {workspaceId ? (
                  <DesignLayerHoverOverlay
                    workspaceId={workspaceId}
                    frame={frame.file}
                    sourceVersion={frame.sourceVersion}
                    selectedNodeIds={
                      selected ? view.selectedNodeIds : EMPTY_NODE_IDS
                    }
                  />
                ) : null}

                {workspaceId &&
                measurePressed &&
                gestureCancelRef.current === null &&
                selectedElement &&
                inlineTextEdit?.frame !== frame.file ? (
                  <DesignMeasureOverlay
                    workspaceId={workspaceId}
                    frameFile={frame.file}
                    sourceVersion={frame.sourceVersion}
                    selected={selectedElement}
                    parentRect={parentGuideRect}
                  />
                ) : null}

                {parentGuideRect &&
                selectedElement &&
                (!measurePressed || gestureCancelRef.current !== null) &&
                inlineTextEdit?.frame !== frame.file ? (
                  <DesignConstraintGuides
                    nodeId={selectedElement.oid}
                    bounds={designSelectionBoxBounds(
                      designSelectionBox(selectedElement),
                    )}
                    parentRect={parentGuideRect}
                    sides={designConstraintSides({
                      position: selectedElement.styles.position,
                      authored: selectedElement.authoredStyleProperties,
                      styles: selectedElement.styles,
                    })}
                  />
                ) : null}

                {overlayElements.map((details) => {
                  const primarySelection = details.oid === selectedElement?.oid;
                  const additiveSelection = selectedElements.some(
                    (candidate) => candidate.oid === details.oid,
                  );
                  const editingThisElement =
                    inlineTextEdit?.kind === "existing" &&
                    inlineTextEdit.frame === frame.file &&
                    inlineTextEdit.nodeId === details.oid;
                  // The outline traces the element's own rotated box, not the
                  // upright bounding box a rotation grows around it.
                  const overlayFrame = designSelectionOverlayFrame(
                    designSelectionBox(details),
                  );
                  // Rotation and its pivot belong to the Select tool. Frame and
                  // Text are crosshair modes that must keep drawing through a
                  // live selection's corners.
                  const rotationToolsActive = activeTool === "select";
                  return (
                    <div
                      key={details.oid}
                      data-design-element-overlay={details.oid}
                      data-design-overlay-source-version={details.sourceVersion}
                      data-design-selected-element={
                        primarySelection ? "" : undefined
                      }
                      className={cn(
                        "absolute touch-none outline",
                        editingThisElement
                          ? "pointer-events-none outline-none"
                          : primarySelection
                            ? "zd-design-selection-outline pointer-events-auto cursor-move"
                            : additiveSelection
                              ? "zd-design-selection-outline pointer-events-auto cursor-move"
                              : "zd-design-hover-outline pointer-events-none",
                        additiveSelection &&
                          selectionOverlaySuppressed &&
                          "opacity-0",
                      )}
                      style={{
                        ...designSelectionOverlayStyle(overlayFrame),
                        zIndex: 1,
                        outlineWidth: editingThisElement
                          ? 0
                          : designCanvasScreenPixels(primarySelection ? 2 : 1),
                      }}
                      onPointerDown={(event) => {
                        if (
                          !additiveSelection ||
                          (event.target as HTMLElement).closest(
                            "[data-design-controls]",
                          )
                        ) {
                          return;
                        }
                        startNodeGesture(event, frame, details, "move");
                      }}
                      onPointerLeave={(event) => {
                        // Leaving the selection disarms its rotation pivot, so
                        // the center goes back to moving and editing.
                        if (
                          !event.currentTarget.hasAttribute(
                            "data-design-origin-dragging",
                          )
                        ) {
                          event.currentTarget.removeAttribute(
                            "data-design-origin-armed",
                          );
                        }
                      }}
                      onDoubleClick={(event) => {
                        if (
                          !primarySelection ||
                          selectedElements.length !== 1 ||
                          event.shiftKey ||
                          event.metaKey ||
                          event.ctrlKey ||
                          blocksDesignCanvasDoubleClick(event.target)
                        ) {
                          return;
                        }
                        const frameElement =
                          event.currentTarget.closest<HTMLElement>(
                            "[data-design-frame]",
                          );
                        if (!frameElement) return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (canEditDesignNodeText(details)) {
                          finishInlineTextTool(frame, details);
                          return;
                        }
                        descendAtCanvasPoint(
                          frame,
                          frameElement,
                          event.clientX,
                          event.clientY,
                        );
                      }}
                    >
                      {primarySelection && !editingThisElement ? (
                        <>
                          <span
                            data-design-spacing-hover-zone=""
                            className="absolute inset-0"
                            aria-hidden="true"
                          />
                          {motionTimelineOpen && currentMotionOverlay?.draft ? (
                            <DesignMotionCanvasOverlay
                              owner={motionOverlayOwner}
                              details={details}
                              draft={currentMotionOverlay.draft}
                              onSeek={seekMotionFromCanvas}
                            />
                          ) : null}
                          <DesignSelectionMeasurements
                            details={details}
                            overlay={overlayFrame}
                            children={childGeometryDetails}
                            zoom={view.zoom}
                            onSpacingPointerDown={(event, control) =>
                              startInlineSpacingGesture(
                                event,
                                frame,
                                details,
                                control,
                              )
                            }
                          />
                          {selectedElements.length === 1 ? (
                            <>
                              <span
                                data-design-rotation-feedback=""
                                className="bg-inverted-bg text-inverted-fg pointer-events-none absolute top-full right-full hidden rounded-sm px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap"
                                style={{
                                  marginTop: designCanvasScreenPixels(4),
                                  marginRight: designCanvasScreenPixels(4),
                                  transform: `rotate(${-overlayFrame.rotation}deg) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
                                  transformOrigin: "top right",
                                }}
                              />
                              <DesignResizeHandles
                                label={details.name}
                                onPointerDown={(event, handle) =>
                                  startNodeGesture(
                                    event,
                                    frame,
                                    details,
                                    handle,
                                  )
                                }
                              />
                              {rotationToolsActive ? (
                                <>
                                  <DesignRotationHandles
                                    label={details.name}
                                    rotation={overlayFrame.rotation}
                                    onPointerDown={(event) =>
                                      startNodeRotation(event, frame, details)
                                    }
                                  />
                                  <DesignOriginAnchors />
                                  {overlayFrame.width >=
                                    DESIGN_ORIGIN_HANDLE_MINIMUM / view.zoom &&
                                  overlayFrame.height >=
                                    DESIGN_ORIGIN_HANDLE_MINIMUM / view.zoom ? (
                                    <DesignOriginHandle
                                      label={details.name}
                                      overlay={overlayFrame}
                                      origin={designSelectionBox(details)}
                                      onPointerDown={(event) =>
                                        startNodeOriginGesture(
                                          event,
                                          frame,
                                          details,
                                        )
                                      }
                                      onReset={() =>
                                        void centerNodeOrigin(frame, details)
                                      }
                                    />
                                  ) : null}
                                </>
                              ) : null}
                            </>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  );
                })}

                {inlineTextEdit?.frame === frame.file ? (
                  <DesignInlineTextEditor
                    edit={inlineTextEdit}
                    details={
                      inlineTextEdit.kind === "existing" &&
                      selectedElements.length === 1 &&
                      selectedElement?.oid === inlineTextEdit.nodeId &&
                      canEditDesignNodeText(selectedElement)
                        ? selectedElement
                        : null
                    }
                    onMounted={suppressInlineTextGlyphs}
                    onDraft={previewInlineTextDraft}
                    onCommit={commitInlineText}
                    onCancel={cancelInlineTextEditing}
                  />
                ) : null}

                {frameSelectedOnly ? (
                  <DesignResizeHandles
                    label={frame.title}
                    onPointerDown={(event, handle) =>
                      startFrameGesture(event, frame, handle)
                    }
                  />
                ) : null}
              </article>
            );
          })}
          {inlineTextEdit?.kind === "new" &&
          inlineTextEdit.owner === "canvas" &&
          !inlineTextEdit.frame ? (
            <DesignInlineTextEditor
              edit={inlineTextEdit}
              details={null}
              onMounted={suppressInlineTextGlyphs}
              onDraft={previewInlineTextDraft}
              onCommit={commitInlineText}
              onCancel={cancelInlineTextEditing}
            />
          ) : null}
          <div
            ref={creationDraftRef}
            data-design-creation-draft="frame"
            className="zd-design-creation-draft pointer-events-none absolute z-[100001] hidden outline outline-solid"
            aria-hidden="true"
          >
            <span
              data-design-creation-size=""
              className="zd-design-selection-label absolute bottom-full left-0 origin-bottom-left rounded-sm px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap"
            />
          </div>
          <div
            ref={verticalGuideRef}
            data-design-guide="vertical"
            className="pointer-events-none absolute z-[100000] hidden bg-[var(--design-selection-stroke)]"
            style={{
              top: -100_000,
              width: designCanvasScreenPixels(1),
              height: 200_000,
            }}
            aria-hidden="true"
          />
          <div
            ref={horizontalGuideRef}
            data-design-guide="horizontal"
            className="pointer-events-none absolute z-[100000] hidden bg-[var(--design-selection-stroke)]"
            style={{
              left: -100_000,
              height: designCanvasScreenPixels(1),
              width: 200_000,
            }}
            aria-hidden="true"
          />
        </div>

        <div
          ref={marqueeRef}
          data-design-marquee=""
          className="zd-design-selection-border zd-design-selection-fill pointer-events-none absolute z-40 hidden border"
          aria-hidden="true"
        />

        {view.codeView &&
        selectedFrame &&
        (selectedFrameDocument.data || selectedFrameDocument.error) ? (
          <div
            data-design-controls
            className="bg-bg1 absolute inset-0 overflow-hidden p-4"
          >
            <ScrollArea className="h-full">
              <CodeBlock
                language="html"
                filename={`Zeros Design/${selectedFrame.file}`}
              >
                <pre>
                  {selectedFrameDocument.data?.source ??
                    "The frame source could not be loaded."}
                </pre>
              </CodeBlock>
            </ScrollArea>
          </div>
        ) : null}

        {!snapshot && showColdBusy ? (
          <div className="text-muted-fg pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
            Loading design…
          </div>
        ) : null}

        {!workspaceId && !snapshot ? (
          <div className="text-muted-fg pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
            Setting up design workspace…
          </div>
        ) : null}

        {hitStackMenu ? (
          <ContextMenu
            open={active && hitStackMenu.workspaceId === workspaceId}
            anchor={hitStackMenu.anchor}
            modal={false}
            onOpenChange={(open) => {
              if (!open) setHitStackMenu(null);
            }}
          >
            <ContextMenuContent
              data-design-controls
              aria-label="Layers under pointer"
              className="bg-bg1 w-52 rounded-md px-0 py-1"
              onPointerDown={(event) => event.stopPropagation()}
              onEntryFocus={(event) => {
                // This pointer-driven picker has always focused its deepest
                // layer first. Keep that origin for subsequent arrow keys.
                event.preventDefault();
                if (event.target instanceof HTMLElement) {
                  event.target.querySelector<HTMLElement>('[role="menuitem"]')
                    ?.focus({ preventScroll: true });
                }
              }}
              loop
            >
              <ContextMenuLabel className="text-muted-fg flex h-6 items-center px-2 text-[9px] font-medium tracking-wide uppercase">
                Select layer
              </ContextMenuLabel>
              {hitStackMenu.layers.map((layer, index) => (
                <ContextMenuItem
                  key={layer.oid}
                  className={cn(
                    "hover:bg-bg2 focus:bg-bg2 flex h-7 w-full min-w-0 items-center gap-2 rounded-none px-2 text-left",
                    view.selectedNodeId === layer.oid && "bg-highlighted-bg",
                  )}
                  onSelect={() => {
                    setHitStackMenu(null);
                    if (!workspaceId || !folder) return;
                    void selectDesignNode({
                      workspaceId,
                      folder,
                      frame: hitStackMenu.frame,
                      nodeId: layer.oid,
                    }).catch((selectionError) => {
                      toast.error("Couldn't select that design layer", {
                        description: errorMessage(selectionError),
                      });
                    });
                  }}
                >
                  <span className="text-muted-fg border-border2 shrink-0 rounded-sm border px-1 font-mono text-[8px] uppercase">
                    {layer.tag}
                  </span>
                  <span className="text-fg1 min-w-0 flex-1 truncate text-[11px]">
                    {layer.name}
                  </span>
                  <span className="text-muted-fg font-mono text-[9px]">
                    {index === 0 ? "deep" : `↑${index}`}
                  </span>
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator className="bg-border1 mx-0 my-1" />
              <ContextMenuItem
                className="hover:bg-bg2 focus:bg-bg2 flex h-7 w-full items-center gap-2 rounded-none px-2 text-left"
                onSelect={() => {
                  setHitStackMenu(null);
                  void selectDesignFrame(workspaceId!, hitStackMenu.frame, {
                    selected: true,
                  });
                }}
              >
                <Frame className="text-muted-fg size-3.5" />
                <span className="text-fg1 truncate text-[11px]">
                  {hitStackMenu.frame.title}
                </span>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : null}

        <DesignMotionTimeline
          key={`${workspaceId ?? "none"}:${selectedFrame?.file ?? "none"}:${selectedNodeDetails?.oid ?? "frame"}`}
          open={motionTimelineOpen}
          ownerKey={selectedFrame?.file ?? "frame"}
          sessionOwnerKey={motionOverlayOwner}
          details={selectedNodeDetails}
          definitions={
            canvasFoundation.data?.foundation.keyframes ??
            EMPTY_DESIGN_KEYFRAME_DEFINITIONS
          }
          propertyRequest={motionPropertyRequest}
          seekRequest={currentMotionSeekRequest}
          disabled={!active || !canvasFoundation.data}
          onOpenChange={onMotionTimelineOpenChange}
          onPreview={previewMotion}
          onClearPreview={clearMotionPreview}
          onSave={saveMotion}
          onDeleteMotion={deleteMotion}
          onPropertyRequestHandled={onMotionPropertyRequestHandled}
          onSeekRequestHandled={finishMotionSeekRequest}
          onPropertiesChange={onMotionPropertiesChange}
          onDraftChange={publishMotionDraft}
          onPlayheadChange={publishMotionPlayhead}
        />

        <Toolbar
          data-design-controls
          role="toolbar"
          aria-label="Canvas tools"
          className={cn(
            "zd-design-floating-toolbar absolute left-1/2 -translate-x-1/2 transition-[bottom]",
            motionTimelineOpen ? "bottom-[336px]" : "bottom-4",
          )}
        >
          <Tooltip label="Select" shortcut="V">
            <Button
              type="button"
              variant={activeTool === "select" ? "secondary-on" : "ghost"}
              size="icon-lg"
              aria-label="Select"
              aria-pressed={activeTool === "select"}
              aria-keyshortcuts="V"
              onClick={() => activateTool("select")}
            >
              <MousePointer2 />
            </Button>
          </Tooltip>
          <Tooltip
            label={creatingFrame ? "Creating frame…" : "Frame"}
            shortcut="F"
          >
            <Button
              type="button"
              variant={activeTool === "frame" ? "secondary-on" : "ghost"}
              size="icon-lg"
              disabled={!workspaceId || creatingFrame}
              aria-label="Frame tool"
              aria-pressed={activeTool === "frame"}
              aria-keyshortcuts="F"
              onClick={() => activateTool("frame")}
            >
              <Frame />
            </Button>
          </Tooltip>
          <Tooltip label="Text" shortcut="T">
            <Button
              type="button"
              variant={activeTool === "text" ? "secondary-on" : "ghost"}
              size="icon-lg"
              disabled={!workspaceId}
              aria-label="Text tool"
              aria-pressed={activeTool === "text"}
              aria-keyshortcuts="T"
              onClick={() => activateTool("text")}
            >
              <Type />
            </Button>
          </Tooltip>
          <Tooltip label="Read source">
            <Button
              type="button"
              variant={view.codeView ? "secondary-on" : "ghost"}
              size="icon-lg"
              disabled={!workspaceId || !selectedFrame}
              aria-label="Toggle frame source"
              aria-pressed={view.codeView}
              onPointerEnter={warmSelectedFrameDocument}
              onFocus={warmSelectedFrameDocument}
              onClick={() => {
                if (workspaceId) setCodeView(workspaceId, !view.codeView);
              }}
            >
              <Code2 />
            </Button>
          </Tooltip>
          <Tooltip
            label={`Themes · ${view.activeTheme ?? "Base"}`}
            shortcut="⌥T"
          >
            <Button
              ref={themeEditorTriggerRef}
              data-design-theme-trigger
              type="button"
              variant={themeEditorOpen ? "secondary-on" : "ghost"}
              size="icon-lg"
              disabled={!workspaceId || !selectedFrame}
              aria-label="Open theme editor"
              aria-haspopup="dialog"
              aria-expanded={themeEditorOpen}
              aria-keyshortcuts="Alt+T"
              onClick={() => setThemeEditorOpen((current) => !current)}
            >
              <Palette />
            </Button>
          </Tooltip>
          <Tooltip label="Motion timeline" shortcut="⇧A">
            <Button
              type="button"
              variant={motionTimelineOpen ? "secondary-on" : "ghost"}
              size="icon-lg"
              disabled={!workspaceId || !selectedFrame || !view.selectedNodeId}
              aria-label="Toggle motion timeline"
              aria-pressed={motionTimelineOpen}
              aria-keyshortcuts="Shift+A"
              onClick={() => onMotionTimelineOpenChange(!motionTimelineOpen)}
            >
              <Diamond />
            </Button>
          </Tooltip>
        </Toolbar>

        <DesignThemeEditor
          workspaceId={workspaceId}
          frame={selectedFrame}
          tokens={snapshot?.tokens ?? []}
          tokenSourceVersion={snapshot?.tokenSourceVersion ?? null}
          activeTheme={view.activeTheme}
          active={active}
          open={themeEditorOpen}
          returnFocusRef={themeEditorTriggerRef}
          onReturnFocus={focusThemeEditorTrigger}
          onOpenChange={setThemeEditorOpenWithFocus}
          onActiveThemeChange={changeActiveTheme}
        />
      </div>
    </div>
  );
}
