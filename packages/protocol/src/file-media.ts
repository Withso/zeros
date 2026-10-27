import { z } from "zod";

/** Decimal MB, matching the composer file policy. Inline legacy reads keep
 * their smaller limits; this allowance is for streamed Files previews only. */
export const MAX_FILE_MEDIA_BYTES = 200_000_000;
export const FILE_MEDIA_CHUNK_BYTES = 1024 * 1024;
export const FILE_MEDIA_SCHEME = "zeros-media";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", svg: "image/svg+xml",
};
const VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  ogv: "video/ogg", mkv: "video/x-matroska",
};
export function fileMediaType(path: string): { kind: "image" | "video"; mimeType: string } | null {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase() ?? "";
  if (Object.hasOwn(IMAGE_TYPES, ext)) return { kind: "image", mimeType: IMAGE_TYPES[ext] };
  if (Object.hasOwn(VIDEO_TYPES, ext)) return { kind: "video", mimeType: VIDEO_TYPES[ext] };
  return null;
}
export const fileMediaDescriptorSchema = z.object({
  mimeType: z.string().refine(value => [...Object.values(IMAGE_TYPES), ...Object.values(VIDEO_TYPES)].includes(value)),
  version: z.string().min(1).max(192).regex(/^[0-9.:-]+$/),
});
export type FileMediaDescriptor = z.infer<typeof fileMediaDescriptorSchema>;

/** Metadata, never a content digest: a replaced/modified source invalidates
 * every later range. Both ends use the held descriptor's stat, including ctime. */
export function fileMediaVersion(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
}
export const fileMediaRangeSchema = z.object({
  path: z.string().min(1).max(4096),
  version: fileMediaDescriptorSchema.shape.version,
  offset: z.number().int().min(0).max(MAX_FILE_MEDIA_BYTES),
  length: z.number().int().min(1).max(FILE_MEDIA_CHUNK_BYTES),
});
export type FileMediaRange = z.infer<typeof fileMediaRangeSchema>;
export interface FileMediaRangeResult { base64: string; bytes: number }

/** HTTP single byte ranges, including suffix and open-ended seeks. Invalid,
 * multiple and unsatisfiable ranges fail closed rather than reading a file. */
export function parseFileMediaRange(value: string | null, size: number): { start: number; end: number; partial: boolean } | null {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_MEDIA_BYTES) return null;
  if (value === null) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0
      ? { start: Math.max(0, size - suffix), end: size - 1, partial: true } : null;
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1), partial: true };
}
