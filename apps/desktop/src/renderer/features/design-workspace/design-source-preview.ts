import { DESIGN_CAPTURE_MAX_DIMENSION, type DesignPreviewReply } from "@zeros/protocol/design-capture";
import { DESIGN_SURFACE_LAYOUT, DESIGN_SURFACE_LAYOUT_REQUEST, DESIGN_SURFACE_READY } from "@zeros/protocol/design-surface";
import { designProtocolFrameUrl } from "../../platform/bridge/design-protocol-url";
import {
  designSourceLoadSlots,
  designSourceVectorCache,
  designSourceVectorDataUrl,
  type DesignSourceVectorTarget,
} from "./design-source-vector";

/** Pictures from a frame's passive source vector: the sanitized SVG the canvas
 * tiles already draw, rasterized once at a picture level. A temporary sandboxed
 * document lays the frame out through the shared source load slots, publishes
 * its vector to the warm vector cache (a later zoom-in reuses it) and retires
 * at once, so no document outlives its picture. The native capture host stays
 * the fallback for content the vector path cannot represent. */
export interface DesignSourcePreviewDeps {
  /** Lays out the surface document and resolves its serialized vector. */
  loadVector(target: DesignSourceVectorTarget, signal?: AbortSignal): Promise<unknown>;
  /** Draws a vector data URL at the given device size and returns a PNG. */
  rasterize(url: string, width: number, height: number, signal?: AbortSignal): Promise<Blob>;
  /** Resolves once no camera gesture is live. Rasterizing lays the vector
   * out again on the renderer thread, so it never runs mid-gesture. */
  quiet?(signal?: AbortSignal): Promise<void>;
}

