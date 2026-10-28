import type React from "react";
import { DESIGN_RUNTIME_DOCUMENT_BODY_ID } from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire } from "../../platform/git";
import { designFrameRuntime, waitForDesignFrameRuntime } from "../../platform/bridge/design-frame-runtime";
import { createDesignDragPresentation } from "./design-drag-presentation";
import { beginDesignPointerGesture } from "./design-pointer-gesture";
import { designCanvasFrameAt, transferDesignLayerOnCanvas } from "./design-layout-transfer";
import { designFrameViews, type DesignFrameView } from "./state/design-frame-view";
import { designWorkspaceSnapshotCache, duplicateDesignFrameCached } from "./state/design-workspace-cache";
import { captureDesignPageOwner, designWorkspaceView, isCurrentDesignPageOwner } from "./state/design-workspace-ui";
import { selectDesignFrame } from "./state/design-selection";
import { designBackgroundWork } from "./state/design-background-work";
import { designRuntimeFrameState } from "./state/design-runtime-store";

/** The original stays in place throughout an Option drag. The temporary
 * pixels have one gesture owner and one bounded handoff to the saved copy. */
export function startDesignFrameCopy(input: {
  event: React.PointerEvent<HTMLElement>;
  workspaceId: string;
  folder: string;
  frame: DesignCanvasFrameWire;
  point(pointer: { clientX: number; clientY: number }): { x: number; y: number };
  current(): boolean;
  nest(file: string | null): void;
  finished(): void;
  saving(save: Promise<void>): void;
  failed(error: unknown): void;
}): () => void {
  const { event, workspaceId, frame } = input;
  const article = event.currentTarget.closest<HTMLElement>("[data-design-frame]");
  if (!article) return () => {};
  event.preventDefault();
  event.stopPropagation();
  const owner = captureDesignPageOwner(workspaceId);
  const selection = designWorkspaceView(workspaceId);
  const start = input.point(event);
  const grab = { x: start.x - frame.x, y: start.y - frame.y };
  const resume = designBackgroundWork.pause();
  let presentation: ReturnType<typeof createDesignDragPresentation> = null;
  let moved = false, cancelled = false, released = false;
  let pointer = start;
  let origin = { x: frame.x, y: frame.y };
  let destination: DesignFrameView | undefined;
  const captures = new AbortController();
  let capturing = false;
  const rootId = designRuntimeFrameState(workspaceId, frame.file)?.snapshot?.frame.oid ?? DESIGN_RUNTIME_DOCUMENT_BODY_ID;
  const current = () => !cancelled && input.current() && isCurrentDesignPageOwner(owner) &&
    designWorkspaceView(workspaceId).selectionEvent === selection.selectionEvent;
  const sourceDetails = async () => {
    const runtime = await waitForDesignFrameRuntime(workspaceId, frame.file, 2_000, { sourceVersion: frame.sourceVersion, signal: captures.signal });
    if (!runtime || !current()) return null;
    const snapshot = await runtime.getSnapshot(captures.signal);
    const rootId = snapshot.frame?.oid ?? DESIGN_RUNTIME_DOCUMENT_BODY_ID;
    const details = await runtime.getNodeDetails(rootId, captures.signal, { relocation: true });
    if (!current() || designFrameRuntime(workspaceId, frame.file) !== runtime) return null;
    return details;
  };
  const cleanup = () => { input.nest(null); input.finished(); };
  const cancel = () => {
    if (released) return;
    cancelled = true;
    captures.abort();
    cleanup();
    presentation?.remove();
    resume();
  };
  return beginDesignPointerGesture({ target: event.currentTarget, pointerId: event.pointerId, cursor: "copy",
    onMove: event => {
      if (!current()) return;
      if (!moved && Math.hypot(event.clientX - input.event.clientX, event.clientY - input.event.clientY) < 3) return;
      moved = true;
      pointer = input.point(event);
      origin = { x: pointer.x - grab.x, y: pointer.y - grab.y };
      presentation ??= createDesignDragPresentation(workspaceId, frame, {
        oid: rootId, rect: { x: 0, y: 0, width: frame.width, height: frame.height },
      }, article);
      presentation?.paint({ x: origin.x - frame.x, y: origin.y - frame.y });
      const runtime = designFrameRuntime(workspaceId, frame.file);
      if (presentation && !presentation.hasPixels && !capturing && runtime?.sourceVersion === frame.sourceVersion) {
        capturing = true;
        void runtime.captureScreenshot(null, 1, captures.signal, "explicit").then(capture => {
          if (current()) presentation?.adopt({ ...capture, nodeId: rootId });
        }).catch(() => {});
      }
      destination = event.metaKey || event.ctrlKey ? undefined : designCanvasFrameAt(frame.file,
        designFrameViews(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data), pointer);
      input.nest(destination?.file ?? null);
    },
    onCancel: cancel,
    onFinish: () => {
      if (!moved || !current()) { cancel(); return; }
      released = true;
      input.finished();
      const save = (async () => {
        if (!current()) return;
        if (destination) {
          const details = await sourceDetails();
          if (!current()) return;
          if (!details) throw new Error("The source frame is still preparing. Try the copy again.");
          const transferred = await transferDesignLayerOnCanvas({ workspaceId, folder: input.folder, frame, details,
            duplicateNodeId: `copy-${crypto.randomUUID()}`, frames: designFrameViews(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data),
            origin, pointer, destination, detach: false, requireRelocation: true, isCurrent: current,
            presented: target => presentation?.handoff(target) ?? Promise.resolve() });
          if (transferred) return;
          throw new Error("The copy destination changed before release.");
        }
        const result = await duplicateDesignFrameCached(workspaceId, frame.file, owner.pageId, {
          sourceVersion: frame.sourceVersion, geometry: { ...origin, w: frame.width, h: frame.height, z: Math.min(256, frame.z + 1) },
        });
        const copy = result.snapshot.frames.find(candidate => candidate.file === result.frame.file);
        if (copy && current()) {
          void selectDesignFrame(workspaceId, copy, { owner }).catch(() => {});
          await presentation?.handoff(copy);
        }
      })();
      input.saving(save);
      void save.catch(error => { if (current()) input.failed(error); }).finally(() => {
        captures.abort();
        presentation?.remove();
        input.nest(null);
        resume();
      });
    },
  });
}
