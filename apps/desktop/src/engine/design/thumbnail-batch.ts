import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import {
  DESIGN_BATCH_CAPTURE_HTML_BYTES,
  DESIGN_BATCH_CAPTURE_MAX_ITEMS,
  DESIGN_BATCH_CAPTURE_PIXELS,
  DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES,
  DESIGN_BATCH_CAPTURE_TIMEOUT_MS,
  DESIGN_CAPTURE_HTML_BYTES,
  DESIGN_CAPTURE_PNG_BYTES,
  designBatchCaptureReplySchema,
  designCaptureSheetUrl,
  designThumbnailsRenderSchema,
  designThumbnailsReplySchema,
  type DesignBatchCaptureReply,
  type DesignBatchCaptureRequest,
  type DesignThumbnailsRender,
  type DesignThumbnailsReply,
} from "@zeros/protocol/design-capture";
import { resolveDesignCaptureConfig, type DesignCaptureConfig } from "./capture-client";
import { designDirectoryNameFor } from "./directory-registry";
import { assertDesignThemeName } from "./document";
import { assertFrameFile, designDirectory, readSharedCanvasContext } from "./document-storage";
import { designDirectoryEntry } from "./metadata";
import { MAX_DESIGN_TEXT_BYTES } from "./render-budget";
import { prepareFrameRenderSource } from "./render-preparation";
import { readSafeRegularFile } from "./safe-files";
import { parseDesignSource } from "./shared-parse";
import { elementRecords } from "./source";
import { frameStyleSourceIds, frameStyleSources, readDesignStyleSourceCatalog } from "./style-sources";
import { applyDesignSurfaceTheme } from "./surface-document";

/** Bump whenever composing a thumbnail changes its pixels for the same frame. */
const DESIGN_THUMBNAIL_PIPELINE = "thumbnails-1";
const MAX_LAYOUT_SIDE = 16_384;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MAX_REPLY_BYTES = DESIGN_BATCH_CAPTURE_MAX_ITEMS * Math.ceil((DESIGN_CAPTURE_PNG_BYTES * 4) / 3) + 1024 * 1024;

type Frame = { file: string; sourceVersion: string };
type Item = DesignBatchCaptureRequest["items"][number];
export interface DesignThumbnailBatch {
  request: DesignBatchCaptureRequest;
  /** Batch item id -> the frame it pictures. */
  frames: ReadonlyMap<string, Frame>;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const UNPICTURED = "This frame could not be pictured.";
/** Per-frame errors reach the renderer path-free: system errors and messages
 * naming the checkout or home directory become a generic one. */
const failure = (error: unknown, root: string) => {
  const message = error instanceof Error && !("syscall" in error) ? error.message.slice(0, 500) : "";
  return !message || message.includes(path.resolve(root)) || message.includes(homedir()) ? UNPICTURED : message;
};

/** Each placeholder of the frame's skeleton becomes a link to its sheet, in
 * place. A placeholder inside SVG keeps its CSS inline: a <link> there is
 * not a stylesheet. */
function linkSheets(skeleton: string, sheets: ReadonlyArray<{ token: string; css: string }>, link: (css: string) => string): string {
  if (sheets.length === 0) return skeleton;
  const css = new Map(sheets.map((sheet) => [sheet.token, sheet.css]));
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const { element } of elementRecords(parseDesignSource(skeleton))) {
    const token = element.tagName === "style" ? element.attrs.find((attribute) => attribute.name === "data-zeros-sheet")?.value : undefined;
    const sheet = token === undefined ? undefined : css.get(token);
    const location = element.sourceCodeLocation;
    if (sheet === undefined || !location?.startTag || !location.endTag) continue;
    const attributes = skeleton.slice(location.startTag.startOffset + "<style".length, location.startTag.endOffset - 1);
    edits.push({ start: location.startOffset, end: location.endOffset, text: element.namespaceURI === HTML_NAMESPACE
      ? `<link rel="stylesheet" href="${link(sheet)}"${attributes}>`
      : `<style${attributes}>${sheet}</style>` });
  }
  let html = skeleton;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    html = `${html.slice(0, edit.start)}${edit.text}${html.slice(edit.end)}`;
  return html;
}

/** Compose saved frames for batch capture: every frame of a page folder links
 * the same bytes for its linked stylesheets and for each imported source
 * (whole, not pruned per frame), so the capture host parses them once. A
 * Tailwind source compiles utilities per frame and stays per frame. */
