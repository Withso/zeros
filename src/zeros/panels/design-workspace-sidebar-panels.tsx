// ============================================
// COMPONENT: DesignWorkspaceSidebarPanels
// PURPOSE: Searchable, collapsible Layers tree for the native design sidebar
// USED IN: DesignWorkspaceSidebar for design workspaces
// ============================================

// --- IMPORTS ---

import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
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
import type { DesignRuntimeTreeNode } from "@zeros/core/design-runtime";

import {
  hoverDesignNode,
  selectDesignFrame,
  selectDesignNode,
  setDesignNodeVisibility,
} from "../store/design-selection";
import { useDesignRuntimeStore } from "../store/design-runtime-store";
import { useActiveWorkspace } from "../store/use-active-workspace";
import { useDesignWorkspaceSnapshot } from "../store/use-design-workspace";
import { useDesignWorkspaceUiStore } from "../store/design-workspace-ui";
import { usePendingWorkspaceKind } from "../store/pending-workspaces";
import { resolveWorkspacePresentationKind } from "../store/workspace-resolution";
import {
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  ScrollArea,
  Tooltip,
  toast,
} from "../ui/primitives";
import {
  collectDesignLayerParentIds,
  designLayerAncestorIds,
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

const EMPTY_LAYER_TREE: readonly DesignRuntimeTreeNode[] = Object.freeze([]);

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
  const selectedFrame =
    snapshot.data?.frames.find((frame) => frame.file === selectedFrameFile) ??
    snapshot.data?.frames[0] ??
    null;
  const runtimeSnapshot = useDesignRuntimeStore((state) =>
    workspaceId && selectedFrame
      ? state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.snapshot
      : undefined,
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
  const treeRef = useRef<HTMLDivElement | null>(null);

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
    const row = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>(
        "[data-design-layer-id]",
      ) ?? [],
    ).find((candidate) => candidate.dataset.designLayerId === selectedNodeId);
    row?.scrollIntoView({ block: "nearest" });
  }, [flattenedLayers, selectedNodeId]);

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
  const chooseLayer = (layer: FlatDesignLayer) => {
    if (!workspaceId || !folder || !selectedFrame) return;
    void selectDesignNode({
      workspaceId,
      folder,
      frame: selectedFrame,
      nodeId: layer.node.oid,
    }).catch((error) => {
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

  /** Desktop tree conventions: arrows navigate; Tab exits the composite. */
  const handleLayerKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    layer: FlatDesignLayer,
  ) => {
    const rows = Array.from(
      treeRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-design-layer-select]",
      ) ?? [],
    );
    const index = rows.indexOf(event.currentTarget);
    const focusRow = (next: HTMLButtonElement | undefined) => {
      if (!next) return;
      event.preventDefault();
      next.focus();
    };

    if (event.key === "ArrowDown") return focusRow(rows[index + 1]);
    if (event.key === "ArrowUp") return focusRow(rows[index - 1]);
    if (event.key === "Home") return focusRow(rows[0]);
    if (event.key === "End") return focusRow(rows.at(-1));
    const visuallyExpanded =
      layer.hasChildren &&
      (Boolean(query) || !collapsedNodeIds.has(layer.node.oid));
    if (event.key === "ArrowRight" && layer.hasChildren) {
      if (!visuallyExpanded) {
        event.preventDefault();
        toggleExpanded(layer);
      } else {
        focusRow(rows[index + 1]);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      if (visuallyExpanded && !query) {
        event.preventDefault();
        toggleExpanded(layer);
        return;
      }
      const parent = rows.find(
        (candidate) => candidate.dataset.designLayerId === layer.parentOid,
      );
      focusRow(parent);
      return;
    }
    if (event.shiftKey && event.key.toLocaleLowerCase() === "h") {
      event.preventDefault();
      toggleVisibility(layer);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseLayer(layer);
    }
  };

  const selectedIsVisible = flattenedLayers.some(
    (layer) => layer.node.oid === selectedNodeId,
  );
  const rovingTabStop = selectedIsVisible
    ? selectedNodeId
    : (flattenedLayers[0]?.node.oid ?? null);

  return (
    <section
      id="design-layers-panel"
      data-design-sidebar-panel=""
      className="bg-bg1 flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-labelledby="design-layers-heading"
    >
        <div className="border-border1 flex h-10 shrink-0 items-center gap-2 border-b px-3">
          <h2
            id="design-layers-heading"
            className="text-fg1 text-xs font-medium"
          >
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

        <div className="border-border1 shrink-0 border-b p-2">
          <InputGroup className="h-7">
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

        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="flex min-w-0 flex-col gap-1 p-1">
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
                      className="w-full min-w-0 justify-start"
                      onClick={() => chooseFrame(frame)}
                    >
                      <Frame />
                      <span className="min-w-0 flex-1 truncate text-left">
                        {frame.title}
                      </span>
                      <span className="text-fg3 max-w-[40%] shrink-0 truncate text-xs">
                        {frame.file}
                      </span>
                    </Button>
                  </Tooltip>

                  {selected ? (
                    <div
                      ref={treeRef}
                      role="tree"
                      aria-label={`${frame.title} layers`}
                      className="flex min-w-0 flex-col"
                    >
                      {flattenedLayers.map((layer) => {
                        const selectedLayer = selectedNodeId === layer.node.oid;
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
                            className="group flex min-w-0 items-center"
                            style={{
                              paddingLeft: 4 + Math.min(layer.depth, 16) * 12,
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
                                className="min-w-0 flex-1 justify-start"
                                tabIndex={
                                  rovingTabStop === layer.node.oid ? 0 : -1
                                }
                                aria-level={layer.depth + 1}
                                aria-selected={selectedLayer}
                                aria-expanded={
                                  layer.hasChildren ? expanded : undefined
                                }
                                aria-keyshortcuts="Shift+H"
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
                                  chooseLayer(layer);
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
                                  <span className="text-fg3 max-w-[32%] shrink-0 truncate text-xs">
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
              <span className="text-fg3 px-2 py-2 text-xs">
                Loading layers…
              </span>
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
