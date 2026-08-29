// ============================================
// COMPONENT: DesignWorkspaceSidebarPanels
// PURPOSE: Collapsible Layers tree for the native design sidebar
// USED IN: DesignWorkspaceSidebar for design workspaces
// ============================================

// --- IMPORTS ---

import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeClosed,
  Frame,
  Grid2X2,
  Image,
  ListCollapse,
  Spline,
  StretchHorizontal,
  StretchVertical,
  Type,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import type { Workspace } from "../../platform/git";
import type { DesignCanvasFrameWire } from "../../platform/bridge/design-bridge";

import {
  hoverDesignNode,
  selectDesignFrame,
  selectDesignNode,
  setDesignNodeVisibility,
  toggleDesignNodeSelection,
} from "./state/design-selection";
import { useDesignRuntimeStore } from "./state/design-runtime-store";
import { useActiveWorkspace } from "../../state/use-active-workspace";
import { useDesignWorkspaceSnapshot } from "./state/use-design-workspace";
import { useDesignWorkspaceUiStore } from "./state/design-workspace-ui";
import {
  usePendingWorkspaceKind,
  usePendingWorkspaceMode,
} from "../../state/pending-workspaces";
import { resolveWorkspacePresentationKind } from "../../state/workspace-resolution";
import { Button, ScrollArea, Tooltip, toast } from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import {
  designLayerAncestorIds,
  designLayerBlockEdges,
  designLayerRevealWindow,
  designLayerRovingTabStop,
  designLayerSelectionSubtreeIds,
  designLayerVirtualWindow,
  flattenDesignLayerTree,
  type DesignLayerBlockEdge,
  type FlatDesignLayer,
} from "./design-layer-tree";
import {
  designFrameLayerLabel,
  designRuntimeLayerLabel,
  type DesignLayerLabel,
} from "./design-layer-label";
import {
  designFrameLayoutIconKind,
  type DesignFrameLayoutIconKind,
} from "./design-layer-layout";
import {
  collapseAllDesignLayers,
  designWorkspaceHasExpandedLayers,
  EMPTY_DESIGN_FRAME_DISCLOSURE,
  revealDesignLayerPath,
  toggleDesignFrameTreeExpanded,
  toggleDesignLayerExpanded,
  useDesignWorkspaceDisclosure,
} from "./state/design-layer-disclosure";

// --- TYPES ---

interface DesignWorkspaceSidebarPanelsProps {
  /** Hidden retained workspace shells keep their reads and controls inert. */
  surfaceActive: boolean;
  /** Retained workspace decks pass an explicit semantic owner. */
  workspace?: Workspace | null;
  folder?: string | null;
  panelId?: string;
}

interface OwnedDesignWorkspaceSidebarPanelsProps {
  surfaceActive: boolean;
  workspace: Workspace | null;
  folder: string | null;
  panelId: string;
  isDesign: boolean;
}

interface LayerWindowState {
  ownerKey: string | null;
  count: number;
  start: number;
  end: number;
}

/** The panel is one tree: every frame contributes its row, and an open frame
 * contributes the layer rows below it. Keeping them in one fixed-height list is
 * what lets several frames stand open while virtualization, keyboard travel,
 * and the selection block keep working across frame boundaries. */
type DesignPanelRow =
  | {
      kind: "frame";
      key: string;
      frame: DesignCanvasFrameWire;
      expanded: boolean;
      discloses: boolean;
    }
  | {
      kind: "layer";
      key: string;
      frame: DesignCanvasFrameWire;
      layer: FlatDesignLayer;
      expanded: boolean;
    }
  | { kind: "pending"; key: string; frame: DesignCanvasFrameWire };

const EMPTY_LAYER_TREE: readonly DesignRuntimeTreeNode[] = Object.freeze([]);
const EMPTY_SELECTED_NODE_IDS: readonly string[] = Object.freeze([]);
const EMPTY_FRAMES: readonly DesignCanvasFrameWire[] = Object.freeze([]);
const DESIGN_LAYER_ROW_HEIGHT = 28;
const DESIGN_LAYER_INDENT = 12;
/** Matches the frame row's own `px-1`, so depth 0 lines up one step in. */
const DESIGN_LAYER_ROW_PADDING = 4;
/** A childless row reserves the chevron's exact 12px footprint, so every
 * type icon in the tree keeps one shared left edge per depth. */
