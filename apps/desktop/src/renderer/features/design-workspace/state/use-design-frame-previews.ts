// Canvas wiring for Design frame previews: the device-wide picture cache,
// the signed-in cloud account's scope, and the hooks the canvas and its frame
// surfaces read. Policy lives in design-frame-previews.ts.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { createIndexedDbDesignPreviewStore } from "../../../platform/design-preview-store";
import { designPreview } from "../../../platform/git";
import {
  canBackgroundSyncCloudWorkspace,
  subscribeCloudWorkspaceRefresh,
} from "../../../state/cloud-workspace-catalog";
import { designBackgroundWork } from "./design-background-work";
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
  store: createIndexedDbDesignPreviewStore(),
  render: (owner, input) =>
    designPreview(owner.workspaceId, {
      directoryId: owner.directoryId,
      frame: input.file,
      sourceVersion: input.sourceVersion,
      theme: input.theme,
      maxDimension: input.maxDimension,
    }),
  // A render waits for a quiet slot in the canvas's background lane and then
  // leaves it: the engine renders out of process, so tiles and audits never
  // queue behind its round trip.
  schedule: async (work) =>
    (await designBackgroundWork.schedule("design-preview", async () => true)) ? work() : null,
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

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => designFramePreviews.resume());
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
    designFramePreviews.setDemand(token, demand);
  }, [demand, token]);
  useEffect(() => () => designFramePreviews.setDemand(token, null), [token]);
}

/** The picture a frame surface paints, pinned while it shows. */
export function useDesignFramePreview(target: DesignPreviewTarget | null): DesignPreviewPicture | null {
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
  const picture = useMemo(
    () => (owner && target ? designFramePreviews.picture(target) : null),
    // `target` is rebuilt per render; its identity is these fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [frameKey, level, sourceVersion, version],
  );
  const key = picture?.key;
  useEffect(() => (key ? designFramePreviews.pin(key) : undefined), [key]);
  return picture;
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
): ReadonlySet<string> {
  const reader = useRef<ReturnType<typeof createDesignFramePicturedReader> | null>(null);
  reader.current ??= createDesignFramePicturedReader(designFramePreviews);
  const subscribe = useCallback(
    (listener: () => void) => (active ? designFramePreviews.subscribeChanges(listener) : () => {}),
    [active],
  );
  const read = () => reader.current!(owner, theme, frames);
  return useSyncExternalStore(subscribe, read, read);
}
