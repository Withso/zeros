import fs from "node:fs";
import path from "node:path";
import { FILE_MEDIA_CHUNK_BYTES, MAX_FILE_MEDIA_BYTES, fileMediaRangeSchema, fileMediaType, fileMediaVersion, type FileMediaRangeResult } from "@zeros/protocol/file-media";
import { isInside, isSensitiveRepoPath } from "./read-file";
import { openBoundedFileSync } from "./bounded-read-sync";

/** A range never trusts a previous successful metadata lookup. Resolve and
 * authorize again, then read a held regular-file descriptor and check revision
 * before AND after I/O. No whole-file buffer, hash or retained descriptor. */
function openMedia(cwd: string, relativePath: string, remote: boolean, canonicalRoot?: string) {
  if (!cwd || !relativePath || relativePath.includes("\0") || !fileMediaType(relativePath)) throw new Error("Invalid media path");
  const root = canonicalRoot ?? fs.realpathSync(cwd), lexicalRoot = path.resolve(cwd), lexical = path.resolve(cwd, relativePath);
  if (!isInside(lexical, lexicalRoot) || (remote && isSensitiveRepoPath(path.relative(lexicalRoot, lexical)))) throw new Error("Media path is outside the workspace");
  const target = fs.realpathSync(lexical);
  if (!isInside(target, root) || (remote && isSensitiveRepoPath(path.relative(root, target)))) throw new Error("Media path is outside the workspace");
  const fd = openBoundedFileSync(target);
  try {
    const info = fs.fstatSync(fd), current = fs.statSync(target);
    if (!info.isFile() || info.dev !== current.dev || info.ino !== current.ino || fs.realpathSync(lexical) !== target || fs.realpathSync(cwd) !== root) throw new Error("Media file changed");
    // Linux can additionally prove the descriptor itself didn't move during
    // lookup. macOS uses identity + repeated realpath checks above.
    if (process.platform === "linux" && fs.realpathSync(`/proc/self/fd/${fd}`) !== target) throw new Error("Media file moved");
    return { fd, info };
  } catch (error) { fs.closeSync(fd); throw error; }
}

export function readWorkspaceMediaMetadata(cwd: string, relativePath: string, remote: boolean, canonicalRoot?: string) {
  const { fd, info } = openMedia(cwd, relativePath, remote, canonicalRoot);
  try {
    if (info.size > MAX_FILE_MEDIA_BYTES) return { kind: "too-large" as const, path: relativePath, bytes: info.size };
    const type = fileMediaType(relativePath)!;
    // Documents retain the existing binary wire kind. Older renderers show
    // their safe fallback; new ones opt into a viewer using the MIME metadata.
    return { kind: type.kind === "document" ? "binary" as const : type.kind, path: relativePath, bytes: info.size, media: { mimeType: type.mimeType, version: fileMediaVersion(info) } };
  } finally { fs.closeSync(fd); }
}

export async function readWorkspaceMediaRange(cwd: string, input: unknown, remote = false, canonicalRoot?: string): Promise<FileMediaRangeResult> {
  const range = fileMediaRangeSchema.parse(input);
  const { fd, info } = openMedia(cwd, range.path, remote, canonicalRoot);
  try {
    if (info.size > MAX_FILE_MEDIA_BYTES || fileMediaVersion(info) !== range.version || range.offset > info.size) throw new Error("Media file changed; reopen it to continue");
    const length = Math.min(range.length, info.size - range.offset, FILE_MEDIA_CHUNK_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    let bytes = 0;
    while (bytes < length) {
      const count = await new Promise<number>((resolve, reject) => fs.read(fd, buffer, bytes, length - bytes, range.offset + bytes, (error, read) => error ? reject(error) : resolve(read)));
      if (!count) throw new Error("Media file changed while reading");
      bytes += count;
    }
    if (fileMediaVersion(fs.fstatSync(fd)) !== range.version) throw new Error("Media file changed while reading");
    return { base64: buffer.toString("base64"), bytes };
  } finally { fs.closeSync(fd); }
}
