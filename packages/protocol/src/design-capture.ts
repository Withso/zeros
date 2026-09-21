import { z } from "zod";
export const DESIGN_CAPTURE_HTML_BYTES = 16 * 1024 * 1024;
export const DESIGN_CAPTURE_PNG_BYTES = 1024 * 1024;
export const DESIGN_CAPTURE_TIMEOUT_MS = 20_000;
/** Authenticated workspace operation. Renderer coordinates are never accepted
 * from a client; the engine resolves its qualified local capture host. */
export const designWorkspaceCaptureSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  frame: z.string().min(1).max(255),
  expectedRevision: z.string().min(1).max(128),
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
}).strict();
export const designCaptureRequestSchema = z
  .object({
    version: z.literal(1),
    html: z.string().min(1).max(DESIGN_CAPTURE_HTML_BYTES),
    revision: z.string().min(1).max(128),
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
    colorScheme: z.enum(["light", "dark"]).default("light"),
  })
  .strict();
export type DesignCaptureRequest = z.infer<typeof designCaptureRequestSchema>;
export const designCaptureReplySchema = z
  .object({
    version: z.literal(1),
    revision: z.string().min(1).max(128),
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
    data: z.string().max(Math.ceil((DESIGN_CAPTURE_PNG_BYTES * 4) / 3) + 4),
    renderer: z.string().min(1).max(128),
  })
  .strict();
export type DesignCaptureReply = z.infer<typeof designCaptureReplySchema>;