export async function composeDesignThumbnailBatches(
  root: string,
  input: DesignThumbnailsRender,
  signal?: AbortSignal,
): Promise<{ batches: DesignThumbnailBatch[]; stale: Frame[]; failed: Array<{ file: string; error: string }> }> {
  if (designDirectoryEntry(root, designDirectoryNameFor(root))?.id !== input.directoryId)
    throw new Error("The active Design directory changed. Refresh before rendering thumbnails.");
  if (input.theme !== null) await assertDesignThemeName(root, input.theme);
  const { canvas } = await readSharedCanvasContext(root);
  const catalog = readDesignStyleSourceCatalog(canvas);
  const tailwind = new Set(catalog.declarations.filter((declaration) => declaration.kind === "tailwind").map((declaration) => declaration.id));
  // Keyed by the sources a frame chooses: App fonts embeds the fonts those sources import.
  const whole = new Map<string, ReadonlyMap<string, string>>();
  const wholeSources = async (file: string) => {
    const key = JSON.stringify(frameStyleSourceIds(canvas, catalog, file));
    let sources = whole.get(key);
    if (!sources) {
      sources = new Map((await frameStyleSources(root, canvas, file, { build: true }))
        .map((source) => [source.id, source.css.replace(/<\/style/gi, "<\\/style")]));
      whole.set(key, sources);
    }
    return sources;
  };
  const design = designDirectory(root);
  const stale: Frame[] = [];
  const failed: Array<{ file: string; error: string }> = [];
  const composed: Array<{ frame: Frame; item: Item; sheets: Map<string, string> }> = [];
  for (const [index, requested] of input.frames.entries()) {
    signal?.throwIfAborted();
    try {
      const file = assertFrameFile(requested.file);
      const geometry = canvas.frames[file];
      if (!geometry || !canvas.frame_info[file]) throw new Error("This frame is not on the canvas.");
      const safe = await readSafeRegularFile(design, path.join(design, file), MAX_DESIGN_TEXT_BYTES);
      if (!safe) throw new Error("The frame source is unavailable or exceeds its limit.");
      const render = await prepareFrameRenderSource(root, safe.body.toString("utf8"), { width: geometry.w, height: geometry.h },
        undefined, undefined, file, canvas, { parts: true });
      if (render.sourceVersion !== requested.sourceVersion) {
        stale.push({ file, sourceVersion: render.sourceVersion });
        continue;
      }
      const pruned = (render.sheets ?? []).map(({ token, css }) => ({ token, css }));
      let parts = pruned;
      if (render.sheets?.some((sheet) => sheet.source !== undefined && !tailwind.has(sheet.source))) {
        const sources = await wholeSources(file);
        parts = render.sheets.map((sheet) => ({ token: sheet.token,
          css: sheet.source !== undefined && !tailwind.has(sheet.source) ? sources.get(sheet.source) ?? sheet.css : sheet.css }));
        // A frame the canvas can draw is never refused for sharing: past the
        // budget it carries its own pruned CSS instead.
        const bytes = [...new Set(parts.map((part) => part.css))].reduce((total, css) => total + css.length, 0);
        if (bytes > DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES) parts = pruned;
      }
      const sheets = new Map<string, string>();
      const html = applyDesignSurfaceTheme(linkSheets(render.sanitized, parts, (css) => {
        const hash = sha256(css);
        sheets.set(hash, css);
        return designCaptureSheetUrl(hash);
      }), input.theme);
      if (html.length > DESIGN_CAPTURE_HTML_BYTES) throw new Error("This frame is too large to picture.");
      composed.push({ frame: { file, sourceVersion: requested.sourceVersion }, sheets, item: {
        id: `f${index}`, html, maxDimension: input.maxDimension,
        viewport: {
          width: Math.max(1, Math.min(MAX_LAYOUT_SIDE, Math.ceil(geometry.w))),
          height: Math.max(1, Math.min(MAX_LAYOUT_SIDE, Math.ceil(geometry.h))),
        },
      } });
    } catch (error) {
      if (signal?.aborted) throw error;
      failed.push({ file: requested.file, error: failure(error, root) });
    }
  }
  // Split into requests the capture host admits: items, pixels and bytes.
  const batches: DesignThumbnailBatch[] = [];
  let current: { items: Item[]; frames: Map<string, Frame>; sheets: Map<string, string>; pixels: number; html: number; css: number } | null = null;
  const close = () => {
    if (current?.items.length) batches.push({
      request: { version: 1, revision: randomUUID(), colorScheme: input.colorScheme, stylesheets: Object.fromEntries(current.sheets), items: current.items },
      frames: current.frames,
    });
    current = null;
  };
  for (const { frame, item, sheets } of composed) {
    const pixels = item.maxDimension * item.maxDimension;
    const added = (target: NonNullable<typeof current>) =>
      [...sheets].reduce((total, [hash, css]) => total + (target.sheets.has(hash) ? 0 : css.length), 0);
    const own = [...sheets.values()].reduce((total, css) => total + css.length, 0);
    if (own > DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES) {
      failed.push({ file: frame.file, error: "This frame's stylesheets are too large to picture." });
      continue;
    }
    if (current && (current.items.length >= DESIGN_BATCH_CAPTURE_MAX_ITEMS || current.pixels + pixels > DESIGN_BATCH_CAPTURE_PIXELS ||
      current.html + item.html.length > DESIGN_BATCH_CAPTURE_HTML_BYTES || current.css + added(current) > DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES))
      close();
    current ??= { items: [], frames: new Map(), sheets: new Map(), pixels: 0, html: 0, css: 0 };
    current.css += added(current);
    for (const [hash, css] of sheets) current.sheets.set(hash, css);
    current.items.push(item);
    current.frames.set(item.id, frame);
    current.pixels += pixels;
    current.html += item.html.length;
  }
  close();
  return { batches, stale, failed };
}

