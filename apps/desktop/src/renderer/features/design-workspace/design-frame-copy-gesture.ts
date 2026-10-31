import type React from "react";
import { DESIGN_FRAME_COORDINATE_LIMIT } from "@zeros/design-core";
import { DESIGN_RUNTIME_DOCUMENT_BODY_ID } from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire, DesignFrameGeometryWire } from "../../platform/git";
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

const FRAME_GRID_GAP = 120;
const FRAME_GRID_COLUMNS = 3;
const FRAME_COPY_HANDOFF_MS = 2_000;
const PAINTED_FRAME_SELECTOR =
  'iframe[data-design-document-buffer="displayed"][data-design-document-ready], [data-design-source-ready], [data-design-frame-pixels-ready]';

/** The slot the engine gives a copy saved without a position
 * (`nextFrameGeometry`): the next cell of its page's three-column grid. */
export function designFrameCopyGeometry(
  page: readonly { width: number; height: number }[],
  source: { width: number; height: number },
): DesignFrameGeometryWire {
  const index = page.length;
  const widest = Math.max(source.width, ...page.map((frame) => frame.width));
  const tallest = Math.max(source.height, ...page.map((frame) => frame.height));
  const rows = Math.floor(DESIGN_FRAME_COORDINATE_LIMIT / (tallest + FRAME_GRID_GAP)) + 1;
  const columns = Math.max(FRAME_GRID_COLUMNS, Math.ceil((index + 1) / rows));
  return {
    x: Math.min(DESIGN_FRAME_COORDINATE_LIMIT, (index % columns) * (widest + FRAME_GRID_GAP)),
    y: Math.min(DESIGN_FRAME_COORDINATE_LIMIT, Math.floor(index / columns) * (tallest + FRAME_GRID_GAP)),
    w: source.width,
    h: source.height,
    z: index,
  };
}

/** A keyboard frame copy paints the source's pixels at once, in the slot it
 * will be saved to. They are presentation only, never catalog state: they
 * retire when the saved copy paints its own, when the copy leaves (or never
 * reaches) the confirmed catalog, or when the canvas owner changes. */
export function presentDesignFrameCopy(input: {
  workspaceId: string;
  frame: DesignCanvasFrameWire;
  article: HTMLElement;
  geometry: DesignFrameGeometryWire;
  current(): boolean;
}) {
  const { workspaceId, frame, geometry } = input;
  const rootId = designRuntimeFrameState(workspaceId, frame.file)?.snapshot?.frame.oid ?? DESIGN_RUNTIME_DOCUMENT_BODY_ID;
  const presentation = createDesignDragPresentation(workspaceId, frame, {
    oid: rootId, rect: { x: 0, y: 0, width: frame.width, height: frame.height },
  }, input.article);
  if (!presentation) return null;
  presentation.element.dataset.designFrameCopyPreview = "";
  presentation.paint({ x: geometry.x - frame.x, y: geometry.y - frame.y });
  const captures = new AbortController();
  const runtime = designFrameRuntime(workspaceId, frame.file);
  if (!presentation.hasPixels && runtime?.sourceVersion === frame.sourceVersion)
    void runtime.captureScreenshot(null, 1, captures.signal, "explicit").then((capture) => {
      if (input.current()) presentation.adopt({ ...capture, nodeId: rootId });
    }).catch(() => {});
  let retired = false;
  const retire = () => {
    if (retired) return;
    retired = true;
    captures.abort();
    presentation.remove();
  };
  return {
    retire,
    /** Keep the pixels over the saved copy until it shows its own. */
    handoff(copy: DesignCanvasFrameWire, articleOf: (file: string) => HTMLElement | undefined) {
      if (retired) return;
      // The confirmed place wins if anything moved the copy meanwhile.
      if (copy.x !== geometry.x || copy.y !== geometry.y)
        presentation.paint({ x: copy.x - frame.x, y: copy.y - frame.y });
      const started = performance.now();
      let mounted = false;
      const tick = () => {
        if (retired) return;
        const article = articleOf(copy.file);
        if (article?.isConnected) mounted = true;
        const confirmed = designFrameViews(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data)
          .some((candidate) => candidate.file === copy.file);
        // An Undo can retire the copy's surface before its reply confirms.
        if (!input.current() || !confirmed || (mounted && !article?.isConnected) ||
          article?.querySelector(PAINTED_FRAME_SELECTOR) || performance.now() - started > FRAME_COPY_HANDOFF_MS) {
          retire();
          return;
        }
        window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    },
  };
}

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
