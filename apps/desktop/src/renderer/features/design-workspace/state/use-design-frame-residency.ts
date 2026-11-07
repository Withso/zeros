import { useCallback, useLayoutEffect, useMemo, useReducer, useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { designHiddenDocuments } from "./design-hidden-documents";
import type { DesignViewport } from "../design-canvas-math";
import { createDesignFrameResidencyReader, type DesignFrameResidencyInput } from "../design-frame-residency";
import { DesignFrameSpatialIndex, type DesignSpatialFrame, type DesignSpatialRect } from "../design-frame-spatial-index";

/** After the camera rests, the page stays as the camera left it this long, so
 * the steps of one zoom do not unmount and remount hundreds of frames between
 * them; then the change applies once. */
export const DESIGN_RESIDENCY_SETTLE_MS = 1200;

/** The painted camera is read once per requested animation frame. Publishing
 * happens only when residency changes, not on every pixel of a pan. The durable
 * camera continues to commit through the existing gesture-settle path. */
export function useDesignFrameResidency<T extends DesignSpatialFrame>(
  input: Omit<DesignFrameResidencyInput<T>, "index" | "geometry"> & {
    camera: { readonly current: DesignViewport | null };
    geometry(): ReadonlyMap<string, DesignSpatialRect>;
    retainHidden?: boolean;
    retireHidden?(files: string[]): void;
  },
) {
  const reader = useMemo(() => createDesignFrameResidencyReader<T>(), []);
  const token = useMemo(() => ({ owner: input.owner }), [input.owner]);
  const readHidden = useCallback(() => designHiddenDocuments.read(token), [token]);
  const hiddenLive = useSyncExternalStore(designHiddenDocuments.subscribe, readHidden, readHidden);
  const index = useMemo(() => new DesignFrameSpatialIndex(input.frames), [input.frames]);
  const [, invalidate] = useReducer((value: number) => value + 1, 0);
  const cameraAt = useRef(-Infinity);
  const settleTimer = useRef<number | null>(null);
  const read = () => reader({ ...input, hiddenLive, index, view: input.camera.current ?? input.view, geometry: input.geometry(),
    gesture: input.camera.current !== null,
    settling: input.camera.current === null && performance.now() - cameraAt.current < DESIGN_RESIDENCY_SETTLE_MS });
  const result = read();
  useLayoutEffect(() => {
    designHiddenDocuments.update(token, {
      owner: input.owner, active: input.active, files: result.live,
      available: input.frames.map((frame) => frame.file),
      protectedFiles: input.protectedFiles ?? [], retainAll: input.retainHidden ?? false,
    }, (files) => input.retireHidden?.(files));
  });
  useLayoutEffect(() => () => designHiddenDocuments.remove(token), [token]);
  const latest = useRef({ read, input });
  latest.current = { read, input };
  const committed = useRef({ result, owner: input.owner });
  useLayoutEffect(() => { committed.current = { result, owner: input.owner }; }, [result, input.owner]);
  const pending = useRef<number | null>(null);
  const refresh = useCallback((reason?: "camera") => {
    const { input } = latest.current, current = committed.current;
    if (reason === "camera") {
      cameraAt.current = performance.now();
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      // Apply what the settling camera held back once it has rested.
      settleTimer.current = window.setTimeout(() => { settleTimer.current = null; refreshAfterSettle.current(); },
        DESIGN_RESIDENCY_SETTLE_MS + 16);
    }
    // A complete passive canvas already owns every source and needs no live
    // document. Camera paint handles visibility directly. Avoid another rAF,
    // spatial query and admission allocation for that unchanged working set.
    // Readiness maps can mutate without React; inspect the exact versions on
    // every request. Explicit content/editor demand never takes this shortcut.
    if (reason === "camera" && input.active && input.owner === current.owner &&
        input.sourceSurfacesEnabled && !input.selectedFrame && !input.requiredFiles.length && !input.protectedFiles?.length &&
        input.frames.length > 0 && current.result.frames.length === input.frames.length &&
        current.result.sources.size === input.frames.length && current.result.live.size === 0 &&
        input.frames.every(frame => {
          const version = (frame as T & { sourceVersion?: string }).sourceVersion;
          return version && current.result.sources.has(frame.file) && input.sourceReady?.get(frame.file) === version &&
            input.sourceUnavailable?.get(frame.file) !== version;
        })) return;
    if (pending.current !== null) return;
    pending.current = window.requestAnimationFrame(() => {
      pending.current = null;
      // The imperative camera already exposes the destination. Commit newly
      // admitted surfaces before this frame paints, not in a later React task.
      const next = latest.current.read(), current = committed.current.result;
      // A camera edge can change visibility while all source/editor leases
      // stay the same. The camera painter handles that CSS gate synchronously;
      // reconciling every frame tree here adds avoidable work to a zoom frame.
      if (next.frames !== current.frames || next.live !== current.live || next.sources !== current.sources)
        flushSync(invalidate);
    });
  }, []);
  const refreshAfterSettle = useRef(() => refresh());
  refreshAfterSettle.current = () => refresh();
  useLayoutEffect(() => () => {
    if (pending.current !== null) window.cancelAnimationFrame(pending.current);
    pending.current = null;
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = null;
  }, [input.active, input.owner]);
  return { frames: result.frames, live: result.live, sources: result.sources, refresh };
}