function waitForCapacity(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** POST one batch to the capture host. A busy host (429) is retried with
 * backoff within the batch deadline; closing the request ends the batch. */
export async function requestDesignBatchCapture(
  config: DesignCaptureConfig,
  request: DesignBatchCaptureRequest,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<DesignBatchCaptureReply> {
  const body = JSON.stringify(request);
  const deadline = Date.now() + DESIGN_BATCH_CAPTURE_TIMEOUT_MS;
  for (let delay = 100; ; delay = Math.min(delay * 2, 1_000)) {
    signal?.throwIfAborted();
    const response = await fetchImpl(`${config.url}/batch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      redirect: "error",
      body,
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(DESIGN_BATCH_CAPTURE_TIMEOUT_MS + 5_000)]),
    });
    if (response.status === 429 && Date.now() + delay < deadline) {
      await response.body?.cancel();
      await waitForCapacity(delay, signal);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 429
        ? "Design capture capacity reached. Thumbnails wait for the active capture."
        : "Design capture host could not render these thumbnails.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Design capture returned no thumbnails.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPLY_BYTES) {
        await reader.cancel();
        throw new Error("Design capture returned too much data.");
      }
      chunks.push(value);
    }
    const reply = designBatchCaptureReplySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (reply.revision !== request.revision) throw new Error("Design capture answered another batch.");
    return reply;
  }
}

/** design.thumbnails.render on one Local workspace. */
export async function renderDesignThumbnails(
  root: string,
  raw: unknown,
  deps: {
    signal?: AbortSignal;
    capture?: (request: DesignBatchCaptureRequest, signal?: AbortSignal) => Promise<DesignBatchCaptureReply>;
  } = {},
): Promise<DesignThumbnailsReply> {
  const input = designThumbnailsRenderSchema.parse(raw);
  const config = deps.capture ? null : resolveDesignCaptureConfig();
  if (!deps.capture && !config) throw new Error("No qualified Design capture host is available.");
  const capture = deps.capture ?? ((request, signal) => requestDesignBatchCapture(config!, request, signal));
  const { batches, stale, failed } = await composeDesignThumbnailBatches(root, input, deps.signal);
  const pictures: DesignThumbnailsReply["pictures"] = [];
  let renderer: string | null = null;
  for (const batch of batches) {
    const reply = await capture(batch.request, deps.signal);
    renderer ??= reply.renderer;
    const answered = new Map(reply.items.map((item) => [item.id, item]));
    for (const [id, frame] of batch.frames) {
      const item = answered.get(id);
      if (!item) failed.push({ file: frame.file, error: "Design capture returned no picture for this frame." });
      else if ("error" in item) failed.push({ file: frame.file, error: failure(new Error(item.error), root) });
      // The reply names one pipeline, so pictures from a host that restarted between batches can't join it.
      else if (reply.renderer !== renderer) failed.push({ file: frame.file, error: "The capture renderer changed; try again." });
      else pictures.push({ ...frame, mimeType: "image/png", width: item.width, height: item.height, data: item.data });
    }
  }
  return designThumbnailsReplySchema.parse({
    pipeline: renderer === null ? DESIGN_THUMBNAIL_PIPELINE : `${DESIGN_THUMBNAIL_PIPELINE}:${renderer}`,
    pictures, stale, failed,
  });
}
