import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "parse5";
import {
  DESIGN_BATCH_CAPTURE_HTML_BYTES,
  DESIGN_BATCH_CAPTURE_MAX_ITEMS,
  DESIGN_BATCH_CAPTURE_PIXELS,
  DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES,
  DESIGN_BATCH_CAPTURE_TIMEOUT_MS,
  DESIGN_CAPTURE_HTML_BYTES,
  DESIGN_CAPTURE_PNG_BYTES,
  DESIGN_THUMBNAILS_REPLY_DATA_BYTES,
  designBatchCaptureReplySchema,
  designCaptureSheetUrl,
  designThumbnailsReadReplySchema,
  designThumbnailsReadSchema,
  designThumbnailsRenderSchema,
  designThumbnailsReplySchema,
  type DesignBatchCaptureReply,
  type DesignBatchCaptureRequest,
  type DesignThumbnailsReadReply,
  type DesignThumbnailsRender,
  type DesignThumbnailsReply,
} from "@zeros/protocol/design-capture";
import { resolveDesignCaptureConfig, type DesignCaptureConfig } from "./capture-client";
import { designDirectoryNameFor } from "./directory-registry";
import { designCatalogRevision, inspectDesignCatalog } from "./catalog-storage";
import { assertDesignThemeName, prepareRegisteredDesignFrameParts } from "./document";
import { assertFrameFile, designDirectory, readSharedCanvasContext } from "./document-storage";
import { designDirectoryEntry } from "./metadata";
import { MAX_DESIGN_TEXT_BYTES } from "./render-budget";
import { prepareFrameRenderSource } from "./render-preparation";
import { readSafeRegularFile } from "./safe-files";
import { parseDesignSource } from "./shared-parse";
import { elementRecords } from "./source";
import { frameStyleSourceIds, frameStyleSources, readDesignStyleSourceCatalog } from "./style-sources";
import { applyDesignSurfaceTheme } from "./surface-document";
import {
  DESIGN_THUMBNAIL_COMPOSER,
  currentDesignThumbnailPipeline,
  designThumbnailPipeline,
  noteDesignThumbnailPipeline,
  readStoredDesignThumbnail,
  storeDesignThumbnail,
  type DesignThumbnailVariant,
} from "./thumbnail-store";

const MAX_LAYOUT_SIDE = 16_384;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MAX_REPLY_BYTES = DESIGN_BATCH_CAPTURE_MAX_ITEMS * Math.ceil((DESIGN_CAPTURE_PNG_BYTES * 4) / 3) + 1024 * 1024;

type Frame = { file: string; sourceVersion: string };
/** A frame sent without a version is pictured, and prepared, as it is now. */
type Requested = { file: string; sourceVersion?: string };
type PreparedFrame = NonNullable<DesignThumbnailsReply["prepared"]>[number];
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

// Placeholders are the engine's own empty <style> elements, inserted as text,
// so a string search finds the ones the canvas splices into.
const PLACEHOLDER = /<style((?: [^\s"'>/=]+="[^"<>]*")*)><\/style>/g;
const BEFORE_HEAD = /<(?:head|body)[\s/>]/i;

type Part = { token: string; css: string; foreign?: true };

/** Each placeholder of the frame's skeleton becomes a link to its sheet, in
 * place. A placeholder inside SVG keeps its CSS inline: a <link> there is
 * not a stylesheet. */
function linkSheets(skeleton: string, sheets: readonly Part[], link: (css: string) => string): string {
  if (sheets.length === 0) return skeleton;
  const parts = new Map(sheets.map((sheet) => [sheet.token, sheet]));
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const match of skeleton.matchAll(PLACEHOLDER)) {
    const token = /(?:^| )data-zeros-sheet="([^"]*)"/.exec(match[1]!)?.[1];
    const part = token === undefined ? undefined : parts.get(token);
    if (!part) continue;
    edits.push({ start: match.index, end: match.index + match[0].length, text: part.foreign
      ? `<style${match[1]}>${part.css}</style>`
      : `<link rel="stylesheet" href="${link(part.css)}"${match[1]}>` });
  }
  if (edits.length !== parts.size) return linkParsedSheets(skeleton, parts, link);
  let html = "", at = 0;
  for (const edit of edits) {
    html += skeleton.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return html + skeleton.slice(at);
}

