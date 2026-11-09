import { z } from "zod";

import { DESIGN_MAX_FRAMES_PER_PAGE } from "@zeros/protocol/design-pages";

// Contract v0.2 of design.recordings.render / .read, mirrored exactly from the
// engine's protocol schemas until that module lands on this branch; then
// these definitions are replaced by imports from @zeros/protocol/design-capture.

/** Local engines that record frames as Skia pictures. Cloud never offers it. */
export const DESIGN_RECORDINGS_CAPABILITY = "design.recordings.v1";
/** Engines that answer a read's `withFailures`: stored failures the current
 * recorder can't record, so a reopen covers those frames without waiting. */
export const DESIGN_RECORDINGS_READ_FAILURES_CAPABILITY = "design.recordings.read-failures.v1";
/** Engines that take a request's `colorScheme` and keep each scheme's recordings apart. */
export const DESIGN_RECORDINGS_COLOR_SCHEME_CAPABILITY = "design.recordings.color-scheme.v1";
export const DESIGN_RECORDING_CHUNK_ID_PATTERN = /^[a-f0-9]{32}$/;
export const DESIGN_RECORDING_CHUNK_MAX_BYTES = 64 * 1024;
export const DESIGN_RECORDING_MAX_BYTES = 64 * 1024 * 1024;
export const DESIGN_RECORDING_MAX_LAYERS = 16;
export const DESIGN_RECORDINGS_REPLY_DATA_BYTES = 12 * 1024 * 1024;
export const DESIGN_RECORDINGS_KNOWN_CHUNKS = 4096;
export const DESIGN_RECORDING_MAX_TYPEFACES = 64;
export const DESIGN_RECORDING_TYPEFACE_MAX_BYTES = 64 * 1024 * 1024;
/** Frames per render request: one engine batch capture. */
export const DESIGN_RECORDINGS_RENDER_FRAMES = 64;

const recordingChunkId = z.string().regex(DESIGN_RECORDING_CHUNK_ID_PATTERN);
const recordingFrame = z.object({
  file: z.string().min(1).max(255),
  sourceVersion: z.string().regex(/^[a-f0-9]{24}$/),
}).strict();
const recordingTheme = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable();
const recordingLayer = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().int().min(1).max(65_536),
  height: z.number().int().min(1).max(65_536),
  bytes: z.number().int().min(1).max(DESIGN_RECORDING_MAX_BYTES),
  chunks: z.array(recordingChunkId).min(1).max(Math.ceil(DESIGN_RECORDING_MAX_BYTES / 2048)),
  typefaces: z.array(recordingChunkId).max(DESIGN_RECORDING_MAX_TYPEFACES),
}).strict();
export type DesignRecordingLayer = z.infer<typeof recordingLayer>;
const designRecordingSchema = recordingFrame.extend({
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  scale: z.number().min(0.25).max(8),
  layers: z.array(recordingLayer).min(1).max(DESIGN_RECORDING_MAX_LAYERS),
}).strict();
export type DesignRecording = z.infer<typeof designRecordingSchema>;
const recordingChunk = z.object({
  id: recordingChunkId,
  data: z.string().min(1).max(Math.ceil((DESIGN_RECORDING_CHUNK_MAX_BYTES * 4) / 3) + 4),
}).strict();
const recordingChunks = z.array(recordingChunk).max(Math.ceil(DESIGN_RECORDINGS_REPLY_DATA_BYTES / 4));
const recordingTypeface = z.object({
  id: recordingChunkId,
  bytes: z.number().int().min(1).max(DESIGN_RECORDING_TYPEFACE_MAX_BYTES),
  chunks: z.array(recordingChunkId).min(1).max(Math.ceil(DESIGN_RECORDING_TYPEFACE_MAX_BYTES / 2048)),
}).strict();
export type DesignRecordingTypeface = z.infer<typeof recordingTypeface>;
const recordingTypefaces = z.array(recordingTypeface).max(DESIGN_RECORDING_MAX_TYPEFACES * DESIGN_RECORDINGS_RENDER_FRAMES);
const withinReply = (reply: { chunks: Array<{ data: string }> }) =>
  reply.chunks.reduce((total, chunk) => total + chunk.data.length, 0) <= DESIGN_RECORDINGS_REPLY_DATA_BYTES;