const DESIGN_LAYER_DISCLOSURE_SPACER = "size-3 shrink-0";

// --- WORKFLOWS ---

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The layer action failed.";
}

/** Row identity is frame-scoped: two frames may legitimately author the same
 * node id, and both can be on screen at once. */
function frameRowKey(file: string): string {
  return `frame:${file}`;
}

function layerRowKey(file: string, nodeId: string): string {
  return `layer:${file}:${nodeId}`;
}

function FrameLayoutIcon({ kind }: { kind: DesignFrameLayoutIconKind }) {
  if (kind === "flex-vertical") {
    return (
      <StretchVertical
        data-design-layout-icon="flex-vertical"
        aria-hidden="true"
      />
    );
  }
  if (kind === "flex-horizontal") {
    return (
      <StretchHorizontal
        data-design-layout-icon="flex-horizontal"
        aria-hidden="true"
      />
    );
  }
  if (kind === "grid") {
    return <Grid2X2 data-design-layout-icon="grid" aria-hidden="true" />;
  }
  return <Frame data-design-layout-icon="frame" aria-hidden="true" />;
}

function LayerTypeIcon({
  label,
  display,
  flexDirection,
}: {
  label: DesignLayerLabel;
  display?: string;
  flexDirection?: string;
}) {
  if (label === "Image") return <Image aria-hidden="true" />;
  if (label === "Text") return <Type aria-hidden="true" />;
  if (label === "Vector Path") return <Spline aria-hidden="true" />;
  return (
    <FrameLayoutIcon
      kind={designFrameLayoutIconKind({ display, flexDirection })}
    />
  );
}

/** A selection and the rows it owns form one rounded container: the run's first
 * row rounds its top, its last rounds its bottom, and the rows between stay
 * square. Rows outside a run round on their own, so hover reads as one chip. */
function designLayerBlockRadius(edge: DesignLayerBlockEdge | null): string {
  if (edge === "top") return "rounded-t-md rounded-b-none";
  if (edge === "middle") return "rounded-none";
  if (edge === "bottom") return "rounded-t-none rounded-b-md";
  return "rounded-md";
}

function layerRowPadding(depth: number): number {
  return (
    DESIGN_LAYER_ROW_PADDING + Math.min(depth + 1, 16) * DESIGN_LAYER_INDENT
  );
}

// --- RENDER ---

export function DesignWorkspaceSidebarPanels({
  surfaceActive,
  workspace: workspaceOverride,
  folder: folderOverride,
  panelId = "design-layers-panel",
}: DesignWorkspaceSidebarPanelsProps) {
  if (workspaceOverride?.kind === "design" && folderOverride) {
    return (
      <OwnedDesignWorkspaceSidebarPanels
        surfaceActive={surfaceActive}
        workspace={workspaceOverride}
        folder={folderOverride}
        panelId={panelId}
        isDesign
      />
    );
  }
  return (
    <ActiveDesignWorkspaceSidebarPanels
      surfaceActive={surfaceActive}
      panelId={panelId}
    />
  );
}

function ActiveDesignWorkspaceSidebarPanels({
  surfaceActive,
  panelId,
}: {
  surfaceActive: boolean;
  panelId: string;
}) {
  const { workspace, folder } = useActiveWorkspace();
  const pendingKind = usePendingWorkspaceKind(folder);
  const requestedKind = usePendingWorkspaceMode(workspace?.id);
  const isDesign =
    resolveWorkspacePresentationKind({
      confirmedKind: workspace?.kind,
      requestedKind,
      pendingKind,
      folder,
    }) === "design";
  return (
    <OwnedDesignWorkspaceSidebarPanels
      surfaceActive={surfaceActive}
      workspace={workspace}
      folder={folder}
      panelId={panelId}
      isDesign={isDesign}
    />
  );
}

