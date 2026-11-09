import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";

import { getActiveBridge } from "../../../platform/bridge/active-bridge";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { bridgeDesignRecordingsRead, bridgeDesignRecordingsRender } from "../../../platform/bridge/design-bridge";
import { useInternalFeatureActive } from "../../settings/internal-features";
import { DesignGpuScene, type DesignGpuSceneFrame } from "./design-gpu-scene";
import { DesignGpuStats, type DesignGpuSnapshot } from "./design-gpu-stats";
import { DesignGpuWorkerClient } from "./design-gpu-worker-client";
import { DesignRecordingChunks } from "./design-recording-chunks";
import { DesignRecordings, type DesignRecordingsOwner, type DesignRecordingsSource } from "./design-recordings";
import { DESIGN_RECORDINGS_CAPABILITY } from "./design-recordings-wire";

/** The raster worker retires this long after the last recorded canvas closes,
 * releasing its WebAssembly heap (which never shrinks while it lives). */
const WORKER_IDLE_MS = 60_000;

export interface DesignGpuRuntime {
  readonly recordings: DesignRecordings;
  readonly chunks: DesignRecordingChunks;
  readonly stats: DesignGpuStats;
  acquireClient(): DesignGpuWorkerClient;
  releaseClient(): void;
  readonly client: DesignGpuWorkerClient | null;
}

export function createDesignGpuRuntime(source: DesignRecordingsSource,
  createWorker: () => Worker = () => new Worker(new URL("./design-gpu-raster.worker.ts", import.meta.url), { type: "module" })): DesignGpuRuntime {
  const chunks = new DesignRecordingChunks();
  const recordings = new DesignRecordings({ source, chunks, setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) });
  let client: DesignGpuWorkerClient | null = null, holders = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  return {
    recordings, chunks, stats: new DesignGpuStats(),
    get client() { return client; },
    acquireClient() {
      if (idle !== null) { clearTimeout(idle); idle = null; }
      if (!client || client.error) client = new DesignGpuWorkerClient(createWorker);
      holders++;
      return client;
    },
    releaseClient() {
      holders = Math.max(0, holders - 1);
      if (holders || idle !== null) return;
      idle = setTimeout(() => {
        idle = null;
        if (holders) return;
        client?.dispose();
        client = null;
      }, WORKER_IDLE_MS);
    },
  };
}

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
  return appRuntime ??= createDesignGpuRuntime(bridgeSource);
}

/** A removed workspace's recordings leave memory with it. */
export function forgetDesignGpuWorkspaces(workspaceIds: readonly string[]): void {
  appRuntime?.recordings.forgetWorkspaces(workspaceIds);
}

/** Staff with the internal flag, a Local workspace, and an engine that
 * records frames. Cloud workspaces never offer Design recordings. */
export function useDesignGpuCanvasEnabled(workspaceId: string | null | undefined): boolean {
  const flag = useInternalFeatureActive("designGpuCanvas");
  return flag && !!workspaceId && !isCloudWorkspace(workspaceId) &&
    getActiveBridge()?.supportsEngineCapability?.(DESIGN_RECORDINGS_CAPABILITY, workspaceId) === true;
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

function installInstrumentation(): void {
  const target = window as InstrumentedWindow;
  if (target.__zerosDesignGpu) return;
  const current = () => [...activeScenes].at(-1);
  target.__zerosDesignGpu = {
    version: 1,
    get last() { return lastSnapshot; },
    async snapshot() {
      const entry = current();
      const runtime = entry?.[1] ?? designGpuRuntime();
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

function uninstallInstrumentation(): void {
  if (!activeScenes.size) delete (window as InstrumentedWindow).__zerosDesignGpu;
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
      runtime.stats.error = "WebGL2 is unavailable to the recorded Design canvas.";
      return undefined;
    }
    sceneRef.current = scene;
    activeScenes.set(scene, runtime);
    installInstrumentation();
    const { owner, openKey, frames, live } = latest.current;
    scene.update({ owner, openKey, frames, live });
    return () => {
      sceneRef.current = null;
      activeScenes.delete(scene);
      uninstallInstrumentation();
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
