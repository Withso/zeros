import {
  DESIGN_CANVAS_INVERSE_ZOOM,
  designCanvasCameraStyle,
  designCanvasScreenPixels,
  paintDesignCanvasCamera,
  observeDesignCanvasChrome,
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
  Diamond,
  Frame,
  Image as ImageIcon,
  MousePointer2,
  Palette,
  Play,
  Type,
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useShallow } from "zustand/react/shallow";

import {
  DESIGN_FRAME_COORDINATE_LIMIT,
  DESIGN_FRAME_MAX_SIZE,
  type DesignOperation,
} from "@zeros/design-core";
import type { DesignAuthoredKeyframes } from "@zeros/design-web";
import {
  DESIGN_RUNTIME_DOCUMENT_BODY_ID,
  type DesignRuntimeNodeDetails,
  type DesignRuntimeNodeGeometry,
  type DesignRuntimeTreeNode,
} from "@zeros/protocol/design-runtime";

import { useWorkbenchStatusSource } from "../../shell/workbench/tab-status";
import { retainDesignResource } from "./state/design-resource-counters";
import { designFrameRuntime, waitForDesignFrameRuntime, type DesignFrameRuntimeConnection } from "../../platform/bridge/design-frame-runtime";
import { applyDesignNodeAction } from "./state/design-node-actions";
import {
  type DesignCanvasFrameWire,
  type DesignFrameGeometryWire,
} from "../../platform/git";
import { cn } from "../../shared/ui/cn";
import { createMenuAnchor, type MenuAnchor } from "../../shared/ui/menu-anchor";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "../../shared/ui/primitives/context-menu";
import {
  Input,
  Toolbar,
  toast,
} from "../../shared/ui/primitives";
import { isEditableHotkeyTarget } from "../../shell/editable-target";
import { beginDesignPointerGesture } from "./design-pointer-gesture";
import { hasDesignAssetDrag, readDesignAssetDrag } from "./design-assets";
import {
  canFillDesignContainer,
  canHugDesignContents,
  designFrameResizeRootStyles,
  designSizingMode,
  designSizingStyles,
} from "./design-auto-layout-values";
import {
  clampDesignRectPosition,
  clampDesignResizeRect,
  designAuthoredResizeAxis,
  designCanvasPointFromClient,
  designCanvasRectFromPoints,
  designConstraintSides,
  designCssSizeAfterResize,
  designHighResolutionViewportTile,
  designLocalDelta,
  designOriginFraction,
  designPointerRotation,
  designResizeAnchor,
  designResizeLayoutOffset,
  designResizeStyleAxes,
  designRevealRectViewport,
  designGestureRectUnchanged,
  designSafeViewportRect,
  designRotatedResizeOrigin,
  designRotationCursor,
  designSelectionBox,
  designSelectionBoxBounds,
  designSelectionClickIntent,
  designSelectionOverlayFrame,
  designSelectionPivot,
  designViewportShowsAnyRect,
  designWheelDeltaPixels,
  designWheelZoomFactor,
  fitDesignRects,
  resizeDesignRect,
  resizeDesignRectWithinBounds,
  snapDesignRect,
  snapDesignResizeRect,
  zoomDesignViewportAtPoint,
  DESIGN_VIEWPORT_NO_INSETS,
  type DesignHighResolutionViewportTile,
  type DesignResizeHandle,
  type DesignViewport,
  type DesignViewportInsets,
} from "./design-canvas-math";
import { createDesignDragPresentation } from "./design-drag-presentation";
import {
  formatDesignTransform,
  parseDesignTransform,
} from "./design-effect-values";
import {
  canInsertDesignFrame,
  designFrameInsertion,
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
import { startDesignFrameCopy } from "./design-frame-copy-gesture";
import { DESIGN_REPARENT_HYSTERESIS_PIXELS, designMovementDelta, designNodeMovementStyles, designNudgeStep } from "./design-movement-geometry";
import { designSelectionMutationTargets } from "./design-selected-targets";
import {
  DESIGN_SPACING_DRAG_THRESHOLD,
  designConstraintGuidesApply,
  designConstraintReferenceRect,
  designConstraintReferenceGeometry,
  designGapValue,
  designLocalAxisCursor,
  designLocalAxisDelta,
  designSizeBadgeText,
  designSpacingDragValue,
  designSpacingModifiers,
  type DesignGapProperty,
  type DesignSizeBadgeMode,
} from "./design-layout-tools";
import {
  designCanvasFrameAt,
  transferDesignLayerAtRelease,
  transferDesignLayerOnCanvas,
} from "./design-layout-transfer";
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
import { captureDeferredFocus } from "../../shared/ui/deferred-focus";
import { designThemeView, effectiveDesignTheme } from "./design-themes";
import { DesignToolbarButton } from "./design-inspector-kit";
import { designRuntimeLayerLabel } from "./design-layer-label";
import { useDesignWorkspaceDisclosure } from "./state/design-layer-disclosure";
import {
  clearDesignLivePreview,
  designLivePreviewValue,
  publishDesignGestureLivePreview,
} from "./state/design-live-preview";
import { publishDesignMotionPlayhead } from "./state/design-motion-playhead";
import { commitDesignLayoutOwnerStyles } from "./state/design-layout-owner-commit";
import {
  designLayoutToolsKey,
  publishDesignLayoutToolsLive,
  releaseDesignLayoutToolsLive,
} from "./state/design-layout-tools-live";
import { useDesignRuntimeStore, waitForDesignRuntimeFrame } from "./state/design-runtime-store";
import { clearDesignFrameIntent, noteDesignFrameIntent, primeDesignFrameIntent, useDesignFrameIntent } from "./state/design-frame-intent";
import { useDesignFrameResidency } from "./state/use-design-frame-residency";
import { designFrameViews, designFramesAtPresentedGeometry, isPreparedDesignFrame, type DesignFrameView } from "./state/design-frame-view";
import { useDesignHistoryGeometryPreview, useDesignHistorySelection } from "./state/design-history-presentation";
import { useDesignFramePreparation } from "./state/use-design-frame-preparation";
import { designBackgroundWork } from "./state/design-background-work";
import { activeDesignPreviewDemand, designPreviewDemandItems, type DesignPreviewLevel } from "./state/design-frame-previews";
import {
  useDesignFramePictured,
  useDesignFramePreviewDemand,
  useDesignPreviewOwner,
} from "./state/use-design-frame-previews";
import {
  clearDesignNodeStylePreviewTransient,
  clearDesignNodeTextPreviewTransient,
  hoverDesignNode,
  hoverDesignNodeAtLocation,
  inspectDesignNode,
  inspectDesignNodeAtLocation,
  previewDesignNodeGeometry,
  previewDesignNodeMotionTransient,
  previewDesignNodeStylesTransient,
  previewDesignNodeTextTransient,
  selectDesignFrame,
  selectDesignFrameBodyAtLocation,
  selectDesignNode,
  selectDesignNodeAtLocation,
  selectDesignNodes,
  selectDesignTargetsInRect,
  toggleDesignNodeSelection,
} from "./state/design-selection";
import { createDesignSerialQueue } from "./state/design-serial-queue";
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
  moveDesignFramesCached,
  updateDesignNodeStylesCached,
  hasPendingDesignEdits,
  subscribePendingDesignEdits,
  retireHiddenDesignFrames,
} from "./state/design-workspace-cache";
import {
  designWorkspaceView,
  isCurrentDesignPageOwner,
  captureDesignPageOwner,
  useDesignWorkspaceUiStore,
  useDesignWorkspaceView,
  designSelectionUnchangedSince,
} from "./state/design-workspace-ui";
import { useDesignFoundation } from "./state/use-design-foundation";

import { DesignFrameRenderSurface } from "./design-frame-render-surface";
import { hasAsyncCanvasWheel } from "../../platform/runtime";
import { useDesignSavedEditing } from "./design-saved-editing";
import {
  DesignAgentActivityChip,
  DesignAgentDraftFrameOverlay,
  DesignAgentDraftGhosts,
  useDesignAgentDraftFrameFiles,
  type DesignAgentRevealTarget,
} from "./design-agent-drafts";
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
type FrameGeometryPreview = {
  geometry: DesignFrameGeometryWire;
  settled: boolean;
  commit?: Promise<DesignCanvasFrameWire | undefined>;
};
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
/** How long a dragged frame rests over another before that one goes live. */
const DESIGN_NEST_DWELL_MS = 300;
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

type DesignSizeBadgeModes = {
  x?: DesignSizeBadgeMode;
  y?: DesignSizeBadgeMode;
};

/** Sizing intent after each dimension of the selection badge. Older runtimes
 * without layout metadata show plain numbers rather than a guessed mode. */
function designSizeBadgeModes(
  details: DesignRuntimeNodeDetails,
): DesignSizeBadgeModes | undefined {
  if (!details.layout) return undefined;
  const mode = (axis: "x" | "y") => {
    const resolved = designSizingMode(details, axis);
    return resolved === "hug" || resolved === "fill" ? resolved : undefined;
  };
  const x = mode("x");
  const y = mode("y");
  return x || y ? { x, y } : undefined;
}

/** A canvas frame hugs only where its root explicitly sizes to content. */
function designFrameSizeModeValues(
  root: DesignRuntimeNodeDetails | null,
): DesignSizeBadgeModes | undefined {
  if (!root?.layout) return undefined;
  const hug = (value: string | undefined) =>
    ["max-content", "min-content", "fit-content"].includes(value ?? "")
      ? ("hug" as const)
      : undefined;
  const x = hug(root.layout.widthValue);
  const y = hug(root.layout.heightValue);
  return x || y ? { x, y } : undefined;
}

function designFrameSizeModes(
  root: DesignRuntimeNodeDetails | null,
): string | null {
  const modes = designFrameSizeModeValues(root);
  return modes ? `${modes.x ?? "fixed"},${modes.y ?? "fixed"}` : null;
}

const frameRootPreviewQueue = createDesignSerialQueue();

/** Rendered bounds of floating chrome, or null while it is put away
 * (`display: none` leaves an element without client rects). */
