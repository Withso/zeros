// ============================================
// COMPONENT: DesignWorkspaceSidebarPanels
// PURPOSE: Workspace-owned Layers and Assets panels beneath the unchanged chat
// USED IN: Column2Workspace for design workspaces
// ============================================

// --- IMPORTS ---

import React, { useMemo, useRef } from "react";
import {
  ChevronRight,
  Eye,
  EyeOff,
  FileCode2,
  Image,
  Layers3,
} from "lucide-react";

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
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  toast,
} from "../ui/primitives";
import {
  flattenDesignLayerTree,
  type FlatDesignLayer,
} from "./design-layer-tree";
import { DESIGN_ASSET_DRAG_TYPE } from "./design-assets";

// --- TYPES ---

interface DesignWorkspaceSidebarPanelsProps {
  /** Hidden retained workspace shells keep their reads and controls inert. */
  surfaceActive: boolean;
}

// --- WORKFLOWS ---

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The layer action failed.";
}

function DesignFramePreview({
  workspaceId,
  frame,
}: {
  workspaceId: string | null;
  frame: string;
}) {
  const thumbnail = useDesignRuntimeStore((state) =>
    workspaceId
      ? state.byWorkspace[workspaceId]?.frames[frame]?.screenshotsByNode[""]
      : undefined,
  );
  return thumbnail ? (
    <img
      src={thumbnail.dataUrl}
      alt=""
      className="size-8 shrink-0 object-cover"
    />
  ) : (
    <FileCode2 />
  );
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
  const panel = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.panel ?? "layers")
      : "layers",
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
  const setPanel = useDesignWorkspaceUiStore((state) => state.setPanel);
  const selectedFrame =
    snapshot.data?.frames.find((frame) => frame.file === selectedFrameFile) ??
    snapshot.data?.frames[0] ??
    null;
  const runtimeSnapshot = useDesignRuntimeStore((state) =>
    workspaceId && selectedFrame
      ? state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.snapshot
      : undefined,
  );
  const flattenedLayers = useMemo(
    () => flattenDesignLayerTree(runtimeSnapshot?.tree ?? []),
    [runtimeSnapshot?.tree],
  );
  // Scopes roving keyboard traversal to this one selected frame tree.
  const treeRef = useRef<HTMLDivElement | null>(null);

  if (!isDesign) return null;

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

  /** Tab/arrow traversal remains within the tree; Shift+Enter selects parent. */
  const handleLayerKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    layer: FlatDesignLayer,
  ) => {
    if (event.key === "Enter" && event.shiftKey && layer.parentOid) {
      const parent = flattenedLayers.find(
        (candidate) => candidate.node.oid === layer.parentOid,
      );
      if (parent) {
        event.preventDefault();
        chooseLayer(parent);
      }
      return;
    }
    const direction =
      event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)
        ? 1
        : event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)
          ? -1
          : 0;
    if (direction === 0) return;
    const rows = Array.from(
      treeRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-design-layer-select]",
      ) ?? [],
    );
    const index = rows.indexOf(event.currentTarget);
    const next = rows[index + direction];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <section
      className="border-border1 bg-bg1 flex h-52 shrink-0 flex-col overflow-hidden border-t"
      aria-label="Design workspace panels"
    >
      <Tabs
        value={panel}
        onValueChange={(value) => {
          if (!workspaceId || (value !== "layers" && value !== "assets")) {
            return;
          }
          setPanel(workspaceId, value);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="shrink-0 px-2 pt-2">
          <TabsList className="h-7">
            <TabsTrigger value="layers" className="h-5 gap-1.5 px-2 text-xs">
              <Layers3 />
              Layers
            </TabsTrigger>
            <TabsTrigger value="assets" className="h-5 gap-1.5 px-2 text-xs">
              <Image />
              Assets
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="layers"
          className="mt-0 min-h-0 flex-1 overflow-hidden"
        >
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-1 p-2">
              {snapshot.data?.frames.map((frame) => {
                const selected = selectedFrame?.file === frame.file;
                return (
                  <React.Fragment key={frame.file}>
                    <Button
                      type="button"
                      variant={selected ? "secondary-on" : "ghost"}
                      size="sm"
                      onClick={() => chooseFrame(frame)}
                    >
                      <DesignFramePreview
                        workspaceId={workspaceId}
                        frame={frame.file}
                      />
                      <span className="max-w-40 truncate">{frame.title}</span>
                      <span className="text-fg3">{frame.file}</span>
                    </Button>

                    {selected ? (
                      <div
                        ref={treeRef}
                        role="tree"
                        aria-label={`${frame.title} layers`}
                        className="flex flex-col gap-1"
                      >
                        {flattenedLayers.map((layer) => (
                          <div
                            key={layer.node.oid}
                            role="treeitem"
                            aria-level={layer.depth + 1}
                            aria-selected={selectedNodeId === layer.node.oid}
                            className="flex min-w-0 items-center gap-1"
                            style={{
                              paddingLeft: 8 + layer.depth * 12,
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
                            <Button
                              data-design-layer-select
                              type="button"
                              variant={
                                selectedNodeId === layer.node.oid
                                  ? "secondary-on"
                                  : "ghost"
                              }
                              size="sm"
                              className="min-w-0 flex-1 justify-start"
                              onClick={() => chooseLayer(layer)}
                              onKeyDown={(event) =>
                                handleLayerKeyDown(event, layer)
                              }
                            >
                              <ChevronRight />
                              <span className="truncate">
                                {layer.node.name}
                              </span>
                              <span className="text-fg3">{layer.node.tag}</span>
                            </Button>
                            <Tooltip
                              label={
                                layer.node.visible
                                  ? "Hide on canvas"
                                  : "Show on canvas"
                              }
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`${layer.node.visible ? "Hide" : "Show"} ${layer.node.name}`}
                                onClick={() => {
                                  if (!workspaceId || !folder) return;
                                  void setDesignNodeVisibility({
                                    workspaceId,
                                    folder,
                                    frame: frame.file,
                                    sourceVersion: frame.sourceVersion,
                                    nodeId: layer.node.oid,
                                    visible: !layer.node.visible,
                                  }).catch((error) => {
                                    toast.error(
                                      "Couldn't change layer visibility",
                                      { description: errorMessage(error) },
                                    );
                                  });
                                }}
                              >
                                {layer.node.visible ? <Eye /> : <EyeOff />}
                              </Button>
                            </Tooltip>
                          </div>
                        ))}
                        {!runtimeSnapshot ? (
                          <span className="text-fg3 px-2 py-1 text-xs">
                            Loading live layers…
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </React.Fragment>
                );
              })}
              {!snapshot.data && snapshot.loading ? (
                <span className="text-fg3 px-2 py-1 text-xs">
                  Loading frames…
                </span>
              ) : null}
              {snapshot.data?.frames.length === 0 ? (
                <span className="text-fg3 px-2 py-1 text-xs">
                  Create a frame from the canvas toolbar.
                </span>
              ) : null}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent
          value="assets"
          className="mt-0 min-h-0 flex-1 overflow-hidden"
        >
          <ScrollArea className="h-full">
            <div className="grid grid-cols-2 gap-2 p-2">
              {snapshot.data?.assets.map((asset) => (
                <button
                  key={asset.path}
                  type="button"
                  draggable
                  className="border-border2 bg-bg1 hover:bg-bg2-hover flex min-w-0 flex-col gap-1 rounded-md border p-2 text-left"
                  title={`Drag ${asset.name} into a frame`}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData(
                      DESIGN_ASSET_DRAG_TYPE,
                      asset.path,
                    );
                  }}
                >
                  {asset.dataUrl ? (
                    <img
                      src={asset.dataUrl}
                      alt=""
                      className="bg-bg2 h-16 w-full object-contain"
                    />
                  ) : (
                    <span className="bg-bg2 text-fg3 flex h-16 w-full items-center justify-center">
                      <Image />
                    </span>
                  )}
                  <span className="text-fg1 w-full truncate text-xs">
                    {asset.name}
                  </span>
                  <span className="text-fg3 text-xs">
                    {Math.max(1, Math.round(asset.size / 1_024))} KB
                  </span>
                </button>
              ))}
              {snapshot.data?.assets.length === 0 ? (
                <div className="text-fg3 col-span-2 flex h-24 flex-col items-center justify-center gap-2 px-4 text-center text-xs">
                  <Image />
                  Add images under Zeros Design/assets, then drag them into a
                  frame.
                </div>
              ) : null}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </section>
  );
}
