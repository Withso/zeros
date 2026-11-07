import { z } from "zod";
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

/** Smallest raster a canvas preview may request. */
export const DESIGN_CAPTURE_MIN_DIMENSION = 16;

/** Raster dimensions stay bounded independently of the frame's CSS viewport.
 * Browsers require whole viewport pixels; round fractional canvas bounds up.
 * Canvas previews pass a smaller `maxDimension`; both capture hosts compute
 * their scale through this one function, so a request and its host agree. */
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
/** Passive previews and captures show the canvas's default still state.
 * Authored keyframes remain source; explicit motion playback is separate. */
export const DESIGN_STATIC_RENDER_CSS = "*,:before,:after{animation:none!important;transition:none!important;caret-color:transparent!important}";
/** SVG SMIL timelines, marquees and media loop outside CSS and the Web
 * Animations API; this holds them at their opening state. It is the one
 * definition both capture hosts run (DESIGN_STATIC_RENDER_SCRIPT) and the
 * canvas runtime embeds, so a frame's picture and its live document show the
 * same moment. ES5 source, as the runtime is. */
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
/** Authenticated workspace operation. Renderer coordinates are never accepted
 * from a client; the engine resolves its qualified local capture host. */
export const designWorkspaceCaptureSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  frame: z.string().min(1).max(255),
  expectedRevision: z.string().min(1).max(128),
  width: z.number().int().min(1).max(DESIGN_CAPTURE_MAX_DIMENSION),
  height: z.number().int().min(1).max(DESIGN_CAPTURE_MAX_DIMENSION),
}).strict();
/** Canvas preview of a frame's saved source: laid out at the frame's own
 * canvas size, rasterized to fit `maxDimension`, in an optional canvas theme.
 * `sourceVersion` names the exact generation the canvas expects; a changed
 * frame answers `{ stale: true, sourceVersion }` instead of other pixels. */
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
    // Optional for existing callers. A large frame keeps its layout viewport;
    // only the emitted raster is scaled to width/height above.
    layoutViewport: z.object({
      width: z.number().int().min(1).max(16_384),
      height: z.number().int().min(1).max(16_384),
    }).strict().optional(),
    // Optional preview bound: the layout keeps the frame's own viewport and the
    // raster fits this many pixels on its longest side.
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

/** Batched thumbnails: many frames are laid out in one capture document per
 * sheet, and stylesheets shared by those frames are parsed once per capture
 * process. Each item's style blocks are replaced, at their own positions, by
 * links to content-addressed sheets served only from this batch. */
export const DESIGN_CAPTURE_SHEET_SCHEME = "zeros-capture";
export const DESIGN_BATCH_CAPTURE_MAX_ITEMS = 64;
export const DESIGN_BATCH_CAPTURE_MAX_DIMENSION = 1280;
export const DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES = 16 * 1024 * 1024;
export const DESIGN_BATCH_CAPTURE_HTML_BYTES = 32 * 1024 * 1024;
export const DESIGN_BATCH_CAPTURE_TIMEOUT_MS = 60_000;
/** A batch's pictures together stay within this many pixels (64 thumbnails
 * fit easily; detail pictures go a few at a time), bounding the reply. */
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
