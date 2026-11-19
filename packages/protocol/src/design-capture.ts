import { z } from "zod";
import { designPreparedFrameSchema } from "./design-catalog";
import { DESIGN_MAX_FRAMES_PER_PAGE } from "./design-pages";
export const DESIGN_CAPTURE_HTML_BYTES = 16 * 1024 * 1024;
export const DESIGN_CAPTURE_PNG_BYTES = 1024 * 1024;
export const DESIGN_CAPTURE_TIMEOUT_MS = 20_000;
export const DESIGN_CAPTURE_MAX_DIMENSION = 2048;
/** Conservative reservation for clone, serialization, decoder, canvas and output. */
export const DESIGN_CAPTURE_TEMP_BYTES = 256 * 1024 * 1024;
export const DESIGN_PREVIEW_JOBS_CAPABILITY = "design.preview.jobs.v1";
export const DESIGN_PREVIEW_JOB_TIMEOUT_MS = 30_000;
/** A failed transport is not proof that its renderer released its resources. */
export class DesignCaptureCleanupUnconfirmedError extends Error {
  constructor() { super("Design capture cleanup is unconfirmed. Restart the app before capturing again."); }
}
const previewJobId = z.string().uuid();
export const designPreviewCancelSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  directoryId: z.string().min(1).max(128),
  jobId: previewJobId,
  deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const DESIGN_CAPTURE_MIN_DIMENSION = 16;

/** Round viewport fractions up and share raster sizing across capture hosts so requests and replies agree. */
export function designCaptureRasterSize(
  viewport: { width: number; height: number },
  maxDimension: number = DESIGN_CAPTURE_MAX_DIMENSION,
) {
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const bound = Math.min(DESIGN_CAPTURE_MAX_DIMENSION, Math.max(DESIGN_CAPTURE_MIN_DIMENSION, Math.floor(maxDimension)));
  const scale = Math.min(1, bound / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}
/** The default view is still; authored animation remains available to explicit playback. */
export const DESIGN_STATIC_RENDER_CSS = "*,:before,:after{animation:none!important;transition:none!important;caret-color:transparent!important}";
/** This shared ES5 script stops timelines outside CSS and the Web Animations API so live surfaces and captures agree. */
export const DESIGN_STILL_TIMELINES_SOURCE =
  "function stillAuthoredTimelines() {" +
  ' var svgs = document.getElementsByTagName("svg");' +
  " for (var index = 0; index < svgs.length; index += 1) {" +
  "  var svg = svgs[index];" +
  '  if (svg.ownerSVGElement || typeof svg.pauseAnimations !== "function") continue;' +
  "  try { svg.pauseAnimations(); svg.setCurrentTime(0); } catch (_error) {}" +
  " }" +
  ' var marquees = document.getElementsByTagName("marquee");' +
  " for (var marquee = 0; marquee < marquees.length; marquee += 1) {" +
  '  try { if (typeof marquees[marquee].stop === "function") marquees[marquee].stop(); } catch (_error) {}' +
  " }" +
  ' var media = document.querySelectorAll("video, audio");' +
  " for (var item = 0; item < media.length; item += 1) {" +
  "  try { media[item].pause(); } catch (_error) {}" +
  " }" +
  "}";
/** Host-evaluated before every still capture. */
export const DESIGN_STATIC_RENDER_SCRIPT = `(${DESIGN_STILL_TIMELINES_SOURCE})()`;
/** The engine resolves the authenticated workspace's capture host; clients cannot supply renderer coordinates. */
export const designWorkspaceCaptureSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  frame: z.string().min(1).max(255),
  expectedRevision: z.string().min(1).max(128),
  width: z.number().int().min(1).max(DESIGN_CAPTURE_MAX_DIMENSION),
  height: z.number().int().min(1).max(DESIGN_CAPTURE_MAX_DIMENSION),
}).strict();
/** Lay out saved source at its own viewport; a mismatched sourceVersion returns stale rather than unrelated pixels. */
export const designPreviewRequestSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  // The directory the canvas shows; a changed active directory is refused.
  directoryId: z.string().min(1).max(128).optional(),
  frame: z.string().min(1).max(255),
  sourceVersion: z.string().regex(/^[a-f0-9]{24}$/),
  theme: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable(),
  maxDimension: z.number().int().min(DESIGN_CAPTURE_MIN_DIMENSION).max(DESIGN_CAPTURE_MAX_DIMENSION),
  /** Sent only when the engine advertises design.preview.jobs.v1. */
  jobId: previewJobId.optional(),
  deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine((input) => (input.jobId === undefined) === (input.deadline === undefined), "Preview job and deadline must be supplied together.");
