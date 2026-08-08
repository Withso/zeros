// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas and structured design inspector
// USED IN: MainShellBody in place of the code workspace's Workbench
// ============================================

// --- IMPORTS ---

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./design-workspace-ui.css";
import {
  AlertTriangle,
  Boxes,
  Code2,
  Copy,
  Diamond,
  FileCode2,
  Frame,
  Minus,
  MousePointer2,
  Palette,
  Plus,
  Redo2,
  RotateCw,
  Save,
  SlidersHorizontal,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";

import type {
  DesignRuntimeNodeDetails,
  DesignRuntimeTreeNode,
} from "@zeros/protocol/design-runtime";
import {
  designParameterDocumentId,
  type DesignComponentDefinition,
  type DesignOperation,
  type DesignParameter,
  type DesignParameterValue,
  type DesignTransaction,
} from "@zeros/design-core";
import type { DesignStyleProvenance } from "@zeros/design-web";

import { exportDesignPng } from "../../platform/design";
import { shellOpenUrl } from "../../platform/app";
import { CreatePrButton } from "../../shell/pr/create-pr-button";
import { WorkbenchToggleButton } from "../../shell/workbench/toggle-button";
import {
  type DesignCanvasFrameWire,
  type DesignFrameGeometryWire,
  type DesignLintReportWire,
  type DesignWorkspaceSnapshotWire,
  type Workspace,
} from "../../platform/git";
import { isEditableHotkeyTarget } from "../../shell/editable-target";
import {
  blockingDesignLintReason,
  groupDesignLintViolations,
  lintReviewBadgeLabel,
} from "./design-lint-summary";
import {
  createDesignFrameAndRefresh,
  deleteDesignFrameCached,
  duplicateDesignFrameCached,
  insertDesignAssetCached,
  applyDesignHistoryCached,
  applyDesignTransactionCached,
  renameDesignFrameAndRefresh,
  saveDesigns,
  setDesignNodeTextCached,
  updateDesignFrameGeometryCached,
  updateDesignNodeStylesCached,
  warmDesignFrameDocument,
  designFoundationCache,
  designFoundationKey,
  fetchDesignFoundation,
} from "./state/design-workspace-cache";
import {
  clearDesignNodeStylePreview,
  clearDesignNodeStylePreviewTransient,
  captureDesignRuntimeScreenshot,
  hoverDesignNode,
  hoverDesignNodeAtLocation,
  inspectDesignNode,
  inspectDesignNodeAtLocation,
  inspectDesignNodesInRect,
  inspectDesignNodeStyleProvenance,
  previewDesignNodeStyles,
  previewDesignNodeMotionTransient,
  previewDesignNodeStylesTransient,
  selectDesignFrame,
  selectDesignNode,
  selectDesignNodes,
  selectDesignNodeAtLocation,
  toggleDesignNodeSelection,
} from "./state/design-selection";
import { useDesignRuntimeStore } from "./state/design-runtime-store";
import {
  useDesignWorkspaceUiStore,
  useDesignWorkspaceView,
  validateDesignWorkspaceSelection,
} from "./state/design-workspace-ui";
import { useDesignWorkspaceSnapshot } from "./state/use-design-workspace";
import { useDesignFoundation } from "./state/use-design-foundation";
import { useDesignFrameDocument } from "./state/use-design-frame-document";
import { clearWorkspaceSettling } from "../../state/pending-workspaces";
import { cn } from "../../shared/ui/cn";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  CodeBlock,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Toolbar,
  Tooltip,
  toast,
} from "../../shared/ui/primitives";
import {
  designCssSizeAfterResize,
  designSelectionClickIntent,
  designSpacingMeasurements,
  designPointerRotation,
  fitDesignRects,
  resizeDesignRect,
  resizeDesignRectWithinBounds,
  snapDesignRect,
  snapDesignResizeRect,
  retainLiveDesignFrameFiles,
  selectLiveDesignFrameFiles,
  settleDesignFrameGesture,
  zoomDesignViewportAtPoint,
  type DesignViewport,
  type DesignResizeHandle,
} from "./design-canvas-math";
import {
  beginInlineTextCommit,
  cancelInlineTextCommit,
  createInlineTextCommitGuard,
  finishInlineTextCommit,
} from "./design-inline-text-commit";
import { DesignFrameRuntimeIframe } from "./design-frame-runtime-iframe";
import { hasDesignAssetDrag, readDesignAssetDrag } from "./design-assets";
import { DesignThemeEditor } from "./design-theme-editor";
import { DesignStyleEditor } from "./design-style-editor";
import {
  DesignMotionTimeline,
  designMotionPreviewInput,
  type DesignMotionTimelineDraft,
} from "./design-motion-timeline";
import { canEditDesignNodeText } from "./design-node-capabilities";
import {
  formatDesignTransform,
  parseDesignTransform,
} from "./design-effect-values";
import {
  designStyleFieldValue,
  isDesignRuntimeStylePropertyAuthored,
  resolveDesignNumericExpression,
  scrubDesignNumericValue,
  withDesignPositionContext,
} from "./design-style-values";
import {
  designLayerChildId,
  designLayerPathIds,
  designLayerParentId,
  designLayerPeerIds,
  designLayerSiblingId,
  designLayerTopLevelSelectionIds,
  flattenDesignLayerTree,
} from "./design-layer-tree";

// --- TYPES ---

interface DesignWorkspaceColumnProps {
  /** Confirmed design workspace; null while an optimistic create is landing. */
  workspace: Workspace | null;
  /** Exact destination path used for the snapshot refresh key. */
  folder: string | null;
  /** Hidden retained shells must not read, poll, focus, or attach shortcuts. */
  surfaceActive: boolean;
  /** Mirrors Workbench collapse without destroying canvas DOM. */
  collapsed?: boolean;
  /** Open-state panel collapse action shared with the code workspace. */
  onToggleWorkbench: () => void;
}

interface DesignCanvasProps {
  /** Exact workspace owner for selection and mutations. */
  workspaceId: string | null;
  /** Exact folder owner for runtime selection context and screenshots. */
  folder: string | null;
  /** Confirmed aggregate snapshot retained during refreshes. */
  snapshot: DesignWorkspaceSnapshotWire | undefined;
  /** Cold-load state only; refreshes leave the existing canvas visible. */
  loading: boolean;
  /** Latest bridge failure while the last confirmed snapshot remains usable. */
  error: unknown;
  /** Re-run the aggregate read without clearing confirmed data. */
  refresh: () => void;
  /** Whether keyboard, wheel, and pointer interactions are currently allowed. */
  active: boolean;
  motionTimelineOpen: boolean;
  onMotionTimelineOpenChange: (open: boolean) => void;
}

interface DesignInspectorProps {
  /** Full workspace metadata supplies the existing shared PR workflow. */
  workspace: Workspace | null;
  workspaceId: string | null;
  folder: string | null;
  /** Selected frame document, or null for an empty canvas selection. */
  frame: DesignCanvasFrameWire | null;
  /** Browser-computed values for the exact selected frame/element key. */
  details: DesignRuntimeNodeDetails | null;
  /** Stable element identity; null means the frame itself is selected. */
  selectedNodeId: string | null;
  /** Primary-first additive selection for group styling feedback. */
  selectedNodeIds: readonly string[];
  /** Deterministic document lint result from the aggregate snapshot. */
  lint: DesignLintReportWire | null;
  active: boolean;
  onToggleWorkbench: () => void;
  onOpenMotionTimeline: () => void;
}

type FrameGestureMode = "move" | DesignResizeHandle;
type DesignCanvasTool = "select" | "text";

interface InlineTextEdit {
  frame: string;
  nodeId: string;
  sourceVersion: string;
  draft: string;
}

interface CanvasHitStackMenu {
  frame: DesignCanvasFrameWire;
  x: number;
  y: number;
  layers: Array<{ oid: string; name: string; tag: string }>;
}

interface InspectorProvenanceState {
  ownerKey: string;
  property: string;
  loading: boolean;
  value: DesignStyleProvenance | null;
  error: string | null;
}

function designParameterText(value: DesignParameterValue): string {
  if (value === null) return "";
  return String(value);
}

function parseDesignParameterDraft(
  parameter: DesignParameter,
  draft: string,
): DesignParameterValue {
  if (parameter.type === "number") {
    const value = Number(draft);
    if (!Number.isFinite(value)) throw new Error("Enter a finite number.");
    return value;
  }
  if (
    (parameter.type === "length" || parameter.type === "angle") &&
    typeof parameter.value === "number"
  ) {
    const value = Number(draft);
    if (!Number.isFinite(value)) throw new Error("Enter a finite number.");
    return value;
  }
  return draft;
}

// --- CONSTANTS ---

const DESIGN_COLUMN_CLS =
  "border-border1 relative flex min-h-0 min-w-[min(456px,66%)] overflow-hidden border-l bg-bg1 [flex:calc((1_-_var(--zeros-design-column-2-ratio,0.2))*100)_1_0px]";
const MIN_FRAME_WIDTH = 240;
const MIN_FRAME_HEIGHT = 160;
const COLD_BUSY_DELAY_MS = 180;
const MAX_LIVE_DESIGN_FRAMES = 12;
const EMPTY_DESIGN_TREE: readonly DesignRuntimeTreeNode[] = Object.freeze([]);
const EMPTY_NODE_DETAILS: readonly DesignRuntimeNodeDetails[] = Object.freeze(
  [],
);
const EMPTY_NODE_IDS: readonly string[] = Object.freeze([]);
const EMPTY_NODE_DETAILS_BY_ID: Readonly<
  Record<string, DesignRuntimeNodeDetails>
> = Object.freeze({});

// --- WORKFLOWS ---

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The design could not load.";
}

function frameGeometry(frame: DesignCanvasFrameWire): DesignFrameGeometryWire {
  return {
    x: frame.x,
    y: frame.y,
    w: frame.width,
    h: frame.height,
    z: frame.z,
  };
}

/** Pointer gestures paint the one frame DOM node directly and commit once. */
function paintFrameGeometry(
  element: HTMLElement,
  geometry: DesignFrameGeometryWire,
): void {
  element.style.left = `${geometry.x}px`;
  element.style.top = `${geometry.y}px`;
  element.style.width = `${geometry.w}px`;
  element.style.height = `${geometry.h}px`;
  element.style.zIndex = String(geometry.z);
}

const DESIGN_RESIZE_HANDLES: ReadonlyArray<{
  handle: DesignResizeHandle;
  x: "left" | "center" | "right";
  y: "top" | "center" | "bottom";
  cursor: string;
}> = [
  { handle: "nw", x: "left", y: "top", cursor: "nwse-resize" },
  { handle: "n", x: "center", y: "top", cursor: "ns-resize" },
  { handle: "ne", x: "right", y: "top", cursor: "nesw-resize" },
  { handle: "e", x: "right", y: "center", cursor: "ew-resize" },
  { handle: "se", x: "right", y: "bottom", cursor: "nwse-resize" },
  { handle: "s", x: "center", y: "bottom", cursor: "ns-resize" },
  { handle: "sw", x: "left", y: "bottom", cursor: "nesw-resize" },
  { handle: "w", x: "left", y: "center", cursor: "ew-resize" },
];

function DesignResizeHandles({
  zoom,
  label,
  onPointerDown,
}: {
  zoom: number;
  label: string;
  onPointerDown: (
    event: React.PointerEvent<HTMLButtonElement>,
    handle: DesignResizeHandle,
  ) => void;
}) {
  const size = 8 / zoom;
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {DESIGN_RESIZE_HANDLES.map(({ handle, x, y, cursor }) => (
        <button
          key={handle}
          data-design-controls
          type="button"
          className="border-highlighted-bright bg-bg1 pointer-events-auto absolute rounded-[1px] border"
          style={{
            width: size,
            height: size,
            left: x === "left" ? 0 : x === "center" ? "50%" : "100%",
            top: y === "top" ? 0 : y === "center" ? "50%" : "100%",
            transform: "translate(-50%, -50%)",
            cursor,
            borderWidth: 1 / zoom,
          }}
          aria-label={`Resize ${label} from ${handle}`}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onPointerDown(event, handle);
          }}
        />
      ))}
    </div>
  );
}

function DesignRotateHandle({
  zoom,
  label,
  onPointerDown,
}: {
  zoom: number;
  label: string;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
}) {
  const size = 18 / zoom;
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <span
        className="bg-highlighted-bright absolute bottom-full left-full h-px origin-left rotate-[-45deg]"
        style={{ width: 14 / zoom }}
        aria-hidden="true"
      />
      <button
        data-design-controls
        type="button"
        className="border-highlighted-bright bg-bg1 text-highlighted-bright pointer-events-auto absolute bottom-full left-full flex items-center justify-center rounded-full border shadow-sm"
        style={{
          width: size,
          height: size,
          marginBottom: 10 / zoom,
          marginLeft: 10 / zoom,
          borderWidth: 1 / zoom,
          cursor: "grab",
        }}
        aria-label={`Rotate ${label}`}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onPointerDown(event);
        }}
      >
        <RotateCw style={{ width: 10 / zoom, height: 10 / zoom }} />
      </button>
    </div>
  );
}

function designPixelValue(value: string | undefined): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value?.trim() ?? "");
  return match?.[1] ? Math.max(0, Number(match[1])) : 0;
}