function visibleChromeRect(element: Element | null | undefined): DOMRect | null {
  if (!element || element.getClientRects().length === 0) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/** The canvas edges floating chrome covers, read only when the camera moves
 * on purpose (fit, reveal, zoom about the centre): the directory pill along
 * the top, the tool rail on the left, the Layers + Inspector panel on the
 * right and an open Motion timeline along the bottom. */
function measureDesignCanvasInsets(
  viewport: HTMLElement | null,
): DesignViewportInsets {
  if (!viewport) return DESIGN_VIEWPORT_NO_INSETS;
  const bounds = viewport.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return DESIGN_VIEWPORT_NO_INSETS;
  const surface = viewport.closest("[data-design-workspace-surface]");
  const pill = visibleChromeRect(
    surface?.querySelector("[data-design-directory-header]"),
  );
  const tools = visibleChromeRect(
    viewport.querySelector('[data-design-canvas-tools-rail] [role="toolbar"]'),
  );
  const panel = visibleChromeRect(
    surface?.querySelector("[data-design-floating-panel]"),
  );
  const timeline = visibleChromeRect(
    viewport.querySelector("[data-design-motion-timeline]"),
  );
  return {
    top: pill ? Math.max(0, pill.bottom - bounds.top) : 0,
    left: tools ? Math.max(0, tools.right - bounds.left) : 0,
    right: panel ? Math.max(0, bounds.right - panel.left) : 0,
    bottom: timeline ? Math.max(0, bounds.bottom - timeline.top) : 0,
  };
}

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
// PURPOSE: Pan, zoom, select, create, move, resize, and rename
// USED IN: DesignWorkspaceColumn
// ============================================

const DesignPreparingFrame = React.forwardRef<HTMLElement, React.ComponentPropsWithoutRef<"article">>(function DesignPreparingFrame(props, ref) {
  useLayoutEffect(() => retainDesignResource("frameSurfaces"), []);
  return <article {...props} ref={ref} />;
});

export function DesignCanvas({
  workspaceId,
  folder,
  snapshot,
  loading,
  refresh,
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
  const canvasDirectoryId = snapshot?.directoryId ?? view.directoryId;
  const canvasPageOwner = useMemo(() => workspaceId ? { workspaceId, directoryId: canvasDirectoryId, pageId: view.activePageId, revision: view.ownerRevision ?? 0 } : undefined,
    [workspaceId, canvasDirectoryId, view.activePageId, view.ownerRevision]);
  const canvasDocumentOwner = `${workspaceId ?? ""}\0${canvasDirectoryId ?? ""}\0${view.activePageId ?? ""}`;
  const canvasDocumentOwnerRef = useRef(canvasDocumentOwner);
  canvasDocumentOwnerRef.current = canvasDocumentOwner;
  const canvasFolderRef = useRef(folder);
  canvasFolderRef.current = folder;
  const setActiveTheme = useDesignWorkspaceUiStore(
    (state) => state.setActiveTheme,
  );
  const setViewport = useDesignWorkspaceUiStore((state) => state.setViewport);
  // Frames show the chosen theme, else the named default theme (whose id
  // style sources may map); a directory without names keeps plain Base.
  const baseThemeId = useMemo(
    () => designThemeView(snapshot?.themes).baseId,
    [snapshot?.themes],
  );
  const frameTheme = effectiveDesignTheme(view.activeTheme, baseThemeId);
  // Undo and Redo show a frame's earlier place at once, before the engine
  // confirms it. Painting and hit testing read that presentation; every
  // write still checks the confirmed catalog.
  const historyGeometry = useDesignHistoryGeometryPreview(workspaceId ?? "");
  // Undo of a frame change also shows the frame it selects at once; this
  // paints frame chrome only. Gestures and writes keep the confirmed view.
  const historySelection = useDesignHistorySelection(active ? workspaceId : null);
  const paintedSelectedTargets = historySelection?.selectedTargets ?? view.selectedTargets;
  const confirmedFrameViews = designFrameViews(snapshot);
  const frameViews = useMemo(
    () => designFramesAtPresentedGeometry(confirmedFrameViews, active ? historyGeometry?.frames : null),
    [active, confirmedFrameViews, historyGeometry],
  );
  const preparedFrames = useMemo(() => frameViews.filter(isPreparedDesignFrame), [frameViews]);
  const preparationError = useMemo(() => {
    const message = Object.values(snapshot?.preparation?.errors ?? {})[0];
    return message ? new Error(message) : null;
  }, [snapshot?.preparation?.errors]);
  useWorkbenchStatusSource({ error: preparationError, pending: false, hasContent: !!snapshot, active, retry: refresh }, workspaceId ?? undefined);
  const selectedDescription = view.selectedFrame === null ? frameViews[0] : frameViews.find((frame) => frame.file === view.selectedFrame);
  const selectedFrame = selectedDescription && isPreparedDesignFrame(selectedDescription) ? selectedDescription : null;
  const canvasFoundation = useDesignFoundation(
    workspaceId,
    selectedFrame?.file,
    selectedFrame?.sourceVersion,
    active && Boolean(selectedFrame),
  );
  const selectedNodeDetails = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame || !view.selectedNodeId) return null;
    return (
      state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.detailsByNode[
        view.selectedNodeId
      ] ?? null
    );
  });
  // A selected canvas frame edits its root: the seeded frame root element or
  // the document body. This is the same target the inspector resolves.
  const selectedFrameRootDetails = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame) return null;
    const root =
      state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.snapshot
        ?.frame ?? null;
    return root?.oid ? root : null;
  });
  const frameLayoutOwnerDetails =
    view.frameSelected && !view.selectedNodeId
      ? selectedFrameRootDetails
      : null;
  // Motion uses the inspector's style target, including the outer frame root.
  // Selection, rather than runtime readback readiness, keeps the timeline open.
  const motionNodeDetails = selectedNodeDetails ?? frameLayoutOwnerDetails;
  const motionTargetSelected = view.frameSelected || Boolean(view.selectedNodeId);
  /** The one auto-layout owner whose padding and gaps the canvas edits: a
   * single selected layer, or the selected frame's root. A multi-selection
   * has none — editing its primary alone would surprise. */
  const layoutOwnerDetails =
    view.selectedNodeIds.length > 1
      ? null
      : (selectedNodeDetails ?? frameLayoutOwnerDetails);
  const layoutOwnerId = layoutOwnerDetails?.oid ?? null;
  // Cancels whichever direct-DOM pointer gesture owns global listeners.
  const gestureCancelRef = useRef<(() => void) | null>(null);
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
  // Only the secondary targets' own readbacks: hover reads, screenshots and
  // other frames' snapshots must not re-render the whole canvas.
  const secondaryTargetDetails = useDesignRuntimeStore(useShallow((state) => {
    const frames = workspaceId ? state.byWorkspace[workspaceId]?.frames : undefined;
    const details: Record<string, DesignRuntimeNodeDetails> = {};
    if (!frames) return details;
    for (const target of view.selectedTargets) {
      if (!target.nodeId) continue;
      const value = frames[target.frame]?.detailsByNode[target.nodeId];
      if (value) details[`${target.frame}\u0000${target.nodeId}`] = value;
    }
    return details;
  }));
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
  const childGeometrySelectionOwner = `${selectedFrame?.file ?? ""}\u0000${layoutOwnerId ?? ""}\u0000${frameTheme ?? ""}`;
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
    const display = layoutOwnerDetails?.styles.display;
    if (
      !active ||
      !workspaceId ||
      !selectedFrame ||
      !layoutOwnerId ||
      !layoutOwnerDetails ||
      !["flex", "inline-flex", "grid", "inline-grid"].includes(display ?? "")
    ) {
      return;
    }
    let cancelled = false;
    const owner = childGeometryOwner;
    // A metadata refresh can read the runtime while a gesture is previewing.
    // Its child boxes are provisional even if the reply arrives after Escape.
    // Keep the confirmed baseline; the gesture owns its own live measurement.
    const provisional = gestureCancelRef.current !== null;
    void previewDesignNodeGeometry({
      workspaceId,
      frame: selectedFrame,
      nodeId: layoutOwnerId,
      children: true,
    })
      .then((geometry) => {
        if (cancelled || provisional || gestureCancelRef.current) return;
        setChildGeometryState({
          owner,
          selectionOwner: childGeometrySelectionOwner,
          details: geometry.children,
        });
      })
      .catch(() => {
        if (!cancelled && !provisional && !gestureCancelRef.current) {
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
    layoutOwnerDetails,
    layoutOwnerId,
    selectedFrame,
    selectedRuntimeRevision,
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
  // Imported style sources can define themes that tokens.css does not.
  const availableThemes = useMemo(
    () =>
      new Set([
        ...(snapshot?.tokens.flatMap((token) => Object.keys(token.themeValues)) ??
          []),
        ...(snapshot?.styleSources?.flatMap((source) => source.themes) ?? []),
      ]),
    [snapshot?.styleSources, snapshot?.tokens],
  );

  const themeView = useMemo(
    () => designThemeView(snapshot?.themes, [...availableThemes]),
    [availableThemes, snapshot?.themes],
  );

  useEffect(() => {
    if (!workspaceId || !snapshot || !view.activeTheme) return;
    // Validate against the picker catalog, including themes without token
    // overrides. The default theme is shown by choosing none.
    if (themeView.others.includes(view.activeTheme)) return;
    setActiveTheme(workspaceId, null);
  }, [
    themeView,
    setActiveTheme,
    snapshot,
    view.activeTheme,
    workspaceId,
  ]);

  useEffect(() => {
    if (motionTimelineOpen && !motionTargetSelected) {
      onMotionTimelineOpenChange(false);
    }
  }, [motionTimelineOpen, motionTargetSelected, onMotionTimelineOpenChange]);

  // DOM owner for viewport bounds, focus scoping, and pointer-relative zoom.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Direct transform target keeps panning gesture paints out of React.
  const worldRef = useRef<HTMLDivElement | null>(null);
  const frameGeometryPreviewsRef = useRef(new Map<string, FrameGeometryPreview>());
  const frameElementsRef = useRef(new Map<string, HTMLElement>());
  const marqueeRef = useRef<HTMLDivElement | null>(null);
  const creationDraftRef = useRef<HTMLDivElement | null>(null);
  const verticalGuideRef = useRef<HTMLDivElement | null>(null);
  const horizontalGuideRef = useRef<HTMLDivElement | null>(null);
  // Space state is mirrored in a ref so pointer handlers read the current key.
  const spacePressedRef = useRef(false);
  /** A captured spacing edit freezes the camera: its coordinate system and
   * feedback must not move under the pointer mid-drag. */
  const spacingGestureRef = useRef(false);
  const panGestureRef = useRef(false);
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
  // One explicit playback session; it never survives an owner, source or
  // editing-intent change. A token also fences late iframe stop/error replies.
  const [playbackSession, setPlaybackSession] = useState<{
    id: string;
    owner: string;
    file: string;
    sourceVersion: string;
    selectionEvent: number | undefined;
  } | null>(null);
  // Tool choice is interaction-local; only semantic frame/node selection is durable.
  const [activeTool, setActiveTool] = useState<DesignCanvasTool>("select");
  const activeToolRef = useRef<DesignCanvasTool>("select");
  activeToolRef.current = activeTool;
  const activateTool = useCallback((tool: DesignCanvasTool) => {
    setPlaybackSession(null);
    activeToolRef.current = tool;
    setActiveTool(tool);
  }, []);
  // The theme matrix is a persistent non-modal tool window launched from the
  // canvas toolbar, so it may coexist with canvas and inspector work.
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);
  const motionOverlayOwner = `${workspaceId ?? ""}\u0000${snapshot?.directoryId ?? view.directoryId ?? ""}\u0000${selectedFrame?.file ?? ""}\u0000${motionNodeDetails?.oid ?? ""}`;
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
      // No draft reads the same for every owner; a closed timeline switching
      // selection must not re-render the canvas to say so again.
      setMotionOverlayState((current) =>
        (current.owner === motionOverlayOwner || (draft === null && current.draft === null)) &&
        current.draft === draft
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
  const setThemeEditorOpenWithFocus = useCallback(
    (open: boolean) => {
      // Radix Slot may own the outer Tooltip ref; use the scoped hook too.
      const trigger = themeEditorTriggerRef.current ??
        viewportRef.current?.querySelector<HTMLButtonElement>("[data-design-theme-trigger]") ?? null;
      const mayRestoreFocus = captureDeferredFocus(trigger);
      setThemeEditorOpen(open);
      if (open) return;
      // Controlled dialogs have no Radix DialogTrigger to restore. Wait until
      // FocusScope has unmounted, then return keyboard users to the canvas tool.
      window.requestAnimationFrame(() => {
        if (mayRestoreFocus()) trigger?.focus();
      });
    },
    [],
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
  }, [workspaceId, active, view.activePageId]);
  const frameActionIntentRef = useRef(0);
  const frameActionPendingRef = useRef(0);
  const pendingFrameCopyRef = useRef<{
    owner: ReturnType<typeof captureDesignPageOwner>;
    selectionEvent: number | undefined;
    frame: string;
    result: Promise<DesignCanvasFrameWire | null>;
  } | null>(null);
  const [selectionOverlaySuppressed, setSelectionOverlaySuppressed] =
    useState(false);
  const nudgeGestureRef = useRef<
    | (({
        mode: "move";
        frame: DesignCanvasFrameWire;
        selectionKey: string;
        nodes: Array<{
          nodeId: string;
          details: DesignRuntimeNodeDetails;
        }>;
        dx: number;
        dy: number;
      }
    | {
        mode: "frame";
        frame: DesignCanvasFrameWire;
        element: HTMLElement;
        preview: { geometry: DesignFrameGeometryWire; settled: boolean };
        dx: number;
        dy: number;
      }
    | {
        // Several selected frames; `frame` is the selected one.
        mode: "frames";
        frame: DesignCanvasFrameWire;
        selectionKey: string;
        members: Array<{
          file: string;
          key: string;
          start: DesignFrameGeometryWire;
          element: HTMLElement | null;
          preview: FrameGeometryPreview;
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
      }) & {
        owner: ReturnType<typeof captureDesignPageOwner>;
        selectionEvent: number | undefined;
        lifetime: number;
        canvasLifetime: number;
        retired: boolean;
        runtime: ReturnType<typeof designFrameRuntime>;
        runtimeRevision: number | undefined;
        theme: string | null;
        pending?: Promise<unknown>;
      })
    | null
  >(null);
  const nudgeLifetimeRef = useRef(0);
  const { session: savedEditingSession, state: savedEditingState, nativePixels } = useDesignSavedEditing();
  const canvasLifetimeRef = useRef(0);
  const nudgeCommitRef = useRef<Promise<void> | null>(null);
  const [nudgeCommitVersion, setNudgeCommitVersion] = useState(0);
  const queuedNudgeRef = useRef<{
    owner: ReturnType<typeof captureDesignPageOwner>;
    frame: string;
    selectionEvent: number | undefined;
    lifetime: number;
    theme: string | null;
    sourceVersion?: string;
    /** Several selected frames: geometry only, no live document needed. */
    frames: boolean;
    dx: number;
    dy: number;
    released: boolean;
  } | null>(null);
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
  const wheelPaintFrameRef = useRef<number | null>(null);
  const wheelSettleTimerRef = useRef<number | null>(null);
  const wheelBoundsRef = useRef<DOMRect | null>(null);
  const armWheelStartRef = useRef<(() => void) | null>(null);
  /** The transient camera zoom. Continued native input paints at the display
   * callback; direct actions flush it first. A wheel or pinch keeps the store
   * 80ms behind, so a gesture that
   * divided pointer travel by the store's number would track the pointer at the
   * wrong rate for the rest of the drag. */
  const liveDesignZoom = useCallback(
    () => wheelViewportRef.current?.zoom ?? view.zoom,
    [view.zoom],
  );
  const cancelPendingWheelGesture = useCallback(() => {
    if (wheelPaintFrameRef.current !== null) {
      window.cancelAnimationFrame(wheelPaintFrameRef.current);
      wheelPaintFrameRef.current = null;
    }
    if (wheelSettleTimerRef.current !== null) {
      window.clearTimeout(wheelSettleTimerRef.current);
      wheelSettleTimerRef.current = null;
    }
    wheelViewportRef.current = null;
    wheelBoundsRef.current = null;
    worldRef.current?.removeAttribute("data-design-camera-gesture");
    armWheelStartRef.current?.();
  }, []);
  // A retained canvas may change workspace owner before an 80ms trackpad
  // settle fires. Never let that old gesture publish into a hidden owner.
  useEffect(
    () => () => cancelPendingWheelGesture(),
    [cancelPendingWheelGesture, workspaceId],
  );
  const playbackOwner = `${canvasDocumentOwner}\0${folder ?? ""}\0${view.ownerRevision ?? 0}\0${snapshot?.protocolCapability ?? "bridge"}`;
  const playbackFrame = playbackSession && preparedFrames.find((frame) =>
    frame.file === playbackSession.file && frame.sourceVersion === playbackSession.sourceVersion);
  const currentPlayback =
    active && playbackSession?.owner === playbackOwner && playbackFrame &&
    activeTool === "select" && !inlineTextEdit && !renamingFrame && !motionTimelineOpen &&
    view.selectionEvent === playbackSession.selectionEvent && view.selectedTargets.length === 0 &&
    designViewportShowsAnyRect(view, viewportSize, [playbackFrame])
      ? playbackSession
      : null;
  const currentPlaybackRef = useRef(currentPlayback);
  currentPlaybackRef.current = currentPlayback;
  useLayoutEffect(() => {
    if (playbackSession && !currentPlayback) setPlaybackSession(null);
  }, [currentPlayback, playbackSession]);
  const stopFramePlayback = useCallback((sessionId: string, error?: Error) => {
    const current = currentPlaybackRef.current;
    if (current?.id !== sessionId) return;
    currentPlaybackRef.current = null;
    setPlaybackSession(null);
    if (!document.hidden) viewportRef.current?.querySelector<HTMLButtonElement>(
      `[data-design-frame-play="${CSS.escape(current.file)}"]`,
    )?.focus({ preventScroll: true });
    if (error) toast.error("Couldn't play this frame", { description: errorMessage(error) });
  }, []);
  useEffect(() => {
    if (!currentPlayback) return;
    const hide = () => {
      if (document.hidden) stopFramePlayback(currentPlayback.id);
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [currentPlayback, stopFramePlayback]);
  const liveFrameOwner = `${canvasDocumentOwner}\0${folder ?? ""}`;
  const subscribeEdits = useCallback((listener: () => void) => workspaceId
    ? subscribePendingDesignEdits(workspaceId, listener) : () => {}, [workspaceId]);
  const readPendingEdits = useCallback(() => !!workspaceId && hasPendingDesignEdits(workspaceId), [workspaceId]);
  const pendingEdits = useSyncExternalStore(subscribeEdits, readPendingEdits, readPendingEdits);
  // Layers reads each open frame's runtime tree, so an open frame is a demand
  // for a live runtime exactly like the selection is.
  const layerDisclosures = useDesignWorkspaceDisclosure(workspaceId);
  // A frame an agent is drafting ranks the same way: once the tool saves,
  // its live document paints the result in place under the draft.
  const agentDraftFiles = useDesignAgentDraftFrameFiles(
    workspaceId,
    snapshot?.directory,
  );
  // The frame a drag would nest into is outlined imperatively, so crossing
  // frames never re-renders the canvas. It goes live only once the pointer
  // rests on it or the drag releases there, so its drop slot resolves
  // against its document even while it painted a picture.
  const [nestLiveFile, setNestLiveFile] = useState<string | null>(null);
  const nestOutlineRef = useRef<HTMLElement | null>(null);
  const paintNestTarget = useCallback((file: string | null) => {
    const element = file
      ? viewportRef.current?.querySelector<HTMLElement>(`[data-design-frame="${CSS.escape(file)}"]`) ?? null
      : null;
    if (nestOutlineRef.current === element) return;
    nestOutlineRef.current?.removeAttribute("data-design-nest-target");
    element?.setAttribute("data-design-nest-target", "");
    nestOutlineRef.current = element;
  }, []);
  const showNestTarget = useCallback((file: string | null) => {
    paintNestTarget(file);
    setNestLiveFile(file);
  }, [paintNestTarget]);
  // The frame whose title or Layers row the pointer (or focus) rests on is the
  // likely next selection: boot its editor now so the click paints ready
  // Layers and inspector data. One latest frame, ranked with explicit demand.
  const intentFile = useDesignFrameIntent(active ? workspaceId : null);
  useEffect(() => {
    if (!active && workspaceId) clearDesignFrameIntent(workspaceId);
  }, [active, workspaceId]);
  // Selecting the frame fulfils the intent; selection demand owns it now, and
  // clearing the selection later must retire an editor nothing else needs.
  useEffect(() => {
    if (workspaceId && intentFile && view.selectedTargets.some((target) => target.frame === intentFile))
      clearDesignFrameIntent(workspaceId);
  }, [intentFile, view.selectedTargets, workspaceId]);
  const layersOpenFiles = useMemo(
    () => [
      ...(currentPlayback ? [currentPlayback.file] : []),
      ...Object.entries(view.layersVisible ? layerDisclosures : {})
        .filter(([, disclosure]) => disclosure.treeExpanded)
        .map(([file]) => file),
      ...agentDraftFiles,
      ...(nestLiveFile ? [nestLiveFile] : []),
      ...(intentFile && !currentPlayback ? [intentFile] : []),
    ],
    [agentDraftFiles, currentPlayback, intentFile, layerDisclosures, nestLiveFile, view.layersVisible],
  );
  // Saved pictures of this directory's frames. A frame painted no larger
  // than its picture shows the picture instead of running its document.
  const previewOwner = useDesignPreviewOwner(workspaceId, snapshot?.directoryId);
  const devicePixelRatio =
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const pictured = useDesignFramePictured(
    previewOwner,
    frameTheme,
    preparedFrames,
    active,
    (wheelViewportRef.current?.zoom ?? view.zoom) * devicePixelRatio,
  );
  // A lower-resolution decoded cover is enough to hand off a live slot while
  // finer pixels arrive. Without any cover, keep the visible document painted.
  const covered = useDesignFramePictured(previewOwner, frameTheme, preparedFrames, active);
  const sourceSurfaceState = useMemo(() => ({ owner: `${liveFrameOwner}\0${snapshot?.protocolCapability}\0${frameTheme}`,
    ready: new Map<string, string>(), unavailable: new Map<string, string>() }),
    [liveFrameOwner, snapshot?.protocolCapability, frameTheme]);
  const { frames: mountedFrames, live: liveFrameFiles, sources: sourceFrameFiles, refresh: refreshFrameResidency } = useDesignFrameResidency({
    owner: liveFrameOwner,
    frames: frameViews,
    active, view, viewport: viewportSize, camera: wheelViewportRef,
    // The active frame also serves metadata APIs and remembered navigation.
    // It needs an editor only when something consumes its live document.
    // A cached overview with closed panels must not keep a hidden editor busy.
    selectedFrame: view.frameSelected || view.selectedNodeIds.length > 0 || view.layersVisible ||
      view.inspectorVisible || activeTool === "text" || motionTimelineOpen || pendingEdits
      ? selectedDescription?.file ?? null : null,
    requiredFiles: layersOpenFiles, pictured, covered, devicePixelRatio,
    sourceSurfacesEnabled: !!snapshot?.protocolCapability,
    sourceReady: sourceSurfaceState.ready,
    sourceUnavailable: sourceSurfaceState.unavailable,
    protectedFiles: [inlineTextEdit?.frame, renamingFrame, nestLiveFile].filter((file): file is string => !!file),
    retainHidden: pendingEdits,
    retireHidden: (files) => {
      if (workspaceId) retireHiddenDesignFrames(workspaceId, snapshot?.directoryId, files);
    },
    geometry: () => new Map([...frameGeometryPreviewsRef.current]
      .filter(([key]) => key.startsWith(`${canvasDocumentOwner}\0`))
      .map(([key, preview]) => [key.slice(canvasDocumentOwner.length + 1), {
        x: preview.geometry.x, y: preview.geometry.y, width: preview.geometry.w, height: preview.geometry.h,
      }])),
  });
  const paintPendingWheelGesture = useCallback(() => {
    if (wheelPaintFrameRef.current !== null) {
      window.cancelAnimationFrame(wheelPaintFrameRef.current);
      wheelPaintFrameRef.current = null;
    }
    const latest = wheelViewportRef.current;
    if (!latest) return;
    paintDesignCanvasCamera(worldRef.current, latest, true);
    refreshFrameResidency("camera");
  }, [refreshFrameResidency]);
  useLayoutEffect(() => {
    const pending = wheelViewportRef.current;
    paintDesignCanvasCamera(
      worldRef.current,
      pending ?? { zoom: view.zoom, panX: view.panX, panY: view.panY },
      Boolean(pending),
      viewportSize,
    );
  }, [active, canvasDocumentOwner, folder, mountedFrames, view.panX, view.panY, view.zoom, viewportSize]);
  useLayoutEffect(() => active && worldRef.current ? observeDesignCanvasChrome(worldRef.current) : undefined,
    [active, canvasDocumentOwner]);
  const sourceSurfaceReady = useCallback((file: string, version: string) => {
    sourceSurfaceState.ready.set(file, version);
    refreshFrameResidency();
  }, [refreshFrameResidency, sourceSurfaceState]);
  const sourceSurfaceUnavailable = useCallback((file: string, version: string) => {
    sourceSurfaceState.ready.delete(file);
    sourceSurfaceState.unavailable.set(file, version);
    refreshFrameResidency();
  }, [refreshFrameResidency, sourceSurfaceState]);
  const sourceSurfaceRetired = useCallback((file: string, version: string) => {
    if (sourceSurfaceState.ready.get(file) === version) sourceSurfaceState.ready.delete(file);
  }, [sourceSurfaceState]);
  useDesignFramePreparation(workspaceId,
    [...(selectedDescription ? [selectedDescription.file] : []), ...liveFrameFiles, ...mountedFrames.map((frame) => frame.file)],
    active, snapshot?.preparation?.epoch);
  const admissionView = wheelViewportRef.current ?? view;
  // Only admitted/nearby surfaces demand pictures. Distant metadata stays
  // cheap until navigation makes its content useful.
  const previewItems = useMemo(
    () =>
      snapshot && viewportSize.width > 0 && viewportSize.height > 0
        ? designPreviewDemandItems({
            frames: mountedFrames.filter(isPreparedDesignFrame).filter(frame => !sourceFrameFiles.has(frame.file)),
            view: { zoom: admissionView.zoom, panX: admissionView.panX, panY: admissionView.panY },
            viewport: viewportSize,
            devicePixelRatio,
            live: liveFrameFiles,
          })
        : [],
    [admissionView.panX, admissionView.panY, admissionView.zoom, devicePixelRatio, liveFrameFiles, mountedFrames, sourceFrameFiles, snapshot, viewportSize],
  );
  const previewLevels = useMemo(() => {
    const levels = new Map<string, DesignPreviewLevel>();
    for (const item of previewItems) if (!levels.has(item.file)) levels.set(item.file, item.level);
    return levels;
  }, [previewItems]);
  const previewDemand = useMemo(
    () => activeDesignPreviewDemand(active, previewOwner, frameTheme, previewItems),
    [active, frameTheme, previewItems, previewOwner],
  );
  useDesignFramePreviewDemand(previewDemand);
  const highResolutionTiles = useMemo(() => {
    const result = new Map<string, DesignHighResolutionViewportTile>();
    if (
      !active ||
      view.zoom < HIGH_RESOLUTION_ZOOM_THRESHOLD ||
      viewportSize.width <= 0 ||
      viewportSize.height <= 0
    ) {
      return result;
    }
    const devicePixelRatio =
      typeof window === "undefined" ? 1 : window.devicePixelRatio;
    const candidates = preparedFrames
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
    preparedFrames,
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
    (
      frame: DesignFrameView | null,
      options?: { selected?: boolean; reveal?: boolean; explicit?: boolean; additive?: boolean },
    ) => {
      if (!workspaceId) return;
      void selectDesignFrame(workspaceId, frame, { ...options, owner: canvasPageOwner }).catch(
        (selectionError) => {
          toast.error("Couldn't update the design selection", {
            description: errorMessage(selectionError),
          });
        },
      );
    },
    [workspaceId, canvasPageOwner],
  );

  // The first authoritative fallback is a real activation too: publish it so
  // get_selection agrees with the inspector before the user clicks anything.
  // The user's frame-selected state survives snapshot republication verbatim.
  useEffect(() => {
    if (!active || !snapshot) return;
    if (view.selectedNodeId) return;
    publishSelection(selectedDescription ?? null, { selected: view.frameSelected, explicit: false });
  }, [
    active,
    publishSelection,
    selectedDescription,
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
      wheelBoundsRef.current = bounds;
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
    // Pane resize updates geometry outside the input path. Ancestor scrolling
    // and window movement invalidate it; the next input measures once before
    // any camera write. Settling also drops it, so a new gesture starts fresh.
    const invalidate = () => { wheelBoundsRef.current = null; };
    window.addEventListener("scroll", invalidate, true);
    window.addEventListener("resize", invalidate);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", invalidate, true);
      window.removeEventListener("resize", invalidate);
      wheelBoundsRef.current = null;
    };
  }, [active]);

  /** Fit a stable frame set from current DOM bounds without awaiting data. */
  const fitFrames = useCallback(
    (frames: readonly DesignFrameView[]) => {
      if (!workspaceId || frames.length === 0) return;
      if (canvasPageOwner && !isCurrentDesignPageOwner(canvasPageOwner)) return;
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
        undefined,
        measureDesignCanvasInsets(viewportRef.current),
      );
      if (!next) return;
      // Toolbar intent wins over any wheel burst that has painted but not yet
      // settled into the store; otherwise its old timer snaps the canvas back.
      cancelPendingWheelGesture();
      paintDesignCanvasCamera(worldRef.current, next, false);
      setViewport(workspaceId, next, canvasPageOwner);
    },
    [cancelPendingWheelGesture, setViewport, workspaceId, canvasPageOwner],
  );

  /** Zoom about a screen point so the content beneath it does not jump. */
  const zoomAt = useCallback(
    (
      nextZoom: number | ((currentZoom: number) => number),
      point?: { x: number; y: number },
    ) => {
      if (!workspaceId || (canvasPageOwner && !isCurrentDesignPageOwner(canvasPageOwner))) return;
      const bounds = viewportRef.current?.getBoundingClientRect();
      if (!bounds) return;
      // Menu and keyboard zoom keep the centre of the visible canvas still.
      let anchor = point;
      if (!anchor) {
        const safe = designSafeViewportRect(
          { width: bounds.width, height: bounds.height },
          measureDesignCanvasInsets(viewportRef.current),
        );
        anchor = { x: safe.x + safe.width / 2, y: safe.y + safe.height / 2 };
      }
      const current = wheelViewportRef.current ?? view;
      const targetZoom =
        typeof nextZoom === "function" ? nextZoom(current.zoom) : nextZoom;
      const next = zoomDesignViewportAtPoint(current, targetZoom, anchor);
      cancelPendingWheelGesture();
      paintDesignCanvasCamera(worldRef.current, next, false);
      setViewport(workspaceId, next, canvasPageOwner);
    },
    [cancelPendingWheelGesture, setViewport, view, workspaceId, canvasPageOwner],
  );

  // Fit an unvisited page when no frame is visible. Saved page cameras and
  // later visits belong to the user; legacy root canvases retain open fitting.
  const openFitOwnersRef = useRef(new Set<string>());
  const rememberedPagesRef = useRef({
    directoryId: view.directoryId,
    views: view.byPage,
  });
  useLayoutEffect(() => {
    if (!active || !workspaceId || !snapshot) return;
    if (viewportSize.width <= 0 || viewportSize.height <= 0) return;
    if (openFitOwnersRef.current.has(canvasDocumentOwner)) return;
    openFitOwnersRef.current.add(canvasDocumentOwner);
    if (openFitOwnersRef.current.size > 64)
      openFitOwnersRef.current.delete(
        openFitOwnersRef.current.values().next().value!,
      );
    if (
      snapshot.pages?.some((page) => page.folder) &&
      view.activePageId &&
      rememberedPagesRef.current.directoryId === canvasDirectoryId &&
      Object.hasOwn(rememberedPagesRef.current.views ?? {}, view.activePageId)
    )
      return;
    const rects = frameViews.map((frame) => ({
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
    }));
    if (
      !designViewportShowsAnyRect(
        view,
        viewportSize,
        rects,
        measureDesignCanvasInsets(viewportRef.current),
      )
    )
      fitFrames(frameViews);
  }, [
    active,
    fitFrames,
    frameViews,
    canvasDocumentOwner,
    canvasDirectoryId,
    snapshot,
    view,
    viewportSize,
    workspaceId,
  ]);

  // Selecting a frame the user cannot see (from Layers, keyboard navigation or
  // history) brings it into view. A frame already on screen never moves.
  const revealedFrameRef = useRef<{
    owner: string;
    file: string | null;
    event: number | undefined;
  } | null>(null);
  useLayoutEffect(() => {
    const file = selectedDescription?.file ?? null;
    const event = view.selectionEvent;
    const previous = revealedFrameRef.current;
    revealedFrameRef.current = { owner: liveFrameOwner, file, event };
    // The selection an owner opens with restores a session; it does not ask
    // the camera to move.
    if (!previous || previous.owner !== liveFrameOwner) return;
    // Only a person's own choice moves the camera. A frame chosen for them
    // when theirs left the page (nested into another, deleted) stays put.
    if (!active || !workspaceId || !selectedDescription || previous.file === file || previous.event === event)
      return;
    const next = designRevealRectViewport(
      view,
      viewportSize,
      {
        x: selectedDescription.x,
        y: selectedDescription.y,
        width: selectedDescription.width,
        height: selectedDescription.height,
      },
      undefined,
      measureDesignCanvasInsets(viewportRef.current),
    );
    if (!next) return;
    cancelPendingWheelGesture();
    paintDesignCanvasCamera(worldRef.current, next, false);
    setViewport(workspaceId, next, canvasPageOwner);
    // Only a change of frame reveals; the camera and size are read at it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, liveFrameOwner, selectedDescription?.file, view.selectionEvent, workspaceId]);

  /** Show what an agent is writing without selecting it: one frame comes
   * into view like a Layers selection, several are fitted, and a frame on
   * another page switches to that page first. */
  const pendingAgentRevealRef = useRef<DesignAgentRevealTarget | null>(null);
  const revealAgentRects = useCallback(
    (rects: readonly { x: number; y: number; width: number; height: number }[]) => {
      if (!workspaceId || rects.length === 0) return;
      if (canvasPageOwner && !isCurrentDesignPageOwner(canvasPageOwner)) return;
      const bounds = viewportRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const size = { width: bounds.width, height: bounds.height };
      const insets = measureDesignCanvasInsets(viewportRef.current);
      const current = wheelViewportRef.current ?? view;
      const next =
        rects.length === 1
          ? designRevealRectViewport(current, size, rects[0]!, undefined, insets)
          : fitDesignRects([...rects], size, undefined, insets);
      if (!next) return;
      cancelPendingWheelGesture();
      paintDesignCanvasCamera(worldRef.current, next, false);
      setViewport(workspaceId, next, canvasPageOwner);
    },
    [cancelPendingWheelGesture, canvasPageOwner, setViewport, view, workspaceId],
  );
  const agentRevealRects = useCallback(
    (target: DesignAgentRevealTarget) => [
      ...frameViews
        .filter((frame) => target.files.includes(frame.file))
        .map((frame) => ({ x: frame.x, y: frame.y, width: frame.width, height: frame.height })),
      ...target.rects,
    ],
    [frameViews],
  );
  const revealAgentTarget = useCallback(
    (target: DesignAgentRevealTarget) => {
      if (!workspaceId) return;
      if (target.pageId && view.activePageId && target.pageId !== view.activePageId) {
        pendingAgentRevealRef.current = target;
        useDesignWorkspaceUiStore
          .getState()
          .setActivePage(workspaceId, target.pageId, canvasDirectoryId);
        return;
      }
      pendingAgentRevealRef.current = null;
      revealAgentRects(agentRevealRects(target));
    },
    [agentRevealRects, canvasDirectoryId, revealAgentRects, view.activePageId, workspaceId],
  );
  // The switched-to page's frames arrive with its projection.
  useLayoutEffect(() => {
    const pending = pendingAgentRevealRef.current;
    if (!active || !pending || pending.pageId !== view.activePageId) return;
    const rects = agentRevealRects(pending);
    if (rects.length === 0) return;
    pendingAgentRevealRef.current = null;
    revealAgentRects(rects);
  }, [active, agentRevealRects, revealAgentRects, view.activePageId]);

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
   * can flash before a second resize write. The new frame's editor boots at
   * once and the frame is selected when it reports (bounded), so the
   * inspector moves straight to its full properties; the drawn rectangle
   * covers the canvas until the frame paints. */
  const createFrame = useCallback(
    async (geometry?: DesignFrameGeometryWire) => {
      if (!workspaceId || creatingFrameRef.current) return null;
      creatingFrameRef.current = true;
      setCreatingFrame(true);
      const selectionBefore = designWorkspaceView(workspaceId);
      let created: DesignCanvasFrameWire | null = null;
      try {
        const result = await createDesignFrameAndRefresh(
          workspaceId,
          undefined,
          geometry,
          undefined,
          canvasPageOwner?.pageId,
        );
        created = result.snapshot.frames.find(
          (frame) => frame.file === result.frame.file,
        ) ?? null;
        if (canvasPageOwner && !isCurrentDesignPageOwner(canvasPageOwner)) return null;
      } catch (createError) {
        toast.error("Couldn't create a design frame", {
          description: errorMessage(createError),
        });
        return null;
      } finally {
        creatingFrameRef.current = false;
        setCreatingFrame(false);
      }
      if (!created) return null;
      const frame = created;
      if (!geometry) fitFrames([frame]);
      primeDesignFrameIntent(workspaceId, frame.file);
      void waitForDesignRuntimeFrame(workspaceId, frame.file, frame.sourceVersion, 1_000).then(() => {
        if (canvasPageOwner && !isCurrentDesignPageOwner(canvasPageOwner)) return;
        // Any selection the person made meanwhile wins over the creation's,
        // including choosing the same target again or clearing it.
        if (!designSelectionUnchangedSince(workspaceId, selectionBefore)) return;
        publishSelection(frame, { selected: true, reveal: true });
      });
      return frame;
    },
    [fitFrames, publishSelection, workspaceId, canvasPageOwner],
  );

  /** Title edits are surgical source splices; filenames remain Git-stable. */
  /** Enter and blur both finish a rename; Escape cancels it. One gesture is
   * one write however many of those events reach the field. */
  const renameSettledRef = useRef(false);
  const commitRename = useCallback(
    async (frame: DesignCanvasFrameWire) => {
      if (renameSettledRef.current) return;
      renameSettledRef.current = true;
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
      if (canvasPageOwner && !isCurrentDesignPageOwner(canvasPageOwner)) return;
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
              { owner: canvasPageOwner },
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
          runtime: edit.runtime,
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
                    ...frameViews.map((frame) => frame.z + 1),
                  ),
                ),
              },
              {
                kind: "text",
                nodeId: edit.nodeId,
                text: draft,
                fixedSize: edit.width !== undefined,
              },
              canvasPageOwner?.pageId,
            );
            const created = result.snapshot.frames.find(
              (frame) => frame.file === result.frame.file,
            );
            if (!created) {
              throw new Error("The created canvas text is unavailable.");
            }
            useDesignWorkspaceUiStore
              .getState()
              .setSelection(workspaceId, created.file, edit.nodeId, undefined, { owner: canvasPageOwner });
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
            (!canvasPageOwner || isCurrentDesignPageOwner(canvasPageOwner)) &&
            currentSelection.selectedFrame === edit.frame &&
            currentSelection.selectedNodeId === null;
          if (editorStillOwnsSelection) {
            useDesignWorkspaceUiStore
              .getState()
              .setSelection(workspaceId, edit.frame, edit.nodeId, undefined, { owner: canvasPageOwner });
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
            runtime: edit.runtime,
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
    [frameViews, workspaceId, canvasPageOwner],
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
        runtime: workspaceId ? designFrameRuntime(workspaceId, frame.file) : null,
        frame: frame.file,
        nodeId: details.oid,
        sourceVersion: frame.sourceVersion,
        initialText,
        whiteSpace: details.styles.whiteSpace ?? "normal",
        status: "editing",
        initialDetails: details,
      });
    },
    [activateTool, workspaceId],
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
        runtime: edit.runtime,
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
            runtime: pending.edit.runtime,
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
      // Escape cancels a draft, not a transaction that already started. Keep
      // its glyph owner through the displayed-buffer handoff. The guard also
      // covers Escape arriving before React publishes the committing state.
      const key = `${edit.frame ?? "canvas"}\u0000${edit.nodeId}\u0000${edit.sourceVersion ?? "draft"}`;
      if (edit.status !== "editing" || textCommitGuardRef.current.activeKey === key) return;
      cancelInlineTextCommit(textCommitGuardRef.current, edit);
      if (inlineTextPreviewRef.current.pending?.edit.id === edit.id) {
        inlineTextPreviewRef.current.pending = null;
      }
      if (workspaceId && edit.kind === "existing") {
        void clearDesignNodeTextPreviewTransient({
          workspaceId,
          frame: edit.frame,
          sourceVersion: edit.sourceVersion,
          runtime: edit.runtime,
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
            { owner: canvasPageOwner },
          );
        } else {
          store.setSelectedFrame(workspaceId, null, canvasPageOwner);
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
    [activateTool, workspaceId, canvasPageOwner],
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

  const duplicateSelectedNode = useCallback(
    async (duplicateMode: "copy" | "duplicate" = "duplicate") => {
      if (!workspaceId || !folder) return;
      try {
        const save = applyDesignNodeAction({ workspaceId, folder, action: "duplicate", copy: duplicateMode === "copy" });
        savedEditingSession?.retain(save);
        await save;
      } catch (error) {
        toast.error(duplicateMode === "copy" ? "Couldn't copy the element" : "Couldn't duplicate the element", { description: errorMessage(error) });
      }
    },
    [workspaceId, folder, savedEditingSession],
  );

  const duplicateSelectedFrame = useCallback(
    async (duplicateMode: "copy" | "duplicate" = "duplicate") => {
      if (!workspaceId) return;
      const selected = designWorkspaceView(workspaceId);
      const frame = designFrameViews(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data).find(candidate => candidate.file === selected.selectedFrame);
      if (!frame) return;
      if (frameActionPendingRef.current >= 256) {
        toast.error("Let the pending copies finish before adding more");
        return;
      }
      const owner = captureDesignPageOwner(workspaceId);
      const intent = ++frameActionIntentRef.current;
      frameActionPendingRef.current++;
      const save = duplicateDesignFrameCached(workspaceId, frame.file, owner.pageId);
      const pending = { owner, selectionEvent: selected.selectionEvent, frame: frame.file,
        result: save.then(result => result.snapshot.frames.find(candidate => candidate.file === result.frame.file) ?? null) };
      pendingFrameCopyRef.current = pending;
      try {
        savedEditingSession?.retain(save);
        const duplicate = await pending.result;
        if (frameActionIntentRef.current !== intent || !isCurrentDesignPageOwner(owner) || designWorkspaceView(workspaceId).selectionEvent !== selected.selectionEvent) return;
        if (duplicate) void selectDesignFrame(workspaceId, duplicate, { selected: true, reveal: true, owner }).catch(() => {});
      } catch (error) {
        toast.error(duplicateMode === "copy" ? "Couldn't copy the frame" : "Couldn't duplicate the frame", { description: errorMessage(error) });
      } finally {
        frameActionPendingRef.current--;
        if (pendingFrameCopyRef.current === pending) pendingFrameCopyRef.current = null;
      }
    },
    [workspaceId, savedEditingSession],
  );

  const deleteSelectedFrame = useCallback(async (frame: DesignCanvasFrameWire) => {
    const pending = pendingFrameCopyRef.current;
    if (workspaceId && pending?.frame === frame.file && isCurrentDesignPageOwner(pending.owner) &&
      pending.selectionEvent === designWorkspaceView(workspaceId).selectionEvent) {
      // Delete follows the latest copy command even before its file exists.
      // A fresh explicit selection of the original retires that follow intent.
      frameActionIntentRef.current++;
      pendingFrameCopyRef.current = null;
      useDesignWorkspaceUiStore.getState().setSelection(workspaceId, frame.file, null, undefined, { owner: pending.owner });
      const copy = await pending.result.catch(() => null);
      if (copy && isCurrentDesignPageOwner(pending.owner)) await onDeleteFrame(copy);
      return;
    }
    await onDeleteFrame(frame);
  }, [workspaceId, onDeleteFrame]);

  const deleteSelectedNode = useCallback(async () => {
    if (!workspaceId || !folder) return;
    const selected = designWorkspaceView(workspaceId);
    const frame = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames.find(candidate => candidate.file === selected.selectedFrame);
    if (frame?.kind === "text") {
      await deleteSelectedFrame(frame);
      return;
    }
    try {
      const save = applyDesignNodeAction({ workspaceId, folder, action: "delete" });
      savedEditingSession?.retain(save);
      await save;
    } catch (error) {
      toast.error("Couldn't delete the element", { description: errorMessage(error) });
    }
  }, [workspaceId, folder, deleteSelectedFrame, savedEditingSession]);

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
        !motionNodeDetails
      ) {
        return;
      }
      await previewDesignNodeMotionTransient({
        workspaceId,
        frame: selectedFrame.file,
        sourceVersion: selectedFrame.sourceVersion,
        nodeId: motionNodeDetails.oid,
        motion: designMotionPreviewInput(draft, currentTime, playing),
      });
    },
    [motionTimelineOpen, selectedFrame, motionNodeDetails, workspaceId],
  );

  const clearMotionPreview = useCallback(async () => {
    if (!workspaceId || !selectedFrame || !motionNodeDetails) return;
    await clearDesignNodeStylePreviewTransient({
      workspaceId,
      frame: selectedFrame.file,
      sourceVersion: selectedFrame.sourceVersion,
      nodeId: motionNodeDetails.oid,
    });
  }, [selectedFrame, motionNodeDetails, workspaceId]);

  const saveMotion = useCallback(
    async (draft: DesignMotionTimelineDraft) => {
      const foundation = canvasFoundation.data;
      if (
        !workspaceId ||
        !selectedFrame ||
        !motionNodeDetails ||
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
            nodeId: motionNodeDetails.oid,
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
    [canvasFoundation.data, selectedFrame, motionNodeDetails, workspaceId],
  );

  const deleteMotion = useCallback(async () => {
    const foundation = canvasFoundation.data;
    if (!workspaceId || !selectedFrame || !motionNodeDetails || !foundation) {
      throw new Error("The selected element is not ready for motion editing.");
    }
    await applyDesignTransactionCached(workspaceId, selectedFrame.file, {
      schemaVersion: 1,
      transactionId: `desktop:${crypto.randomUUID()}`,
      documentId: foundation.summary.documentId,
      baseRevision: foundation.summary.revision,
      actor: { kind: "human", id: "desktop" },
      intent: `Remove motion from ${motionNodeDetails.name}`,
      createdAt: Date.now(),
      operations: [
        {
          operationId: `animation:${crypto.randomUUID()}`,
          type: "node.set-styles",
          nodeId: motionNodeDetails.oid,
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
  }, [canvasFoundation.data, selectedFrame, motionNodeDetails, workspaceId]);

  // Arrow keys on several selected frames move them together, in the nudge
  // lifecycle of one frame: presses while the key is held land as one canvas
  // write and one undo step on release; Escape, leaving the window and a page
  // or selection change restore them; presses during a save wait for it.
  const nudgeSelectedFrames = useCallback(
    (files: readonly string[], deltaX: number, deltaY: number): boolean => {
      const viewport = viewportRef.current;
      if (!workspaceId || !selectedFrame || !viewport) return false;
      const selection = designWorkspaceView(workspaceId);
      const selectionKey = [...files].sort().join("\0");
      const previous = nudgeGestureRef.current;
      if (previous && (previous.mode !== "frames" || previous.selectionKey !== selectionKey ||
        !isCurrentDesignPageOwner(previous.owner) || previous.selectionEvent !== selection.selectionEvent)) {
        previous.retired = true;
        return true;
      }
      let gesture = previous?.mode === "frames" ? previous : null;
      if (!gesture) {
        const confirmed = designFrameViews(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data);
        const members = files.flatMap((file) => {
          const frame = confirmed.find((candidate) => candidate.file === file);
          const element = frameElementsRef.current.get(file) ?? null;
          const key = `${canvasDocumentOwner}\0${file}`;
          return frame && !frameGeometryPreviewsRef.current.has(key)
            ? [{ file, key, start: frameGeometry(frame), element, preview: { geometry: frameGeometry(frame), settled: false } }]
            : [];
        });
        // A deleted frame or pending move keeps the whole selection in place.
        // Offscreen members move from metadata without needing DOM residency.
        if (members.length !== files.length) return true;
        gesture = {
          mode: "frames", frame: selectedFrame, selectionKey, members, dx: 0, dy: 0,
          owner: captureDesignPageOwner(workspaceId), selectionEvent: selection.selectionEvent,
          lifetime: nudgeLifetimeRef.current, canvasLifetime: canvasLifetimeRef.current, retired: false,
          runtime: null, runtimeRevision: undefined, theme: selection.activeTheme,
        };
      }
      const current = gesture;
      current.dx += deltaX;
      current.dy += deltaY;
      for (const member of current.members) {
        member.preview.geometry = {
          ...member.start,
          x: Math.max(-DESIGN_FRAME_COORDINATE_LIMIT, Math.min(DESIGN_FRAME_COORDINATE_LIMIT, member.start.x + current.dx)),
          y: Math.max(-DESIGN_FRAME_COORDINATE_LIMIT, Math.min(DESIGN_FRAME_COORDINATE_LIMIT, member.start.y + current.dy)),
        };
        frameGeometryPreviewsRef.current.set(member.key, member.preview);
        member.element = frameElementsRef.current.get(member.file) ?? null;
        if (member.element) paintFrameGeometry(member.element, member.preview.geometry);
      }
      nudgeGestureRef.current = current;
      refreshFrameResidency();
      return true;
    },
    [canvasDocumentOwner, selectedFrame, workspaceId, refreshFrameResidency],
  );

  const nudgeSelectedNode = useCallback(
    (deltaX: number, deltaY: number) => {
      if (!workspaceId || !selectedFrame) return false;
      if (gestureCancelRef.current) return true;
      const selection = designWorkspaceView(workspaceId);
      if (nudgeCommitRef.current || queuedNudgeRef.current) {
        const previous = queuedNudgeRef.current;
        const queued = previous && previous.selectionEvent === selection.selectionEvent && previous.lifetime === nudgeLifetimeRef.current && previous.frame === selectedFrame.file && previous.theme === selection.activeTheme && isCurrentDesignPageOwner(previous.owner) ? previous : {
          owner: captureDesignPageOwner(workspaceId), frame: selectedFrame.file,
          selectionEvent: selection.selectionEvent, lifetime: nudgeLifetimeRef.current, theme: selection.activeTheme,
          frames: selection.selectedTargets.every((target) => !target.nodeId) &&
            selection.selectedTargets.some((target) => target.frame !== selectedFrame.file),
          dx: 0, dy: 0, released: false,
        };
        queued.dx += deltaX;
        queued.dy += deltaY;
        queued.released = false;
        queuedNudgeRef.current = queued;
        return true;
      }
      const roots = designSelectionMutationTargets(selection.selectedTargets, new Map([[selectedFrame.file, selectedRuntimeTree]]));
      if (!roots.length) return false;
      if (roots.some((target) => target.frame !== selectedFrame.file)) {
        if (roots.every((target) => !target.nodeId))
          return nudgeSelectedFrames(roots.map((target) => target.frame), deltaX, deltaY);
        toast.error("Move frames or layers, not both", { description: "Select only frames, or layers in one frame, to move them together. Nothing was moved." });
        return true;
      }
      const runtime = designFrameRuntime(workspaceId, selectedFrame.file);
      if (!runtime || runtime.sourceVersion !== selectedFrame.sourceVersion) {
        toast.error("Wait for the selected scene to finish loading");
        return true;
      }
      const previous = nudgeGestureRef.current;
      if (previous && (previous.frame.sourceVersion !== selectedFrame.sourceVersion || !isCurrentDesignPageOwner(previous.owner) || previous.selectionEvent !== selection.selectionEvent)) {
        previous.retired = true;
        return true;
      }
      const runtimeState = useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[selectedFrame.file];
      const context = { owner: captureDesignPageOwner(workspaceId), selectionEvent: selection.selectionEvent, lifetime: nudgeLifetimeRef.current, canvasLifetime: canvasLifetimeRef.current, retired: false, runtime, runtimeRevision: runtimeState?.snapshot?.revision, theme: selection.activeTheme };
      if (roots.some((target) => !target.nodeId)) {
        const element = viewportRef.current?.querySelector<HTMLElement>(`[data-design-frame="${CSS.escape(selectedFrame.file)}"]`);
        if (!element) return false;
        const current = nudgeGestureRef.current;
        const gesture: NonNullable<typeof nudgeGestureRef.current> = current?.mode === "frame" && current.frame.file === selectedFrame.file && current.selectionEvent === selection.selectionEvent
          ? current : { mode: "frame" as const, frame: selectedFrame, element, preview: { geometry: frameGeometry(selectedFrame), settled: false }, dx: 0, dy: 0, ...context };
        gesture.dx += deltaX;
        gesture.dy += deltaY;
        gesture.preview.geometry = { ...frameGeometry(gesture.frame), x: Math.max(-DESIGN_FRAME_COORDINATE_LIMIT, Math.min(DESIGN_FRAME_COORDINATE_LIMIT, gesture.frame.x + gesture.dx)), y: Math.max(-DESIGN_FRAME_COORDINATE_LIMIT, Math.min(DESIGN_FRAME_COORDINATE_LIMIT, gesture.frame.y + gesture.dy)) };
        frameGeometryPreviewsRef.current.set(`${canvasDocumentOwner}\0${gesture.frame.file}`, gesture.preview);
        paintFrameGeometry(element, gesture.preview.geometry);
        nudgeGestureRef.current = gesture;
        return true;
      }
      if (!selectedNodeDetails) return false;
      if (roots.length > 1) {
        const known = new Set<string>();
        const pending = [...selectedRuntimeTree];
        while (pending.length) { const node = pending.pop()!; known.add(node.oid); pending.push(...node.children); }
        if (runtimeState?.sourceVersion !== selectedFrame.sourceVersion || selection.selectedTargets.some((target) => target.nodeId && !known.has(target.nodeId))) {
          toast.error("The selected ancestry is not ready", { description: "Nothing was moved; select fewer layers or wait for this scene to refresh." });
          return true;
        }
      }
      const topLevelIds = roots.flatMap((target) => target.nodeId ? [target.nodeId] : []);
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
              },
            ]
          : [];
      });
      if (nodes.length !== topLevelIds.length || nodes.some((node) => node.details.sourceVersion !== selectedFrame.sourceVersion)) {
        toast.error("Wait for the selected layers to finish loading", { description: "Nothing was moved." });
        return true;
      }
      const selectionKey = nodes.map((node) => node.nodeId).join("\u0000");
      const current = nudgeGestureRef.current;
      const gesture: NonNullable<typeof nudgeGestureRef.current> =
        current?.mode === "move" &&
        current.frame.file === selectedFrame.file &&
        current.selectionKey === selectionKey &&
        current.selectionEvent === selection.selectionEvent
          ? current
          : {
              mode: "move" as const,
              frame: selectedFrame,
              selectionKey,
              nodes,
              dx: 0,
              dy: 0,
              ...context,
            };
      gesture.dx += deltaX;
      gesture.dy += deltaY;
      let updates;
      try {
        updates = gesture.nodes.map((node) => ({ nodeId: node.nodeId, styles: designNodeMovementStyles(node.details, { x: gesture.dx, y: gesture.dy }) }));
      } catch (error) {
        toast.error("This selection cannot be moved safely", { description: errorMessage(error) });
        return true;
      }
      nudgeGestureRef.current = gesture;
      setSelectionOverlaySuppressed(true);
      gesture.pending = Promise.all([
        gesture.pending,
        ...updates.map((node) =>
          previewDesignNodeStylesTransient({
            workspaceId,
            frame: gesture.frame.file,
            sourceVersion: gesture.frame.sourceVersion,
            nodeId: node.nodeId,
            styles: node.styles,
          }),
        ),
      ]).catch(() => {});
      return true;
    },
    [
      selectedFrame,
      selectedNodeDetails,
      selectedNodeDetailsList,
      selectedRuntimeTree,
      canvasDocumentOwner,
      nudgeSelectedFrames,
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
      const gesture: NonNullable<typeof nudgeGestureRef.current> =
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
              owner: captureDesignPageOwner(workspaceId),
              selectionEvent: designWorkspaceView(workspaceId).selectionEvent,
              lifetime: nudgeLifetimeRef.current,
              canvasLifetime: canvasLifetimeRef.current,
              retired: false,
              runtime: designFrameRuntime(workspaceId, selectedFrame.file),
              runtimeRevision: useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[selectedFrame.file]?.snapshot?.revision,
              theme: designWorkspaceView(workspaceId).activeTheme,
            };
      gesture.dw += deltaWidth;
      gesture.dh += deltaHeight;
      nudgeGestureRef.current = gesture;
      setSelectionOverlaySuppressed(true);
      gesture.pending = previewDesignNodeStylesTransient({
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

  const finishNodeNudge = useCallback((cancelled = false) => {
    if (cancelled) queuedNudgeRef.current = null;
    else if (queuedNudgeRef.current) queuedNudgeRef.current.released = true;
    const gesture = nudgeGestureRef.current;
    nudgeGestureRef.current = null;
    if (!gesture || !workspaceId) {
      setSelectionOverlaySuppressed(false);
      return;
    }
    gesture.retired ||= cancelled || gesture.lifetime !== nudgeLifetimeRef.current || designWorkspaceView(workspaceId).selectionEvent !== gesture.selectionEvent;
    // Several frames move by canvas geometry alone; one frame's guarded move
    // and layer edits need the live document they previewed in.
    const isCurrent = () => !gesture.retired && gesture.canvasLifetime === canvasLifetimeRef.current &&
      isCurrentDesignPageOwner(gesture.owner) &&
      (gesture.mode === "frames" || (
        designWorkspaceView(workspaceId).activeTheme === gesture.theme &&
        gesture.runtime?.isActive?.() === true &&
        designFrameRuntime(workspaceId, gesture.frame.file) === gesture.runtime &&
        useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[gesture.frame.file]?.snapshot?.revision === gesture.runtimeRevision));
    const frameKey = `${canvasDocumentOwner}\0${gesture.frame.file}`;
    const restore = async () => {
      if (gesture.mode === "frames") {
        const confirmed = designFrameViews(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data);
        for (const member of gesture.members) {
          if (frameGeometryPreviewsRef.current.get(member.key) !== member.preview) continue;
          frameGeometryPreviewsRef.current.delete(member.key);
          const frame = confirmed?.find((candidate) => candidate.file === member.file);
          member.element = frameElementsRef.current.get(member.file) ?? null;
          if (member.element?.isConnected && isCurrentDesignPageOwner(gesture.owner))
            paintFrameGeometry(member.element, frame ? frameGeometry(frame) : member.start);
        }
        refreshFrameResidency();
      } else if (gesture.mode === "frame") {
        if (frameGeometryPreviewsRef.current.get(frameKey) !== gesture.preview) return;
        frameGeometryPreviewsRef.current.delete(frameKey);
        const confirmed = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames.find((frame) => frame.file === gesture.frame.file);
        if (gesture.element.isConnected && isCurrentDesignPageOwner(gesture.owner)) paintFrameGeometry(gesture.element, frameGeometry(confirmed ?? gesture.frame));
      } else if (!nudgeGestureRef.current && !gestureCancelRef.current && gesture.runtime &&
        designFrameRuntime(workspaceId, gesture.frame.file) === gesture.runtime && gesture.runtime.sourceVersion === gesture.frame.sourceVersion) {
        const ids = gesture.mode === "move" ? gesture.nodes.map((node) => node.nodeId) : [gesture.nodeId];
        await Promise.all(ids.map((nodeId) => {
          clearDesignLivePreview(workspaceId, gesture.frame.file, nodeId);
          return gesture.runtime!.clearPreviewStyles(nodeId).catch(() => {});
        }));
      }
    };
    const pending = (async () => {
      await gesture.pending;
      if (!isCurrent() || (gesture.mode !== "resize" && gesture.dx === 0 && gesture.dy === 0)) {
        if (isCurrent() && queuedNudgeRef.current) queuedNudgeRef.current.sourceVersion = gesture.frame.sourceVersion;
        await restore();
        return;
      }
      if (gesture.mode === "frames") {
        const moved = await moveDesignFramesCached(workspaceId, gesture.members.map((member) => ({
          frame: member.file, from: member.start, to: member.preview.geometry,
        })));
        const queued = queuedNudgeRef.current;
        if (queued) queued.sourceVersion = moved.frames.find((frame) => frame.file === queued.frame)?.sourceVersion;
        await restore();
        return;
      }
      const updates = gesture.mode === "frame" ? [] : gesture.mode === "move"
        ? gesture.nodes.map((node) => ({ nodeId: node.nodeId, styles: designNodeMovementStyles(node.details, { x: gesture.dx, y: gesture.dy }) }))
        : [{ nodeId: gesture.nodeId, styles: preserveDesignLayoutPins(gesture.details, { width: `${Math.max(1, Math.round(gesture.width + gesture.dw))}px`, height: `${Math.max(1, Math.round(gesture.height + gesture.dh))}px` }) }];
      const operations: DesignOperation[] = gesture.mode === "frame"
        ? [{ operationId: crypto.randomUUID(), type: "frame.set-geometry", frame: gesture.frame.file, geometry: { x: gesture.preview.geometry.x, y: gesture.preview.geometry.y, width: gesture.preview.geometry.w, height: gesture.preview.geometry.h, z: gesture.preview.geometry.z } }]
        : updates.map((update) => ({ operationId: crypto.randomUUID(), type: "node.set-styles", nodeId: update.nodeId, styles: update.styles, scope: "auto", responsiveContext: "base", stateContext: "default" }));
      const result = await applyDesignEditCached(workspaceId, gesture.frame, { schemaVersion: 1, transactionId: `desktop:${crypto.randomUUID()}`, actor: { kind: "human", id: "desktop" }, intent: gesture.mode === "frame" ? "Move canvas frame" : `Move ${updates.length} selected layers`, createdAt: Date.now(), operations }, {
        movementGuard: { sourceVersion: gesture.frame.sourceVersion, geometry: frameGeometry(gesture.frame) },
        isCurrent,
      });
      const queued = queuedNudgeRef.current;
      if (queued) queued.sourceVersion = result.snapshot?.frames.find((frame) => frame.file === queued.frame)?.sourceVersion;
      if (gesture.mode === "frame") await restore();
    })().catch(async (error) => {
      queuedNudgeRef.current = null;
      await restore();
      if (isCurrent()) toast.error("Couldn't move the selection", { description: errorMessage(error) });
    }).finally(() => {
      if (nudgeCommitRef.current === pending) nudgeCommitRef.current = null;
      if (!nudgeGestureRef.current) setSelectionOverlaySuppressed(false);
      setNudgeCommitVersion((version) => version + 1);
    });
    nudgeCommitRef.current = pending;
    savedEditingSession?.retain(pending);
  }, [workspaceId, canvasDocumentOwner, savedEditingSession, refreshFrameResidency]);

  useEffect(() => {
    const queued = queuedNudgeRef.current;
    if (!queued || nudgeCommitRef.current || !workspaceId) return;
    const selection = designWorkspaceView(workspaceId);
    if (!active || !isCurrentDesignPageOwner(queued.owner) || queued.lifetime !== nudgeLifetimeRef.current ||
      queued.selectionEvent !== selection.selectionEvent || queued.theme !== selection.activeTheme ||
      !queued.sourceVersion || selectedFrame?.file !== queued.frame || selectedFrame.sourceVersion !== queued.sourceVersion) {
      queuedNudgeRef.current = null;
      return;
    }
    if (!queued.frames && (designFrameRuntime(workspaceId, queued.frame)?.sourceVersion !== queued.sourceVersion ||
      (selection.selectedTargets.some((target) => target.nodeId) &&
        selection.selectedTargets.some((target) => target.nodeId && !selectedNodeDetailsList.some((details) => details.oid === target.nodeId && details.sourceVersion === queued.sourceVersion))))) return;
    queuedNudgeRef.current = null;
    nudgeSelectedNode(queued.dx, queued.dy);
    if (queued.released) finishNodeNudge();
  }, [active, workspaceId, nudgeCommitVersion, selectedFrame, selectedNodeDetailsList, nudgeSelectedNode, finishNodeNudge]);

  /** Move/resize previews paint one node; release publishes one engine write. */
  /** Several selected frames follow the pointer together, snap as one box
   * and commit in one canvas write and one undo step. */
  const startFrameGroupMove = useCallback(
    (event: React.PointerEvent<HTMLElement>, files: readonly string[]) => {
      const viewport = viewportRef.current;
      if (!workspaceId || !viewport) return;
      const confirmed = designFrameViews(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data ?? snapshot);
      const wanted = new Set(files);
      const members = confirmed
        .filter((frame) => wanted.has(frame.file))
        .map((frame) => ({
          frame,
          key: `${canvasDocumentOwner}\0${frame.file}`,
          start: frameGeometry(frame),
          element: frameElementsRef.current.get(frame.file) ?? null,
        }));
      if (members.length < 2 || members.length !== wanted.size) return;
      // A previous move of one of these frames is still being saved; its
      // confirmed geometry is what this move must start from.
      if (members.some((member) => frameGeometryPreviewsRef.current.has(member.key))) {
        toast.error("Wait for the last move to finish", {
          description: "Nothing was moved.",
        });
        return;
      }
      const pageOwner = captureDesignPageOwner(workspaceId);
      const selectionEvent = designWorkspaceView(workspaceId).selectionEvent;
      const lifetime = ++nudgeLifetimeRef.current;
      const canvasLifetime = canvasLifetimeRef.current;
      let completed = false;
      const ownerIsCurrent = () =>
        canvasDocumentOwnerRef.current === canvasDocumentOwner &&
        designWorkspaceView(workspaceId).directoryId === canvasDirectoryId &&
        isCurrentDesignPageOwner(pageOwner) &&
        canvasLifetimeRef.current === canvasLifetime &&
        (completed ||
          (nudgeLifetimeRef.current === lifetime &&
            designWorkspaceView(workspaceId).selectionEvent === selectionEvent));
      const left = Math.min(...members.map((member) => member.start.x));
      const top = Math.min(...members.map((member) => member.start.y));
      const box = {
        x: left,
        y: top,
        width: Math.max(...members.map((member) => member.start.x + member.start.w)) - left,
        height: Math.max(...members.map((member) => member.start.y + member.start.h)) - top,
      };
      const peers = confirmed
        .filter((frame) => !wanted.has(frame.file))
        .map((frame) => ({ x: frame.x, y: frame.y, width: frame.width, height: frame.height }));
      const camera = () => wheelViewportRef.current ?? designWorkspaceView(workspaceId);
      const startWorld = designCanvasPointFromClient(
        { x: event.clientX, y: event.clientY },
        viewport.getBoundingClientRect(),
        camera(),
      );
      const grab = { x: startWorld.x - box.x, y: startWorld.y - box.y };
      let offset = { x: 0, y: 0 };
      let moved = false;
      const paintGuides = (guides: { x?: number; y?: number }) => {
        if (verticalGuideRef.current) {
          verticalGuideRef.current.style.display = guides.x === undefined ? "none" : "block";
          if (guides.x !== undefined) verticalGuideRef.current.style.left = `${guides.x}px`;
        }
        if (horizontalGuideRef.current) {
          horizontalGuideRef.current.style.display = guides.y === undefined ? "none" : "block";
          if (guides.y !== undefined) horizontalGuideRef.current.style.top = `${guides.y}px`;
        }
      };
      const paint = (shift: { x: number; y: number }) => {
        for (const member of members) {
          const geometry = {
            ...member.start,
            x: member.start.x + shift.x,
            y: member.start.y + shift.y,
          };
          frameGeometryPreviewsRef.current.set(member.key, { geometry, settled: false });
          member.element = frameElementsRef.current.get(member.frame.file) ?? null;
          if (member.element) paintFrameGeometry(member.element, geometry);
        }
        refreshFrameResidency();
      };
      const move = (pointerEvent: PointerEvent) => {
        if (!ownerIsCurrent()) return;
        const zoom = liveDesignZoom();
        const delta = designMovementDelta(
          { x: pointerEvent.clientX, y: pointerEvent.clientY },
          viewport.getBoundingClientRect(),
          camera(),
          box,
          grab,
        );
        if (!moved && Math.hypot(delta.x, delta.y) < 3 / zoom) return;
        moved = true;
        document.body.style.cursor = "grabbing";
        const moving = { ...box, x: box.x + delta.x, y: box.y + delta.y };
        const snapped =
          pointerEvent.metaKey || pointerEvent.ctrlKey
            ? { rect: moving, guides: {} }
            : snapDesignRect(moving, peers, 6 / zoom);
        paintGuides(snapped.guides);
        const position = clampDesignRectPosition(snapped.rect, DESIGN_FRAME_COORDINATE_LIMIT);
        offset = { x: Math.round(position.x - box.x), y: Math.round(position.y - box.y) };
        paint(offset);
      };
      const restore = () => {
        for (const member of members) {
          frameGeometryPreviewsRef.current.delete(member.key);
          member.element = frameElementsRef.current.get(member.frame.file) ?? null;
          if (ownerIsCurrent() && member.element?.isConnected)
            paintFrameGeometry(member.element, member.start);
        }
        refreshFrameResidency();
      };
      const cancel = () => {
        paintGuides({});
        gestureCancelRef.current = null;
        restore();
      };
      const finish = () => {
        paintGuides({});
        gestureCancelRef.current = null;
        if (!ownerIsCurrent() || !moved || (offset.x === 0 && offset.y === 0)) {
          restore();
          return;
        }
        completed = true;
        const moves = members.map((member) => ({
          frame: member.frame.file,
          from: member.start,
          to: { ...member.start, x: member.start.x + offset.x, y: member.start.y + offset.y },
        }));
        for (const move of moves)
          frameGeometryPreviewsRef.current.set(`${canvasDocumentOwner}\0${move.frame}`, {
            geometry: move.to,
            settled: false,
          });
        const commit = moveDesignFramesCached(workspaceId, moves);
        savedEditingSession?.retain(commit);
        void commit
          .then((next) => {
            for (const member of members) {
              frameGeometryPreviewsRef.current.delete(member.key);
              const saved = next.frames.find((frame) => frame.file === member.frame.file);
              member.element = frameElementsRef.current.get(member.frame.file) ?? null;
              if (saved && ownerIsCurrent() && member.element?.isConnected)
                paintFrameGeometry(member.element, frameGeometry(saved));
            }
            refreshFrameResidency();
          })
          .catch((moveError) => {
            restore();
            if (ownerIsCurrent())
              toast.error("Couldn't move the frames", { description: errorMessage(moveError) });
          });
      };
      gestureCancelRef.current?.();
      gestureCancelRef.current = beginDesignPointerGesture({
        target: event.currentTarget,
        pointerId: event.pointerId,
        cursor: "default",
        onMove: move,
        onFinish: finish,
        onCancel: cancel,
      });
    },
    [
      canvasDirectoryId,
      canvasDocumentOwner,
      liveDesignZoom,
      savedEditingSession,
      snapshot,
      workspaceId,
      refreshFrameResidency,
    ],
  );

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
      gestureCancelRef.current?.();
      if (event.shiftKey && mode === "move") {
        publishSelection(frame, { selected: true, reveal: true, additive: true });
        return;
      }
      const currentSelection = designWorkspaceView(workspaceId);
      const selectedScene = currentSelection.selectedTargets.some((target) => target.frame === frame.file && !target.nodeId);
      if (mode === "move" && selectedScene && currentSelection.selectedTargets.some((target) => target.frame !== frame.file)) {
        if (event.altKey) {
          toast.error("Copy one canvas frame at a time", { description: "Select a single canvas frame to Option-drag a copy." });
          return;
        }
        // Selected frames move together in one write and one undo step.
        if (currentSelection.selectedTargets.every((target) => !target.nodeId)) {
          startFrameGroupMove(event, currentSelection.selectedTargets.map((target) => target.frame));
          return;
        }
        toast.error("Move frames or layers, not both", { description: "Select only frames, or layers in one frame, to move them together. Nothing was moved." });
        return;
      }
      if (selectedScene) useDesignWorkspaceUiStore.getState().setSelectedTargets(workspaceId, currentSelection.selectedTargets, { activeFrame: frame.file });
      else publishSelection(frame, { selected: true, reveal: true });
      const element = event.currentTarget.closest<HTMLElement>(
        "[data-design-frame]",
      );
      if (!element) return;
      if (mode === "move" && event.altKey && folder) {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const bounds = viewport.getBoundingClientRect();
        const lifetime = ++nudgeLifetimeRef.current;
        const canvasLifetime = canvasLifetimeRef.current;
        gestureCancelRef.current = startDesignFrameCopy({ event, workspaceId, folder, frame,
          point: pointer => designCanvasPointFromClient({ x: pointer.clientX, y: pointer.clientY }, bounds,
            wheelViewportRef.current ?? designWorkspaceView(workspaceId)),
          current: () => nudgeLifetimeRef.current === lifetime && canvasLifetimeRef.current === canvasLifetime,
          nest: showNestTarget, finished: () => { gestureCancelRef.current = null; },
          saving: save => savedEditingSession?.retain(save),
          failed: error => toast.error("Couldn't copy the frame", { description: errorMessage(error) }),
        });
        return;
      }
      const previewKey = `${canvasDocumentOwner}\0${frame.file}`;
      const pageOwner = captureDesignPageOwner(workspaceId);
      const selectionEvent = designWorkspaceView(workspaceId).selectionEvent;
      const lifetime = ++nudgeLifetimeRef.current;
      const canvasLifetime = canvasLifetimeRef.current;
      const theme = designWorkspaceView(workspaceId).activeTheme;
      let completed = false;
      const ownerIsCurrent = () =>
        canvasDocumentOwnerRef.current === canvasDocumentOwner &&
        designWorkspaceView(workspaceId).directoryId === canvasDirectoryId &&
        isCurrentDesignPageOwner(pageOwner) && canvasLifetimeRef.current === canvasLifetime &&
        designWorkspaceView(workspaceId).activeTheme === theme &&
        (completed || (nudgeLifetimeRef.current === lifetime &&
          designWorkspaceView(workspaceId).selectionEvent === selectionEvent));
      const previousPreview = frameGeometryPreviewsRef.current.get(previewKey);
      const start = previousPreview?.geometry ?? frameGeometry(frame);
      const preview: FrameGeometryPreview = { geometry: start, settled: false };
      const startX = event.clientX;
      const startY = event.clientY;
      const viewport = viewportRef.current;
      if (!viewport) return;
      const viewportBounds = viewport.getBoundingClientRect();
      const startWorld = designCanvasPointFromClient({ x: startX, y: startY }, viewportBounds, wheelViewportRef.current ?? designWorkspaceView(workspaceId));
      const grab = { x: startWorld.x - start.x, y: startWorld.y - start.y };
      let latest = start;
      const startRect = {
        x: start.x,
        y: start.y,
        width: start.w,
        height: start.h,
      };
      let latestRawRect = startRect;
      let moved = false;
      // Resizing a Hug frame fixes the axes it changes. The root previews that
      // intent while dragging so release commits exactly what is on screen.
      const runtimeFrame =
        useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
          frame.file
        ];
      const rootId = runtimeFrame?.snapshot?.frame?.oid;
      const resizeRoot =
        mode === "move" || !rootId
          ? null
          : (runtimeFrame?.detailsByNode[rootId] ??
            runtimeFrame?.snapshot?.frame ??
            null);
      const rootModes = designFrameSizeModeValues(resizeRoot);
      const badge = element.querySelector<HTMLElement>(
        "[data-design-frame-size-badge]",
      );
      let rootPreviewKeys = "";
      const rootPreviewLane = resizeRoot
        ? `${canvasDocumentOwner}\0${frame.file}\0${resizeRoot.oid}`
        : "";
      const queueRootPreview = (styles: Record<string, string> | null) => {
        if (!resizeRoot) return;
        const nodeId = resizeRoot.oid;
        const cleared = rootPreviewKeys !== "";
        rootPreviewKeys = Object.keys(styles ?? {}).sort().join(",");
        // One lane per root across gestures: a cancelled drag's restore runs
        // before the next drag's preview, never after it.
        void frameRootPreviewQueue.run(rootPreviewLane, async () => {
          if (!ownerIsCurrent()) return;
          // Restore the source first so a narrower intent drops the axis that
          // is no longer being fixed.
          if (cleared)
            await clearDesignNodeStylePreviewTransient({
              workspaceId,
              frame: frame.file,
              sourceVersion: frame.sourceVersion,
              nodeId,
            });
          if (styles && ownerIsCurrent())
            await previewDesignNodeGeometry({
              workspaceId,
              frame,
              nodeId,
              styles,
            });
        });
      };
      const previewRootSizing = (geometry: DesignFrameGeometryWire) => {
        const fixed = designFrameResizeRootStyles(resizeRoot, start, geometry);
        paintDesignLabelText(
          badge,
          designSizeBadgeText(geometry.w, geometry.h, {
            x: fixed?.width ? undefined : rootModes?.x,
            y: fixed?.height ? undefined : rootModes?.y,
          }),
        );
        const keys = Object.keys(fixed ?? {}).sort().join(",");
        if (keys !== rootPreviewKeys)
          queueRootPreview(fixed as Record<string, string> | null);
      };
      const clearRootPreview = () => {
        if (rootPreviewKeys) queueRootPreview(null);
      };
      const peers =
        frameViews
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

      // As in a design tool, the frame under the pointer is where this one
      // nests on release; it is outlined while it is. Cmd/Ctrl moves the
      // frame over others without nesting.
      const nestable = mode === "move" && frame.kind !== "text" && Boolean(folder);
      let nestTarget: DesignFrameView | undefined;
      let nestPointer: { x: number; y: number } | null = null;
      let nestDwell: number | null = null;
      const trackNestTarget = (pointerEvent: PointerEvent) => {
        if (!nestable || designWorkspaceView(workspaceId).selectedTargets.length !== 1) return;
        nestPointer = designCanvasPointFromClient(
          { x: pointerEvent.clientX, y: pointerEvent.clientY },
          viewportBounds,
          wheelViewportRef.current ?? designWorkspaceView(workspaceId),
        );
        // The confirmed frames now; another frame may have moved meanwhile.
        const target =
          pointerEvent.metaKey || pointerEvent.ctrlKey
            ? undefined
            : designCanvasFrameAt(
                frame.file,
                designFrameViews(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data),
                nestPointer,
              );
        if (target?.file === nestTarget?.file) return;
        nestTarget = target;
        paintNestTarget(target?.file ?? null);
        if (nestDwell !== null) window.clearTimeout(nestDwell);
        nestDwell = target
          ? window.setTimeout(() => {
              nestDwell = null;
              if (ownerIsCurrent()) setNestLiveFile(target.file);
            }, DESIGN_NEST_DWELL_MS)
          : null;
      };
      const releaseNestTarget = () => {
        nestTarget = undefined;
        if (nestDwell !== null) window.clearTimeout(nestDwell);
        nestDwell = null;
        showNestTarget(null);
      };

      const move = (pointerEvent: PointerEvent) => {
        if (!ownerIsCurrent()) return;
        // A trackpad pinch repaints the camera up to 80ms before the store
        // learns the new zoom, so travel divides by what is on screen now.
        const zoom = liveDesignZoom();
        const delta = designMovementDelta({ x: pointerEvent.clientX, y: pointerEvent.clientY }, viewportBounds, wheelViewportRef.current ?? designWorkspaceView(workspaceId), start, grab);
        const dx = delta.x;
        const dy = delta.y;
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
                latestRawRect = moving;
                const snapped =
                  pointerEvent.metaKey || pointerEvent.ctrlKey
                    ? { rect: moving, guides: {} }
                    : snapDesignRect(moving, peers, 6 / zoom);
                paintGuides(snapped.guides);
                const position = clampDesignRectPosition(
                  snapped.rect,
                  DESIGN_FRAME_COORDINATE_LIMIT,
                );
                return {
                  ...start,
                  x: Math.round(position.x),
                  y: Math.round(position.y),
                };
              })()
            : (() => {
                // Canvas metadata stores frames up to 16,384 px. The dragged
                // edge stops there instead of snapping back on release.
                const limits = {
                  minWidth: MIN_FRAME_WIDTH,
                  minHeight: MIN_FRAME_HEIGHT,
                  maxWidth: DESIGN_FRAME_MAX_SIZE,
                  maxHeight: DESIGN_FRAME_MAX_SIZE,
                };
                const resized = resizeDesignRect(
                  { x: start.x, y: start.y, width: start.w, height: start.h },
                  dx,
                  dy,
                  mode,
                  {
                    ...limits,
                    keepAspect: pointerEvent.shiftKey,
                    fromCenter: pointerEvent.altKey,
                  },
                );
                latestRawRect = resized;
                const snapped =
                  pointerEvent.metaKey ||
                  pointerEvent.ctrlKey ||
                  pointerEvent.shiftKey ||
                  pointerEvent.altKey
                    ? { rect: resized, guides: {} }
                    : snapDesignResizeRect(resized, mode, peers, 6 / zoom);
                const rect = clampDesignRectPosition(
                  clampDesignResizeRect(snapped.rect, mode, limits),
                  DESIGN_FRAME_COORDINATE_LIMIT,
                );
                paintGuides({
                  x:
                    rect.width === snapped.rect.width
                      ? snapped.guides.x
                      : undefined,
                  y:
                    rect.height === snapped.rect.height
                      ? snapped.guides.y
                      : undefined,
                });
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
        if (mode !== "move") previewRootSizing(latest);
        else trackNestTarget(pointerEvent);
      };

      const finish = () => {
        paintGuides({});
        gestureCancelRef.current = null;
        const releasedNestTarget = nestTarget;
        const releasedNestPointer = nestPointer;
        if (nestDwell !== null) window.clearTimeout(nestDwell);
        nestDwell = null;
        if (!ownerIsCurrent()) {
          cancel();
          return;
        }
        if (!moved) {
          releaseNestTarget();
          return;
        }
        if (releasedNestTarget) setNestLiveFile(releasedNestTarget.file);
        if (
          designGestureRectUnchanged(startRect, latestRawRect) ||
          (latest.x === Math.round(start.x) &&
            latest.y === Math.round(start.y) &&
            latest.w === Math.round(start.w) &&
            latest.h === Math.round(start.h))
        ) {
          cancel();
          return;
        }
        const persist = async () => {
          const acknowledgedFrame = previousPreview?.commit
            ? await previousPreview.commit
            : frame;
          if (!acknowledgedFrame) throw new Error("The preceding move removed this frame.");
          if (!ownerIsCurrent()) return acknowledgedFrame;
          const root =
            useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
              frame.file
            ]?.snapshot?.frame;
          const currentFrames = designFrameViews(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data ?? snapshot);
          const nestInto =
            releasedNestTarget &&
            currentFrames.find((candidate) => candidate.file === releasedNestTarget.file);
          if (
            mode === "move" &&
            folder &&
            nestInto &&
            releasedNestPointer &&
            designWorkspaceView(workspaceId).selectedTargets.length === 1
          ) {
            // A frame without a seeded root moves whole, by its body.
            const rootId = root?.oid ?? DESIGN_RUNTIME_DOCUMENT_BODY_ID;
            const presentation = root
              ? createDesignDragPresentation(workspaceId, frame, root, element)
              : null;
            presentation?.paint({
              x: latest.x - frame.x,
              y: latest.y - frame.y,
            });
            try {
              const sourceRuntime = await waitForDesignFrameRuntime(workspaceId, frame.file, 2_000, { sourceVersion: acknowledgedFrame.sourceVersion });
              if (!ownerIsCurrent()) return acknowledgedFrame;
              const measured = await sourceRuntime?.getNodeDetails(rootId, undefined, { relocation: true });
              if (!ownerIsCurrent()) return acknowledgedFrame;
              if (!measured)
                throw new Error("This frame's document is still loading. Try again in a moment.");
              if (
                await transferDesignLayerOnCanvas({
                  workspaceId,
                  folder,
                  frame: acknowledgedFrame,
                  details: measured,
                  frames: currentFrames,
                  origin: { x: latest.x, y: latest.y },
                  detach: false,
                  requireRelocation: true,
                  destination: nestInto,
                  pointer: releasedNestPointer,
                  isCurrent: ownerIsCurrent,
                  presented: (target) =>
                    presentation?.handoff(target) ?? Promise.resolve(),
                })
              )
                return undefined;
            } catch (nestError) {
              // A move never fails because nesting could not: the frame stays
              // where it was dropped, and the reason is shown.
              if (ownerIsCurrent())
                toast.error("Couldn't nest the frame", {
                  description: `${errorMessage(nestError)} It stays where you dropped it.`,
                });
            } finally {
              presentation?.remove();
            }
          }
          if (!ownerIsCurrent()) return acknowledgedFrame;
          if (mode === "move") {
            const result = await applyDesignEditCached(workspaceId, acknowledgedFrame, {
              schemaVersion: 1, transactionId: `desktop:${crypto.randomUUID()}`, actor: { kind: "human", id: "desktop" },
              intent: "Move canvas frame", createdAt: Date.now(),
              operations: [{ operationId: crypto.randomUUID(), type: "frame.set-geometry", frame: frame.file, geometry: { x: latest.x, y: latest.y, width: latest.w, height: latest.h, z: latest.z } }],
            }, { isCurrent: ownerIsCurrent, movementGuard: { sourceVersion: acknowledgedFrame.sourceVersion, geometry: frameGeometry(acknowledgedFrame) } });
            return result.snapshot?.frames.find((candidate) => candidate.file === frame.file);
          }
          const rootStyles = designFrameResizeRootStyles(
            resizeRoot,
            start,
            latest,
          );
          if (resizeRoot && rootStyles) {
            // A quick release must not let the drag's preview land after the
            // committed generation.
            await frameRootPreviewQueue.idle(rootPreviewLane);
            if (!ownerIsCurrent()) return acknowledgedFrame;
            const result = await applyDesignEditCached(workspaceId, acknowledgedFrame, {
              schemaVersion: 1,
              transactionId: `desktop:${crypto.randomUUID()}`,
              actor: { kind: "human", id: "desktop" },
              intent: "Resize canvas frame",
              createdAt: Date.now(),
              operations: [
                {
                  operationId: `layout:${crypto.randomUUID()}`,
                  type: "node.set-styles",
                  nodeId: resizeRoot.oid,
                  styles: rootStyles,
                  scope: "auto",
                  responsiveContext: "base",
                  stateContext: "default",
                },
                {
                  operationId: `layout:${crypto.randomUUID()}`,
                  type: "frame.set-geometry",
                  frame: frame.file,
                  geometry: {
                    x: latest.x,
                    y: latest.y,
                    width: latest.w,
                    height: latest.h,
                    z: latest.z,
                  },
                },
              ],
            });
            return result.snapshot?.frames.find((candidate) => candidate.file === frame.file);
          }
          await updateDesignFrameGeometryCached(
            workspaceId,
            frame.file,
            latest,
          );
          return designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames.find((candidate) => candidate.file === frame.file);
        };
        const settle = (geometry: DesignFrameGeometryWire) => {
          preview.geometry = geometry;
          preview.settled = true;
          if (frameGeometryPreviewsRef.current.get(previewKey) !== preview)
            return;
          frameGeometryPreviewsRef.current.delete(previewKey);
          if (ownerIsCurrent() && element.isConnected)
            paintFrameGeometry(element, geometry);
        };
        completed = true;
        preview.commit = persist();
        // The destination stays live until the nest that needed it settles.
        void preview.commit.finally(releaseNestTarget).catch(() => {});
        savedEditingSession?.retain(preview.commit);
        void preview.commit
          .then((confirmed) => settle(confirmed ? frameGeometry(confirmed) : latest))
          .catch((geometryError) => {
            const confirmed = designWorkspaceSnapshotCache
              .peekSnapshot(workspaceId)
              .data?.frames.find((candidate) => candidate.file === frame.file);
            const restored = confirmed ? frameGeometry(confirmed) : start;
            settle(restored);
            if (!ownerIsCurrent()) return;
            clearRootPreview();
            paintDesignLabelText(
              badge,
              designSizeBadgeText(restored.w, restored.h, rootModes),
            );
            toast.error("Couldn't update the frame geometry", {
              description: errorMessage(geometryError),
            });
          });
      };

      const cancel = () => {
        releaseNestTarget();
        if (frameGeometryPreviewsRef.current.get(previewKey) === preview) {
          if (ownerIsCurrent() && previousPreview && !previousPreview.settled)
            frameGeometryPreviewsRef.current.set(previewKey, previousPreview);
          else frameGeometryPreviewsRef.current.delete(previewKey);
          // The label DOM can survive a directory replacement. React has
          // already painted the new owner; the old rollback must not touch it.
          if (ownerIsCurrent()) {
            const restored = previousPreview?.geometry ?? start;
            paintFrameGeometry(element, restored);
            if (mode !== "move") {
              clearRootPreview();
              paintDesignLabelText(
                badge,
                designSizeBadgeText(restored.w, restored.h, rootModes),
              );
            }
          }
        }
        paintGuides({});
        gestureCancelRef.current = null;
      };

      gestureCancelRef.current?.();
      gestureCancelRef.current = beginDesignPointerGesture({
        target: event.currentTarget,
        pointerId: event.pointerId,
        cursor:
          mode === "move"
            ? "default"
            : (DESIGN_RESIZE_HANDLES.find((item) => item.handle === mode)
                ?.cursor ?? "nwse-resize"),
        onMove: move,
        onFinish: finish,
        onCancel: cancel,
      });
    },
    [
      active,
      activeTool,
      canvasDirectoryId,
      canvasDocumentOwner,
      folder,
      liveDesignZoom,
      paintNestTarget,
      publishSelection,
      savedEditingSession,
      showNestTarget,
      snapshot,
      frameViews,
      startFrameGroupMove,
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

  /** Direct canvas padding/gap editing. A press that moves under three screen
   * pixels is a click and opens numeric entry; past that it is a drag along
   * the owner's own (possibly turned) axis. Previews stay coalesced to one
   * in-flight request whose measurement repaints the tools island, and one
   * release is one source transaction — none at all when the drag ends where
   * it began. */
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
      // Space-drag pans the canvas, even over spacing chrome.
      if (spacePressedRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const pointerOwner = event.currentTarget;
      const pointerId = event.pointerId;
      // Capture on the owner, which outlives any one tick: a gap whose space
      // reflow removes mid-drag unmounts its button, not the gesture.
      const captureOwner =
        pointerOwner.closest<HTMLElement>("[data-design-layout-owner]") ??
        pointerOwner;
      captureOwner.setPointerCapture?.(pointerId);
      const frameElement = pointerOwner.closest<HTMLElement>(
        "[data-design-frame]",
      );
      const ownerKey = designLayoutToolsKey(
        workspaceId,
        frame.file,
        details.oid,
      );
      const controlKey = control.regionKey ?? control.property;
      const padding = control.kind === "padding";
      const start = { x: event.clientX, y: event.clientY };
      const previewInput = {
        workspaceId,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
        nodeId: details.oid,
      };
      const paddingSides = [
        "padding-top",
        "padding-right",
        "padding-bottom",
        "padding-left",
      ] as const;
      const paddingOriginal: Record<string, number> = {
        "padding-top": designPixelValue(details.styles.paddingTop),
        "padding-right": designPixelValue(details.styles.paddingRight),
        "padding-bottom": designPixelValue(details.styles.paddingBottom),
        "padding-left": designPixelValue(details.styles.paddingLeft),
      };
      // What the drag builds on. Recomputed from the gesture's own baseline
      // read below, so a fast second drag cannot start from a stale render.
      let baseline = control.value;
      let originalGeometry: DesignPaintedNode & {
        box?: DesignRuntimeNodeDetails["box"];
      } = details;
      let dragging = false;
      /** Set once the gesture ends: a late reply must have no effect. */
      let ended = false;
      spacingGestureRef.current = true;
      let pointer = {
        x: event.clientX,
        y: event.clientY,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      };
      let latest: {
        value: number;
        mirror: "none" | "opposite" | "all";
        commit: Record<string, string>;
      } = { value: baseline, mirror: "none", commit: {} };

      const currentOwner = () =>
        frameElement?.querySelector<HTMLElement>(
          `[data-design-layout-owner="${CSS.escape(details.oid)}"]`,
        ) ?? null;
      const paintOwnerGeometry = (
        geometry:
          | (DesignPaintedNode & { box?: DesignRuntimeNodeDetails["box"] })
          | null,
      ) => {
        const owner = currentOwner();
        if (!owner || !geometry) return;
        paintDesignNodeOverlayGeometry(
          owner,
          designSelectionOverlayFrame(designSelectionBox(geometry)),
        );
      };
      const mirroredSides = (mirror: "none" | "opposite" | "all") =>
        !padding
          ? []
          : mirror === "all"
            ? paddingSides.filter((side) => side !== control.property)
            : mirror === "opposite" && control.opposite
              ? [control.opposite]
              : [];
      const stylesFor = (
        value: number,
        mirror: "none" | "opposite" | "all",
      ) => {
        const css = `${value}px`;
        const commit: Record<string, string> = { [control.property]: css };
        // Padding previews name all four sides, so releasing a modifier
        // restores the side it had borrowed.
        const preview: Record<string, string> = padding
          ? Object.fromEntries(
              paddingSides.map((side) => [side, `${paddingOriginal[side]}px`]),
            )
          : {};
        preview[control.property] = css;
        for (const side of mirroredSides(mirror)) {
          commit[side] = css;
          preview[side] = css;
        }
        if (!padding && control.automatic && control.reset) {
          Object.assign(commit, control.reset);
          Object.assign(preview, control.reset);
        }
        return { commit, preview };
      };

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
          if (ended) return;
          paintOwnerGeometry(geometry);
          publishDesignLayoutToolsLive(ownerKey, {
            geometry: {
              rect: geometry.rect,
              box: geometry.box,
              styles: geometry.styles,
              children: geometry.children,
            },
            pinned: true,
          });
        },
      });

      const update = () => {
        const dx = pointer.x - start.x;
        const dy = pointer.y - start.y;
        if (!dragging) {
          if (Math.hypot(dx, dy) < DESIGN_SPACING_DRAG_THRESHOLD) return;
          dragging = true;
          document.body.style.cursor = designLocalAxisCursor(
            control.axis,
            control.rotation,
          );
        }
        const { mirror, step } = designSpacingModifiers(pointer, padding);
        const value = designSpacingDragValue({
          start: baseline,
          delta: designLocalAxisDelta({
            dx,
            dy,
            axis: control.axis,
            rotation: control.rotation,
            zoom: liveDesignZoom(),
            scale: control.scale,
          }),
          direction: control.direction,
          step,
        });
        if (
          latest.commit[control.property] !== undefined &&
          value === latest.value &&
          mirror === latest.mirror
        ) {
          return;
        }
        const { commit, preview } = stylesFor(value, mirror);
        latest = { value, mirror, commit };
        const mirrored = mirroredSides(mirror);
        publishDesignLayoutToolsLive(ownerKey, {
          interaction: {
            active: controlKey,
            property: control.property,
            anchor: control.anchor,
            mirrored,
            values: Object.fromEntries([
              [controlKey, value],
              ...mirrored.map((side) => [side, value]),
            ]),
          },
          pinned: true,
        });
        loop.author(preview);
      };
      const move = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        pointer = {
          x: pointerEvent.clientX,
          y: pointerEvent.clientY,
          altKey: pointerEvent.altKey,
          shiftKey: pointerEvent.shiftKey,
        };
        update();
      };
      // Modifiers change a drag's scope even while the pointer rests.
      const modifiers = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== "Alt" && keyEvent.key !== "Shift") return;
        pointer = {
          ...pointer,
          altKey: keyEvent.altKey,
          shiftKey: keyEvent.shiftKey,
        };
        if (dragging) update();
      };
      const cleanup = () => {
        ended = true;
        spacingGestureRef.current = false;
        loop.stop();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        window.removeEventListener("keydown", modifiers, true);
        window.removeEventListener("keyup", modifiers, true);
        if (captureOwner.hasPointerCapture?.(pointerId)) {
          captureOwner.releasePointerCapture(pointerId);
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
      };
      const restore = () => {
        paintOwnerGeometry(originalGeometry);
        releaseDesignLayoutToolsLive(ownerKey);
        void clearDesignNodeStylePreviewTransient(previewInput).catch(() => {});
      };
      const finish = (pointerEvent?: PointerEvent) => {
        if (pointerEvent && pointerEvent.pointerId !== pointerId) return;
        if (pointerEvent) {
          pointer = {
            ...pointer,
            altKey: pointerEvent.altKey,
            shiftKey: pointerEvent.shiftKey,
          };
          if (dragging) update();
        }
        cleanup();
        if (!dragging) {
          releaseDesignLayoutToolsLive(ownerKey);
          // A modifier-click selects through spacing chrome.
          if (event.metaKey || event.ctrlKey) {
            if (!folder || !frameElement) return;
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
          control.openEntry(
            padding && event.altKey
              ? event.shiftKey
                ? "all"
                : "opposite"
              : "none",
          );
          return;
        }
        // A drag that ends where it began changes nothing: no write, no
        // history, and authored units and expressions stay untouched.
        const changed = Object.entries(latest.commit).some(([property, css]) =>
          property.startsWith("padding-")
            ? designPixelValue(css) !== paddingOriginal[property]
            : property === control.property
              ? latest.value !== baseline
              : false,
        );
        if (!changed) {
          restore();
          return;
        }
        publishDesignGestureLivePreview(
          workspaceId,
          frame.file,
          details.oid,
          latest.commit,
          { settle: true },
        );
        releaseDesignLayoutToolsLive(ownerKey, { keepGeometry: true });
        void commitDesignLayoutOwnerStyles({
          workspaceId,
          frame,
          nodeId: details.oid,
          styles: latest.commit,
        }).catch((spacingError: unknown) => {
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
      // Inspector reads may have observed the preceding gesture's preview.
      // After canceling it, capture this gesture's baseline on the same runtime
      // port before any preview writes; its reply precedes their measurements.
      void previewDesignNodeGeometry({
        workspaceId,
        frame,
        nodeId: details.oid,
        children: true,
      })
        .then((geometry) => {
          if (ended) return;
          originalGeometry = geometry;
          for (const side of paddingSides) {
            paddingOriginal[side] = designPixelValue(
              geometry.styles[
                side === "padding-top"
                  ? "paddingTop"
                  : side === "padding-right"
                    ? "paddingRight"
                    : side === "padding-bottom"
                      ? "paddingBottom"
                      : "paddingLeft"
              ],
            );
          }
          if (padding) {
            baseline = paddingOriginal[control.property] ?? baseline;
          } else if (!control.automatic) {
            const authored = designGapValue(
              geometry.styles,
              control.property as DesignGapProperty,
            );
            if (authored !== null) baseline = authored;
          }
          if (dragging) update();
        })
        .catch(() => {});
      gestureCancelRef.current = cancel;
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
      window.addEventListener("keydown", modifiers, true);
      window.addEventListener("keyup", modifiers, true);
    },
    [active, folder, liveDesignZoom, workspaceId],
  );

  /** Figma's edge shortcut: double-click a vertical edge to Hug width, a
   * horizontal one to Hug height; Option asks for Fill where the inspector
   * would offer it. */
  const sizeEdgeToContent = useCallback(
    (
      frame: DesignCanvasFrameWire,
      details: DesignRuntimeNodeDetails,
      handle: DesignResizeHandle,
      fill: boolean,
    ) => {
      if (!workspaceId || !active) return;
      const axis = handle === "e" || handle === "w" ? "x" : "y";
      if (
        fill ? !canFillDesignContainer(details) : !canHugDesignContents(details)
      )
        return;
      const styles = designSizingStyles(details, axis, fill ? "fill" : "hug");
      void commitDesignLayoutOwnerStyles({
        workspaceId,
        frame,
        nodeId: details.oid,
        styles,
      }).catch((sizingError: unknown) => {
        toast.error("Couldn't resize to content", {
          description: errorMessage(sizingError),
        });
      });
    },
    [active, workspaceId],
  );

  /** Typed values and key steps from the canvas tools: one write each. */
  const commitInlineSpacing = useCallback(
    (
      frame: DesignCanvasFrameWire,
      details: DesignRuntimeNodeDetails,
      styles: Record<string, string>,
    ) => {
      if (!workspaceId || !active) return Promise.resolve();
      publishDesignGestureLivePreview(
        workspaceId,
        frame.file,
        details.oid,
        styles,
        {
          settle: true,
        },
      );
      return commitDesignLayoutOwnerStyles({
        workspaceId,
        frame,
        nodeId: details.oid,
        styles,
      }).catch((spacingError: unknown) => {
        void clearDesignNodeStylePreviewTransient({
          workspaceId,
          frame: frame.file,
          sourceVersion: frame.sourceVersion,
          nodeId: details.oid,
        }).catch(() => {});
        toast.error("Couldn't update canvas spacing", {
          description: errorMessage(spacingError),
        });
      });
    },
    [active, workspaceId],
  );

  const startNodeGroupMove = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      frame: DesignCanvasFrameWire,
      nodes: readonly DesignRuntimeNodeDetails[],
      clickedNode: DesignRuntimeNodeDetails,
      clicked?: () => void,
    ) => {
      if (
        !workspaceId ||
        !active ||
        !event.isPrimary ||
        event.button !== 0 ||
        nodes.length < 1
      ) {
        return false;
      }
      const article = event.currentTarget.closest<HTMLElement>(
        "[data-design-frame]",
      );
      if (!article) return false;
      const viewport = viewportRef.current;
      if (!viewport) return false;
      const viewportBounds = viewport.getBoundingClientRect();
      const pointInFrame = (pointer: { clientX: number; clientY: number }) => {
        const world = designCanvasPointFromClient({ x: pointer.clientX, y: pointer.clientY }, viewportBounds,
          wheelViewportRef.current ?? designWorkspaceView(workspaceId));
        return { x: world.x - frame.x, y: world.y - frame.y };
      };
      event.preventDefault();
      event.stopPropagation();
      const runtime = designFrameRuntime(workspaceId, frame.file);
      if (!runtime?.supports("previewLayout") || runtime.sourceVersion !== frame.sourceVersion) {
        toast.error("Wait for the selected scene to finish loading");
        return true;
      }
      const duplicate = event.altKey;
      if (duplicate && (!runtime.previewStructure || !runtime.supports("commitStructure"))) {
        toast.error("Wait for this document to update before copying layers");
        return true;
      }
      const transactionId = `desktop:${crypto.randomUUID()}`;
      const copyIds = new Map(duplicate ? nodes.map(node => [node.oid, `copy-${crypto.randomUUID()}`]) : []);
      let copyPreview: Promise<unknown> | null = null;
      gestureCancelRef.current?.();
      const owner = captureDesignPageOwner(workspaceId);
      const selection = designWorkspaceView(workspaceId);
      const lifetime = ++nudgeLifetimeRef.current;
      const revision = useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[frame.file]?.snapshot?.revision;
      let cancelled = false;
      const isCurrent = () => !cancelled && isCurrentDesignPageOwner(owner) && nudgeLifetimeRef.current === lifetime &&
        designWorkspaceView(workspaceId).selectionEvent === selection.selectionEvent && designWorkspaceView(workspaceId).activeTheme === selection.activeTheme &&
        designFrameRuntime(workspaceId, frame.file) === runtime && runtime.sourceVersion === frame.sourceVersion &&
        useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[frame.file]?.snapshot?.revision === revision;
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
      const starts = nodes.map((details) => ({ details }));
      const painted = selectedNodeDetailsList.map((details) => ({
        overlay: overlays.get(details.oid) ?? null,
        // A rotated member's overlay is anchored on its pivot, so a group move
        // has to translate that placement rather than its bounding box.
        overlayFrame: designSelectionOverlayFrame(designSelectionBox(details)),
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
      const grab = pointInFrame(event);
      let delta = { x: 0, y: 0 };
      let latestRawBounds = groupBounds;
      let moved = false;
      let releasePointer = grab;
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
          nodeId: duplicate ? copyIds.get(start.details.oid)! : start.details.oid,
          styles: designNodeMovementStyles(start.details, delta),
        }));
      // The whole group is one flight: its members must never land a frame apart.
      const loop = createDesignGestureLoop<unknown>({
        request: async () => {
          if (!isCurrent()) throw new Error("The group changed during this move.");
          if (duplicate) await (copyPreview ??= runtime.previewStructure!({ previewId: transactionId,
            operations: starts.map(start => ({ type: "duplicate", nodeId: start.details.oid, duplicateNodeId: copyIds.get(start.details.oid)! })),
          }));
          if (!isCurrent()) return;
          const next = updates();
          for (const update of next) publishDesignGestureLivePreview(workspaceId, frame.file, update.nodeId, update.styles);
          return runtime.previewLayout({ updates: next, nodeIds: [], children: false });
        },
      });
      const paint = () => {
        for (const start of painted) {
          if (!start.overlay) continue;
          start.overlay.style.left = `${start.overlayFrame.left + delta.x}px`;
          start.overlay.style.top = `${start.overlayFrame.top + delta.y}px`;
        }
      };
      const restore = () => {
        if (duplicate) void copyPreview?.finally(() => runtime.clearPreviewStructure?.(transactionId)).catch(() => {});
        if (nudgeLifetimeRef.current !== lifetime || runtime.sourceVersion !== frame.sourceVersion || designFrameRuntime(workspaceId, frame.file) !== runtime) return;
        for (const start of painted) {
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
              nodeId: duplicate ? copyIds.get(start.details.oid)! : start.details.oid,
            }),
          ),
        ).catch(() => {});
      };
      const move = (pointerEvent: PointerEvent) => {
        // A trackpad pinch repaints the camera up to 80ms before the store
        // learns the new zoom, so travel divides by what is on screen now.
        const zoom = liveDesignZoom();
        if (!isCurrent()) return;
        const point = pointInFrame(pointerEvent);
        const rawX = point.x - grab.x;
        const rawY = point.y - grab.y;
        if (!moved && Math.hypot(rawX, rawY) < 3 / zoom) return;
        moved = true;
        releasePointer = { x: grab.x + rawX, y: grab.y + rawY };
        const moving = {
          ...groupBounds,
          x: groupBounds.x + rawX,
          y: groupBounds.y + rawY,
        };
        latestRawBounds = moving;
        const snapped =
          pointerEvent.metaKey || pointerEvent.ctrlKey
            ? { rect: moving, guides: {} }
            : snapDesignRect(moving, peerRects, 6 / zoom);
        delta = {
          x: snapped.rect.x - groupBounds.x,
          y: snapped.rect.y - groupBounds.y,
        };
        const margin = DESIGN_REPARENT_HYSTERESIS_PIXELS / zoom;
        if (selection.selectedTargets.length > 1 && starts.some(({ details }) => {
          const x = details.rect.x + delta.x + details.rect.width / 2;
          const y = details.rect.y + delta.y + details.rect.height / 2;
          return x < -margin || y < -margin || x > frame.width + margin || y > frame.height + margin;
        })) {
          gestureCancelRef.current?.();
          toast.error("Detach one layer at a time", { description: "Grouped structural transfer is not yet atomic; nothing was moved." });
          return;
        }
        paintGuides(snapped.guides);
        paint();
        loop.author({});
      };
      const cleanup = () => {
        loop.stop();
        paintGuides({});
        gestureCancelRef.current = null;
      };
      const finish = () => {
        cleanup();
        if (!isCurrent()) { restore(); return; }
        if (!moved) {
          if (clicked) { clicked(); return; }
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
        if (designGestureRectUnchanged(groupBounds, latestRawBounds)) {
          restore();
          return;
        }
        // One layer released outside its frame leaves it, as in a design
        // tool: over another frame it joins that frame at the pointer, over
        // empty canvas it becomes a frame of its own.
        const single =
          starts.length === 1 && selection.selectedTargets.length === 1
            ? starts[0]!.details
            : null;
        const margin = DESIGN_REPARENT_HYSTERESIS_PIXELS / liveDesignZoom();
        const releasedCenter = single && {
          x: single.rect.x + delta.x + single.rect.width / 2,
          y: single.rect.y + delta.y + single.rect.height / 2,
        };
        if (
          single &&
          folder &&
          releasedCenter &&
          (releasedCenter.x < -margin ||
            releasedCenter.y < -margin ||
            releasedCenter.x > frame.width + margin ||
            releasedCenter.y > frame.height + margin)
        ) {
          const pointer = { x: frame.x + releasePointer.x, y: frame.y + releasePointer.y };
          void (async () => {
            const measured = await runtime.getNodeDetails(single.oid, undefined, { relocation: true });
            if (!isCurrent()) return false;
            return transferDesignLayerAtRelease({
              workspaceId,
              folder,
              frame,
              details: measured,
              ...(duplicate ? { duplicateNodeId: copyIds.get(single.oid)! } : {}),
              origin: { x: frame.x + measured.rect.x, y: frame.y + measured.rect.y },
              pointer,
              isCurrent,
              nest: showNestTarget,
            });
          })()
            .then((transferred) => {
              if (!transferred) restore();
              else if (duplicate) void runtime.clearPreviewStructure?.(transactionId).catch(() => {});
            })
            .catch((error) => {
              restore();
              toast.error("Couldn't move the layer", { description: errorMessage(error) });
            });
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
        const save = (async () => {
          await copyPreview;
          const result = await applyDesignEditCached(workspaceId, frame, {
            schemaVersion: 1,
            transactionId,
            actor: { kind: "human", id: "desktop" },
            intent: `${duplicate ? "Copy and place" : "Move"} ${finalUpdates.length} selected layers`,
            createdAt: Date.now(),
            operations: [...(duplicate ? starts.map(start => ({ operationId: crypto.randomUUID(), type: "node.duplicate" as const,
              nodeId: start.details.oid, duplicateNodeId: copyIds.get(start.details.oid)! })) : []), ...finalUpdates.map((update) => ({
              operationId: `move:${crypto.randomUUID()}`,
              type: "node.set-styles" as const,
              nodeId: update.nodeId,
              styles: update.styles,
              scope: "auto" as const,
              responsiveContext: "base" as const,
              stateContext: "default" as const,
            }))],
          }, { isCurrent, movementGuard: { sourceVersion: frame.sourceVersion, geometry: frameGeometry(frame) } }, duplicate ? { structurePreviewId: transactionId } : undefined);
          if (duplicate) {
            await runtime.clearPreviewStructure?.(transactionId).catch(() => {});
            const confirmed = result.snapshot?.frames.find(candidate => candidate.file === frame.file);
            if (confirmed && folder && isCurrentDesignPageOwner(owner) && nudgeLifetimeRef.current === lifetime &&
              designWorkspaceView(workspaceId).selectionEvent === selection.selectionEvent)
              void selectDesignNodes({ workspaceId, folder, frame: confirmed, nodeIds: [...copyIds.values()], owner }).catch(() => {});
          }
        })();
        savedEditingSession?.retain(save);
        void save.catch((error) => {
          restore();
          toast.error("Couldn't move the selected elements", {
            description: errorMessage(error),
          });
        });
      };
      const cancel = () => {
        cancelled = true;
        cleanup();
        restore();
      };

      gestureCancelRef.current?.();
      gestureCancelRef.current = beginDesignPointerGesture({
        target: event.currentTarget,
        pointerId: event.pointerId,
        cursor: "move",
        onMove: move,
        onFinish: finish,
        onCancel: cancel,
      });
      return true;
    },
    [
      active,
      activeTool,
      finishInlineTextTool,
      folder,
      liveDesignZoom,
      parentOutlineDetails,
      peerGeometryDetails,
      selectedNodeDetailsList,
      savedEditingSession,
      showNestTarget,
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
      let latestRawBounds = startBounds;
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
        latestRawBounds = raw;
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
        paintGuides({});
        delete groupOverlay.dataset.designGesture;
        gestureCancelRef.current = null;
      };
      const finish = () => {
        cleanup();
        if (!moved) return;
        if (designGestureRectUnchanged(startBounds, latestRawBounds)) {
          restore();
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
      gestureCancelRef.current = beginDesignPointerGesture({
        target: event.currentTarget,
        pointerId: event.pointerId,
        cursor:
          DESIGN_RESIZE_HANDLES.find((item) => item.handle === handle)?.cursor ??
          "nwse-resize",
        onMove: move,
        onFinish: finish,
        onCancel: cancel,
      });
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
      if (gestureMode === "move") {
        const targets = designWorkspaceView(workspaceId).selectedTargets;
        if (targets.some((target) => target.frame !== frame.file)) {
          event.preventDefault();
          event.stopPropagation();
          if (targets.every((target) => !target.nodeId)) {
            startFrameGroupMove(event, targets.map((target) => target.frame));
            return;
          }
          toast.error("Move frames or layers, not both", { description: "Select only frames, or layers in one frame, to move them together. Nothing was moved." });
          return;
        }
        const roots = designSelectionMutationTargets(targets, new Map([[frame.file, selectedRuntimeTree]]));
        if (roots.some((target) => !target.nodeId)) {
          startFrameGesture(event, frame, "move");
          return;
        }
        if (targets.length > 1) {
        const runtimeState = useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[frame.file];
        const topLevelIds = roots.flatMap((target) => target.nodeId ? [target.nodeId] : []);
        if (runtimeState?.sourceVersion !== frame.sourceVersion || targets.some((target) => target.nodeId && !designLayerPathIds(selectedRuntimeTree, target.nodeId).length)) {
          event.preventDefault();
          event.stopPropagation();
          toast.error("The selected ancestry is not ready", { description: "Nothing was moved; wait for this scene to refresh." });
          return;
        }
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
        if (group.length !== topLevelIds.length || group.some((node) => node.sourceVersion !== frame.sourceVersion || node.parentCoordinateSpace === null)) {
          event.preventDefault();
          event.stopPropagation();
          toast.error("The selected geometry is not ready", { description: "Nothing was moved." });
          return;
        }
        if (startNodeGroupMove(event, frame, group, details)) return;
        }
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
        (details.styles.position === "absolute" || !details.box?.rotation)
      ) {
        if (
          ["flex", "inline-flex", "grid", "inline-grid"].includes(
            details.layout?.parentDisplay ?? "",
          ) ||
          selectedFrameHasFlow || details.styles.position === "absolute"
        ) {
          gestureCancelRef.current?.();
          const lifetime = ++nudgeLifetimeRef.current;
          const gestureViewportBounds = viewportRef.current?.getBoundingClientRect();
          const cancel = startDesignLayoutDrag({
            saving: (save) => savedEditingSession?.retain(save),
            copied: (copyFrame, nodeId) => {
              if (folder) void selectDesignNode({ workspaceId, folder, frame: copyFrame, nodeId }).catch(() => {});
            },
            event,
            workspaceId,
            frame,
            details,
            zoom: liveDesignZoom,
            point: gestureViewportBounds ? pointer => {
              const world = designCanvasPointFromClient({ x: pointer.clientX, y: pointer.clientY }, gestureViewportBounds,
                wheelViewportRef.current ?? designWorkspaceView(workspaceId));
              return { x: world.x - frame.x, y: world.y - frame.y };
            } : undefined,
            isCurrent: () => nudgeLifetimeRef.current === lifetime,
            paint: (geometry, parent) => {
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
              paintDesignConstraintGuides(
                guides,
                designSelectionBoxBounds(box),
                box,
                parent,
              );
            },
            detach: folder
              ? (origin, movedDetails, presented, canWrite, pointer, duplicateNodeId) =>
                  transferDesignLayerAtRelease({
                    workspaceId,
                    folder,
                    frame,
                    details: movedDetails,
                    duplicateNodeId,
                    origin: { x: frame.x + origin.x, y: frame.y + origin.y },
                    pointer: { x: frame.x + pointer.x, y: frame.y + pointer.y },
                    isCurrent: () => nudgeLifetimeRef.current === lifetime,
                    canWrite,
                    presented,
                    nest: showNestTarget,
                  })
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
      if (gestureMode === "move" && startNodeGroupMove(event, frame, [details], details, finishClickSelection)) return;
      event.preventDefault();
      event.stopPropagation();
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
      let latestRawRect = start;
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
            measuredBox,
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
        latestRawRect = raw;
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
        paintGuides({});
        gestureCancelRef.current = null;
      };

      const restorePreview = () => {
        paintDesignNodeOverlayGeometry(overlay, startOverlay);
        paintDesignConstraintGuides(
          constraintGuides,
          designSelectionBoxBounds(box),
          box,
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
        // Returning to the original authored geometry is a cancelled edit.
        // Restore source sizing intent (Hug/Fill, %, auto), not fixed pixels.
        if (
          designGestureRectUnchanged(start, latestRawRect) ||
          sameDesignGestureStyles(latestStyles, authoredForRect(start).styles)
        ) {
          restorePreview();
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
      gestureCancelRef.current = beginDesignPointerGesture({
        target: event.currentTarget,
        pointerId: event.pointerId,
        cursor:
          gestureMode === "move"
            ? "move"
            : (DESIGN_RESIZE_HANDLES.find((item) => item.handle === gestureMode)
                ?.cursor ?? "nwse-resize"),
        onMove: move,
        onFinish: finish,
        onCancel: cancel,
      });
    },
    [
      active,
      activeTool,
      childGeometryDetails,
      folder,
      liveDesignZoom,
      parentOutlineDetails,
      peerGeometryDetails,
      savedEditingSession,
      selectedNodeDetailsList,
      selectedFrameHasFlow,
      showNestTarget,
      selectedRuntimeTree,
      startFrameGesture,
      startFrameGroupMove,
      startNodeGroupMove,
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
        !event.isPrimary ||
        (event.button !== 1 && !(event.button === 0 && spacePressedRef.current))
      ) {
        return false;
      }
      event.preventDefault();
      gestureCancelRef.current?.();
      const startX = event.clientX;
      const startY = event.clientY;
      if (wheelPaintFrameRef.current !== null) paintPendingWheelGesture();
      // The wheel camera may be a paint ahead of persisted state. Transfer that
      // exact camera to the hand and retire its timer before starting the drag.
      const camera = wheelViewportRef.current ?? view;
      const start: DesignViewport = {
        zoom: camera.zoom,
        panX: camera.panX,
        panY: camera.panY,
      };
      const ownerIsCurrent = () =>
        canvasDocumentOwnerRef.current === canvasDocumentOwner &&
        designWorkspaceView(workspaceId).directoryId === canvasDirectoryId;
      cancelPendingWheelGesture();
      wheelViewportRef.current = start;
      panGestureRef.current = true;
      let latest: DesignViewport = start;

      const move = (pointerEvent: PointerEvent) => {
        if (!ownerIsCurrent()) return;
        latest = {
          ...start,
          panX: start.panX + pointerEvent.clientX - startX,
          panY: start.panY + pointerEvent.clientY - startY,
        };
        wheelViewportRef.current = latest;
        paintDesignCanvasCamera(worldRef.current, latest, true);
        refreshFrameResidency("camera");
        designBackgroundWork.touch();
      };

      const settle = (viewport: DesignViewport) => {
        panGestureRef.current = false;
        gestureCancelRef.current = null;
        cancelPendingWheelGesture();
        // Directory replacement already published its own view. Releasing the
        // retired hand must not restore the old camera or selection into it.
        if (!ownerIsCurrent()) return;
        paintDesignCanvasCamera(worldRef.current, viewport, false);
        setViewport(workspaceId, viewport, canvasPageOwner);
      };
      gestureCancelRef.current = beginDesignPointerGesture({
        target: event.currentTarget,
        pointerId: event.pointerId,
        cursor: "grabbing",
        onMove: move,
        onFinish: () => settle(latest),
        onCancel: () => settle(start),
      });
      return true;
    },
    [
      active,
      cancelPendingWheelGesture,
      paintPendingWheelGesture,
      canvasDirectoryId,
      canvasDocumentOwner,
      canvasPageOwner,
      setViewport,
      refreshFrameResidency,
      view,
      workspaceId,
    ],
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
      // The timeline is mounted inside the canvas, but its controls own native
      // focus, activation and keyframe editing rather than layer navigation.
      if (
        event.defaultPrevented || event.isComposing ||
        (event.target instanceof Element &&
          event.target.closest(
            "[data-design-motion-timeline], [data-design-motion-settings]",
          ))
      ) return;
      if (event.key === "Escape" && currentPlaybackRef.current) {
        event.preventDefault();
        stopFramePlayback(currentPlaybackRef.current.id);
        return;
      }
      // The toggle owns native Space/Enter activation, even though it sits
      // inside the canvas that normally uses Space to pan.
      if (event.target instanceof Element && event.target.closest("[data-design-frame-play]")) return;
      const editableTarget = isEditableHotkeyTarget(event.target);
      // Option measures; it never types, moves, or deletes anything. Reading it
      // outside the canvas's own focus scope is what makes the overlay appear
      // right after a Layers row click, where focus lives in the sidebar.
      if (!editableTarget) syncMeasureModifier(event.altKey);
      const activeElement = document.activeElement;
      const designSurfaceFocused =
        activeElement instanceof Element &&
        Boolean(activeElement.closest("[data-design-workspace-surface]"));
      const shortcutView = designWorkspaceView(workspaceId);
      const shortcutFrame = workspaceId ? designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames.find(frame => frame.file === shortcutView.selectedFrame) : undefined;
      const selectedNodeIsTarget = Boolean(shortcutFrame && shortcutView.selectedNodeId);
      const selectedFrameIsTarget = Boolean(shortcutFrame && shortcutView.frameSelected);
      const selectionShortcut = resolveDesignSelectionShortcut(
        event,
        editableTarget,
        designSurfaceFocused && (selectedNodeIsTarget || selectedFrameIsTarget),
      );
      if (selectionShortcut) {
        event.preventDefault();
        if (selectionShortcut === "delete") {
          if (selectedNodeIsTarget) void deleteSelectedNode();
          else if (shortcutFrame) void deleteSelectedFrame(shortcutFrame);
        } else {
          const duplicateMode =
            selectionShortcut === "copy" ? "copy" : "duplicate";
          if (shortcutFrame?.kind === "text" || !selectedNodeIsTarget) {
            void duplicateSelectedFrame(duplicateMode);
          } else {
            void duplicateSelectedNode(duplicateMode);
          }
        }
        return;
      }
      if (editableTarget) return;
      if (!viewport.contains(document.activeElement)) return;
      if (event.key === "Escape" && (nudgeGestureRef.current || queuedNudgeRef.current)) {
        event.preventDefault();
        finishNodeNudge(true);
        return;
      }
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
            reveal: true,
          });
        }
        return;
      }
      if (event.key === "Escape" && view.frameSelected && selectedDescription) {
        event.preventDefault();
        void selectDesignFrame(workspaceId!, selectedDescription);
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
              reveal: true,
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
        const step = designNudgeStep(event.shiftKey);
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
        motionTargetSelected
      ) {
        event.preventDefault();
        onMotionTimelineOpenChange(!motionTimelineOpen);
        return;
      }
      if (!event.shiftKey) return;
      if (event.code === "Digit1") {
        event.preventDefault();
        fitFrames(frameViews);
      } else if (event.code === "Digit2" && selectedDescription) {
        event.preventDefault();
        fitFrames([selectedDescription]);
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
        (nudgeGestureRef.current || queuedNudgeRef.current)
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
      if (nudgeGestureRef.current || queuedNudgeRef.current) finishNodeNudge(true);
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
    deleteSelectedFrame,
    deleteSelectedNode,
    duplicateSelectedFrame,
    duplicateSelectedNode,
    finishInlineTextTool,
    finishNodeNudge,
    fitFrames,
    hitStackMenu,
    stopFramePlayback,
    nudgeSelectedNode,
    motionTimelineOpen,
    motionTargetSelected,
    navigateToNode,
    onMotionTimelineOpenChange,
    onDeleteFrame,
    resizeSelectedNode,
    selectedDescription,
    selectedFrame,
    selectedNodeDetails,
    selectedNavigationTree,
    selectedRuntimeTree,
    frameViews,
    syncMeasureModifier,
    view.frameSelected,
    view.selectedFrame,
    view.selectedNodeId,
    workspaceId,
    zoomAt,
  ]);

  // Navigation/collapse during a drag must release window listeners and restore
  // the pre-gesture DOM geometry before the retained surface becomes inert.
  useLayoutEffect(
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
      // A hidden return must restore the camera the user actually saw. Merely
      // dropping the debounce leaves the DOM at the gesture scale and the
      // saved view at its previous scale. A replaced page/checkout cannot
      // receive this outgoing gesture's last position.
      const settled = wheelViewportRef.current;
      cancelPendingWheelGesture();
      if (settled && workspaceId && canvasFolderRef.current === folder &&
          canvasDocumentOwnerRef.current === canvasDocumentOwner)
        setViewport(workspaceId, settled, canvasPageOwner);
      hitStackGenerationRef.current += 1;
      canvasLifetimeRef.current += 1;
      nudgeLifetimeRef.current += 1;
      finishNodeNudge(true);
      setHitStackMenu(null);
      setSelectionOverlaySuppressed(false);
      setMotionOverlayState({ owner: "", draft: null });
      setMotionSeekState({ owner: "", request: null });
      activateTool("select");
    },
    [active, canvasDocumentOwner, canvasPageOwner, folder, view.directoryId, workspaceId, activateTool, finishNodeNudge, cancelPendingWheelGesture, setViewport],
  );

  // Hiding keeps the host-owned draft (including IME) mounted. Only a real
  // source owner change/unmount cancels it; memory grace is never edit authority.
  useLayoutEffect(() => () => {
      const edit = inlineTextEditRef.current;
      if (edit) {
        cancelInlineTextCommit(textCommitGuardRef.current, edit);
        if (edit.kind === "existing" && workspaceId) {
          void clearDesignNodeTextPreviewTransient({
            workspaceId, frame: edit.frame, sourceVersion: edit.sourceVersion, nodeId: edit.nodeId,
            runtime: edit.runtime,
          }).catch(() => {});
        }
      }
      inlineTextEditRef.current = null;
      inlineTextPreviewRef.current.pending = null;
      renameSettledRef.current = true;
      setInlineTextEdit(null);
      setRenamingFrame(null);
  }, [canvasDocumentOwner, folder, workspaceId]);

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
      }).catch((selectionError) => {
        toast.error("Couldn't inspect that nested element", {
          description: errorMessage(selectionError),
        });
      });
    },
    [active, activeTool, folder, workspaceId],
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
      // A new gesture owns the draft; a previous creation's hand-off ends.
      creationHandoffRef.current += 1;
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

  const creationHandoffRef = useRef(0);
  const hideCreationDraft = useCallback(() => {
    creationHandoffRef.current += 1;
    if (creationDraftRef.current) {
      creationDraftRef.current.style.display = "none";
    }
  }, []);
  /** A created frame paints only once its document or pixels are ready. Keep
   * the drawn rectangle until then so the canvas never blinks empty; a new
   * gesture, retirement or a 2 s bound ends the hand-off. */
  const hideCreationDraftWhenPainted = useCallback((file: string) => {
    const token = ++creationHandoffRef.current;
    const started = performance.now();
    const tick = () => {
      if (creationHandoffRef.current !== token) return;
      const article = frameElementsRef.current.get(file);
      const painted = article?.querySelector(
        'iframe[data-design-document-buffer="displayed"][data-design-document-ready], [data-design-source-ready], [data-design-frame-pixels-ready]',
      );
      if (painted || !article?.isConnected && performance.now() - started > 250 || performance.now() - started > 2_000) {
        hideCreationDraft();
        return;
      }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  }, [hideCreationDraft]);
  useLayoutEffect(() => {
    if (!active) hideCreationDraft();
  }, [active, hideCreationDraft]);

  /** A frame drawn inside a document belongs to its nearest frame container.
   * A capable runtime paints the child on release and adopts the saved
   * generation in place, so Layers and the inspector show the new layer at
   * once and its document never reloads. */
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
      let preview: { runtime: DesignFrameRuntimeConnection; nodeId: string } | null = null;
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
        const { operations, insert, parentStyles } = designFrameInsertion(
          parent,
          nodeId,
          start,
          end,
        );
        if (
          runtime.supports("previewInsert") &&
          runtime.sourceVersion === owner.sourceVersion &&
          parent.sourceVersion === owner.sourceVersion
        ) {
          try {
            const painted = await runtime.previewInsert({
              inserts: [insert],
              ...(parentStyles ? { updates: [{ nodeId: parent.oid, styles: parentStyles }] } : {}),
            });
            preview = { runtime, nodeId };
            hideCreationDraft();
            const store = useDesignRuntimeStore.getState();
            store.publishSnapshot(workspaceId, folder, owner.file, painted.snapshot, owner.sourceVersion);
            if (
              designWorkspaceView(workspaceId).selectedFrame === selection.selectedFrame &&
              designWorkspaceView(workspaceId).selectedNodeId === selection.selectedNodeId
            ) {
              void selectDesignNode({
                workspaceId,
                folder,
                frame: owner,
                nodeId,
                details: painted.details[0],
                owner: canvasPageOwner,
              }).catch(() => {});
            }
          } catch {
            // The saved document still gains the child; it simply reloads.
            preview = null;
          }
        }
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
          { runtimeInserts: [insert] },
        );
        const current = designWorkspaceView(workspaceId);
        const nextFrame = result.snapshot?.frames.find(
          (frame) => frame.file === owner.file,
        );
        if (
          nextFrame &&
          (!canvasPageOwner || isCurrentDesignPageOwner(canvasPageOwner)) &&
          ((current.selectedFrame === selection.selectedFrame &&
            current.selectedNodeId === selection.selectedNodeId) ||
            (preview && current.selectedFrame === owner.file && current.selectedNodeId === nodeId))
        ) {
          // Publish identity immediately; the adopted (or incoming) runtime
          // supplies the new node's exact-generation details.
          void selectDesignNode({
            workspaceId,
            folder,
            frame: nextFrame,
            nodeId,
            owner: canvasPageOwner,
            reveal: !preview,
          }).catch(() => {});
        }
      } catch (error) {
        if (preview) {
          const { runtime, nodeId } = preview;
          void runtime.clearPreviewInserts([nodeId]).then(({ snapshot }) => {
            useDesignRuntimeStore.getState().publishSnapshot(workspaceId, folder, owner.file, snapshot, owner.sourceVersion);
          }).catch(() => {});
          const current = designWorkspaceView(workspaceId);
          if (current.selectedFrame === owner.file && current.selectedNodeId === nodeId) {
            const store = useDesignWorkspaceUiStore.getState();
            if (selection.selectedFrame === null) store.setSelectedFrame(workspaceId, null, canvasPageOwner);
            else store.setSelection(
              workspaceId,
              selection.selectedFrame,
              selection.selectedNodeId,
              selection.selectedNodeIds,
              { owner: canvasPageOwner, frameSelected: selection.frameSelected },
            );
          }
        }
        toast.error("Couldn't create the child frame", {
          description: errorMessage(error),
        });
      } finally {
        creatingFrameRef.current = false;
        setCreatingFrame(false);
      }
    },
    [canvasPageOwner, folder, hideCreationDraft, workspaceId],
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
      const ownerDescription = frameViews.find((frame) => frame.file === ownerFile && frame.kind !== "text");
      // A still-preparing parent must never turn a child creation into a new
      // top-level frame. Selecting it schedules preparation first.
      if (ownerDescription && !isPreparedDesignFrame(ownerDescription)) {
        event.preventDefault(); event.stopPropagation();
        void selectDesignFrame(workspaceId, ownerDescription, { selected: true, owner: canvasPageOwner }).catch(() => {});
        return true;
      }
      const owner = ownerDescription;
      // A top-level frame stops at the storable size; a child frame is a
      // layer and has no such limit.
      const frameSizeLimit = owner ? undefined : DESIGN_FRAME_MAX_SIZE;
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
          designCanvasRectFromPoints(start, latest, frameSizeLimit),
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
          ? designCanvasRectFromPoints(start, latest, frameSizeLimit)
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
              ...frameViews.map((frame) => frame.z + 1),
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
        if (owner) {
          void createChildFrame(
            owner,
            { x: start.x - owner.x, y: start.y - owner.y },
            moved
              ? { x: latest.x - owner.x, y: latest.y - owner.y }
              : undefined,
          ).finally(hideCreationDraft);
        } else {
          // The hand-off belongs to this canvas lifetime: a reply that lands
          // after the surface hid or changed owner only clears the draft.
          const canvasLifetime = canvasLifetimeRef.current;
          void createFrame(geometry).then(
            (created) => created && canvasLifetimeRef.current === canvasLifetime
              ? hideCreationDraftWhenPainted(created.file) : hideCreationDraft(),
            hideCreationDraft,
          );
        }
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
      hideCreationDraftWhenPainted,
      paintCreationDraft,
      frameViews,
      canvasPageOwner,
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
          .setSelection(workspaceId, frame.file, null, undefined, { owner: canvasPageOwner });
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
      canvasPageOwner,
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
      const owner = captureDesignPageOwner(workspaceId);
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
        if (!isCurrentDesignPageOwner(owner)) return;
        if (!moved) {
          if (options?.onClick) options.onClick();
          else if (!additive) publishSelection(selectedDescription ?? null);
          return;
        }
        const screenRect = {
          x: Math.min(start.x, latest.x),
          y: Math.min(start.y, latest.y),
          width: Math.abs(latest.x - start.x),
          height: Math.abs(latest.y - start.y),
        };
        const camera = wheelViewportRef.current ?? designWorkspaceView(workspaceId);
        const worldRect = {
          x: (screenRect.x - camera.panX) / camera.zoom,
          y: (screenRect.y - camera.panY) / camera.zoom,
          width: screenRect.width / camera.zoom,
          height: screenRect.height / camera.zoom,
        };
        const scopeNodeId =
          options?.frame?.file === selectedFrame?.file && view.selectedNodeId
            ? designLayerParentId(selectedRuntimeTree, view.selectedNodeId)
            : null;
        void selectDesignTargetsInRect({
          workspaceId,
          folder,
          frames: frameViews,
          startFrame: options?.frame,
          additive,
          owner,
          rect: worldRect,
          scopeNodeId,
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
      selectedDescription,
      selectedFrame,
      selectedRuntimeTree,
      frameViews,
      view.selectedNodeId,
      workspaceId,
    ],
  );

  const handleViewportPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      hitStackGenerationRef.current += 1;
      setHitStackMenu(null);
      viewportRef.current?.focus({ preventScroll: true });
      // Space or middle-button drag is the hand tool everywhere on the canvas,
      // including over selection chrome that would otherwise take the press.
      if (startPan(event)) return;
      if (
        event.target instanceof Element &&
        event.target.closest("[data-design-controls]")
      ) {
        return;
      }
      if (startFrameCreation(event)) return;
      if (
        event.target === event.currentTarget &&
        startCanvasTextInsertion(event)
      ) {
        return;
      }
      if (event.target === event.currentTarget && startMarquee(event)) return;
      if (event.target === event.currentTarget) publishSelection(selectedDescription ?? null);
    },
    [
      publishSelection,
      selectedDescription,
      startFrameCreation,
      startCanvasTextInsertion,
      startMarquee,
      startPan,
    ],
  );

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      const viewport = viewportRef.current;
      if (!active || !workspaceId || !viewport) return;
      // Chrome inside the viewport owns its wheel: the tool rail never pans
      // the canvas, and the Motion timeline scrolls itself.
      if (
        event.target instanceof Element &&
        event.target.closest(
          "[data-design-canvas-tools-rail], [data-design-motion-timeline]",
        )
      ) {
        return;
      }
      if (!hasAsyncCanvasWheel()) event.preventDefault();
      if (spacingGestureRef.current || panGestureRef.current) return;
      const bounds = wheelBoundsRef.current ??= viewport.getBoundingClientRect();
      const firstWheel = wheelViewportRef.current === null;
      const zooming = event.metaKey || event.ctrlKey;
      const current = wheelViewportRef.current ?? view;
      let latest: DesignViewport;
      if (zooming) {
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
      // Paint the first native response immediately. Deferring its commit can
      // keep the main frame one refresh behind the compositor for the gesture.
      // Continued input shares a display paint. Zoom can arrive before the
      // browser's post-input hit testing and text selection update; publishing
      // its geometry there forces layout before the ordinary frame lifecycle.
      // The display callback commits density, camera and chrome together.
      // Integrate every delta before batching so clamps and anchors stay ordered.
      if (!hasAsyncCanvasWheel() || firstWheel) paintPendingWheelGesture();
      else wheelPaintFrameRef.current ??= window.requestAnimationFrame(paintPendingWheelGesture);
      // Optional captures and pictures wait until the camera rests.
      designBackgroundWork.touch();
      if (wheelSettleTimerRef.current !== null) {
        window.clearTimeout(wheelSettleTimerRef.current);
      }
      wheelSettleTimerRef.current = window.setTimeout(() => {
        wheelSettleTimerRef.current = null;
        const settled = wheelViewportRef.current;
        cancelPendingWheelGesture();
        if (settled) {
          paintDesignCanvasCamera(worldRef.current, settled, false);
          setViewport(workspaceId, settled, canvasPageOwner);
        }
      }, 80);
    },
    [active, setViewport, view, workspaceId, canvasPageOwner, paintPendingWheelGesture, cancelPendingWheelGesture],
  );
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!active || !viewport) return;
    // Native visual zoom is disabled by the host and this viewport cannot
    // scroll. Passive delivery avoids serial wheel ACKs adding a whole frame.
    // Plain browsers still require cancellation; nested controls own input in
    // both cases, and retained inactive canvases have no wheel subscription.
    viewport.addEventListener("wheel", handleWheel, { passive: hasAsyncCanvasWheel() });
    // Claim the first native pan so Chromium does not start a parallel scroll
    // sequence. Remove this blocking listener immediately: continued input
    // keeps passive delivery instead of waiting for an ACK on every wheel.
    // Zoom has no native default in this host and keeps passive ownership.
    const claimStart = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest(
        "[data-design-canvas-tools-rail], [data-design-motion-timeline]",
      )) return;
      if (spacingGestureRef.current || panGestureRef.current) return;
      if (!event.metaKey && !event.ctrlKey) event.preventDefault();
      viewport.removeEventListener("wheel", claimStart, true);
    };
    const armStart = () => {
      // An unrelated React render replaces this effect during a gesture.
      // Only settlement/cancellation may claim the start of another one.
      if (wheelViewportRef.current === null)
        viewport.addEventListener("wheel", claimStart, { capture: true, passive: false });
    };
    if (hasAsyncCanvasWheel()) {
      armWheelStartRef.current = armStart;
      armStart();
    }
    // Hit-test direct actions against the camera implied by preceding input,
    // including pan that has not reached its shared display callback yet.
    const flush = () => { if (wheelPaintFrameRef.current !== null) paintPendingWheelGesture(); };
    const directEvents = ["pointerdown", "keydown", "contextmenu", "dragover", "drop"] as const;
    for (const name of directEvents) viewport.addEventListener(name, flush, true);
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
      viewport.removeEventListener("wheel", claimStart, true);
      if (armWheelStartRef.current === armStart) armWheelStartRef.current = null;
      for (const name of directEvents) viewport.removeEventListener(name, flush, true);
    };
  }, [active, handleWheel, paintPendingWheelGesture]);

  // --- RENDER ---

  return (
    // Full bleed under the floating directory pill and Layers + Inspector
    // panel. `isolate` keeps every canvas layer (overlays, guides, Motion)
    // beneath that chrome without a global z-index.
    <div className="relative isolate min-h-0 min-w-0 flex-1 overflow-hidden">
      <div
        ref={viewportRef}
        data-design-canvas-viewport=""
        data-design-active-tool={activeTool}
        tabIndex={0}
        className={cn(
          "bg-bg2 relative size-full overflow-clip outline-none",
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
        // Entering a frame's title (or leaving it for anything else) is the
        // intent signal; movement within one element never reaches React state.
        onPointerOver={(event) => {
          if (!workspaceId || !active) return;
          const target = event.target instanceof Element ? event.target : null;
          // Only a frame's own chrome (its title) is selection intent. Passing
          // over a frame's pixels must not turn a passive frame into an editor.
          const file = target?.closest("[data-design-frame-chrome]")
            ? target.closest<HTMLElement>("[data-design-frame]")?.dataset.designFrame ?? null
            : null;
          // A selected frame already has its editor.
          if (file && view.selectedTargets.some((selected) => selected.frame === file)) return;
          noteDesignFrameIntent(workspaceId, file);
        }}
        onPointerLeave={() => {
          if (workspaceId) clearDesignFrameIntent(workspaceId);
        }}
        aria-label="Design canvas"
      >
        <div className="pointer-events-none absolute inset-0 isolate">
        <div
          ref={worldRef}
          data-design-canvas-world=""
          className="pointer-events-none absolute inset-0 origin-top-left"
          style={designCanvasCameraStyle(view)}
        >
          {snapshot && mountedFrames.map((description) => {
            const prepared = isPreparedDesignFrame(description);
            const frame = prepared ? description : description.previous;
            if (!frame) return (
              <DesignPreparingFrame key={`${workspaceId ?? "pending"}:${description.file}`}
                ref={(element) => {
                  if (element) frameElementsRef.current.set(description.file, element);
                  else frameElementsRef.current.delete(description.file);
                }}
                data-design-frame={description.file} data-design-preparing=""
                className="invisible pointer-events-none absolute"
                style={{ left: description.x, top: description.y, width: description.width, height: description.height,
                  zIndex: description.z }}
              />
            );
            const framePlaying = currentPlayback?.file === frame.file;
            const paintedFrame = frameGeometryPreviewsRef.current.get(
              `${canvasDocumentOwner}\0${frame.file}`,
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
              paintedSelectedTargets.some(target => target.frame === frame.file && !target.nodeId);
            const secondaryElements = (prepared ? view.selectedTargets : []).filter(target => target.frame === frame.file && target.nodeId &&
              !selectedElements.some(details => details.oid === target.nodeId)).map(target => secondaryTargetDetails[`${frame.file}\u0000${target.nodeId}`])
              .filter((details): details is DesignRuntimeNodeDetails => Boolean(details && details.sourceVersion === frame.sourceVersion));
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
            // The frame a drag will nest into is outlined like a selection by
            // data-design-nest-target, painted outside React (paintNestTarget).
            return (
              <article
                key={`${workspaceId ?? "pending"}:${frame.file}`}
                ref={(element) => {
                  if (element) frameElementsRef.current.set(frame.file, element);
                  else frameElementsRef.current.delete(frame.file);
                }}
                data-design-frame={frame.file}
                data-design-preparing={!prepared ? "" : undefined}
                onPointerDownCapture={(event) => {
                  if (prepared || !active || !workspaceId) return;
                  event.stopPropagation();
                  void selectDesignFrame(workspaceId, description, { selected: true, additive: event.shiftKey, owner: canvasPageOwner }).catch(() => {});
                }}
                onClickCapture={(event) => { if (!prepared) event.stopPropagation(); }}
                onDoubleClickCapture={(event) => { if (!prepared) event.stopPropagation(); }}
                onContextMenuCapture={(event) => { if (!prepared) { event.preventDefault(); event.stopPropagation(); } }}
                onPointerMoveCapture={(event) => { if (!prepared) event.stopPropagation(); }}
                onDropCapture={(event) => { if (!prepared) { event.preventDefault(); event.stopPropagation(); } }}
                data-design-frame-kind={frame.kind ?? "frame"}
                data-design-frame-playing={framePlaying ? "" : undefined}
                data-design-frame-chrome-protected={selected || frameSelectedOnly || framePlaying ||
                  renamingFrame === frame.file || secondaryElements.length > 0 ? "" : undefined}
                data-design-frame-stack-protected={framePlaying || renamingFrame === frame.file ||
                  inlineTextEdit?.frame === frame.file || view.selectedTargets.some(target => target.frame === frame.file) ? "" : undefined}
                // The camera resolves automatic controls against current geometry,
                // including gestures between React renders. Editing stays expanded.
                data-design-frame-controls={selected || frameSelectedOnly || framePlaying || renamingFrame === frame.file
                  ? "expanded" : "automatic"}
                className={cn(
                  "zd-design-frame pointer-events-auto absolute outline",
                  frame.kind === "text" ? "bg-transparent" : "bg-bg1",
                  frameSelectedOnly
                    ? "zd-design-selection-outline"
                    : frame.kind === "text"
                      ? "outline-transparent"
                      : "outline-border2",
                )}
                style={{
                  left: paintedFrame?.x ?? description.x,
                  top: paintedFrame?.y ?? description.y,
                  width: paintedFrame?.w ?? description.width,
                  height: paintedFrame?.h ?? description.height,
                  zIndex: paintedFrame?.z ?? description.z,
                  outlineWidth: frameSelectedOnly
                    ? designCanvasScreenPixels(2)
                    : frame.kind === "text"
                      ? 0
                      : designCanvasScreenPixels(1),
                }}
                onPointerDown={(event) => {
                  if (
                    !active ||
                    framePlaying ||
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
                      owner: canvasPageOwner,
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
                    framePlaying ||
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
                onPointerMove={(event) => { if (!framePlaying) scheduleCanvasHover(event, frame); }}
                onPointerLeave={() => clearCanvasHover(frame)}
                onContextMenu={(event) => { if (!framePlaying) openHitStack(event, frame); }}
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
                  <>
                    <div
                      data-design-controls
                      data-design-frame-chrome=""
                      className="absolute bottom-full left-0 flex h-7 origin-bottom-left items-center"
                      style={
                        {
                          // Reserve the 28px Play control and its 12px gap in screen space.
                          "--design-frame-label-max-width": `max(0px, calc(${frame.width}px * var(--design-canvas-zoom) - 40px))`,
                          maxWidth: "var(--design-frame-label-max-width)",
                          transform: `translateY(${designCanvasScreenPixels(-8)}) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
                        } as React.CSSProperties
                      }
                    >
                      {renamingFrame === frame.file ? (
                        <Input
                          autoFocus
                          value={renameDraft}
                          className="h-6 w-48 min-w-0 max-w-full"
                          aria-label={`Rename ${frame.title}`}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onPointerDown={(event) => event.stopPropagation()}
                          onBlur={() => void commitRename(frame)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void commitRename(frame);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              renameSettledRef.current = true;
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
                              : "text-muted-fg hover:text-fg2",
                          )}
                          onPointerDown={(event) =>
                            startFrameGesture(event, frame, "move")
                          }
                          onDoubleClick={(event) => {
                            event.stopPropagation();
                            renameSettledRef.current = false;
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
                    <div
                      data-design-controls
                      data-design-frame-chrome=""
                      className="absolute right-0 bottom-full origin-bottom-right"
                      style={{ transform: `translateY(${designCanvasScreenPixels(-8)}) scale(${DESIGN_CANVAS_INVERSE_ZOOM})` }}
                    >
                      <DesignToolbarButton
                        data-design-frame-play={frame.file}
                        label={`Play ${frame.title}`}
                        tooltip={framePlaying ? "Stop playback (Esc)" : "Play frame"}
                        className="zd-frame-play"
                        tool
                        pressed={framePlaying}
                        disabled={!active || !workspaceId || !folder || Boolean(inlineTextEdit || renamingFrame)}
                        onPointerDown={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (currentPlayback?.file === frame.file) {
                            stopFramePlayback(currentPlayback.id);
                            return;
                          }
                          if (!workspaceId || !canvasPageOwner) return;
                          gestureCancelRef.current?.();
                          activateTool("select");
                          onMotionTimelineOpenChange(false);
                          setHitStackMenu(null);
                          clearCanvasHover(frame);
                          // Selection is published synchronously before its
                          // durable bridge write; Play never waits on that I/O.
                          void selectDesignFrame(workspaceId, frame, { selected: false, owner: canvasPageOwner }).catch(() => {});
                          const session = { id: crypto.randomUUID(), owner: playbackOwner,
                            file: frame.file, sourceVersion: frame.sourceVersion,
                            selectionEvent: designWorkspaceView(workspaceId).selectionEvent };
                          currentPlaybackRef.current = session;
                          setPlaybackSession(session);
                        }}
                      >
                        <Play />
                      </DesignToolbarButton>
                    </div>
                  </>
                ) : null}

                {workspaceId && folder ? (
                  <DesignFrameRenderSurface
                    workspaceId={workspaceId}
                    protocolCapability={snapshot.protocolCapability}
                    folder={folder}
                    frame={frame}
                    active={active}
                    playbackSessionId={framePlaying ? currentPlayback.id : null}
                    onPlaybackStopped={stopFramePlayback}
                    selected={selected && !framePlaying}
                    selectedNodeIds={
                      selected ? view.selectedNodeIds : EMPTY_NODE_IDS
                    }
                    live={prepared && liveFrameFiles.has(frame.file)}
                    sourceSurface={sourceFrameFiles.has(frame.file)}
                    sourceReadOnly={!prepared}
                    onSourceReady={sourceSurfaceReady}
                    onSourceUnavailable={sourceSurfaceUnavailable}
                    onSourceRetired={sourceSurfaceRetired}
                    theme={frameTheme}
                    highResolutionTile={
                      highResolutionTiles.get(frame.file) ?? null
                    }
                    highResolutionDisabled={
                      sourceFrameFiles.has(frame.file) || framePlaying || inlineTextEdit?.frame === frame.file || savedEditingState > 0 && nativePixels
                    }
                    designDirectory={snapshot.directory}
                    previewOwner={previewOwner}
                    previewLevel={previewLevels.get(frame.file) ?? "overview"}
                  />
                ) : (
                  <div className="bg-bg2 text-muted-fg flex size-full items-center justify-center text-xs">
                    Preparing {frame.title}…
                  </div>
                )}

                {workspaceId && !framePlaying && frame.kind !== "text" ? (
                  <DesignAgentDraftFrameOverlay
                    workspaceId={workspaceId}
                    directory={snapshot.directory}
                    frame={frame}
                    live={prepared && liveFrameFiles.has(frame.file)}
                    active={active}
                    theme={frameTheme}
                  />
                ) : null}

                {secondaryElements.map(details => (
                  <div key={details.oid} data-design-secondary-selection={details.oid}
                    className="zd-design-selection-outline pointer-events-none absolute z-1 outline"
                    style={{ ...designSelectionOverlayStyle(designSelectionOverlayFrame(designSelectionBox(details))), outlineWidth: designCanvasScreenPixels(2) }} />
                ))}

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
                      className="zd-design-selection-label text-2xxs absolute top-full left-1/2 rounded-sm px-1.5 py-0.5 leading-4 font-medium whitespace-nowrap tabular-nums"
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

                {workspaceId && !framePlaying ? (
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
                selectedElements.length === 1 &&
                designConstraintGuidesApply({
                  hasParent: true,
                  position: selectedElement.styles.position,
                  // A fixed box is positioned against the viewport unless an
                  // ancestor creates its containing block (transform, filter…).
                  parentIsContainingBlock:
                    selectedElement.styles.position === "fixed"
                      ? selectedElement.layout?.fixedContainingBlock !==
                        "ancestor"
                      : selectedElement.layout?.isContainingBlock,
                }) &&
                (!measurePressed || gestureCancelRef.current !== null) &&
                inlineTextEdit?.frame !== frame.file ? (
                  <DesignConstraintGuides
                    nodeId={selectedElement.oid}
                    box={designSelectionBox(selectedElement)}
                    reference={parentElement && selectedElement.styles.position !== "fixed" ? designConstraintReferenceGeometry(parentElement) : undefined}
                    outlineBox={parentElement && selectedElement.styles.position !== "fixed" ? designSelectionBox(parentElement) : undefined}
                    bounds={designSelectionBoxBounds(
                      designSelectionBox(selectedElement),
                    )}
                    parentRect={
                      selectedElement.styles.position === "fixed" &&
                      selectedElement.layout?.fixedContainingBlock !== "parent"
                        ? {
                            x: 0,
                            y: 0,
                            width: frame.width,
                            height: frame.height,
                          }
                        : designConstraintReferenceRect(
                            parentGuideRect,
                            parentElement?.styles,
                          )
                    }
                    outlineRect={
                      parentElement &&
                      (selectedElement.styles.position !== "fixed" ||
                        selectedElement.layout?.fixedContainingBlock ===
                          "parent")
                        ? parentGuideRect
                        : undefined
                    }
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
                      data-design-layout-owner={details.oid}
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
                            ownerKey={designLayoutToolsKey(
                              workspaceId ?? "",
                              frame.file,
                              details.oid,
                            )}
                            details={details}
                            children={childGeometryDetails}
                            zoom={view.zoom}
                            showSize={selectedElements.length === 1}
                            sizeModes={designSizeBadgeModes(details)}
                            sizeWidth={overlayFrame.width}
                            sizeHeight={overlayFrame.height}
                            onSpacingPointerDown={
                              selectedElements.length === 1 &&
                              activeTool === "select"
                                ? (event, control) =>
                                    startInlineSpacingGesture(
                                      event,
                                      frame,
                                      details,
                                      control,
                                    )
                                : undefined
                            }
                            onSpacingCommit={(_control, styles) =>
                              commitInlineSpacing(frame, details, styles)
                            }
                          />
                          {selectedElements.length === 1 ? (
                            <>
                              <span
                                data-design-rotation-feedback=""
                                className="bg-inverted-bg text-inverted-fg text-2xxs pointer-events-none absolute top-full right-full hidden rounded-sm px-1.5 py-0.5 leading-4 font-medium whitespace-nowrap tabular-nums"
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
                                onEdgeDoubleClick={(handle, fill) =>
                                  sizeEdgeToContent(
                                    frame,
                                    details,
                                    handle,
                                    fill,
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

                {frameSelectedOnly &&
                frameLayoutOwnerDetails &&
                workspaceId &&
                activeTool === "select" &&
                inlineTextEdit?.frame !== frame.file &&
                ["flex", "inline-flex", "grid", "inline-grid"].includes(
                  frameLayoutOwnerDetails.styles.display ?? "",
                ) ? (
                  <div
                    data-design-layout-owner={frameLayoutOwnerDetails.oid}
                    data-design-frame-layout-owner=""
                    className="pointer-events-none absolute"
                    style={{
                      ...designSelectionOverlayStyle(
                        designSelectionOverlayFrame(
                          designSelectionBox(frameLayoutOwnerDetails),
                        ),
                      ),
                      zIndex: 2,
                    }}
                  >
                    <span
                      data-design-spacing-hover-zone=""
                      className="pointer-events-auto absolute inset-0"
                      aria-hidden="true"
                    />
                    <DesignSelectionMeasurements
                      ownerKey={designLayoutToolsKey(
                        workspaceId,
                        frame.file,
                        frameLayoutOwnerDetails.oid,
                      )}
                      details={frameLayoutOwnerDetails}
                      children={childGeometryDetails}
                      zoom={view.zoom}
                      showSize={false}
                      sizeWidth={frameLayoutOwnerDetails.rect.width}
                      sizeHeight={frameLayoutOwnerDetails.rect.height}
                      onSpacingPointerDown={(event, control) =>
                        startInlineSpacingGesture(
                          event,
                          frame,
                          frameLayoutOwnerDetails,
                          control,
                        )
                      }
                      onSpacingCommit={(_control, styles) =>
                        commitInlineSpacing(
                          frame,
                          frameLayoutOwnerDetails,
                          styles,
                        )
                      }
                    />
                  </div>
                ) : null}

                {frameSelectedOnly ? (
                  <span
                    data-design-frame-size-badge=""
                    data-design-size-modes={
                      designFrameSizeModes(frameLayoutOwnerDetails) ?? undefined
                    }
                    className="zd-design-selection-label text-2xxs pointer-events-none absolute top-full left-1/2 z-[3] rounded-sm px-1.5 py-0.5 leading-4 font-medium whitespace-nowrap tabular-nums"
                    style={{
                      marginTop: designCanvasScreenPixels(4),
                      transform: `translateX(-50%) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
                      transformOrigin: "top center",
                    }}
                  >
                    {designSizeBadgeText(
                      paintedFrame?.w ?? frame.width,
                      paintedFrame?.h ?? frame.height,
                      designFrameSizeModeValues(frameLayoutOwnerDetails),
                    )}
                  </span>
                ) : null}

                {frameSelectedOnly ? (
                  <DesignResizeHandles
                    label={frame.title}
                    onPointerDown={(event, handle) =>
                      startFrameGesture(event, frame, handle)
                    }
                    onEdgeDoubleClick={(handle) => {
                      // A canvas frame hugs its root; it has no parent to fill.
                      if (frameLayoutOwnerDetails)
                        sizeEdgeToContent(
                          frame,
                          frameLayoutOwnerDetails,
                          handle,
                          false,
                        );
                    }}
                  />
                ) : null}
              </article>
            );
          })}
          {workspaceId && snapshot ? (
            <DesignAgentDraftGhosts
              workspaceId={workspaceId}
              directory={snapshot.directory}
              pages={snapshot.pages}
              activePageId={view.activePageId}
              frames={frameViews}
              active={active}
              theme={frameTheme}
            />
          ) : null}
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
              className="zd-design-selection-label text-2xxs absolute bottom-full left-0 origin-bottom-left rounded-sm px-1.5 py-0.5 leading-4 font-medium whitespace-nowrap tabular-nums"
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
        </div>

        <div
          ref={marqueeRef}
          data-design-marquee=""
          className="zd-design-selection-border zd-design-selection-fill pointer-events-none absolute z-40 hidden border"
          aria-hidden="true"
        />

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
              className="w-60"
              onPointerDown={(event) => event.stopPropagation()}
              onEntryFocus={(event) => {
                // This pointer-driven picker has always focused its deepest
                // layer first. Keep that origin for subsequent arrow keys.
                event.preventDefault();
                if (event.target instanceof HTMLElement) {
                  event.target
                    .querySelector<HTMLElement>('[role="menuitem"]')
                    ?.focus({ preventScroll: true });
                }
              }}
              loop
            >
              <ContextMenuLabel className="text-muted-fg text-3xxs">
                Select layer
              </ContextMenuLabel>
              {hitStackMenu.layers.map((layer, index) => {
                const kind = designRuntimeLayerLabel({ tag: layer.tag });
                const Glyph =
                  kind === "Text" ? Type : kind === "Image" ? ImageIcon : Frame;
                return (
                  <ContextMenuItem
                    key={layer.oid}
                    className={cn(
                      "min-w-0",
                      view.selectedNodeId === layer.oid && "text-fg1",
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
                    <Glyph />
                    <span className="min-w-0 flex-1 truncate">
                      {layer.name}
                    </span>
                    {index > 0 ? (
                      <span className="text-muted-fg text-3xxs tabular-nums">
                        ↑{index}
                      </span>
                    ) : null}
                  </ContextMenuItem>
                );
              })}
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => {
                  setHitStackMenu(null);
                  void selectDesignFrame(workspaceId!, hitStackMenu.frame, {
                    selected: true,
                    reveal: true,
                  });
                }}
              >
                <Frame />
                <span className="min-w-0 flex-1 truncate">
                  {hitStackMenu.frame.title}
                </span>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : null}

        <DesignMotionTimeline
          key={motionOverlayOwner}
          open={motionTimelineOpen}
          ownerKey={selectedFrame?.file ?? "frame"}
          sessionOwnerKey={motionOverlayOwner}
          details={motionNodeDetails}
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

        {/* The tool rail floats at the canvas's left edge, centred in the
            space between the directory pill and the Motion timeline. Its
            track ignores the pointer, so only the tools themselves are
            chrome and the canvas beside them stays directly editable. It
            shares the timeline's layer and follows it, so a canvas too short
            for both keeps every tool on top and reachable. */}
        <div
          data-design-canvas-tools-rail=""
          data-motion-open={motionTimelineOpen ? "" : undefined}
          className="zd-design-tools-rail pointer-events-none absolute left-2 z-chrome flex items-center"
        >
          <Toolbar
            data-design-controls
            role="toolbar"
            aria-label="Canvas tools"
            aria-orientation="vertical"
            className="zd-design-floating-toolbar zd-canvas-toolbar pointer-events-auto flex-col"
          >
            <DesignToolbarButton
              label="Select"
              tooltip="Move"
              shortcut="V"
              tooltipSide="right"
              tool
              pressed={activeTool === "select"}
              aria-keyshortcuts="V"
              onClick={() => activateTool("select")}
            >
              <MousePointer2 />
            </DesignToolbarButton>
            <DesignToolbarButton
              label="Frame tool"
              tooltip={creatingFrame ? "Creating frame…" : "Frame"}
              shortcut="F"
              tooltipSide="right"
              tool
              pressed={activeTool === "frame"}
              disabled={!workspaceId || creatingFrame}
              aria-keyshortcuts="F"
              onClick={() => activateTool("frame")}
            >
              <Frame />
            </DesignToolbarButton>
            <DesignToolbarButton
              label="Text tool"
              tooltip="Text"
              shortcut="T"
              tooltipSide="right"
              tool
              pressed={activeTool === "text"}
              disabled={!workspaceId}
              aria-keyshortcuts="T"
              onClick={() => activateTool("text")}
            >
              <Type />
            </DesignToolbarButton>
            <span className="zd-canvas-toolbar-divider" aria-hidden="true" />
            <DesignToolbarButton
              ref={themeEditorTriggerRef}
              data-design-theme-trigger
              label="Open theme editor"
              tooltip={`Themes · ${themeView.label(view.activeTheme)}`}
              shortcut="⌥T"
              tooltipSide="right"
              disabled={!workspaceId || !selectedFrame}
              aria-haspopup="dialog"
              aria-expanded={themeEditorOpen}
              aria-keyshortcuts="Alt+T"
              onClick={() => setThemeEditorOpen((current) => !current)}
            >
              <Palette />
            </DesignToolbarButton>
            <DesignToolbarButton
              label="Toggle motion timeline"
              tooltip="Motion"
              shortcut="⇧A"
              tooltipSide="right"
              pressed={motionTimelineOpen}
              disabled={!workspaceId || !selectedFrame || !motionTargetSelected}
              aria-keyshortcuts="Shift+A"
              onClick={() => onMotionTimelineOpenChange(!motionTimelineOpen)}
            >
              <Diamond />
            </DesignToolbarButton>
          </Toolbar>
        </div>

        {workspaceId && snapshot ? (
          <DesignAgentActivityChip
            workspaceId={workspaceId}
            directory={snapshot.directory}
            pages={snapshot.pages}
            activePageId={view.activePageId}
            frames={frameViews}
            active={active}
            motionOpen={motionTimelineOpen}
            onReveal={revealAgentTarget}
          />
        ) : null}

        <DesignThemeEditor
          workspaceId={workspaceId}
          workspaceFolder={folder}
          directory={snapshot?.directory ?? null}
          frame={selectedFrame}
          tokens={snapshot?.tokens ?? []}
          tokenSourceVersion={snapshot?.tokenSourceVersion ?? null}
          styleSources={snapshot?.styleSources}
          styleSourceErrors={snapshot?.styleSourceErrors}
          themeNames={snapshot?.themes}
          activeTheme={view.activeTheme === baseThemeId ? null : view.activeTheme}
          active={active}
          open={themeEditorOpen}
          onOpenChange={setThemeEditorOpenWithFocus}
          onActiveThemeChange={changeActiveTheme}
        />
      </div>
    </div>
  );
}
