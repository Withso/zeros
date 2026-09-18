import type React from "react";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire } from "../../platform/git";
import { designFrameRuntime } from "../../platform/bridge/design-frame-runtime";
import { applyDesignEditCached } from "./state/design-workspace-cache";
import { clearDesignNodeStylePreviewTransient } from "./state/design-selection";
import { publishDesignGestureLivePreview } from "./state/design-live-preview";
import {
  createDesignLayoutDropResolver,
  type DesignLayoutDrop,
} from "./design-layout-drag";
import { createDesignDragPresentation } from "./design-drag-presentation";
import type { DesignOperation } from "@zeros/design-core";
import { designBackgroundWork } from "./state/design-background-work";

const dragOwners = new WeakMap<object, object>();

/** A single-flight structural drag. Hit testing uses a frozen geometry set;
 * previews preserve DOM identity and the release is one undoable transaction. */
export function startDesignLayoutDrag(input: {
  event: React.PointerEvent<HTMLElement>;
  workspaceId: string;
  frame: DesignCanvasFrameWire;
  details: DesignRuntimeNodeDetails;
  zoom: () => number;
  paint: (
    details:
      | DesignRuntimeNodeDetails
      | { rect: DesignRuntimeNodeDetails["rect"] },
    parentRect?: DesignRuntimeNodeDetails["rect"],
  ) => void;
  finished: () => void;
  clicked: () => void;
  failed: (error: unknown) => void;
  detach?: (
    origin: { x: number; y: number },
    details: DesignRuntimeNodeDetails,
    presented: (frame: DesignCanvasFrameWire) => Promise<void>,
  ) => Promise<boolean>;
}): (() => void) | null {
  const { event, workspaceId, frame } = input;
  let details = input.details;
  const runtime = designFrameRuntime(workspaceId, frame.file);
  if (
    !runtime?.supports("previewLayout") ||
    !runtime.supports("getLayoutTargets")
  )
    return null;
  const owner = event.currentTarget;
  const article = owner.closest<HTMLElement>("[data-design-frame]");
  if (!article) return null;
  const ownership = {};
  dragOwners.set(runtime, ownership);
  const bounds = article.getBoundingClientRect();
  const initialZoom = input.zoom();
  const grab = {
    x: (event.clientX - bounds.left) / initialZoom - details.rect.x,
    y: (event.clientY - bounds.top) / initialZoom - details.rect.y,
  };
  const start = { x: event.clientX, y: event.clientY };
  const resumeBackground = designBackgroundWork.pause();
  let point = { x: details.rect.x + grab.x, y: details.rect.y + grab.y };
  let targets: DesignRuntimeNodeDetails[] | null = null;
  let resolveDrop: ReturnType<typeof createDesignLayoutDropResolver> | null =
    null;
  let presentation: ReturnType<typeof createDesignDragPresentation> = null;
  let suppressed = false;
  let latest: DesignLayoutDrop | null = null;
  let moved = false;
  let stopped = false;
  let released = false;
  let dirty = false;
  let sample = 0;
  let lastKey = "";
  const previewedIds = new Set<string>();
  let inFlight: Promise<void> | null = null;
  let animation: number | null = null;
  const line = document.createElement("div");
  line.dataset.designLayoutInsertion = "";
  line.className = "zd-design-layout-insertion";
  line.hidden = true;
  article.appendChild(line);
  const origin = () => ({ x: point.x - grab.x, y: point.y - grab.y });
  const paintLine = (drop: DesignLayoutDrop | null) => {
    const rect = drop?.indicator;
    line.hidden = !rect;
    if (rect)
      Object.assign(line.style, {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${Math.max(2 / input.zoom(), rect.width)}px`,
        height: `${Math.max(2 / input.zoom(), rect.height)}px`,
      });
  };
  const flush = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (!dirty || !targets || stopped) return Promise.resolve();
    dirty = false;
    latest = resolveDrop!(point, origin());
    paintLine(latest);
    if (!latest) {
      lastKey = "";
      presentation ??= createDesignDragPresentation(
        workspaceId,
        { ...frame, sourceVersion: runtime.sourceVersion },
        details,
        article,
      );
      presentation?.paint(origin());
      input.paint({ rect: { ...details.rect, ...origin() } });
      if (!suppressed && presentation?.hasPixels) {
        suppressed = true;
        inFlight = runtime
          .previewLayout({
            updates: [],
            nodeIds: [],
            suppressNodeId: details.oid,
          })
          .then(() => {})
          .finally(() => {
            inFlight = null;
          });
        return inFlight;
      }
      return Promise.resolve();
    }
    const drop = latest;
    const paintedSample = sample;
    const key = JSON.stringify([drop.parentId, drop.beforeId, drop.styles]);
    if (key === lastKey) return Promise.resolve();
    lastKey = key;
    const parent = targets.find((candidate) => candidate.oid === drop.parentId);
    const updates = [{ nodeId: details.oid, styles: drop.styles }];
    if (
      parent &&
      drop.styles.position === "absolute" &&
      parent.styles.position === "static"
    )
      updates.unshift({ nodeId: parent.oid, styles: { position: "relative" } });
    for (const update of updates) previewedIds.add(update.nodeId);
    publishDesignGestureLivePreview(
      workspaceId,
      frame.file,
      details.oid,
      drop.styles,
    );
    const restorePaint = suppressed;
    suppressed = false;
    inFlight = runtime
      .previewLayout({
        updates,
        moves: [
          {
            nodeId: details.oid,
            parentId: drop.parentId,
            beforeId: drop.beforeId,
          },
        ],
        nodeIds: [details.oid],
        children: false,
        ...(restorePaint ? { suppressNodeId: null } : {}),
      })
      .then((geometries) => {
        const currentDrop =
          sample === paintedSample ? drop : resolveDrop?.(point, origin());
        const stillCurrent =
          currentDrop &&
          JSON.stringify([
            currentDrop.parentId,
            currentDrop.beforeId,
            currentDrop.styles,
          ]) === key;
        if (
          !stopped &&
          stillCurrent &&
          dragOwners.get(runtime) === ownership &&
          geometries[0]
        ) {
          presentation?.hide();
          input.paint(geometries[0], parent?.rect);
        }
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const schedule = () => {
    dirty = true;
    if (animation !== null || stopped) return;
    animation = requestAnimationFrame(() => {
      animation = null;
      void flush()
        .then(() => {
          if (dirty) schedule();
        })
        .catch((error) => {
          if (!released) {
            cancel();
            input.failed(error);
          }
        });
    });
  };
  let ready: Promise<void> | null = null;
  const prepare = () =>
    (ready ??= runtime
      .getLayoutTargets(undefined, details.oid)
      .then((result) => {
        targets = result;
        // The last drag can already be visible while its inspector snapshot is
        // settling. Use the same current DOM snapshot for the moving node and its
        // destinations, including the cancellation baseline and pointer anchor.
        const current = targets.find((target) => target.oid === details.oid);
        if (current && !stopped) {
          details = current;
          grab.x = (start.x - bounds.left) / initialZoom - current.rect.x;
          grab.y = (start.y - bounds.top) / initialZoom - current.rect.y;
        }
        resolveDrop = createDesignLayoutDropResolver(details, targets);
        if (moved && !stopped) schedule();
      }));
  const move = (pointer: PointerEvent) => {
    if (pointer.pointerId !== event.pointerId || stopped) return;
    if (
      !moved &&
      Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) < 3
    )
      return;
    moved = true;
    sample++;
    if (!ready)
      void prepare().catch((error) => {
        if (!released) {
          cancel();
          input.failed(error);
        }
      });
    point = {
      x: details.rect.x + grab.x + (pointer.clientX - start.x) / input.zoom(),
      y: details.rect.y + grab.y + (pointer.clientY - start.y) / input.zoom(),
    };
    if (!targets) input.paint({ rect: { ...details.rect, ...origin() } });
    // The external visual follows every pointer, even while the source port
    // finishes its previous request. Late responses cannot move it backwards.
    if (suppressed) presentation?.paint(origin());
    schedule();
  };
  const cleanup = () => {
    if (animation !== null) cancelAnimationFrame(animation);
    animation = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    if (owner.hasPointerCapture?.(event.pointerId))
      owner.releasePointerCapture(event.pointerId);
    line.remove();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    input.finished();
  };
  const restore = async () => {
    await inFlight?.catch(() => {});
    if (dragOwners.get(runtime) !== ownership) {
      presentation?.remove();
      return;
    }
    await runtime
      .previewLayout({
        updates: [],
        cancelMoves: true,
        nodeIds: [],
        suppressNodeId: null,
      })
      .catch(() => {});
    await Promise.all(
      [...previewedIds].map((nodeId) =>
        clearDesignNodeStylePreviewTransient({
          workspaceId,
          frame: frame.file,
          sourceVersion: runtime.sourceVersion,
          nodeId,
        }).catch(() => {}),
      ),
    );
    input.paint(
      details,
      targets?.find((target) => target.oid === details.layout?.parentId)?.rect,
    );
    presentation?.remove();
  };
  const cancel = () => {
    if (released || stopped) return;
    stopped = true;
    cleanup();
    void restore().finally(resumeBackground);
  };
  const finish = () => {
    if (released || stopped) return;
    released = true;
    cleanup();
    if (!moved) {
      stopped = true;
      resumeBackground();
      input.clicked();
      return;
    }
    void (async () => {
      await prepare();
      await inFlight;
      await flush();
      stopped = true;
      const drop = latest;
      if (!drop) {
        const transferred = await input.detach?.(
          origin(),
          details,
          (target) => presentation?.handoff(target) ?? Promise.resolve(),
        );
        if (!transferred) await restore();
        else presentation?.remove();
        return;
      }
      publishDesignGestureLivePreview(
        workspaceId,
        frame.file,
        details.oid,
        drop.styles,
        { settle: true },
      );
      const parent = targets?.find(
        (candidate) => candidate.oid === drop.parentId,
      );
      const operations: DesignOperation[] = [
        {
          operationId: crypto.randomUUID(),
          type: "node.move",
          nodeId: drop.nodeId,
          parentId: drop.parentId,
          beforeId: drop.beforeId,
        },
        {
          operationId: crypto.randomUUID(),
          type: "node.set-styles",
          nodeId: details.oid,
          styles: drop.styles,
          scope: "auto",
          responsiveContext: "base",
          stateContext: "default",
        },
      ];
      if (
        parent &&
        drop.styles.position === "absolute" &&
        parent.styles.position === "static"
      )
        operations.push({
          operationId: crypto.randomUUID(),
          type: "node.set-styles",
          nodeId: parent.oid,
          styles: { position: "relative" },
          scope: "auto",
          responsiveContext: "base",
          stateContext: "default",
        });
      await applyDesignEditCached(
        workspaceId,
        { ...frame, sourceVersion: runtime.sourceVersion },
        {
          schemaVersion: 1,
          transactionId: `desktop:${crypto.randomUUID()}`,
          actor: { kind: "human", id: "desktop" },
          intent: "Move layer",
          createdAt: Date.now(),
          operations,
        },
      );
      presentation?.remove();
    })()
      .catch(async (error) => {
        stopped = true;
        await restore();
        input.failed(error);
      })
      .finally(resumeBackground);
  };
  event.preventDefault();
  event.stopPropagation();
  owner.setPointerCapture?.(event.pointerId);
  document.body.style.cursor = "grabbing";
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
  return cancel;
}
