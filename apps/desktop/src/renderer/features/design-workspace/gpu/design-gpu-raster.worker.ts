/// <reference lib="webworker" />
// CanvasKit raster worker for the recorded Design canvas. It deserializes
// recorded pictures and rasterizes bursts of units with WebGL2 on its own
// OffscreenCanvas; each burst returns as one ImageBitmap the canvas's
// compositor uploads. Nothing here touches the DOM, and WebAssembly is
// compiled only in this worker.

import type { GrDirectContext, Surface } from "canvaskit-wasm";

import CanvasKitInit from "./canvaskit/canvaskit.js";
import type { DesignCanvasKit } from "./canvaskit/canvaskit";
import wasmUrl from "./canvaskit/canvaskit.wasm?url";
import type { DesignGpuWorkerReply, DesignGpuWorkerRequest } from "./design-gpu-protocol";
import { DesignGpuPictures, DesignGpuRasterizer } from "./design-gpu-rasterizer";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (reply: DesignGpuWorkerReply, transfer: Transferable[] = []) => scope.postMessage(reply, transfer);

let ck: DesignCanvasKit | null = null;
let canvas: OffscreenCanvas | null = null;
let handle = 0;
let gpu: GrDirectContext | null = null;
let gpuCacheBudget = 0;
let surface: Surface | null = null;
let pictures: DesignGpuPictures | null = null;
let rasterizer: DesignGpuRasterizer<ImageBitmap> | null = null;
let lost = false;
let contextLosses = 0;

function attachContext(): boolean {
  if (!ck || !canvas) return false;
  handle = ck.GetWebGLContext(canvas, { majorVersion: 2, alpha: 1, antialias: 0, depth: 0, premultipliedAlpha: 1,
    preserveDrawingBuffer: 0 });
  gpu = handle ? ck.MakeWebGLContext(handle) : null;
  if (!gpu) return false;
  gpu.setResourceCacheLimitBytes(gpuCacheBudget);
  return true;
}

function detachContext(): void {
  surface?.delete();
  surface = null;
  // The native resources are gone with the context; abandon them rather
  // than letting Skia issue GL calls into a lost context.
  gpu?.releaseResourcesAndAbandonContext();
  gpu?.delete();
  gpu = null;
}

const backend = {
  surface(width: number, height: number): Surface | null {
    if (lost || !ck || !canvas || !gpu) return null;
    if (!surface || canvas.width !== width || canvas.height !== height) {
      surface?.delete();
      canvas.width = width;
      canvas.height = height;
      surface = ck.MakeOnScreenGLSurface(gpu, width, height, ck.ColorSpace.SRGB);
    }
    return surface;
  },
  finish(drawn: Surface): ImageBitmap {
    drawn.flush();
    return canvas!.transferToImageBitmap();
  },
};

async function init(request: Extract<DesignGpuWorkerRequest, { type: "init" }>): Promise<void> {
  ck = await CanvasKitInit({ locateFile: () => wasmUrl });
  canvas = new OffscreenCanvas(256, 256);
  gpuCacheBudget = request.gpuCacheBudget;
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    lost = true;
    contextLosses++;
    detachContext();
    post({ type: "context", lost: true });
  });
  canvas.addEventListener("webglcontextrestored", () => {
    lost = !attachContext();
    post({ type: "context", lost });
  });
  if (!attachContext()) throw new Error("WebGL2 is unavailable to the Design raster worker.");
  pictures = new DesignGpuPictures(ck, request.pictureBudget);
  rasterizer = new DesignGpuRasterizer(ck, pictures, backend);
  post({ type: "ready", gpu: true, wasmHeapBytes: ck.HEAPU8.buffer.byteLength });
}

function percentileSamples(values: readonly number[]): number[] {
  return values.slice(-1_024);
}

function serve(request: DesignGpuWorkerRequest): void {
  switch (request.type) {
    case "fonts": {
      for (const font of request.fonts) {
        if (!ck || ck.HasDesignTypeface(font.id)) continue;
        const bytes = new Uint8Array(font.bytes);
        const pointer = ck._malloc(bytes.length);
        ck.HEAPU8.set(bytes, pointer);
        ck._RegisterDesignTypeface(font.id, pointer, bytes.length);
      }
      return;
    }
    case "pictures": {
      if (!pictures) return;
      post({ type: "pictures", ...pictures.put(request.pictures) });
      return;
    }
    case "raster": {
      if (!rasterizer) return;
      try {
        const result = rasterizer.raster(request);
        post({ type: "rastered", job: request.job, bitmap: result.output, width: request.width, height: request.height,
          done: result.done, missing: result.missing, evicted: pictures!.trim(), ms: result.ms },
        result.output ? [result.output] : []);
      } catch (error) {
        post({ type: "rastered", job: request.job, bitmap: null, width: request.width, height: request.height, done: [],
          missing: [], evicted: [], ms: 0, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    case "forget": {
      pictures?.forget(request.pictures);
      if (request.clearTypefaces) ck?.ClearTypefaceCache();
      return;
    }
    case "stats": {
      if (!ck || !pictures || !rasterizer) return;
      post({ type: "stats", id: request.id, stats: {
        pictures: pictures.usage(),
        deserialize: percentileSamples(pictures.deserializeMs),
        raster: { sprite: percentileSamples(rasterizer.rasterMs.sprite), tile: percentileSamples(rasterizer.rasterMs.tile) },
        wasmHeapBytes: ck.HEAPU8.buffer.byteLength,
        typefaces: { shared: ck.TypefaceCacheCount(), registered: ck.DesignTypefaceRegistryCount(),
          registeredBytes: ck.DesignTypefaceRegistryBytes() },
        gpuCacheBytes: gpu?.getResourceCacheUsageBytes() ?? 0,
        contextLosses,
      } });
      return;
    }
    case "lose-context": {
      const gl = canvas?.getContext("webgl2") as WebGL2RenderingContext | null;
      const extension = gl?.getExtension("WEBGL_lose_context");
      extension?.loseContext();
      setTimeout(() => extension?.restoreContext(), 0);
      return;
    }
    case "dispose": {
      pictures?.dispose();
      detachContext();
      scope.close();
      return;
    }
    case "init":
      return;
  }
}

// Requests sent while CanvasKit compiles wait behind it, in arrival order.
let initialized: Promise<void> = Promise.resolve();
scope.addEventListener("message", (event: MessageEvent<DesignGpuWorkerRequest>) => {
  const request = event.data;
  if (request.type === "init") {
    initialized = init(request).catch((error: unknown) => {
      post({ type: "failed", error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  void initialized.then(() => serve(request));
});
