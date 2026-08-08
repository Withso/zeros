// ============================================
// COMPONENT: DesignWorkspaceSidebarPanels
// PURPOSE: Searchable, collapsible Layers tree for the native design sidebar
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
  Box,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Frame,
  Image,
  ListCollapse,
  Search,
  Type,
  X,
} from "lucide-react";
import type { DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import type { DesignOperation, DesignTransaction } from "@zeros/design-core";

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
import { useDesignFoundation } from "./state/use-design-foundation";
import { applyDesignTransactionCached } from "./state/design-workspace-cache";
import { useDesignWorkspaceUiStore } from "./state/design-workspace-ui";
import { usePendingWorkspaceKind } from "../../state/pending-workspaces";
import { resolveWorkspacePresentationKind } from "../../state/workspace-resolution";
import {
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  ScrollArea,
  Tooltip,
  toast,
} from "../../shared/ui/primitives";
import { cn } from "../../shared/ui/cn";
import {
  collectDesignLayerParentIds,
  designLayerAncestorIds,
  designLayerRevealWindow,
  designLayerRovingTabStop,
  designLayerVirtualWindow,
  flattenDesignLayerTree,
  type FlatDesignLayer,
} from "./design-layer-tree";

// --- TYPES ---

interface DesignWorkspaceSidebarPanelsProps {
  /** Hidden retained workspace shells keep their reads and controls inert. */
  surfaceActive: boolean;
}

interface CollapsedLayerState {
  ownerKey: string | null;
  ids: ReadonlySet<string>;
}

interface LayerSearchState {
  ownerKey: string | null;
  value: string;
}

interface LayerWindowState {
  ownerKey: string | null;
  count: number;
  start: number;
  end: number;
}

const EMPTY_LAYER_TREE: readonly DesignRuntimeTreeNode[] = Object.freeze([]);
const EMPTY_SELECTED_NODE_IDS: readonly string[] = Object.freeze([]);
const DESIGN_LAYER_ROW_HEIGHT = 28;

// --- WORKFLOWS ---

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The layer action failed.";
}

function LayerTypeIcon({ tag }: { tag: string }) {
  const normalized = tag.toLocaleLowerCase();
  if (["img", "picture", "video", "canvas"].includes(normalized)) {
    return <Image aria-hidden="true" />;
  }
  if (
    [
      "p",
      "span",
      "label",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
    ].includes(normalized)
  ) {
    return <Type aria-hidden="true" />;
  }
  return <Box aria-hidden="true" />;
}

function layerDisplayName(layer: FlatDesignLayer): string {
  const name = layer.node.name.trim();
  return name || layer.node.tag;
}

// --- RENDER ---

