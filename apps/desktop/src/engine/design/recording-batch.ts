import { appendFile, realpath, rm, rmdir } from "node:fs/promises";
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
  readDesignRecordingFailure,
  readDesignRecordingTypeface,
  readNewestDesignRecordingFailure,
  designRecordingVariant,
  readStoredDesignRecording,
  storeDesignRecording,
  storeDesignRecordingFailure,
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

/** Diagnostics: a JSON-lines file of each render request's time by phase
 * (lookups, compose, waiting on compose, waiting for the recorder, recording,
 * storing), in milliseconds. */
const recordingsTimings = () => process.env.ZEROS_DESIGN_RECORDINGS_TIMINGS ?? "";

/** Frames composed at a time: as cheap per frame as larger calls, and the
 * recorder starts sooner. */
const COMPOSE_SLICE = 16;
type ComposedRecordingBatch = Awaited<ReturnType<typeof composeDesignThumbnailBatches>>["batches"][number];

/** Stored-recording lookups are small independent reads: a few at a time. */
const LOOKUPS = 16;

/** What a canvas's recordings request draws: work ahead of an open
 * (recording-ahead.ts) records in the same theme and color scheme. */
export interface DesignRecordingTarget {
  readonly workspaceId: string;
  readonly root: string;
  readonly directoryId: string;
  readonly theme: string | null;
  readonly colorScheme: "light" | "dark";
}
let renderingForCanvas = 0;
const targetListeners = new Set<(target: DesignRecordingTarget) => void>();

/** Whether a canvas's recordings request is in flight. */
export function designRecordingsRendering(): boolean {
  return renderingForCanvas > 0;
}

/** Told the target of every canvas request that passed its checks, until the returned function is called. */
export function onDesignRecordingTarget(listener: (target: DesignRecordingTarget) => void): () => void {
  targetListeners.add(listener);
  return () => { targetListeners.delete(listener); };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) results[index] = await run(items[index]!);
  }));
  return results;
}

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

/** Batches at the recorder at once: its windows share their frames, so the
 * next batch's frames start while the last ones of another finish. */
