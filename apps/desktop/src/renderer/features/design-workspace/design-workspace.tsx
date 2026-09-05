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
import { useShallow } from "zustand/react/shallow";
import "./design-workspace-ui.css";
import {
  AlertTriangle,
  Code2,
  Diamond,
  Download,
  FileCode2,
  Frame,
  GitBranch,
  MousePointer2,
  Palette,
  Type,
  X,
} from "lucide-react";

import type {
  DesignRuntimeNodeDetails,
  DesignRuntimeNodeGeometry,
  DesignRuntimeTreeNode,
} from "@zeros/protocol/design-runtime";
import { DESIGN_SELECTION_NODE_LIMIT } from "@zeros/protocol/design-runtime";
import { type DesignOperation } from "@zeros/design-core";
import type {
  DesignAuthoredKeyframes,
  DesignStyleProvenance,
} from "@zeros/design-web";

import { exportDesignPng } from "../../platform/design";
import { designFrameRuntime } from "../../platform/bridge/design-frame-runtime";
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
  appendDesignNodeHtmlCached,
  createDesignFrameAndRefresh,
  deleteDesignFrameCached,
  duplicateDesignFrameCached,
  insertDesignAssetCached,
  applyDesignHistoryCached,
  applyDesignTransactionCached,
  renameDesignFrameAndRefresh,
  commitDesigns,
  saveDesigns,
  stageDesigns,
  updateDesignFrameGeometryCached,
  updateDesignNodeStylesCached,
  warmDesignFrameDocument,
  designFoundationCache,
  designFoundationKey,
  fetchDesignFoundation,
} from "./state/design-workspace-cache";
import {
  clearDesignNodeTextPreviewTransient,
  clearDesignNodeStylePreviewTransient,
  captureDesignRuntimeScreenshot,
  hoverDesignNode,
  hoverDesignNodeAtLocation,
  inspectDesignNode,
  inspectDesignNodeAtLocation,
  inspectDesignNodesInRect,
  inspectDesignNodeStyleProvenance,
  previewDesignNodeGeometry,
  previewDesignNodeMotionTransient,
  previewDesignNodeStylesTransient,
  previewDesignNodeTextTransient,
  selectDesignFrame,
  selectDesignNode,
  selectDesignNodes,
  selectDesignNodeAtLocation,
  toggleDesignNodeSelection,
} from "./state/design-selection";
import {
  designRuntimeFrameState,
  useDesignRuntimeStore,
} from "./state/design-runtime-store";
import {
  designLivePreviewValue,
  publishDesignGestureLivePreview,
  useDesignLivePreviewValue,
} from "./state/design-live-preview";
import { useDesignWorkspaceDisclosure } from "./state/design-layer-disclosure";
import {
  DEFAULT_DESIGN_WORKSPACE_VIEW,
  DESIGN_MAX_ZOOM,
  DESIGN_MIN_ZOOM,
  designWorkspaceView,
  useDesignWorkspaceUiStore,
  useDesignWorkspaceView,
  validateDesignWorkspaceSelection,
} from "./state/design-workspace-ui";
import { useDesignWorkspaceSnapshot } from "./state/use-design-workspace";
import { useDesignFoundation } from "./state/use-design-foundation";
import { useDesignFrameDocument } from "./state/use-design-frame-document";
import { clearWorkspaceSettling } from "../../state/pending-workspaces";
import { cn } from "../../shared/ui/cn";
import { useThemeId } from "../../shared/theme/use-theme-variant";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  CodeBlock,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Toolbar,
  Tooltip,
  toast,
} from "../../shared/ui/primitives";
import {
  DESIGN_ROTATION_CORNERS,
  designAuthoredResizeAxis,
  designCanvasPointFromClient,
  designCanvasRectFromPoints,
  designConstraintGuides,
  designConstraintSides,
  designCssSizeAfterResize,
  designLocalDelta,
  designOriginFraction,
  designOriginTranslationShift,
  designResizeAnchor,
  designResizeLayoutOffset,
  designResizeStyleAxes,
  designRotatedResizeOrigin,
  designRotationCursor,
  designSelectionBox,
  designSelectionBoxBounds,
  designSelectionOverlayFrame,
  designSelectionPivot,
  designGridTrackSegments,
  designHighResolutionViewportTile,
  designInlineGapDistributionStyles,
  designInlineGapGeometry,
  designInlineGapRegions,
  designInlineSpacingValue,
  designSelectionClickIntent,
  designMeasureSpacing,
  designPointerRotation,
  fitDesignRects,
  resizeDesignRect,
  resizeDesignRectWithinBounds,
  snapDesignRect,
  snapDesignResizeRect,
  retainLiveDesignFrameFiles,
  selectLiveDesignFrameFiles,
  settleDesignFrameGesture,
  designWheelDeltaPixels,
  designWheelZoomFactor,
  zoomDesignViewportAtPoint,
  type DesignCanvasRect,
  type DesignConstraintSide,
  type DesignConstraintSides,
  type DesignInlineGapRegion,
  type DesignHighResolutionViewportTile,
  type DesignRotationCorner,
  type DesignSelectionBox,
  type DesignSelectionOverlayFrame,
  type DesignViewport,
  type DesignResizeHandle,
} from "./design-canvas-math";
import {
  beginInlineTextCommit,
  cancelInlineTextCommit,
  createInlineTextCommitGuard,
  finishInlineTextCommit,
} from "./design-inline-text-commit";
import {
  createDesignTextMarkup,
  createDesignTextNodeId,
} from "./design-text-editing";
import { DesignFrameRuntimeIframe } from "./design-frame-runtime-iframe";
import { hasDesignAssetDrag, readDesignAssetDrag } from "./design-assets";
import { DesignThemeEditor } from "./design-theme-editor";
import { DesignComputedCssEditor } from "./design-computed-css-editor";
import { DesignStyleEditor } from "./design-style-editor";
import { DesignCanvasBackgroundEditor } from "./design-canvas-background-editor";
import {
  normalizeDesignCanvasBackground,
  resolveDesignCanvasDefaultBackground,
} from "./design-canvas-background";
import { DesignPanelResizeHandle } from "./design-panel-resize-handle";
import {
  DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT,
  DESIGN_WORKSPACE_STYLE_WIDTH_MAX,
  DESIGN_WORKSPACE_STYLE_WIDTH_MIN,
  DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
  clampDesignWorkspaceStyleWidth,
  persistDesignWorkspaceStyleWidth,
  readPersistedDesignWorkspaceStyleWidth,
} from "./design-workspace-width";
import { dispatchDesignWorkspaceShortcut } from "./design-workspace-shortcuts";
import {
  DesignMotionTimeline,
  designMotionPreviewInput,
  type DesignMotionPropertyRequest,
  type DesignMotionSeekRequest,
  type DesignMotionTimelineDraft,
} from "./design-motion-timeline";
import {
  designDurationMs,
  designMotionProperties,
  designMotionTimeAtOffset,
  designMotionTranslationAtOffset,
  designMotionTranslationPoints,
} from "./design-motion-values";
import {
  publishDesignMotionPlayhead,
  useDesignMotionPlayhead,
} from "./state/design-motion-playhead";
import { canEditDesignNodeText } from "./design-node-capabilities";
import {
  createDesignGestureLoop,
  sameDesignGestureStyles,
} from "./design-gesture-loop";
import {
  formatDesignTransform,
  parseDesignTransform,
  type DesignTransformValue,
} from "./design-effect-values";
import {
  designStyleUnitOptions,
  designStylePropertyAffectsLayout,
  designStyleFieldValue,
  isDesignRuntimeStylePropertyAuthored,
  normalizeDesignStyleFieldInput,
  parseDesignStyleNumericParts,
  replaceDesignStyleNumericUnit,
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
  resolveDesignFrameBodyTarget,
  type DesignFrameBodyIntent,
} from "./design-layer-tree";
import {
  designFrameLayerLabel,
  designRuntimeLayerLabel,
} from "./design-layer-label";
import { resolveDesignSelectionShortcut } from "./design-selection-shortcuts";

// --- TYPES ---

interface DesignWorkspaceColumnProps {
  /** Confirmed design workspace; null while an optimistic create is landing. */
  workspace: Workspace | null;
  /** Exact destination path used for the snapshot refresh key. */
  folder: string | null;
  /** Hidden retained shells must not read, poll, focus, or attach shortcuts. */
  surfaceActive: boolean;
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
  /** Concrete workspace-owned color, or the resolved --bg2 default. */
  canvasBackground: string;
  motionTimelineOpen: boolean;
  motionPropertyRequest: DesignMotionPropertyRequest | null;
  onMotionTimelineOpenChange: (open: boolean) => void;
  onMotionPropertyRequestHandled: (id: number) => void;
  onMotionPropertiesChange: (properties: readonly string[]) => void;
  onDeleteFrame: (frame: DesignCanvasFrameWire) => Promise<void>;
  zoomActionsRef: React.MutableRefObject<DesignCanvasZoomActions | null>;
}

interface DesignInspectorProps {
  workspaceId: string | null;
  folder: string | null;
  /** Selected frame document, or null for an empty canvas selection. */
  frame: DesignCanvasFrameWire | null;
  /** True when the frame itself is the selection target (not just active). */
  frameSelected: boolean;
  /** Browser-computed values for the exact selected frame/element key. */
  details: DesignRuntimeNodeDetails | null;
  /** Stable element identity; null means the frame itself is selected. */
  selectedNodeId: string | null;
  /** Primary-first additive selection for group styling feedback. */
  selectedNodeIds: readonly string[];
  /** Deterministic document lint result from the aggregate snapshot. */
  lint: DesignLintReportWire | null;
  active: boolean;
  canvasBackground: string;
  onCanvasBackgroundChange: (value: string) => void;
  motionTimelineOpen: boolean;
  motionProperties: readonly string[];
  onOpenMotionTimeline: (property?: string, value?: string) => void;
  zoomActionsRef: React.MutableRefObject<DesignCanvasZoomActions | null>;
}

interface DesignCanvasZoomActions {
  zoomIn(): void;
  zoomOut(): void;
}

type FrameGestureMode = "move" | DesignResizeHandle;
type DesignCanvasTool = "select" | "frame" | "text";

interface InlineTextEditBase {
  id: string;
  nodeId: string;
  initialText: string;
  status: "editing" | "committing" | "settling";
}

interface ExistingInlineTextEdit extends InlineTextEditBase {
  kind: "existing";
  frame: string;
  sourceVersion: string;
  whiteSpace: string;
  /** Runtime details captured when editing began. The editor mounts from
   * these in the same commit that starts the edit, so glyph ownership can
   * never sit with a suppressed iframe while selection readback is still in
   * flight — the exact failure that rendered text invisible. */
  initialDetails: DesignRuntimeNodeDetails;
}

interface NewInlineTextEdit extends InlineTextEditBase {
  kind: "new";
  owner: "frame" | "canvas";
  frame: string | null;
  sourceVersion: string | null;
  parentNodeId: string | null;
  previousFrame: string | null;
  previousNodeId: string | null;
  previousNodeIds: readonly string[];
  canvasX: number;
  canvasY: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  placement: "absolute" | "flow";
  /** Exact inherited runtime typography for an element that does not exist in
   * source yet. Canvas-owned text falls back to the same black system text the
   * generated document uses. */
  inheritedStyles: Record<string, string>;
}

type InlineTextEdit = ExistingInlineTextEdit | NewInlineTextEdit;

const DESIGN_TEXT_WHITE_SPACE_PRESERVES_LINES = new Set([
  "pre",
  "pre-wrap",
  "pre-line",
  "break-spaces",
]);
const DESIGN_CANVAS_DEFAULT_TEXT_COLOR = "var(--design-canvas-default-text)";

function designInlineTextPaintColor(value: string | undefined): string {
  const color = value?.trim() ?? "";
  if (
    !color ||
    (color.includes("var(") && color !== DESIGN_CANVAS_DEFAULT_TEXT_COLOR) ||
    color === "transparent" ||
    /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(color) ||
    /^rgb\([^)]*\/\s*0(?:\.0+)?\s*\)$/i.test(color)
  ) {
    return "var(--design-selection-stroke)";
  }
  return color;
}

function positiveCssPixels(value: string | undefined): number | null {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))px$/i.exec(value?.trim() ?? "");
  if (!match) return null;
  const pixels = Number(match[1]);
  return Number.isFinite(pixels) && pixels > 0 ? pixels : null;
}