export function DesignWorkspaceSidebarPanels({
  surfaceActive,
}: DesignWorkspaceSidebarPanelsProps) {
  const { workspace, folder } = useActiveWorkspace();
  const pendingKind = usePendingWorkspaceKind(folder);
  const isDesign =
    resolveWorkspacePresentationKind({
      confirmedKind: workspace?.kind,
      pendingKind,
      folder,
    }) === "design";
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
  const selectedFrame =
    snapshot.data?.frames.find((frame) => frame.file === selectedFrameFile) ??
    snapshot.data?.frames[0] ??
    null;
  const runtimeSnapshot = useDesignRuntimeStore((state) =>
    workspaceId && selectedFrame
      ? state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.snapshot
      : undefined,
  );
  const foundation = useDesignFoundation(
    workspaceId,
    selectedFrame?.file,
    selectedFrame?.sourceVersion,
    surfaceActive && isDesign && Boolean(selectedFrame),
  );
  const layerTree = runtimeSnapshot?.tree ?? EMPTY_LAYER_TREE;
  const ownerKey =
    workspaceId && selectedFrame
      ? `${workspaceId}\u0000${selectedFrame.file}`
      : null;
  const [searchState, setSearchState] = useState<LayerSearchState>({
    ownerKey: null,
    value: "",
  });
  // Search is an ephemeral draft; it must not leak from frame A into frame B.
  const query = searchState.ownerKey === ownerKey ? searchState.value : "";
  const [collapsedState, setCollapsedState] = useState<CollapsedLayerState>({
    ownerKey: null,
    ids: new Set(),
  });
  const [layerAction, setLayerAction] = useState<string | null>(null);
  const layerActionRef = useRef(false);
  const parentNodeIds = useMemo(
    () => collectDesignLayerParentIds(layerTree),
    [layerTree],
  );
  const selectedAncestors = useMemo(
    () => designLayerAncestorIds(layerTree, selectedNodeId),
    [layerTree, selectedNodeId],
  );
  const collapsedNodeIds = useMemo(() => {
    const base =
      collapsedState.ownerKey === ownerKey ? collapsedState.ids : parentNodeIds;
    if (selectedAncestors.length === 0) return base;
    const selectedPath = new Set(selectedAncestors);
    return new Set([...base].filter((nodeId) => !selectedPath.has(nodeId)));
  }, [collapsedState, ownerKey, parentNodeIds, selectedAncestors]);
  const flattenedLayers = useMemo(
    () =>
      flattenDesignLayerTree(layerTree, {
        collapsedNodeIds,
        query,
      }),
    [collapsedNodeIds, layerTree, query],
  );
  const totalLayerCount = useMemo(
    () => flattenDesignLayerTree(layerTree).length,
    [layerTree],
  );
  // One composite tab stop; arrows move among the visible tree rows.
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
        count: flattenedLayers.length,
        visibleTop: 0,
        viewportHeight: 840,
      }),
    [flattenedLayers.length],
  );
  const layerWindow =
    layerWindowState.ownerKey === ownerKey &&
    layerWindowState.count === flattenedLayers.length
      ? layerWindowState
      : { ownerKey, count: flattenedLayers.length, ...initialLayerWindow };
  const virtualizedLayers = flattenedLayers.length > 400;
  const renderedLayers = virtualizedLayers
    ? flattenedLayers.slice(layerWindow.start, layerWindow.end)
    : flattenedLayers;

  /** Track only the fixed-height slice intersecting the Radix viewport. */
  useLayoutEffect(() => {
    if (!surfaceActive || !ownerKey || !virtualizedLayers) return;
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
        count: flattenedLayers.length,
        visibleTop: viewportRect.top - treeRect.top,
        viewportHeight: viewport.clientHeight,
        rowHeight: DESIGN_LAYER_ROW_HEIGHT,
      });
      setLayerWindowState((current) =>
        current.ownerKey === ownerKey &&
        current.count === flattenedLayers.length &&
        current.start === next.start &&
        current.end === next.end
          ? current
          : {
              ownerKey,
              count: flattenedLayers.length,
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
  }, [flattenedLayers.length, ownerKey, surfaceActive, virtualizedLayers]);

  const revealLayerAtIndex = useCallback(
    (index: number, focus: boolean) => {
      const layer = flattenedLayers[index];
      if (!layer || !ownerKey) return;
      if (virtualizedLayers) {
        const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
          "[data-radix-scroll-area-viewport]",
        );
        const viewportHeight = viewport?.clientHeight || 840;
        setLayerWindowState((current) => {
          const currentWindow =
            current.ownerKey === ownerKey &&
            current.count === flattenedLayers.length
              ? current
              : initialLayerWindow;
          const next = designLayerRevealWindow({
            count: flattenedLayers.length,
            index,
            viewportHeight,
            current: currentWindow,
            rowHeight: DESIGN_LAYER_ROW_HEIGHT,
          });
          return current.ownerKey === ownerKey &&
            current.count === flattenedLayers.length &&
            current.start === next.start &&
            current.end === next.end
            ? current
            : { ownerKey, count: flattenedLayers.length, ...next };
        });
      }
      window.requestAnimationFrame(() => {
        const row = Array.from(
          treeRef.current?.querySelectorAll<HTMLButtonElement>(
            "[data-design-layer-select]",
          ) ?? [],
        ).find(
          (candidate) => candidate.dataset.designLayerId === layer.node.oid,
        );
        row?.scrollIntoView({ block: "nearest" });
        if (focus) row?.focus();
      });
    },
    [flattenedLayers, initialLayerWindow, ownerKey, virtualizedLayers],
  );

  /** Canvas selection reveals its complete path before the browser paints. */
  useLayoutEffect(() => {
    if (!ownerKey || selectedAncestors.length === 0) return;
    setCollapsedState((current) => {
      const base = current.ownerKey === ownerKey ? current.ids : parentNodeIds;
      const next = new Set(base);
      let changed = current.ownerKey !== ownerKey;
      for (const ancestorId of selectedAncestors) {
        if (next.delete(ancestorId)) changed = true;
      }
      return changed ? { ownerKey, ids: next } : current;
    });
  }, [ownerKey, parentNodeIds, selectedAncestors]);

  /** Keep an externally selected canvas layer inside the scroll viewport. */
  useLayoutEffect(() => {
    if (!selectedNodeId) return;
    const index = flattenedLayers.findIndex(
      (layer) => layer.node.oid === selectedNodeId,
    );
    if (index < 0) return;
    const row = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>(
        "[data-design-layer-id]",
      ) ?? [],
    ).find((candidate) => candidate.dataset.designLayerId === selectedNodeId);
    if (row) row.scrollIntoView({ block: "nearest" });
    else revealLayerAtIndex(index, false);
  }, [flattenedLayers, revealLayerAtIndex, selectedNodeId]);

  if (!isDesign) return null;

  /** Every collapse mutation starts from the current semantic frame owner. */
  const updateCollapsed = (update: (current: Set<string>) => Set<string>) => {
    if (!ownerKey) return;
    setCollapsedState((current) => {
      const base = new Set(
        current.ownerKey === ownerKey ? current.ids : parentNodeIds,
      );
      return { ownerKey, ids: update(base) };
    });
  };

  const toggleExpanded = (layer: FlatDesignLayer) => {
    if (!layer.hasChildren) return;
    updateCollapsed((current) => {
      if (current.has(layer.node.oid)) current.delete(layer.node.oid);
      else current.add(layer.node.oid);
      return current;
    });
  };

  /** Selection publication is immediate locally; engine/runtime reads finish off-path. */
  const chooseFrame = (frame: NonNullable<typeof selectedFrame>) => {
    if (!workspaceId) return;
    void selectDesignFrame(workspaceId, frame).catch((error) => {
      toast.error("Couldn't select the design frame", {
        description: errorMessage(error),
      });
    });
  };

  /** Select one stable oid using cached details or the exact frame runtime. */
  const chooseLayer = (layer: FlatDesignLayer, additive = false) => {
    if (!workspaceId || !folder || !selectedFrame) return;
    const selection = additive
      ? toggleDesignNodeSelection({
          workspaceId,
          folder,
          frame: selectedFrame,
          nodeId: layer.node.oid,
        })
      : selectDesignNode({
          workspaceId,
          folder,
          frame: selectedFrame,
          nodeId: layer.node.oid,
        });
    void selection.catch((error) => {
      toast.error("Couldn't select the design layer", {
        description: errorMessage(error),
      });
    });
  };

  const toggleVisibility = (layer: FlatDesignLayer) => {
    if (!workspaceId || !folder || !selectedFrame) return;
    void setDesignNodeVisibility({
      workspaceId,
      folder,
      frame: selectedFrame.file,
      sourceVersion: selectedFrame.sourceVersion,
      nodeId: layer.node.oid,
      visible: !layer.node.visible,
    }).catch((error) => {
      toast.error("Couldn't change layer visibility", {
        description: errorMessage(error),
      });
    });
  };

  const mutateLayer = async (
    action: "duplicate" | "delete",
    layer: FlatDesignLayer,
  ) => {
    const data = foundation.data;
    if (
      !workspaceId ||
      !folder ||
      !selectedFrame ||
      !data ||
      layerActionRef.current
    ) {
      return;
    }
    layerActionRef.current = true;
    setLayerAction(`${action}:${layer.node.oid}`);
    const suffix = crypto.randomUUID().slice(0, 8);
    const duplicateNodeId = `${layer.node.oid.slice(0, Math.max(1, 242 - suffix.length))}-copy-${suffix}`;
    try {
      const operation: DesignOperation =
        action === "duplicate"
          ? {
              operationId: `duplicate:${crypto.randomUUID()}`,
              type: "node.duplicate",
              nodeId: layer.node.oid,
              duplicateNodeId,
            }
          : {
              operationId: `delete:${crypto.randomUUID()}`,
              type: "node.delete",
              nodeId: layer.node.oid,
            };
      const transaction: DesignTransaction = {
        schemaVersion: 1,
        transactionId: `desktop:${crypto.randomUUID()}`,
        documentId: data.summary.documentId,
        baseRevision: data.summary.revision,
        actor: { kind: "human", id: "desktop" },
        intent: `${action === "duplicate" ? "Duplicate" : "Delete"} ${layerDisplayName(layer)}`,
        createdAt: Date.now(),
        operations: [operation],
      };
      const result = await applyDesignTransactionCached(
        workspaceId,
        selectedFrame.file,
        transaction,
      );
      if (action === "duplicate") {
        const currentFrame =
          result.snapshot?.frames.find(
            (candidate) => candidate.file === selectedFrame.file,
          ) ?? selectedFrame;
        await selectDesignFrame(workspaceId, currentFrame);
        void selectDesignNode({
          workspaceId,
          folder,
          frame: currentFrame,
          nodeId: duplicateNodeId,
        }).catch(() => {
          // The ready snapshot retries this semantic selection once the
          // replacement iframe owns the duplicate's new source generation.
        });
        toast.success("Layer duplicated");
      } else {
        const currentFrame =
          result.snapshot?.frames.find(
            (candidate) => candidate.file === selectedFrame.file,
          ) ?? selectedFrame;
        await selectDesignFrame(workspaceId, currentFrame);
        toast.success("Layer deleted");
      }
    } catch (error) {
      toast.error(`Couldn't ${action} the layer`, {
        description: errorMessage(error),
      });
    } finally {
      layerActionRef.current = false;
      setLayerAction(null);
    }
  };

  /** Desktop tree conventions: arrows navigate; Tab exits the composite. */
  const handleLayerKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    layer: FlatDesignLayer,
  ) => {
    const index = flattenedLayers.findIndex(
      (candidate) => candidate.node.oid === layer.node.oid,
    );
    const focusLayer = (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= flattenedLayers.length) return;
      event.preventDefault();
      revealLayerAtIndex(nextIndex, true);
    };

    if (event.key === "ArrowDown") return focusLayer(index + 1);
    if (event.key === "ArrowUp") return focusLayer(index - 1);
    if (event.key === "Home") return focusLayer(0);
    if (event.key === "End") return focusLayer(flattenedLayers.length - 1);
    const visuallyExpanded =
      layer.hasChildren &&
      (Boolean(query) || !collapsedNodeIds.has(layer.node.oid));
    if (event.key === "ArrowRight" && layer.hasChildren) {
      if (!visuallyExpanded) {
        event.preventDefault();
        toggleExpanded(layer);
      } else {
        focusLayer(index + 1);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      if (visuallyExpanded && !query) {
        event.preventDefault();
        toggleExpanded(layer);
        return;
      }
      const parentIndex = flattenedLayers.findIndex(
        (candidate) => candidate.node.oid === layer.parentOid,
      );
      focusLayer(parentIndex);
      return;
    }
    if (event.shiftKey && event.key.toLocaleLowerCase() === "h") {
      event.preventDefault();
      toggleVisibility(layer);
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      event.key.toLocaleLowerCase() === "d"
    ) {
      event.preventDefault();
      if (!event.repeat) void mutateLayer("duplicate", layer);
      return;
    }
    if (
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      (event.key === "Backspace" || event.key === "Delete")
    ) {
      event.preventDefault();
      if (!event.repeat) void mutateLayer("delete", layer);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseLayer(layer);
    }
  };

  const rovingTabStop = designLayerRovingTabStop(
    renderedLayers,
    selectedNodeId,
  );

  return (
    <section
      id="design-layers-panel"
      data-design-sidebar-panel=""
      className="bg-bg1 flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-labelledby="design-layers-heading"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 px-3">
        <h2 id="design-layers-heading" className="text-fg1 text-xs font-medium">
          Layers
        </h2>
        <span
          className="text-fg3 text-xs"
          aria-label={`${totalLayerCount} layers`}
        >
          {totalLayerCount}
        </span>
        <Tooltip label="Collapse all layers">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Collapse all layers"
            disabled={parentNodeIds.size === 0}
            onClick={() => {
              const selectedPath = new Set(selectedAncestors);
              updateCollapsed(
                () =>
                  new Set(
                    [...parentNodeIds].filter(
                      (nodeId) => !selectedPath.has(nodeId),
                    ),
                  ),
              );
            }}
          >
            <ListCollapse />
          </Button>
        </Tooltip>
      </div>

      <div className="shrink-0 px-2 pb-2">
        <InputGroup className="zd-design-search h-7">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            aria-label="Search layers"
            placeholder="Search layers"
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setSearchState({ ownerKey, value: "" });
              }
            }}
            onChange={(event) =>
              setSearchState({
                ownerKey,
                value: event.currentTarget.value,
              })
            }
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Clear layer search"
                onClick={() => setSearchState({ ownerKey, value: "" })}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>

      <ScrollArea ref={scrollAreaRef} className="min-h-0 min-w-0 flex-1">
        <div className="flex min-w-0 flex-col gap-px px-1 py-1">
          {snapshot.data?.frames.map((frame) => {
            const selected = selectedFrame?.file === frame.file;
            return (
              <React.Fragment key={frame.file}>
                <Tooltip
                  label={`${frame.title} · ${frame.file}`}
                  side="right"
                  align="start"
                >
                  <Button
                    type="button"
                    variant={selected ? "secondary-on" : "ghost"}
                    size="sm"
                    className={cn(
                      "zd-design-control-quiet h-7 w-full min-w-0 justify-start rounded-md px-2",
                      selected && "zd-design-state-active",
                    )}
                    onClick={() => chooseFrame(frame)}
                  >
                    <Frame />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {frame.title}
                    </span>
                  </Button>
                </Tooltip>

                {selected ? (
                  <div
                    ref={treeRef}
                    role="tree"
                    aria-label={`${frame.title} layers`}
                    className={cn(
                      "min-w-0",
                      virtualizedLayers ? "relative" : "flex flex-col",
                    )}
                    style={
                      virtualizedLayers
                        ? {
                            height:
                              flattenedLayers.length * DESIGN_LAYER_ROW_HEIGHT,
                          }
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
                      {renderedLayers.map((layer) => {
                        const selectedLayer = selectedNodeIds.includes(
                          layer.node.oid,
                        );
                        const expanded =
                          layer.hasChildren &&
                          (Boolean(query) ||
                            !collapsedNodeIds.has(layer.node.oid));
                        const displayName = layerDisplayName(layer);
                        const showTag =
                          displayName.toLocaleLowerCase() !==
                          layer.node.tag.toLocaleLowerCase();
                        return (
                          <div
                            key={layer.node.oid}
                            role="none"
                            className="group flex h-7 min-w-0 items-center"
                            style={{
                              paddingLeft: 2 + Math.min(layer.depth, 16) * 12,
                            }}
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
                            <Tooltip
                              label={`${displayName} · ${layer.node.tag}`}
                              side="right"
                              align="start"
                            >
                              <Button
                                data-design-layer-select=""
                                data-design-layer-id={layer.node.oid}
                                type="button"
                                role="treeitem"
                                variant={
                                  selectedLayer ? "secondary-on" : "ghost"
                                }
                                size="sm"
                                className={cn(
                                  "zd-design-control-quiet h-7 min-w-0 flex-1 justify-start rounded-md px-1 text-[11px] [&_svg]:size-3",
                                  selectedLayer && "zd-design-state-active",
                                )}
                                tabIndex={
                                  rovingTabStop === layer.node.oid ? 0 : -1
                                }
                                aria-level={layer.depth + 1}
                                aria-selected={selectedLayer}
                                aria-expanded={
                                  layer.hasChildren ? expanded : undefined
                                }
                                aria-keyshortcuts="Shift+H Meta+D Control+D Delete Backspace"
                                onClick={(event) => {
                                  if (
                                    layer.hasChildren &&
                                    !query &&
                                    (event.target as HTMLElement).closest(
                                      "[data-layer-disclosure]",
                                    )
                                  ) {
                                    toggleExpanded(layer);
                                    return;
                                  }
                                  chooseLayer(layer, event.shiftKey);
                                }}
                                onKeyDown={(event) =>
                                  handleLayerKeyDown(event, layer)
                                }
                              >
                                {layer.hasChildren ? (
                                  <span
                                    data-layer-disclosure={
                                      query ? undefined : ""
                                    }
                                  >
                                    {expanded ? (
                                      <ChevronDown aria-hidden="true" />
                                    ) : (
                                      <ChevronRight aria-hidden="true" />
                                    )}
                                  </span>
                                ) : (
                                  <span className="size-4 shrink-0" />
                                )}
                                <LayerTypeIcon tag={layer.node.tag} />
                                <span className="min-w-0 flex-1 truncate text-left">
                                  {displayName}
                                </span>
                                {showTag ? (
                                  <span className="text-fg3 max-w-[32%] shrink-0 truncate font-mono text-[9px]">
                                    {layer.node.tag}
                                  </span>
                                ) : null}
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
                                disabled={layerAction !== null}
                                className={
                                  layer.node.visible
                                    ? "invisible shrink-0 group-focus-within:visible group-hover:visible"
                                    : "shrink-0"
                                }
                                tabIndex={-1}
                                aria-label={`${layer.node.visible ? "Hide" : "Show"} ${displayName}`}
                                onClick={() => toggleVisibility(layer)}
                              >
                                {layer.node.visible ? <Eye /> : <EyeOff />}
                              </Button>
                            </Tooltip>
                          </div>
                        );
                      })}
                    </div>
                    {!runtimeSnapshot ? (
                      <span className="text-fg3 px-2 py-2 text-xs">
                        Connecting to the selected frame…
                      </span>
                    ) : null}
                    {runtimeSnapshot &&
                    query &&
                    flattenedLayers.length === 0 ? (
                      <span className="text-fg3 px-2 py-2 text-xs">
                        No layers match “{query}”.
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}
          {!snapshot.data && snapshot.loading ? (
            <span className="text-fg3 px-2 py-2 text-xs">Loading layers…</span>
          ) : null}
          {!snapshot.data && snapshot.error ? (
            <div className="flex flex-col items-start gap-2 px-2 py-2">
              <span className="text-fg3 text-xs">Couldn’t load layers.</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={snapshot.refresh}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {snapshot.data?.frames.length === 0 ? (
            <span className="text-fg3 px-2 py-2 text-xs">
              Create a frame from the canvas toolbar to start designing.
            </span>
          ) : null}
        </div>
      </ScrollArea>
    </section>
  );
}