export type DesignPreviewRequest = z.infer<typeof designPreviewRequestSchema>;
export const designPreviewReplySchema = z.union([
  z.object({ stale: z.literal(true), sourceVersion: z.string().min(1).max(128) }).strict(),
  z.object({
    sourceVersion: z.string().regex(/^[a-f0-9]{24}$/),
    theme: z.string().max(64).nullable(),
    mimeType: z.literal("image/png"),
    width: z.number().int().min(1).max(DESIGN_CAPTURE_MAX_DIMENSION),
    height: z.number().int().min(1).max(DESIGN_CAPTURE_MAX_DIMENSION),
    data: z.string().min(1).max(Math.ceil((DESIGN_CAPTURE_PNG_BYTES * 4) / 3) + 4),
  }).strict(),
]);
export type DesignPreviewReply = z.infer<typeof designPreviewReplySchema>;
export const designCaptureRequestSchema = z
  .object({
    version: z.literal(1),
    html: z.string().min(1).max(DESIGN_CAPTURE_HTML_BYTES),
    revision: z.string().min(1).max(128),
    width: z.number().int().min(1).max(DESIGN_CAPTURE_MAX_DIMENSION),
    height: z.number().int().min(1).max(DESIGN_CAPTURE_MAX_DIMENSION),
    // Optional for legacy callers; scaling affects only the output raster, not layout.
    layoutViewport: z.object({
      width: z.number().int().min(1).max(16_384),
      height: z.number().int().min(1).max(16_384),
    }).strict().optional(),
    // Bounds the raster's longest side without changing the layout viewport.
    maxDimension: z.number().int().min(DESIGN_CAPTURE_MIN_DIMENSION).max(DESIGN_CAPTURE_MAX_DIMENSION).optional(),
    colorScheme: z.enum(["light", "dark"]).default("light"),
  })
  .strict()
  .refine(input => {
    if (!input.layoutViewport) return input.maxDimension === undefined;
    const raster = designCaptureRasterSize(input.layoutViewport, input.maxDimension);
    return input.width === raster.width && input.height === raster.height;
  }, { message: "Capture dimensions must match the bounded layout viewport raster." });
export type DesignCaptureRequest = z.infer<typeof designCaptureRequestSchema>;
export const designCaptureReplySchema = z
  .object({
    version: z.literal(1),
    revision: z.string().min(1).max(128),
    width: z.number().int().min(1).max(DESIGN_CAPTURE_MAX_DIMENSION),
    height: z.number().int().min(1).max(DESIGN_CAPTURE_MAX_DIMENSION),
    data: z.string().max(Math.ceil((DESIGN_CAPTURE_PNG_BYTES * 4) / 3) + 4),
    renderer: z.string().min(1).max(128),
  })
  .strict();
export type DesignCaptureReply = z.infer<typeof designCaptureReplySchema>;