function OwnedDesignWorkspaceSidebarPanels({
  surfaceActive,
  workspace,
  folder,
  panelId,
  isDesign,
}: OwnedDesignWorkspaceSidebarPanelsProps) {
  const workspaceId = workspace?.kind === "design" ? workspace.id : null;
  const snapshot = useDesignWorkspaceSnapshot(
    workspaceId,
    folder,
    surfaceActive && isDesign,
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
      ? (state.byWorkspace[workspaceId]?.selectedNodeIds ??
        EMPTY_SELECTED_NODE_IDS)
      : EMPTY_SELECTED_NODE_IDS,
  );
  const frameSelected = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.frameSelected ?? false)
      : false,
  );
  const frames = snapshot.data?.frames ?? EMPTY_FRAMES;
  const selectedFrame =
    frames.find((frame) => frame.file === selectedFrameFile) ??
    frames[0] ??
    null;
  // Every frame can be open, so the panel reads all of their trees in one
  // subscription instead of one per frame. The runtime store also carries
  // details, screenshots, and hover state, all of which churn far more often
  // than a document tree — a shallow compare keeps those out of this panel.
  const treesByFile = useDesignRuntimeStore(
    useShallow((state) => {
      const runtimeFrames = workspaceId
        ? state.byWorkspace[workspaceId]?.frames
        : undefined;
      const trees: Record<string, readonly DesignRuntimeTreeNode[]> = {};
      if (!runtimeFrames) return trees;
      for (const [file, runtimeFrame] of Object.entries(runtimeFrames)) {
        const tree = runtimeFrame.snapshot?.tree;
        if (tree) trees[file] = tree;
      }
      return trees;
    }),
  );
  const frameLayoutIconsByFile = useDesignRuntimeStore(
    useShallow((state) => {
      const runtimeFrames = workspaceId
        ? state.byWorkspace[workspaceId]?.frames
        : undefined;
      const icons: Record<string, DesignFrameLayoutIconKind> = {};
      if (!runtimeFrames) return icons;
      for (const [file, runtimeFrame] of Object.entries(runtimeFrames)) {
        const styles = runtimeFrame.snapshot?.frame.styles;
        if (!styles) continue;
        icons[file] = designFrameLayoutIconKind({
          display: styles.display,
          flexDirection: styles.flexDirection,
        });
      }
      return icons;
    }),
  );
  const hoveredFrameFile = useDesignRuntimeStore((state) =>
    workspaceId ? (state.byWorkspace[workspaceId]?.hoveredFrame ?? null) : null,
  );
  const hoveredNodeId = useDesignRuntimeStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.hoveredNodeId ?? null)
      : null,
  );
  const disclosures = useDesignWorkspaceDisclosure(workspaceId);
  const revealedSelectionRef = useRef<string | null>(null);
  const selectedTree = selectedFrame
    ? (treesByFile[selectedFrame.file] ?? EMPTY_LAYER_TREE)
    : EMPTY_LAYER_TREE;
  const selectedAncestors = useMemo(
    () => designLayerAncestorIds(selectedTree, selectedNodeId),
    [selectedTree, selectedNodeId],
  );
  // Figma semantics: selecting a container selects everything it owns, so its
  // descendant rows carry a softer tint. A selected frame owns every row.
  const selectionSubtreeIds = useMemo(
    () => designLayerSelectionSubtreeIds(selectedTree, selectedNodeIds),
    [selectedTree, selectedNodeIds],
  );
  const panelRows = useMemo(() => {
    const rows: DesignPanelRow[] = [];
    for (const frame of frames) {
      const tree = treesByFile[frame.file];
      const disclosure =
        disclosures[frame.file] ?? EMPTY_DESIGN_FRAME_DISCLOSURE;
      rows.push({
        kind: "frame",
        key: frameRowKey(frame.file),
        frame,
        expanded: disclosure.treeExpanded,
        // A frame with a live tree answers from it; one whose runtime has not
        // reported yet answers from the engine's authored node count.
        discloses: tree ? tree.length > 0 : frame.nodeCount > 0,
      });
      if (!disclosure.treeExpanded) continue;
      if (!tree) {
        rows.push({ kind: "pending", key: `pending:${frame.file}`, frame });
        continue;
      }
      const expandedNodeIds = new Set(disclosure.expandedNodeIds);
      for (const layer of flattenDesignLayerTree(tree, { expandedNodeIds })) {
        rows.push({
          kind: "layer",
          key: layerRowKey(frame.file, layer.node.oid),
          frame,
          layer,
          expanded: layer.hasChildren && expandedNodeIds.has(layer.node.oid),
        });
      }
    }
    return rows;
  }, [disclosures, frames, treesByFile]);
  /** Consecutive rows the selection owns paint as one rounded block. Only the
   * selected frame can own rows, so every other frame's run stays closed. */
  const blockEdges = useMemo(() => {
    const selected = new Set(selectedNodeIds);
    return designLayerBlockEdges(
      panelRows.map((row) => {
        if (row.frame.file !== selectedFrame?.file) return false;
        if (row.kind === "frame") return frameSelected && !selectedNodeId;
        if (row.kind === "pending") return false;
        return (
          frameSelected ||
          selected.has(row.layer.node.oid) ||
          selectionSubtreeIds.has(row.layer.node.oid)
        );
      }),
    );
  }, [
    frameSelected,
    panelRows,
    selectedFrame?.file,
    selectedNodeId,
    selectedNodeIds,
    selectionSubtreeIds,
  ]);
  const hasExpandedLayers = useMemo(
    () =>
      designWorkspaceHasExpandedLayers(
        disclosures,
        frames.map((frame) => frame.file),
      ),
    [disclosures, frames],
  );
  // One composite tab stop; arrows move among every visible row.
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [layerWindowState, setLayerWindowState] = useState<LayerWindowState>({
    ownerKey: null,
    count: 0,
    start: 0,
    end: 0,
  });
  const initialLayerWindow = useMemo(
    () =>
      designLayerVirtualWindow({
        count: panelRows.length,
        visibleTop: 0,
        viewportHeight: 840,
      }),
    [panelRows.length],
  );
  const layerWindow =
    layerWindowState.ownerKey === workspaceId &&
    layerWindowState.count === panelRows.length
      ? layerWindowState
      : {
          ownerKey: workspaceId,
          count: panelRows.length,
          ...initialLayerWindow,
        };
  const virtualizedLayers = panelRows.length > 400;
  const renderedRows = virtualizedLayers
    ? panelRows.slice(layerWindow.start, layerWindow.end)
    : panelRows;

  /** Track only the fixed-height slice intersecting the Radix viewport. */
  useLayoutEffect(() => {
    if (!surfaceActive || !workspaceId || !virtualizedLayers) return;
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );
    const tree = treeRef.current;
    if (!viewport || !tree) return;
    let animationFrame: number | null = null;
    const updateWindow = () => {
      animationFrame = null;
      const viewportRect = viewport.getBoundingClientRect();
      const treeRect = tree.getBoundingClientRect();
      const next = designLayerVirtualWindow({
        count: panelRows.length,
        visibleTop: viewportRect.top - treeRect.top,
        viewportHeight: viewport.clientHeight,
        rowHeight: DESIGN_LAYER_ROW_HEIGHT,
      });
      setLayerWindowState((current) =>
        current.ownerKey === workspaceId &&
        current.count === panelRows.length &&
        current.start === next.start &&
        current.end === next.end
          ? current
          : {
              ownerKey: workspaceId,
              count: panelRows.length,
              ...next,
            },
      );
    };
    const scheduleWindow = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(updateWindow);
    };
    viewport.addEventListener("scroll", scheduleWindow, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleWindow);
    resizeObserver.observe(viewport);
    updateWindow();
    return () => {
      viewport.removeEventListener("scroll", scheduleWindow);
      resizeObserver.disconnect();
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [panelRows.length, surfaceActive, virtualizedLayers, workspaceId]);

  const revealRowAtIndex = useCallback(
    (index: number, focus: boolean) => {
      const row = panelRows[index];
      if (!row || !workspaceId) return;
      if (virtualizedLayers) {
        const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
          "[data-radix-scroll-area-viewport]",
        );
        const viewportHeight = viewport?.clientHeight || 840;
        setLayerWindowState((current) => {
          const currentWindow =
            current.ownerKey === workspaceId &&
            current.count === panelRows.length
              ? current
              : initialLayerWindow;
          const next = designLayerRevealWindow({
            count: panelRows.length,
            index,
            viewportHeight,
            current: currentWindow,
            rowHeight: DESIGN_LAYER_ROW_HEIGHT,
          });
          return current.ownerKey === workspaceId &&
            current.count === panelRows.length &&
            current.start === next.start &&
            current.end === next.end
            ? current
            : { ownerKey: workspaceId, count: panelRows.length, ...next };
        });
      }
      window.requestAnimationFrame(() => {
        const element = Array.from(
          treeRef.current?.querySelectorAll<HTMLButtonElement>(
            "[data-design-panel-row]",
          ) ?? [],
        ).find((candidate) => candidate.dataset.designPanelRow === row.key);
        element?.scrollIntoView({ block: "nearest" });
        if (focus) element?.focus();
      });
    },
    [initialLayerWindow, panelRows, virtualizedLayers, workspaceId],
  );

  /** A selection restored from durable memory (or published by the engine
   * rather than by a click) still has to be reachable. Reveal its path once per
   * selected node, before the browser paints, and never again: a frame or
   * container the user folds afterwards must stay folded through mutations. */
  useLayoutEffect(() => {
    if (!workspaceId || !selectedFrame || !selectedNodeId) return;
    if (selectedTree.length === 0) return;
    const revealKey = `${workspaceId} ${selectedFrame.file} ${selectedNodeId}`;
    if (revealedSelectionRef.current === revealKey) return;
    revealedSelectionRef.current = revealKey;
    revealDesignLayerPath(workspaceId, selectedFrame.file, selectedAncestors);
  }, [
    selectedAncestors,
    selectedFrame,
    selectedNodeId,
    selectedTree.length,
    workspaceId,
  ]);

  /** Keep an externally selected canvas layer inside the scroll viewport. */
  useLayoutEffect(() => {
    if (!selectedNodeId || !selectedFrame) return;
    const rowKey = layerRowKey(selectedFrame.file, selectedNodeId);
    const index = panelRows.findIndex((row) => row.key === rowKey);
    if (index < 0) return;
    const element = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>(
        "[data-design-panel-row]",
      ) ?? [],
    ).find((candidate) => candidate.dataset.designPanelRow === rowKey);
    if (element) element.scrollIntoView({ block: "nearest" });
    else revealRowAtIndex(index, false);
  }, [panelRows, revealRowAtIndex, selectedFrame, selectedNodeId]);

  if (!isDesign) return null;

  const toggleExpanded = (row: DesignPanelRow) => {
    if (row.kind !== "layer" || !row.layer.hasChildren || !workspaceId) return;
    toggleDesignLayerExpanded(workspaceId, row.frame.file, row.layer.node.oid);
  };

  /** The chevron owns the fold, and nothing else touches it: a frame the user
   * opened stays open while they work in another frame, and one they closed
   * stays closed when the canvas selects that frame. */
  const toggleFrameTree = (frame: DesignCanvasFrameWire) => {
    if (!workspaceId) return;
    toggleDesignFrameTreeExpanded(workspaceId, frame.file);
  };

  /** Selection publication is immediate locally; engine/runtime reads finish off-path. */
  const chooseFrame = (frame: DesignCanvasFrameWire) => {
    if (!workspaceId) return;
    void selectDesignFrame(workspaceId, frame, { selected: true }).catch(
      (error) => {
        toast.error("Couldn't select the design frame", {
          description: errorMessage(error),
        });
      },
    );
  };

  /** Select one stable oid using cached details or the exact frame runtime. A
   * row in a dormant frame selects inside that frame, switching to it. */
  const chooseLayer = (
    frame: DesignCanvasFrameWire,
    layer: FlatDesignLayer,
    additive = false,
  ) => {
    if (!workspaceId || !folder) return;
    const selection = additive
      ? toggleDesignNodeSelection({
          workspaceId,
          folder,
          frame,
          nodeId: layer.node.oid,
        })
      : selectDesignNode({
          workspaceId,
          folder,
          frame,
          nodeId: layer.node.oid,
        });
    void selection.catch((error) => {
      toast.error("Couldn't select the design layer", {
        description: errorMessage(error),
      });
    });
  };

  const toggleVisibility = (
    frame: DesignCanvasFrameWire,
    layer: FlatDesignLayer,
  ) => {
    if (!workspaceId || !folder) return;
    void setDesignNodeVisibility({
      workspaceId,
      folder,
      frame: frame.file,
      sourceVersion: frame.sourceVersion,
      nodeId: layer.node.oid,
      visible: !layer.node.visible,
    }).catch((error) => {
      toast.error("Couldn't change layer visibility", {
        description: errorMessage(error),
      });
    });
  };

  /** The row above a layer at depth 0 is its frame row, so ArrowLeft climbs out
   * of a frame's contents the same way it climbs out of a container. */
  const parentRowIndex = (index: number): number => {
    const row = panelRows[index];
    if (row?.kind !== "layer") return -1;
    const parentKey = row.layer.parentOid
      ? layerRowKey(row.frame.file, row.layer.parentOid)
      : frameRowKey(row.frame.file);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (panelRows[cursor]?.key === parentKey) return cursor;
    }
    return -1;
  };

  /** Desktop tree conventions: arrows navigate; Tab exits the composite. */
  const handleRowKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const row = panelRows[index];
    if (!row) return;
    const focusRow = (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= panelRows.length) return;
      event.preventDefault();
      revealRowAtIndex(nextIndex, true);
    };

    if (event.key === "ArrowDown") return focusRow(index + 1);
    if (event.key === "ArrowUp") return focusRow(index - 1);
    if (event.key === "Home") return focusRow(0);
    if (event.key === "End") return focusRow(panelRows.length - 1);

    if (row.kind === "frame") {
      if (event.key === "ArrowRight") {
        if (row.discloses && !row.expanded) {
          event.preventDefault();
          toggleFrameTree(row.frame);
        } else if (row.expanded) {
          focusRow(index + 1);
        }
        return;
      }
      if (event.key === "ArrowLeft" && row.expanded) {
        event.preventDefault();
        toggleFrameTree(row.frame);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        chooseFrame(row.frame);
      }
      return;
    }
    if (row.kind !== "layer") return;

    const { frame, layer } = row;
    if (event.key === "ArrowRight" && layer.hasChildren) {
      if (!row.expanded) {
        event.preventDefault();
        toggleExpanded(row);
      } else {
        focusRow(index + 1);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      if (row.expanded) {
        event.preventDefault();
        toggleExpanded(row);
        return;
      }
      focusRow(parentRowIndex(index));
      return;
    }
    if (event.shiftKey && event.key.toLocaleLowerCase() === "h") {
      event.preventDefault();
      toggleVisibility(frame, layer);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseLayer(frame, layer);
    }
  };

  const rovingRowKey = designLayerRovingTabStop(
    renderedRows.map((row) => row.key),
    selectedFrame && selectedNodeId
      ? layerRowKey(selectedFrame.file, selectedNodeId)
      : null,
  );
  const headingId = `${panelId}-heading`;

  return (
    <section
      id={panelId}
      data-design-sidebar-panel=""
      className="bg-bg1 text-3xxs flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-labelledby={headingId}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <h2 id={headingId} className="text-fg1 text-3xxs font-medium">
          Layers
        </h2>
        {selectedNodeIds.length > 1 ? (
          <span className="zd-design-layer-selection-count text-3xxs rounded px-1.5 py-0.5 font-medium">
            {selectedNodeIds.length} selected
          </span>
        ) : null}
        <Tooltip label="Collapse all layers">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Collapse all layers"
            // Anything open anywhere counts, including containers inside a frame
            // the user has since folded — one click closes the whole workspace.
            disabled={!hasExpandedLayers}
            onClick={() => {
              if (!workspaceId) return;
              collapseAllDesignLayers(workspaceId);
            }}
          >
            <ListCollapse />
          </Button>
        </Tooltip>
      </div>

      {/* Rows sit flush: a selection and everything it owns must read as one
          uninterrupted fill, so no gap may cut through the block. */}
      <ScrollArea ref={scrollAreaRef} className="min-h-0 min-w-0 flex-1">
        <div className="flex min-w-0 flex-col px-1 py-1">
          <div
            ref={treeRef}
            role="tree"
            aria-label="Design layers"
            className={cn(
              "min-w-0",
              virtualizedLayers ? "relative" : "flex flex-col",
            )}
            style={
              virtualizedLayers
                ? { height: panelRows.length * DESIGN_LAYER_ROW_HEIGHT }
                : undefined
            }
          >
            <div
              role="none"
              className={cn(
                "flex min-w-0 flex-col",
                virtualizedLayers && "absolute inset-x-0 top-0",
              )}
              style={
                virtualizedLayers
                  ? {
                      transform: `translateY(${layerWindow.start * DESIGN_LAYER_ROW_HEIGHT}px)`,
                    }
                  : undefined
              }
            >
              {renderedRows.map((row, windowIndex) => {
                const rowIndex =
                  (virtualizedLayers ? layerWindow.start : 0) + windowIndex;
                const blockRadius = designLayerBlockRadius(
                  blockEdges[rowIndex] ?? null,
                );
                if (row.kind === "pending") {
                  const frameLabel = designFrameLayerLabel(row.frame.kind);
                  return (
                    <div
                      key={row.key}
                      role="none"
                      className="flex h-7 min-w-0 items-center"
                      style={{ paddingLeft: layerRowPadding(0) }}
                    >
                      <span className="text-muted-fg text-3xxs truncate">
                        Connecting to {frameLabel}…
                      </span>
                    </div>
                  );
                }
                if (row.kind === "frame") {
                  const { frame } = row;
                  const frameLabel = designFrameLayerLabel(frame.kind);
                  const activeFrame = selectedFrame?.file === frame.file;
                  // The frame row is "selected" only when the frame itself is
                  // the canvas selection target — merely showing its tree is
                  // not selection, mirroring Figma's frame rows.
                  const frameRowSelected =
                    activeFrame && frameSelected && !selectedNodeId;
                  return (
                    <Tooltip
                      key={row.key}
                      label={frameLabel}
                      side="right"
                      align="start"
                    >
                      <Button
                        type="button"
                        role="treeitem"
                        variant="ghost"
                        size="sm"
                        data-design-frame-row={frame.file}
                        data-design-panel-row={row.key}
                        className={cn(
                          "zd-design-layer-row text-3xxs h-7 w-full min-w-0 shrink-0 justify-start px-1 [&_svg]:size-3",
                          blockRadius,
                          frameRowSelected && "zd-design-layer-selected",
                        )}
                        tabIndex={rovingRowKey === row.key ? 0 : -1}
                        aria-level={1}
                        aria-selected={frameRowSelected}
                        aria-expanded={row.discloses ? row.expanded : undefined}
                        aria-keyshortcuts="Meta+C Control+C Meta+D Control+D Delete Backspace"
                        onClick={(event) => {
                          if (
                            row.discloses &&
                            (event.target as HTMLElement).closest(
                              "[data-layer-disclosure]",
                            )
                          ) {
                            toggleFrameTree(frame);
                            return;
                          }
                          chooseFrame(frame);
                        }}
                        onKeyDown={(event) => handleRowKeyDown(event, rowIndex)}
                      >
                        {row.discloses ? (
                          <span data-layer-disclosure="">
                            {row.expanded ? (
                              <ChevronDown aria-hidden="true" />
                            ) : (
                              <ChevronRight aria-hidden="true" />
                            )}
                          </span>
                        ) : (
                          <span className={DESIGN_LAYER_DISCLOSURE_SPACER} />
                        )}
                        {frame.kind === "text" ? (
                          <Type />
                        ) : (
                          <FrameLayoutIcon
                            kind={frameLayoutIconsByFile[frame.file] ?? "frame"}
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate text-left">
                          {frameLabel}
                        </span>
                      </Button>
                    </Tooltip>
                  );
                }

                const { frame, layer } = row;
                const activeFrame = selectedFrame?.file === frame.file;
                const selectedLayer =
                  activeFrame && selectedNodeIds.includes(layer.node.oid);
                // Descendants of the selection carry a softer tint; a selected
                // frame owns its whole tree. Ancestors stay untouched —
                // selection never bleeds upward.
                const inSelectionSubtree =
                  activeFrame &&
                  !selectedLayer &&
                  (frameSelected || selectionSubtreeIds.has(layer.node.oid));
                const hoveredLayer =
                  hoveredFrameFile === frame.file &&
                  hoveredNodeId === layer.node.oid;
                const displayName = designRuntimeLayerLabel(layer.node);
                const dimmed = !layer.node.visible || layer.hiddenByAncestor;
                return (
                  <div
                    key={row.key}
                    role="none"
                    data-design-layer-row={layer.node.oid}
                    className="group relative flex h-7 min-w-0 shrink-0 items-center"
                    onPointerEnter={() => {
                      if (!workspaceId || !folder) return;
                      void hoverDesignNode({
                        workspaceId,
                        folder,
                        frame: frame.file,
                        sourceVersion: frame.sourceVersion,
                        nodeId: layer.node.oid,
                      });
                    }}
                    onPointerLeave={() => {
                      if (!workspaceId || !folder) return;
                      void hoverDesignNode({
                        workspaceId,
                        folder,
                        frame: frame.file,
                        sourceVersion: frame.sourceVersion,
                        nodeId: null,
                      });
                    }}
                  >
                    <Tooltip label={displayName} side="right" align="start">
                      <Button
                        data-design-layer-select=""
                        data-design-layer-id={layer.node.oid}
                        data-design-panel-row={row.key}
                        type="button"
                        role="treeitem"
                        variant="ghost"
                        size="sm"
                        className={cn(
                          "zd-design-layer-row text-3xxs relative z-[1] h-7 min-w-0 flex-1 justify-start px-1 pr-6 [&_svg]:size-3",
                          blockRadius,
                          selectedLayer && "zd-design-layer-selected",
                          inSelectionSubtree && "zd-design-layer-in-selection",
                          hoveredLayer &&
                            !selectedLayer &&
                            "zd-design-layer-hovered",
                          dimmed && "zd-design-layer-dimmed",
                        )}
                        style={{
                          // The fill spans the panel; only the row's own
                          // content steps in, so a selection and everything it
                          // owns share one block edge.
                          paddingLeft: layerRowPadding(layer.depth),
                        }}
                        tabIndex={rovingRowKey === row.key ? 0 : -1}
                        aria-level={layer.depth + 2}
                        aria-selected={selectedLayer}
                        aria-expanded={
                          layer.hasChildren ? row.expanded : undefined
                        }
                        aria-keyshortcuts="Shift+H Meta+C Control+C Meta+D Control+D Delete Backspace"
                        onClick={(event) => {
                          if (
                            layer.hasChildren &&
                            (event.target as HTMLElement).closest(
                              "[data-layer-disclosure]",
                            )
                          ) {
                            toggleExpanded(row);
                            return;
                          }
                          chooseLayer(frame, layer, event.shiftKey);
                        }}
                        onKeyDown={(event) => handleRowKeyDown(event, rowIndex)}
                      >
                        {layer.hasChildren ? (
                          <span data-layer-disclosure="">
                            {row.expanded ? (
                              <ChevronDown aria-hidden="true" />
                            ) : (
                              <ChevronRight aria-hidden="true" />
                            )}
                          </span>
                        ) : (
                          <span className={DESIGN_LAYER_DISCLOSURE_SPACER} />
                        )}
                        <LayerTypeIcon
                          label={displayName}
                          display={layer.node.display}
                          flexDirection={layer.node.flexDirection}
                        />
                        <span className="min-w-0 flex-1 truncate text-left">
                          {displayName}
                        </span>
                      </Button>
                    </Tooltip>
                    <Tooltip
                      label={
                        layer.node.visible
                          ? "Hide on canvas · ⇧H"
                          : "Show on canvas · ⇧H"
                      }
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className={cn(
                          "absolute top-1/2 right-0.5 z-[2] size-6 -translate-y-1/2",
                          layer.node.visible
                            ? "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                            : "text-muted-fg",
                        )}
                        tabIndex={-1}
                        aria-label={`${layer.node.visible ? "Hide" : "Show"} ${displayName}`}
                        onClick={() => toggleVisibility(frame, layer)}
                      >
                        {layer.node.visible ? <Eye /> : <EyeClosed />}
                      </Button>
                    </Tooltip>
                  </div>
                );
              })}
            </div>
          </div>
          {!snapshot.data && snapshot.loading ? (
            <span className="text-muted-fg text-3xxs px-2 py-2">
              Loading layers…
            </span>
          ) : null}
          {!snapshot.data && snapshot.error ? (
            <div className="flex flex-col items-start gap-2 px-2 py-2">
              <span className="text-muted-fg text-3xxs">
                Couldn’t load layers.
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="text-3xxs"
                onClick={snapshot.refresh}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {snapshot.data?.frames.length === 0 ? (
            <span className="text-muted-fg text-3xxs px-2 py-2">
              Create a frame from the canvas toolbar to start designing.
            </span>
          ) : null}
        </div>
      </ScrollArea>
    </section>
  );
}