export const designRecordingsRenderSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  directoryId: z.string().min(1).max(128),
  theme: recordingTheme,
  frames: z.array(recordingFrame).min(1).max(DESIGN_RECORDINGS_RENDER_FRAMES),
  knownChunks: z.array(recordingChunkId).max(DESIGN_RECORDINGS_KNOWN_CHUNKS).optional(),
  deviceScaleFactor: z.number().min(1).max(4).optional(),
  colorScheme: z.enum(["light", "dark"]).default("light"),
  jobId: z.string().uuid().optional(),
  deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict()
  .refine((input) => new Set(input.frames.map((frame) => frame.file)).size === input.frames.length, "Recording frames must be distinct.")
  .refine((input) => (input.jobId === undefined) === (input.deadline === undefined), "Recording job and deadline must be supplied together.");
export type DesignRecordingsRender = z.infer<typeof designRecordingsRenderSchema>;

export const designRecordingsReplySchema = z.object({
  pipeline: z.string().min(1).max(256),
  recordings: z.array(designRecordingSchema).max(DESIGN_RECORDINGS_RENDER_FRAMES),
  typefaces: recordingTypefaces,
  chunks: recordingChunks,
  stale: z.array(recordingFrame).max(DESIGN_RECORDINGS_RENDER_FRAMES),
  /** `retryable` (engine N+1, optional): a transient outcome worth asking again. */
  failed: z.array(z.object({ file: z.string().min(1).max(255), error: z.string().min(1).max(500), retryable: z.boolean().optional() })
    .strict()).max(DESIGN_RECORDINGS_RENDER_FRAMES),
  deferred: z.array(recordingFrame).max(DESIGN_RECORDINGS_RENDER_FRAMES),
}).strict().refine(withinReply, "Recording chunks exceed one reply.");
export type DesignRecordingsReply = z.infer<typeof designRecordingsReplySchema>;

export const designRecordingsReadSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  directoryId: z.string().min(1).max(128),
  theme: recordingTheme,
  frames: z.array(recordingFrame.partial({ sourceVersion: true })).min(1).max(DESIGN_MAX_FRAMES_PER_PAGE),
  knownChunks: z.array(recordingChunkId).max(DESIGN_RECORDINGS_KNOWN_CHUNKS).optional(),
  colorScheme: z.enum(["light", "dark"]).default("light"),
  withFailures: z.literal(true).optional(),
}).strict()
  .refine((input) => new Set(input.frames.map((frame) => frame.file)).size === input.frames.length, "Recording frames must be distinct.");
export type DesignRecordingsRead = z.infer<typeof designRecordingsReadSchema>;

export const designRecordingsReadReplySchema = z.object({
  recordings: z.array(designRecordingSchema.extend({ pipeline: z.string().min(1).max(256) }).strict()).max(DESIGN_MAX_FRAMES_PER_PAGE),
  typefaces: recordingTypefaces,
  chunks: recordingChunks,
  missing: z.array(z.string().min(1).max(255)).max(DESIGN_MAX_FRAMES_PER_PAGE),
  deferred: z.array(z.string().min(1).max(255)).max(DESIGN_MAX_FRAMES_PER_PAGE),
  /** Engine N+1, answering a read that opted in: stored permanent failures. */
  failed: z.array(recordingFrame.extend({ error: z.string().min(1).max(500) }).strict()).max(DESIGN_MAX_FRAMES_PER_PAGE).optional(),
}).strict().refine(withinReply, "Recording chunks exceed one reply.");
export type DesignRecordingsReadReply = z.infer<typeof designRecordingsReadReplySchema>;