/** Link content-addressed stylesheets in their original cascade order and serve them only within the batch. */
export const DESIGN_CAPTURE_SHEET_SCHEME = "zeros-capture";
export const DESIGN_BATCH_CAPTURE_MAX_ITEMS = 64;
export const DESIGN_BATCH_CAPTURE_MAX_DIMENSION = 1280;
export const DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES = 16 * 1024 * 1024;
export const DESIGN_BATCH_CAPTURE_HTML_BYTES = 32 * 1024 * 1024;
export const DESIGN_BATCH_CAPTURE_TIMEOUT_MS = 60_000;
/** Bound the aggregate reply even when several large pictures share a batch. */
export const DESIGN_BATCH_CAPTURE_PIXELS = 16 * 1024 * 1024;
export const designCaptureSheetUrl = (hash: string) => `${DESIGN_CAPTURE_SHEET_SCHEME}://css/${hash}`;
const sheetHash = z.string().regex(/^[a-f0-9]{64}$/);
export const designBatchCaptureRequestSchema = z
  .object({
    version: z.literal(1),
    revision: z.string().min(1).max(128),
    colorScheme: z.enum(["light", "dark"]).default("light"),
    stylesheets: z.record(sheetHash, z.string().max(DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES)),
    items: z.array(z.object({
      id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
      html: z.string().min(1).max(DESIGN_CAPTURE_HTML_BYTES),
      viewport: z.object({
        width: z.number().int().min(1).max(16_384),
        height: z.number().int().min(1).max(16_384),
      }).strict(),
      maxDimension: z.number().int().min(DESIGN_CAPTURE_MIN_DIMENSION).max(DESIGN_BATCH_CAPTURE_MAX_DIMENSION),
    }).strict()).min(1).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
  })
  .strict()
  .refine(input => new Set(input.items.map(item => item.id)).size === input.items.length,
    { message: "Batch capture item ids must be unique." })
  .refine(input => input.items.reduce((sum, item) => sum + item.maxDimension * item.maxDimension, 0) <= DESIGN_BATCH_CAPTURE_PIXELS,
    { message: "Batch capture exceeds its pixel budget." })
  .refine(input => Object.values(input.stylesheets).reduce((sum, css) => sum + css.length, 0) <= DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES &&
    input.items.reduce((sum, item) => sum + item.html.length, 0) <= DESIGN_BATCH_CAPTURE_HTML_BYTES,
    { message: "Batch capture exceeds its byte budget." });
export type DesignBatchCaptureRequest = z.infer<typeof designBatchCaptureRequestSchema>;
export const designBatchCaptureReplySchema = z
  .object({
    version: z.literal(1),
    revision: z.string().min(1).max(128),
    renderer: z.string().min(1).max(128),
    items: z.array(z.union([
      z.object({
        id: z.string().min(1).max(128),
        width: z.number().int().min(1).max(DESIGN_BATCH_CAPTURE_MAX_DIMENSION),
        height: z.number().int().min(1).max(DESIGN_BATCH_CAPTURE_MAX_DIMENSION),
        data: z.string().max(Math.ceil((DESIGN_CAPTURE_PNG_BYTES * 4) / 3) + 4),
      }).strict(),
      z.object({ id: z.string().min(1).max(128), error: z.string().min(1).max(500) }).strict(),
    ])).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
  })
  .strict();
export type DesignBatchCaptureReply = z.infer<typeof designBatchCaptureReplySchema>;

/** Local engines that compose many frames' thumbnails into capture batches. */
export const DESIGN_THUMBNAILS_CAPABILITY = "design.thumbnails.v1";
const thumbnailFrame = z.object({
  file: z.string().min(1).max(255),
  sourceVersion: z.string().regex(/^[a-f0-9]{24}$/),
}).strict();
/** Engines that prepare a frame sent without its version while picturing it. */
export const DESIGN_THUMBNAILS_PREPARE_CAPABILITY = "design.thumbnails.prepare.v1";
/** A moved source returns stale; a versionless request may also return preparation data while catalogRevision still matches. */
export const designThumbnailsRenderSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  directoryId: z.string().min(1).max(128),
  theme: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable(),
  colorScheme: z.enum(["light", "dark"]),
  maxDimension: z.number().int().min(DESIGN_CAPTURE_MIN_DIMENSION).max(DESIGN_BATCH_CAPTURE_MAX_DIMENSION),
  frames: z.array(thumbnailFrame.partial({ sourceVersion: true })).min(1).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
  catalogRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** As for previews: cancelled through design.preview.cancel. */
  jobId: previewJobId.optional(),
  deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict()
  .refine((input) => new Set(input.frames.map((frame) => frame.file)).size === input.frames.length, "Thumbnail frames must be distinct.")
  .refine((input) => (input.jobId === undefined) === (input.deadline === undefined), "Thumbnail job and deadline must be supplied together.")
  .refine((input) => input.catalogRevision !== undefined || input.frames.every((frame) => frame.sourceVersion !== undefined),
    "A thumbnail frame without a version needs the catalog revision.");
