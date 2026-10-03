import { z } from "zod";
export const DESIGN_CAPTURE_HTML_BYTES = 16 * 1024 * 1024;
export const DESIGN_CAPTURE_PNG_BYTES = 1024 * 1024;
export const DESIGN_CAPTURE_TIMEOUT_MS = 20_000;
export const DESIGN_CAPTURE_MAX_DIMENSION = 2048;

/** Raster dimensions stay bounded independently of the frame's CSS viewport.
 * Browsers require whole viewport pixels; round fractional canvas bounds up. */
export function designCaptureRasterSize(viewport: { width: number; height: number }) {
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const scale = Math.min(1, DESIGN_CAPTURE_MAX_DIMENSION / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}
/** Passive previews and captures show the canvas's default still state.
 * Authored keyframes remain source; explicit motion playback is separate. */
export const DESIGN_STATIC_RENDER_CSS = "*,:before,:after{animation:none!important;transition:none!important;caret-color:transparent!important}";
/** Authenticated workspace operation. Renderer coordinates are never accepted
 * from a client; the engine resolves its qualified local capture host. */
export const designWorkspaceCaptureSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  frame: z.string().min(1).max(255),
  expectedRevision: z.string().min(1).max(128),
  width: z.number().int().min(1).max(DESIGN_CAPTURE_MAX_DIMENSION),
  height: z.number().int().min(1).max(DESIGN_CAPTURE_MAX_DIMENSION),
}).strict();
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
    colorScheme: z.enum(["light", "dark"]).default("light"),
  })
  .strict()
  .refine(input => {
    if (!input.layoutViewport) return true;
    const raster = designCaptureRasterSize(input.layoutViewport);
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
