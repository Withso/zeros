import { lstat, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  DESIGN_BATCH_CAPTURE_TIMEOUT_MS,
  DESIGN_RECORDER_FOLDER_PREFIX,
  DESIGN_RECORDING_MAX_BYTES,
  DESIGN_RECORDING_TYPEFACE_MAX_BYTES,
  DESIGN_RECORDINGS_REPLY_DATA_BYTES,
  designBatchRecordReplySchema,
  designRecordingsReadReplySchema,
  designRecordingsReadSchema,
  designRecordingsRenderSchema,
  designRecordingsReplySchema,
  type DesignBatchCaptureRequest,
  type DesignBatchRecordReply,
  type DesignBatchRecordRequest,
  type DesignRecordingsReadReply,
  type DesignRecordingsReply,
} from "@zeros/protocol/design-capture";
import { resolveDesignCaptureConfig, type DesignCaptureConfig } from "./capture-client";
import { designDirectoryNameFor } from "./directory-registry";
import { assertDesignThemeName } from "./document";
import { readSharedCanvasContext } from "./document-storage";
import { designDirectoryEntry } from "./metadata";
import {
  readDesignRecordingChunk,
  readDesignRecordingTypeface,
  readStoredDesignRecording,
  storeDesignRecording,
  storeDesignRecordingTypeface,
  type StoredDesignRecording,
  type StoredDesignRecordingTypeface,
} from "./recording-store";
import { composeDesignThumbnailBatches } from "./thumbnail-batch";

/** Bump whenever composing a recording changes what it draws for the same frame. */
export const DESIGN_RECORDING_COMPOSER = "recordings-1";
export const designRecordingPipeline = (recorder: string) => `${DESIGN_RECORDING_COMPOSER}:${recorder}`;
export { DESIGN_RECORDER_FOLDER_PREFIX } from "@zeros/protocol/design-capture";
/** Composition only needs a valid size here; nothing is rasterized. */
const COMPOSE_DIMENSION = 256;
const MAX_HOST_REPLY_BYTES = 4 * 1024 * 1024;
const UNRECORDED = "This frame could not be recorded.";

type Frame = { file: string; sourceVersion: string };
type Recording = DesignRecordingsReply["recordings"][number];

const failure = (error: unknown, root: string) => {
  const message = error instanceof Error && !("syscall" in error) ? error.message.slice(0, 500) : "";
  return !message || message.includes(path.resolve(root)) || message.includes(homedir()) ? UNRECORDED : message;
};