export type DesignThumbnailsRender = z.infer<typeof designThumbnailsRenderSchema>;
/** Leave room for metadata within the bridge's 16 MiB frame limit. */
export const DESIGN_THUMBNAILS_REPLY_DATA_BYTES = 12 * 1024 * 1024;
export const designThumbnailsReplySchema = z.object({
  /** Stored pictures from another composition or capture pipeline cannot be reused as current. */
  pipeline: z.string().min(1).max(256),
  pictures: z.array(thumbnailFrame.extend({
    mimeType: z.literal("image/png"),
    width: z.number().int().min(1).max(DESIGN_BATCH_CAPTURE_MAX_DIMENSION),
    height: z.number().int().min(1).max(DESIGN_BATCH_CAPTURE_MAX_DIMENSION),
    data: z.string().min(1).max(Math.ceil((DESIGN_CAPTURE_PNG_BYTES * 4) / 3) + 4),
  }).strict()).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
  stale: z.array(thumbnailFrame).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
  failed: z.array(z.object({ file: z.string().min(1).max(255), error: z.string().min(1).max(500) }).strict())
    .max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
  /** Not pictured in this reply, to keep it within one frame: ask again. */
  deferred: z.array(thumbnailFrame).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
  /** design.frames.prepare records of frames sent without a version. */
  prepared: z.array(designPreparedFrameSchema).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS).optional(),
}).strict()
  .refine((reply) => reply.pictures.reduce((total, picture) => total + picture.data.length, 0) <= DESIGN_THUMBNAILS_REPLY_DATA_BYTES,
    "Thumbnail pictures exceed one reply.");
export type DesignThumbnailsReply = z.infer<typeof designThumbnailsReplySchema>;

/** Local engines that keep frame thumbnails across launches. */
export const DESIGN_THUMBNAILS_STORE_CAPABILITY = "design.thumbnails.store.v1";
/** Reads can return any stored generation; compare sourceVersion and pipeline before treating it as current. */
export const designThumbnailsReadSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  directoryId: z.string().min(1).max(128),
  theme: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable(),
  colorScheme: z.enum(["light", "dark"]),
  maxDimension: z.number().int().min(DESIGN_CAPTURE_MIN_DIMENSION).max(DESIGN_BATCH_CAPTURE_MAX_DIMENSION),
  frames: z.array(z.object({ file: z.string().min(1).max(255) }).strict()).min(1).max(DESIGN_MAX_FRAMES_PER_PAGE),
}).strict()
  .refine((input) => new Set(input.frames.map((frame) => frame.file)).size === input.frames.length, "Thumbnail frames must be distinct.");