function DesignSelectionMeasurements({
  details,
  peers,
  showSpacing,
  zoom,
}: {
  details: DesignRuntimeNodeDetails;
  peers: readonly DesignRuntimeNodeDetails[];
  showSpacing: boolean;
  zoom: number;
}) {
  const top = Math.min(
    details.rect.height / 2,
    designPixelValue(details.styles.paddingTop),
  );
  const right = Math.min(
    details.rect.width / 2,
    designPixelValue(details.styles.paddingRight),
  );
  const bottom = Math.min(
    details.rect.height / 2,
    designPixelValue(details.styles.paddingBottom),
  );
  const left = Math.min(
    details.rect.width / 2,
    designPixelValue(details.styles.paddingLeft),
  );
  const display = details.styles.display;
  const gap = designPixelValue(details.styles.gap);
  const measurements = showSpacing
    ? designSpacingMeasurements(
        details.rect,
        peers.map((peer) => peer.rect),
      )
    : [];
  const strips = [
    {
      key: "top",
      visible: top > 0,
      style: { top: 0, left: 0, right: 0, height: top },
    },
    {
      key: "right",
      visible: right > 0,
      style: { top, right: 0, bottom, width: right },
    },
    {
      key: "bottom",
      visible: bottom > 0,
      style: { right: 0, bottom: 0, left: 0, height: bottom },
    },
    {
      key: "left",
      visible: left > 0,
      style: { top, bottom, left: 0, width: left },
    },
  ];
  return (
    <>
      {strips.map((strip) =>
        showSpacing && strip.visible ? (
          <span
            key={strip.key}
            className="bg-red-primary/20 pointer-events-none absolute"
            style={strip.style}
          />
        ) : null,
      )}
      {measurements.map((measurement) => {
        const horizontal = measurement.axis === "horizontal";
        return (
          <span
            key={measurement.side}
            data-design-spacing={measurement.side}
            className="bg-red-primary pointer-events-none absolute"
            style={{
              left: measurement.x - details.rect.x,
              top: measurement.y - details.rect.y,
              width: horizontal ? measurement.length : 1 / zoom,
              height: horizontal ? 1 / zoom : measurement.length,
            }}
          >
            <span
              className="bg-bg1 text-red-primary border-red-primary/50 absolute rounded-sm border px-1 font-mono text-[9px] leading-4 whitespace-nowrap"
              style={{
                left: horizontal ? "50%" : 0,
                top: horizontal ? 0 : "50%",
                transform: horizontal
                  ? `translate(-50%, -50%) scale(${1 / zoom})`
                  : `translate(-50%, -50%) scale(${1 / zoom})`,
                transformOrigin: "center",
              }}
            >
              {Math.round(measurement.distance)}
            </span>
          </span>
        );
      })}
      <span
        className="bg-inverted-bg text-inverted-fg pointer-events-none absolute top-full left-1/2 -translate-x-1/2 rounded-sm px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap"
        style={{
          marginTop: 4 / zoom,
          transform: `translateX(-50%) scale(${1 / zoom})`,
          transformOrigin: "top center",
        }}
      >
        {Math.round(details.rect.width)} × {Math.round(details.rect.height)}
      </span>
      {display === "flex" || display === "grid" ? (
        <span
          className="border-highlighted-bright bg-bg1 text-highlighted-bright pointer-events-none absolute right-0 bottom-full rounded-sm border px-1.5 py-0.5 font-mono text-[9px] whitespace-nowrap"
          style={{
            marginBottom: 4 / zoom,
            transform: `scale(${1 / zoom})`,
            transformOrigin: "bottom right",
          }}
        >
          {display === "flex" ? "Auto layout" : "Grid"}
          {gap > 0 ? ` · gap ${Math.round(gap)}` : ""}
        </span>
      ) : null}
    </>
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
// COMPONENT: DesignFrameRenderSurface
// PURPOSE: Swap far frame runtimes for exact-generation raster snapshots
// USED IN: DesignCanvas
// ============================================

function DesignFrameRenderSurface({
  workspaceId,
  protocolCapability,
  folder,
  frame,
  active,
  selected,
  live,
  theme,
}: {
  workspaceId: string;
  protocolCapability: string | null;
  folder: string;
  frame: DesignCanvasFrameWire;
  active: boolean;
  selected: boolean;
  live: boolean;
  theme: string | null;
}) {
  const screenshot = useDesignRuntimeStore(
    (state) =>
      state.byWorkspace[workspaceId]?.frames[frame.file]?.screenshotsByNode[""],
  );
  if (live) {
    return (
      <DesignFrameRuntimeIframe
        workspaceId={workspaceId}
        protocolCapability={protocolCapability}
        folder={folder}
        frame={frame}
        active={active}
        selected={selected}
        autoCapture
        theme={theme}
      />
    );
  }
  if (screenshot?.sourceVersion === frame.sourceVersion) {
    return (
      <img
        src={screenshot.dataUrl}
        alt=""
        draggable={false}
        className="pointer-events-none block size-full object-fill"
      />
    );
  }
  return (
    <div className="bg-bg2 text-fg3 pointer-events-none flex size-full items-center justify-center gap-2 text-xs">
      <FileCode2 />
      <span className="max-w-48 truncate">{frame.title}</span>
    </div>
  );
}

// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Native canvas and inspector beside the design-only Layers sidebar
// USED IN: MainShellBody
// ============================================

// --- STATE ---

export function DesignWorkspaceColumn({
  workspace,
  folder,
  surfaceActive,
  collapsed = false,
  onToggleWorkbench,
}: DesignWorkspaceColumnProps) {
  const [motionTimelineOpen, setMotionTimelineOpen] = useState(false);
  const workspaceId = workspace?.kind === "design" ? workspace.id : null;
  const snapshot = useDesignWorkspaceSnapshot(
    workspaceId,
    folder,
    surfaceActive && !collapsed,
  );
  const selectedFrameFile = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.selectedFrame ?? null)
      : null,
  );
  const selectedNodeId = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.selectedNodeId ?? null)
      : null,
  );
  const selectedNodeIds = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.selectedNodeIds ?? EMPTY_NODE_IDS)
      : EMPTY_NODE_IDS,
  );

  const frameFiles = useMemo(
    () => snapshot.data?.frames.map((frame) => frame.file) ?? [],
    [snapshot.data?.frames],
  );
  const selectedFrame = useMemo(
    () =>
      snapshot.data?.frames.find((frame) => frame.file === selectedFrameFile) ??
      snapshot.data?.frames[0] ??
      null,
    [selectedFrameFile, snapshot.data?.frames],
  );
  const selectedDetails = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame) return null;
    const runtimeFrame =
      state.byWorkspace[workspaceId]?.frames[selectedFrame.file];
    return selectedNodeId
      ? (runtimeFrame?.detailsByNode[selectedNodeId] ?? null)
      : (runtimeFrame?.snapshot?.frame ?? null);
  });

  // Validate against authoritative data in layout, so a removed remembered
  // frame never paints as a visibly incomplete selection.
  useLayoutEffect(() => {
    if (!workspaceId || !snapshot.data) return;
    validateDesignWorkspaceSelection(workspaceId, frameFiles);
  }, [frameFiles, snapshot.data, workspaceId]);

  // A freshly provisioned design surface is ready when its first exact-key
  // snapshot either resolves or fails open; code-only settling UI must not
  // remain latched for this folder.
  useEffect(() => {
    if (!workspace || !folder || (!snapshot.data && !snapshot.error)) return;
    clearWorkspaceSettling(folder);
  }, [folder, snapshot.data, snapshot.error, workspace]);

  // --- RENDER ---

  return (
    <section
      {...(collapsed || !surfaceActive ? { inert: "" } : {})}
      data-design-workspace-surface=""
      className={DESIGN_COLUMN_CLS}
      style={collapsed ? { display: "none" } : undefined}
      aria-hidden={collapsed}
      aria-label="Design workspace"
    >
      <DesignCanvas
        workspaceId={workspaceId}
        folder={folder}
        snapshot={snapshot.data}
        loading={snapshot.loading}
        error={snapshot.error}
        refresh={snapshot.refresh}
        active={surfaceActive && !collapsed}
        motionTimelineOpen={motionTimelineOpen}
        onMotionTimelineOpenChange={setMotionTimelineOpen}
      />
      <DesignInspector
        workspace={workspace}
        workspaceId={workspaceId}
        folder={folder}
        frame={selectedFrame}
        details={selectedDetails}
        selectedNodeId={selectedNodeId}
        selectedNodeIds={selectedNodeIds}
        lint={snapshot.data?.lint ?? null}
        active={surfaceActive && !collapsed}
        onToggleWorkbench={onToggleWorkbench}
        onOpenMotionTimeline={() => setMotionTimelineOpen(true)}
      />
    </section>
  );
}

// ============================================
// COMPONENT: DesignCanvas
// PURPOSE: Pan, zoom, select, create, move, resize, rename, and inspect source
// USED IN: DesignWorkspaceColumn
// ============================================