const RECORD_TURNS = 2;
let turnsRunning = 0;
const turnsWaiting: Array<() => void> = [];
/** Batches take turns here, a few at a time, in arrival order. */
async function inRecordTurn<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  if (turnsRunning < RECORD_TURNS) turnsRunning++;
  else {
    // A finishing batch hands its turn to the first waiter directly.
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const go = () => { signal?.removeEventListener("abort", abort); resolve(); };
      const abort = () => { turnsWaiting.splice(turnsWaiting.indexOf(go), 1); reject(signal!.reason); };
      signal?.addEventListener("abort", abort, { once: true });
      turnsWaiting.push(go);
    });
  }
  try {
    return await run();
  } finally {
    const next = turnsWaiting.shift();
    if (next) next();
    else turnsRunning--;
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
  // The boundary is the recorder's private 0700 folder, which only this user
  // can write; realpath above resolved every link. Everything else is checked
  // on the opened file itself, never on the path again.
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw outside; });
  try {
    const info = await handle.stat();
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

export interface DesignRecordingDeps {
  signal?: AbortSignal;
  record?: (request: DesignBatchRecordRequest, signal?: AbortSignal) => Promise<DesignBatchRecordReply>;
  /** The recorder identity when known before any batch (normally from the capture config). */
  recorder?: string | null;
}

/** design.recordings.render on one Local workspace. */
export async function renderDesignRecordings(root: string, raw: unknown, deps: DesignRecordingDeps = {}): Promise<DesignRecordingsReply> {
  renderingForCanvas++;
  try {
    return await recordFrames(root, designRecordingsRenderSchema.parse(raw), deps, true);
  } finally {
    renderingForCanvas--;
  }
}

/** Records and stores frames that aren't stored yet, answering no one: the
 * reply carries no recordings or chunks. */
export async function recordDesignFramesAhead(root: string, raw: unknown, deps: DesignRecordingDeps = {}): Promise<DesignRecordingsReply> {
  return recordFrames(root, designRecordingsRenderSchema.parse(raw), deps, false);
}

async function recordFrames(root: string, input: ReturnType<typeof designRecordingsRenderSchema.parse>, deps: DesignRecordingDeps,
  forCanvas: boolean): Promise<DesignRecordingsReply> {
  const started = performance.now();
  const spent = { lookups: 0, compose: 0, composeWait: 0, recordWait: 0, record: 0, store: 0, frames: 0, misses: 0, batches: 0 };
  const config = deps.record ? null : resolveDesignCaptureConfig();
  if (!deps.record && !config) throw new Error("No qualified Design capture host is available.");
  const record = deps.record ?? ((request, signal) => requestDesignBatchRecord(config!, request, signal));
  await assertRecordingTarget(root, input);
  if (forCanvas) for (const listener of targetListeners) listener({ workspaceId: input.workspaceId, root,
    directoryId: input.directoryId, theme: input.theme, colorScheme: input.colorScheme });
  const { canvas } = await readSharedCanvasContext(root);
  const variant = designRecordingVariant(input.theme, input.colorScheme);
  const known = deps.recorder !== undefined ? deps.recorder : config?.recorder ?? null;
  let pipeline = known === null ? null : designRecordingPipeline(known);
  const reply = new ReplyBuilder(input.knownChunks);
  const stale: Frame[] = [];
  /** `retryable`: this attempt failed, not the frame. */
  const failed: Array<{ file: string; error: string; retryable?: true }> = [];
  const deferred: Frame[] = [];
  const misses: Frame[] = [];
  const lookups = await mapLimit(input.frames, LOOKUPS, async (frame) => {
    const id = frameId(canvas, frame.file);
    if (!pipeline || !id) return { frame, stored: null, known: null };
    const wanted = { sourceVersion: frame.sourceVersion, pipeline };
    const stored = await readStoredDesignRecording(root, input.directoryId, id, variant, wanted);
    // A frame this recorder can't record is answered without recording again.
    return { frame, stored, known: stored ? null : await readDesignRecordingFailure(root, input.directoryId, id, variant, wanted) };
  });
  spent.lookups = performance.now() - started;
  for (const { frame, stored, known } of lookups) {
    if (known) { failed.push({ file: frame.file, error: known }); continue; }
    if (!stored) { misses.push(frame); continue; }
    if (!forCanvas) continue;
    const outcome = await reply.add(frame, stored);
    if (outcome === "deferred") deferred.push(frame);
    else if (outcome === "missing") misses.push(frame);
  }
  // Composition runs on this thread, recording in the host's processes: each
  // slice composes while the previous one records, so recording starts after
  // the first slice rather than after the whole request.
  const recordBatch = async (batch: ComposedRecordingBatch) => {
    const request = designBatchRecordRequestFrom(batch.request);
    const queued = performance.now();
    let recording = queued;
    const answer = await inRecordTurn(deps.signal, () => { recording = performance.now(); return record(request, deps.signal); });
    spent.recordWait += recording - queued;
    spent.record += performance.now() - recording;
    spent.batches++;
    const storing = performance.now();
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
        const id = frameId(canvas, frame.file);
        if (!item) { failed.push({ file: frame.file, error: "The recorder returned no recording for this frame.", retryable: true }); continue; }
        if ("error" in item) {
          const error = failure(new Error(item.error), root);
          if (item.permanent && id && drawn === pipeline)
            await storeDesignRecordingFailure(root, input.directoryId, id, variant, { sourceVersion: frame.sourceVersion, pipeline: drawn, error });
          failed.push(item.permanent ? { file: frame.file, error } : { file: frame.file, error, retryable: true });
          continue;
        }
        if (drawn !== pipeline) { failed.push({ file: frame.file, error: "The recorder changed; try again.", retryable: true }); continue; }
        try {
          const layers = [];
          for (const layer of item.layers) layers.push({ x: layer.x, y: layer.y, width: layer.width, height: layer.height,
            bytes: await readRecorderFile(layer.path, LAYER_FILE, DESIGN_RECORDING_MAX_BYTES), typefaces: await storeLayerTypefaces(layer.typefaces) });
          const stored = id ? await storeDesignRecording(root, input.directoryId, id, variant,
            { sourceVersion: frame.sourceVersion, pipeline: drawn, width: viewport.width, height: viewport.height, scale: item.scale, layers }) : null;
          if (!stored) { failed.push({ file: frame.file, error: "This frame's recording could not be stored.", retryable: true }); continue; }
          if (!forCanvas) continue;
          const outcome = await reply.add(frame, stored);
          if (outcome === "deferred") deferred.push(frame);
          else if (outcome === "missing") failed.push({ file: frame.file, error: "This frame's recording could not be stored.", retryable: true });
        } catch (error) {
          failed.push({ file: frame.file, error: failure(error, root), retryable: true });
        }
      }
    } finally {
      // The host's files are single-use: stored chunks are the only copy kept.
      const folders = answer.items.flatMap((item) => "layers" in item ? [path.dirname(item.layers[0]!.path)] : []);
      await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true }).catch(() => {})));
      // The batch's own folder, once empty (rmdir removes nothing else).
      for (const batchFolder of new Set(folders.map((folder) => path.dirname(folder)))) await rmdir(batchFolder).catch(() => {});
      spent.store += performance.now() - storing;
    }
  };
  if (misses.length) {
    const compose = async (frames: Frame[]) => {
      const composing = performance.now();
      try {
        return await composeDesignThumbnailBatches(root, { workspaceId: input.workspaceId, directoryId: input.directoryId,
          theme: input.theme, colorScheme: input.colorScheme, maxDimension: COMPOSE_DIMENSION, frames }, deps.signal);
      } finally { spent.compose += performance.now() - composing; }
    };
    const slices: Frame[][] = [];
    for (let at = 0; at < misses.length; at += COMPOSE_SLICE) slices.push(misses.slice(at, at + COMPOSE_SLICE));
    let next: ReturnType<typeof compose> | null = compose(slices[0]!);
    for (let index = 0; index < slices.length; index++) {
      const waiting = performance.now();
      const composed = await next!;
      spent.composeWait += performance.now() - waiting;
      next = index + 1 < slices.length ? compose(slices[index + 1]!) : null;
      // Observed when awaited; an abort or error must not go unhandled meanwhile.
      next?.catch(() => {});
      stale.push(...composed.stale);
      failed.push(...composed.failed);
      for (const batch of composed.batches) await recordBatch(batch);
    }
  }
  spent.frames = input.frames.length;
  spent.misses = misses.length;
  const timings = recordingsTimings();
  if (timings) void appendFile(timings, `${JSON.stringify({ at: Date.now(), ...(forCanvas ? {} : { ahead: 1 }), ...Object.fromEntries(Object.entries(spent)
    .map(([name, value]) => [name, Math.round(value)])), total: Math.round(performance.now() - started) })}\n`).catch(() => {});
  return designRecordingsReplySchema.parse({ pipeline: pipeline ?? DESIGN_RECORDING_COMPOSER, recordings: reply.recordings,
    typefaces: reply.typefaces, chunks: reply.chunks, stale, failed, deferred });
}

