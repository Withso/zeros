import type { DesignPreviewLevel } from "./design-frame-previews";

/** A high-quality reduction of a picture to an exact smaller size, encoded
 * like a render. Never used to enlarge. */
export async function downscaleDesignPreview(picture: Blob, width: number, height: number, level: DesignPreviewLevel): Promise<Blob> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function")
    throw new Error("Design preview downscaling is unavailable.");
  const bitmap = await createImageBitmap(picture, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
  try {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Design preview downscaling is unavailable.");
    context.drawImage(bitmap, 0, 0);
    return encodeDesignPreview(await canvas.convertToBlob({ type: "image/png" }), level);
  } finally {
    bitmap.close();
  }
}

/** PNG → WebP; the smaller of the two is kept, so flat interface pictures may
 * stay PNG. */
export async function encodeDesignPreview(png: Blob, level: DesignPreviewLevel): Promise<Blob> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") return png;
  const bitmap = await createImageBitmap(png);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) return png;
    context.drawImage(bitmap, 0, 0);
    const webp = await canvas.convertToBlob({ type: "image/webp", quality: level === "detail" ? 0.95 : 0.9 });
    return webp.type === "image/webp" && webp.size < png.size ? webp : png;
  } finally {
    bitmap.close();
  }
}

export type DesignPreviewEncodeRequest =
  | { id: number; op: "encode"; picture: Blob; level: DesignPreviewLevel }
  | { id: number; op: "downscale"; picture: Blob; width: number; height: number; level: DesignPreviewLevel };
export type DesignPreviewEncodeReply = { id: number; blob: Blob } | { id: number; error: string };

type EncodeRequest = DesignPreviewEncodeRequest extends infer T ? T extends unknown ? Omit<T, "id"> : never : never;
interface EncodeWorker {
  postMessage(message: DesignPreviewEncodeRequest): void;
  addEventListener(type: "message" | "error", listener: (event: MessageEvent) => void): void;
  terminate(): void;
}

/** Chromium encodes OffscreenCanvas WebP on the calling thread: a new frame's
 * pictures blocked the canvas for hundreds of milliseconds right after an
 * edit. Workers encode them instead: one while pictures trickle in, up to
 * `workers` when a page opens and hundreds arrive together. Where none can
 * start (or one dies), encoding stays on this thread so pictures are never lost. */
export function createDesignPreviewEncoder(createWorker: (() => EncodeWorker) | null, workers = 1) {
  const limit = Math.max(1, Math.floor(workers));
  const pool: Array<{ worker: EncodeWorker; pending: number }> = [];
  let failed = !createWorker, next = 0;
  const pending = new Map<number, { slot: (typeof pool)[number]; resolve(blob: Blob): void; reject(error: Error): void; fallback(): Promise<Blob> }>();
  const abandon = () => {
    failed = true;
    for (const slot of pool.splice(0)) slot.worker.terminate();
    for (const [id, request] of pending) { pending.delete(id); request.fallback().then(request.resolve, request.reject); }
  };
  const start = (): (typeof pool)[number] | null => {
    if (failed) return null;
    const idle = pool.find(slot => slot.pending === 0);
    if (idle) return idle;
    if (pool.length >= limit) return pool.reduce((least, slot) => slot.pending < least.pending ? slot : least);
    let worker: EncodeWorker;
    try { worker = createWorker!(); } catch {
      if (pool.length) return pool.reduce((least, slot) => slot.pending < least.pending ? slot : least);
      failed = true;
      return null;
    }
    const slot = { worker, pending: 0 };
    pool.push(slot);
    worker.addEventListener("message", event => {
      const data = event.data as DesignPreviewEncodeReply, request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      request.slot.pending--;
      if ("blob" in data) request.resolve(data.blob); else request.reject(new Error(data.error));
    });
    worker.addEventListener("error", abandon);
    return slot;
  };
  const run = (message: EncodeRequest, fallback: () => Promise<Blob>): Promise<Blob> => {
    const slot = start();
    if (!slot) return fallback();
    const id = ++next;
    slot.pending++;
    return new Promise((resolve, reject) => {
      pending.set(id, { slot, resolve, reject, fallback });
      slot.worker.postMessage({ ...message, id } as DesignPreviewEncodeRequest);
    });
  };
  return {
    encode: (png: Blob, level: DesignPreviewLevel) => run({ op: "encode", picture: png, level }, () => encodeDesignPreview(png, level)),
    downscale: (picture: Blob, width: number, height: number, level: DesignPreviewLevel) =>
      run({ op: "downscale", picture, width, height, level }, () => downscaleDesignPreview(picture, width, height, level)),
  };
}