function frameId(canvas: { frame_info: Record<string, unknown> }, file: string): string | null {
  const id = (canvas.frame_info[file] as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : null;
}

async function assertRecordingTarget(root: string, input: { directoryId: string; theme: string | null }): Promise<void> {
  if (designDirectoryEntry(root, designDirectoryNameFor(root))?.id !== input.directoryId)
    throw new Error("The active Design directory changed. Refresh before recording frames.");
  if (input.theme !== null) await assertDesignThemeName(root, input.theme);
}

/** A reply grows recording by recording while every chunk the caller lacks
 * fits its data budget; a recording whose chunks don't fit is deferred. */
class ReplyBuilder {
  readonly recordings: Array<Recording & { pipeline?: string }> = [];
  readonly typefaces: StoredDesignRecordingTypeface[] = [];
  readonly chunks: Array<{ id: string; data: string }> = [];
  private readonly described = new Set<string>();
  private readonly sent: Set<string>;
  private budget = DESIGN_RECORDINGS_REPLY_DATA_BYTES;
  constructor(known: readonly string[] | undefined) { this.sent = new Set(known); }
  /** "added", "deferred", or "missing" when a stored chunk is unreadable. */
  async add(frame: Frame, stored: StoredDesignRecording, withPipeline = false): Promise<"added" | "deferred" | "missing"> {
    // Typefaces first described in this reply travel with the recording.
    const typefaces: StoredDesignRecordingTypeface[] = [];
    for (const id of new Set(stored.layers.flatMap((layer) => layer.typefaces))) {
      if (this.described.has(id)) continue;
      const typeface = await readDesignRecordingTypeface(id);
      if (!typeface) return "missing";
      typefaces.push(typeface);
    }
    const wanted = [...new Set([...stored.layers.flatMap((layer) => layer.chunks), ...typefaces.flatMap((typeface) => typeface.chunks)])]
      .filter((id) => !this.sent.has(id));
    const data: Array<{ id: string; data: string }> = [];
    let size = 0;
    for (const id of wanted) {
      const bytes = await readDesignRecordingChunk(id);
      if (!bytes) return "missing";
      const encoded = bytes.toString("base64");
      size += encoded.length;
      if (size > this.budget) return "deferred";
      data.push({ id, data: encoded });
    }
    this.budget -= size;
    for (const chunk of data) { this.sent.add(chunk.id); this.chunks.push(chunk); }
    for (const typeface of typefaces) { this.described.add(typeface.id); this.typefaces.push(typeface); }
    this.recordings.push({ file: frame.file, sourceVersion: frame.sourceVersion, width: stored.width, height: stored.height,
      scale: stored.scale, layers: stored.layers.map((layer) => ({ ...layer, chunks: [...layer.chunks], typefaces: [...layer.typefaces] })),
      ...(withPipeline ? { pipeline: stored.pipeline } : {}) });
    return "added";
  }
}

let recordTail: Promise<void> = Promise.resolve();
/** The capture host records one batch at a time; batches take turns here. */
async function inRecordTurn<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const previous = recordTail;
  let release!: () => void;
  recordTail = new Promise<void>((resolve) => { release = resolve; });
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

function waitForCapacity(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** POST one batch to the capture host's recorder. A busy host (429) is
 * retried with backoff within the batch deadline. */
export async function requestDesignBatchRecord(
  config: DesignCaptureConfig,
  request: DesignBatchRecordRequest,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<DesignBatchRecordReply> {
  const body = JSON.stringify(request);
  const deadline = Date.now() + DESIGN_BATCH_CAPTURE_TIMEOUT_MS;
  for (let delay = 100; ; delay = Math.min(delay * 2, 1_000)) {
    signal?.throwIfAborted();
    const response = await fetchImpl(`${config.url}/record`, {
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
      throw new Error(response.status === 404 ? "This Design capture host cannot record frames."
        : response.status === 429 ? "Design recording capacity reached. Recordings wait for the active batch."
        : "Design capture host could not record these frames.");
    }
    const text = await response.text();
    if (text.length > MAX_HOST_REPLY_BYTES) throw new Error("Design recorder returned too much data.");
    const reply = designBatchRecordReplySchema.parse(JSON.parse(text));
    if (reply.revision !== request.revision) throw new Error("Design recorder answered another batch.");
    return reply;
  }
}

export function designBatchRecordRequestFrom(capture: DesignBatchCaptureRequest): DesignBatchRecordRequest {
  return { version: 1, revision: capture.revision, colorScheme: capture.colorScheme, stylesheets: capture.stylesheets,
    items: capture.items.map((item) => ({ id: item.id, html: item.html, viewport: item.viewport })) };
}

let realTemporary: string | null = null;
/** A file named by the host must be one it wrote in its own recording
 * folder: never a path elsewhere, and never followed through a link. */
async function readRecorderFile(file: string, name: RegExp, limit: number): Promise<Buffer> {
  const outside = new Error("The recorder named a recording outside its folder.");
  realTemporary ??= await realpath(tmpdir());
  const resolved = await realpath(file).catch(() => { throw outside; });
  const relative = path.relative(realTemporary, resolved);
  if (!path.isAbsolute(file) || relative.startsWith("..") || path.isAbsolute(relative) ||
    !relative.split(path.sep)[0]!.startsWith(DESIGN_RECORDER_FOLDER_PREFIX) || !name.test(path.basename(resolved)))
    throw outside;
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    // The file held open must be the one checked: an intermediate directory
    // swapped between the check and the open would point elsewhere.
    const [info, checked] = await Promise.all([handle.stat(), lstat(resolved)]);
    if (info.dev !== checked.dev || info.ino !== checked.ino) throw outside;
    if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error("This frame's recording is too large.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
const LAYER_FILE = /^layer_\d+\.skp$/;
const TYPEFACE_FILE = /^[a-f0-9]{32}\.font$/;

/** Stores the fonts a recorded layer references, verified by content id. */
async function storeLayerTypefaces(typefaces: ReadonlyArray<{ id: string; path: string }>): Promise<string[]> {
  const ids: string[] = [];
  for (const typeface of typefaces) {
    if (!(await readDesignRecordingTypeface(typeface.id))) {
      const bytes = await readRecorderFile(typeface.path, TYPEFACE_FILE, DESIGN_RECORDING_TYPEFACE_MAX_BYTES);
      if (!(await storeDesignRecordingTypeface(typeface.id, bytes))) throw new Error("A font this frame uses could not be stored.");
    }
    ids.push(typeface.id);
  }
  return ids;
}

/** design.recordings.render on one Local workspace. */
export async function renderDesignRecordings(
  root: string,
  raw: unknown,
  deps: {
    signal?: AbortSignal;
    record?: (request: DesignBatchRecordRequest, signal?: AbortSignal) => Promise<DesignBatchRecordReply>;
    /** The recorder identity when known before any batch (normally from the capture config). */
    recorder?: string | null;
  } = {},
): Promise<DesignRecordingsReply> {
  const input = designRecordingsRenderSchema.parse(raw);
  const config = deps.record ? null : resolveDesignCaptureConfig();
  if (!deps.record && !config) throw new Error("No qualified Design capture host is available.");
  const record = deps.record ?? ((request, signal) => requestDesignBatchRecord(config!, request, signal));
  await assertRecordingTarget(root, input);
  const { canvas } = await readSharedCanvasContext(root);
  const known = deps.recorder !== undefined ? deps.recorder : config?.recorder ?? null;
  let pipeline = known === null ? null : designRecordingPipeline(known);
  const reply = new ReplyBuilder(input.knownChunks);
  const stale: Frame[] = [];
  const failed: Array<{ file: string; error: string }> = [];
  const deferred: Frame[] = [];
  const misses: Frame[] = [];
  for (const frame of input.frames) {
    const id = frameId(canvas, frame.file);
    const stored = pipeline && id ? await readStoredDesignRecording(root, input.directoryId, id, input.theme, { sourceVersion: frame.sourceVersion, pipeline }) : null;
    const outcome = stored ? await reply.add(frame, stored) : "missing";
    if (outcome === "deferred") deferred.push(frame);
    else if (outcome === "missing") misses.push(frame);
  }
  if (misses.length) {
    const composed = await composeDesignThumbnailBatches(root, { workspaceId: input.workspaceId, directoryId: input.directoryId,
      theme: input.theme, colorScheme: "light", maxDimension: COMPOSE_DIMENSION, frames: misses }, deps.signal);
    stale.push(...composed.stale);
    failed.push(...composed.failed);
    for (const batch of composed.batches) {
      const request = designBatchRecordRequestFrom(batch.request);
      const answer = await inRecordTurn(deps.signal, () => record(request, deps.signal));
      const drawn = designRecordingPipeline(answer.recorder);
      // One reply names one pipeline: a recorder restarted under another
      // build between batches can't join it.
      pipeline ??= drawn;
      const items = new Map(answer.items.map((item) => [item.id, item]));
      const viewports = new Map(request.items.map((item) => [item.id, item.viewport]));
      try {
        for (const [itemId, frame] of batch.frames) {
          const item = items.get(itemId);
          const viewport = viewports.get(itemId)!;
          if (!item) { failed.push({ file: frame.file, error: "The recorder returned no recording for this frame." }); continue; }
          if ("error" in item) { failed.push({ file: frame.file, error: failure(new Error(item.error), root) }); continue; }
          if (drawn !== pipeline) { failed.push({ file: frame.file, error: "The recorder changed; try again." }); continue; }
          const id = frameId(canvas, frame.file);
          try {
            const layers = [];
            for (const layer of item.layers) layers.push({ x: layer.x, y: layer.y, width: layer.width, height: layer.height,
              bytes: await readRecorderFile(layer.path, LAYER_FILE, DESIGN_RECORDING_MAX_BYTES), typefaces: await storeLayerTypefaces(layer.typefaces) });
            const stored = id ? await storeDesignRecording(root, input.directoryId, id, input.theme,
              { sourceVersion: frame.sourceVersion, pipeline: drawn, width: viewport.width, height: viewport.height, scale: item.scale, layers }) : null;
            if (!stored) { failed.push({ file: frame.file, error: "This frame's recording could not be stored." }); continue; }
            const outcome = await reply.add(frame, stored);
            if (outcome === "deferred") deferred.push(frame);
            else if (outcome === "missing") failed.push({ file: frame.file, error: "This frame's recording could not be stored." });
          } catch (error) {
            failed.push({ file: frame.file, error: failure(error, root) });
          }
        }
      } finally {
        // The host's files are single-use: stored chunks are the only copy kept.
        await Promise.all(answer.items.flatMap((item) => "layers" in item
          ? [rm(path.dirname(item.layers[0]!.path), { recursive: true, force: true }).catch(() => {})] : []));
      }
    }
  }
  return designRecordingsReplySchema.parse({ pipeline: pipeline ?? DESIGN_RECORDING_COMPOSER, recordings: reply.recordings,
    typefaces: reply.typefaces, chunks: reply.chunks, stale, failed, deferred });
}

/** design.recordings.read on one Local workspace: each frame's newest stored
 * recording in this theme, of any generation and pipeline. Nothing is recorded. */
export async function readDesignRecordings(root: string, raw: unknown): Promise<DesignRecordingsReadReply> {
  const input = designRecordingsReadSchema.parse(raw);
  await assertRecordingTarget(root, input);
  const { canvas } = await readSharedCanvasContext(root);
  const reply = new ReplyBuilder(input.knownChunks);
  const missing: string[] = [];
  const deferred: string[] = [];
  for (const frame of input.frames) {
    const id = frameId(canvas, frame.file);
    const stored = id ? await readStoredDesignRecording(root, input.directoryId, id, input.theme,
      frame.sourceVersion ? { sourceVersion: frame.sourceVersion } : {}) : null;
    if (!stored) { missing.push(frame.file); continue; }
    const outcome = await reply.add({ file: frame.file, sourceVersion: stored.sourceVersion }, stored, true);
    if (outcome === "deferred") deferred.push(frame.file);
    else if (outcome === "missing") missing.push(frame.file);
  }
  return designRecordingsReadReplySchema.parse({ recordings: reply.recordings, typefaces: reply.typefaces, chunks: reply.chunks, missing, deferred });
}