const DesignInlineTextEditor = React.memo(function DesignInlineTextEditor({
  edit,
  details,
  onMounted,
  onDraft,
  onCommit,
  onCancel,
}: {
  edit: InlineTextEdit;
  details: DesignRuntimeNodeDetails | null;
  onMounted: (edit: InlineTextEdit) => void;
  onDraft: (edit: InlineTextEdit, draft: string) => void;
  onCommit: (
    edit: InlineTextEdit,
    measured: { width: number; height: number },
  ) => void;
  onCancel: (edit: InlineTextEdit) => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const blurredDuringCompositionRef = useRef(false);
  const publishedDraftRef = useRef(edit.initialText);
  // Selection readback may lag or fail entirely; the start-of-edit snapshot
  // keeps the editor mounted and painted so the text can never disappear.
  const resolvedDetails =
    details ?? (edit.kind === "existing" ? edit.initialDetails : null);
  const rect =
    edit.kind === "new"
      ? {
          x: edit.canvasX,
          y: edit.canvasY,
          width: edit.width,
          height: edit.height,
        }
      : resolvedDetails?.rect;

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.textContent = edit.initialText;
    composingRef.current = false;
    blurredDuringCompositionRef.current = false;
    publishedDraftRef.current = edit.initialText;
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [edit.id, edit.initialText]);

  // Painted first, suppressed second: the runtime hides its glyphs only once
  // this editor exists with the same text, so a lost request or slow readback
  // degrades to a brief identical double-paint instead of invisible text.
  useEffect(() => {
    onMounted(edit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit.id]);

  if (!rect) return null;
  const isExisting = edit.kind === "existing";
  // A rotated element paints its glyphs rotated, so the editor that stands in
  // for them has to turn with it — and take the element's own box, not the
  // larger upright box its rotation spans.
  const editedBox =
    isExisting && resolvedDetails ? designSelectionBox(resolvedDetails) : null;
  const turned =
    editedBox && editedBox.rotation
      ? designSelectionOverlayFrame(editedBox)
      : null;
  const painted =
    turned && editedBox
      ? {
          x: turned.left,
          y: turned.top,
          width: editedBox.width,
          height: editedBox.height,
        }
      : rect;
  const computed =
    resolvedDetails?.styles ??
    (edit.kind === "new" ? edit.inheritedStyles : {});
  const sizing = resolvedDetails?.textSizing;
  const intrinsicWidth =
    edit.kind === "new"
      ? edit.width === undefined
        ? "max-content"
        : null
      : sizing?.width && sizing.width !== "fixed"
        ? sizing.width === "auto"
          ? "max-content"
          : sizing.width
        : null;
  const fixedHeight =
    edit.kind === "new"
      ? edit.height !== undefined
      : sizing?.height === "fixed";
  // A new node inherits typography from its parent, but the parent's box
  // constraints (padding, borders, min/max sizes) are not inherited CSS and
  // never reach the committed text node — applying them here would shift the
  // draft relative to the final layout.
  const authoredMinHeight = isExisting
    ? positiveCssPixels(computed.minHeight)
    : null;
  const maxWidthPixels = isExisting
    ? positiveCssPixels(computed.maxWidth)
    : null;
  const intrinsicMaxWidth =
    intrinsicWidth === "fit-content" || sizing?.width === "auto"
      ? Math.min(
          sizing?.availableWidth ?? Number.POSITIVE_INFINITY,
          maxWidthPixels ?? Number.POSITIVE_INFINITY,
        )
      : maxWidthPixels;
  const authoredWhiteSpace =
    edit.kind === "new"
      ? "pre-wrap"
      : computed.whiteSpace || edit.whiteSpace || "normal";
  const paintColor = designInlineTextPaintColor(computed.color);
  const syncDraftLayout = (editor: HTMLDivElement, draft: string) => {
    editor.style.whiteSpace =
      draft.includes("\n") &&
      !DESIGN_TEXT_WHITE_SPACE_PRESERVES_LINES.has(authoredWhiteSpace)
        ? "pre-wrap"
        : authoredWhiteSpace;
  };
  const readDraft = (editor: HTMLDivElement) =>
    editor.innerText.replace(/\r\n?/g, "\n");
  const publishDraft = (editor: HTMLDivElement) => {
    let draft = readDraft(editor);
    if (draft.length > 10_000) {
      draft = draft.slice(0, 10_000);
      editor.textContent = draft;
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    syncDraftLayout(editor, draft);
    if (publishedDraftRef.current === draft) return;
    publishedDraftRef.current = draft;
    onDraft(edit, draft);
  };
  const insertPlainText = (editor: HTMLDivElement, value: string) => {
    const text = value.replace(/\r\n?/g, "\n").slice(0, 10_000);
    const selection = window.getSelection();
    const range =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      editor.append(document.createTextNode(text));
      const fallbackRange = document.createRange();
      fallbackRange.selectNodeContents(editor);
      fallbackRange.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(fallbackRange);
    } else {
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    publishDraft(editor);
  };
  const commit = (editor: HTMLDivElement) =>
    onCommit(edit, {
      width: Math.max(1, Math.ceil(editor.scrollWidth)),
      height: Math.max(1, Math.ceil(editor.scrollHeight)),
    });

  return (
    <div
      ref={editorRef}
      key={edit.id}
      data-design-controls
      data-design-inline-text-editor=""
      data-placeholder={edit.kind === "new" ? "Type something" : undefined}
      role="textbox"
      aria-label={
        edit.kind === "new"
          ? "New canvas text"
          : `Edit text for ${resolvedDetails?.name ?? edit.nodeId}`
      }
      aria-multiline="true"
      aria-busy={edit.status !== "editing"}
      contentEditable={edit.status === "editing" ? "plaintext-only" : false}
      suppressContentEditableWarning
      spellCheck
      className="zd-design-inline-text-editor absolute"
      style={{
        left: painted.x,
        top: painted.y,
        ...(turned
          ? {
              transform: `rotate(${turned.rotation}deg)`,
              transformOrigin: `${turned.pivotX}px ${turned.pivotY}px`,
            }
          : {}),
        width: intrinsicWidth ?? Math.max(1, painted.width ?? 1),
        maxWidth:
          intrinsicMaxWidth == null || !Number.isFinite(intrinsicMaxWidth)
            ? undefined
            : Math.max(1, intrinsicMaxWidth),
        minWidth: intrinsicWidth ? designCanvasScreenPixels(2) : undefined,
        height: fixedHeight ? Math.max(1, painted.height ?? 1) : undefined,
        minHeight: fixedHeight
          ? undefined
          : Math.max(
              edit.kind === "new" ? 24 : 1,
              authoredMinHeight ? (painted.height ?? authoredMinHeight) : 1,
            ),
        zIndex: 20,
        margin: 0,
        padding: isExisting ? computed.padding : 0,
        boxSizing:
          isExisting && intrinsicWidth
            ? (computed.boxSizing as React.CSSProperties["boxSizing"])
            : "border-box",
        borderTopWidth: isExisting ? computed.borderTopWidth : 0,
        borderRightWidth: isExisting ? computed.borderRightWidth : 0,
        borderBottomWidth: isExisting ? computed.borderBottomWidth : 0,
        borderLeftWidth: isExisting ? computed.borderLeftWidth : 0,
        borderStyle: "solid",
        borderColor: "transparent",
        overflow: "visible",
        outlineWidth: designCanvasScreenPixels(1),
        outlineStyle: "solid",
        outlineColor: "var(--design-selection-stroke)",
        outlineOffset: 0,
        background: "transparent",
        color: paintColor,
        WebkitTextFillColor: paintColor,
        caretColor: paintColor,
        fontFamily: computed.fontFamily || "inherit",
        fontSize: computed.fontSize || "16px",
        fontWeight: computed.fontWeight || "inherit",
        fontStyle: computed.fontStyle || "normal",
        fontStretch: computed.fontStretch,
        fontVariant: computed.fontVariant,
        fontKerning: computed.fontKerning as React.CSSProperties["fontKerning"],
        fontFeatureSettings: computed.fontFeatureSettings,
        fontVariationSettings: computed.fontVariationSettings,
        lineHeight: computed.lineHeight || "normal",
        letterSpacing: computed.letterSpacing || "normal",
        wordSpacing: computed.wordSpacing,
        textAlign: (computed.textAlign ||
          "start") as React.CSSProperties["textAlign"],
        textIndent: computed.textIndent,
        textTransform:
          computed.textTransform as React.CSSProperties["textTransform"],
        textDecoration: computed.textDecoration,
        whiteSpace: authoredWhiteSpace,
        wordBreak: computed.wordBreak as React.CSSProperties["wordBreak"],
        overflowWrap: (computed.overflowWrap ||
          (edit.kind === "new"
            ? "anywhere"
            : "normal")) as React.CSSProperties["overflowWrap"],
        hyphens: computed.hyphens as React.CSSProperties["hyphens"],
        writingMode: computed.writingMode as React.CSSProperties["writingMode"],
        direction: computed.direction as React.CSSProperties["direction"],
        unicodeBidi: computed.unicodeBidi as React.CSSProperties["unicodeBidi"],
        opacity: computed.opacity,
        pointerEvents: edit.status === "editing" ? "auto" : "none",
      }}
      onInput={(event) => publishDraft(event.currentTarget)}
      onCompositionStart={() => {
        composingRef.current = true;
        blurredDuringCompositionRef.current = false;
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        publishDraft(event.currentTarget);
        if (
          blurredDuringCompositionRef.current &&
          document.activeElement !== event.currentTarget
        ) {
          blurredDuringCompositionRef.current = false;
          commit(event.currentTarget);
        }
      }}
      onPaste={(event) => {
        event.preventDefault();
        insertPlainText(
          event.currentTarget,
          event.clipboardData.getData("text/plain"),
        );
      }}
      onDrop={(event) => event.preventDefault()}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={() => {
        if (edit.status !== "editing") return;
        if (composingRef.current) {
          blurredDuringCompositionRef.current = true;
        } else {
          const editor = editorRef.current;
          if (editor) commit(editor);
        }
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (composingRef.current) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel(edit);
        } else if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          edit.status === "editing"
        ) {
          event.preventDefault();
          commit(event.currentTarget);
        }
      }}
    />
  );
});

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

// --- CONSTANTS ---

const DESIGN_COLUMN_CLS =
  "border-border1 relative flex min-h-0 min-w-[min(456px,66%)] flex-1 overflow-hidden border-l bg-bg1";
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
const EMPTY_NODE_IDS: readonly string[] = Object.freeze([]);
const DESIGN_CANVAS_INVERSE_ZOOM = "var(--design-canvas-inverse-zoom)";
/** The origin marker keeps a constant screen size, so on a selection only a few
 * marker-widths across it stops reading as a pivot and starts covering the
 * element. Below six times its own hit box — roughly 108 screen pixels, or a
 * 48×30 element under ~2.5× zoom — the marker is not drawn at all, and zooming
 * out far enough always retires it. */
const DESIGN_ORIGIN_HANDLE_MINIMUM = 108;
/** Snap distance, in screen pixels, from a dragged origin to a box anchor. */
const DESIGN_ORIGIN_SNAP_DISTANCE = 6;

type DesignCanvasWorldStyle = React.CSSProperties & {
  "--design-canvas-zoom": number;
  "--design-canvas-inverse-zoom": number;
};

/** Canvas chrome is authored in world coordinates but must keep a stable
 * physical size. A CSS custom property lets an imperative wheel/pan paint
 * update the camera and every descendant affordance in the same style pass,
 * without waiting for the debounced React store commit. */
function designCanvasScreenPixels(pixels: number): string {
  return `calc(${pixels}px * ${DESIGN_CANVAS_INVERSE_ZOOM})`;
}

function designCanvasCameraStyle(
  viewport: DesignViewport,
): DesignCanvasWorldStyle {
  return {
    transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`,
    "--design-canvas-zoom": viewport.zoom,
    "--design-canvas-inverse-zoom": 1 / viewport.zoom,
  };
}

function paintDesignCanvasCamera(
  world: HTMLDivElement | null,
  viewport: DesignViewport,
  gestureActive: boolean,
): void {
  if (!world) return;
  const style = designCanvasCameraStyle(viewport);
  world.style.transform = String(style.transform);
  world.style.setProperty("--design-canvas-zoom", String(viewport.zoom));
  world.style.setProperty(
    "--design-canvas-inverse-zoom",
    String(1 / viewport.zoom),
  );
  world.toggleAttribute("data-design-camera-gesture", gestureActive);
}

// --- WORKFLOWS ---

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "The design could not load.";
  // Raw transport diagnostics ("Request timeout: WORKSPACE_REQUEST",
  // "Engine swapping — request aborted") describe the bridge, not the user's
  // edit. The write may still have landed; stale-generation replay and the
  // reconnect revalidation converge the canvas either way.
  if (
    /^Request timeout: /.test(message) ||
    message.includes("Engine swapping — request aborted")
  ) {
    return "The workspace engine didn't respond in time. If the change applied, the canvas catches up automatically — otherwise try again.";
  }
  return message;
}

function blocksDesignCanvasDoubleClick(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest("[data-design-controls]");
  return Boolean(
    control && control.closest("[data-design-inline-spacing]") === null,
  );
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

/** Every gesture paints the one selected overlay directly, so its placement
 * must be expressible without React. A rotated selection is anchored on its
 * pivot, which no rotation can move, and an upright one keeps the exact
 * left/top/width/height it has always had. */
function designSelectionOverlayStyle(
  overlay: DesignSelectionOverlayFrame,
): React.CSSProperties {
  return {
    left: overlay.left,
    top: overlay.top,
    width: overlay.width,
    height: overlay.height,
    ...(overlay.rotation
      ? {
          transform: `rotate(${overlay.rotation}deg)`,
          transformOrigin: `${overlay.pivotX}px ${overlay.pivotY}px`,
        }
      : {}),
  };
}

/** Write a label's text without replacing the node React rendered.
 * `replaceChildren` and `textContent` both detach the text node React's fiber
 * points at; React's next update then writes into a node that is no longer in
 * the document, and the label silently freezes at its last painted value. */
function paintDesignLabelText(element: HTMLElement | null, text: string): void {
  if (!element) return;
  const first = element.firstChild;
  if (first && first.nodeType === Node.TEXT_NODE && !first.nextSibling) {
    if (first.nodeValue !== text) first.nodeValue = text;
    return;
  }
  element.textContent = text;
}

function paintDesignNodeOverlayGeometry(
  element: HTMLElement,
  overlay: DesignSelectionOverlayFrame,
): void {
  element.style.left = `${overlay.left}px`;
  element.style.top = `${overlay.top}px`;
  element.style.width = `${overlay.width}px`;
  element.style.height = `${overlay.height}px`;
  element.style.transform = overlay.rotation
    ? `rotate(${overlay.rotation}deg)`
    : "";
  element.style.transformOrigin = overlay.rotation
    ? `${overlay.pivotX}px ${overlay.pivotY}px`
    : "";
  paintDesignLabelText(
    element.querySelector<HTMLElement>("[data-design-selection-size]"),
    `${Math.round(overlay.width)} × ${Math.round(overlay.height)}`,
  );
  // The pivot rides the box it turns about, and both it and the angle readout
  // counter-rotate to stay upright. React renders them from the same overlay
  // frame; a gesture that repaints the box owes them the same update, or the
  // reticle drifts off the pivot and the readout tilts as you drag.
  const pivot = element.querySelector<HTMLElement>(
    "[data-design-origin-handle]",
  );
  if (pivot) {
    const originX = Number(pivot.dataset.designOriginX);
    const originY = Number(pivot.dataset.designOriginY);
    if (Number.isFinite(originX) && Number.isFinite(originY)) {
      pivot.style.left = `${originX * overlay.width}px`;
      pivot.style.top = `${originY * overlay.height}px`;
    }
    pivot.style.transform = `translate(-50%, -50%) rotate(${-overlay.rotation}deg)`;
  }
  const readout = element.querySelector<HTMLElement>(
    "[data-design-rotation-feedback]",
  );
  if (readout) {
    readout.style.transform = `rotate(${-overlay.rotation}deg) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`;
  }
}

/** Dashed runs from the selection to the parent edges its CSS pins it to — the
 * constraint, in the properties HTML actually has. They live in frame space
 * rather than inside the rotated overlay, because a constraint describes where
 * the box is anchored, not which way the element faces. The spans render even
 * at zero length (hidden) so gesture paints can reveal them. */
function DesignConstraintGuides({
  nodeId,
  bounds,
  parentRect,
  sides,
}: {
  nodeId: string;
  bounds: DesignCanvasRect;
  parentRect: DesignCanvasRect;
  sides: DesignConstraintSides;
}) {
  const guides = designConstraintGuides(bounds, parentRect, sides);
  return (
    <span
      data-design-parent-guides={nodeId}
      data-parent-x={parentRect.x}
      data-parent-y={parentRect.y}
      data-parent-width={parentRect.width}
      data-parent-height={parentRect.height}
      data-constraint-sides={[...sides.horizontal, ...sides.vertical].join(" ")}
      className="pointer-events-none absolute inset-0 z-[1]"
      aria-hidden="true"
    >
      {guides.map((guide) => (
        <span
          key={guide.side}
          data-design-parent-guide={guide.side}
          className={cn(
            "zd-design-parent-guide absolute border-dashed",
            guide.axis === "vertical" ? "border-l" : "border-t",
          )}
          style={{
            left: guide.x,
            top: guide.y,
            width: guide.axis === "vertical" ? 0 : guide.length,
            height: guide.axis === "vertical" ? guide.length : 0,
            borderLeftWidth:
              guide.axis === "vertical"
                ? designCanvasScreenPixels(1)
                : undefined,
            borderTopWidth:
              guide.axis === "horizontal"
                ? designCanvasScreenPixels(1)
                : undefined,
            display: guide.length > 0.5 ? undefined : "none",
          }}
        />
      ))}
    </span>
  );
}

/** Gesture paints repaint the guides directly: the parent stays put while one
 * element moves or resizes, so the runs follow the painted bounding box. */
function paintDesignConstraintGuides(
  guides: HTMLElement | null,
  bounds: DesignCanvasRect,
): void {
  if (!guides) return;
  const parent = {
    x: Number(guides.dataset.parentX),
    y: Number(guides.dataset.parentY),
    width: Number(guides.dataset.parentWidth),
    height: Number(guides.dataset.parentHeight),
  };
  if (Object.values(parent).some((value) => !Number.isFinite(value))) return;
  const sides = (guides.dataset.constraintSides ?? "")
    .split(" ")
    .filter(Boolean) as DesignConstraintSide[];
  const painted = designConstraintGuides(bounds, parent, {
    horizontal: sides.filter((side) => side === "left" || side === "right"),
    vertical: sides.filter((side) => side === "top" || side === "bottom"),
  });
  for (const guide of painted) {
    const element = guides.querySelector<HTMLElement>(
      `[data-design-parent-guide="${guide.side}"]`,
    );
    if (!element) continue;
    element.style.left = `${guide.x}px`;
    element.style.top = `${guide.y}px`;
    if (guide.axis === "vertical") element.style.height = `${guide.length}px`;
    else element.style.width = `${guide.length}px`;
    element.style.display = guide.length > 0.5 ? "" : "none";
  }
}

/** Option/Alt measurement overlay: red distance lines between the selection
 * and its measured target — the hovered node when the pointer rests on one,
 * otherwise the selection's parent (or the frame itself). Geometry is
 * frame-local, so this renders as a direct child of the frame article. */
const DesignMeasureOverlay = React.memo(function DesignMeasureOverlay({
  workspaceId,
  frameFile,
  sourceVersion,
  selected,
  parentRect,
}: {
  workspaceId: string;
  frameFile: string;
  sourceVersion: string;
  selected: DesignRuntimeNodeDetails;
  parentRect: { x: number; y: number; width: number; height: number } | null;
}) {
  const hovered = useDesignRuntimeStore((state) => {
    const workspace = state.byWorkspace[workspaceId];
    if (workspace?.hoveredFrame !== frameFile || !workspace.hoveredNodeId) {
      return null;
    }
    const details =
      workspace.frames[frameFile]?.detailsByNode[workspace.hoveredNodeId] ??
      null;
    if (
      !details ||
      details.sourceVersion !== sourceVersion ||
      details.oid === selected.oid
    ) {
      return null;
    }
    return details;
  });
  const target = hovered?.rect ?? parentRect;
  if (!target) return null;
  const { lines, extensions } = designMeasureSpacing(selected.rect, target);
  return (
    <div
      data-design-measure-overlay=""
      data-design-spacing-measurement=""
      className="pointer-events-none absolute inset-0 z-30"
      aria-hidden="true"
    >
      <span
        data-design-measure-target=""
        className="absolute outline"
        style={{
          left: target.x,
          top: target.y,
          width: target.width,
          height: target.height,
          outlineColor: "var(--red-primary)",
          outlineWidth: designCanvasScreenPixels(1),
        }}
      />
      {extensions.map((extension, index) => (
        <span
          key={`extension:${index}`}
          data-design-measure-extension=""
          className={cn(
            "absolute border-dashed",
            extension.axis === "vertical" ? "border-l" : "border-t",
          )}
          style={{
            left: extension.x,
            top: extension.y,
            width: extension.axis === "vertical" ? 0 : extension.length,
            height: extension.axis === "vertical" ? extension.length : 0,
            borderColor: "var(--red-primary)",
            borderLeftWidth:
              extension.axis === "vertical"
                ? designCanvasScreenPixels(1)
                : undefined,
            borderTopWidth:
              extension.axis === "horizontal"
                ? designCanvasScreenPixels(1)
                : undefined,
          }}
        />
      ))}
      {lines.map((measurement) => {
        const horizontal = measurement.axis === "horizontal";
        return (
          <span
            key={measurement.side}
            data-design-measure={measurement.side}
            className="bg-red-primary absolute"
            style={{
              left: measurement.x,
              top: measurement.y,
              width: horizontal
                ? measurement.length
                : designCanvasScreenPixels(1),
              height: horizontal
                ? designCanvasScreenPixels(1)
                : measurement.length,
            }}
          >
            <span
              className="bg-red-primary absolute rounded-sm px-1 font-mono text-[9px] leading-4 whitespace-nowrap text-[var(--design-selection-label-fg)]"
              style={{
                left: horizontal ? "50%" : 0,
                top: horizontal ? 0 : "50%",
                transform: `translate(-50%, -50%) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
                transformOrigin: "center",
              }}
            >
              {Math.round(measurement.distance)}
            </span>
          </span>
        );
      })}
    </div>
  );
});

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
const DESIGN_CORNER_RESIZE_HANDLES = DESIGN_RESIZE_HANDLES.filter(
  ({ x, y }) => x !== "center" && y !== "center",
);
const DESIGN_EDGE_RESIZE_HANDLES = DESIGN_RESIZE_HANDLES.filter(
  ({ x, y }) => x === "center" || y === "center",
);

