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
 * edit. One worker encodes them instead; where none can start (or it dies),
 * encoding stays on this thread so pictures are never lost. */
export function createDesignPreviewEncoder(createWorker: (() => EncodeWorker) | null) {
  let worker: EncodeWorker | null = null, failed = !createWorker, next = 0;
  const pending = new Map<number, { resolve(blob: Blob): void; reject(error: Error): void; fallback(): Promise<Blob> }>();
  const abandon = () => {
    failed = true; worker?.terminate(); worker = null;
    for (const [id, request] of pending) { pending.delete(id); request.fallback().then(request.resolve, request.reject); }
  };
  const start = (): EncodeWorker | null => {
    if (worker || failed) return worker;
    try { worker = createWorker!(); } catch { failed = true; return null; }
    worker.addEventListener("message", event => {
      const data = event.data as DesignPreviewEncodeReply, request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if ("blob" in data) request.resolve(data.blob); else request.reject(new Error(data.error));
    });
    worker.addEventListener("error", abandon);
    return worker;
  };
  const run = (message: EncodeRequest, fallback: () => Promise<Blob>): Promise<Blob> => {
    const target = start();
    if (!target) return fallback();
    const id = ++next;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, fallback });
      target.postMessage({ ...message, id } as DesignPreviewEncodeRequest);
    });
  };
  return {
    encode: (png: Blob, level: DesignPreviewLevel) => run({ op: "encode", picture: png, level }, () => encodeDesignPreview(png, level)),
    downscale: (picture: Blob, width: number, height: number, level: DesignPreviewLevel) =>
      run({ op: "downscale", picture, width, height, level }, () => downscaleDesignPreview(picture, width, height, level)),
  };
}
