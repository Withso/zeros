// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Live HTML/CSS canvas and structured design inspector
// USED IN: MainShellBody in place of the code workspace's Workbench
// ============================================

// --- IMPORTS ---

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./design-workspace-ui.css";

import { type DesignCanvasFrameWire } from "../../platform/git";
import { useThemeId } from "../../shared/theme/use-theme-variant";
import { toast } from "../../shared/ui/primitives";
import { clearWorkspaceSettling } from "../../state/pending-workspaces";
import { resolveDesignCanvasDefaultBackground } from "./design-canvas-background";
import { type DesignMotionPropertyRequest } from "./design-motion-timeline";
import { useDesignRuntimeStore } from "./state/design-runtime-store";
import { selectDesignFrame } from "./state/design-selection";
import { deleteDesignFrameCached } from "./state/design-workspace-cache";
import {
  useDesignWorkspaceUiStore,
  validateDesignWorkspaceSelection,
} from "./state/design-workspace-ui";
import { useDesignWorkspaceSnapshot } from "./state/use-design-workspace";
import { useDesignLifecycleFeedback } from "./state/use-design-lifecycle-feedback";

import { DesignCanvas, EMPTY_NODE_IDS } from "./design-canvas";
import { DesignInspector } from "./design-inspector";
import { errorMessage } from "./design-workspace-error";
import {
  type DesignCanvasZoomActions,
  type DesignWorkspaceColumnProps,
} from "./design-workspace-types";


// --- CONSTANTS ---

const DESIGN_COLUMN_CLS =
  "border-border1 relative flex min-h-0 min-w-0 flex-1 overflow-hidden border-l bg-bg1";

// ============================================
// COMPONENT: DesignWorkspaceColumn
// PURPOSE: Canvas and inspector inside the shared workbench's Design tab
// USED IN: DesignWorkbenchSurface and the standalone interaction harness
// ============================================

// --- STATE ---

export function DesignWorkspaceColumn({
  workspace,
  folder,
  surfaceActive,
  inspectorVisible = true,
}: DesignWorkspaceColumnProps) {
  const [motionTimelineOpen, setMotionTimelineOpen] = useState(false);
  const [motionPropertyRequest, setMotionPropertyRequest] =
    useState<DesignMotionPropertyRequest | null>(null);
  const [motionProperties, setMotionProperties] =
    useState<readonly string[]>(EMPTY_NODE_IDS);
  const deletingFrameFilesRef = useRef(new Set<string>());
  const motionPropertyRequestIdRef = useRef(0);
  const zoomActionsRef = useRef<DesignCanvasZoomActions | null>(null);
  const workspaceId = workspace?.id ?? null;
  const snapshot = useDesignWorkspaceSnapshot(
    workspaceId,
    folder,
    surfaceActive,
  );
  useDesignLifecycleFeedback(workspaceId, surfaceActive, snapshot.error, snapshot.refresh);
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
      {inspectorVisible && <DesignInspector
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
      />}
    </section>
  );
}