function DesignResizeHandles({
  label,
  onPointerDown,
}: {
  label: string;
  onPointerDown: (
    event: React.PointerEvent<HTMLButtonElement>,
    handle: DesignResizeHandle,
  ) => void;
}) {
  const size = designCanvasScreenPixels(8);
  // Keep a crisp four-screen-pixel resize strip inside the outline. Wider
  // bands steal pointer intent from padding/gap controls that legitimately
  // approach the same edge on small or zero-spacing containers.
  const edgeHitSize = designCanvasScreenPixels(4);
  // Visible squares live on the four corners only; edges keep their invisible
  // resize strips so mid-edge resizing still works without the extra chrome.
  const handles = DESIGN_CORNER_RESIZE_HANDLES;
  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      {DESIGN_EDGE_RESIZE_HANDLES.map(({ handle, x, y, cursor }) => {
        const horizontal = x === "center";
        return (
          <button
            key={`edge:${handle}`}
            data-design-controls
            data-design-resize-edge={handle}
            type="button"
            className="pointer-events-auto absolute z-0 border-0 bg-transparent p-0"
            style={
              horizontal
                ? {
                    right: designCanvasScreenPixels(4),
                    left: designCanvasScreenPixels(4),
                    top: y === "top" ? 0 : `calc(100% - ${edgeHitSize})`,
                    height: edgeHitSize,
                    cursor,
                  }
                : {
                    top: designCanvasScreenPixels(4),
                    bottom: designCanvasScreenPixels(4),
                    left: x === "left" ? 0 : `calc(100% - ${edgeHitSize})`,
                    width: edgeHitSize,
                    cursor,
                  }
            }
            aria-label={`Resize ${label} from ${handle} edge`}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPointerDown(event, handle);
            }}
          />
        );
      })}
      {handles.map(({ handle, x, y, cursor }) => (
        <button
          key={handle}
          data-design-controls
          type="button"
          className="zd-design-selection-handle pointer-events-auto absolute rounded-[1px] border"
          style={{
            width: size,
            height: size,
            left: x === "left" ? 0 : x === "center" ? "50%" : "100%",
            top: y === "top" ? 0 : y === "center" ? "50%" : "100%",
            transform: "translate(-50%, -50%)",
            cursor,
            borderWidth: designCanvasScreenPixels(1),
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

/** Rotation lives just outside each corner instead of on a separate button:
 * hovering past a corner shows a rotation cursor aimed the way the drag will
 * turn, which keeps the resting selection free of extra chrome. The zones stop
 * short of the corner so the resize square keeps its own hit area, and entering
 * one arms the rotation pivot for dragging. */
function DesignRotationHandles({
  label,
  rotation,
  onPointerDown,
}: {
  label: string;
  /** The selection's painted rotation, so each cursor stays aimed at the box. */
  rotation: number;
  onPointerDown: (
    event: React.PointerEvent<HTMLButtonElement>,
    corner: DesignRotationCorner,
  ) => void;
}) {
  const size = designCanvasScreenPixels(20);
  const inset = designCanvasScreenPixels(5);
  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {DESIGN_ROTATION_CORNERS.map(({ corner, x, y, cursorAngle }) => (
        <button
          key={corner}
          data-design-controls
          data-design-rotate-corner={corner}
          type="button"
          className="pointer-events-auto absolute border-0 bg-transparent p-0"
          style={{
            width: size,
            height: size,
            [x === 0 ? "right" : "left"]: `calc(100% - ${inset})`,
            [y === 0 ? "bottom" : "top"]: `calc(100% - ${inset})`,
            cursor: designRotationCursor(rotation + cursorAngle),
          }}
          aria-label={`Rotate ${label} from ${corner} corner`}
          // Arming here, in the DOM, keeps hover off React's render path.
          onPointerEnter={(event) =>
            event.currentTarget
              .closest("[data-design-element-overlay]")
              ?.setAttribute("data-design-origin-armed", "")
          }
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onPointerDown(event, corner);
          }}
        />
      ))}
    </div>
  );
}

/** The pivot every rotation turns about, authored as `transform-origin`. It
 * counter-rotates so the crosshair stays upright, and hides on a selection too
 * small to spare its center to a drag target.
 *
 * The marker is visible at rest but inert until the pointer has entered a
 * rotation corner: it sits at the element's center, where a drag means "move
 * this element" and a double-click means "edit this text". Rotation and its
 * pivot arrive together, so approaching one arms the other. */
function DesignOriginHandle({
  label,
  overlay,
  origin,
  onPointerDown,
  onReset,
}: {
  label: string;
  overlay: DesignSelectionOverlayFrame;
  /** The pivot as a fraction of the box, so a gesture repainting the overlay can
   * place the marker without re-deriving it. */
  origin: { originX: number; originY: number };
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onReset: () => void;
}) {
  const size = designCanvasScreenPixels(13);
  const hit = designCanvasScreenPixels(18);
  return (
    <div
      data-design-origin-root=""
      className="pointer-events-none absolute inset-0 z-40"
    >
      <button
        data-design-controls
        data-design-origin-handle=""
        data-design-origin-x={origin.originX}
        data-design-origin-y={origin.originY}
        type="button"
        className="absolute flex items-center justify-center border-0 bg-transparent p-0"
        style={{
          left: overlay.pivotX,
          top: overlay.pivotY,
          width: hit,
          height: hit,
          transform: `translate(-50%, -50%) rotate(${-overlay.rotation}deg)`,
          cursor: "move",
        }}
        aria-label={`Move the rotation origin of ${label}`}
        title="Drag to move the rotation origin. Double-click to center it."
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onPointerDown(event);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onReset();
        }}
      >
        {/* A reticle reads as a pivot rather than a resize square: a ringed
         * center with four ticks aimed at the axes it turns about. Stroke
         * widths are authored in screen pixels because this marker lives inside
         * the zoomed world and must not thicken with the camera. */}
        <svg
          className="zd-design-origin-marker block"
          style={{ width: size, height: size }}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          // User units inside a constant-screen-size box already hold their
          // screen width; compensating again would thin the reticle at zoom.
          strokeWidth={1.4}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="3.4" />
          <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
          <path d="M8 0.6V3M8 13V15.4M0.6 8H3M13 8H15.4" />
        </svg>
      </button>
    </div>
  );
}

/** The nine anchors a dragged origin snaps to, revealed only while dragging so
 * the resting selection stays quiet. */
function DesignOriginAnchors() {
  const size = designCanvasScreenPixels(9);
  return (
    <div
      data-design-origin-anchors=""
      className="pointer-events-none absolute inset-0 z-30 hidden"
      aria-hidden="true"
    >
      {[0, 0.5, 1].flatMap((y) =>
        [0, 0.5, 1].map((x) => (
          <span
            key={`${x}:${y}`}
            className="zd-design-origin-anchor absolute block"
            style={{
              left: `${x * 100}%`,
              top: `${y * 100}%`,
              width: size,
              height: size,
              transform: "translate(-50%, -50%)",
              borderWidth: designCanvasScreenPixels(1),
            }}
          />
        )),
      )}
    </div>
  );
}

/** Percentage origins keep the pivot in place when the element resizes, which
 * is what a pivot should do, and read cleanly in the authored source. */
function roundedOriginPercentage(fraction: number): number {
  return Math.round(fraction * 10_000) / 100;
}

/** The `transform-origin` change plus the translation that keeps an already
 * transformed element from jumping when its pivot moves. An authored transform
 * the editor cannot decompose keeps its exact text: rewriting it from a partial
 * parse would silently discard the parts it did not understand. */
function designOriginStyles(
  box: DesignSelectionBox,
  transform: DesignTransformValue,
  next: { originX: number; originY: number },
): Record<string, string> {
  const styles: Record<string, string> = {
    "transform-origin": `${roundedOriginPercentage(next.originX)}% ${roundedOriginPercentage(next.originY)}%`,
  };
  if (transform.raw !== undefined) return styles;
  const shift = designOriginTranslationShift({
    width: box.width,
    height: box.height,
    originX: box.originX,
    originY: box.originY,
    nextOriginX: next.originX,
    nextOriginY: next.originY,
    transform,
  });
  if (Math.abs(shift.x) > 0.01 || Math.abs(shift.y) > 0.01) {
    styles.transform = formatDesignTransform({
      ...transform,
      x: transform.x + shift.x,
      xUnit: "px",
      y: transform.y + shift.y,
      yUnit: "px",
    });
  }
  return styles;
}

/** What every canvas paint actually reads. A node's full runtime details and a
 * gesture's lean geometry both satisfy it, so one helper serves both. */
type DesignPaintedNode = {
  rect: DesignCanvasRect;
  styles: Record<string, string>;
};

type DesignPaintedChild = DesignPaintedNode & {
  oid: string;
  name: string;
};

function designPixelValue(value: string | undefined): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value?.trim() ?? "");
  return match?.[1] ? Math.max(0, Number(match[1])) : 0;
}

function designPixelLength(value: string | undefined): number | null {
  const match = /^(-?\d+(?:\.\d+)?)px$/i.exec(value?.trim() ?? "");
  return match?.[1] ? Number(match[1]) : null;
}

/** The pixel value one gesture step must build on.
 *
 * A second drag can begin before the first one's source commit has been
 * adopted, and the runtime store still holds the pre-commit details until it
 * is. Building on those authors the new delta from the stale base and silently
 * discards the previous drag, so the speculative value the commit is still
 * landing wins — but only where it is a length a gesture can add to. An
 * inspector can leave `50%` or `calc(…)` speculative on the same property, and
 * there only the computed value says where that actually put the element. */
function designGesturePixelBase(
  owner: { workspaceId: string; frame: string; nodeId: string },
  property: string,
  computed: string | undefined,
  fallback = 0,
): number {
  const live = designLivePreviewValue(
    owner.workspaceId,
    owner.frame,
    owner.nodeId,
    property,
  );
  return (
    (typeof live === "string" ? designPixelLength(live) : null) ??
    designPixelLength(computed) ??
    fallback
  );
}

interface DesignInlineSpacingControl {
  property:
    | "padding-top"
    | "padding-right"
    | "padding-bottom"
    | "padding-left"
    | "gap"
    | "row-gap"
    | "column-gap";
  oppositeProperty?:
    | "padding-top"
    | "padding-right"
    | "padding-bottom"
    | "padding-left";
  axis: "x" | "y";
  direction: 1 | -1;
  value: number;
  regionKey?: string;
}

interface DesignMotionOverlayState {
  owner: string;
  draft: DesignMotionTimelineDraft | null;
}

function paintDesignInlineGapHandle(
  handle: HTMLElement,
  region: DesignInlineGapRegion,
  zoom: number,
): void {
  const { hitRect, visualRect } = designInlineGapGeometry(region, zoom);
  handle.style.visibility = "visible";
  handle.style.left = `${hitRect.x}px`;
  handle.style.top = `${hitRect.y}px`;
  handle.style.width = `${hitRect.width}px`;
  handle.style.height = `${hitRect.height}px`;
  const visual = handle.querySelector<HTMLElement>(
    "[data-design-inline-gap-visual]",
  );
  if (!visual) return;
  visual.style.left = `${visualRect.x}px`;
  visual.style.top = `${visualRect.y}px`;
  visual.style.width = `${visualRect.width}px`;
  visual.style.height = `${visualRect.height}px`;
}

function paintDesignInlineGapHandles(
  root: HTMLElement,
  containerDetails: DesignPaintedNode,
  childDetails: readonly DesignPaintedChild[],
  zoom: number,
): void {
  const regions = designInlineGapRegions({
    container: containerDetails.rect,
    children: childDetails.map((child) => ({
      id: child.oid,
      rect: child.rect,
      position: child.styles.position,
    })),
    display: containerDetails.styles.display,
    flexDirection: containerDetails.styles.flexDirection,
    flexWrap: containerDetails.styles.flexWrap,
  });
  const regionsByKey = new Map(regions.map((region) => [region.key, region]));
  for (const handle of root.querySelectorAll<HTMLElement>(
    "[data-design-inline-gap-region]",
  )) {
    const key = handle.dataset.designInlineGapRegion;
    const region = key ? regionsByKey.get(key) : null;
    if (!region) {
      handle.style.visibility = "hidden";
      continue;
    }
    paintDesignInlineGapHandle(handle, region, zoom);
  }
}

