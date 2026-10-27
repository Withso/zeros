// Canvas wiring for Design frame previews: the device-wide picture cache,
// the signed-in cloud account's scope, and the hooks the canvas and its frame
// surfaces read. Policy lives in design-frame-previews.ts.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { createIndexedDbDesignPreviewStore } from "../../../platform/design-preview-store";
import { designPreview } from "../../../platform/git";
import {
  canBackgroundSyncCloudWorkspace,
  subscribeCloudWorkspaceRefresh,
} from "../../../state/cloud-workspace-catalog";
import { designBackgroundWork } from "./design-background-work";
import { designImageResidency } from "./design-image-residency";
import { DesignPreviewDecodes, type DesignDecodedPreviewLease } from "./design-preview-decodes";
import { useDesignImageState } from "./use-design-image-display";
import { designCaptureScheduler } from "../../../platform/bridge/design-capture-scheduler";
import { designSourceVectorCache } from "../design-source-vector";
import {
  DesignFramePreviews,
  createDesignFramePicturedReader,
  designPreviewFrameKey,
  encodeDesignPreview,
  type DesignPreviewDemand,
  type DesignPreviewOwner,
  type DesignPreviewPicture,
  type DesignPreviewTarget,
} from "./design-frame-previews";

/** A cloud picture starts a capture browser on the VM the agents run on, so
 * cloud canvases render only frames near the screen, with a pause between
 * pictures that leaves the VM's capture host free for agent captures. */
const CLOUD_PREVIEW_RENDER_GAP_MS = 2_000;

let cloudScope: string | null = null;
let accountGeneration = 0;
const scopeListeners = new Set<() => void>();

export const designFramePreviews = new DesignFramePreviews({
  displayBudget: designImageResidency,
  store: createIndexedDbDesignPreviewStore(),
  render: (owner, input, signal) =>
    designPreview(owner.workspaceId, {
      directoryId: owner.directoryId,
      frame: input.file,
      sourceVersion: input.sourceVersion,
      theme: input.theme,
      maxDimension: input.maxDimension,
    }, { signal, admitted: true }),
  // A render waits for a quiet slot in the canvas's background lane and then
  // leaves it: the engine renders out of process, so tiles and audits never
  // queue behind its round trip.
  schedule: async (work, capture) =>
    (await designBackgroundWork.schedule("design-preview", async () => true))
      ? capture ? designCaptureScheduler.schedule(capture.key, capture.priority, work, capture.signal) : work()
      : null,
  encode: encodeDesignPreview,
  canProduce: (owner) => {
    if (!isCloudWorkspace(owner.workspaceId)) return true;
    const target = parseCloudWorkspaceKey(owner.workspaceId);
    return !!target && owner.scope === cloudScope && canBackgroundSyncCloudWorkspace(target);
  },
  rendersFar: (owner) => !isCloudWorkspace(owner.workspaceId),
  renderGapMs: (owner) => (isCloudWorkspace(owner.workspaceId) ? CLOUD_PREVIEW_RENDER_GAP_MS : 0),
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
});

export const designPreviewDecodes = new DesignPreviewDecodes({
  acquire: (target) => designFramePreviews.acquire(target),
  hasPicture: (target) => !!designFramePreviews.picture(target),
  retain: (key) => designFramePreviews.pin(key),
  decode: decodeDesignPreviewPicture,
});
designImageResidency.subscribePressure(() => {
  designPreviewDecodes.clearWarm();
  designSourceVectorCache.clearWarmImages();
});

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    designFramePreviews.resume();
  });
}
// A VM that starts running lets its canvas render the pictures it is missing.
subscribeCloudWorkspaceRefresh(() => designFramePreviews.resume());

async function accountDigest(account: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(account)));
  return Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The signed-in cloud account, or null when signed out. Cloud pictures are
 * stored under a digest of it and shown only to it. */
export function setDesignFramePreviewAccount(account: string | null): void {
  const generation = ++accountGeneration;
  const install = (scope: string | null) => {
    if (generation !== accountGeneration) return;
    cloudScope = scope;
    designPreviewDecodes.clearWarm();
    designFramePreviews.retainCloudScope(scope);
    for (const listener of [...scopeListeners]) listener();
  };
  if (!account) {
    install(null);
    return;
  }
  install(null);
  void accountDigest(account).then((digest) => install(`cloud:${digest}`), () => install(null));
}

/** A workspace was removed; its pictures go from memory and disk. */
export function forgetDesignFramePreviews(workspaceIds: readonly string[]): void {
  designSourceVectorCache.forgetWorkspaces(workspaceIds);
  designPreviewDecodes.forgetWorkspaces(workspaceIds);
  designFramePreviews.forgetWorkspaces(workspaceIds);
}

function subscribeScope(listener: () => void) {
  scopeListeners.add(listener);
  return () => { scopeListeners.delete(listener); };
}

/** The picture owner for a canvas: Local workspaces always, cloud ones only
 * for a signed-in account. */
export function useDesignPreviewOwner(
  workspaceId: string | null | undefined,
  directoryId: string | null | undefined,
): DesignPreviewOwner | null {
  const scope = useSyncExternalStore(subscribeScope, () => cloudScope, () => cloudScope);
  return useMemo(() => {
    if (!workspaceId || !directoryId) return null;
    if (!isCloudWorkspace(workspaceId)) return { scope: "local", workspaceId, directoryId };
    return scope ? { scope, workspaceId, directoryId } : null;
  }, [directoryId, scope, workspaceId]);
}