export async function renderDesignSourcePreview(
  target: DesignSourceVectorTarget,
  maxDimension: number,
  signal?: AbortSignal,
  deps: DesignSourcePreviewDeps = { loadVector: loadDesignSurfaceVector, rasterize: rasterizeDesignVector },
  /** A frame without an admitted surface cost never enters the warm vector
   * cache: its vector serves this one picture and is dropped. */
  options: { cache?: boolean; timing?: (stage: "load" | "raster" | "encode", ms: number) => void } = {},
): Promise<DesignPreviewReply> {
  if (!(target.width > 0 && target.height > 0 && maxDimension > 0)) throw new Error("Invalid Design preview size.");
  const scale = Math.min(maxDimension, DESIGN_CAPTURE_MAX_DIMENSION) / Math.max(target.width, target.height);
  const width = Math.max(1, Math.round(target.width * scale)), height = Math.max(1, Math.round(target.height * scale));
  const request = options.cache === false ? null : designSourceVectorCache.open(target);
  let lease = request?.cached ?? null;
  try {
    let url = lease?.url ?? null;
    let started = performance.now();
    const stage = (name: "load" | "raster" | "encode") => {
      const now = performance.now();
      options.timing?.(name, now - started);
      started = now;
    };
    if (!url) {
      const svg = await deps.loadVector(target, signal);
      signal?.throwIfAborted();
      lease = request?.publish(svg) ?? null;
      url = lease?.url ?? designSourceVectorDataUrl(svg);
    }
    stage("load");
    if (!url) throw new Error("Design source vector is unavailable for this frame.");
    await deps.quiet?.(signal);
    signal?.throwIfAborted();
    started = performance.now();
    const png = await deps.rasterize(url, width, height, signal);
    signal?.throwIfAborted();
    stage("raster");
    // The vector decoded: keep it warm for a later zoom-in to source tiles.
    lease?.confirm();
    const data = await base64(png);
    stage("encode");
    return { sourceVersion: target.sourceVersion, theme: target.theme, mimeType: "image/png", width, height, data };
  } finally {
    lease?.release();
    request?.close();
  }
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export async function rasterizeDesignVector(url: string, width: number, height: number, signal?: AbortSignal): Promise<Blob> {
  const image = new Image();
  image.decoding = "async";
  const canvas = new OffscreenCanvas(width, height);
  try {
    image.src = url;
    await image.decode();
    signal?.throwIfAborted();
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Design preview rasterization is unavailable.");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
  } finally {
    // A decoded SVG image keeps its own laid-out document until its source
    // is removed; a page of pictures otherwise retains hundreds of them.
    image.removeAttribute("src");
  }
  return canvas.convertToBlob({ type: "image/png" });
}

let host: HTMLDivElement | null = null;
function previewHost(): HTMLDivElement {
  if (host?.isConnected) return host;
  host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.dataset.designSourcePreviewHost = "";
  // Out of view and clipped: each document still lays out at its own frame
  // size, and its ready script never waits for an animation frame.
  host.style.cssText = "position:fixed;left:-100000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;contain:strict";
  document.body.appendChild(host);
  return host;
}

/** One temporary surface document per picture, admitted through the same
 * bounded slots as canvas source loads and fenced by window and generation. */
export function loadDesignSurfaceVector(target: DesignSourceVectorTarget, signal?: AbortSignal): Promise<unknown> {
  const url = designProtocolFrameUrl({ workspaceId: target.workspaceId, capability: target.capability,
    frame: target.file, sourceVersion: target.sourceVersion, surface: true, theme: target.theme });
  if (!url) return Promise.reject(new Error("Design surface URL is unavailable."));
  return new Promise((resolve, reject) => {
    let iframe: HTMLIFrameElement | null = null, timer = 0, layoutFrame = 0, settled = false;
    const finish = (error: Error | null, svg?: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer); window.cancelAnimationFrame(layoutFrame);
      window.removeEventListener("message", message);
      signal?.removeEventListener("abort", aborted);
      iframe?.remove(); iframe = null;
      ticket.release();
      if (error) reject(error); else resolve(svg);
    };
    const aborted = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("Design preview cancelled."));
    const deliverLayout = () => {
      if (!iframe || settled) return;
      iframe.getBoundingClientRect();
      iframe.contentWindow?.postMessage({ kind: DESIGN_SURFACE_LAYOUT, sourceVersion: target.sourceVersion, theme: target.theme }, "*");
    };
    const paintLayout = () => {
      deliverLayout();
      window.cancelAnimationFrame(layoutFrame);
      layoutFrame = window.requestAnimationFrame(() => { layoutFrame = window.requestAnimationFrame(() => { layoutFrame = 0; deliverLayout(); }); });
    };
    const message = (event: MessageEvent) => {
      if (settled || !iframe || event.source !== iframe.contentWindow || !event.data ||
        event.data.sourceVersion !== target.sourceVersion || event.data.theme !== target.theme) return;
      if (event.data.kind === DESIGN_SURFACE_LAYOUT_REQUEST) { paintLayout(); return; }
      if (event.data.kind !== DESIGN_SURFACE_READY) return;
      if (typeof event.data.svg !== "string") { finish(new Error("Design surface produced no vector.")); return; }
      finish(null, event.data.svg);
    };
    const ticket = designSourceLoadSlots.request(() => {
      if (settled) return;
      const node = document.createElement("iframe");
      iframe = node;
      node.setAttribute("sandbox", "allow-scripts");
      node.setAttribute("aria-hidden", "true");
      node.tabIndex = -1;
      node.toggleAttribute("inert", true);
      node.style.cssText = `position:absolute;left:0;top:0;border:0;width:${target.width}px;height:${target.height}px;color-scheme:normal`;
      node.addEventListener("load", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => finish(new Error("Design surface did not become ready.")), 5_000);
        paintLayout();
      }, { once: true });
      window.addEventListener("message", message);
      timer = window.setTimeout(() => finish(new Error("Design surface did not load.")), 30_000);
      node.src = url;
      previewHost().appendChild(node);
    });
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
