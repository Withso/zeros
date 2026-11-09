import { DesignGpuStats } from "./design-gpu-stats";
import { DesignGpuWorkerClient } from "./design-gpu-worker-client";
import { DesignRecordingChunks } from "./design-recording-chunks";
import { DesignRecordings, type DesignRecordingsSource } from "./design-recordings";

/** The raster worker retires this long after the last recorded canvas closes,
 * releasing its WebAssembly heap (which never shrinks while it lives). */
export const DESIGN_GPU_WORKER_IDLE_MS = 60_000;
/** A worker whose heap grew past this retires as soon as no canvas holds it. */
export const DESIGN_GPU_WORKER_HEAP_BYTES = 512 * 1024 * 1024;

export interface DesignGpuRuntime {
  readonly recordings: DesignRecordings;
  readonly chunks: DesignRecordingChunks;
  readonly stats: DesignGpuStats;
  acquireClient(): DesignGpuWorkerClient;
  releaseClient(): void;
  readonly client: DesignGpuWorkerClient | null;
}

/** Recordings, chunks and bench stats for the recorded canvas, and the one
 * raster worker its canvases share while any of them holds it. */
export function createDesignGpuRuntime(source: DesignRecordingsSource, createWorker: () => Worker, timers: {
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
} = { setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }):
  DesignGpuRuntime {
  const chunks = new DesignRecordingChunks();
  const recordings = new DesignRecordings({ source, chunks, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  let client: DesignGpuWorkerClient | null = null, holders = 0;
  let idle: unknown = null;
  const retire = (retiring: DesignGpuWorkerClient) => {
    if (idle !== null) { timers.clearTimer(idle); idle = null; }
    if (holders || client !== retiring) return;
    retiring.dispose();
    client = null;
  };
  return {
    recordings, chunks, stats: new DesignGpuStats(),
    get client() { return client; },
    acquireClient() {
      if (idle !== null) { timers.clearTimer(idle); idle = null; }
      if (!client || client.error) client = new DesignGpuWorkerClient(createWorker);
      holders++;
      return client;
    },
    releaseClient() {
      holders = Math.max(0, holders - 1);
      const retiring = client;
      if (holders || idle !== null || !retiring) return;
      idle = timers.setTimer(() => { idle = null; retire(retiring); }, DESIGN_GPU_WORKER_IDLE_MS);
      void retiring.requestStats().then((stats) => {
        if (stats && stats.wasmHeapBytes > DESIGN_GPU_WORKER_HEAP_BYTES) retire(retiring);
      });
    },
  };
}