function paintDesignInlinePaddingGeometry(
  root: HTMLElement,
  details: DesignPaintedNode,
): void {
  const sides = [
    ["top", details.styles.paddingTop, details.rect.height / 2],
    ["right", details.styles.paddingRight, details.rect.width / 2],
    ["bottom", details.styles.paddingBottom, details.rect.height / 2],
    ["left", details.styles.paddingLeft, details.rect.width / 2],
  ] as const;
  for (const [side, rawValue, maximum] of sides) {
    const value = Math.min(maximum, designPixelValue(rawValue));
    root.style.setProperty(`--design-inline-padding-${side}`, `${value}px`);
    root.style.setProperty(
      `--design-inline-padding-${side}-center`,
      `${value / 2}px`,
    );
  }
}

function designInspectorPreviewOverlay(
  workspaceId: string,
  frame: string,
  nodeId: string,
): HTMLElement | null {
  const surface = document.querySelector<HTMLElement>(
    `[data-design-workspace-surface][data-design-workspace-id="${CSS.escape(workspaceId)}"]`,
  );
  const frameElement = surface?.querySelector<HTMLElement>(
    `[data-design-frame="${CSS.escape(frame)}"]`,
  );
  return (
    frameElement?.querySelector<HTMLElement>(
      `[data-design-element-overlay="${CSS.escape(nodeId)}"]`,
    ) ?? null
  );
}

function paintDesignFrameGeometryPreview(
  workspaceId: string,
  frame: string,
  geometry: DesignFrameGeometryWire,
): void {
  const surface = document.querySelector<HTMLElement>(
    `[data-design-workspace-surface][data-design-workspace-id="${CSS.escape(workspaceId)}"]`,
  );
  const frameElement = surface?.querySelector<HTMLElement>(
    `[data-design-frame="${CSS.escape(frame)}"]`,
  );
  if (!frameElement) return;
  frameElement.style.left = `${geometry.x}px`;
  frameElement.style.top = `${geometry.y}px`;
  frameElement.style.width = `${geometry.w}px`;
  frameElement.style.height = `${geometry.h}px`;
  const size = frameElement.querySelector<HTMLElement>(
    "[data-design-frame-size]",
  );
  if (size) {
    size.textContent = `${Math.round(geometry.w)} × ${Math.round(geometry.h)}`;
  }
}

function paintedDesignFrameGeometry(
  workspaceId: string,
  frame: string,
  fallback: DesignFrameGeometryWire,
): DesignFrameGeometryWire {
  const surface = document.querySelector<HTMLElement>(
    `[data-design-workspace-surface][data-design-workspace-id="${CSS.escape(workspaceId)}"]`,
  );
  const element = surface?.querySelector<HTMLElement>(
    `[data-design-frame="${CSS.escape(frame)}"]`,
  );
  if (!element) return fallback;
  const number = (value: string, prior: number) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : prior;
  };
  return {
    x: number(element.style.left, fallback.x),
    y: number(element.style.top, fallback.y),
    w: number(element.style.width, fallback.w),
    h: number(element.style.height, fallback.h),
    z: fallback.z,
  };
}

/** Paint one inspector preview into the already-mounted selection island.
 * The iframe owns element pixels; this keeps only the blue overlay and its
 * spacing geometry in lockstep without publishing a broad runtime snapshot. */
function paintDesignInspectorPreviewDetails(
  workspaceId: string,
  frame: string,
  details: DesignPaintedNode & { oid: string; box?: DesignSelectionBox },
): HTMLElement | null {
  const overlay = designInspectorPreviewOverlay(
    workspaceId,
    frame,
    details.oid,
  );
  if (!overlay) return null;
  paintDesignNodeOverlayGeometry(
    overlay,
    designSelectionOverlayFrame(designSelectionBox(details)),
  );
  const spacingRoot = overlay.querySelector<HTMLElement>(
    "[data-design-inline-spacing-root]",
  );
  if (spacingRoot) paintDesignInlinePaddingGeometry(spacingRoot, details);
  return spacingRoot;
}

