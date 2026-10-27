// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas with a secondary directory toolbar, floating
//          tool rail, and attached Layers + Inspector panel
// USED IN: DesignWorkbenchSurface (the workbench's Design tab)
// ============================================

// --- IMPORTS ---

import { takeDesignSyncAgentRequest } from "../../state/design-sync-intent";
import { designSyncBrief } from "./design-agent-brief";
import { useAskDesignAgent } from "./design-agent-sync";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import "./design-workspace-ui.css";

import { designSelectPage, type DesignCanvasFrameWire } from "../../platform/git";
import { useThemeId } from "../../shared/theme/use-theme-variant";
import { toast } from "../../shared/ui/primitives";
import { clearWorkspaceSettling } from "../../state/pending-workspaces";
import { useDocumentActive } from "../../state/use-document-active";
import { resolveDesignCanvasDefaultBackground } from "./design-canvas-background";
import { type DesignMotionPropertyRequest } from "./design-motion-timeline";
import { useDesignRuntimeStore } from "./state/design-runtime-store";
import { selectDesignFrame, selectDesignTargets } from "./state/design-selection";
import { deleteDesignFrameCached, waitForPendingDesignEdits } from "./state/design-workspace-cache";
import {
  bindDesignWorkspacePages,
  captureDesignPageOwner,
  designWorkspaceView,
  isCurrentDesignPageOwner,
  useDesignWorkspaceUiStore,
} from "./state/design-workspace-ui";
import { useDesignPageSnapshot } from "./state/design-page-projection";
import { useDesignStyleBuildPresence } from "./state/use-design-style-build-presence";
import { startDesignAgentDraftEvents } from "./state/design-agent-drafts";
import { useDesignWorkspaceSnapshot } from "./state/use-design-workspace";
import { useDesignLifecycleFeedback } from "./state/use-design-lifecycle-feedback";