/** The canvas's theme on the root element, as applyDesignSurfaceTheme sets
 * it, parsing only the text before <head> or <body> that holds the root tag. */
function themeRoot(html: string, theme: string | null): string {
  const end = html.search(BEFORE_HEAD);
  const prefix = end > 0 ? parse(html.slice(0, end), { sourceCodeLocationInfo: true }) : null;
  const location = prefix && elementRecords(prefix).find(({ element }) => element.tagName === "html")?.element.sourceCodeLocation;
  if (!location?.startTag) return applyDesignSurfaceTheme(html, theme);
  const authored = location.attrs?.["data-zd-theme"];
  const attribute = theme === null ? "" : `data-zd-theme="${theme}"`;
  if (authored) return `${html.slice(0, authored.startOffset)}${attribute}${html.slice(authored.endOffset)}`;
  if (theme === null) return html;
  const at = location.startTag.startOffset + "<html".length;
  return `${html.slice(0, at)} ${attribute}${html.slice(at)}`;
}

/** The same edits, found by a parse when the text search does not account for every sheet. */
function linkParsedSheets(skeleton: string, parts: ReadonlyMap<string, Part>, link: (css: string) => string): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const { element } of elementRecords(parseDesignSource(skeleton))) {
    const token = element.tagName === "style" ? element.attrs.find((attribute) => attribute.name === "data-zeros-sheet")?.value : undefined;
    const sheet = token === undefined ? undefined : parts.get(token)?.css;
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

async function assertThumbnailTarget(root: string, input: { directoryId: string; theme: string | null }): Promise<void> {
  if (designDirectoryEntry(root, designDirectoryNameFor(root))?.id !== input.directoryId)
    throw new Error("The active Design directory changed. Refresh before rendering thumbnails.");
  if (input.theme !== null) await assertDesignThemeName(root, input.theme);
}

function frameId(canvas: { frame_info: Record<string, unknown> }, file: string): string | null {
  const id = (canvas.frame_info[file] as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : null;
}


/** Compose saved frames for batch capture: every frame of a page folder links
 * the same bytes for its linked stylesheets and for each imported source
 * (whole, not pruned per frame), so the capture host parses them once. A
 * Tailwind source compiles utilities per frame and stays per frame. */
export async function composeDesignThumbnailBatches(
  root: string,
  input: DesignThumbnailsRender,
  signal?: AbortSignal,
): Promise<{ batches: DesignThumbnailBatch[]; stale: Frame[]; failed: Array<{ file: string; error: string }>; prepared: PreparedFrame[] }> {
  await assertThumbnailTarget(root, input);
  // Records are only as good as the catalog they came from: the caller's
  // revision, unchanged from before the first build to after the last.
  let prepared: PreparedFrame[] | null = input.frames.some((frame) => frame.sourceVersion === undefined)
    && catalogAt(root, input.catalogRevision) ? [] : null;
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
      let render: Awaited<ReturnType<typeof prepareFrameRenderSource>>;
      if (requested.sourceVersion === undefined) {
        const built = await prepareRegisteredDesignFrameParts(root, file, canvas);
        prepared?.push(built.frame as PreparedFrame);
        render = built.render;
      } else {
        const safe = await readSafeRegularFile(design, path.join(design, file), MAX_DESIGN_TEXT_BYTES);
        if (!safe) throw new Error("The frame source is unavailable or exceeds its limit.");
        render = await prepareFrameRenderSource(root, safe.body.toString("utf8"), { width: geometry.w, height: geometry.h },
          undefined, undefined, file, canvas, { parts: true });
        if (render.sourceVersion !== requested.sourceVersion) {
          stale.push({ file, sourceVersion: render.sourceVersion });
          continue;
        }
      }
      const pruned: Part[] = (render.sheets ?? []).map(({ token, css, foreign }) => ({ token, css, ...(foreign ? { foreign } : {}) }));
      let parts = pruned;
      if (render.sheets?.some((sheet) => sheet.source !== undefined && !tailwind.has(sheet.source))) {
        const sources = await wholeSources(file);
        parts = pruned.map((part, index) => {
          const source = render.sheets![index]!.source;
          return source !== undefined && !tailwind.has(source) ? { ...part, css: sources.get(source) ?? part.css } : part;
        });
        // A frame the canvas can draw is never refused for sharing: past the
        // budget it carries its own pruned CSS instead.
        const bytes = [...new Set(parts.map((part) => part.css))].reduce((total, css) => total + css.length, 0);
        if (bytes > DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES) parts = pruned;
      }
      const sheets = new Map<string, string>();
      const html = linkSheets(themeRoot(render.sanitized, input.theme), parts, (css) => {
        const hash = sha256(css);
        sheets.set(hash, css);
        return designCaptureSheetUrl(hash);
      });
      if (html.length > DESIGN_CAPTURE_HTML_BYTES) throw new Error("This frame is too large to picture.");
      composed.push({ frame: { file, sourceVersion: render.sourceVersion }, sheets, item: {
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
  if (prepared && !catalogAt(root, input.catalogRevision)) prepared = null;
  return { batches, stale, failed, prepared: prepared ?? [] };
}

function catalogAt(root: string, revision: string | undefined): boolean {
  if (revision === undefined) return false;
  try {
    return designCatalogRevision(inspectDesignCatalog(root, designDirectoryNameFor(root), { revision: false })) === revision;
  } catch {
    return false;
  }
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

let captureTail: Promise<void> = Promise.resolve();
/** The host captures one batch at a time. Batches composed meanwhile take
 * turns here rather than polling its busy reply; a cancelled one leaves the
 * line at once. */
async function inCaptureTurn<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const previous = captureTail;
  let release!: () => void;
  captureTail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      void previous.then(() => { signal?.removeEventListener("abort", abort); resolve(); });
    });
    return await run();
  } finally {
    release();
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
  await assertThumbnailTarget(root, input);
  const { canvas } = await readSharedCanvasContext(root);
  const variant: DesignThumbnailVariant = { theme: input.theme, colorScheme: input.colorScheme, maxDimension: input.maxDimension };
  const pictures: DesignThumbnailsReply["pictures"] = [];
  const deferred: Frame[] = [];
  let budget = DESIGN_THUMBNAILS_REPLY_DATA_BYTES;
  const take = (frame: Frame, picture: { width: number; height: number; data: string }) => {
    if (picture.data.length > budget) {
      deferred.push(frame);
      budget = 0;
      return;
    }
    budget -= picture.data.length;
    pictures.push({ ...frame, mimeType: "image/png", width: picture.width, height: picture.height, data: picture.data });
  };
  // A stored picture answers only when the host's pipeline is known exactly:
  // after an app update, the last pipeline seen is not the one drawing now.
  const current = await currentDesignThumbnailPipeline();
  const misses: Requested[] = [];
  for (const frame of input.frames) {
    const id = frameId(canvas, frame.file);
    const stored = current.exact && id && frame.sourceVersion !== undefined
      ? await readStoredDesignThumbnail(root, input.directoryId, id, variant) : null;
    if (stored && stored.sourceVersion === frame.sourceVersion && stored.pipeline === current.pipeline)
      take({ file: frame.file, sourceVersion: stored.sourceVersion }, { width: stored.width, height: stored.height, data: stored.bytes.toString("base64") });
    else misses.push(frame);
  }
  const { batches, stale, failed, prepared } = misses.length === 0 ? { batches: [], stale: [], failed: [], prepared: [] }
    : await composeDesignThumbnailBatches(root, { ...input, frames: misses }, deps.signal);
  const named = current.exact ? current.pipeline : null;
  let pipeline: string | null = null;
  for (const batch of batches) {
    if (budget === 0) {
      deferred.push(...batch.frames.values());
      continue;
    }
    const reply = await inCaptureTurn(deps.signal, () => capture(batch.request, deps.signal));
    const drawn = designThumbnailPipeline(reply.renderer);
    if (pipeline === null) {
      pipeline = drawn;
      await noteDesignThumbnailPipeline(drawn);
      if (named !== null && drawn !== named) {
        // The host draws with another pipeline than the one named at launch,
        // so the stored pictures answered so far are not current: ask again.
        for (const picture of pictures.splice(0)) deferred.push({ file: picture.file, sourceVersion: picture.sourceVersion });
        budget = DESIGN_THUMBNAILS_REPLY_DATA_BYTES;
      }
    }
    const answered = new Map(reply.items.map((item) => [item.id, item]));
    const stores: Array<Promise<boolean>> = [];
    for (const [id, frame] of batch.frames) {
      const item = answered.get(id);
      if (!item) failed.push({ file: frame.file, error: "Design capture returned no picture for this frame." });
      else if ("error" in item) failed.push({ file: frame.file, error: failure(new Error(item.error), root) });
      // The reply names one pipeline, so pictures from a host that restarted between batches can't join it.
      else if (drawn !== pipeline) failed.push({ file: frame.file, error: "The capture renderer changed; try again." });
      else {
        // Stored before the reply, so a deferred picture is a store hit when asked for again.
        const stored = frameId(canvas, frame.file);
        if (stored) stores.push(storeDesignThumbnail(root, input.directoryId, stored, variant,
          { sourceVersion: frame.sourceVersion, pipeline: drawn, bytes: Buffer.from(item.data, "base64") }));
        take(frame, item);
      }
    }
    await Promise.all(stores);
  }
  return designThumbnailsReplySchema.parse({ pipeline: pipeline ?? named ?? DESIGN_THUMBNAIL_COMPOSER, pictures, stale, failed, deferred,
    ...(prepared.length ? { prepared } : {}) });
}

const READ_CONCURRENCY = 32;

/** design.thumbnails.read on one Local workspace: each frame's newest stored
 * picture, of any generation, for covers at open. Nothing is drawn. */
export async function readDesignThumbnails(root: string, raw: unknown): Promise<DesignThumbnailsReadReply> {
  const input = designThumbnailsReadSchema.parse(raw);
  await assertThumbnailTarget(root, input);
  const { canvas } = await readSharedCanvasContext(root);
  const variant: DesignThumbnailVariant = { theme: input.theme, colorScheme: input.colorScheme, maxDimension: input.maxDimension };
  const reply: DesignThumbnailsReadReply = { pipeline: (await currentDesignThumbnailPipeline()).pipeline, pictures: [], missing: [], deferred: [] };
  let budget = DESIGN_THUMBNAILS_REPLY_DATA_BYTES;
  for (let start = 0; start < input.frames.length; start += READ_CONCURRENCY) {
    const files = input.frames.slice(start, start + READ_CONCURRENCY).map((frame) => frame.file);
    if (budget === 0) {
      reply.deferred.push(...files);
      continue;
    }
    const stored = await Promise.all(files.map((file) => {
      const id = frameId(canvas, file);
      return id ? readStoredDesignThumbnail(root, input.directoryId, id, variant) : null;
    }));
    for (const [index, picture] of stored.entries()) {
      const file = files[index]!;
      const data = picture?.bytes.toString("base64");
      if (!picture || !data) reply.missing.push(file);
      else if (data.length > budget) {
        reply.deferred.push(file);
        budget = 0;
      } else {
        budget -= data.length;
        reply.pictures.push({ file, sourceVersion: picture.sourceVersion, pipeline: picture.pipeline, mimeType: "image/png",
          width: picture.width, height: picture.height, data });
      }
    }
  }
  return designThumbnailsReadReplySchema.parse(reply);
}
