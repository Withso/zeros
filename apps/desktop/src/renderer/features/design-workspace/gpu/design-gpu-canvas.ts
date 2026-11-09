import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";

import { getActiveBridge } from "../../../platform/bridge/active-bridge";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { bridgeDesignRecordingsRead, bridgeDesignRecordingsRender } from "../../../platform/bridge/design-bridge";
import { useInternalFeatureActive } from "../../settings/internal-features";
import { DesignGpuScene, type DesignGpuSceneFrame } from "./design-gpu-scene";
import { createDesignGpuRuntime, type DesignGpuRuntime } from "./design-gpu-runtime";
import type { DesignGpuSnapshot } from "./design-gpu-stats";
import type { DesignRecordingsOwner, DesignRecordingsSource } from "./design-recordings";
import { DESIGN_RECORDINGS_CAPABILITY } from "./design-recordings-wire";

const bridgeSource: DesignRecordingsSource = {
  read: (owner, frames, knownChunks, signal) => {
    const bridge = getActiveBridge();
    if (!bridge) return Promise.reject(new Error("Design recordings need a connected engine."));
    return bridgeDesignRecordingsRead(bridge, owner.workspaceId, { directoryId: owner.directoryId, theme: owner.theme, frames,
      knownChunks }, { signal });
  },
  render: (owner, frames, knownChunks, signal) => {
    const bridge = getActiveBridge();
    if (!bridge) return Promise.reject(new Error("Design recordings need a connected engine."));
    return bridgeDesignRecordingsRender(bridge, owner.workspaceId, { directoryId: owner.directoryId, theme: owner.theme, frames,
      knownChunks }, { signal });
  },
};

let appRuntime: DesignGpuRuntime | null = null;
export function designGpuRuntime(): DesignGpuRuntime {
  return appRuntime ??= createDesignGpuRuntime(bridgeSource,
    () => new Worker(new URL("./design-gpu-raster.worker.ts", import.meta.url), { type: "module" }));
}

/** A removed workspace's recordings leave memory with it. */
export function forgetDesignGpuWorkspaces(workspaceIds: readonly string[]): void {
  appRuntime?.recordings.forgetWorkspaces(workspaceIds);
}

/** Staff with the internal flag, a Local workspace, an engine that records
 * frames, and a session where the recorded canvas can draw. Cloud workspaces
 * never offer Design recordings. */
export function useDesignGpuCanvasEnabled(workspaceId: string | null | undefined, runtime = designGpuRuntime()): boolean {
  const flag = useInternalFeatureActive("designGpuCanvas");
  const available = useDesignGpuAvailable(runtime);
  return flag && available && !!workspaceId && !isCloudWorkspace(workspaceId) &&
    getActiveBridge()?.supportsEngineCapability?.(DESIGN_RECORDINGS_CAPABILITY, workspaceId) === true;
}

/** False once WebGL2 or the raster worker failed this session. */
export function useDesignGpuAvailable(runtime: DesignGpuRuntime): boolean {
  const read = () => runtime.unavailable === null;
  return useSyncExternalStore(runtime.subscribe, read, read);
}

/** Frames whose recordings failed: the canvas lets their live document cover them. */
export function useDesignGpuFailedFrames(runtime: DesignGpuRuntime, owner: DesignRecordingsOwner | null): ReadonlySet<string> {
  const subscribe = useCallback((listener: () => void) => runtime.recordings.subscribe(() => listener()), [runtime]);
  const read = () => owner ? runtime.recordings.failedFiles(owner) : EMPTY;
  return useSyncExternalStore(subscribe, read, read);
}
const EMPTY: ReadonlySet<string> = new Set();

interface DesignGpuInstrumentation {
  readonly version: 1;
  readonly last: DesignGpuSnapshot | null;
  snapshot(): Promise<DesignGpuSnapshot>;
  reset(): void;
  loseContext(target: "compositor" | "rasterizer"): void;
}
type InstrumentedWindow = Window & { __zerosDesignGpu?: DesignGpuInstrumentation };

