// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas and structured design inspector
// USED IN: MainShellBody in place of the code workspace's Column 3
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
import {
  AlertTriangle,
  Code2,
  Copy,
  FileCode2,
  Minus,
  MousePointer2,
  MoveDiagonal2,
  Plus,
  SquareDashed,
  Trash2,
  Type,
} from "lucide-react";

import type { DesignRuntimeNodeDetails } from "@zeros/core/design-runtime";

import { exportDesignPng } from "../../native/design";
import { shellOpenUrl } from "../../native/native";
import { CreatePrButton } from "../../shell/pr/create-pr-button";
import {
  type DesignFrameDocumentWire,
  type DesignFrameGeometryWire,
  type DesignLintReportWire,
  type DesignTokenWire,
  type DesignWorkspaceSnapshotWire,
  type Workspace,
} from "../../native/git";
import { isEditableHotkeyTarget } from "../../shell/editable-target";
import {
  groupDesignLintViolations,
  lintReviewBadgeLabel,
} from "../agent/design-lint-summary";
import {
  createDesignFrameAndRefresh,
  deleteDesignFrameCached,
  duplicateDesignFrameCached,
  insertDesignAssetCached,
  renameDesignFrameAndRefresh,
  saveDesigns,
  setDesignNodeTextCached,
  updateDesignFrameGeometryCached,
  updateDesignNodeStylesCached,
  updateDesignTokenCached,
} from "../store/design-workspace-cache";
import {
  clearDesignNodeStylePreview,
  captureDesignRuntimeScreenshot,
  previewDesignNodeStyles,
  selectDesignFrame,
  selectDesignNodeAtLocation,
} from "../store/design-selection";
import { useDesignRuntimeStore } from "../store/design-runtime-store";
import {
  useDesignWorkspaceUiStore,
  useDesignWorkspaceView,
  validateDesignWorkspaceSelection,
} from "../store/design-workspace-ui";
import { useDesignWorkspaceSnapshot } from "../store/use-design-workspace";
import { clearWorkspaceSettling } from "../store/pending-workspaces";
import { cn } from "../ui/cn";
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  toast,
} from "../ui/primitives";
import {
  fitDesignRects,
  selectLiveDesignFrameFiles,
  zoomDesignViewportAtPoint,
  type DesignViewport,
} from "./design-canvas-math";
import { DesignFrameRuntimeIframe } from "./design-frame-runtime-iframe";
import { hasDesignAssetDrag, readDesignAssetDrag } from "./design-assets";

// --- TYPES ---

interface DesignWorkspaceColumnProps {
  /** Confirmed design workspace; null while an optimistic create is landing. */
  workspace: Workspace | null;
  /** Exact destination path used for the snapshot refresh key. */
  folder: string | null;
  /** Hidden retained shells must not read, poll, focus, or attach shortcuts. */
  surfaceActive: boolean;
  /** Mirrors Column 3 collapse without destroying canvas DOM. */
  collapsed?: boolean;
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
}

interface DesignInspectorProps {
  /** Full workspace metadata supplies the existing shared PR workflow. */
  workspace: Workspace | null;
  workspaceId: string | null;
  folder: string | null;
  /** Selected frame document, or null for an empty canvas selection. */
  frame: DesignFrameDocumentWire | null;
  /** Browser-computed values for the exact selected frame/element key. */
  details: DesignRuntimeNodeDetails | null;
  /** Stable element identity; null means the frame itself is selected. */
  selectedNodeId: string | null;
  /** Deterministic document lint result from the aggregate snapshot. */
  lint: DesignLintReportWire | null;
  /** Typed token rows and their exact tokens.css generation. */
  tokens: DesignTokenWire[];
  tokenSourceVersion: string | null;
}

type FrameGestureMode = "move" | "resize";
type DesignCanvasTool = "select" | "text";

interface InlineTextEdit {
  frame: string;
  nodeId: string;
  sourceVersion: string;
  draft: string;
}

// --- CONSTANTS ---