/** The canvas states what it shows while it is the active surface. */
export function useDesignFramePreviewDemand(demand: DesignPreviewDemand | null): void {
  const token = useRef({}).current;
  useEffect(() => {
    designPreviewDecodes.setOwner(token, demand);
    designFramePreviews.setDemand(token, demand);
  }, [demand, token]);
  useEffect(() => () => {
    designPreviewDecodes.setOwner(token, null);
    designFramePreviews.setDemand(token, null);
  }, [token]);
}

/** Decode only after reserving its pixels, and release the decoder itself on
 * cancellation or eviction. A warm cache retains the actual decoded image. */
export async function decodeDesignPreviewPicture(picture: DesignPreviewPicture, signal: AbortSignal): Promise<{ element: HTMLImageElement; dispose(): void }> {
  const image = new Image();
  const cancel = () => { image.src = ""; };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new Error("Preview display was superseded.");
    image.src = picture.url;
    await image.decode();
    if (signal.aborted || image.naturalWidth !== picture.width || image.naturalHeight !== picture.height)
      throw new Error("Preview display dimensions or owner changed.");
    return { element: image, dispose: cancel };
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** The picture a visible/admitted surface paints. Both old and incoming pixels
 * own leases through decode; the old lease ends after React replaces its DOM. */
export function useDesignFramePreview(target: DesignPreviewTarget | null): (DesignPreviewPicture & { image: HTMLImageElement | null }) | null {
  const owner = target?.owner;
  const frameKey = owner && target ? designPreviewFrameKey(owner, target.file, target.theme) : null;
  const subscribe = useMemo(
    () => (listener: () => void) => frameKey ? designFramePreviews.subscribe(frameKey, listener) : () => {},
    [frameKey],
  );
  const version = useSyncExternalStore(
    subscribe,
    () => (frameKey ? designFramePreviews.version(frameKey) : 0),
    () => 0,
  );
  const sourceVersion = target?.sourceVersion;
  const level = target?.level;
  const stableTarget = useMemo(
    () => target,
    // The target's identity is these fields, not its per-render wrapper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frameKey, level, sourceVersion],
  );
  const [shown, setShown] = useDesignImageState<{ frameKey: string; lease: DesignDecodedPreviewLease }>();
  const shownRef = useRef(shown);
  shownRef.current = shown;
  // Publish cover readiness only after this decoded lease is committed. An
  // encoded cache hit alone cannot authorize retiring the live document.
  useLayoutEffect(() => { shown?.lease.confirmDecoded(); }, [shown]);
  useLayoutEffect(() => {
    if (!stableTarget || !frameKey) {
      setShown(null);
      return;
    }
    if (shownRef.current?.frameKey !== frameKey) setShown(null);
    let cancelled = false;
    let decoding = false;
    let stopWaiting: (() => void) | undefined;
    let releasePending: (() => void) | undefined;
    const attempt = () => {
      if (cancelled || decoding) return;
      const lease = designPreviewDecodes.acquire(stableTarget);
      if (!lease) {
        stopWaiting ??= designFramePreviews.subscribeAvailable(attempt);
        return;
      }
      if (lease.picture.key !== designFramePreviews.picture(stableTarget)?.key)
        stopWaiting ??= designFramePreviews.subscribeAvailable(attempt);
      if (lease.picture.key === shownRef.current?.lease.picture.key) {
        lease.release();
        return;
      }
      decoding = true;
      let transferred = false;
      releasePending = () => { if (!transferred) lease.release(); };
      const publish = () => {
        if (cancelled) return;
        transferred = true;
        setShown({ frameKey, lease });
      };
      // A culled frame's owned decoder is ready synchronously. A layout
      // publication lets React install those pixels before the camera paints.
      if (lease.ready) { publish(); decoding = false; return; }
      void lease.whenReady.then(publish).catch(() => {
        // Keep the last confirmed same-frame pixels or its live document.
      }).finally(() => {
        decoding = false;
        if (!transferred) lease.release();
      });
    };
    attempt();
    return () => {
      cancelled = true;
      stopWaiting?.();
      releasePending?.();
    };
  }, [frameKey, stableTarget, version, setShown]);
  return useMemo(() => shown && shown.frameKey === frameKey ? {
    ...shown.lease.picture, current: shown.lease.picture.sourceVersion === sourceVersion, image: shown.lease.image,
  } : null, [frameKey, shown, sourceVersion]);
}

/** Frames with a picture of their current generation. Pictures arrive in
 * batches at most every 100ms; the canvas re-renders only when the set's
 * members change, and never while it is inactive (a retained hidden canvas
 * stays inert and reads the set again when it returns). */
export function useDesignFramePictured(
  owner: DesignPreviewOwner | null,
  theme: string | null,
  frames: readonly { file: string; sourceVersion: string }[],
  active: boolean,
  renderScale = 0,
): ReadonlySet<string> {
  const reader = useRef<ReturnType<typeof createDesignFramePicturedReader> | null>(null);
  reader.current ??= createDesignFramePicturedReader({
    changes: () => designFramePreviews.changes(),
    pictured: (owner, theme, frames, scale) => designFramePreviews.pictured(owner, theme, frames, scale, true),
  });
  const subscribe = useCallback(
    (listener: () => void) => (active ? designFramePreviews.subscribeChanges(listener) : () => {}),
    [active],
  );
  const read = () => reader.current!(owner, theme, frames, renderScale);
  return useSyncExternalStore(subscribe, read, read);
}
