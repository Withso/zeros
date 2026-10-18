import type React from "react";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire } from "../../platform/git";
import { designFrameRuntime } from "../../platform/bridge/design-frame-runtime";
import {
  applyDesignEditCached,
  designWorkspaceSnapshotCache,
  prepareDesignMovementFrame,
  transferDesignNodeCached,
} from "./state/design-workspace-cache";
import { clearDesignNodeStylePreviewTransient } from "./state/design-selection";
import { publishDesignGestureLivePreview } from "./state/design-live-preview";
import {
  createDesignLayoutDropResolver,
  type DesignLayoutDrop,
} from "./design-layout-drag";
import { createDesignDragPresentation } from "./design-drag-presentation";
import type { DesignOperation } from "@zeros/design-core";
import { designBackgroundWork } from "./state/design-background-work";
import { beginDesignPointerGesture } from "./design-pointer-gesture";
import { DESIGN_MOVE_ACTIVATION_PIXELS } from "./design-movement-geometry";
import {
  captureDesignPageOwner,
  designWorkspaceView,
  isCurrentDesignPageOwner,
} from "./state/design-workspace-ui";
import { useDesignRuntimeStore } from "./state/design-runtime-store";

const dragOwners = new WeakMap<object, object>();
const pendingSaves = new Map<string, Promise<void>>();

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
    parent?: DesignRuntimeNodeDetails,
  ) => void;
  finished: () => void;
  clicked: () => void;
  failed: (error: unknown) => void;
  isCurrent?: () => boolean;
  detach?: (
    origin: { x: number; y: number },
    details: DesignRuntimeNodeDetails,
    presented: (frame: DesignCanvasFrameWire) => Promise<void>,
    canWrite: () => boolean,
  ) => Promise<boolean>;
}): (() => void) | null {
  const { event, workspaceId } = input;
  let frame = input.frame;
  let details = input.details;
  const initialRuntime = designFrameRuntime(workspaceId, frame.file);
  if (
    !initialRuntime?.supports("previewLayout") ||
    !initialRuntime.supports("getLayoutTargets")
  )
    return null;
  let runtime = initialRuntime;
  const owner = event.currentTarget;
  const article = owner.closest<HTMLElement>("[data-design-frame]");
  if (!article) return null;
  const ownership = {};
  dragOwners.set(article, ownership);
  const pageOwner = captureDesignPageOwner(workspaceId);
  const saveKey = JSON.stringify([
    workspaceId,
    pageOwner.directoryId,
    pageOwner.pageId,
    pageOwner.revision,
    frame.file,
  ]);
  const previousSave = pendingSaves.get(saveKey);
  const selection = designWorkspaceView(workspaceId);
  let sourceVersion = runtime.sourceVersion;
  let geometry = {
    x: frame.x,
    y: frame.y,
    w: frame.width,
    h: frame.height,
    z: frame.z,
  };
  const frameIsCurrent = () => {
    const current = designWorkspaceSnapshotCache
      .peekSnapshot(workspaceId)
      .data?.frames.find((item) => item.file === frame.file);
    return (
      !!current &&
      current.sourceVersion === sourceVersion &&
      current.x === frame.x &&
      current.y === frame.y &&
      current.width === frame.width &&
      current.height === frame.height &&
      current.z === frame.z
    );
  };
  let revision =
    useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
      frame.file
    ]?.snapshot?.revision;
  let positioned = details.styles.position === "absolute";
  let freePosition =
    positioned && details.styles["--zeros-layout-origin-flow"] !== "1";
  let cancelled = false;
  let accepted = false;
  const ownsPointer = () =>
    dragOwners.get(article) === ownership &&
    input.isCurrent?.() !== false &&
    designWorkspaceView(workspaceId).selectionEvent ===
      selection.selectionEvent;
  const isCurrent = () =>
    (accepted || ownsPointer()) &&
    designFrameRuntime(workspaceId, frame.file) === runtime &&
    runtime.sourceVersion === sourceVersion &&
    runtime.isActive?.() !== false &&
    frameIsCurrent() &&
    isCurrentDesignPageOwner(pageOwner) &&
    designWorkspaceView(workspaceId).activeTheme === selection.activeTheme &&
    useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
      frame.file
    ]?.snapshot?.revision === revision;
  const assertCurrent = () => {
    if (cancelled || !isCurrent())
      throw new Error(
        "The layer or its editing context changed during the move. Try the gesture again.",
      );
  };
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
  const flush = async (): Promise<void> => {
    if (inFlight) return inFlight;
    if (!dirty || !targets || stopped) return Promise.resolve();
    assertCurrent();
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
      parent.oid !== details.layout?.parentId &&
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
          isCurrent() &&
          stillCurrent &&
          dragOwners.get(article) === ownership &&
          geometries[0]
        ) {
          presentation?.hide();
          input.paint(geometries[0], parent);
        }
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const schedule = (immediate = false) => {
    dirty = true;
    if (animation !== null || stopped) return;
    const update = () => {
      animation = null;
      void flush()
        .then(() => {
          if (dirty) schedule();
        })
        .catch((error) => {
          if (!released && !stopped) {
            cancelPointerGesture();
            input.failed(error);
          }
        });
    };
    if (immediate) update();
    else animation = requestAnimationFrame(update);
  };
  let ready: Promise<void> | null = null;
  const prepare = () =>
    (ready ??= (async () => {
      await previousSave;
      frame = await prepareDesignMovementFrame(workspaceId, frame);
      const currentRuntime = designFrameRuntime(workspaceId, frame.file);
      if (!currentRuntime || (!accepted && !ownsPointer()) || cancelled)
        throw new Error("The layer move no longer owns its editing context.");
      const currentRevision =
        useDesignRuntimeStore.getState().byWorkspace[workspaceId]?.frames[
          frame.file
        ]?.snapshot?.revision;
      if (
        frame.sourceVersion === input.frame.sourceVersion &&
        (currentRuntime !== initialRuntime || currentRevision !== revision)
      )
        throw new Error(
          "The layer runtime changed before movement could be measured.",
        );
      runtime = currentRuntime;
      sourceVersion = frame.sourceVersion;
      geometry = {
        x: frame.x,
        y: frame.y,
        w: frame.width,
        h: frame.height,
        z: frame.z,
      };
      revision = currentRevision;
      assertCurrent();
      const [result, measured] = await Promise.all([
        runtime.getLayoutTargets(undefined, details.oid),
        positioned
          ? runtime.getNodeDetails(details.oid, undefined, { relocation: true })
          : Promise.resolve(null),
      ]);
      assertCurrent();
      targets = result;
      // The last drag can already be visible while its inspector snapshot is
      // settling. Use the same current DOM snapshot for the moving node and its
      // destinations, including the cancellation baseline and pointer anchor.
      const current =
        measured ?? targets.find((target) => target.oid === details.oid);
      if (current && !stopped) {
        details = current;
        grab.x = (start.x - bounds.left) / initialZoom - current.rect.x;
        grab.y = (start.y - bounds.top) / initialZoom - current.rect.y;
      }
      positioned = details.styles.position === "absolute";
      freePosition =
        positioned && details.styles["--zeros-layout-origin-flow"] !== "1";
      if (positioned && !details.relocationContext) {
        details = await runtime.getNodeDetails(details.oid, undefined, {
          relocation: true,
        });
        assertCurrent();
      }
      if (positioned && !details.relocationContext)
        throw new Error(
          "This runtime cannot measure inherited appearance for safe layer movement.",
        );
      resolveDrop = createDesignLayoutDropResolver(details, targets, {
        zoom: input.zoom,
        preserveFreePosition: freePosition,
      });
      if (moved && !stopped) schedule();
    })());
  const move = (pointer: PointerEvent) => {
    if (pointer.pointerId !== event.pointerId || stopped) return;
    if (
      !moved &&
      Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) <
        DESIGN_MOVE_ACTIVATION_PIXELS
    )
      return;
    moved = true;
    sample++;
    if (!ready)
      void prepare().catch((error) => {
        if (!released && !stopped) {
          cancelPointerGesture();
          input.failed(error);
        }
      });
    const currentBounds = article.getBoundingClientRect();
    point = {
      x: (pointer.clientX - currentBounds.left) / input.zoom(),
      y: (pointer.clientY - currentBounds.top) / input.zoom(),
    };
    if (!targets) input.paint({ rect: { ...details.rect, ...origin() } });
    // The external visual follows every pointer, even while the source port
    // finishes its previous request. Late responses cannot move it backwards.
    if (suppressed) presentation?.paint(origin());
    // The shared pointer owner already sampled this move for the current paint.
    // Dispatch here rather than adding another frame before the live preview.
    schedule(true);
  };
  const cleanup = () => {
    if (animation !== null) cancelAnimationFrame(animation);
    animation = null;
    line.remove();
    input.finished();
  };
  const restore = async () => {
    await inFlight?.catch(() => {});
    if (
      dragOwners.get(article) !== ownership ||
      designFrameRuntime(workspaceId, frame.file) !== runtime ||
      runtime.sourceVersion !== sourceVersion
    ) {
      presentation?.remove();
      return;
    }
    if (previewedIds.size === 0 && !suppressed) {
      const restored = await runtime
        .getLayoutTargets(undefined, details.oid)
        .catch(() => []);
      const current = restored.find(
        (candidate) => candidate.oid === details.oid,
      );
      if (current && isCurrent())
        input.paint(
          current,
          restored.find(
            (candidate) => candidate.oid === current.layout?.parentId,
          ),
        );
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
          sourceVersion,
          nodeId,
        }).catch(() => {}),
      ),
    );
    if (isCurrent())
      input.paint(
        details,
        targets?.find((target) => target.oid === details.layout?.parentId),
      );
    presentation?.remove();
  };
  const cancel = () => {
    if (released || stopped) return;
    cancelled = true;
    stopped = true;
    cleanup();
    void restore().finally(resumeBackground);
  };
  const finish = () => {
    if (released || stopped) return;
    if (!ownsPointer()) {
      cancel();
      return;
    }
    accepted = true;
    released = true;
    cleanup();
    if (!moved) {
      stopped = true;
      resumeBackground();
      input.clicked();
      return;
    }
    const save = (async () => {
      await prepare();
      await inFlight;
      await flush();
      assertCurrent();
      stopped = true;
      const drop = latest;
      if (!drop) {
        const transferred = await input.detach?.(
          origin(),
          details,
          (target) => presentation?.handoff(target) ?? Promise.resolve(),
          isCurrent,
        );
        if (!transferred) await restore();
        else presentation?.remove();
        return;
      }
      if (
        freePosition &&
        drop.parentId === details.layout?.parentId &&
        origin().x === details.rect.x &&
        origin().y === details.rect.y
      ) {
        await restore();
        return;
      }
      if (drop.relocation) {
        await transferDesignNodeCached(
          workspaceId,
          {
            frame: frame.file,
            pageId: pageOwner.pageId,
            sourceVersion,
            destinationFrame: frame.file,
            destinationSourceVersion: sourceVersion,
            nodeId: details.oid,
            parentId: drop.parentId,
            beforeId: drop.beforeId,
            relocation: drop.relocation,
            movementGuard: { sourceVersion, geometry },
            x: frame.x,
            y: frame.y,
            w: frame.width,
            h: frame.height,
            z: frame.z,
          },
          isCurrent,
        );
        presentation?.remove();
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
        parent.oid !== details.layout?.parentId &&
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
        { ...frame, sourceVersion },
        {
          schemaVersion: 1,
          transactionId: `desktop:${crypto.randomUUID()}`,
          actor: { kind: "human", id: "desktop" },
          intent: "Move layer",
          createdAt: Date.now(),
          operations,
        },
        { movementGuard: { sourceVersion, geometry }, isCurrent },
      );
      presentation?.remove();
    })();
    pendingSaves.set(saveKey, save);
    void save
      .catch(async (error) => {
        stopped = true;
        await restore();
        input.failed(error);
      })
      .finally(() => {
        if (pendingSaves.get(saveKey) === save) pendingSaves.delete(saveKey);
        resumeBackground();
      });
  };
  event.preventDefault();
  event.stopPropagation();
  const cancelPointerGesture = beginDesignPointerGesture({
    target: owner,
    pointerId: event.pointerId,
    cursor: "grabbing",
    onMove: move,
    onFinish: finish,
    onCancel: cancel,
  });
  return cancelPointerGesture;
}
