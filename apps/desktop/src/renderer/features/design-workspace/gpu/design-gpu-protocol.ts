// Messages between the canvas (main thread) and its CanvasKit raster worker.
// The main thread owns recordings, chunks and the visible composite; the
// worker owns CanvasKit, its pictures and their rasterization.

export interface DesignGpuRasterPicture {
  /** Recording content key (DesignAdoptedRecording.key). */
  readonly key: string;
  /** Recording pixels per CSS pixel. */
  readonly scale: number;
  /** The frame in CSS pixels; drawing is clipped to it. */
  readonly width: number;
  readonly height: number;
  /** Placement in recording pixels and the layer's reassembled picture. */
  readonly layers: ReadonlyArray<{ readonly x: number; readonly y: number; readonly bytes: ArrayBuffer }>;
}

export interface DesignGpuRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface DesignGpuRasterUnit {
  readonly key: string;
  readonly picture: string;
  readonly kind: "sprite" | "tile";
  readonly density: number;
  /** The rasterized part of the frame, in its device pixels at `density`. */
  readonly raster: DesignGpuRect;
  /** Where it goes on the burst's staging surface. */
  readonly at: { readonly x: number; readonly y: number };
}

export interface DesignGpuWorkerStats {
  readonly pictures: { readonly count: number; readonly bytes: number; readonly budget: number; readonly evicted: number };
  readonly deserialize: readonly number[];
  readonly raster: { readonly sprite: readonly number[]; readonly tile: readonly number[] };
  readonly wasmHeapBytes: number;
  readonly typefaces: { readonly shared: number; readonly registered: number; readonly registeredBytes: number };
  readonly gpuCacheBytes: number;
  readonly contextLosses: number;
}

export type DesignGpuWorkerRequest =
  | { readonly type: "init"; readonly pictureBudget: number; readonly gpuCacheBudget: number }
  | { readonly type: "fonts"; readonly fonts: ReadonlyArray<{ readonly id: string; readonly bytes: ArrayBuffer }> }
  | { readonly type: "pictures"; readonly pictures: readonly DesignGpuRasterPicture[] }
  | { readonly type: "raster"; readonly job: number; readonly width: number; readonly height: number;
      readonly units: readonly DesignGpuRasterUnit[]; readonly budgetMs: number }
  /** Pictures and typefaces of owners the canvas no longer shows. */
  | { readonly type: "forget"; readonly pictures: readonly string[]; readonly clearTypefaces: boolean }
  | { readonly type: "stats"; readonly id: number }
  | { readonly type: "lose-context" }
  | { readonly type: "dispose" };

export type DesignGpuWorkerReply =
  | { readonly type: "ready"; readonly gpu: boolean; readonly wasmHeapBytes: number }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "pictures"; readonly added: readonly string[];
      readonly failed: ReadonlyArray<{ readonly key: string; readonly error: string }>; readonly evicted: readonly string[] }
  | { readonly type: "rastered"; readonly job: number; readonly bitmap: ImageBitmap | null;
      readonly width: number; readonly height: number;
      readonly done: readonly string[]; readonly missing: readonly string[]; readonly evicted: readonly string[];
      readonly ms: number; readonly error?: string }
  | { readonly type: "stats"; readonly id: number; readonly stats: DesignGpuWorkerStats }
  | { readonly type: "context"; readonly lost: boolean };