export type DesignThumbnailsRead = z.infer<typeof designThumbnailsReadSchema>;
export const designThumbnailsReadReplySchema = z.object({
  /** The pipeline pictures drawn now carry; null until the engine knows it. */
  pipeline: z.string().min(1).max(256).nullable(),
  pictures: z.array(thumbnailFrame.extend({
    /** Null when the store no longer knows which pipeline drew it. */
    pipeline: z.string().min(1).max(256).nullable(),
    mimeType: z.literal("image/png"),
    width: z.number().int().min(1).max(DESIGN_BATCH_CAPTURE_MAX_DIMENSION),
    height: z.number().int().min(1).max(DESIGN_BATCH_CAPTURE_MAX_DIMENSION),
    data: z.string().min(1).max(Math.ceil((DESIGN_CAPTURE_PNG_BYTES * 4) / 3) + 4),
  }).strict()).max(DESIGN_MAX_FRAMES_PER_PAGE),
  /** No stored picture at this size, theme and color scheme. */
  missing: z.array(z.string().min(1).max(255)).max(DESIGN_MAX_FRAMES_PER_PAGE),
  /** Not looked up, to keep the reply within one frame: ask again. */
  deferred: z.array(z.string().min(1).max(255)).max(DESIGN_MAX_FRAMES_PER_PAGE),
}).strict()
  .refine((reply) => reply.pictures.reduce((total, picture) => total + picture.data.length, 0) <= DESIGN_THUMBNAILS_REPLY_DATA_BYTES,
    "Thumbnail pictures exceed one reply.");
export type DesignThumbnailsReadReply = z.infer<typeof designThumbnailsReadReplySchema>;

/** Local engines with this capability return Skia pictures; the recorded canvas is internal-only. */
export const DESIGN_RECORDINGS_CAPABILITY = "design.recordings.v1";
/** design.recordings.read accepts `withFailures`. */
export const DESIGN_RECORDINGS_READ_FAILURES_CAPABILITY = "design.recordings.read-failures.v1";
/** design.recordings.render and .read accept `colorScheme`. */
export const DESIGN_RECORDINGS_COLOR_SCHEME_CAPABILITY = "design.recordings.color-scheme.v1";
/** Chunk IDs are the first 32 hex digits of SHA-256; identical bytes are transferred and stored once. */
export const DESIGN_RECORDING_CHUNK_ID_PATTERN = /^[a-f0-9]{32}$/;
export const DESIGN_RECORDING_CHUNK_MAX_BYTES = 64 * 1024;
/** Bounds a reassembled layer; embedded font data can make one layer several megabytes. */
export const DESIGN_RECORDING_MAX_BYTES = 64 * 1024 * 1024;
export const DESIGN_RECORDING_MAX_LAYERS = 16;
/** Base64 chunk data in one reply, within one bridge frame like thumbnails. */
export const DESIGN_RECORDINGS_REPLY_DATA_BYTES = 12 * 1024 * 1024;
export const DESIGN_RECORDINGS_KNOWN_CHUNKS = 4096;
export const DESIGN_RECORDING_MAX_TYPEFACES = 64;
export const DESIGN_RECORDING_TYPEFACE_MAX_BYTES = 64 * 1024 * 1024;
const recordingChunkId = z.string().regex(DESIGN_RECORDING_CHUNK_ID_PATTERN);
const recordingFrame = thumbnailFrame;
const recordingTheme = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable();
const recordingLayer = z.object({
  /** Placement and size in recording pixels: CSS pixels times `scale`. */
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().int().min(1).max(65_536),
  height: z.number().int().min(1).max(65_536),
  bytes: z.number().int().min(1).max(DESIGN_RECORDING_MAX_BYTES),
  /** The layer's picture is these chunks' bytes, concatenated in order. */
  chunks: z.array(recordingChunkId).min(1).max(Math.ceil(DESIGN_RECORDING_MAX_BYTES / 2048)),
  /** Fonts the picture references instead of embedding (externalized
   * typefaces); each is described once per reply in `typefaces`. */
  typefaces: z.array(recordingChunkId).max(DESIGN_RECORDING_MAX_TYPEFACES),
}).strict();
const designRecordingSchema = recordingFrame.extend({
  /** CSS pixels of the frame. */
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  /** Recording pixels per CSS pixel. */
  scale: z.number().min(0.25).max(8),
  /** The first layer is the frame's root; recordings are normally one layer. */
  layers: z.array(recordingLayer).min(1).max(DESIGN_RECORDING_MAX_LAYERS),
}).strict();
export type DesignRecording = z.infer<typeof designRecordingSchema>;
const recordingChunk = z.object({
  id: recordingChunkId,
  data: z.string().min(1).max(Math.ceil((DESIGN_RECORDING_CHUNK_MAX_BYTES * 4) / 3) + 4),
}).strict();
const recordingChunks = z.array(recordingChunk).max(Math.ceil(DESIGN_RECORDINGS_REPLY_DATA_BYTES / 4));
/** An externalized typeface: font data a recording references by its content
 * id (the chunk-id rule over the font data), carried as ordinary chunks. */