/** design.recordings.read on one Local workspace: each frame's newest stored
 * recording in this theme, of any generation and pipeline. Nothing is recorded. */
export async function readDesignRecordings(root: string, raw: unknown,
  deps: { recorder?: string | null } = {}): Promise<DesignRecordingsReadReply> {
  const input = designRecordingsReadSchema.parse(raw);
  await assertRecordingTarget(root, input);
  const { canvas } = await readSharedCanvasContext(root);
  const reply = new ReplyBuilder(input.knownChunks);
  const variant = designRecordingVariant(input.theme, input.colorScheme);
  const missing: string[] = [];
  const deferred: string[] = [];
  const failed: Array<{ file: string; sourceVersion: string; error: string }> = [];
  // Failures belong to the recorder that would record the frame now.
  const recorder = !input.withFailures ? null : deps.recorder !== undefined ? deps.recorder : resolveDesignCaptureConfig()?.recorder ?? null;
  const pipeline = recorder ? designRecordingPipeline(recorder) : null;
  const lookups = await mapLimit(input.frames, LOOKUPS, async (frame) => {
    const id = frameId(canvas, frame.file);
    const stored = id ? await readStoredDesignRecording(root, input.directoryId, id, variant,
      frame.sourceVersion ? { sourceVersion: frame.sourceVersion } : {}) : null;
    if (stored || !id || !pipeline) return { frame, stored, known: null };
    const known = frame.sourceVersion
      ? await readDesignRecordingFailure(root, input.directoryId, id, variant, { sourceVersion: frame.sourceVersion, pipeline })
        .then((error) => (error ? { sourceVersion: frame.sourceVersion!, error } : null))
      : await readNewestDesignRecordingFailure(root, input.directoryId, id, variant, pipeline);
    return { frame, stored, known };
  });
  for (const { frame, stored, known } of lookups) {
    if (!stored) {
      missing.push(frame.file);
      if (known) failed.push({ file: frame.file, ...known });
      continue;
    }
    const outcome = await reply.add({ file: frame.file, sourceVersion: stored.sourceVersion }, stored, true);
    if (outcome === "deferred") deferred.push(frame.file);
    else if (outcome === "missing") missing.push(frame.file);
  }
  return designRecordingsReadReplySchema.parse({ recordings: reply.recordings, typefaces: reply.typefaces, chunks: reply.chunks, missing, deferred,
    ...(input.withFailures ? { failed } : {}) });
}