const activeScenes = new Map<DesignGpuScene, DesignGpuRuntime>();
let lastSnapshot: DesignGpuSnapshot | null = null;
let instrumented: DesignGpuRuntime | null = null;

function installInstrumentation(runtime: DesignGpuRuntime): void {
  instrumented = runtime;
  const target = window as InstrumentedWindow;
  if (target.__zerosDesignGpu) return;
  const current = () => [...activeScenes].at(-1);
  target.__zerosDesignGpu = {
    version: 1,
    get last() { return lastSnapshot; },
    async snapshot() {
      const entry = current();
      const runtime = entry?.[1] ?? instrumented ?? designGpuRuntime();
      const worker = await runtime.client?.requestStats() ?? null;
      lastSnapshot = runtime.stats.snapshot({ gpu: entry?.[0].usage() ?? { pages: 0, units: 0, bytes: 0, budget: 0, evictedPages: 0 },
        chunks: runtime.chunks.usage(), requests: runtime.recordings.usage(), worker });
      return lastSnapshot;
    },
    reset() { for (const [, runtime] of activeScenes) runtime.stats.reset(); },
    loseContext(which) {
      const entry = current();
      if (which === "compositor") entry?.[0].loseContext();
      else entry?.[1].client?.loseContext();
    },
  };
}

/** An unavailable canvas keeps it, so its snapshot still says why. */
function uninstallInstrumentation(runtime: DesignGpuRuntime): void {
  if (!activeScenes.size && runtime.unavailable === null) delete (window as InstrumentedWindow).__zerosDesignGpu;
}

/** Mounts the recorded canvas under a world while it is active and enabled.
 * An inactive canvas owns no scene, plane, observer or worker request. */
export function useDesignGpuCanvas(input: {
  enabled: boolean;
  active: boolean;
  worldRef: RefObject<HTMLDivElement | null>;
  /** The world's document owner: a new one mounts a new scene. */
  documentOwner: string;
  owner: DesignRecordingsOwner | null;
  openKey: string;
  frames: readonly DesignGpuSceneFrame[];
  live: ReadonlySet<string>;
  runtime?: DesignGpuRuntime;
}): void {
  const runtime = input.runtime ?? designGpuRuntime();
  const sceneRef = useRef<DesignGpuScene | null>(null);
  const latest = useRef(input);
  latest.current = input;
  useLayoutEffect(() => {
    const world = input.worldRef.current;
    if (!input.enabled || !input.active || !world) return undefined;
    const client = runtime.acquireClient();
    const scene = new DesignGpuScene(world, { recordings: runtime.recordings, client, stats: runtime.stats });
    if (!scene.start()) {
      scene.dispose();
      runtime.releaseClient();
      runtime.markUnavailable("WebGL2 is unavailable to the recorded Design canvas.");
      installInstrumentation(runtime);
      return undefined;
    }
    sceneRef.current = scene;
    activeScenes.set(scene, runtime);
    installInstrumentation(runtime);
    const { owner, openKey, frames, live } = latest.current;
    scene.update({ owner, openKey, frames, live });
    return () => {
      sceneRef.current = null;
      activeScenes.delete(scene);
      uninstallInstrumentation(runtime);
      scene.dispose();
      runtime.releaseClient();
    };
  }, [input.active, input.documentOwner, input.enabled, input.worldRef, runtime]);
  useEffect(() => {
    sceneRef.current?.update({ owner: input.owner, openKey: input.openKey, frames: input.frames, live: input.live });
  }, [input.frames, input.live, input.openKey, input.owner]);
}

/** Scene frames from canvas frame views: a frame still being prepared has no version yet. */
export function useDesignGpuSceneFrames(frames: ReadonlyArray<{ file: string; sourceVersion?: string; x: number; y: number;
  width: number; height: number }>, enabled: boolean): readonly DesignGpuSceneFrame[] {
  return useMemo(() => enabled ? frames.map(({ file, sourceVersion, x, y, width, height }) =>
    (typeof sourceVersion === "string" ? { file, sourceVersion, x, y, width, height } : { file, x, y, width, height })) : [],
  [enabled, frames]);
}