const recordingTypeface = z.object({
  id: recordingChunkId,
  bytes: z.number().int().min(1).max(DESIGN_RECORDING_TYPEFACE_MAX_BYTES),
  chunks: z.array(recordingChunkId).min(1).max(Math.ceil(DESIGN_RECORDING_TYPEFACE_MAX_BYTES / 2048)),
}).strict();
const recordingTypefaces = z.array(recordingTypeface).max(DESIGN_RECORDING_MAX_TYPEFACES * DESIGN_BATCH_CAPTURE_MAX_ITEMS);
const withinReply = (reply: { chunks: Array<{ data: string }> }) =>
  reply.chunks.reduce((total, chunk) => total + chunk.data.length, 0) <= DESIGN_RECORDINGS_REPLY_DATA_BYTES;
/** Render missing saved frames for one theme and color scheme; skip known chunks and cancel through design.preview.cancel. */
export const designRecordingsRenderSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  directoryId: z.string().min(1).max(128),
  theme: recordingTheme,
  /** The color scheme frames are drawn in: recordings of each are kept apart. */
  colorScheme: z.enum(["light", "dark"]).default("light"),
  frames: z.array(recordingFrame).min(1).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
  knownChunks: z.array(recordingChunkId).max(DESIGN_RECORDINGS_KNOWN_CHUNKS).optional(),
  /** Accepted for the future; the recorder reports its own `scale`. */
  deviceScaleFactor: z.number().min(1).max(4).optional(),
  jobId: previewJobId.optional(),
  deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict()
  .refine((input) => new Set(input.frames.map((frame) => frame.file)).size === input.frames.length, "Recording frames must be distinct.")
  .refine((input) => (input.jobId === undefined) === (input.deadline === undefined), "Recording job and deadline must be supplied together.");
export type DesignRecordingsRender = z.infer<typeof designRecordingsRenderSchema>;
export const designRecordingsReplySchema = z.object({
  /** A change to the composer or recorder pipeline makes the client request new recordings. */
  pipeline: z.string().min(1).max(256),
  recordings: z.array(designRecordingSchema).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
  /** Every typeface the reply's recordings reference, once. */
  typefaces: recordingTypefaces,
  chunks: recordingChunks,
  stale: z.array(recordingFrame).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
  /** Retryable failures belong to the attempt; otherwise the same source and recorder will fail again. */
  failed: z.array(z.object({ file: z.string().min(1).max(255), error: z.string().min(1).max(500), retryable: z.literal(true).optional() }).strict())
    .max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
  /** Not answered in this reply, to keep it within one frame: ask again. */
  deferred: z.array(recordingFrame).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
}).strict().refine(withinReply, "Recording chunks exceed one reply.");
export type DesignRecordingsReply = z.infer<typeof designRecordingsReplySchema>;
/** Read stored recordings without rendering; a named version must match exactly. */
export const designRecordingsReadSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  directoryId: z.string().min(1).max(128),
  theme: recordingTheme,
  colorScheme: z.enum(["light", "dark"]).default("light"),
  frames: z.array(recordingFrame.partial({ sourceVersion: true })).min(1).max(DESIGN_MAX_FRAMES_PER_PAGE),
  knownChunks: z.array(recordingChunkId).max(DESIGN_RECORDINGS_KNOWN_CHUNKS).optional(),
  /** Also answer `failed` for frames the current recorder can't record. */
  withFailures: z.literal(true).optional(),
}).strict()
  .refine((input) => new Set(input.frames.map((frame) => frame.file)).size === input.frames.length, "Recording frames must be distinct.");