function DesignSelectionMeasurements({
  details,
  overlay,
  children,
  zoom,
  onSpacingPointerDown,
}: {
  details: DesignRuntimeNodeDetails;
  /** Painted geometry of the owning overlay. Padding, tracks, and the size
   * label all describe the element's own box, which a rotation grows a larger
   * bounding box around. */
  overlay: DesignSelectionOverlayFrame;
  children: readonly DesignPaintedChild[];
  zoom: number;
  onSpacingPointerDown?: (
    event: React.PointerEvent<HTMLButtonElement>,
    control: DesignInlineSpacingControl,
  ) => void;
}) {
  const paddingTop = designPixelValue(details.styles.paddingTop);
  const paddingRight = designPixelValue(details.styles.paddingRight);
  const paddingBottom = designPixelValue(details.styles.paddingBottom);
  const paddingLeft = designPixelValue(details.styles.paddingLeft);
  const top = Math.min(overlay.height / 2, paddingTop);
  const right = Math.min(overlay.width / 2, paddingRight);
  const bottom = Math.min(overlay.height / 2, paddingBottom);
  const left = Math.min(overlay.width / 2, paddingLeft);
  const display = details.styles.display;
  const gap = designPixelValue(details.styles.gap);
  const rowGap =
    designPixelValue(details.styles.rowGap) ||
    designPixelValue(details.styles.gap);
  const columnGap =
    designPixelValue(details.styles.columnGap) ||
    designPixelValue(details.styles.gap);
  const layoutToolsActive =
    Boolean(onSpacingPointerDown) &&
    ["flex", "inline-flex", "grid", "inline-grid"].includes(display);
  const gapRegions = layoutToolsActive
    ? designInlineGapRegions({
        container: details.rect,
        children: children.map((child) => ({
          id: child.oid,
          rect: child.rect,
          position: child.styles.position,
        })),
        display,
        flexDirection: details.styles.flexDirection,
        flexWrap: details.styles.flexWrap,
      })
    : [];
  const gridColumns =
    display === "grid"
      ? designGridTrackSegments(
          details.styles.gridTemplateColumns,
          Math.max(1, overlay.width - left - right),
        )
      : [];
  const gridRows =
    display === "grid"
      ? designGridTrackSegments(
          details.styles.gridTemplateRows,
          Math.max(1, overlay.height - top - bottom),
        )
      : [];
  const paddingControls = [
    {
      property: "padding-top" as const,
      oppositeProperty: "padding-bottom" as const,
      axis: "y" as const,
      direction: 1 as const,
      value: paddingTop,
      left: "50%",
      top: "var(--design-inline-padding-top-center)",
      highlight: {
        top: 0,
        right: 0,
        left: 0,
        height: "var(--design-inline-padding-top)",
      },
      cursor: "ns-resize",
    },
    {
      property: "padding-right" as const,
      oppositeProperty: "padding-left" as const,
      axis: "x" as const,
      direction: -1 as const,
      value: paddingRight,
      left: "calc(100% - var(--design-inline-padding-right-center))",
      top: "50%",
      highlight: {
        top: 0,
        right: 0,
        bottom: 0,
        width: "var(--design-inline-padding-right)",
      },
      cursor: "ew-resize",
    },
    {
      property: "padding-bottom" as const,
      oppositeProperty: "padding-top" as const,
      axis: "y" as const,
      direction: -1 as const,
      value: paddingBottom,
      left: "50%",
      top: "calc(100% - var(--design-inline-padding-bottom-center))",
      highlight: {
        right: 0,
        bottom: 0,
        left: 0,
        height: "var(--design-inline-padding-bottom)",
      },
      cursor: "ns-resize",
    },
    {
      property: "padding-left" as const,
      oppositeProperty: "padding-right" as const,
      axis: "x" as const,
      direction: 1 as const,
      value: paddingLeft,
      left: "var(--design-inline-padding-left-center)",
      top: "50%",
      highlight: {
        top: 0,
        bottom: 0,
        left: 0,
        width: "var(--design-inline-padding-left)",
      },
      cursor: "ew-resize",
    },
  ];
  const spacingRootStyle = {
    "--design-inline-padding-top": `${top}px`,
    "--design-inline-padding-right": `${right}px`,
    "--design-inline-padding-bottom": `${bottom}px`,
    "--design-inline-padding-left": `${left}px`,
    "--design-inline-padding-top-center": `${top / 2}px`,
    "--design-inline-padding-right-center": `${right / 2}px`,
    "--design-inline-padding-bottom-center": `${bottom / 2}px`,
    "--design-inline-padding-left-center": `${left / 2}px`,
  } as React.CSSProperties;
  const gapValue = (region: DesignInlineGapRegion) =>
    region.property === "row-gap"
      ? rowGap
      : region.property === "column-gap"
        ? columnGap
        : gap;
  return (
    <>
      {layoutToolsActive ? (
        <span
          data-design-inline-spacing-root=""
          className="pointer-events-none absolute inset-0"
          style={spacingRootStyle}
        >
          {gridColumns.map((segment, index) =>
            segment.end < 100 ? (
              <span
                key={`column:${index}`}
                data-design-grid-track="column"
                className="zd-design-grid-line pointer-events-none absolute top-0 bottom-0 border-l border-dashed"
                style={{
                  left:
                    left + ((overlay.width - left - right) * segment.end) / 100,
                  borderWidth: 1 / zoom,
                }}
              />
            ) : null,
          )}
          {gridColumns.length <= 12
            ? gridColumns.map((segment, index) => (
                <span
                  key={`column-label:${index}`}
                  data-design-grid-track-label="column"
                  className="zd-design-grid-track-label pointer-events-none absolute z-20 rounded-sm border px-1 font-mono whitespace-nowrap"
                  style={{
                    left:
                      left +
                      ((overlay.width - left - right) *
                        ((segment.start + segment.end) / 2)) /
                        100,
                    top,
                    borderWidth: 1 / zoom,
                    fontSize: 9 / zoom,
                    lineHeight: `${14 / zoom}px`,
                    transform: "translate(-50%, -50%)",
                  }}
                >
                  {segment.label.replace(/(\.\d{1})\d+(px)$/i, "$1$2")}
                </span>
              ))
            : null}
          {gridRows.map((segment, index) =>
            segment.end < 100 ? (
              <span
                key={`row:${index}`}
                data-design-grid-track="row"
                className="zd-design-grid-line pointer-events-none absolute right-0 left-0 border-t border-dashed"
                style={{
                  top:
                    top + ((overlay.height - top - bottom) * segment.end) / 100,
                  borderWidth: 1 / zoom,
                }}
              />
            ) : null,
          )}
          {gridRows.length <= 12
            ? gridRows.map((segment, index) => (
                <span
                  key={`row-label:${index}`}
                  data-design-grid-track-label="row"
                  className="zd-design-grid-track-label pointer-events-none absolute z-20 rounded-sm border px-1 font-mono whitespace-nowrap"
                  style={{
                    left,
                    top:
                      top +
                      ((overlay.height - top - bottom) *
                        ((segment.start + segment.end) / 2)) /
                        100,
                    borderWidth: 1 / zoom,
                    fontSize: 9 / zoom,
                    lineHeight: `${14 / zoom}px`,
                    transform: "translate(-50%, -50%) rotate(-90deg)",
                  }}
                >
                  {segment.label.replace(/(\.\d{1})\d+(px)$/i, "$1$2")}
                </span>
              ))
            : null}
          {paddingControls.map((control) => (
            <span
              key={control.property}
              data-design-inline-padding-control={control.property}
              className="zd-design-inline-padding-control pointer-events-none absolute inset-0"
            >
              <span
                data-design-inline-spacing-highlight={control.property}
                className="zd-design-inline-spacing-highlight pointer-events-none absolute"
                style={control.highlight}
                aria-hidden="true"
              />
              <button
                data-design-controls
                data-design-inline-spacing={control.property}
                data-design-inline-spacing-axis={control.axis}
                type="button"
                className="zd-design-inline-spacing-handle pointer-events-auto absolute z-30 flex items-center justify-center"
                style={{
                  left: control.left,
                  top: control.top,
                  width: 28 / zoom,
                  height: 20 / zoom,
                  transform: "translate(-50%, -50%)",
                  cursor: control.cursor,
                }}
                aria-label={`Adjust ${control.property}`}
                title={`Drag to adjust ${control.property}. Shift snaps to 8px; Option mirrors the opposite side.`}
                onPointerDown={(event) =>
                  onSpacingPointerDown?.(event, control)
                }
              >
                <span
                  data-design-inline-spacing-line=""
                  className="zd-design-inline-spacing-line pointer-events-none absolute box-border border"
                  style={{
                    width: (control.axis === "y" ? 14 : 3) / zoom,
                    height: (control.axis === "x" ? 14 : 3) / zoom,
                    borderWidth: 1 / zoom,
                  }}
                  aria-hidden="true"
                />
                <span
                  data-design-inline-spacing-value={control.property}
                  className="zd-design-inline-spacing-value pointer-events-none absolute left-1/2 rounded-sm font-mono font-medium whitespace-nowrap"
                  style={{
                    bottom: `calc(50% + ${5 / zoom}px)`,
                    paddingInline: 4 / zoom,
                    fontSize: 9 / zoom,
                    lineHeight: `${16 / zoom}px`,
                    transform: "translateX(-50%)",
                  }}
                >
                  {Math.round(control.value)}
                </span>
              </button>
            </span>
          ))}
          {gapRegions.map((region) => {
            const value = gapValue(region);
            const { hitRect, visualRect } = designInlineGapGeometry(
              region,
              zoom,
            );
            const childNames = children
              .filter(
                (child) =>
                  child.oid === region.leadingId ||
                  child.oid === region.trailingId,
              )
              .map((child) => child.name);
            return (
              <button
                key={region.key}
                data-design-controls
                data-design-inline-spacing={region.property}
                data-design-inline-spacing-axis={region.axis}
                data-design-inline-gap-region={region.key}
                type="button"
                className="zd-design-inline-gap-handle pointer-events-auto absolute z-20 flex items-center justify-center"
                style={{
                  left: hitRect.x,
                  top: hitRect.y,
                  width: hitRect.width,
                  height: hitRect.height,
                  // A gesture paint may hide a region that momentarily has no
                  // space; naming it here is what lets React reveal it again.
                  visibility: "visible",
                  cursor: region.axis === "x" ? "ew-resize" : "ns-resize",
                }}
                aria-label={`Adjust ${region.property} between ${childNames.join(" and ")}`}
                title="Drag to adjust gap. Shift snaps to 8px."
                onPointerDown={(event) =>
                  onSpacingPointerDown?.(event, {
                    property: region.property,
                    axis: region.axis,
                    direction: 1,
                    value,
                    regionKey: region.key,
                  })
                }
              >
                <span
                  data-design-inline-gap-visual=""
                  data-design-inline-spacing-highlight={region.key}
                  className="zd-design-inline-spacing-highlight pointer-events-none absolute"
                  style={{
                    left: visualRect.x,
                    top: visualRect.y,
                    width: visualRect.width,
                    height: visualRect.height,
                  }}
                  aria-hidden="true"
                />
                <span
                  data-design-inline-spacing-line=""
                  className="zd-design-inline-spacing-line pointer-events-none absolute box-border border"
                  style={{
                    width: (region.axis === "y" ? 14 : 3) / zoom,
                    height: (region.axis === "x" ? 14 : 3) / zoom,
                    borderWidth: 1 / zoom,
                  }}
                  aria-hidden="true"
                />
                <span
                  data-design-inline-spacing-value={region.property}
                  className="zd-design-inline-spacing-value pointer-events-none absolute left-1/2 rounded-sm font-mono font-medium whitespace-nowrap"
                  style={{
                    bottom: `calc(50% + ${5 / zoom}px)`,
                    paddingInline: 4 / zoom,
                    fontSize: 9 / zoom,
                    lineHeight: `${16 / zoom}px`,
                    transform: "translateX(-50%)",
                  }}
                >
                  {Math.round(value)}
                </span>
              </button>
            );
          })}
        </span>
      ) : null}
      <span
        data-design-selection-size=""
        className="zd-design-selection-label pointer-events-none absolute top-full left-1/2 -translate-x-1/2 rounded-sm px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap"
        style={{
          marginTop: designCanvasScreenPixels(4),
          transform: `translateX(-50%) scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
          transformOrigin: "top center",
        }}
      >
        {`${Math.round(overlay.width)} × ${Math.round(overlay.height)}`}
      </span>
    </>
  );
}

const DesignLayerHoverOverlay = React.memo(function DesignLayerHoverOverlay({
  workspaceId,
  frame,
  sourceVersion,
  selectedNodeIds,
}: {
  workspaceId: string;
  frame: string;
  sourceVersion: string;
  selectedNodeIds: readonly string[];
}) {
  const details = useDesignRuntimeStore((state) => {
    const workspace = state.byWorkspace[workspaceId];
    if (workspace?.hoveredFrame !== frame || !workspace.hoveredNodeId) {
      return null;
    }
    const hovered =
      workspace.frames[frame]?.detailsByNode[workspace.hoveredNodeId] ?? null;
    if (
      !hovered ||
      hovered.sourceVersion !== sourceVersion ||
      selectedNodeIds.includes(hovered.oid)
    ) {
      return null;
    }
    return hovered;
  });
  if (!details) return null;
  return (
    <div
      data-design-element-overlay={details.oid}
      className="zd-design-hover-outline pointer-events-none absolute z-[1] outline"
      style={{
        ...designSelectionOverlayStyle(
          designSelectionOverlayFrame(designSelectionBox(details)),
        ),
        outlineWidth: designCanvasScreenPixels(1),
      }}
    />
  );
});

const DesignMotionCanvasOverlay = React.memo(
  function DesignMotionCanvasOverlay({
    owner,
    details,
    draft,
    onSeek,
  }: {
    owner: string;
    details: DesignRuntimeNodeDetails;
    draft: DesignMotionTimelineDraft;
    onSeek: (offset: number) => void;
  }) {
    const playhead = useDesignMotionPlayhead(owner);
    const pathPoints = useMemo(
      () => designMotionTranslationPoints(draft.keyframes),
      [draft.keyframes],
    );
    const currentTranslation = designMotionTranslationAtOffset(
      draft.keyframes,
      playhead,
    );
    const properties = useMemo(
      () => designMotionProperties(draft.keyframes),
      [draft.keyframes],
    );
    const duration = useMemo(
      () => designDurationMs(draft.duration),
      [draft.duration],
    );
    const center = useMemo(
      () => ({
        x: details.rect.width / 2,
        y: details.rect.height / 2,
      }),
      [details.rect.height, details.rect.width],
    );
    return (
      <>
        <div
          data-design-motion-inline-toolbar=""
          className="zd-design-motion-inline-toolbar pointer-events-none absolute top-0 right-0 z-30 flex items-center gap-1 rounded-sm border px-1.5 py-0.5 shadow-sm"
          style={{
            marginTop: designCanvasScreenPixels(4),
            marginRight: designCanvasScreenPixels(4),
            transform: `scale(${DESIGN_CANVAS_INVERSE_ZOOM})`,
            transformOrigin: "top right",
          }}
        >
          <Diamond className="size-2.5 fill-current" />
          <span className="text-[9px] font-medium whitespace-nowrap">
            {properties.length} {properties.length === 1 ? "track" : "tracks"}
          </span>
          <span className="font-mono text-[9px] opacity-75">
            {designMotionTimeAtOffset(playhead, duration)}ms
          </span>
        </div>
        {pathPoints.length > 1 ? (
          <>
            <svg
              data-design-motion-path=""
              aria-hidden="true"
              className="pointer-events-none absolute overflow-visible"
              style={{ left: center.x, top: center.y, width: 1, height: 1 }}
            >
              <polyline
                className="zd-design-motion-path-line"
                points={pathPoints
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
                fill="none"
                style={{
                  strokeWidth: designCanvasScreenPixels(2),
                  strokeDasharray: `${designCanvasScreenPixels(5)} ${designCanvasScreenPixels(3)}`,
                }}
              />
            </svg>
            {pathPoints.map((point) => {
              const selected = Math.abs(point.offset - playhead) < 0.05;
              return (
                <button
                  key={point.offset}
                  data-design-controls
                  data-design-motion-path-point={point.offset}
                  type="button"
                  className={cn(
                    "zd-design-motion-path-point pointer-events-auto absolute z-30 rounded-full border shadow-sm",
                    selected && "zd-design-motion-path-point-selected",
                  )}
                  style={{
                    left: center.x + point.x,
                    top: center.y + point.y,
                    width: designCanvasScreenPixels(12),
                    height: designCanvasScreenPixels(12),
                    borderWidth: designCanvasScreenPixels(1),
                    transform: "translate(-50%, -50%)",
                  }}
                  aria-label={`Seek motion to ${designMotionTimeAtOffset(point.offset, duration)}ms`}
                  aria-pressed={selected}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSeek(point.offset);
                  }}
                />
              );
            })}
            {currentTranslation ? (
              <span
                data-design-motion-current-point=""
                className="zd-design-motion-current-point pointer-events-none absolute z-20 rounded-full"
                style={{
                  left: center.x + currentTranslation.x,
                  top: center.y + currentTranslation.y,
                  width: designCanvasScreenPixels(5),
                  height: designCanvasScreenPixels(5),
                  transform: "translate(-50%, -50%)",
                }}
              />
            ) : null}
          </>
        ) : null}
      </>
    );
  },
);

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

function designHighResolutionTileKey(
  tile: DesignHighResolutionViewportTile,
): string {
  const coordinate = (value: number) => Math.round(value * 1_000_000);
  return [
    coordinate(tile.crop.x),
    coordinate(tile.crop.y),
    coordinate(tile.crop.width),
    coordinate(tile.crop.height),
    tile.outputWidth,
    tile.outputHeight,
  ].join(":");
}

async function decodeDesignHighResolutionCapture(
  dataUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  if (signal.aborted) throw new Error("Resolution capture was superseded.");
}

// ============================================
// COMPONENT: DesignFrameRenderSurface
// PURPOSE: Swap far frame runtimes for exact-generation raster snapshots
// USED IN: DesignCanvas
// ============================================

const DesignFrameRenderSurface = React.memo(function DesignFrameRenderSurface({
  workspaceId,
  protocolCapability,
  folder,
  frame,
  active,
  selected,
  selectedNodeIds,
  live,
  theme,
  highResolutionTile,
  highResolutionDisabled,
}: {
  workspaceId: string;
  protocolCapability: string | null;
  folder: string;
  frame: DesignCanvasFrameWire;
  active: boolean;
  selected: boolean;
  selectedNodeIds: readonly string[];
  live: boolean;
  theme: string | null;
  highResolutionTile: DesignHighResolutionViewportTile | null;
  highResolutionDisabled: boolean;
}) {
  const screenshot = useDesignRuntimeStore(
    (state) =>
      state.byWorkspace[workspaceId]?.frames[frame.file]?.screenshotsByNode[""],
  );
  const runtimePaintVersion = useDesignRuntimeStore(
    (state) =>
      state.byWorkspace[workspaceId]?.frames[frame.file]?.updatedAt ?? -1,
  );
  const [highResolutionCapture, setHighResolutionCapture] = useState<{
    sourceVersion: string;
    tileKey: string;
    dataUrl: string;
    crop: DesignHighResolutionViewportTile["crop"];
    width: number;
    height: number;
    scale: number;
  } | null>(null);
  const requestedTileKey = highResolutionTile
    ? designHighResolutionTileKey(highResolutionTile)
    : null;
  // At most one viewport rasterization travels to the frame runtime at a
  // time. Each capture clones and re-renders the whole document inside the
  // frame, so a stepped zoom would otherwise stack redundant clones; the
  // newest requested tile replaces the queued one instead.
  const captureFlightRef = useRef<{
    inFlight: boolean;
    queued: (() => void) | null;
  }>({ inFlight: false, queued: null });

  useEffect(() => {
    if (!active || !live || highResolutionDisabled || !highResolutionTile) {
      return;
    }
    const controller = new AbortController();
    const flight = captureFlightRef.current;
    let retryTimer: number | null = null;
    let attempts = 0;
    const tileKey = designHighResolutionTileKey(highResolutionTile);
    const capture = () => {
      if (controller.signal.aborted) return;
      const runtime = designFrameRuntime(workspaceId, frame.file);
      if (!runtime || runtime.sourceVersion !== frame.sourceVersion) {
        if (attempts < 4) {
          attempts += 1;
          retryTimer = window.setTimeout(capture, 50);
        }
        return;
      }
      if (flight.inFlight) {
        flight.queued = capture;
        return;
      }
      flight.inFlight = true;
      void runtime
        .captureViewportScreenshot(
          highResolutionTile.crop,
          {
            width: highResolutionTile.outputWidth,
            height: highResolutionTile.outputHeight,
          },
          controller.signal,
        )
        .then(async (captured) => {
          if (
            controller.signal.aborted ||
            captured.sourceVersion !== frame.sourceVersion
          ) {
            return;
          }
          await decodeDesignHighResolutionCapture(
            captured.dataUrl,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          setHighResolutionCapture({
            sourceVersion: captured.sourceVersion,
            tileKey,
            dataUrl: captured.dataUrl,
            crop: highResolutionTile.crop,
            width: captured.width,
            height: captured.height,
            scale: captured.scale,
          });
        })
        .catch(() => {
          // The live iframe remains authoritative while a newer camera or
          // document generation cancels this optional resolution tile.
        })
        .finally(() => {
          flight.inFlight = false;
          const queued = flight.queued;
          flight.queued = null;
          queued?.();
        });
    };
    capture();
    return () => {
      if (flight.queued === capture) flight.queued = null;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      controller.abort();
    };
  }, [
    active,
    frame.file,
    frame.sourceVersion,
    highResolutionDisabled,
    highResolutionTile,
    live,
    runtimePaintVersion,
    workspaceId,
  ]);

  let surface: React.ReactNode;
  if (live) {
    surface = (
      <DesignFrameRuntimeIframe
        workspaceId={workspaceId}
        protocolCapability={protocolCapability}
        folder={folder}
        frame={frame}
        active={active}
        selected={selected}
        selectedNodeIds={selectedNodeIds}
        autoCapture
        theme={theme}
        transitionCover={screenshot ?? null}
      />
    );
  } else if (screenshot?.sourceVersion === frame.sourceVersion) {
    surface = (
      <img
        src={screenshot.dataUrl}
        alt=""
        draggable={false}
        className="pointer-events-none block size-full object-fill"
      />
    );
  } else {
    surface = (
      <div className="bg-bg2 text-muted-fg pointer-events-none flex size-full items-center justify-center gap-2 text-xs">
        <FileCode2 />
        <span className="max-w-48 truncate">{frame.title}</span>
      </div>
    );
  }

  const mountedHighResolutionCapture =
    active &&
    live &&
    !highResolutionDisabled &&
    highResolutionTile &&
    highResolutionCapture?.sourceVersion === frame.sourceVersion
      ? highResolutionCapture
      : null;
  // A settled camera move invalidates the mounted tile's key while its
  // replacement is still rasterizing. The stale capture stays painted — its
  // crop is authored in frame-local coordinates, so the camera transform
  // keeps it glued to the world exactly like the previous level of a map
  // tile — and the decoded replacement swaps pixels in one paint. Hiding it
  // here would flash the compositor-magnified iframe on every zoom step.
  const currentHighResolutionCapture =
    mountedHighResolutionCapture?.tileKey === requestedTileKey
      ? mountedHighResolutionCapture
      : null;
  return (
    <div className="relative isolate size-full overflow-hidden">
      {surface}
      {mountedHighResolutionCapture ? (
        <img
          data-design-high-resolution-tile=""
          data-design-tile-current={
            currentHighResolutionCapture ? "" : undefined
          }
          data-design-tile-key={mountedHighResolutionCapture.tileKey}
          data-design-tile-source-version={
            mountedHighResolutionCapture.sourceVersion
          }
          data-design-tile-scale={mountedHighResolutionCapture.scale}
          data-design-tile-width={mountedHighResolutionCapture.width}
          data-design-tile-height={mountedHighResolutionCapture.height}
          src={mountedHighResolutionCapture.dataUrl}
          alt=""
          draggable={false}
          className="pointer-events-none absolute z-[2] block max-w-none object-fill"
          style={{
            left: mountedHighResolutionCapture.crop.x,
            top: mountedHighResolutionCapture.crop.y,
            width: mountedHighResolutionCapture.crop.width,
            height: mountedHighResolutionCapture.crop.height,
          }}
        />
      ) : null}
    </div>
  );
});

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
}: DesignWorkspaceColumnProps) {
  const [motionTimelineOpen, setMotionTimelineOpen] = useState(false);
  const [motionPropertyRequest, setMotionPropertyRequest] =
    useState<DesignMotionPropertyRequest | null>(null);
  const [motionProperties, setMotionProperties] =
    useState<readonly string[]>(EMPTY_NODE_IDS);
  const deletingFrameFilesRef = useRef(new Set<string>());
  const motionPropertyRequestIdRef = useRef(0);
  const zoomActionsRef = useRef<DesignCanvasZoomActions | null>(null);
  const workspaceId = workspace?.kind === "design" ? workspace.id : null;
  const snapshot = useDesignWorkspaceSnapshot(
    workspaceId,
    folder,
    surfaceActive,
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
  const frameSelected = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.frameSelected ?? false)
      : false,
  );
  const storedCanvasBackground = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.canvasBackground ?? null)
      : null,
  );
  const setCanvasBackground = useDesignWorkspaceUiStore(
    (state) => state.setCanvasBackground,
  );
  const themeId = useThemeId();
  const canvasBackground = useMemo(() => {
    // Reading the theme id invalidates the computed-token snapshot whenever
    // the active theme changes, while authored workspace colors remain exact.
    void themeId;
    return storedCanvasBackground ?? resolveDesignCanvasDefaultBackground();
  }, [storedCanvasBackground, themeId]);
  const commitCanvasBackground = useCallback(
    (value: string) => {
      if (!workspaceId) return;
      setCanvasBackground(workspaceId, value);
    },
    [setCanvasBackground, workspaceId],
  );
  const deleteFrame = useCallback(
    async (candidate: DesignCanvasFrameWire) => {
      if (!workspaceId || deletingFrameFilesRef.current.has(candidate.file)) {
        return;
      }
      deletingFrameFilesRef.current.add(candidate.file);
      try {
        const next = await deleteDesignFrameCached(workspaceId, candidate.file);
        // Selection publishes locally before its durable bridge write. Do not
        // make that bookkeeping delay—or misreport—a completed deletion.
        void selectDesignFrame(workspaceId, next.frames[0] ?? null).catch(
          () => {},
        );
      } catch (deleteError) {
        toast.error("Couldn't delete the design frame", {
          description: errorMessage(deleteError),
        });
      } finally {
        deletingFrameFilesRef.current.delete(candidate.file);
      }
    },
    [workspaceId],
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

  useEffect(() => {
    setMotionPropertyRequest(null);
    setMotionProperties(EMPTY_NODE_IDS);
  }, [selectedFrame?.file, selectedNodeId]);

  const openMotionTimeline = useCallback(
    (property?: string, value?: string) => {
      setMotionTimelineOpen(true);
      if (!property || value === undefined) return;
      motionPropertyRequestIdRef.current += 1;
      setMotionPropertyRequest({
        id: motionPropertyRequestIdRef.current,
        property,
        value,
      });
    },
    [],
  );

  const publishMotionProperties = useCallback(
    (properties: readonly string[]) => {
      setMotionProperties((current) =>
        current.length === properties.length &&
        current.every((property, index) => property === properties[index])
          ? current
          : [...properties],
      );
    },
    [],
  );

  // --- RENDER ---

  return (
    <section
      {...(!surfaceActive ? { inert: "" } : {})}
      data-design-workspace-surface=""
      data-design-workspace-id={workspaceId ?? undefined}
      className={DESIGN_COLUMN_CLS}
      aria-label="Design workspace"
    >
      <DesignCanvas
        workspaceId={workspaceId}
        folder={folder}
        snapshot={snapshot.data}
        loading={snapshot.loading}
        error={snapshot.error}
        refresh={snapshot.refresh}
        active={surfaceActive}
        canvasBackground={canvasBackground}
        motionTimelineOpen={motionTimelineOpen}
        motionPropertyRequest={motionPropertyRequest}
        onMotionTimelineOpenChange={setMotionTimelineOpen}
        onMotionPropertyRequestHandled={(id) =>
          setMotionPropertyRequest((current) =>
            current?.id === id ? null : current,
          )
        }
        onMotionPropertiesChange={publishMotionProperties}
        onDeleteFrame={deleteFrame}
        zoomActionsRef={zoomActionsRef}
      />
      <DesignInspector
        workspaceId={workspaceId}
        folder={folder}
        frame={selectedFrame}
        frameSelected={frameSelected}
        details={selectedDetails}
        selectedNodeId={selectedNodeId}
        selectedNodeIds={selectedNodeIds}
        lint={snapshot.data?.lint ?? null}
        active={surfaceActive}
        canvasBackground={canvasBackground}
        onCanvasBackgroundChange={commitCanvasBackground}
        motionTimelineOpen={motionTimelineOpen}
        motionProperties={motionProperties}
        onOpenMotionTimeline={openMotionTimeline}
        zoomActionsRef={zoomActionsRef}
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
  const selectedRuntimeRevision = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame) return 0;
    return (
      state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.snapshot
        ?.revision ?? 0
    );
  });
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
        viewportRef.current?.focus({ preventScroll: true });
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
      if (
        !workspaceId ||
        !active ||
        activeTool !== "select" ||
        !event.isPrimary ||
        event.button !== 0
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // The label (and the frame's own handles) are the frame's only
      // selection surfaces — body clicks never reach here.
      publishSelection(frame, { selected: true });
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
        // A trackpad pinch repaints the camera up to 80ms before the store
        // learns the new zoom, so travel divides by what is on screen now.
        const zoom = liveDesignZoom();
        const dx = (pointerEvent.clientX - startX) / zoom;
        const dy = (pointerEvent.clientY - startY) / zoom;
        if (!moved && Math.hypot(dx, dy) < 3 / zoom) return;
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
    [
      active,
      activeTool,
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
        const rotate = Math.round((base.rotate + delta) * 10) / 10;
        latestTransform = formatDesignTransform({ ...base, rotate });
        // Paint the angle that is actually being authored, so the outline and
        // the element never disagree by a rounding step.
        latestRotation = overlayFrame.rotation + (rotate - base.rotate);
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
          pointerEvent.shiftKey ? 8 : 1,
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
        if (!moved) return;
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
    [active, childGeometryDetails, liveDesignZoom, workspaceId],
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
          styles: {
            position: start.position,
            left: `${Math.round(start.left + delta.x)}px`,
            top: `${Math.round(start.top + delta.y)}px`,
          },
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
            styles: {
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
            },
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
      const box = designSelectionBox(details);
      const startOverlay = designSelectionOverlayFrame(box);
      const ownTransform = parseDesignTransform(
        details.styles.transform ?? "none",
      );
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
      const ancestorScaleX = box.scaleX / (ownTransform.scaleX || 1);
      const ancestorScaleY = box.scaleY / (ownTransform.scaleY || 1);
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
        const authorsLeft = gestureMode === "move" || Math.abs(offset.x) > 0.01;
        const authorsTop = gestureMode === "move" || Math.abs(offset.y) > 0.01;
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
        if (axes.width) styles.width = `${horizontal.size}px`;
        if (axes.height) styles.height = `${vertical.size}px`;
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
          }).catch(() => {});
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
          selectedRuntimeTree,
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

  /** Resolve a frame-body pointer hit into paper.design-style selection: the
   * deepest runtime hit maps through the local layer tree so a body-like root
   * reads as empty canvas ("clear"), plain clicks enter at the root's
   * children, and repeated clicks descend. "unresolved" means the local tree
   * is stale; callers fall back to the runtime's own hit modes. */
  const resolveFrameBodyHit = useCallback(
    async (input: {
      frame: DesignCanvasFrameWire;
      x: number;
      y: number;
      intent: DesignFrameBodyIntent;
      selectedNodeId: string | null;
      deepest?: DesignRuntimeNodeDetails | null;
    }): Promise<
      | {
          kind: "node";
          nodeId: string;
          details: DesignRuntimeNodeDetails | null;
        }
      | { kind: "clear" }
      | { kind: "unresolved" }
    > => {
      if (!workspaceId) return { kind: "unresolved" };
      const deepest =
        input.deepest !== undefined
          ? input.deepest
          : await inspectDesignNodeAtLocation({
              workspaceId,
              frame: input.frame,
              x: input.x,
              y: input.y,
              mode: "deepest",
            });
      if (!deepest) return { kind: "clear" };
      const runtimeState = designRuntimeFrameState(
        workspaceId,
        input.frame.file,
      );
      const snapshotTree =
        runtimeState?.snapshot?.sourceVersion === input.frame.sourceVersion
          ? runtimeState.snapshot.tree
          : null;
      if (!snapshotTree) return { kind: "unresolved" };
      const rootOid = snapshotTree.length === 1 ? snapshotTree[0]!.oid : null;
      const rootCandidate = rootOid
        ? runtimeState?.detailsByNode[rootOid]
        : undefined;
      const target = resolveDesignFrameBodyTarget({
        nodes: snapshotTree,
        deepestNodeId: deepest.oid,
        deepestRect: deepest.rect,
        selectedNodeId: input.selectedNodeId,
        intent: input.intent,
        frameSize: { width: input.frame.width, height: input.frame.height },
        rootRect:
          rootCandidate?.sourceVersion === input.frame.sourceVersion
            ? rootCandidate.rect
            : null,
        labeledFrame: input.frame.kind !== "text",
      });
      if (target.kind === "node") {
        return {
          kind: "node",
          nodeId: target.nodeId,
          details: target.nodeId === deepest.oid ? deepest : null,
        };
      }
      return target;
    },
    [workspaceId],
  );

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
      const point = {
        x: ((clientX - bounds.left) * frame.width) / bounds.width,
        y: ((clientY - bounds.top) * frame.height) / bounds.height,
      };
      void inspectDesignNodeAtLocation({
        workspaceId,
        frame,
        ...point,
        mode: "deepest",
      })
        .then((details) => {
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
          return resolveFrameBodyHit({
            frame,
            ...point,
            intent: "descend",
            selectedNodeId,
            deepest: details,
          }).then((hit) => {
            if (hit.kind === "node") {
              return selectDesignNode({
                workspaceId,
                folder,
                frame,
                nodeId: hit.nodeId,
                ...(hit.details ? { details: hit.details } : {}),
              });
            }
            if (hit.kind === "unresolved") {
              return selectDesignNodeAtLocation({
                workspaceId,
                folder,
                frame,
                ...point,
                mode: "descend",
                selectedNodeId,
              });
            }
            publishSelection(frame);
            return null;
          });
        })
        .catch((selectionError) => {
          toast.error("Couldn't inspect that nested element", {
            description: errorMessage(selectionError),
          });
        });
    },
    [
      finishInlineTextTool,
      folder,
      publishSelection,
      resolveFrameBodyHit,
      workspaceId,
    ],
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

  /** Frame is a real modal canvas tool: pointer-down owns one inverse-zoom
   * drag and commits the final world rect as the frame's initial geometry. */
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
        void createFrame(geometry).finally(hideCreationDraft);
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
            // Frame chrome belongs to an explicit frame selection (label,
            // Layers row, Escape) — an active frame with nothing selected
            // stays chrome-free like Figma's resting state.
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
                  left: frame.x,
                  top: frame.y,
                  width: frame.width,
                  height: frame.height,
                  zIndex: frame.z,
                  outlineWidth: frameSelectedOnly
                    ? designCanvasScreenPixels(2)
                    : frame.kind === "text"
                      ? 0
                      : designCanvasScreenPixels(1),
                }}
                onPointerDown={(event) => {
                  if (
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
                    const intent: DesignFrameBodyIntent =
                      activeTool === "text" ||
                      pointer.metaKey ||
                      pointer.ctrlKey
                        ? "deepest"
                        : pointer.detail > 1
                          ? "descend"
                          : "plain";
                    const point = {
                      x: (pointer.clientX - bounds.left) * scaleX,
                      y: (pointer.clientY - bounds.top) * scaleY,
                    };
                    const legacyMode = intent === "plain" ? "preserve" : intent;
                    const selection = resolveFrameBodyHit({
                      frame,
                      ...point,
                      intent,
                      selectedNodeId: view.selectedNodeId,
                    }).then((hit) => {
                      if (hit.kind === "node") {
                        return pointer.shiftKey
                          ? toggleDesignNodeSelection({
                              workspaceId,
                              folder,
                              frame,
                              nodeId: hit.nodeId,
                              ...(hit.details ? { details: hit.details } : {}),
                            }).then(() => hit.details)
                          : selectDesignNode({
                              workspaceId,
                              folder,
                              frame,
                              nodeId: hit.nodeId,
                              ...(hit.details ? { details: hit.details } : {}),
                            });
                      }
                      if (hit.kind === "unresolved") {
                        // Stale local tree — the runtime resolves the click.
                        const hitInput = {
                          workspaceId,
                          frame,
                          ...point,
                          mode: legacyMode,
                          selectedNodeId: view.selectedNodeId,
                        } as const;
                        return pointer.shiftKey
                          ? inspectDesignNodeAtLocation(hitInput).then(
                              (details) =>
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
                          : selectDesignNodeAtLocation({
                              ...hitInput,
                              folder,
                            });
                      }
                      // Empty frame body reads as canvas: a plain click clears
                      // the selection without selecting the frame itself.
                      if (!pointer.shiftKey) publishSelection(frame);
                      return null;
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
                  if (blocksDesignCanvasDoubleClick(event.target)) return;
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
                          "text-2xxs block max-w-full min-w-0 cursor-move overflow-hidden border-0 bg-transparent p-0 text-left leading-4 font-medium whitespace-nowrap outline-none",
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
                          details.oid,
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
            <div className="text-muted-fg flex h-6 items-center px-2 text-[9px] font-medium tracking-wide uppercase">
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
                <span className="text-muted-fg border-border2 shrink-0 rounded-sm border px-1 font-mono text-[8px] uppercase">
                  {layer.tag}
                </span>
                <span className="text-fg1 min-w-0 flex-1 truncate text-[11px]">
                  {layer.name}
                </span>
                <span className="text-muted-fg font-mono text-[9px]">
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
                void selectDesignFrame(workspaceId!, hitStackMenu.frame, {
                  selected: true,
                });
              }}
            >
              <Frame className="text-muted-fg size-3.5" />
              <span className="text-fg1 truncate text-[11px]">
                {hitStackMenu.frame.title}
              </span>
            </button>
          </div>
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

interface InspectorEditFieldProps {
  label: string;
  value: string | number;
  applied?: boolean;
  disabled?: boolean;
  hint?: string;
  placeholder?: string;
  styleProperty?: string;
  motion?: {
    modeActive: boolean;
    trackActive: boolean;
    onAddKeyframe: () => void;
  };
  onInspect?: () => void;
  onPreview?: (value: string) => Promise<unknown> | void;
  onCancelPreview?: () => Promise<unknown> | void;
  onCommit: (value: string) => Promise<unknown>;
}

interface InspectorFieldPresentation {
  text: string;
  unit: string | null;
}

function inspectorFieldPresentation(
  property: string | undefined,
  value: string,
): InspectorFieldPresentation {
  if (!property || value.trim() === "") return { text: value, unit: null };
  const numeric = parseDesignStyleNumericParts(value);
  if (!numeric) return { text: value, unit: null };
  const units = designStyleUnitOptions(property, numeric.unit);
  if (units.length === 0) return { text: value, unit: null };
  return {
    text: numeric.text,
    unit: numeric.unit || units[0] || null,
  };
}

function inspectorFieldDraftWithUnit(text: string, unit: string): string {
  const candidate = text.trim();
  // A leading plus and x/operator notation are equations against the value
  // captured on focus. Leave them unitless until commit resolves the equation.
  if (/^\+/.test(candidate) || /[xX()*/^]/.test(candidate)) return text;
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(candidate)) {
    return `${candidate}${unit}`;
  }
  return text;
}

function InspectorEditField({
  label,
  value,
  applied = false,
  disabled = false,
  hint,
  placeholder,
  styleProperty,
  motion,
  onInspect,
  onPreview,
  onCancelPreview,
  onCommit,
}: InspectorEditFieldProps) {
  const id = useId();
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baselineRef = useRef(String(value));
  const skipCommitRef = useRef(false);
  const unitMenuOpenRef = useRef(false);
  const commitIntentRef = useRef(0);
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
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [presentation, setPresentation] = useState<InspectorFieldPresentation>(
    () => inspectorFieldPresentation(styleProperty, String(value)),
  );

  const setPresentedDraft = useCallback(
    (next: string) => {
      draftRef.current = next;
      setDraft(next);
      setPresentation(inspectorFieldPresentation(styleProperty, next));
    },
    [styleProperty],
  );
  const unitOptions = presentation.unit
    ? designStyleUnitOptions(styleProperty ?? "", presentation.unit)
    : [];

  const resolveDraft = (next: string, baseline: string) =>
    styleProperty
      ? normalizeDesignStyleFieldInput(styleProperty, next, baseline)
      : resolveDesignNumericExpression(next, baseline);

  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    const next = String(value);
    baselineRef.current = next;
    setPresentedDraft(next);
  }, [setPresentedDraft, value]);

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

  const finishCommittedPreview = () => {
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    // Preserve the last exact live scalar until the authoritative source
    // generation arrives. Clearing here causes a visible value snap-back.
    previewDirtyRef.current = false;
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

  const commit = async (requestedDraft = draftRef.current) => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      cancelPreview();
      return;
    }
    const baseline = baselineRef.current;
    const resolvedDraft = resolveDraft(requestedDraft, baseline);
    if (resolvedDraft !== requestedDraft) setPresentedDraft(resolvedDraft);
    if (resolvedDraft === baseline) {
      cancelPreview();
      return;
    }
    // Paint the committed value now rather than at the end of the source
    // round trip. Typing no longer touches the canvas, so this is the moment
    // the user asked for the change to appear.
    if (!previewDirtyRef.current) preview(resolvedDraft);
    const intent = ++commitIntentRef.current;
    try {
      await onCommit(resolvedDraft);
      if (commitIntentRef.current !== intent) return;
      baselineRef.current = resolvedDraft;
      finishCommittedPreview();
    } catch (fieldError) {
      if (commitIntentRef.current !== intent) return;
      setPresentedDraft(baseline);
      cancelPreview();
      toast.error(`Couldn't update ${label.toLowerCase()}`, {
        description: errorMessage(fieldError),
      });
    }
  };

  return (
    <div ref={fieldRef} className="group/design-field relative min-w-0">
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
          disabled={disabled}
          className={cn(
            "text-muted-fg hover:text-fg1 flex h-full shrink-0 cursor-ew-resize items-center justify-center text-[10px] font-medium focus-visible:outline-none disabled:cursor-default",
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
            setPresentedDraft(next);
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
            setPresentedDraft(baselineRef.current);
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
          value={presentation.text}
          placeholder={placeholder}
          disabled={disabled}
          title={hint}
          className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-1.5 py-0 font-mono text-[11px] shadow-none focus-visible:border-transparent"
          onFocus={() => {
            baselineRef.current = String(value);
            onInspect?.();
          }}
          onChange={(event) => {
            // Deliberately local. A canvas write per keystroke reflowed the
            // document on every character — and on a backspace it removed the
            // declaration outright before the next digit put it back.
            const text = event.target.value;
            const pastedNumeric = parseDesignStyleNumericParts(text);
            if (
              styleProperty &&
              pastedNumeric?.unit &&
              designStyleUnitOptions(
                styleProperty,
                pastedNumeric.unit,
              ).includes(pastedNumeric.unit)
            ) {
              setPresentedDraft(text);
              return;
            }
            if (
              presentation.unit &&
              (text.trim() === "" || /^[\d.+\-*/^xX()\s]*$/.test(text))
            ) {
              const next = inspectorFieldDraftWithUnit(text, presentation.unit);
              draftRef.current = next;
              setDraft(next);
              setPresentation({ text, unit: presentation.unit });
              return;
            }
            setPresentedDraft(text);
          }}
          onBlur={(event) => {
            if (
              unitMenuOpenRef.current ||
              fieldRef.current?.contains(event.relatedTarget)
            ) {
              return;
            }
            void commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              const normalized = resolveDraft(draft, baselineRef.current);
              const direction = event.key === "ArrowUp" ? 1 : -1;
              const multiplier = event.altKey ? 0.1 : event.shiftKey ? 10 : 1;
              const next = scrubDesignNumericValue(
                normalized,
                direction * multiplier,
              );
              if (next !== null) {
                event.preventDefault();
                setPresentedDraft(next);
              }
            } else if (event.key === "Escape") {
              event.preventDefault();
              skipCommitRef.current = true;
              // A preceding commit can publish its authoritative computed
              // value while this input is focused. The synchronization effect
              // deliberately leaves an active draft alone, so the focus-time
              // baseline may now be stale (notably after removing an authored
              // declaration). Escape must restore the latest exact-key value
              // from props; once we blur there may be no further value change
              // to trigger the effect again.
              const restored = String(value);
              baselineRef.current = restored;
              setPresentedDraft(restored);
              cancelPreview();
              event.currentTarget.blur();
            }
          }}
        />
        {presentation.unit && unitOptions.length > 0 ? (
          <Select
            value={presentation.unit}
            disabled={disabled}
            onOpenChange={(open) => {
              if (open) {
                unitMenuOpenRef.current = true;
              } else if (unitMenuOpenRef.current) {
                unitMenuOpenRef.current = false;
                void commit();
              }
            }}
            onValueChange={(unit) => {
              unitMenuOpenRef.current = false;
              const resolved = resolveDraft(
                draftRef.current,
                baselineRef.current,
              );
              const next = replaceDesignStyleNumericUnit(resolved, unit);
              if (next === null) return;
              setPresentedDraft(next);
              void commit(next);
            }}
          >
            <SelectTrigger
              size="sm"
              className="zd-design-unit-trigger h-full w-11 shrink-0 gap-0 rounded-none border-0 bg-transparent px-1 text-[10px] shadow-none [&>svg]:size-2.5"
              aria-label={`Unit for ${label}`}
              onPointerDown={() => {
                unitMenuOpenRef.current = true;
              }}
              onBlur={(event) => {
                if (
                  unitMenuOpenRef.current ||
                  fieldRef.current?.contains(event.relatedTarget)
                ) {
                  return;
                }
                void commit();
              }}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-20">
              {unitOptions.map((unit) => (
                <SelectItem key={unit} value={unit}>
                  {unit}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {motion || applied ? (
          <div
            className={cn(
              "zd-design-field-actions absolute top-0 right-0 flex h-full items-center rounded-r-sm",
              (motion?.modeActive || motion?.trackActive) &&
                "zd-design-field-actions-visible",
            )}
            data-has-unit={presentation.unit ? "true" : undefined}
            data-has-hint={hint ? "true" : undefined}
          >
            {motion ? (
              <Tooltip
                label={
                  motion.trackActive
                    ? `Add ${label} keyframe at the playhead`
                    : `Animate ${label}`
                }
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "size-6 shrink-0",
                    motion.trackActive &&
                      "text-[var(--design-selection-stroke)]",
                  )}
                  aria-label={
                    motion.trackActive
                      ? `Add ${label} keyframe at the playhead`
                      : `Animate ${label}`
                  }
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={motion.onAddKeyframe}
                >
                  <Diamond
                    className={motion.trackActive ? "fill-current" : undefined}
                  />
                </Button>
              </Tooltip>
            ) : null}
            {applied ? (
              <Tooltip label={`Remove authored ${label}`}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 shrink-0"
                  aria-label={`Remove authored ${label}`}
                  disabled={disabled}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={() => {
                    setPresentedDraft("");
                    void commit("");
                  }}
                >
                  <X />
                </Button>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
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

const InspectorStyleField = React.memo(function InspectorStyleField({
  workspaceId,
  frame,
  nodeId,
  label,
  property,
  value,
  computedValue,
  applied,
  hint,
  onInspect,
  onPreviewStyles,
  onCancelPreview,
  onCommitStyles,
  motionModeActive,
  motionTrackActive,
  onAddMotionKeyframe,
}: {
  workspaceId: string;
  frame: string;
  nodeId: string;
  label: string;
  property: string;
  value: string;
  computedValue: string;
  applied: boolean;
  hint?: string;
  onInspect: (property: string, computedValue: string) => void;
  onPreviewStyles: (
    styles: Record<string, string | null>,
  ) => void | Promise<void>;
  onCancelPreview: () => void | Promise<void>;
  onCommitStyles: (styles: Record<string, string | null>) => Promise<void>;
  motionModeActive: boolean;
  motionTrackActive: boolean;
  onAddMotionKeyframe: (property: string, value: string) => void;
}) {
  const liveValue = useDesignLivePreviewValue(
    workspaceId,
    frame,
    nodeId,
    property,
  );
  const displayedValue =
    liveValue === undefined ? value || computedValue : (liveValue ?? "");
  return (
    <InspectorEditField
      label={label}
      value={displayedValue}
      placeholder="-"
      styleProperty={property}
      applied={applied}
      hint={hint}
      motion={
        motionModeActive
          ? {
              modeActive: true,
              trackActive: motionTrackActive,
              onAddKeyframe: () =>
                onAddMotionKeyframe(property, displayedValue || computedValue),
            }
          : undefined
      }
      onInspect={() =>
        onInspect(
          property,
          typeof liveValue === "string" ? liveValue : computedValue,
        )
      }
      onPreview={(next) => onPreviewStyles({ [property]: next || null })}
      onCancelPreview={onCancelPreview}
      onCommit={(next) => onCommitStyles({ [property]: next || null })}
    />
  );
});

function DesignInspector({
  workspaceId,
  folder,
  frame,
  frameSelected,
  details,
  selectedNodeId,
  selectedNodeIds,
  lint,
  active,
  canvasBackground,
  onCanvasBackgroundChange,
  motionTimelineOpen,
  motionProperties,
  onOpenMotionTimeline,
  zoomActionsRef,
}: DesignInspectorProps) {
  const styleTargetNodeId =
    selectedNodeId ?? (frameSelected && details?.oid ? details.oid : null);
  const frameStyleTarget =
    frameSelected && !selectedNodeId && styleTargetNodeId !== null;
  const elementDetails = styleTargetNodeId ? details : null;
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
  const zoom = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.zoom ??
        DEFAULT_DESIGN_WORKSPACE_VIEW.zoom)
      : DEFAULT_DESIGN_WORKSPACE_VIEW.zoom,
  );
  const zoomPercentage = Math.round(zoom * 100);
  const [frameAction, setFrameAction] = useState<"export" | null>(null);
  const [designGitAction, setDesignGitAction] = useState<
    "stage" | "commit" | null
  >(null);
  const [pendingHistoryActions, setPendingHistoryActions] = useState(0);
  const [cssMode, setCssMode] = useState(false);
  const [provenance, setProvenance] = useState<InspectorProvenanceState | null>(
    null,
  );
  const provenanceAbortRef = useRef<AbortController | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const [stylePanelWidth, setStylePanelWidth] = useState(
    readPersistedDesignWorkspaceStyleWidth,
  );
  const inspectorId = workspaceId
    ? `design-style-panel-${workspaceId}`
    : "design-style-panel";

  useLayoutEffect(() => {
    inspectorRef.current?.parentElement?.style.setProperty(
      DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
      `${stylePanelWidth}px`,
    );
  }, [stylePanelWidth]);

  const persistStylePanelWidth = useCallback((next: number) => {
    const committed = persistDesignWorkspaceStyleWidth(next);
    setStylePanelWidth(committed);
    inspectorRef.current?.parentElement?.style.setProperty(
      DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
      `${committed}px`,
    );
    document.documentElement.style.setProperty(
      DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
      `${committed}px`,
    );
  }, []);

  const paintCanvasBackground = useCallback((value: string) => {
    const normalized = normalizeDesignCanvasBackground(value);
    if (!normalized) return;
    inspectorRef.current?.parentElement
      ?.querySelector<HTMLElement>("[data-design-canvas-viewport]")
      ?.style.setProperty("background-color", normalized);
  }, []);
  const previewCanvasBackground = useCallback(
    (value: string) => paintCanvasBackground(value),
    [paintCanvasBackground],
  );
  const cancelCanvasBackgroundPreview = useCallback(
    () => paintCanvasBackground(canvasBackground),
    [canvasBackground, paintCanvasBackground],
  );
  const commitCanvasBackground = useCallback(
    (value: string) => {
      const normalized = normalizeDesignCanvasBackground(value);
      if (!normalized) return;
      paintCanvasBackground(normalized);
      onCanvasBackgroundChange(normalized);
    },
    [onCanvasBackgroundChange, paintCanvasBackground],
  );

  const foundation = useDesignFoundation(
    workspaceId,
    frame?.file,
    frame?.sourceVersion,
    active,
  );
  const foundationData = foundation.data;
  const provenanceOwnerKey = `${workspaceId ?? ""}\u0000${frame?.file ?? ""}\u0000${frame?.sourceVersion ?? ""}\u0000${foundationData?.summary.revision ?? ""}\u0000${styleTargetNodeId ?? ""}`;

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
        !styleTargetNodeId ||
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
        nodeId: styleTargetNodeId,
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
      styleTargetNodeId,
      workspaceId,
    ],
  );

  const runHistory = useCallback(
    (direction: "undo" | "redo") => {
      if (!workspaceId) return;
      // Start every request immediately. applyDesignHistoryCached registers it
      // with the workspace mutation lane before returning its promise, so two
      // fast keypresses become two ordered history steps rather than one being
      // discarded while the first bridge round trip is in flight.
      setPendingHistoryActions((current) => current + 1);
      void applyDesignHistoryCached(workspaceId, frame?.file ?? null, direction)
        .then((result) => {
          if (result.historySelection === undefined) return;
          const selected = result.historySelection
            ? (result.snapshot?.frames.find(
                (candidate) => candidate.file === result.historySelection,
              ) ?? null)
            : null;
          void selectDesignFrame(workspaceId, selected, {
            selected: direction === "undo" && selected !== null,
          }).catch((selectionError: unknown) => {
            toast.error("Couldn't save the restored frame selection", {
              description: errorMessage(selectionError),
            });
          });
        })
        .catch((historyError: unknown) => {
          toast.error(`Couldn't ${direction} the design edit`, {
            description: errorMessage(historyError),
          });
        })
        .finally(() => {
          setPendingHistoryActions((current) => Math.max(0, current - 1));
        });
    },
    [frame, workspaceId],
  );

  const saveDesignChanges = useCallback(() => {
    if (!workspaceId) return;
    // Do not suppress a repeated Command-S while an earlier save is running.
    // Each request enters the same workspace mutation lane as focused-draft
    // publication, so the newest edit is always validated after publication.
    void saveDesigns(workspaceId)
      .then(() => {
        toast.success("Design draft saved", {
          description: "Changes remain unstaged and uncommitted.",
          id: `design-save:${workspaceId}`,
        });
      })
      .catch((saveError: unknown) => {
        toast.error("Couldn't save design draft", {
          description: errorMessage(saveError),
          id: `design-save:${workspaceId}`,
        });
      });
  }, [workspaceId]);

  const stageDesignChanges = useCallback(() => {
    if (!workspaceId || designGitAction) return;
    setDesignGitAction("stage");
    void stageDesigns(workspaceId)
      .then(() => {
        toast.success("Design changes staged", {
          description: "No commit was created.",
          id: `design-stage:${workspaceId}`,
        });
      })
      .catch((stageError: unknown) => {
        toast.error("Couldn't stage Design changes", {
          description: errorMessage(stageError),
          id: `design-stage:${workspaceId}`,
        });
      })
      .finally(() => setDesignGitAction(null));
  }, [designGitAction, workspaceId]);

  const commitDesignChanges = useCallback(() => {
    if (!workspaceId || designGitAction) return;
    setDesignGitAction("commit");
    void commitDesigns(workspaceId)
      .then(() => {
        toast.success("Staged Design changes committed", {
          id: `design-commit:${workspaceId}`,
        });
      })
      .catch((commitError: unknown) => {
        toast.error("Couldn't commit staged Design changes", {
          description: errorMessage(commitError),
          id: `design-commit:${workspaceId}`,
        });
      })
      .finally(() => setDesignGitAction(null));
  }, [designGitAction, workspaceId]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const editableTarget = isEditableHotkeyTarget(event.target);
      dispatchDesignWorkspaceShortcut(event, editableTarget, {
        save: () => {
          // Inspector and inline-text fields publish drafts on blur. React
          // dispatches that blur synchronously, registering its mutation before
          // saveDesigns joins the same ordered workspace lane.
          if (editableTarget && event.target instanceof HTMLElement) {
            event.target.blur();
          }
          saveDesignChanges();
        },
        undo: () => runHistory("undo"),
        redo: () => runHistory("redo"),
      });
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [active, runHistory, saveDesignChanges]);

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
      styleTargetNodeId
        ? [
            styleTargetNodeId,
            ...(selectedNodeId
              ? selectedNodeIds.filter((nodeId) => nodeId !== styleTargetNodeId)
              : []),
          ].slice(0, DESIGN_SELECTION_NODE_LIMIT)
        : [],
    [selectedNodeId, selectedNodeIds, styleTargetNodeId],
  );
  const styleEditContextRef = useRef({
    workspaceId,
    folder,
    frame,
    styleNodeIds,
    selectedNodeId: styleTargetNodeId,
    elementDetails,
    foundationData,
  });
  const stylePreviewIntentRef = useRef(0);
  styleEditContextRef.current = {
    workspaceId,
    folder,
    frame,
    styleNodeIds,
    selectedNodeId: styleTargetNodeId,
    elementDetails,
    foundationData,
  };
  const stylesForNode = useCallback(
    (nodeId: string, styles: Record<string, string | null>) => {
      const context = styleEditContextRef.current;
      const runtimeDetails =
        context.workspaceId && context.frame
          ? useDesignRuntimeStore.getState().byWorkspace[context.workspaceId]
              ?.frames[context.frame.file]?.detailsByNode[nodeId]
          : null;
      return withDesignPositionContext(
        styles,
        runtimeDetails?.styles.position ??
          (nodeId === context.selectedNodeId
            ? context.elementDetails?.styles.position
            : undefined) ??
          "static",
      );
    },
    [],
  );

  const previewSelectedStyles = useCallback(
    async (styles: Record<string, string | null>) => {
      const context = styleEditContextRef.current;
      if (
        !context.workspaceId ||
        !context.folder ||
        !context.frame ||
        context.styleNodeIds.length === 0
      ) {
        throw new Error("Select one or more design layers first.");
      }
      const intent = ++stylePreviewIntentRef.current;
      // A slider, a colour drag or a label scrub can ask for this many times a
      // second, so it asks for the same lean geometry a canvas gesture does —
      // including the container's children in the same round trip, rather than a
      // second O(children) read behind it.
      const wantsChildren =
        Object.keys(styles).some(designStylePropertyAffectsLayout) &&
        Boolean(
          context.selectedNodeId &&
          designInspectorPreviewOverlay(
            context.workspaceId,
            context.frame.file,
            context.selectedNodeId,
          )?.querySelector("[data-design-inline-spacing-root]"),
        );
      const previewGeometries = await Promise.all(
        context.styleNodeIds.map((nodeId) =>
          previewDesignNodeGeometry({
            workspaceId: context.workspaceId!,
            frame: context.frame!,
            nodeId,
            styles: stylesForNode(nodeId, styles),
            children: wantsChildren && nodeId === context.selectedNodeId,
          }),
        ),
      );
      if (stylePreviewIntentRef.current !== intent) return;
      for (const geometry of previewGeometries) {
        const spacingRoot = paintDesignInspectorPreviewDetails(
          context.workspaceId,
          context.frame.file,
          geometry,
        );
        if (spacingRoot && geometry.children.length > 0) {
          paintDesignInlineGapHandles(
            spacingRoot,
            geometry,
            geometry.children,
            designWorkspaceView(context.workspaceId).zoom,
          );
        }
      }
    },
    [stylesForNode],
  );

  const restoreSelectedStylePreview = useCallback(async () => {
    const context = styleEditContextRef.current;
    if (!context.workspaceId || !context.folder || !context.frame) return;
    const intent = ++stylePreviewIntentRef.current;
    const restoredDetails = await Promise.all(
      context.styleNodeIds.map((nodeId) => {
        const input = {
          workspaceId: context.workspaceId!,
          frame: context.frame!.file,
          sourceVersion: context.frame!.sourceVersion,
          nodeId,
        };
        return clearDesignNodeStylePreviewTransient(input);
      }),
    );
    if (stylePreviewIntentRef.current !== intent) return;
    for (const details of restoredDetails) {
      paintDesignInspectorPreviewDetails(
        context.workspaceId,
        context.frame.file,
        details,
      );
    }
    const primary = restoredDetails.find(
      (details) => details.oid === context.selectedNodeId,
    );
    if (!primary) return;
    // The restored layout still owes the gap affordances their positions; one
    // lean measurement answers that without re-reading every child in full.
    const restored = await previewDesignNodeGeometry({
      workspaceId: context.workspaceId,
      frame: context.frame,
      nodeId: primary.oid,
      children: true,
    });
    if (stylePreviewIntentRef.current !== intent) return;
    const spacingRoot = paintDesignInspectorPreviewDetails(
      context.workspaceId,
      context.frame.file,
      restored,
    );
    if (spacingRoot && restored.children.length > 0) {
      paintDesignInlineGapHandles(
        spacingRoot,
        restored,
        restored.children,
        designWorkspaceView(context.workspaceId).zoom,
      );
    }
  }, []);

  /** Cancelling a speculative preview cannot fail in a way the user can act on:
   * the source was never written. A commit landing mid-cancel makes the runtime
   * reject the clear, and that must not surface as a page error. */
  const clearSelectedStylePreview = useCallback(async () => {
    try {
      await restoreSelectedStylePreview();
    } catch {
      // Speculative cleanup only.
    }
  }, [restoreSelectedStylePreview]);

  const commitSelectedStyles = useCallback(
    async (styles: Record<string, string | null>) => {
      const context = styleEditContextRef.current;
      if (
        !context.workspaceId ||
        !context.frame ||
        context.styleNodeIds.length === 0
      ) {
        throw new Error("Select one or more design layers first.");
      }
      if (context.styleNodeIds.length === 1) {
        await updateDesignNodeStylesCached(context.workspaceId, {
          frame: context.frame.file,
          nodeId: context.styleNodeIds[0]!,
          sourceVersion: context.frame.sourceVersion,
          styles: stylesForNode(context.styleNodeIds[0]!, styles),
        });
        return;
      }
      if (!context.foundationData) {
        throw new Error("The selected design document is still loading.");
      }
      const properties = Object.keys(styles).sort();
      await applyDesignTransactionCached(
        context.workspaceId,
        context.frame.file,
        {
          schemaVersion: 1,
          transactionId: `desktop:${crypto.randomUUID()}`,
          documentId: context.foundationData.summary.documentId,
          baseRevision: context.foundationData.summary.revision,
          actor: { kind: "human", id: "desktop" },
          intent: `Set ${properties.join(", ")} on ${context.styleNodeIds.length} layers`,
          createdAt: Date.now(),
          coalesceKey: `styles:${context.styleNodeIds.join(":")}:${properties.join(":")}`,
          operations: context.styleNodeIds.map((nodeId) => ({
            operationId: `styles:${crypto.randomUUID()}`,
            type: "node.set-styles" as const,
            nodeId,
            styles: stylesForNode(nodeId, styles),
            scope: "auto" as const,
            responsiveContext: "base",
            stateContext: "default",
          })),
        },
      );
    },
    [stylesForNode],
  );

  const styleContext =
    workspaceId && folder && frame && styleTargetNodeId && elementDetails
      ? { workspaceId, folder, frame, nodeId: styleTargetNodeId }
      : null;
  const styleField = (label: string, property: string, value: string) => {
    if (!styleContext) return null;
    const frameGeometryProperty = frameStyleTarget
      ? (
          {
            left: ["x", styleContext.frame.x],
            top: ["y", styleContext.frame.y],
            width: ["w", styleContext.frame.width],
            height: ["h", styleContext.frame.height],
          } as const
        )[property as "left" | "top" | "width" | "height"]
      : undefined;
    if (frameGeometryProperty) {
      const [geometryKey, geometryValue] = frameGeometryProperty;
      return (
        <InspectorEditField
          key={`${styleContext.workspaceId}:${styleContext.frame.file}:frame:${geometryKey}`}
          label={label}
          value={geometryValue}
          applied
          onPreview={(next) => {
            const number = Number(next);
            if (!Number.isFinite(number)) return;
            const geometry = paintedDesignFrameGeometry(
              styleContext.workspaceId,
              styleContext.frame.file,
              frameGeometry(styleContext.frame),
            );
            paintDesignFrameGeometryPreview(
              styleContext.workspaceId,
              styleContext.frame.file,
              { ...geometry, [geometryKey]: number },
            );
          }}
          onCancelPreview={() =>
            paintDesignFrameGeometryPreview(
              styleContext.workspaceId,
              styleContext.frame.file,
              frameGeometry(styleContext.frame),
            )
          }
          onCommit={async (next) => {
            const number = Number(next);
            if (!Number.isFinite(number)) {
              throw new Error("Enter a finite number.");
            }
            await updateDesignFrameGeometryCached(
              styleContext.workspaceId,
              styleContext.frame.file,
              {
                ...frameGeometry(styleContext.frame),
                [geometryKey]: number,
              },
              [geometryKey],
            );
          }}
        />
      );
    }
    const authoredProperties = elementDetails?.authoredStyleProperties;
    const applied = isDesignRuntimeStylePropertyAuthored(
      authoredProperties,
      property,
      value,
    );
    return (
      <InspectorStyleField
        key={`${styleContext.workspaceId}:${styleContext.frame.file}:${styleNodeIds.join(":")}:${property}`}
        workspaceId={styleContext.workspaceId}
        frame={styleContext.frame.file}
        nodeId={styleContext.nodeId}
        label={label}
        property={property}
        value={designStyleFieldValue(authoredProperties, property, value)}
        computedValue={value}
        applied={applied}
        hint={
          provenance?.ownerKey === provenanceOwnerKey &&
          provenance.property === property
            ? provenance.loading
              ? "Resolving…"
              : provenance.value?.winner
                ? `${provenance.value.winner.origin} · ${provenance.value.winner.file}`
                : provenance.value?.origin
            : undefined
        }
        motionModeActive={motionTimelineOpen}
        motionTrackActive={motionProperties.includes(property)}
        onAddMotionKeyframe={onOpenMotionTimeline}
        onInspect={inspectStyle}
        onPreviewStyles={previewSelectedStyles}
        onCancelPreview={clearSelectedStylePreview}
        onCommitStyles={commitSelectedStyles}
      />
    );
  };

  const inspectorSelectionHeader = (
    <section className="border-border1 shrink-0 border-b">
      <div
        data-design-inspector-header=""
        className="flex h-10 min-w-0 items-center gap-1 px-3"
      >
        <span className="text-fg1 min-w-0 flex-1 truncate text-xs font-medium">
          {styleNodeIds.length > 1
            ? `${styleNodeIds.length} layers`
            : elementDetails
              ? designRuntimeLayerLabel(elementDetails)
              : frameSelected && frame
                ? designFrameLayerLabel(frame.kind)
                : selectedNodeId
                  ? "Nothing selected"
                  : "Page"}
        </span>
        {frameSelected || selectedNodeId ? (
          <Tooltip label="Export PNG">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!frame || !folder || frameAction !== null}
              aria-label="Export PNG"
              onClick={() => void exportPng()}
            >
              <Download />
            </Button>
          </Tooltip>
        ) : null}
      </div>
    </section>
  );

  return (
    <aside
      ref={inspectorRef}
      id={inspectorId}
      data-design-inspector=""
      className="border-border1 bg-bg1 relative flex w-[var(--zeros-design-style-width,280px)] max-w-[min(640px,50%)] min-w-[min(220px,45%)] [flex:0_1_var(--zeros-design-style-width,280px)] flex-col overflow-hidden border-l"
    >
      <DesignPanelResizeHandle
        panelRef={inspectorRef}
        edge="left"
        value={stylePanelWidth}
        defaultValue={DESIGN_WORKSPACE_STYLE_WIDTH_DEFAULT}
        minimum={DESIGN_WORKSPACE_STYLE_WIDTH_MIN}
        maximum={DESIGN_WORKSPACE_STYLE_WIDTH_MAX}
        clampValue={clampDesignWorkspaceStyleWidth}
        onCommit={persistStylePanelWidth}
        ariaLabel="Resize Style panel"
        controlsId={inspectorId}
      />
      <div
        data-design-style-panel-header=""
        className="border-border1 bg-bg1 flex h-10 shrink-0 items-center justify-between border-b px-2"
      >
        <span className="bg-bg2 text-fg1 flex h-7 items-center rounded-md px-2.5 text-xs font-medium">
          Style
        </span>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={!active || !workspaceId || designGitAction !== null}
                aria-label="Design Git actions"
              >
                <GitBranch />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                disabled={designGitAction !== null}
                aria-label="Stage Design changes"
                onSelect={stageDesignChanges}
              >
                Stage Design changes
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={designGitAction !== null}
                aria-label="Commit staged Design changes"
                onSelect={commitDesignChanges}
              >
                Commit staged Design changes
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 min-w-14 px-2 font-mono text-xs tabular-nums"
                disabled={!active || !workspaceId}
                aria-label={`Canvas zoom ${zoomPercentage}%`}
              >
                {zoomPercentage}%
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                disabled={zoom >= DESIGN_MAX_ZOOM}
                aria-label="Zoom in"
                onSelect={() => zoomActionsRef.current?.zoomIn()}
              >
                <span>Zoom in</span>
                <DropdownMenuShortcut className="tracking-normal">
                  +
                </DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={zoom <= DESIGN_MIN_ZOOM}
                aria-label="Zoom out"
                onSelect={() => zoomActionsRef.current?.zoomOut()}
              >
                <span>Zoom out</span>
                <DropdownMenuShortcut className="tracking-normal">
                  −
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {cssMode && styleContext && elementDetails ? (
        <div
          data-design-style-panel-css-mode=""
          className="flex min-h-0 flex-1 flex-col"
        >
          {inspectorSelectionHeader}
          <DesignComputedCssEditor
            key={`${frame!.file}:${styleNodeIds.join(":")}:css`}
            details={elementDetails}
            disabled={pendingHistoryActions > 0}
            onPreviewStyles={previewSelectedStyles}
            onCancelStylePreview={clearSelectedStylePreview}
            onCommitStyles={commitSelectedStyles}
          />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col">
            {inspectorSelectionHeader}

            {styleTargetNodeId && errors.length > 0 ? (
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

            {styleTargetNodeId && warnings.length > 0 ? (
              <section
                data-design-lint-review=""
                className="text-muted-fg flex min-h-8 items-center gap-2 px-3 py-1.5"
              >
                <AlertTriangle className="size-3.5 shrink-0" />
                <span
                  className="min-w-0 flex-1 truncate text-[10px]"
                  title={warningGroups
                    .map((group) => `${group.label}: ${group.first.message}`)
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
                livePreviewOwner={
                  styleContext
                    ? {
                        workspaceId: styleContext.workspaceId,
                        frame: styleContext.frame.file,
                        nodeId: styleContext.nodeId,
                      }
                    : undefined
                }
                renderField={styleField}
                disabled={pendingHistoryActions > 0}
                onPreviewStyles={previewSelectedStyles}
                onCancelStylePreview={clearSelectedStylePreview}
                onCommitStyles={commitSelectedStyles}
                motionTimelineOpen={motionTimelineOpen}
                motionProperties={motionProperties}
                onOpenMotionTimeline={onOpenMotionTimeline}
              />
            ) : workspaceId && !frameSelected && !selectedNodeId ? (
              <DesignCanvasBackgroundEditor
                value={canvasBackground}
                disabled={!active}
                onPreview={previewCanvasBackground}
                onCancelPreview={cancelCanvasBackgroundPreview}
                onCommit={commitCanvasBackground}
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
                      onPreview={(next) => {
                        const number = Number(next);
                        if (!Number.isFinite(number)) return;
                        const geometry = paintedDesignFrameGeometry(
                          workspaceId,
                          frame.file,
                          frameGeometry(frame),
                        );
                        paintDesignFrameGeometryPreview(
                          workspaceId,
                          frame.file,
                          { ...geometry, [key]: number },
                        );
                      }}
                      onCancelPreview={() =>
                        paintDesignFrameGeometryPreview(
                          workspaceId,
                          frame.file,
                          frameGeometry(frame),
                        )
                      }
                      onCommit={async (next) => {
                        const number = Number(next);
                        if (!Number.isFinite(number)) {
                          throw new Error("Enter a finite number.");
                        }
                        await updateDesignFrameGeometryCached(
                          workspaceId,
                          frame.file,
                          { ...frameGeometry(frame), [key]: number },
                          [key],
                        );
                      }}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </ScrollArea>
      )}
      <div
        data-design-style-panel-footer=""
        className="border-border1 bg-bg1 flex h-12 shrink-0 items-center justify-end border-t px-2"
      >
        <Button
          type="button"
          variant={cssMode ? "default" : "ghost"}
          size="sm"
          disabled={!styleContext && !cssMode}
          aria-label="CSS"
          aria-pressed={cssMode}
          onClick={() => setCssMode((current) => !current)}
        >
          CSS
        </Button>
      </div>
    </aside>
  );
}