import { DesignCanvas, EMPTY_NODE_IDS } from "./design-canvas";
import { DesignSavedEditingContext, DesignSavedEditingSession } from "./design-saved-editing";
import { DesignDirectoryPill } from "./design-directory-pill";
import { DesignFloatingPanel } from "./design-floating-panel";
import { DesignInspector } from "./design-inspector";
import type { DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import { errorMessage } from "./design-workspace-error";
import { DesignWorkspaceSidebarPanels } from "./design-workspace-sidebar-panels";
import {
  type DesignCanvasZoomActions,
  type DesignWorkspaceColumnProps,
} from "./design-workspace-types";


// --- CONSTANTS ---

const DESIGN_COLUMN_CLS =
  "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg1";

function isDesignTreeSelection(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("[data-design-frame-row], [data-design-layer-id]");
}

/** ⌘\ / Ctrl+\ puts the properties panel away and brings it back. */
function isDesignPanelToggleShortcut(event: KeyboardEvent): boolean {
  return (
    event.key === "\\" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing &&
    !event.repeat
  );
}

// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Canvas and inspector inside the shared workbench's Design tab
// USED IN: DesignWorkbenchSurface and the standalone interaction harness
// ============================================

// --- STATE ---

export function DesignWorkspaceColumn({
  workspace,
  folder,
  surfaceActive: tabActive,
}: DesignWorkspaceColumnProps) {
  // A selected tab can outlive its visible native window. Suspend optional
  // work at the shared boundary while caches and protected edits retain their
  // existing ownership; showing the app must not activate a hidden tab.
  const surfaceActive = useDocumentActive(tabActive);
  const [motionTimelineOpen, setMotionTimelineOpen] = useState(false);
  const [motionPropertyRequest, setMotionPropertyRequest] =
    useState<DesignMotionPropertyRequest | null>(null);
  const [motionProperties, setMotionProperties] =
    useState<readonly string[]>(EMPTY_NODE_IDS);
  const deletingFrameFilesRef = useRef(new Set<string>());
  const motionPropertyRequestIdRef = useRef(0);
  const zoomActionsRef = useRef<DesignCanvasZoomActions | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const workspaceId = workspace?.id ?? null;
  // Serialized names predate the floating panel: `inspectorVisible` now puts
  // the whole Layers + Inspector panel away, `layersVisible` folds its Layers.
  const panelVisible = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.inspectorVisible ?? true)
      : true,
  );
  const layersExpanded = useDesignWorkspaceUiStore((state) =>
    workspaceId
      ? (state.byWorkspace[workspaceId]?.layersVisible ?? true)
      : true,
  );
  const snapshot = useDesignWorkspaceSnapshot(
    workspaceId,
    folder,
    surfaceActive,
  );
  // Keeps the person's style builds live while this Design tab is showing.
  useDesignStyleBuildPresence(workspaceId, surfaceActive);
  // Local agents' in-flight Design edits stream onto the canvas as drafts.
  useEffect(() => startDesignAgentDraftEvents(), []);
  // "Create and ask agent to sync styles": once the new directory has loaded,
  // a new chat with the person's default agent sets up syncing.
  const askAgent = useAskDesignAgent(folder);
  const loadedDirectory = snapshot.data?.directory ?? null;
  const loadedSources = snapshot.data?.styleSources;
  useEffect(() => {
    if (!workspaceId || !surfaceActive || !loadedDirectory) return;
    if (!takeDesignSyncAgentRequest(workspaceId)) return;
    askAgent(designSyncBrief(loadedDirectory, loadedSources ?? []));
  }, [askAgent, loadedDirectory, loadedSources, surfaceActive, workspaceId]);
  useDesignLifecycleFeedback(
    workspaceId,
    surfaceActive,
    snapshot.error,
    !!snapshot.data,
    snapshot.loading || snapshot.refreshing,
  );
  const activePageId = useDesignWorkspaceUiStore(state =>
    workspaceId ? state.byWorkspace[workspaceId]?.activePageId : undefined,
  );
  const pageSnapshot = useDesignPageSnapshot(snapshot.data, activePageId);
  const ownerRevision = useDesignWorkspaceUiStore(state => workspaceId ? state.byWorkspace[workspaceId]?.ownerRevision ?? 0 : 0);
  const pageOwner = useMemo(() => workspaceId ? { workspaceId, directoryId: pageSnapshot?.directoryId, pageId: activePageId, revision: ownerRevision } : undefined,
    [workspaceId, activePageId, pageSnapshot?.directoryId, ownerRevision]);
  const savedEditingFolderRef = useRef(folder);
  savedEditingFolderRef.current = folder;
  const savedEditing = useMemo(() => {
    return new DesignSavedEditingSession(() => surfaceActive && savedEditingFolderRef.current === folder && !!pageOwner && isCurrentDesignPageOwner(pageOwner));
  }, [surfaceActive, folder, pageOwner]);
  const pointerInsideRef = useRef(false);
  const savedEditingState = useSyncExternalStore(savedEditing.subscribe, savedEditing.snapshot, savedEditing.snapshot);
  useLayoutEffect(() => {
    savedEditing.activate();
    return () => savedEditing.retire();
  }, [savedEditing]);
  useLayoutEffect(() => workspaceId
    ? savedEditing.registerDrain(() => waitForPendingDesignEdits(workspaceId))
    : undefined, [savedEditing, workspaceId]);
  useLayoutEffect(() => {
    if (!surfaceActive || !workspaceId || !pageSnapshot || snapshot.loading || snapshot.refreshing || snapshot.error) return;
    bindDesignWorkspacePages(workspaceId, pageSnapshot.directoryId, pageSnapshot.pages!);
  }, [surfaceActive, workspaceId, pageSnapshot, snapshot.loading, snapshot.refreshing, snapshot.error]);
  useEffect(() => {
    if (!surfaceActive || !workspaceId || !activePageId || !pageSnapshot?.directoryId ||
      !pageSnapshot.pages?.some(page => page.id === activePageId)) return;
    void designSelectPage(workspaceId, pageSnapshot.directoryId, activePageId).catch(() => {});
  }, [surfaceActive, workspaceId, pageSnapshot?.directoryId, pageSnapshot?.pages, activePageId]);
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
      setCanvasBackground(workspaceId, value, pageOwner);
    },
    [setCanvasBackground, workspaceId, pageOwner],
  );
  const deleteFrame = useCallback(
    async (candidate: DesignCanvasFrameWire) => {
      if (!workspaceId || deletingFrameFilesRef.current.has(candidate.file)) {
        return;
      }
      deletingFrameFilesRef.current.add(candidate.file);
      const owner = captureDesignPageOwner(workspaceId);
      try {
        const next = await deleteDesignFrameCached(workspaceId, candidate.file);
        // Selection publishes locally before its durable bridge write. Do not
        // make that bookkeeping delay—or misreport—a completed deletion.
        if (!isCurrentDesignPageOwner(owner)) return;
        const targets = designWorkspaceView(workspaceId).selectedTargets.filter(target => target.frame !== candidate.file);
        if (targets.length) {
          void selectDesignTargets({ workspaceId, folder: folder ?? "", targets, frames: next.frames, owner, explicit: false }).catch(() => {});
        } else {
          void selectDesignFrame(workspaceId, next.frames.find(frame => frame.pageId === owner.pageId) ?? null, { owner, explicit: false }).catch(() => {});
        }
      } catch (deleteError) {
        toast.error("Couldn't delete the design frame", {
          description: errorMessage(deleteError),
        });
      } finally {
        deletingFrameFilesRef.current.delete(candidate.file);
      }
    },
    [workspaceId, folder],
  );

  // A frame revalidating its source keeps its last confirmed generation in the
  // inspector instead of dropping to an empty panel; edits stay engine-checked.
  const selectedFrame = useMemo(
    () => {
      const frames = designFrameViews(pageSnapshot);
      return designPresentedFrame(frames.find((frame) => frame.file === selectedFrameFile) ?? frames[0]);
    },
    [selectedFrameFile, pageSnapshot],
  );
  const selectedDetails = useDesignRuntimeStore((state) => {
    if (!workspaceId || !selectedFrame) return null;
    const runtimeFrame =
      state.byWorkspace[workspaceId]?.frames[selectedFrame.file];
    return selectedNodeId
      ? (runtimeFrame?.detailsByNode[selectedNodeId] ?? null)
      : (runtimeFrame?.snapshot?.frame ?? null);
  });

  // Until a new selection's exact details arrive, the inspector names the
  // selected layer from its frame's tree instead of reading as empty.
  const selectedFrameTree = useDesignRuntimeStore((state) =>
    workspaceId && selectedFrame
      ? state.byWorkspace[workspaceId]?.frames[selectedFrame.file]?.snapshot?.tree
      : undefined,
  );
  const selectedTreeNode = useMemo(() => {
    if (!selectedNodeId || !selectedFrameTree) return null;
    const pending: DesignRuntimeTreeNode[] = [...selectedFrameTree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.oid === selectedNodeId) return node;
      for (const child of node.children) pending.push(child);
    }
    return null;
  }, [selectedFrameTree, selectedNodeId]);

  // A freshly provisioned design surface is ready when its first exact-key
  // snapshot either resolves or fails open; code-only settling UI must not
  // remain latched for this folder.
  useEffect(() => {
    if (!workspace || !folder || (!snapshot.data && !snapshot.error)) return;
    clearWorkspaceSettling(folder);
  }, [folder, snapshot.data, snapshot.error, workspace]);

  useEffect(() => {
    setMotionTimelineOpen(false);
    setMotionPropertyRequest(null);
    setMotionProperties(EMPTY_NODE_IDS);
  }, [activePageId]);

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

  const togglePanel = useCallback(() => {
    if (!workspaceId) return;
    const store = useDesignWorkspaceUiStore.getState();
    const visible = store.byWorkspace[workspaceId]?.inspectorVisible ?? true;
    // Focus never stays behind in a panel that is being put away: it returns
    // to the canvas, where the keyboard keeps working.
    if (visible && panelRef.current?.contains(document.activeElement)) {
      sectionRef.current
        ?.querySelector<HTMLElement>("[data-design-canvas-viewport]")
        ?.focus({ preventScroll: true });
    }
    store.setPanels(workspaceId, { inspectorVisible: !visible });
  }, [workspaceId]);

  const setLayersExpanded = useCallback(
    (expanded: boolean) => {
      if (!workspaceId) return;
      useDesignWorkspaceUiStore
        .getState()
        .setPanels(workspaceId, { layersVisible: expanded });
    },
    [workspaceId],
  );

  // A visible Design surface owns the panel shortcut wherever its own focus
  // is (canvas, panel, pill) or when nothing holds focus; the conversation
  // column and other surfaces keep the chord.
  useEffect(() => {
    if (!surfaceActive || !workspaceId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isDesignPanelToggleShortcut(event)) return;
      const focused = document.activeElement;
      if (
        focused &&
        focused !== document.body &&
        !sectionRef.current?.contains(focused) &&
        focused.closest<HTMLElement>("[data-design-directory-workspace]")?.dataset.designDirectoryWorkspace !== workspaceId
      ) {
        return;
      }
      event.preventDefault();
      togglePanel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [surfaceActive, togglePanel, workspaceId]);

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
    <DesignSavedEditingContext.Provider value={savedEditing}>
    <section
      ref={sectionRef}
      {...(!surfaceActive ? { inert: "" } : {})}
      data-design-workspace-surface=""
      data-design-workspace-id={workspaceId ?? undefined}
      data-design-panel={panelVisible ? "open" : "closed"}
      data-design-saved-editing={savedEditingState === 0 ? "viewing" : savedEditingState === 1 ? "preparing" : "ready"}
      className={DESIGN_COLUMN_CLS}
      aria-label="Design workspace"
      onPointerMoveCapture={(event) => {
        if (isDesignTreeSelection(event.target) || !(event.target instanceof Element) || event.target.closest("[data-design-agent-activity]") ||
          !event.target.closest("[data-design-frame], [data-design-floating-panel]")) return;
        pointerInsideRef.current = true;
        savedEditing.enter();
      }}
      onPointerLeave={() => {
        pointerInsideRef.current = false;
        if (!sectionRef.current?.contains(document.activeElement)) savedEditing.leave();
      }}
      onFocusCapture={(event) => {
        if (isDesignTreeSelection(event.target)) return;
        if (!(event.target instanceof Element) || !event.target.closest("[data-design-agent-activity]")) savedEditing.enter();
      }}
      onBlurCapture={(event) => {
        if (!pointerInsideRef.current && !event.currentTarget.contains(event.relatedTarget)) savedEditing.leave();
      }}
      onPointerDownCapture={(event) => {
        if (event.button === 1 || isDesignTreeSelection(event.target)) return;
        if (event.target instanceof Element && event.target.closest("[data-design-agent-activity]")) {
          savedEditing.leave();
          return;
        }
        if (savedEditing.enter()) return;
        event.preventDefault();
        event.stopPropagation();
        toast.info("Saved source is still restoring. Try the edit again when the preview has cleared.");
      }}
      onClickCapture={(event) => {
        if (isDesignTreeSelection(event.target)) return;
        if (event.target instanceof Element && event.target.closest("[data-design-agent-activity]")) return;
        if (savedEditing.enter()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDownCapture={(event) => {
        if (isDesignTreeSelection(event.target) && ["Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        if (["Escape", "Tab", "Shift", "Control", "Alt", "Meta", " "].includes(event.key) || event.target instanceof Element && event.target.closest("[data-design-agent-activity]")) return;
        if (savedEditing.enter()) return;
        event.preventDefault();
        event.stopPropagation();
        toast.info("Saved source is still restoring. Try the edit again when the preview has cleared.");
      }}
    >
      {workspace ? (
        <DesignDirectoryPill
          workspace={workspace}
          active={surfaceActive}
          panelVisible={panelVisible}
          onTogglePanel={togglePanel}
        />
      ) : null}
      <div
        data-design-canvas-area=""
        className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        <DesignCanvas
          workspaceId={workspaceId}
          folder={folder}
          snapshot={pageSnapshot}
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
        <DesignFloatingPanel
          ref={panelRef}
          workspaceId={workspaceId}
          active={surfaceActive}
          visible={panelVisible}
          layersExpanded={layersExpanded}
          layers={
            <DesignWorkspaceSidebarPanels
              surfaceActive={surfaceActive && panelVisible}
              workspace={workspace}
              folder={folder}
              panelId={
                workspaceId
                  ? `design-layers-panel-${workspaceId}`
                  : "design-layers-panel"
              }
              expanded={layersExpanded}
              onExpandedChange={setLayersExpanded}
            />
          }
          inspector={
            <DesignInspector
              workspaceId={workspaceId}
              pages={pageSnapshot?.pages}
              activePageId={activePageId}
              pageFrames={designFrameViews(snapshot.data)}
              folder={folder}
              frame={selectedFrame}
              frameSelected={frameSelected}
              details={selectedDetails}
              selectedNode={selectedTreeNode}
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
          }
        />
      </div>
    </section>
    </DesignSavedEditingContext.Provider>
  );
}
import { designFrameViews, designPresentedFrame } from "./state/design-frame-view";