function DesignCanvas({
  workspaceId,
  folder,
  snapshot,
  loading,
  error,
  refresh,
  active,
  motionTimelineOpen,
  onMotionTimelineOpenChange,
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
  const selectedDetailsByNode = useDesignRuntimeStore((state) =>
    workspaceId && selectedFrame
      ? (state.byWorkspace[workspaceId]?.frames[selectedFrame.file]
          ?.detailsByNode ?? EMPTY_NODE_DETAILS_BY_ID)
      : EMPTY_NODE_DETAILS_BY_ID,
  );
  const selectedNodeDetailsList = useMemo(
    () =>
      view.selectedNodeIds.length === 0
        ? EMPTY_NODE_DETAILS
        : view.selectedNodeIds.flatMap((nodeId) => {
            const details = selectedDetailsByNode[nodeId];
            return details ? [details] : [];
          }),
    [selectedDetailsByNode, view.selectedNodeIds],
  );
  const selectedRuntimeTree = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame) return EMPTY_DESIGN_TREE;
    return (
      state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.snapshot
        ?.tree ?? EMPTY_DESIGN_TREE
    );
  });
  const selectedParentId = useMemo(
    () =>
      view.selectedNodeId
        ? designLayerParentId(selectedRuntimeTree, view.selectedNodeId)
        : null,
    [selectedRuntimeTree, view.selectedNodeId],
  );
  const parentOutlineOwner = `${selectedFrame?.file ?? ""}\u0000${selectedFrame?.sourceVersion ?? ""}\u0000${selectedParentId ?? ""}`;
  const [parentOutlineState, setParentOutlineState] = useState<{
    owner: string;
    details: DesignRuntimeNodeDetails | null;
  }>({ owner: "", details: null });
  const parentOutlineDetails =
    parentOutlineState.owner === parentOutlineOwner
      ? parentOutlineState.details
      : null;
  const selectedPeerIds = useMemo(
    () =>
      view.selectedNodeId
        ? designLayerPeerIds(selectedRuntimeTree, view.selectedNodeId)
        : [],
    [selectedRuntimeTree, view.selectedNodeId],
  );
  const peerGeometryOwner = `${selectedFrame?.file ?? ""}\u0000${selectedFrame?.sourceVersion ?? ""}\u0000${view.selectedNodeId ?? ""}\u0000${selectedPeerIds.join("\u0001")}`;
  const [peerGeometryState, setPeerGeometryState] = useState<{
    owner: string;
    details: DesignRuntimeNodeDetails[];
  }>({ owner: "", details: [] });
  const peerGeometryDetails =
    peerGeometryState.owner === peerGeometryOwner
      ? peerGeometryState.details
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
        if (!cancelled) setParentOutlineState({ owner, details });
      })
      .catch(() => {
        if (!cancelled) setParentOutlineState({ owner, details: null });
      });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    parentOutlineOwner,
    selectedFrame,
    selectedParentId,
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
        inspectDesignNode({ workspaceId, frame: selectedFrame, nodeId }).catch(
          () => null,
        ),
      ),
    ).then((details) => {
      if (cancelled) return;
      setPeerGeometryState({
        owner,
        details: details.filter(
          (candidate): candidate is DesignRuntimeNodeDetails =>
            Boolean(
              candidate?.visible &&
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
    selectedFrame,
    selectedPeerIds,
    view.selectedNodeId,
    workspaceId,
  ]);
  const hoveredFrame = useDesignRuntimeStore(
    (state) =>
      (workspaceId ? state.byWorkspace[workspaceId]?.hoveredFrame : null) ??
      null,
  );
  const hoveredNodeId = useDesignRuntimeStore(
    (state) =>
      (workspaceId ? state.byWorkspace[workspaceId]?.hoveredNodeId : null) ??
      null,
  );
  const hoveredNodeDetails = useDesignRuntimeStore((state) => {
    if (!workspaceId || !hoveredFrame || !hoveredNodeId) return null;
    return (
      state.byWorkspace[workspaceId]?.frames[hoveredFrame]?.detailsByNode[
        hoveredNodeId
      ] ?? null
    );
  });
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
  const marqueeRef = useRef<HTMLDivElement | null>(null);
  const verticalGuideRef = useRef<HTMLDivElement | null>(null);
  const horizontalGuideRef = useRef<HTMLDivElement | null>(null);
  // Space state is mirrored in a ref so pointer handlers read the current key.
  const spacePressedRef = useRef(false);
  // Drives the grab cursor without publishing transient state globally.
  const [spacePressed, setSpacePressed] = useState(false);
  // Option/Alt reveals exact sibling spacing without permanently cluttering
  // the selection overlay.
  const [measurePressed, setMeasurePressed] = useState(false);
  // Current viewport pixels drive the bounded live-iframe window.
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  // Disables duplicate frame-create mutations while the exact request runs.
  const [creatingFrame, setCreatingFrame] = useState(false);
  // Owns the one inline rename editor; the filename remains stable.
  const [renamingFrame, setRenamingFrame] = useState<string | null>(null);
  // Keeps the draft isolated from the authoritative frame title.
  const [renameDraft, setRenameDraft] = useState("");
  // Tool choice is interaction-local; only semantic frame/node selection is durable.
  const [activeTool, setActiveTool] = useState<DesignCanvasTool>("select");
  // The theme matrix is a persistent non-modal tool window launched from the
  // canvas toolbar, so it may coexist with canvas and inspector work.
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);
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
  const [nodeAction, setNodeAction] = useState<"duplicate" | "delete" | null>(
    null,
  );
  const [hitStackMenu, setHitStackMenu] = useState<CanvasHitStackMenu | null>(
    null,
  );
  const hitStackGenerationRef = useRef(0);
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
          position: string;
          left: number;
          top: number;
        }>;
        dx: number;
        dy: number;
      }
    | {
        mode: "resize";
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
  const liveFrameFilesRef = useRef<{
    owner: string;
    files: ReadonlySet<string>;
  }>({ owner: "", files: new Set() });
  const liveFrameOwner = `${workspaceId ?? ""}\0${folder ?? ""}`;
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
  const publishSelection = useCallback(
    (frame: DesignCanvasFrameWire | null) => {
      if (!workspaceId) return;
      void selectDesignFrame(workspaceId, frame).catch((selectionError) => {
        toast.error("Couldn't update the design selection", {
          description: errorMessage(selectionError),
        });
      });
    },
    [workspaceId],
  );

  // The first authoritative fallback is a real selection too: publish it so
  // get_selection agrees with the inspector before the user clicks anything.
  useEffect(() => {
    if (!active || !snapshot) return;
    if (view.selectedNodeId) return;
    publishSelection(selectedFrame);
  }, [active, publishSelection, selectedFrame, snapshot, view.selectedNodeId]);

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
      if (next) setViewport(workspaceId, next);
    },
    [setViewport, workspaceId],
  );

  /** Zoom about a screen point so the content beneath it does not jump. */
  const zoomAt = useCallback(
    (nextZoom: number, point?: { x: number; y: number }) => {
      if (!workspaceId) return;
      const bounds = viewportRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const anchor = point ?? {
        x: bounds.width / 2,
        y: bounds.height / 2,
      };
      const next = zoomDesignViewportAtPoint(view, nextZoom, anchor);
      setViewport(workspaceId, next);
    },
    [setViewport, view, workspaceId],
  );

  /** Frame creation returns the aggregate snapshot, avoiding a follow-up read. */
  const createFrame = useCallback(async () => {
    if (!workspaceId || creatingFrame) return;
    setCreatingFrame(true);
    try {
      const result = await createDesignFrameAndRefresh(workspaceId);
      const created = result.snapshot.frames.find(
        (frame) => frame.file === result.frame.file,
      );
      if (created) {
        publishSelection(created);
        fitFrames([created]);
      }
    } catch (createError) {
      toast.error("Couldn't create a design frame", {
        description: errorMessage(createError),
      });
    } finally {
      setCreatingFrame(false);
    }
  }, [creatingFrame, fitFrames, publishSelection, workspaceId]);

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
    async (edit: InlineTextEdit) => {
      const key = `${edit.frame}\u0000${edit.nodeId}\u0000${edit.sourceVersion}`;
      if (!beginInlineTextCommit(textCommitGuardRef.current, edit, key)) return;
      setInlineTextEdit((current) => (current === edit ? null : current));
      if (!workspaceId) {
        finishInlineTextCommit(textCommitGuardRef.current, key);
        return;
      }
      try {
        await setDesignNodeTextCached(workspaceId, {
          frame: edit.frame,
          nodeId: edit.nodeId,
          sourceVersion: edit.sourceVersion,
          text: edit.draft,
        });
      } catch (textError) {
        toast.error("Couldn't edit the design text", {
          description: errorMessage(textError),
        });
      } finally {
        finishInlineTextCommit(textCommitGuardRef.current, key);
      }
    },
    [workspaceId],
  );

  /** Text targeting is one-shot. Once an editable leaf is found, return to
   * Select while the independent inline editor owns keyboard input. */
  const finishInlineTextTool = useCallback(
    (frame: DesignCanvasFrameWire, details: DesignRuntimeNodeDetails) => {
      setActiveTool("select");
      setInlineTextEdit({
        frame: frame.file,
        nodeId: details.oid,
        sourceVersion: frame.sourceVersion,
        draft: details.text ?? "",
      });
    },
    [],
  );

  const cancelInlineTextEditing = useCallback((edit: InlineTextEdit) => {
    cancelInlineTextCommit(textCommitGuardRef.current, edit);
    setInlineTextEdit(null);
    setActiveTool("select");
    window.requestAnimationFrame(() => {
      viewportRef.current?.focus({ preventScroll: true });
    });
  }, []);

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
    ) => {
      const foundation = canvasFoundation.data;
      if (
        !workspaceId ||
        !folder ||
        !selectedFrame ||
        !foundation ||
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
      setNodeAction(action);
      try {
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
                ? `Duplicate ${nodeIds.length} selected ${nodeIds.length === 1 ? "layer" : "layers"}`
                : `Delete ${nodeIds.length} selected ${nodeIds.length === 1 ? "layer" : "layers"}`,
            createdAt: Date.now(),
            operations,
          },
        );
        if (action === "duplicate") {
          useDesignWorkspaceUiStore
            .getState()
            .setSelection(
              workspaceId,
              selectedFrame.file,
              duplicateNodeIds[0]!,
              duplicateNodeIds,
            );
          toast.success(
            nodeIds.length === 1 ? "Element duplicated" : "Elements duplicated",
          );
        } else {
          const currentFrame =
            result.snapshot?.frames.find(
              (candidate) => candidate.file === selectedFrame.file,
            ) ?? selectedFrame;
          await selectDesignFrame(workspaceId, currentFrame);
          toast.success(
            nodeIds.length === 1 ? "Element deleted" : "Elements deleted",
          );
        }
      } finally {
        nodeActionRef.current = false;
        setNodeAction(null);
      }
    },
    [canvasFoundation.data, folder, selectedFrame, workspaceId],
  );

  const duplicateSelectedNode = useCallback(async () => {
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
      await applyCanvasNodeOperation("duplicate", nodeIds, duplicateNodeIds);
    } catch (error) {
      toast.error("Couldn't duplicate the element", {
        description: errorMessage(error),
      });
    }
  }, [applyCanvasNodeOperation, selectedRuntimeTree, view.selectedNodeIds]);

  const deleteSelectedNode = useCallback(async () => {
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
  }, [applyCanvasNodeOperation, selectedRuntimeTree, view.selectedNodeIds]);

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
      if (!workspaceId || !selectedFrame || !selectedNodeDetails) return;
      await previewDesignNodeMotionTransient({
        workspaceId,
        frame: selectedFrame.file,
        sourceVersion: selectedFrame.sourceVersion,
        nodeId: selectedNodeDetails.oid,
        motion: designMotionPreviewInput(draft, currentTime, playing),
      });
    },
    [selectedFrame, selectedNodeDetails, workspaceId],
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
            styles: {
              position: node.position,
              left: `${node.left + gesture.dx}px`,
              top: `${node.top + gesture.dy}px`,
            },
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
              frame: selectedFrame,
              nodeId: selectedNodeDetails.oid,
              width: Math.max(1, selectedNodeDetails.rect.width),
              height: Math.max(1, selectedNodeDetails.rect.height),
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
        styles: {
          width: `${Math.max(1, Math.round(gesture.width + gesture.dw))}px`,
          height: `${Math.max(1, Math.round(gesture.height + gesture.dh))}px`,
        },
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
            styles: {
              position: node.position,
              left: `${node.left + gesture.dx}px`,
              top: `${node.top + gesture.dy}px`,
            },
          }))
        : [
            {
              nodeId: gesture.nodeId,
              styles: {
                width: `${Math.max(1, Math.round(gesture.width + gesture.dw))}px`,
                height: `${Math.max(1, Math.round(gesture.height + gesture.dh))}px`,
              },
            },
          ];
    const foundation = canvasFoundation.data;
    const commit =
      updates.length === 1
        ? updateDesignNodeStylesCached(workspaceId, {
            frame: gesture.frame.file,
            nodeId: updates[0]!.nodeId,
            sourceVersion: gesture.frame.sourceVersion,
            styles: updates[0]!.styles,
          })
        : foundation
          ? applyDesignTransactionCached(workspaceId, gesture.frame.file, {
              schemaVersion: 1,
              transactionId: `desktop:${crypto.randomUUID()}`,
              documentId: foundation.summary.documentId,
              baseRevision: foundation.summary.revision,
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
            })
          : Promise.reject(
              new Error("The selected design document is still loading."),
            );
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
  }, [canvasFoundation.data, workspaceId]);

  /** Move/resize previews paint one node; release publishes one engine write. */
  const startFrameGesture = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      frame: DesignCanvasFrameWire,
      mode: FrameGestureMode,
    ) => {
      if (!workspaceId || !active || !event.isPrimary || event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      publishSelection(frame);
      const element = event.currentTarget.closest<HTMLElement>(
        "[data-design-frame]",
      );
      if (!element) return;
      const start = frameGeometry(frame);
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
        const dx = (pointerEvent.clientX - startX) / view.zoom;
        const dy = (pointerEvent.clientY - startY) / view.zoom;
        if (!moved && Math.hypot(dx, dy) < 3 / view.zoom) return;
        moved = true;
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
                    : snapDesignRect(moving, peers, 6 / view.zoom);
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
                    : snapDesignResizeRect(resized, mode, peers, 6 / view.zoom);
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
        void settleDesignFrameGesture(
          updateDesignFrameGeometryCached(workspaceId, frame.file, latest),
          start,
          (geometry) => paintFrameGeometry(element, geometry),
        ).catch((geometryError) => {
          toast.error("Couldn't update the frame geometry", {
            description: errorMessage(geometryError),
          });
        });
      };

      const cancel = () => {
        paintFrameGeometry(element, start);
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
          ? "grabbing"
          : (DESIGN_RESIZE_HANDLES.find((item) => item.handle === mode)
              ?.cursor ?? "nwse-resize");
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
    },
    [active, publishSelection, snapshot?.frames, view.zoom, workspaceId],
  );

  /** Move or resize one authored element with RAF-coalesced runtime preview
   * and one provenance-aware source transaction at pointer release. */
  const startNodeRotation = useCallback(
    (
      event: React.PointerEvent<HTMLButtonElement>,
      frame: DesignCanvasFrameWire,
      details: DesignRuntimeNodeDetails,
    ) => {
      if (!workspaceId || !active || !event.isPrimary || event.button !== 0) {
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
      const bounds = overlay.getBoundingClientRect();
      const center = {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      };
      const start = { x: event.clientX, y: event.clientY };
      const base = parseDesignTransform(details.styles.transform ?? "none");
      const feedback = overlay.querySelector<HTMLElement>(
        "[data-design-rotation-feedback]",
      );
      let latestTransform = formatDesignTransform(base);
      let moved = false;
      let stopped = false;
      let previewFrame: number | null = null;
      let previewInFlight = false;
      let previewQueued = false;
      const previewInput = {
        workspaceId,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
        nodeId: details.oid,
      };
      const requestPreview = () => {
        if (stopped || previewInFlight) {
          previewQueued = !stopped;
          return;
        }
        previewInFlight = true;
        void previewDesignNodeStylesTransient({
          ...previewInput,
          styles: { transform: latestTransform },
        })
          .catch(() => {})
          .finally(() => {
            previewInFlight = false;
            if (!stopped && previewQueued) {
              previewQueued = false;
              requestPreview();
            }
          });
      };
      const schedulePreview = () => {
        previewQueued = true;
        if (previewFrame !== null) return;
        previewFrame = window.requestAnimationFrame(() => {
          previewFrame = null;
          previewQueued = false;
          requestPreview();
        });
      };
      const move = (pointerEvent: PointerEvent) => {
        const delta = designPointerRotation(
          center,
          start,
          { x: pointerEvent.clientX, y: pointerEvent.clientY },
          pointerEvent.shiftKey ? 15 : 0,
        );
        if (!moved && Math.abs(delta) < 0.2) return;
        moved = true;
        const rotate = Math.round((base.rotate + delta) * 10) / 10;
        latestTransform = formatDesignTransform({ ...base, rotate });
        overlay.style.transform = `rotate(${delta}deg)`;
        overlay.style.transformOrigin = "center";
        if (feedback) {
          feedback.style.display = "block";
          feedback.textContent = `${rotate}°`;
        }
        schedulePreview();
      };
      const cleanup = () => {
        stopped = true;
        previewQueued = false;
        if (previewFrame !== null) {
          window.cancelAnimationFrame(previewFrame);
          previewFrame = null;
        }
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        if (pointerOwner.hasPointerCapture?.(pointerId)) {
          pointerOwner.releasePointerCapture(pointerId);
        }
        overlay.style.transform = "";
        overlay.style.transformOrigin = "";
        if (feedback) feedback.style.display = "none";
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
      };
      const restore = () => {
        void clearDesignNodeStylePreviewTransient(previewInput).catch(() => {});
      };
      const finish = () => {
        cleanup();
        if (!moved) return;
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
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
    },
    [active, workspaceId],
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
      const pixelOffset = (value: string | undefined) => {
        const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value?.trim() ?? "");
        return match?.[1] ? Number(match[1]) : 0;
      };
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
        left: pixelOffset(details.styles.left),
        top: pixelOffset(details.styles.top),
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
      let stopped = false;
      let previewFrame: number | null = null;
      let previewInFlight = false;
      let previewQueued = false;
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
          styles: {
            position: start.position,
            left: `${Math.round(start.left + delta.x)}px`,
            top: `${Math.round(start.top + delta.y)}px`,
          },
        }));
      const requestPreview = () => {
        if (stopped || previewInFlight) {
          previewQueued = !stopped;
          return;
        }
        previewInFlight = true;
        void Promise.all(
          updates().map((update) =>
            previewDesignNodeStylesTransient({
              workspaceId,
              frame: frame.file,
              sourceVersion: frame.sourceVersion,
              nodeId: update.nodeId,
              styles: update.styles,
            }),
          ),
        )
          .catch(() => {})
          .finally(() => {
            previewInFlight = false;
            if (!stopped && previewQueued) {
              previewQueued = false;
              requestPreview();
            }
          });
      };
      const schedulePreview = () => {
        previewQueued = true;
        if (previewFrame !== null) return;
        previewFrame = window.requestAnimationFrame(() => {
          previewFrame = null;
          previewQueued = false;
          requestPreview();
        });
      };
      const paint = () => {
        for (const start of starts) {
          if (!start.overlay) continue;
          start.overlay.style.left = `${start.details.rect.x + delta.x}px`;
          start.overlay.style.top = `${start.details.rect.y + delta.y}px`;
        }
      };
      const restore = () => {
        for (const start of starts) {
          if (start.overlay) {
            start.overlay.style.left = `${start.details.rect.x}px`;
            start.overlay.style.top = `${start.details.rect.y}px`;
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
        const rawX = (pointerEvent.clientX - startX) / view.zoom;
        const rawY = (pointerEvent.clientY - startY) / view.zoom;
        if (!moved && Math.hypot(rawX, rawY) < 3 / view.zoom) return;
        moved = true;
        const moving = {
          ...groupBounds,
          x: groupBounds.x + rawX,
          y: groupBounds.y + rawY,
        };
        const snapped =
          pointerEvent.metaKey || pointerEvent.ctrlKey
            ? { rect: moving, guides: {} }
            : snapDesignRect(moving, peerRects, 6 / view.zoom);
        delta = {
          x: snapped.rect.x - groupBounds.x,
          y: snapped.rect.y - groupBounds.y,
        };
        paintGuides(snapped.guides);
        paint();
        schedulePreview();
      };
      const cleanup = () => {
        stopped = true;
        previewQueued = false;
        if (previewFrame !== null) {
          window.cancelAnimationFrame(previewFrame);
          previewFrame = null;
        }
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
      parentOutlineDetails,
      peerGeometryDetails,
      view.zoom,
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
      const pixelOffset = (value: string | undefined) => {
        const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value?.trim() ?? "");
        return match?.[1] ? Number(match[1]) : 0;
      };
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
        left: pixelOffset(details.styles.left),
        top: pixelOffset(details.styles.top),
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
      let stopped = false;
      let previewFrame: number | null = null;
      let previewInFlight = false;
      let previewQueued = false;
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
            styles: {
              position: start.position,
              left: `${Math.round(
                start.left + rect.x - start.details.rect.x,
              )}px`,
              top: `${Math.round(start.top + rect.y - start.details.rect.y)}px`,
              width: `${Math.round(
                designCssSizeAfterResize(
                  start.details.styles.width,
                  start.details.rect.width,
                  rect.width,
                ),
              )}px`,
              height: `${Math.round(
                designCssSizeAfterResize(
                  start.details.styles.height,
                  start.details.rect.height,
                  rect.height,
                ),
              )}px`,
            },
          };
        });
      const requestPreview = () => {
        if (stopped || previewInFlight) {
          previewQueued = !stopped;
          return;
        }
        previewInFlight = true;
        void Promise.all(
          updates().map((update) =>
            previewDesignNodeStylesTransient({
              workspaceId,
              frame: frame.file,
              sourceVersion: frame.sourceVersion,
              nodeId: update.nodeId,
              styles: update.styles,
            }),
          ),
        )
          .catch(() => {})
          .finally(() => {
            previewInFlight = false;
            if (!stopped && previewQueued) {
              previewQueued = false;
              requestPreview();
            }
          });
      };
      const schedulePreview = () => {
        previewQueued = true;
        if (previewFrame !== null) return;
        previewFrame = window.requestAnimationFrame(() => {
          previewFrame = null;
          previewQueued = false;
          requestPreview();
        });
      };
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
          start.overlay.style.left = `${rect.x}px`;
          start.overlay.style.top = `${rect.y}px`;
          start.overlay.style.width = `${rect.width}px`;
          start.overlay.style.height = `${rect.height}px`;
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
        const dx = (pointerEvent.clientX - startX) / view.zoom;
        const dy = (pointerEvent.clientY - startY) / view.zoom;
        if (!moved && Math.hypot(dx, dy) < 3 / view.zoom) return;
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
          : snapDesignResizeRect(raw, handle, peerRects, 6 / view.zoom);
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
        schedulePreview();
      };
      const cleanup = () => {
        stopped = true;
        previewQueued = false;
        if (previewFrame !== null) {
          window.cancelAnimationFrame(previewFrame);
          previewFrame = null;
        }
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
      parentOutlineDetails,
      peerGeometryDetails,
      view.zoom,
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
      if (!workspaceId || !active || !event.isPrimary || event.button !== 0) {
        return;
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
      event.preventDefault();
      event.stopPropagation();
      const pointerOwner = event.currentTarget;
      const pointerId = event.pointerId;
      pointerOwner.setPointerCapture?.(pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const start = {
        x: details.rect.x,
        y: details.rect.y,
        width: Math.max(1, details.rect.width),
        height: Math.max(1, details.rect.height),
      };
      let latest = start;
      let latestStyles: Record<string, string> = {};
      let moved = false;
      let stopped = false;
      let previewFrame: number | null = null;
      let previewInFlight = false;
      let previewQueued = false;
      const previewInput = {
        workspaceId,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
        nodeId: details.oid,
      };
      const computedPosition = details.styles.position || "static";
      const pixelOffset = (value: string | undefined) => {
        const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value?.trim() ?? "");
        return match?.[1] ? Number(match[1]) : 0;
      };
      const baseLeft = pixelOffset(details.styles.left);
      const baseTop = pixelOffset(details.styles.top);
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
      const stylesForRect = (rect: typeof start): Record<string, string> => {
        const offsetX = rect.x - start.x;
        const offsetY = rect.y - start.y;
        const styles: Record<string, string> = {};
        if (gestureMode !== "move") {
          styles.width = `${Math.round(
            designCssSizeAfterResize(
              details.styles.width,
              start.width,
              rect.width,
            ),
          )}px`;
          styles.height = `${Math.round(
            designCssSizeAfterResize(
              details.styles.height,
              start.height,
              rect.height,
            ),
          )}px`;
        }
        if (gestureMode === "move" || Math.abs(offsetX) > 0.01) {
          styles.position =
            computedPosition === "static" ? "relative" : computedPosition;
          styles.left = `${Math.round(baseLeft + offsetX)}px`;
        }
        if (gestureMode === "move" || Math.abs(offsetY) > 0.01) {
          styles.position =
            computedPosition === "static" ? "relative" : computedPosition;
          styles.top = `${Math.round(baseTop + offsetY)}px`;
        }
        return styles;
      };

      const requestPreview = () => {
        if (stopped || previewInFlight) {
          previewQueued = !stopped;
          return;
        }
        previewInFlight = true;
        void previewDesignNodeStylesTransient({
          ...previewInput,
          styles: latestStyles,
        })
          .catch(() => {
            // Gesture preview is speculative. Commit reports an actionable
            // error if the exact source generation is no longer writable.
          })
          .finally(() => {
            previewInFlight = false;
            if (!stopped && previewQueued) {
              previewQueued = false;
              requestPreview();
            }
          });
      };

      const schedulePreview = () => {
        previewQueued = true;
        if (previewFrame !== null) return;
        previewFrame = window.requestAnimationFrame(() => {
          previewFrame = null;
          previewQueued = false;
          requestPreview();
        });
      };

      const move = (pointerEvent: PointerEvent) => {
        const dx = (pointerEvent.clientX - startX) / view.zoom;
        const dy = (pointerEvent.clientY - startY) / view.zoom;
        if (!moved && Math.hypot(dx, dy) < 3 / view.zoom) return;
        moved = true;
        const raw =
          gestureMode === "move"
            ? { ...start, x: start.x + dx, y: start.y + dy }
            : resizeDesignRect(start, dx, dy, gestureMode, {
                minWidth: 1,
                minHeight: 1,
                keepAspect: pointerEvent.shiftKey,
                fromCenter: pointerEvent.altKey,
              });
        const snappingDisabled =
          pointerEvent.metaKey ||
          pointerEvent.ctrlKey ||
          (gestureMode !== "move" &&
            (pointerEvent.shiftKey || pointerEvent.altKey));
        const snapped = snappingDisabled
          ? { rect: raw, guides: {} }
          : gestureMode === "move"
            ? snapDesignRect(raw, peerRects, 6 / view.zoom)
            : snapDesignResizeRect(raw, gestureMode, peerRects, 6 / view.zoom);
        latest = snapped.rect;
        paintGuides(snapped.guides);
        latestStyles = stylesForRect(latest);
        overlay.style.left = `${latest.x}px`;
        overlay.style.top = `${latest.y}px`;
        overlay.style.width = `${latest.width}px`;
        overlay.style.height = `${latest.height}px`;
        schedulePreview();
      };

      const cleanup = () => {
        stopped = true;
        previewQueued = false;
        if (previewFrame !== null) {
          window.cancelAnimationFrame(previewFrame);
          previewFrame = null;
        }
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
        overlay.style.left = `${start.x}px`;
        overlay.style.top = `${start.y}px`;
        overlay.style.width = `${start.width}px`;
        overlay.style.height = `${start.height}px`;
        void clearDesignNodeStylePreviewTransient(previewInput).catch(() => {});
      };

      const finish = () => {
        cleanup();
        if (!moved) {
          if (gestureMode !== "move" || !folder) return;
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
          const frameElement = overlay.closest<HTMLElement>(
            "[data-design-frame]",
          );
          const bounds = frameElement?.getBoundingClientRect();
          if (!bounds) return;
          const mode =
            event.metaKey || event.ctrlKey
              ? "deepest"
              : event.detail > 1
                ? "descend"
                : "preserve";
          void selectDesignNodeAtLocation({
            workspaceId,
            folder,
            frame,
            x: ((event.clientX - bounds.left) * frame.width) / bounds.width,
            y: ((event.clientY - bounds.top) * frame.height) / bounds.height,
            mode,
            selectedNodeId: view.selectedNodeId,
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
      finishInlineTextTool,
      folder,
      parentOutlineDetails,
      peerGeometryDetails,
      selectedNodeDetailsList,
      selectedRuntimeTree,
      startNodeGroupMove,
      view.selectedNodeId,
      view.selectedNodeIds,
      view.zoom,
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
        if (worldRef.current) {
          worldRef.current.style.transform = `translate(${latest.panX}px, ${latest.panY}px) scale(${latest.zoom})`;
        }
      };

      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
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
        if (worldRef.current) {
          worldRef.current.style.transform = `translate(${start.panX}px, ${start.panY}px) scale(${start.zoom})`;
        }
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
      const viewport = viewportRef.current;
      if (
        !viewport ||
        !viewport.contains(document.activeElement) ||
        isEditableHotkeyTarget(event.target)
      ) {
        return;
      }
      if (event.key === "Escape" && hitStackMenu) {
        event.preventDefault();
        setHitStackMenu(null);
        return;
      }
      if (event.key === "Escape" && activeTool !== "select") {
        event.preventDefault();
        setActiveTool("select");
        return;
      }
      if (event.key === "Alt") {
        setMeasurePressed(true);
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
        event.key.toLowerCase() === "d" &&
        view.selectedNodeId
      ) {
        event.preventDefault();
        if (!event.repeat) void duplicateSelectedNode();
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
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key === "Backspace" || event.key === "Delete") &&
        view.selectedNodeId
      ) {
        event.preventDefault();
        if (!event.repeat) void deleteSelectedNode();
        return;
      }
      if (event.key === "Escape" && view.selectedNodeId && selectedFrame) {
        event.preventDefault();
        const parentId = designLayerParentId(
          selectedRuntimeTree,
          view.selectedNodeId,
        );
        if (parentId) navigateToNode(parentId);
        else void selectDesignFrame(workspaceId!, selectedFrame);
        return;
      }
      if (
        event.key === "Enter" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        view.selectedNodeId
      ) {
        event.preventDefault();
        if (event.shiftKey) {
          const parentId = designLayerParentId(
            selectedRuntimeTree,
            view.selectedNodeId,
          );
          if (parentId) navigateToNode(parentId);
          return;
        }
        const childId = designLayerChildId(
          selectedRuntimeTree,
          view.selectedNodeId,
        );
        if (childId) navigateToNode(childId);
        else if (selectedFrame && canEditDesignNodeText(selectedNodeDetails)) {
          setInlineTextEdit({
            frame: selectedFrame.file,
            nodeId: selectedNodeDetails.oid,
            sourceVersion: selectedFrame.sourceVersion,
            draft: selectedNodeDetails.text ?? "",
          });
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
          selectedRuntimeTree,
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
          setActiveTool("select");
          return;
        }
        if (event.key.toLowerCase() === "t") {
          event.preventDefault();
          setActiveTool("text");
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
      if (event.key === "Alt") setMeasurePressed(false);
    };
    const blur = () => {
      spacePressedRef.current = false;
      setSpacePressed(false);
      setMeasurePressed(false);
      if (nudgeGestureRef.current) finishNodeNudge();
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  }, [
    active,
    activeTool,
    deleteSelectedNode,
    duplicateSelectedNode,
    finishNodeNudge,
    fitFrames,
    hitStackMenu,
    nudgeSelectedNode,
    motionTimelineOpen,
    navigateToNode,
    onMotionTimelineOpenChange,
    resizeSelectedNode,
    selectedFrame,
    selectedNodeDetails,
    selectedRuntimeTree,
    snapshot?.frames,
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
      selectedNodeId: string | null,
    ) => {
      if (!workspaceId || !folder) return;
      const bounds = frameElement.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      void selectDesignNodeAtLocation({
        workspaceId,
        folder,
        frame,
        x: ((clientX - bounds.left) * frame.width) / bounds.width,
        y: ((clientY - bounds.top) * frame.height) / bounds.height,
        mode: "descend",
        selectedNodeId,
      }).catch((selectionError) => {
        toast.error("Couldn't inspect that nested element", {
          description: errorMessage(selectionError),
        });
      });
    },
    [folder, workspaceId],
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
      const x =
        ((clientX - frameBounds.left) * frame.width) / frameBounds.width;
      const y =
        ((clientY - frameBounds.top) * frame.height) / frameBounds.height;
      void inspectDesignNodeAtLocation({ workspaceId, frame, x, y })
        .then((details) => {
          if (!details || hitStackGenerationRef.current !== generation) return;
          const tree =
            useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
              frame.file
            ]?.snapshot?.tree ?? EMPTY_DESIGN_TREE;
          const path = designLayerPathIds(tree, details.oid);
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
          if (layers.length === 0) return;
          setHitStackMenu({
            frame,
            x: Math.min(
              Math.max(8, clientX - viewportBounds.left),
              Math.max(8, viewportBounds.width - 220),
            ),
            y: Math.min(
              Math.max(8, clientY - viewportBounds.top),
              Math.max(8, viewportBounds.height - layers.length * 28 - 48),
            ),
            layers,
          });
        })
        .catch(() => {
          // A source reload can invalidate a speculative context hit.
        });
    },
    [active, workspaceId],
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
      if (event.target === event.currentTarget && startMarquee(event)) return;
      if (event.target === event.currentTarget) publishSelection(selectedFrame);
    },
    [publishSelection, selectedFrame, startMarquee, startPan],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!active || !workspaceId) return;
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        const bounds = event.currentTarget.getBoundingClientRect();
        zoomAt(view.zoom * Math.exp(-event.deltaY * 0.002), {
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        });
        return;
      }
      const current = wheelViewportRef.current ?? view;
      const latest = {
        ...current,
        panX: current.panX - event.deltaX,
        panY: current.panY - event.deltaY,
      };
      wheelViewportRef.current = latest;
      if (worldRef.current) {
        worldRef.current.style.transform = `translate(${latest.panX}px, ${latest.panY}px) scale(${latest.zoom})`;
      }
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
    [active, setViewport, view, workspaceId, zoomAt],
  );

  // --- RENDER ---

  return (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
      <div
        ref={viewportRef}
        tabIndex={0}
        className={cn(
          "bg-bg2 relative size-full overflow-hidden outline-none",
          spacePressed ? "cursor-grab" : "cursor-default",
        )}
        // FLAG: 16px is canvas-grid geometry, not component spacing.
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--border2) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
        onPointerDown={handleViewportPointerDown}
        onWheel={handleWheel}
        aria-label="Design canvas"
      >
        <div
          ref={worldRef}
          data-design-canvas-world=""
          className="pointer-events-none absolute inset-0 origin-top-left"
          style={{
            transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
          }}
        >
          {snapshot?.frames.map((frame) => {
            const selected = selectedFrame?.file === frame.file;
            const selectedElements = selected
              ? selectedNodeDetailsList.filter(
                  (details) => details.sourceVersion === frame.sourceVersion,
                )
              : EMPTY_NODE_DETAILS;
            const selectedElement =
              selectedElements.find(
                (details) => details.oid === view.selectedNodeId,
              ) ?? null;
            const hoveredElement =
              hoveredFrame === frame.file &&
              hoveredNodeDetails?.oid === hoveredNodeId &&
              !selectedElements.some((details) => details.oid === hoveredNodeId)
                ? hoveredNodeDetails
                : null;
            const parentElement =
              selected && selectedElement ? parentOutlineDetails : null;
            const frameSelectedOnly = selected && !selectedElement;
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
            const overlayElements = [
              ...(hoveredElement ? [hoveredElement] : []),
              ...selectedElements,
            ];
            return (
              <article
                key={`${workspaceId ?? "pending"}:${frame.file}`}
                data-design-frame={frame.file}
                className={cn(
                  "bg-bg1 pointer-events-auto absolute outline",
                  frameSelectedOnly
                    ? "outline-highlighted-bright"
                    : "outline-border2",
                )}
                style={{
                  left: frame.x,
                  top: frame.y,
                  width: frame.width,
                  height: frame.height,
                  zIndex: frame.z,
                  outlineWidth: frameSelectedOnly
                    ? 2 / view.zoom
                    : 1 / view.zoom,
                }}
                onPointerDown={(event) => {
                  if (
                    !event.isPrimary ||
                    event.button !== 0 ||
                    spacePressedRef.current
                  ) {
                    return;
                  }
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
                    const mode =
                      activeTool === "text" ||
                      pointer.metaKey ||
                      pointer.ctrlKey
                        ? "deepest"
                        : pointer.detail > 1
                          ? "descend"
                          : "preserve";
                    const hitInput = {
                      workspaceId,
                      frame,
                      x: (pointer.clientX - bounds.left) * scaleX,
                      y: (pointer.clientY - bounds.top) * scaleY,
                      mode,
                      selectedNodeId: view.selectedNodeId,
                    } as const;
                    const selection = pointer.shiftKey
                      ? inspectDesignNodeAtLocation(hitInput).then((details) =>
                          details
                            ? toggleDesignNodeSelection({
                                workspaceId,
                                folder,
                                frame,
                                nodeId: details.oid,
                                details,
                              }).then(() => details)
                            : null,
                        )
                      : selectDesignNodeAtLocation({ ...hitInput, folder });
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
                    event.target instanceof Element &&
                    event.target.closest("[data-design-controls]")
                  ) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  descendAtCanvasPoint(
                    frame,
                    event.currentTarget,
                    event.clientX,
                    event.clientY,
                    view.selectedNodeId,
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
                <div
                  className="absolute bottom-full left-0 flex origin-bottom-left items-center gap-1"
                  style={{
                    transform: `translateY(${-8 / view.zoom}px) scale(${1 / view.zoom})`,
                  }}
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
                    <Button
                      type="button"
                      variant={selected ? "secondary-on" : "secondary"}
                      size="sm"
                      data-design-frame-label=""
                      className={cn(
                        "zd-design-control-quiet rounded-md",
                        selected && "zd-design-state-active",
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
                      <FileCode2 />
                      <span className="max-w-48 truncate">{frame.title}</span>
                      {selected ? (
                        <span className="text-fg3 font-mono text-[10px]">
                          {Math.round(frame.width)} × {Math.round(frame.height)}
                        </span>
                      ) : null}
                    </Button>
                  )}
                </div>

                {workspaceId && folder ? (
                  <DesignFrameRenderSurface
                    workspaceId={workspaceId}
                    protocolCapability={snapshot.protocolCapability}
                    folder={folder}
                    frame={frame}
                    active={active}
                    selected={selected}
                    live={liveFrameFiles.has(frame.file)}
                    theme={view.activeTheme}
                  />
                ) : (
                  <div className="bg-bg2 text-fg3 flex size-full items-center justify-center text-xs">
                    Preparing {frame.title}…
                  </div>
                )}

                {parentElement ? (
                  <div
                    className="border-highlighted-bright pointer-events-none absolute z-[1] border-dashed opacity-60"
                    style={{
                      left: parentElement.rect.x,
                      top: parentElement.rect.y,
                      width: parentElement.rect.width,
                      height: parentElement.rect.height,
                      borderWidth: 1 / view.zoom,
                    }}
                    aria-hidden="true"
                  >
                    <span
                      className="bg-bg1 text-highlighted-bright absolute bottom-full left-0 rounded-sm px-1 font-mono text-[9px] whitespace-nowrap"
                      style={{
                        marginBottom: 2 / view.zoom,
                        transform: `scale(${1 / view.zoom})`,
                        transformOrigin: "bottom left",
                      }}
                    >
                      {parentElement.name}
                    </span>
                  </div>
                ) : null}

                {multiSelectionBounds ? (
                  <div
                    data-design-multi-selection=""
                    data-design-resize-roots={transformElements.length}
                    className="outline-highlighted-bright pointer-events-none absolute z-[2] outline"
                    style={{
                      left: multiSelectionBounds.x,
                      top: multiSelectionBounds.y,
                      width:
                        multiSelectionBounds.right - multiSelectionBounds.x,
                      height:
                        multiSelectionBounds.bottom - multiSelectionBounds.y,
                      outlineWidth: 2 / view.zoom,
                    }}
                  >
                    <span
                      data-design-group-size=""
                      className="bg-inverted-bg text-inverted-fg absolute top-full left-1/2 rounded-sm px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap"
                      style={{
                        marginTop: 4 / view.zoom,
                        transform: `translateX(-50%) scale(${1 / view.zoom})`,
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
                      zoom={view.zoom}
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

                {overlayElements.map((details, index) => {
                  const primarySelection = details.oid === selectedElement?.oid;
                  const additiveSelection = selectedElements.some(
                    (candidate) => candidate.oid === details.oid,
                  );
                  return (
                    <div
                      key={`${index}:${details.oid}`}
                      data-design-element-overlay={details.oid}
                      className={cn(
                        "absolute touch-none outline",
                        primarySelection
                          ? "outline-highlighted-bright pointer-events-auto cursor-move"
                          : additiveSelection
                            ? "outline-highlighted-bright pointer-events-auto cursor-move"
                            : "outline-border4 pointer-events-none",
                        additiveSelection &&
                          selectionOverlaySuppressed &&
                          "opacity-0",
                      )}
                      style={{
                        left: details.rect.x,
                        top: details.rect.y,
                        width: details.rect.width,
                        height: details.rect.height,
                        zIndex: 1,
                        outlineWidth: (primarySelection ? 2 : 1) / view.zoom,
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
                      onDoubleClick={(event) => {
                        if (
                          !primarySelection ||
                          selectedElements.length !== 1 ||
                          (event.target as HTMLElement).closest(
                            "[data-design-controls]",
                          )
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
                        descendAtCanvasPoint(
                          frame,
                          frameElement,
                          event.clientX,
                          event.clientY,
                          details.oid,
                        );
                      }}
                    >
                      {primarySelection ? (
                        <>
                          <DesignSelectionMeasurements
                            details={details}
                            peers={peerGeometryDetails}
                            showSpacing={measurePressed}
                            zoom={view.zoom}
                          />
                          <div
                            data-design-controls
                            className="border-border3 bg-bg1 pointer-events-auto absolute bottom-full left-0 flex max-w-80 items-center overflow-hidden rounded-sm border shadow-sm"
                            style={{
                              transform: `translateY(${-6 / view.zoom}px) scale(${1 / view.zoom})`,
                              transformOrigin: "bottom left",
                            }}
                          >
                            <span className="text-fg1 max-w-44 truncate px-2 text-xs">
                              {selectedElements.length > 1
                                ? `${selectedElements.length} layers`
                                : `${details.name} · ${details.tag}`}
                            </span>
                            {selectedElements.length === 1 &&
                            canEditDesignNodeText(details) ? (
                              <Tooltip label="Edit text" shortcut="T">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Edit text in ${details.name}`}
                                  onPointerDown={(event) =>
                                    event.stopPropagation()
                                  }
                                  onClick={() =>
                                    setInlineTextEdit({
                                      frame: frame.file,
                                      nodeId: details.oid,
                                      sourceVersion: frame.sourceVersion,
                                      draft: details.text ?? "",
                                    })
                                  }
                                >
                                  <Type />
                                </Button>
                              </Tooltip>
                            ) : null}
                            <Tooltip label="Duplicate" shortcut="⌘D">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                disabled={nodeAction !== null}
                                aria-label={`Duplicate ${details.name}`}
                                onPointerDown={(event) =>
                                  event.stopPropagation()
                                }
                                onClick={() => void duplicateSelectedNode()}
                              >
                                <Copy />
                              </Button>
                            </Tooltip>
                            <Tooltip label="Delete" shortcut="⌫">
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                disabled={nodeAction !== null}
                                aria-label={`Delete ${details.name}`}
                                onPointerDown={(event) =>
                                  event.stopPropagation()
                                }
                                onClick={() => void deleteSelectedNode()}
                              >
                                <Trash2 />
                              </Button>
                            </Tooltip>
                          </div>
                          {selectedElements.length === 1 ? (
                            <>
                              <span
                                data-design-rotation-feedback=""
                                className="bg-inverted-bg text-inverted-fg pointer-events-none absolute top-full right-full hidden rounded-sm px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap"
                                style={{
                                  marginTop: 4 / view.zoom,
                                  marginRight: 4 / view.zoom,
                                  transform: `scale(${1 / view.zoom})`,
                                  transformOrigin: "top right",
                                }}
                              />
                              <DesignResizeHandles
                                zoom={view.zoom}
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
                              <DesignRotateHandle
                                zoom={view.zoom}
                                label={details.name}
                                onPointerDown={(event) =>
                                  startNodeRotation(event, frame, details)
                                }
                              />
                            </>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  );
                })}

                {selectedElements.length === 1 &&
                canEditDesignNodeText(selectedElement) &&
                inlineTextEdit?.frame === frame.file &&
                inlineTextEdit.nodeId === selectedElement.oid &&
                inlineTextEdit.sourceVersion === frame.sourceVersion ? (
                  <Input
                    data-design-controls
                    autoFocus
                    value={inlineTextEdit.draft}
                    aria-label={`Edit text for ${selectedElement.name}`}
                    className="border-highlighted-bright bg-bg1 absolute z-10 min-h-7 border-2"
                    style={{
                      left: selectedElement.rect.x,
                      top: selectedElement.rect.y,
                      width: Math.max(120, selectedElement.rect.width),
                      height: Math.max(28, selectedElement.rect.height),
                    }}
                    onChange={(event) => {
                      const draft = event.target.value;
                      setInlineTextEdit((current) =>
                        current ? { ...current, draft } : current,
                      );
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onBlur={() => void commitInlineText(inlineTextEdit)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void commitInlineText(inlineTextEdit);
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        cancelInlineTextEditing(inlineTextEdit);
                      }
                    }}
                  />
                ) : null}

                {frameSelectedOnly ? (
                  <DesignResizeHandles
                    zoom={view.zoom}
                    label={frame.title}
                    onPointerDown={(event, handle) =>
                      startFrameGesture(event, frame, handle)
                    }
                  />
                ) : null}
              </article>
            );
          })}
          <div
            ref={verticalGuideRef}
            data-design-guide="vertical"
            className="bg-highlighted-bright pointer-events-none absolute z-[100000] hidden"
            style={{ top: -100_000, width: 1 / view.zoom, height: 200_000 }}
            aria-hidden="true"
          />
          <div
            ref={horizontalGuideRef}
            data-design-guide="horizontal"
            className="bg-highlighted-bright pointer-events-none absolute z-[100000] hidden"
            style={{ left: -100_000, height: 1 / view.zoom, width: 200_000 }}
            aria-hidden="true"
          />
        </div>

        <div
          ref={marqueeRef}
          data-design-marquee=""
          className="border-highlighted-bright bg-highlighted-bright/10 pointer-events-none absolute z-40 hidden border"
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
          <div className="text-fg3 pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
            Loading design…
          </div>
        ) : null}

        {!workspaceId && !snapshot ? (
          <div className="text-fg3 pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
            Setting up design workspace…
          </div>
        ) : null}

        {!snapshot && error ? (
          <div
            data-design-controls
            className="absolute inset-0 flex items-center justify-center p-6"
          >
            <Alert variant="destructive" className="max-w-md">
              <AlertTriangle />
              <AlertTitle>Design unavailable</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                {errorMessage(error)}
                <Button type="button" size="sm" onClick={refresh}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {hitStackMenu ? (
          <div
            data-design-controls
            role="menu"
            aria-label="Layers under pointer"
            className="border-border2 bg-bg1 absolute z-50 w-52 overflow-hidden rounded-md border py-1 shadow-lg"
            style={{ left: hitStackMenu.x, top: hitStackMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (
                event.key !== "ArrowDown" &&
                event.key !== "ArrowUp" &&
                event.key !== "Home" &&
                event.key !== "End"
              ) {
                return;
              }
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]',
                ),
              );
              if (items.length === 0) return;
              const current = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const nextIndex =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : event.key === "ArrowUp"
                      ? (current - 1 + items.length) % items.length
                      : (current + 1) % items.length;
              event.preventDefault();
              event.stopPropagation();
              items[nextIndex]?.focus();
            }}
          >
            <div className="text-fg3 flex h-6 items-center px-2 text-[9px] font-medium tracking-wide uppercase">
              Select layer
            </div>
            {hitStackMenu.layers.map((layer, index) => (
              <button
                key={layer.oid}
                type="button"
                role="menuitem"
                autoFocus={index === 0}
                tabIndex={index === 0 ? 0 : -1}
                className={cn(
                  "hover:bg-bg2 flex h-7 w-full min-w-0 items-center gap-2 px-2 text-left",
                  view.selectedNodeId === layer.oid && "bg-highlighted-bg",
                )}
                onClick={() => {
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
                <span className="text-fg3 border-border2 shrink-0 rounded-sm border px-1 font-mono text-[8px] uppercase">
                  {layer.tag}
                </span>
                <span className="text-fg1 min-w-0 flex-1 truncate text-[11px]">
                  {layer.name}
                </span>
                <span className="text-fg3 font-mono text-[9px]">
                  {index === 0 ? "deep" : `↑${index}`}
                </span>
              </button>
            ))}
            <div className="bg-border1 my-1 h-px" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="hover:bg-bg2 flex h-7 w-full items-center gap-2 px-2 text-left"
              onClick={() => {
                setHitStackMenu(null);
                void selectDesignFrame(workspaceId!, hitStackMenu.frame);
              }}
            >
              <Frame className="text-fg3 size-3.5" />
              <span className="text-fg1 truncate text-[11px]">
                {hitStackMenu.frame.title}
              </span>
            </button>
          </div>
        ) : null}

        <DesignMotionTimeline
          key={`${selectedFrame?.sourceVersion ?? "none"}:${selectedNodeDetails?.oid ?? "frame"}:${canvasFoundation.data?.summary.revision ?? "none"}`}
          open={motionTimelineOpen}
          details={selectedNodeDetails}
          definitions={canvasFoundation.data?.foundation.keyframes ?? []}
          disabled={!active || !canvasFoundation.data}
          onOpenChange={onMotionTimelineOpenChange}
          onPreview={previewMotion}
          onClearPreview={clearMotionPreview}
          onSave={saveMotion}
        />

        <Toolbar
          data-design-controls
          role="toolbar"
          aria-label="Canvas tools"
          className={cn(
            "zd-design-floating-toolbar absolute left-1/2 -translate-x-1/2 transition-[bottom]",
            motionTimelineOpen ? "bottom-[304px]" : "bottom-4",
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
              onClick={() => setActiveTool("select")}
            >
              <MousePointer2 />
            </Button>
          </Tooltip>
          <Tooltip label={creatingFrame ? "Creating frame…" : "New frame"}>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              disabled={!workspaceId || creatingFrame}
              aria-label="New frame"
              onClick={() => void createFrame()}
            >
              <Frame />
            </Button>
          </Tooltip>
          <Tooltip label="Edit text" shortcut="T">
            <Button
              type="button"
              variant={activeTool === "text" ? "secondary-on" : "ghost"}
              size="icon-lg"
              disabled={!workspaceId || !selectedFrame}
              aria-label="Text tool"
              aria-pressed={activeTool === "text"}
              aria-keyshortcuts="T"
              onClick={() => {
                if (
                  selectedFrame &&
                  view.selectedNodeId &&
                  canEditDesignNodeText(selectedNodeDetails)
                ) {
                  finishInlineTextTool(selectedFrame, selectedNodeDetails);
                } else {
                  setActiveTool("text");
                }
              }}
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

        <Toolbar
          data-design-controls
          role="toolbar"
          aria-label="Canvas zoom"
          className={cn(
            "zd-design-floating-toolbar absolute right-4 transition-[bottom]",
            motionTimelineOpen ? "bottom-[304px]" : "bottom-4",
          )}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom out"
            onClick={() => zoomAt(view.zoom / 1.2)}
          >
            <Minus />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Fit all frames"
            onClick={() => fitFrames(snapshot?.frames ?? [])}
          >
            {Math.round(view.zoom * 100)}%
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Zoom in"
            onClick={() => zoomAt(view.zoom * 1.2)}
          >
            <Plus />
          </Button>
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
          onActiveThemeChange={(theme) => {
            if (workspaceId) setActiveTheme(workspaceId, theme);
          }}
        />
      </div>
    </div>
  );
}

interface InspectorEditFieldProps {
  label: string;
  value: string | number;
  applied?: boolean;
  disabled?: boolean;
  hint?: string;
  placeholder?: string;
  styleProperty?: string;
  onInspect?: () => void;
  onPreview?: (value: string) => Promise<unknown> | void;
  onCancelPreview?: () => Promise<unknown> | void;
  onCommit: (value: string) => Promise<unknown>;
}

function InspectorEditField({
  label,
  value,
  applied = false,
  disabled = false,
  hint,
  placeholder,
  styleProperty,
  onInspect,
  onPreview,
  onCancelPreview,
  onCommit,
}: InspectorEditFieldProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baselineRef = useRef(String(value));
  const skipCommitRef = useRef(false);
  const scrubRef = useRef<{
    pointerId: number;
    startX: number;
    startValue: string;
    latestValue: string;
  } | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const previewDirtyRef = useRef(false);
  const cancelPreviewRef = useRef(onCancelPreview);
  cancelPreviewRef.current = onCancelPreview;
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    const next = String(value);
    baselineRef.current = next;
    setDraft(next);
  }, [value]);

  useEffect(
    () => () => {
      if (previewFrameRef.current !== null) {
        window.cancelAnimationFrame(previewFrameRef.current);
      }
      if (previewDirtyRef.current) {
        previewDirtyRef.current = false;
        void Promise.resolve(cancelPreviewRef.current?.()).catch(() => {});
      }
    },
    [],
  );

  const cancelPreview = () => {
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    if (!previewDirtyRef.current) return;
    previewDirtyRef.current = false;
    void Promise.resolve(cancelPreviewRef.current?.()).catch(() => {});
  };

  const preview = (next: string) => {
    if (!onPreview) return;
    previewDirtyRef.current = true;
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
    }
    previewFrameRef.current = window.requestAnimationFrame(() => {
      previewFrameRef.current = null;
      void Promise.resolve(onPreview(next)).catch(() => {});
    });
  };

  const commit = async (requestedDraft = draft) => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      cancelPreview();
      return;
    }
    const baseline = baselineRef.current;
    if (saving) return;
    const resolvedDraft = resolveDesignNumericExpression(
      requestedDraft,
      baseline,
    );
    if (resolvedDraft !== requestedDraft) setDraft(resolvedDraft);
    if (resolvedDraft === baseline) {
      cancelPreview();
      return;
    }
    setSaving(true);
    try {
      await onCommit(resolvedDraft);
      baselineRef.current = resolvedDraft;
      cancelPreview();
    } catch (fieldError) {
      setDraft(baseline);
      cancelPreview();
      toast.error(`Couldn't update ${label.toLowerCase()}`, {
        description: errorMessage(fieldError),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative min-w-0">
      <div
        data-design-inspector-field=""
        data-design-applied={applied ? "" : undefined}
        data-design-style-property={styleProperty}
        className={cn(
          "flex h-7 min-w-0 items-center overflow-hidden rounded-sm transition-colors",
          applied ? "zd-design-control-applied" : "zd-design-control-quiet",
        )}
      >
        <button
          type="button"
          disabled={disabled || saving}
          className={cn(
            "text-fg3 hover:text-fg1 flex h-full shrink-0 cursor-ew-resize items-center justify-center text-[10px] font-medium focus-visible:outline-none disabled:cursor-default",
            label.length > 4 ? "max-w-16 min-w-10 px-1.5" : "w-7",
          )}
          title={`Drag to scrub ${label}. Option for decimals; Shift for larger steps.`}
          aria-label={`Scrub ${label}`}
          onPointerDown={(event) => {
            const startValue = baselineRef.current;
            if (scrubDesignNumericValue(startValue, 0) === null) {
              onInspect?.();
              return;
            }
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            scrubRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startValue,
              latestValue: startValue,
            };
            onInspect?.();
          }}
          onPointerMove={(event) => {
            const scrub = scrubRef.current;
            if (!scrub || scrub.pointerId !== event.pointerId) return;
            const multiplier = event.altKey ? 0.1 : event.shiftKey ? 10 : 1;
            const next = scrubDesignNumericValue(
              scrub.startValue,
              (event.clientX - scrub.startX) * multiplier,
            );
            if (next === null || next === scrub.latestValue) return;
            scrub.latestValue = next;
            setDraft(next);
            preview(next);
          }}
          onPointerUp={(event) => {
            const scrub = scrubRef.current;
            if (!scrub || scrub.pointerId !== event.pointerId) return;
            scrubRef.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            void commit(scrub.latestValue);
          }}
          onPointerCancel={(event) => {
            const scrub = scrubRef.current;
            if (!scrub || scrub.pointerId !== event.pointerId) return;
            scrubRef.current = null;
            setDraft(baselineRef.current);
            cancelPreview();
          }}
        >
          <Label htmlFor={id} className="pointer-events-none text-[10px]">
            {label}
          </Label>
        </button>
        <Input
          ref={inputRef}
          id={id}
          value={draft}
          placeholder={placeholder}
          disabled={disabled || saving}
          title={hint}
          className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-1.5 py-0 font-mono text-[11px] shadow-none focus-visible:border-transparent"
          onFocus={() => {
            baselineRef.current = String(value);
            onInspect?.();
          }}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            preview(resolveDesignNumericExpression(next, baselineRef.current));
          }}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              skipCommitRef.current = true;
              setDraft(baselineRef.current);
              cancelPreview();
              event.currentTarget.blur();
            }
          }}
        />
        {hint ? (
          <span
            className="bg-highlighted-bright mr-1 size-1.5 shrink-0 rounded-full"
            title={hint}
            aria-label={hint}
          />
        ) : null}
      </div>
    </div>
  );
}

function InspectorStyleField({
  label,
  property,
  value,
  computedValue,
  applied,
  provenance,
  onInspect,
  onPreviewStyles,
  onCancelPreview,
  onCommitStyles,
}: {
  label: string;
  property: string;
  value: string;
  computedValue: string;
  applied: boolean;
  provenance: InspectorProvenanceState | null;
  onInspect: (property: string, computedValue: string) => void;
  onPreviewStyles: (
    styles: Record<string, string | null>,
  ) => void | Promise<void>;
  onCancelPreview: () => void | Promise<void>;
  onCommitStyles: (styles: Record<string, string | null>) => Promise<void>;
}) {
  return (
    <InspectorEditField
      label={label}
      value={value}
      placeholder="-"
      styleProperty={property}
      applied={applied}
      hint={
        provenance?.property === property
          ? provenance.loading
            ? "Resolving…"
            : provenance.value?.winner
              ? `${provenance.value.winner.origin} · ${provenance.value.winner.file}`
              : provenance.value?.origin
          : undefined
      }
      onInspect={() => onInspect(property, computedValue)}
      onPreview={(next) => onPreviewStyles({ [property]: next || null })}
      onCancelPreview={onCancelPreview}
      onCommit={(next) => onCommitStyles({ [property]: next || null })}
    />
  );
}

function DesignInspector({
  workspace,
  workspaceId,
  folder,
  frame,
  details,
  selectedNodeId,
  selectedNodeIds,
  lint,
  active,
  onToggleWorkbench,
  onOpenMotionTimeline,
}: DesignInspectorProps) {
  const elementDetails = selectedNodeId ? details : null;
  const errors =
    lint?.violations.filter((violation) => violation.severity === "error") ??
    [];
  const warnings =
    lint?.violations.filter((violation) => violation.severity === "warning") ??
    [];
  const warningGroups = groupDesignLintViolations(warnings);
  const firstBlockingReason = errors[0]
    ? blockingDesignLintReason(errors[0])
    : null;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [frameAction, setFrameAction] = useState<
    "duplicate" | "delete" | "save" | "export" | null
  >(null);
  const [foundationAction, setFoundationAction] = useState<string | null>(null);
  const foundationActionRef = useRef(false);
  const [provenance, setProvenance] = useState<InspectorProvenanceState | null>(
    null,
  );
  const provenanceAbortRef = useRef<AbortController | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const foundation = useDesignFoundation(
    workspaceId,
    frame?.file,
    frame?.sourceVersion,
    active,
  );
  const foundationData = foundation.data;
  const visibleParameters = useMemo(() => {
    const documentId = foundationData?.summary.documentId;
    const parameters = (
      foundationData?.foundation.manifest.parameters ?? []
    ).filter((parameter) => {
      const owner = designParameterDocumentId(parameter);
      return owner === null || owner === documentId;
    });
    const byId = new Map(
      parameters.map((parameter) => [parameter.id, parameter]),
    );
    return parameters.filter((parameter) => {
      if (!parameter.visibleWhen) return true;
      return Object.is(
        byId.get(parameter.visibleWhen.parameterId)?.value,
        parameter.visibleWhen.equals,
      );
    });
  }, [
    foundationData?.foundation.manifest.parameters,
    foundationData?.summary.documentId,
  ]);
  const provenanceOwnerKey = `${workspaceId ?? ""}\u0000${frame?.file ?? ""}\u0000${frame?.sourceVersion ?? ""}\u0000${foundationData?.summary.revision ?? ""}\u0000${selectedNodeId ?? ""}`;

  useEffect(() => {
    provenanceAbortRef.current?.abort();
    provenanceAbortRef.current = null;
    setProvenance(null);
    return () => {
      provenanceAbortRef.current?.abort();
      provenanceAbortRef.current = null;
    };
  }, [provenanceOwnerKey]);

  const inspectStyle = useCallback(
    (property: string, computedValue: string) => {
      if (
        !active ||
        !workspaceId ||
        !frame ||
        !selectedNodeId ||
        !foundationData
      ) {
        return;
      }
      provenanceAbortRef.current?.abort();
      const controller = new AbortController();
      provenanceAbortRef.current = controller;
      const ownerKey = provenanceOwnerKey;
      setProvenance({
        ownerKey,
        property,
        loading: true,
        value: null,
        error: null,
      });
      void inspectDesignNodeStyleProvenance({
        workspaceId,
        frame: frame.file,
        sourceVersion: frame.sourceVersion,
        expectedRevision: foundationData.summary.revision,
        nodeId: selectedNodeId,
        property,
        computedValue,
        signal: controller.signal,
      })
        .then((value) => {
          if (controller.signal.aborted) return;
          setProvenance((current) =>
            current?.ownerKey === ownerKey && current.property === property
              ? { ...current, loading: false, value, error: null }
              : current,
          );
        })
        .catch((provenanceError) => {
          if (controller.signal.aborted) return;
          setProvenance((current) =>
            current?.ownerKey === ownerKey && current.property === property
              ? {
                  ...current,
                  loading: false,
                  value: null,
                  error: errorMessage(provenanceError),
                }
              : current,
          );
        });
    },
    [
      active,
      foundationData,
      frame,
      provenanceOwnerKey,
      selectedNodeId,
      workspaceId,
    ],
  );

  const applyFoundationOperations = useCallback(
    async (
      action: string,
      intent: string,
      operations: DesignOperation[],
      coalesceKey?: string,
    ) => {
      if (
        !workspaceId ||
        !frame ||
        !foundationData ||
        foundationActionRef.current
      ) {
        return;
      }
      foundationActionRef.current = true;
      setFoundationAction(action);
      try {
        const transactionId = `desktop:${crypto.randomUUID()}`;
        const transaction: DesignTransaction = {
          schemaVersion: 1,
          transactionId,
          documentId: foundationData.summary.documentId,
          baseRevision: foundationData.summary.revision,
          actor: { kind: "human", id: "desktop" },
          intent,
          createdAt: Date.now(),
          ...(coalesceKey ? { coalesceKey } : {}),
          operations,
        };
        await applyDesignTransactionCached(
          workspaceId,
          frame.file,
          transaction,
        );
      } finally {
        foundationActionRef.current = false;
        setFoundationAction(null);
      }
    },
    [foundationData, frame, workspaceId],
  );

  const setParameterValue = useCallback(
    async (parameter: DesignParameter, value: DesignParameterValue) => {
      await applyFoundationOperations(
        `parameter:${parameter.id}`,
        `Set ${parameter.name}`,
        [
          {
            operationId: `parameter:${crypto.randomUUID()}`,
            type: "parameter.set",
            parameterId: parameter.id,
            value,
          },
        ],
        `parameter:${parameter.id}`,
      );
    },
    [applyFoundationOperations],
  );

  const chooseParameterValue = useCallback(
    async (parameter: DesignParameter, value: DesignParameterValue) => {
      try {
        await setParameterValue(parameter, value);
      } catch (parameterError) {
        toast.error(`Couldn't update ${parameter.name}`, {
          description: errorMessage(parameterError),
        });
      }
    },
    [setParameterValue],
  );

  const insertComponent = useCallback(
    async (component: DesignComponentDefinition) => {
      if (!selectedNodeId) return;
      const props = Object.fromEntries(
        component.props
          .filter(
            (prop) => prop.type !== "slot" && prop.defaultValue !== undefined,
          )
          .map((prop) => [prop.name, prop.defaultValue!]),
      );
      await applyFoundationOperations(
        `component:${component.id}`,
        `Insert ${component.name}`,
        [
          {
            operationId: `instance:${crypto.randomUUID()}`,
            type: "instance.create",
            componentId: component.id,
            parentNodeId: selectedNodeId,
            instanceNodeId: `instance-${crypto.randomUUID()}`,
            props,
            slotHtml: "",
          },
        ],
      );
    },
    [applyFoundationOperations, selectedNodeId],
  );

  const runHistory = useCallback(
    async (direction: "undo" | "redo") => {
      if (!workspaceId || !frame || foundationActionRef.current) return;
      foundationActionRef.current = true;
      setFoundationAction(direction);
      try {
        const result = await applyDesignHistoryCached(
          workspaceId,
          frame.file,
          direction,
        );
        if (!result.result) {
          toast.info(`Nothing to ${direction}`);
        }
      } catch (historyError) {
        toast.error(`Couldn't ${direction} the design edit`, {
          description: errorMessage(historyError),
        });
      } finally {
        foundationActionRef.current = false;
        setFoundationAction(null);
      }
    },
    [frame, workspaceId],
  );

  useEffect(() => {
    if (!active || !frame) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "z" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        isEditableHotkeyTarget(event.target)
      ) {
        return;
      }
      const direction = event.shiftKey ? "redo" : "undo";
      const allowed =
        direction === "undo"
          ? foundationData?.summary.history.canUndo
          : foundationData?.summary.history.canRedo;
      if (!allowed) return;
      event.preventDefault();
      void runHistory(direction);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, foundationData?.summary.history, frame, runHistory]);

  const duplicateFrame = async () => {
    if (!workspaceId || !frame || frameAction) return;
    setFrameAction("duplicate");
    try {
      const result = await duplicateDesignFrameCached(workspaceId, frame.file);
      const duplicate = result.snapshot.frames.find(
        (candidate) => candidate.file === result.frame.file,
      );
      if (duplicate) await selectDesignFrame(workspaceId, duplicate);
      toast.success("Design frame duplicated");
    } catch (duplicateError) {
      toast.error("Couldn't duplicate the design frame", {
        description: errorMessage(duplicateError),
      });
    } finally {
      setFrameAction(null);
    }
  };

  const deleteFrame = async () => {
    if (!workspaceId || !frame || frameAction) return;
    setFrameAction("delete");
    try {
      const snapshot = await deleteDesignFrameCached(workspaceId, frame.file);
      await selectDesignFrame(workspaceId, snapshot.frames[0] ?? null);
      setDeleteOpen(false);
      toast.success("Design frame deleted");
    } catch (deleteError) {
      toast.error("Couldn't delete the design frame", {
        description: errorMessage(deleteError),
      });
    } finally {
      setFrameAction(null);
    }
  };

  const save = async () => {
    if (!workspaceId || frameAction) return;
    setFrameAction("save");
    try {
      const result = await saveDesigns(workspaceId);
      toast.success("Designs saved", {
        description: `Commit ${result.sha.slice(0, 8)} on ${result.branch}`,
      });
    } catch (saveError) {
      toast.error("Couldn't save designs", {
        description: errorMessage(saveError),
      });
    } finally {
      setFrameAction(null);
    }
  };

  const exportPng = async () => {
    if (!workspaceId || !folder || !frame || frameAction) return;
    setFrameAction("export");
    try {
      const screenshot = await captureDesignRuntimeScreenshot(
        workspaceId,
        folder,
        frame.file,
        frame.sourceVersion,
        null,
        1,
      );
      if (!screenshot) {
        throw new Error("The selected frame is not ready to export yet.");
      }
      const result = await exportDesignPng(screenshot.dataUrl, frame.title);
      if (result.saved) {
        toast.success("Design PNG exported", {
          ...(result.path ? { description: result.path } : {}),
        });
      }
    } catch (exportError) {
      toast.error("Couldn't export the design frame", {
        description: errorMessage(exportError),
      });
    } finally {
      setFrameAction(null);
    }
  };

  const styleNodeIds = useMemo(
    () =>
      selectedNodeId
        ? [
            selectedNodeId,
            ...selectedNodeIds.filter((nodeId) => nodeId !== selectedNodeId),
          ].slice(0, 32)
        : [],
    [selectedNodeId, selectedNodeIds],
  );

  const stylesForNode = useCallback(
    (nodeId: string, styles: Record<string, string | null>) => {
      const runtimeDetails =
        workspaceId && frame
          ? useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
              frame.file
            ]?.detailsByNode[nodeId]
          : null;
      return withDesignPositionContext(
        styles,
        runtimeDetails?.styles.position ??
          (nodeId === selectedNodeId
            ? elementDetails?.styles.position
            : undefined) ??
          "static",
      );
    },
    [elementDetails?.styles.position, frame, selectedNodeId, workspaceId],
  );

  const previewSelectedStyles = useCallback(
    async (styles: Record<string, string | null>) => {
      if (!workspaceId || !folder || !frame || styleNodeIds.length === 0) {
        throw new Error("Select one or more design layers first.");
      }
      await Promise.all(
        styleNodeIds.map((nodeId, index) => {
          const input = {
            workspaceId,
            frame: frame.file,
            sourceVersion: frame.sourceVersion,
            nodeId,
            styles: stylesForNode(nodeId, styles),
          };
          return index === 0
            ? previewDesignNodeStyles({ ...input, folder })
            : previewDesignNodeStylesTransient(input);
        }),
      );
    },
    [folder, frame, styleNodeIds, stylesForNode, workspaceId],
  );

  const clearSelectedStylePreview = useCallback(async () => {
    if (!workspaceId || !folder || !frame) return;
    await Promise.all(
      styleNodeIds.map((nodeId, index) => {
        const input = {
          workspaceId,
          frame: frame.file,
          sourceVersion: frame.sourceVersion,
          nodeId,
        };
        return index === 0
          ? clearDesignNodeStylePreview({ ...input, folder })
          : clearDesignNodeStylePreviewTransient(input);
      }),
    );
  }, [folder, frame, styleNodeIds, workspaceId]);

  const commitSelectedStyles = useCallback(
    async (styles: Record<string, string | null>) => {
      if (!workspaceId || !frame || styleNodeIds.length === 0) {
        throw new Error("Select one or more design layers first.");
      }
      if (styleNodeIds.length === 1) {
        await updateDesignNodeStylesCached(workspaceId, {
          frame: frame.file,
          nodeId: styleNodeIds[0]!,
          sourceVersion: frame.sourceVersion,
          styles: stylesForNode(styleNodeIds[0]!, styles),
        });
        return;
      }
      if (!foundationData) {
        throw new Error("The selected design document is still loading.");
      }
      const properties = Object.keys(styles).sort();
      await applyFoundationOperations(
        `styles:${styleNodeIds.join(":")}`,
        `Set ${properties.join(", ")} on ${styleNodeIds.length} layers`,
        styleNodeIds.map((nodeId) => ({
          operationId: `styles:${crypto.randomUUID()}`,
          type: "node.set-styles" as const,
          nodeId,
          styles: stylesForNode(nodeId, styles),
          scope: "auto" as const,
          responsiveContext: "base",
          stateContext: "default",
        })),
        `styles:${styleNodeIds.join(":")}:${properties.join(":")}`,
      );
    },
    [
      applyFoundationOperations,
      foundationData,
      frame,
      styleNodeIds,
      stylesForNode,
      workspaceId,
    ],
  );

  const styleContext =
    workspaceId && folder && frame && selectedNodeId && elementDetails
      ? { workspaceId, folder, frame, nodeId: selectedNodeId }
      : null;
  const styleField = (label: string, property: string, value: string) => {
    if (!styleContext) return null;
    const authoredProperties = elementDetails?.authoredStyleProperties;
    const applied = isDesignRuntimeStylePropertyAuthored(
      authoredProperties,
      property,
      value,
    );
    return (
      <InspectorStyleField
        key={`${styleContext.frame.file}:${styleContext.frame.sourceVersion}:${styleNodeIds.join(":")}:${property}`}
        label={label}
        property={property}
        value={designStyleFieldValue(authoredProperties, property, value)}
        computedValue={value}
        applied={applied}
        provenance={
          provenance?.ownerKey === provenanceOwnerKey ? provenance : null
        }
        onInspect={inspectStyle}
        onPreviewStyles={previewSelectedStyles}
        onCancelPreview={clearSelectedStylePreview}
        onCommitStyles={commitSelectedStyles}
      />
    );
  };

  return (
    <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
      <aside
        data-design-inspector=""
        className="border-border1 bg-bg1 flex w-80 shrink-0 flex-col overflow-hidden border-l"
      >
        <Tabs
          defaultValue="style"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <div className="flex h-10 shrink-0 items-center gap-1 px-1">
            <TabsList
              variant="chrome"
              className="min-w-0 flex-1"
              aria-label="Inspector modes"
            >
              <TabsTrigger value="style" variant="chrome">
                Style
              </TabsTrigger>
              <TabsTrigger value="foundation" variant="chrome">
                Data
              </TabsTrigger>
            </TabsList>
            <WorkbenchToggleButton
              workbenchCollapsed={false}
              onToggle={onToggleWorkbench}
            />
          </div>

          <TabsContent
            value="style"
            className="mt-0 min-h-0 flex-1 overflow-hidden"
          >
            <ScrollArea className="h-full">
              <div className="flex flex-col">
                <section className="border-border1 flex flex-col border-b pb-1">
                  <div className="flex h-10 min-w-0 items-center gap-1 px-3">
                    <span className="bg-bg1-hover text-fg3 shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[9px] uppercase">
                      {styleNodeIds.length > 1
                        ? "multi"
                        : (elementDetails?.tag ?? (frame ? "frame" : "—"))}
                    </span>
                    <span className="text-fg1 min-w-0 flex-1 truncate text-xs font-medium">
                      {styleNodeIds.length > 1
                        ? `${styleNodeIds.length} layers`
                        : (elementDetails?.name ??
                          frame?.title ??
                          "Nothing selected")}
                    </span>
                    <Tooltip label="Save designs">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={!workspaceId || frameAction !== null}
                        aria-label="Save designs"
                        onClick={() => void save()}
                      >
                        <Save />
                      </Button>
                    </Tooltip>
                    <Tooltip label="Undo" shortcut="⌘Z">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Undo design edit"
                        aria-keyshortcuts="Meta+Z Control+Z"
                        disabled={
                          !foundationData?.summary.history.canUndo ||
                          foundationAction !== null
                        }
                        onClick={() => void runHistory("undo")}
                      >
                        <Undo2 />
                      </Button>
                    </Tooltip>
                    <Tooltip label="Redo" shortcut="⇧⌘Z">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Redo design edit"
                        aria-keyshortcuts="Shift+Meta+Z Shift+Control+Z"
                        disabled={
                          !foundationData?.summary.history.canRedo ||
                          foundationAction !== null
                        }
                        onClick={() => void runHistory("redo")}
                      >
                        <Redo2 />
                      </Button>
                    </Tooltip>
                  </div>
                  <div className="flex h-6 min-w-0 items-center gap-1 px-3">
                    <span
                      className="text-fg3 min-w-0 flex-1 truncate text-[10px]"
                      title={
                        styleNodeIds.length > 1
                          ? styleNodeIds.join(", ")
                          : (elementDetails?.breadcrumb.join(" / ") ??
                            frame?.file)
                      }
                    >
                      {styleNodeIds.length > 1
                        ? "Multiple selection · Shift-click to toggle"
                        : (elementDetails?.breadcrumb.join(" / ") ??
                          frame?.file ??
                          "Select a frame on canvas")}
                    </span>
                    {!elementDetails ? (
                      <>
                        <Tooltip label="Duplicate frame">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={!frame || frameAction !== null}
                            aria-label="Duplicate frame"
                            onClick={() => void duplicateFrame()}
                          >
                            <Copy />
                          </Button>
                        </Tooltip>
                        <DialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={!frame || frameAction !== null}
                            aria-label="Delete frame"
                            title="Delete frame"
                          >
                            <Trash2 />
                          </Button>
                        </DialogTrigger>
                      </>
                    ) : null}
                  </div>
                </section>

                {errors.length > 0 ? (
                  <section className="text-red-primary flex min-h-8 items-center gap-2 px-3 py-1.5">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    <span
                      className="min-w-0 flex-1 truncate text-[10px]"
                      title={`${firstBlockingReason}: ${errors[0]?.message}`}
                    >
                      {errors.length} blocking · {firstBlockingReason}
                    </span>
                  </section>
                ) : null}

                {warnings.length > 0 ? (
                  <section className="text-fg3 flex min-h-8 items-center gap-2 px-3 py-1.5">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    <span
                      className="min-w-0 flex-1 truncate text-[10px]"
                      title={warningGroups
                        .map(
                          (group) => `${group.label}: ${group.first.message}`,
                        )
                        .join("\n")}
                    >
                      {lintReviewBadgeLabel(warningGroups)} · non-blocking
                    </span>
                  </section>
                ) : null}

                {styleContext && elementDetails ? (
                  <DesignStyleEditor
                    key={`${frame!.file}:${styleNodeIds.join(":")}`}
                    details={elementDetails}
                    renderField={styleField}
                    disabled={foundationAction !== null}
                    onPreviewStyles={previewSelectedStyles}
                    onCancelStylePreview={clearSelectedStylePreview}
                    onCommitStyles={commitSelectedStyles}
                    onOpenMotionTimeline={onOpenMotionTimeline}
                  />
                ) : frame && workspaceId ? (
                  <section className="border-border1 flex flex-col gap-3 border-b p-3">
                    <span className="text-fg2 text-xs font-medium">
                      Frame position &amp; size
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      {(
                        [
                          ["X", "x", frame.x],
                          ["Y", "y", frame.y],
                          ["W", "w", frame.width],
                          ["H", "h", frame.height],
                        ] as const
                      ).map(([label, key, value]) => (
                        <InspectorEditField
                          key={key}
                          label={label}
                          value={value}
                          onCommit={async (next) => {
                            const number = Number(next);
                            if (!Number.isFinite(number)) {
                              throw new Error("Enter a finite number.");
                            }
                            await updateDesignFrameGeometryCached(
                              workspaceId,
                              frame.file,
                              { ...frameGeometry(frame), [key]: number },
                            );
                          }}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent
            value="foundation"
            className="mt-0 min-h-0 flex-1 overflow-hidden"
          >
            <ScrollArea className="h-full">
              <div className="flex flex-col">
                <section className="border-border1 flex flex-col gap-3 border-b p-3">
                  <div className="flex items-start gap-2">
                    <SlidersHorizontal className="text-fg3 mt-0.5 size-3.5 shrink-0" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="text-fg2 text-xs font-medium">
                        Tweaks
                      </span>
                      <span className="text-fg3 text-xs">
                        Typed parameters update every binding in this document
                        in one transaction.
                      </span>
                    </div>
                    {foundationData ? (
                      <span className="text-fg3 shrink-0 text-[10px]">
                        {foundationData.foundation.manifest.variants.length}{" "}
                        variants
                      </span>
                    ) : null}
                  </div>
                  {foundation.loading && !foundationData ? (
                    <span className="text-fg3 text-xs">
                      Loading authored parameters…
                    </span>
                  ) : foundation.error && !foundationData ? (
                    <span className="text-red-primary text-xs">
                      {foundation.error.message}
                    </span>
                  ) : visibleParameters.length > 0 ? (
                    <div className="flex max-h-80 flex-col gap-3 overflow-auto">
                      {visibleParameters.map((parameter) => {
                        const constraints = [
                          parameter.min !== undefined
                            ? `min ${parameter.min}`
                            : null,
                          parameter.max !== undefined
                            ? `max ${parameter.max}`
                            : null,
                          parameter.step !== undefined
                            ? `step ${parameter.step}`
                            : null,
                          parameter.unit ?? null,
                        ]
                          .filter(Boolean)
                          .join(" · ");
                        return (
                          <div
                            key={parameter.id}
                            className="border-border1 flex min-w-0 flex-col gap-2 border-b pb-3 last:border-b-0 last:pb-0"
                          >
                            <div className="flex min-w-0 items-start justify-between gap-2">
                              <div className="flex min-w-0 flex-col">
                                <span className="text-fg1 truncate text-xs font-medium">
                                  {parameter.name}
                                </span>
                                <span
                                  className="text-fg3 truncate text-[10px]"
                                  title={parameter.description}
                                >
                                  {parameter.type} · {parameter.bindings.length}{" "}
                                  {parameter.bindings.length === 1
                                    ? "binding"
                                    : "bindings"}
                                </span>
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={
                                  Object.is(
                                    parameter.value,
                                    parameter.defaultValue,
                                  ) || foundationAction !== null
                                }
                                onClick={() =>
                                  void chooseParameterValue(
                                    parameter,
                                    parameter.defaultValue,
                                  )
                                }
                              >
                                Reset
                              </Button>
                            </div>
                            {parameter.type === "boolean" ? (
                              <Button
                                type="button"
                                variant={
                                  parameter.value === true
                                    ? "secondary-on"
                                    : "secondary"
                                }
                                size="sm"
                                className="w-full"
                                aria-pressed={parameter.value === true}
                                disabled={foundationAction !== null}
                                onClick={() =>
                                  void chooseParameterValue(
                                    parameter,
                                    parameter.value !== true,
                                  )
                                }
                              >
                                {parameter.value === true
                                  ? "Enabled"
                                  : "Disabled"}
                              </Button>
                            ) : parameter.type === "enum" &&
                              parameter.options ? (
                              <Select
                                value={String(
                                  parameter.options.findIndex((option) =>
                                    Object.is(option.value, parameter.value),
                                  ),
                                )}
                                disabled={foundationAction !== null}
                                onValueChange={(index) => {
                                  const option =
                                    parameter.options?.[Number(index)];
                                  if (option) {
                                    void chooseParameterValue(
                                      parameter,
                                      option.value,
                                    );
                                  }
                                }}
                              >
                                <SelectTrigger
                                  size="sm"
                                  className="h-7 w-full text-xs"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {parameter.options.map((option, index) => (
                                    <SelectItem
                                      key={`${parameter.id}:${index}`}
                                      value={String(index)}
                                    >
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <InspectorEditField
                                label={constraints || parameter.type}
                                value={designParameterText(parameter.value)}
                                disabled={foundationAction !== null}
                                onCommit={async (draft) => {
                                  await setParameterValue(
                                    parameter,
                                    parseDesignParameterDraft(parameter, draft),
                                  );
                                }}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : foundationData ? (
                    <span className="text-fg3 text-xs">
                      No parameters are exposed in .zeros-foundation.json yet.
                    </span>
                  ) : (
                    <span className="text-fg3 text-xs">
                      Select a frame to inspect its design parameters.
                    </span>
                  )}
                  {foundation.error && foundationData ? (
                    <span className="text-red-primary text-xs">
                      Refresh failed: {foundation.error.message}
                    </span>
                  ) : foundation.refreshing ? (
                    <span className="text-fg3 text-[10px]">
                      Reconciling external source changes…
                    </span>
                  ) : null}
                </section>

                <section className="border-border1 flex flex-col gap-3 border-b p-3">
                  <div className="flex items-start gap-2">
                    <Boxes className="text-fg3 mt-0.5 size-3.5 shrink-0" />
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-fg2 text-xs font-medium">
                        Components
                      </span>
                      <span className="text-fg3 text-xs">
                        Instances keep component identity while rendering native
                        HTML and CSS.
                      </span>
                    </div>
                  </div>
                  {foundationData?.foundation.manifest.components.length ? (
                    <div className="flex max-h-72 flex-col gap-2 overflow-auto">
                      {foundationData.foundation.manifest.components.map(
                        (component) => (
                          <div
                            key={component.id}
                            className="border-border1 flex min-w-0 items-center gap-2 border-b pb-2 last:border-b-0 last:pb-0"
                          >
                            <div className="flex min-w-0 flex-1 flex-col">
                              <span className="text-fg1 truncate text-xs font-medium">
                                {component.name}
                              </span>
                              <span className="text-fg3 truncate text-[10px]">
                                {component.props.length} props ·{" "}
                                {component.slots.length} slots ·{" "}
                                {component.file}
                              </span>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              disabled={
                                !selectedNodeId || foundationAction !== null
                              }
                              onClick={() => {
                                void insertComponent(component).catch(
                                  (componentError) => {
                                    toast.error(
                                      `Couldn't insert ${component.name}`,
                                      {
                                        description:
                                          errorMessage(componentError),
                                      },
                                    );
                                  },
                                );
                              }}
                            >
                              {foundationAction === `component:${component.id}`
                                ? "Inserting…"
                                : "Insert"}
                            </Button>
                          </div>
                        ),
                      )}
                    </div>
                  ) : foundationData ? (
                    <span className="text-fg3 text-xs">
                      Add a components/*.html definition to expose reusable
                      components here.
                    </span>
                  ) : null}
                  {foundationData?.foundation.manifest.components.length &&
                  !selectedNodeId ? (
                    <span className="text-fg3 text-xs">
                      Select an element to use as the instance parent.
                    </span>
                  ) : null}
                </section>

                <section className="flex flex-col gap-2 p-3">
                  <span className="text-fg2 text-xs font-medium">
                    Export &amp; publish
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!frame || !folder || frameAction !== null}
                    onClick={() => void exportPng()}
                  >
                    {frameAction === "export" ? "Exporting…" : "Export PNG"}
                  </Button>
                  {workspace && workspace.prNumber == null ? (
                    <CreatePrButton
                      workspace={workspace}
                      originUrl={null}
                      disabled={errors.length > 0 || frameAction !== null}
                      disabledReason={
                        firstBlockingReason
                          ? `Fix ${firstBlockingReason} before creating a pull request`
                          : undefined
                      }
                    />
                  ) : workspace?.prUrl ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void shellOpenUrl(workspace.prUrl!)}
                    >
                      Open PR #{workspace.prNumber}
                    </Button>
                  ) : null}
                </section>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </aside>

      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          deleteCancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Delete {frame?.title ?? "this frame"}?</DialogTitle>
          <DialogDescription>
            This removes {frame?.file ?? "the HTML frame"} and its canvas
            placement. Git can recover it until the design is saved.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button
              ref={deleteCancelRef}
              type="button"
              disabled={frameAction === "delete"}
            >
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={!frame || frameAction !== null}
            onClick={() => void deleteFrame()}
          >
            {frameAction === "delete" ? "Deleting…" : "Delete frame"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