const DESIGN_COLUMN_CLS =
  "border-border1 relative flex min-h-0 min-w-[200px] overflow-hidden border-l bg-bg1 [flex:calc((1_-_var(--zeros-column-2-ratio,0.5))*100)_1_0px]";
const MIN_FRAME_WIDTH = 240;
const MIN_FRAME_HEIGHT = 160;
const COLD_BUSY_DELAY_MS = 180;
const MAX_LIVE_DESIGN_FRAMES = 12;

// --- WORKFLOWS ---

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The design could not load.";
}

function frameGeometry(
  frame: DesignFrameDocumentWire,
): DesignFrameGeometryWire {
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
  folder,
  frame,
  active,
  selected,
  live,
}: {
  workspaceId: string;
  folder: string;
  frame: DesignFrameDocumentWire;
  active: boolean;
  selected: boolean;
  live: boolean;
}) {
  const screenshot = useDesignRuntimeStore(
    (state) =>
      state.byWorkspace[workspaceId]?.frames[frame.file]?.screenshotsByNode[""],
  );
  if (live) {
    return (
      <DesignFrameRuntimeIframe
        workspaceId={workspaceId}
        folder={folder}
        frame={frame}
        active={active}
        selected={selected}
        autoCapture
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
// PURPOSE: Swap the right work surface while preserving the chat column
// USED IN: MainShellBody
// ============================================

// --- STATE ---

export function DesignWorkspaceColumn({
  workspace,
  folder,
  surfaceActive,
  collapsed = false,
}: DesignWorkspaceColumnProps) {
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
      />
      <DesignInspector
        workspace={workspace}
        workspaceId={workspaceId}
        folder={folder}
        frame={selectedFrame}
        details={selectedDetails}
        selectedNodeId={selectedNodeId}
        lint={snapshot.data?.lint ?? null}
        tokens={snapshot.data?.tokens ?? []}
        tokenSourceVersion={snapshot.data?.tokenSourceVersion ?? null}
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
}: DesignCanvasProps) {
  const view = useDesignWorkspaceView(workspaceId);
  const setCodeView = useDesignWorkspaceUiStore((state) => state.setCodeView);
  const setViewport = useDesignWorkspaceUiStore((state) => state.setViewport);
  const selectedFrame =
    snapshot?.frames.find((frame) => frame.file === view.selectedFrame) ??
    snapshot?.frames[0] ??
    null;
  const selectedNodeDetails = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame || !view.selectedNodeId) return null;
    return (
      state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.detailsByNode[
        view.selectedNodeId
      ] ?? null
    );
  });
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

  // DOM owner for viewport bounds, focus scoping, and pointer-relative zoom.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Direct transform target keeps panning gesture paints out of React.
  const worldRef = useRef<HTMLDivElement | null>(null);
  // Space state is mirrored in a ref so pointer handlers read the current key.
  const spacePressedRef = useRef(false);
  // Drives the grab cursor without publishing transient state globally.
  const [spacePressed, setSpacePressed] = useState(false);
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
  // Inline text drafts are ephemeral and remain owned by their exact source key.
  const [inlineTextEdit, setInlineTextEdit] = useState<InlineTextEdit | null>(
    null,
  );
  // Enter can cause blur during unmount; one exact edit key may commit once.
  const textCommitKeyRef = useRef<string | null>(null);
  // Cancels whichever direct-DOM pointer gesture owns global listeners.
  const gestureCancelRef = useRef<(() => void) | null>(null);
  const liveFrameFiles = useMemo(
    () =>
      active && snapshot
        ? selectLiveDesignFrameFiles({
            frames: snapshot.frames,
            viewport: viewportSize,
            view,
            selectedFrame: selectedFrame?.file ?? null,
            maxLive: MAX_LIVE_DESIGN_FRAMES,
          })
        : new Set<string>(),
    [active, selectedFrame?.file, snapshot, view, viewportSize],
  );
  const publishSelection = useCallback(
    (frame: DesignFrameDocumentWire | null) => {
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
    (frames: readonly DesignFrameDocumentWire[]) => {
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
    async (frame: DesignFrameDocumentWire) => {
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
      if (textCommitKeyRef.current === key) return;
      textCommitKeyRef.current = key;
      setInlineTextEdit((current) => (current === edit ? null : current));
      if (!workspaceId) {
        textCommitKeyRef.current = null;
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
        if (textCommitKeyRef.current === key) textCommitKeyRef.current = null;
      }
    },
    [workspaceId],
  );

  const insertAsset = useCallback(
    async (
      frame: DesignFrameDocumentWire,
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

  /** Move/resize previews paint one node; release publishes one engine write. */
  const startFrameGesture = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      frame: DesignFrameDocumentWire,
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

      const move = (pointerEvent: PointerEvent) => {
        const dx = (pointerEvent.clientX - startX) / view.zoom;
        const dy = (pointerEvent.clientY - startY) / view.zoom;
        if (!moved && Math.hypot(dx, dy) < 3 / view.zoom) return;
        moved = true;
        latest =
          mode === "move"
            ? {
                ...start,
                x: Math.round(start.x + dx),
                y: Math.round(start.y + dy),
              }
            : {
                ...start,
                w: Math.max(MIN_FRAME_WIDTH, Math.round(start.w + dx)),
                h: Math.max(MIN_FRAME_HEIGHT, Math.round(start.h + dy)),
              };
        paintFrameGeometry(element, latest);
      };

      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        gestureCancelRef.current = null;
        if (!moved) return;
        void updateDesignFrameGeometryCached(
          workspaceId,
          frame.file,
          latest,
        ).catch((geometryError) => {
          paintFrameGeometry(element, start);
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
        gestureCancelRef.current = null;
      };

      gestureCancelRef.current?.();
      gestureCancelRef.current = cancel;
      document.body.style.cursor = mode === "move" ? "grabbing" : "nwse-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
    },
    [active, publishSelection, view.zoom, workspaceId],
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
  // surface is active, protecting chat/composer input and retained Home shells.
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
      if (event.code === "Space" && !event.repeat) {
        event.preventDefault();
        spacePressedRef.current = true;
        setSpacePressed(true);
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
      if (event.code !== "Space") return;
      spacePressedRef.current = false;
      setSpacePressed(false);
    };
    const blur = () => {
      spacePressedRef.current = false;
      setSpacePressed(false);
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  }, [active, fitFrames, selectedFrame, snapshot?.frames, zoomAt]);

  // Navigation/collapse during a drag must release window listeners and restore
  // the pre-gesture DOM geometry before the retained surface becomes inert.
  useEffect(
    () => () => {
      gestureCancelRef.current?.();
      gestureCancelRef.current = null;
    },
    [active],
  );

  // --- EVENT HANDLERS ---

  const handleViewportPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      viewportRef.current?.focus({ preventScroll: true });
      if (
        event.target instanceof Element &&
        event.target.closest("[data-design-controls]")
      ) {
        return;
      }
      if (startPan(event)) return;
      if (event.target === event.currentTarget) publishSelection(null);
    },
    [publishSelection, startPan],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!active || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      zoomAt(view.zoom * Math.exp(-event.deltaY * 0.002), {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    },
    [active, view.zoom, zoomAt],
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
          className="pointer-events-none absolute inset-0 origin-top-left"
          style={{
            transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
          }}
        >
          {snapshot?.frames.map((frame) => {
            const selected = selectedFrame?.file === frame.file;
            const selectedElement =
              selected &&
              view.selectedNodeId &&
              selectedNodeDetails?.oid === view.selectedNodeId
                ? selectedNodeDetails
                : null;
            const hoveredElement =
              hoveredFrame === frame.file &&
              hoveredNodeDetails?.oid === hoveredNodeId &&
              hoveredNodeId !== selectedElement?.oid
                ? hoveredNodeDetails
                : null;
            return (
              <article
                key={`${workspaceId ?? "pending"}:${frame.file}`}
                data-design-frame={frame.file}
                className={cn(
                  "bg-bg1 pointer-events-auto absolute outline",
                  selected ? "outline-highlighted-bright" : "outline-border2",
                )}
                style={{
                  left: frame.x,
                  top: frame.y,
                  width: frame.width,
                  height: frame.height,
                  zIndex: frame.z,
                  outlineWidth: selected ? 2 / view.zoom : 1 / view.zoom,
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
                  const bounds = event.currentTarget.getBoundingClientRect();
                  const scaleX =
                    bounds.width > 0 ? frame.width / bounds.width : 1;
                  const scaleY =
                    bounds.height > 0 ? frame.height / bounds.height : 1;
                  void selectDesignNodeAtLocation({
                    workspaceId,
                    folder,
                    frame,
                    x: (event.clientX - bounds.left) * scaleX,
                    y: (event.clientY - bounds.top) * scaleY,
                  })
                    .then((details) => {
                      if (activeTool !== "text" || !details) return;
                      setInlineTextEdit({
                        frame: frame.file,
                        nodeId: details.oid,
                        sourceVersion: frame.sourceVersion,
                        draft: details.text ?? "",
                      });
                    })
                    .catch((selectionError) => {
                      toast.error("Couldn't inspect that design element", {
                        description: errorMessage(selectionError),
                      });
                    });
                }}
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
                    </Button>
                  )}
                </div>

                {workspaceId && folder ? (
                  <DesignFrameRenderSurface
                    workspaceId={workspaceId}
                    folder={folder}
                    frame={frame}
                    active={active}
                    selected={selected}
                    live={liveFrameFiles.has(frame.file)}
                  />
                ) : (
                  <iframe
                    srcDoc={frame.srcDoc}
                    sandbox="allow-scripts"
                    tabIndex={-1}
                    className="bg-bg1 pointer-events-none block size-full border-0"
                    aria-label={`${frame.title} design frame`}
                  />
                )}

                {[hoveredElement, selectedElement].map((details, index) =>
                  details ? (
                    <div
                      key={`${index}:${details.oid}`}
                      data-design-element-overlay={details.oid}
                      className={cn(
                        "pointer-events-none absolute outline",
                        details === selectedElement
                          ? "outline-highlighted-bright"
                          : "outline-border4",
                      )}
                      style={{
                        left: details.rect.x,
                        top: details.rect.y,
                        width: details.rect.width,
                        height: details.rect.height,
                        zIndex: 1,
                        outlineWidth:
                          (details === selectedElement ? 2 : 1) / view.zoom,
                      }}
                    >
                      {details === selectedElement ? (
                        <span
                          className="border-border3 bg-bg1 text-fg1 absolute bottom-full left-0 max-w-56 truncate rounded-sm border px-1.5 py-1 text-xs"
                          style={{
                            transform: `scale(${1 / view.zoom})`,
                            transformOrigin: "bottom left",
                          }}
                        >
                          {details.name} · {details.tag}
                        </span>
                      ) : null}
                    </div>
                  ) : null,
                )}

                {selectedElement &&
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
                        setInlineTextEdit(null);
                      }
                    }}
                  />
                ) : null}

                {selected ? (
                  <div
                    className="absolute right-0 bottom-0 origin-center"
                    style={{
                      transform: `translate(50%, 50%) scale(${1 / view.zoom})`,
                    }}
                  >
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon-sm"
                      aria-label={`Resize ${frame.title}`}
                      onPointerDown={(event) =>
                        startFrameGesture(event, frame, "resize")
                      }
                    >
                      <MoveDiagonal2 />
                    </Button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>

        {view.codeView && selectedFrame ? (
          <div
            data-design-controls
            className="bg-bg1 absolute inset-0 overflow-hidden p-4"
          >
            <ScrollArea className="h-full">
              <CodeBlock
                language="html"
                filename={`Zeros Design/${selectedFrame.file}`}
              >
                <pre>{selectedFrame.source}</pre>
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

        <div
          data-design-controls
          className="border-border2 bg-bg1 absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg border p-1 shadow-[var(--shadow-dropdown)]"
        >
          <Tooltip label="Select" shortcut="V">
            <Button
              type="button"
              variant={activeTool === "select" ? "secondary-on" : "ghost"}
              size="icon"
              aria-label="Select"
              onClick={() => setActiveTool("select")}
            >
              <MousePointer2 />
            </Button>
          </Tooltip>
          <Tooltip label={creatingFrame ? "Creating frame…" : "New frame"}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={!workspaceId || creatingFrame}
              aria-label="New frame"
              onClick={() => void createFrame()}
            >
              <SquareDashed />
            </Button>
          </Tooltip>
          <Tooltip label="Edit text" shortcut="T">
            <Button
              type="button"
              variant={activeTool === "text" ? "secondary-on" : "ghost"}
              size="icon"
              disabled={!workspaceId || !selectedFrame}
              aria-label="Text tool"
              onClick={() => {
                setActiveTool("text");
                if (
                  selectedFrame &&
                  view.selectedNodeId &&
                  selectedNodeDetails
                ) {
                  setInlineTextEdit({
                    frame: selectedFrame.file,
                    nodeId: view.selectedNodeId,
                    sourceVersion: selectedFrame.sourceVersion,
                    draft: selectedNodeDetails.text ?? "",
                  });
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
              size="icon"
              disabled={!workspaceId || !selectedFrame}
              aria-label="Toggle frame source"
              onClick={() => {
                if (workspaceId) setCodeView(workspaceId, !view.codeView);
              }}
            >
              <Code2 />
            </Button>
          </Tooltip>
        </div>

        <div
          data-design-controls
          className="border-border2 bg-bg1 absolute right-3 bottom-3 flex items-center gap-1 rounded-lg border p-1 shadow-[var(--shadow-dropdown)]"
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
        </div>
      </div>
    </div>
  );
}

interface InspectorEditFieldProps {
  label: string;
  value: string | number;
  disabled?: boolean;
  onPreview?: (value: string) => Promise<unknown> | void;
  onCommit: (value: string) => Promise<unknown>;
}

function InspectorEditField({
  label,
  value,
  disabled = false,
  onPreview,
  onCommit,
}: InspectorEditFieldProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baselineRef = useRef(String(value));
  const skipCommitRef = useRef(false);
  const previewFrameRef = useRef<number | null>(null);
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
    },
    [],
  );

  const preview = (next: string) => {
    if (!onPreview) return;
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
    }
    previewFrameRef.current = window.requestAnimationFrame(() => {
      previewFrameRef.current = null;
      void Promise.resolve(onPreview(next)).catch(() => {});
    });
  };

  const commit = async () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    const baseline = baselineRef.current;
    if (draft === baseline || saving) return;
    setSaving(true);
    try {
      await onCommit(draft);
      baselineRef.current = draft;
    } catch (fieldError) {
      setDraft(baseline);
      preview(baseline);
      toast.error(`Couldn't update ${label.toLowerCase()}`, {
        description: errorMessage(fieldError),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id} className="text-fg3 text-xs">
        {label}
      </Label>
      <Input
        ref={inputRef}
        id={id}
        value={draft}
        disabled={disabled || saving}
        className="h-7 min-w-0 font-mono text-xs"
        onFocus={() => {
          baselineRef.current = String(value);
        }}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          preview(next);
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
            preview(baselineRef.current);
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function InspectorStyleField({
  workspaceId,
  folder,
  frame,
  nodeId,
  label,
  property,
  value,
}: {
  workspaceId: string;
  folder: string;
  frame: DesignFrameDocumentWire;
  nodeId: string;
  label: string;
  property: string;
  value: string;
}) {
  const previewInput = {
    workspaceId,
    folder,
    frame: frame.file,
    sourceVersion: frame.sourceVersion,
    nodeId,
  };
  return (
    <InspectorEditField
      label={label}
      value={value}
      onPreview={(next) =>
        previewDesignNodeStyles({
          ...previewInput,
          styles: { [property]: next || null },
        })
      }
      onCommit={async (next) => {
        try {
          await updateDesignNodeStylesCached(workspaceId, {
            frame: frame.file,
            nodeId,
            sourceVersion: frame.sourceVersion,
            styles: { [property]: next || null },
          });
        } catch (styleError) {
          await clearDesignNodeStylePreview(previewInput).catch(() => {});
          throw styleError;
        }
      }}
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
  lint,
  tokens,
  tokenSourceVersion,
}: DesignInspectorProps) {
  const elementDetails = selectedNodeId ? details : null;
  const errors =
    lint?.violations.filter((violation) => violation.severity === "error") ??
    [];
  const warnings =
    lint?.violations.filter((violation) => violation.severity === "warning") ??
    [];
  const warningGroups = groupDesignLintViolations(warnings);
  const themes = useMemo(
    () =>
      [
        ...new Set(tokens.flatMap((token) => Object.keys(token.themeValues))),
      ].sort((left, right) => left.localeCompare(right)),
    [tokens],
  );
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [frameAction, setFrameAction] = useState<
    "duplicate" | "delete" | "save" | "export" | null
  >(null);
  const [advancedProperty, setAdvancedProperty] = useState("");
  const [advancedValue, setAdvancedValue] = useState("");
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);

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

  const styleContext =
    workspaceId && folder && frame && selectedNodeId && elementDetails
      ? { workspaceId, folder, frame, nodeId: selectedNodeId }
      : null;
  const styleField = (label: string, property: string, value: string) =>
    styleContext ? (
      <InspectorStyleField
        key={property}
        {...styleContext}
        label={label}
        property={property}
        value={value}
      />
    ) : null;

  return (
    <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
      <aside className="border-border1 bg-bg1 flex w-64 shrink-0 flex-col overflow-hidden border-l">
        <Tabs
          defaultValue="design"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <div className="border-border1 shrink-0 border-b p-2">
            <TabsList className="h-7 w-full">
              <TabsTrigger value="design" className="h-5 flex-1 px-2 text-xs">
                Design
              </TabsTrigger>
              <TabsTrigger
                value="prototype"
                className="h-5 flex-1 px-2 text-xs"
                disabled
              >
                Prototype
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent
            value="design"
            className="mt-0 min-h-0 flex-1 overflow-hidden"
          >
            <ScrollArea className="h-full">
              <div className="flex flex-col">
                <section className="border-border1 flex flex-col gap-2 border-b p-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-fg1 truncate text-sm font-medium">
                      {elementDetails?.name ??
                        frame?.title ??
                        "Nothing selected"}
                    </span>
                    <span className="text-fg3 text-xs">
                      {frame
                        ? elementDetails
                          ? `${elementDetails.tag} · ${frame.file}`
                          : `Frame · ${frame.file}`
                        : "Select a frame on canvas"}
                    </span>
                    {elementDetails?.breadcrumb.length ? (
                      <span className="text-fg3 truncate text-xs">
                        {elementDetails.breadcrumb.join(" / ")}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!workspaceId || frameAction !== null}
                      onClick={() => void save()}
                    >
                      {frameAction === "save" ? "Saving…" : "Save designs"}
                    </Button>
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
                    {workspace && workspace.prNumber == null ? (
                      <CreatePrButton
                        workspace={workspace}
                        originUrl={null}
                        disabled={errors.length > 0 || frameAction !== null}
                        disabledReason={
                          errors.length > 0
                            ? "Fix design errors before creating a pull request"
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
                  </div>
                </section>

                {errors.length > 0 ? (
                  <section className="border-border1 border-b p-3">
                    <Alert variant="destructive">
                      <AlertTriangle />
                      <AlertTitle>
                        {errors.length} design{" "}
                        {errors.length === 1 ? "error" : "errors"}
                      </AlertTitle>
                      <AlertDescription>
                        {errors[0]?.ruleId}: {errors[0]?.message}
                      </AlertDescription>
                    </Alert>
                  </section>
                ) : null}

                {warnings.length > 0 ? (
                  <section className="border-border1 border-b p-3">
                    <Alert>
                      <AlertTriangle />
                      <AlertTitle>
                        {lintReviewBadgeLabel(warningGroups)}
                      </AlertTitle>
                      <AlertDescription className="flex flex-col gap-1">
                        <span>
                          {warnings.length} non-blocking design{" "}
                          {warnings.length === 1 ? "finding" : "findings"}.{" "}
                          Saving and pull requests remain available.
                        </span>
                        {warningGroups.slice(0, 3).map((group) => (
                          <span key={group.ruleId}>
                            {group.label} · {group.count}{" "}
                            {group.count === 1 ? "finding" : "findings"}: {" "}
                            {group.first.message}
                          </span>
                        ))}
                      </AlertDescription>
                    </Alert>
                  </section>
                ) : null}

                <section className="border-border1 flex flex-col gap-3 border-b p-3">
                  <span className="text-fg2 text-xs font-medium">
                    Position &amp; size
                  </span>
                  {styleContext && elementDetails ? (
                    <div className="grid grid-cols-2 gap-2">
                      {styleField(
                        "X",
                        "left",
                        elementDetails.styles.left ||
                          `${Math.round(elementDetails.rect.x)}px`,
                      )}
                      {styleField(
                        "Y",
                        "top",
                        elementDetails.styles.top ||
                          `${Math.round(elementDetails.rect.y)}px`,
                      )}
                      {styleField(
                        "W",
                        "width",
                        elementDetails.styles.width ||
                          `${Math.round(elementDetails.rect.width)}px`,
                      )}
                      {styleField(
                        "H",
                        "height",
                        elementDetails.styles.height ||
                          `${Math.round(elementDetails.rect.height)}px`,
                      )}
                    </div>
                  ) : frame && workspaceId ? (
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
                  ) : null}
                  {elementDetails
                    ? styleField(
                        "Radius",
                        "border-radius",
                        elementDetails.styles.borderRadius || "0px",
                      )
                    : null}
                </section>

                {elementDetails ? (
                  <>
                    <section className="border-border1 flex flex-col gap-3 border-b p-3">
                      <span className="text-fg2 text-xs font-medium">
                        Auto layout
                      </span>
                      <div className="grid grid-cols-2 gap-2">
                        {styleField(
                          "Display",
                          "display",
                          elementDetails.styles.display || "block",
                        )}
                        {styleField(
                          "Direction",
                          "flex-direction",
                          elementDetails.styles.flexDirection || "row",
                        )}
                        {styleField(
                          "Gap",
                          "gap",
                          elementDetails.styles.gap || "0px",
                        )}
                        {styleField(
                          "Padding",
                          "padding",
                          elementDetails.styles.padding || "0px",
                        )}
                        {styleField(
                          "Align",
                          "align-items",
                          elementDetails.styles.alignItems || "normal",
                        )}
                        {styleField(
                          "Justify",
                          "justify-content",
                          elementDetails.styles.justifyContent || "normal",
                        )}
                      </div>
                    </section>

                    <section className="border-border1 flex flex-col gap-3 border-b p-3">
                      <span className="text-fg2 text-xs font-medium">
                        Fill &amp; stroke
                      </span>
                      {styleField(
                        "Fill",
                        "background",
                        elementDetails.styles.background || "transparent",
                      )}
                      {styleField(
                        "Stroke",
                        "border",
                        elementDetails.styles.border || "0px none",
                      )}
                    </section>

                    <section className="border-border1 flex flex-col gap-3 border-b p-3">
                      <span className="text-fg2 text-xs font-medium">
                        Typography
                      </span>
                      <div className="grid grid-cols-2 gap-2">
                        {styleField(
                          "Color",
                          "color",
                          elementDetails.styles.color || "",
                        )}
                        {styleField(
                          "Size",
                          "font-size",
                          elementDetails.styles.fontSize || "",
                        )}
                        {styleField(
                          "Weight",
                          "font-weight",
                          elementDetails.styles.fontWeight || "",
                        )}
                        {styleField(
                          "Line",
                          "line-height",
                          elementDetails.styles.lineHeight || "",
                        )}
                        {styleField(
                          "Tracking",
                          "letter-spacing",
                          elementDetails.styles.letterSpacing || "",
                        )}
                        {styleField(
                          "Align",
                          "text-align",
                          elementDetails.styles.textAlign || "start",
                        )}
                      </div>
                    </section>

                    <section className="border-border1 flex flex-col gap-2 border-b p-3">
                      <span className="text-fg2 text-xs font-medium">
                        Advanced
                      </span>
                      <Input
                        value={advancedProperty}
                        placeholder="CSS property"
                        aria-label="Advanced CSS property"
                        className="h-7 font-mono text-xs"
                        onChange={(event) =>
                          setAdvancedProperty(event.target.value)
                        }
                      />
                      <Input
                        value={advancedValue}
                        placeholder="Value"
                        aria-label="Advanced CSS value"
                        className="h-7 font-mono text-xs"
                        onChange={(event) =>
                          setAdvancedValue(event.target.value)
                        }
                      />
                      <Button
                        type="button"
                        size="sm"
                        disabled={!styleContext || !advancedProperty.trim()}
                        onClick={() => {
                          if (!styleContext) return;
                          void updateDesignNodeStylesCached(workspaceId!, {
                            frame: frame!.file,
                            nodeId: selectedNodeId!,
                            sourceVersion: frame!.sourceVersion,
                            styles: {
                              [advancedProperty.trim()]:
                                advancedValue.trim() || null,
                            },
                          })
                            .then(() => {
                              setAdvancedProperty("");
                              setAdvancedValue("");
                            })
                            .catch((advancedError) => {
                              toast.error("Couldn't update the CSS property", {
                                description: errorMessage(advancedError),
                              });
                            });
                        }}
                      >
                        Apply property
                      </Button>
                    </section>
                  </>
                ) : null}

                <section className="border-border1 flex flex-col gap-3 border-b p-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-fg2 text-xs font-medium">Themes</span>
                    <span className="text-fg3 text-xs">
                      Values are written to tokens.css with exact-generation
                      checks.
                    </span>
                  </div>
                  {tokens.length > 0 && workspaceId && tokenSourceVersion ? (
                    <div className="flex max-h-72 flex-col gap-3 overflow-auto">
                      {tokens.map((token) => (
                        <div
                          key={token.name}
                          className="border-border1 flex min-w-0 flex-col gap-2 border-b pb-3 last:border-b-0 last:pb-0"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <code className="text-fg1 min-w-0 truncate text-xs">
                              {token.name}
                            </code>
                            <span className="text-fg3 shrink-0 text-xs">
                              {token.usageCount} uses
                            </span>
                          </div>
                          <InspectorEditField
                            label="Base"
                            value={token.value}
                            onCommit={async (value) => {
                              await updateDesignTokenCached(workspaceId, {
                                name: token.name,
                                theme: null,
                                value,
                                sourceVersion: tokenSourceVersion,
                              });
                            }}
                          />
                          {themes.map((theme) => (
                            <InspectorEditField
                              key={theme}
                              label={theme}
                              value={token.themeValues[theme] ?? token.value}
                              onCommit={async (value) => {
                                await updateDesignTokenCached(workspaceId, {
                                  name: token.name,
                                  theme,
                                  value,
                                  sourceVersion: tokenSourceVersion,
                                });
                              }}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-fg3 text-xs">
                      Add typed properties and :root values in tokens.css to
                      edit themes here.
                    </span>
                  )}
                  {themes.length === 0 && tokens.length > 0 ? (
                    <span className="text-fg3 text-xs">
                      Add a [data-zd-theme=&quot;name&quot;] block in tokens.css
                      to expose a theme column.
                    </span>
                  ) : null}
                </section>

                <section className="flex flex-col gap-2 p-3">
                  <span className="text-fg2 text-xs font-medium">Export</span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!frame || !folder || frameAction !== null}
                    onClick={() => void exportPng()}
                  >
                    {frameAction === "export" ? "Exporting…" : "Export PNG"}
                  </Button>
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
