import { z } from "zod";

// Contract v0 of design.recordings.render / design.recordings.read, mirrored
// strictly until the protocol package exports the engine's own schemas. Every
// bound is the renderer's admission limit, not a promise about the engine.

/** Local engines that record frames as Skia pictures. Cloud never offers it. */
export const DESIGN_RECORDINGS_CAPABILITY = "design.recordings.v1";
export const DESIGN_RECORDINGS_MAX_FRAMES = 64;
export const DESIGN_RECORDINGS_MAX_KNOWN_CHUNKS = 4_096;
export const DESIGN_RECORDINGS_MAX_LAYERS = 64;
export const DESIGN_RECORDINGS_MAX_LAYER_CHUNKS = 4_096;
/** The whole reply has to fit one 16 MiB bridge frame. */
export const DESIGN_RECORDINGS_REPLY_DATA_BYTES = 15 * 1024 * 1024;

const file = z.string().min(1).max(255);
const sourceVersion = z.string().regex(/^[a-f0-9]{24}$/);
export const designRecordingChunkId = z.string().regex(/^[a-f0-9]{32}$/);
const theme = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable();
const deviceLength = z.number().int().min(1).max(65_536);
const cssLength = z.number().positive().max(16_384);

export const designRecordingsRequestSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  directoryId: z.string().min(1).max(128),
  theme,
  frames: z.array(z.object({ file, sourceVersion }).strict()).min(1).max(DESIGN_RECORDINGS_MAX_FRAMES),
  deviceScaleFactor: z.number().int().min(1).max(4),
  knownChunks: z.array(designRecordingChunkId).max(DESIGN_RECORDINGS_MAX_KNOWN_CHUNKS).optional(),
}).strict()
  .refine((input) => new Set(input.frames.map((frame) => frame.file)).size === input.frames.length, "Recorded frames must be distinct.");
export type DesignRecordingsRequest = z.infer<typeof designRecordingsRequestSchema>;

export const designRecordingLayerSchema = z.object({
  x: z.number().int().min(-65_536).max(65_536),
  y: z.number().int().min(-65_536).max(65_536),
  width: deviceLength,
  height: deviceLength,
  chunks: z.array(designRecordingChunkId).min(1).max(DESIGN_RECORDINGS_MAX_LAYER_CHUNKS),
}).strict();
export type DesignRecordingLayer = z.infer<typeof designRecordingLayerSchema>;

export const designRecordingSchema = z.object({
  file,
  sourceVersion,
  width: cssLength,
  height: cssLength,
  scale: z.number().positive().max(8),
  layers: z.array(designRecordingLayerSchema).min(1).max(DESIGN_RECORDINGS_MAX_LAYERS),
}).strict();
export type DesignRecording = z.infer<typeof designRecordingSchema>;

const chunk = z.object({ id: designRecordingChunkId, data: z.string().min(1) }).strict();
const replyShape = {
  pipeline: z.string().min(1).max(256),
  recordings: z.array(designRecordingSchema).max(DESIGN_RECORDINGS_MAX_FRAMES),
  chunks: z.array(chunk).max(DESIGN_RECORDINGS_MAX_FRAMES * DESIGN_RECORDINGS_MAX_LAYER_CHUNKS),
  failed: z.array(z.object({ file, error: z.string().min(1).max(500) }).strict()).max(DESIGN_RECORDINGS_MAX_FRAMES),
  deferred: z.array(file).max(DESIGN_RECORDINGS_MAX_FRAMES),
};
const withinOneFrame = (reply: { chunks: ReadonlyArray<{ data: string }> }) =>
  reply.chunks.reduce((total, entry) => total + entry.data.length, 0) <= DESIGN_RECORDINGS_REPLY_DATA_BYTES;

export const designRecordingsReplySchema = z.object(replyShape).strict()
  .refine(withinOneFrame, "Recording chunks exceed one reply.");
export type DesignRecordingsReply = z.infer<typeof designRecordingsReplySchema>;

export const designRecordingsReadReplySchema = z.object({ ...replyShape, missing: z.array(file).max(DESIGN_RECORDINGS_MAX_FRAMES) }).strict()
  .refine(withinOneFrame, "Recording chunks exceed one reply.");
export type DesignRecordingsReadReply = z.infer<typeof designRecordingsReadReplySchema>;
