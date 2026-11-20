
import fs from "node:fs";
import path from "node:path";
import { isSensitiveWorkspacePath } from "@zeros/protocol/workspace-paths";
import { fileMediaType, type FileMediaDescriptor } from "@zeros/protocol/file-media";
import { readWorkspaceMediaMetadata } from "./file-media";
import { openBoundedFileSync, readBoundedBufferDescriptorSync } from "./bounded-read-sync";

const MAX_TEXT_BYTES = 2_000_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Legacy video payloads must opt in and fit the existing media budget below the bridge limit.
const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".ogv": "video/ogg", ".mkv": "video/x-matroska",
};

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

export type ReadFileKind = "text" | "image" | "video" | "binary" | "too-large" | "error";

export interface ReadFileResult {
  kind: ReadFileKind;
  path: string;
  bytes: number;
  content?: string;
  dataUrl?: string;
  media?: FileMediaDescriptor;
  error?: string;
  /** Advisory Design classification for the viewer; write authorization is enforced separately, and Local source repair remains available. */
  designPath?: boolean;
}

function fail(rel: string, message: string): ReadFileResult {
  return { kind: "error", path: rel, bytes: 0, error: message };
}

// The remote guard also covers direct reads; hiding ignored files from the tree does not prevent a read by path.
export function isSensitiveRepoPath(relPath: string): boolean {
  return isSensitiveWorkspacePath(relPath, path.posix.normalize);
}

/** Both arguments must be resolved absolute paths. */
export function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

export function readWorkspaceFile(
  cwd: string,
  relPath: string,
  opts?: { remote?: boolean; canonicalRoot?: string; includeVideo?: boolean; streamMedia?: boolean },
): ReadFileResult {
  const remote = opts?.remote === true;
  const rel = relPath;
  if (!cwd) return fail(rel, "no workspace folder is open");
  if (!rel) return fail(rel, "missing path");

  const root = path.resolve(cwd);
  const target = path.resolve(cwd, rel);

  if (!isInside(target, root)) {
    return fail(rel, "refusing to read outside the workspace");
  }

  // Deny normalized remote secret paths before checking existence.
  const SECRET_REFUSAL =
    "refusing to read a secret/credential file over a remote connection";
  if (remote && isSensitiveRepoPath(path.relative(root, target))) {
    return fail(rel, SECRET_REFUSAL);
  }

  const ext = path.extname(target).toLowerCase();
  const imageMime = IMAGE_MIME[ext];
  const videoMime = opts?.includeVideo === true ? VIDEO_MIME[ext] : undefined;
  const document = fileMediaType(rel)?.kind === "document";

  let fd: number;
  let size: number;
  try {
    const realRoot = opts?.canonicalRoot ?? fs.realpathSync(root);
    if (opts?.streamMedia && (imageMime || videoMime || document)) {
      return readWorkspaceMediaMetadata(cwd, rel, remote, realRoot);
    }
    const realTarget = fs.realpathSync(target);
    if (!isInside(realTarget, realRoot)) return fail(rel, "refusing to follow a symlink outside the workspace");
    if (remote && isSensitiveRepoPath(path.relative(realRoot, realTarget))) return fail(rel, SECRET_REFUSAL);
    fd = openBoundedFileSync(realTarget);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      fs.closeSync(fd);
      return fail(rel, stat.isDirectory() ? "this is a folder, not a file" : "not a regular file");
    }
    size = stat.size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail(rel, code === "ENOENT" ? "file no longer exists on disk" : `cannot safely read file (${code ?? "unknown error"})`);
  }

  try {
    if (document) return { kind: "binary", path: rel, bytes: size };
    if (imageMime || videoMime) {
      if (size > MAX_IMAGE_BYTES)
        return { kind: "too-large", path: rel, bytes: size };
      const buf = readBoundedBufferDescriptorSync(fd, MAX_IMAGE_BYTES);
      return {
        kind: videoMime ? "video" : "image",
        path: rel,
        bytes: size,
        dataUrl: `data:${videoMime ?? imageMime};base64,${buf.toString("base64")}`,
      };
    }

    if (size > MAX_TEXT_BYTES)
      return { kind: "too-large", path: rel, bytes: size };

    const buf = readBoundedBufferDescriptorSync(fd, MAX_TEXT_BYTES);
    const head = buf.subarray(0, Math.min(buf.length, 8192));
    if (head.includes(0)) return { kind: "binary", path: rel, bytes: size };

    return {
      kind: "text",
      path: rel,
      bytes: size,
      content: buf.toString("utf-8"),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return fail(rel, `cannot read file (${code ?? "unknown error"})`);
  } finally { fs.closeSync(fd); }
}