export type DesignRecordingsRead = z.infer<typeof designRecordingsReadSchema>;
export const designRecordingsReadReplySchema = z.object({
  recordings: z.array(designRecordingSchema.extend({ pipeline: z.string().min(1).max(256) }).strict()).max(DESIGN_MAX_FRAMES_PER_PAGE),
  typefaces: recordingTypefaces,
  chunks: recordingChunks,
  /** No stored recording in this theme. */
  missing: z.array(z.string().min(1).max(255)).max(DESIGN_MAX_FRAMES_PER_PAGE),
  /** Not looked up, to keep the reply within one frame: ask again. */
  deferred: z.array(z.string().min(1).max(255)).max(DESIGN_MAX_FRAMES_PER_PAGE),
  /** With withFailures, missing frames the recorder cannot record also appear here. */
  failed: z.array(z.object({ file: z.string().min(1).max(255), sourceVersion: recordingFrame.shape.sourceVersion,
    error: z.string().min(1).max(500) }).strict()).max(DESIGN_MAX_FRAMES_PER_PAGE).optional(),
}).strict().refine(withinReply, "Recording chunks exceed one reply.");
export type DesignRecordingsReadReply = z.infer<typeof designRecordingsReadReplySchema>;

/** Record Skia pictures at the layout viewport using the same content-addressed styles as batch capture. */
export const designBatchRecordRequestSchema = z.object({
  version: z.literal(1),
  revision: z.string().min(1).max(128),
  colorScheme: z.enum(["light", "dark"]).default("light"),
  stylesheets: z.record(sheetHash, z.string().max(DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES)),
  items: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    html: z.string().min(1).max(DESIGN_CAPTURE_HTML_BYTES),
    viewport: z.object({ width: z.number().int().min(1).max(16_384), height: z.number().int().min(1).max(16_384) }).strict(),
  }).strict()).min(1).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
}).strict()
  .refine((input) => new Set(input.items.map((item) => item.id)).size === input.items.length, { message: "Record item ids must be unique." })
  .refine((input) => Object.values(input.stylesheets).reduce((sum, css) => sum + css.length, 0) <= DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES &&
    input.items.reduce((sum, item) => sum + item.html.length, 0) <= DESIGN_BATCH_CAPTURE_HTML_BYTES,
    { message: "Batch record exceeds its byte budget." });
export type DesignBatchRecordRequest = z.infer<typeof designBatchRecordRequestSchema>;
/** The engine only accepts recorder files in matching OS temporary directories. */
export const DESIGN_RECORDER_FOLDER_PREFIX = "zeros-design-recorder-";
/** Layer files come from the host's private recording folder and are removed after import. */
export const designBatchRecordReplySchema = z.object({
  version: z.literal(1),
  revision: z.string().min(1).max(128),
  recorder: z.string().min(1).max(128),
  items: z.array(z.union([
    z.object({
      id: z.string().min(1).max(128),
      scale: z.number().min(0.25).max(8),
      layers: z.array(z.object({
        x: z.number().finite(), y: z.number().finite(),
        width: z.number().int().min(1).max(65_536), height: z.number().int().min(1).max(65_536),
        path: z.string().min(1).max(4096),
        /** Font data files, by content id, this layer's picture references. */
        typefaces: z.array(z.object({ id: recordingChunkId, path: z.string().min(1).max(4096) }).strict()).max(DESIGN_RECORDING_MAX_TYPEFACES),
      }).strict()).min(1).max(DESIGN_RECORDING_MAX_LAYERS),
    }).strict(),
    /** Permanent failures recur on the same source and recorder, unlike transient host failures. */
    z.object({ id: z.string().min(1).max(128), error: z.string().min(1).max(500), permanent: z.literal(true).optional() }).strict(),
  ])).max(DESIGN_BATCH_CAPTURE_MAX_ITEMS),
}).strict();
export type DesignBatchRecordReply = z.infer<typeof designBatchRecordReplySchema>;
