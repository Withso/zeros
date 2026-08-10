import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";

const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface ValidatedBrowserUpload {
  path: string;
  name: string;
  size: number;
}

export interface AllocateBrowserDownloadInput {
  root: string;
  taskId: string;
  suggestedFilename: string;
}

export interface BrowserDownloadTarget {
  path: string;
  name: string;
}

/** Resolve and validate model-supplied upload paths before Chromium can read
 * them. The real path is used so the confirmation describes the actual file,
 * including when the requested path was a symlink. */
export async function validateBrowserUpload(
  requestedPath: string,
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<ValidatedBrowserUpload> {
  if (!isAbsolute(requestedPath)) {
    throw new Error("Browser upload requires an absolute path.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Browser upload size limit is invalid.");
  }
  const resolved = await realpath(requestedPath);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) {
    throw new Error("Browser upload must be a regular file.");
  }
  if (metadata.size < 1) {
    throw new Error("Browser upload file must not be empty.");
  }
  if (metadata.size > maxBytes) {
    throw new Error(`Browser upload file exceeds ${maxBytes} bytes.`);
  }
  return { path: resolved, name: basename(resolved), size: metadata.size };
}

/** Allocate downloads only below the app-owned artifact root. Site-provided
 * filenames are reduced to a bounded display-safe basename and made unique. */
export function allocateBrowserDownload(
  input: AllocateBrowserDownloadInput,
): BrowserDownloadTarget {
  if (!isAbsolute(input.root)) {
    throw new Error("Browser download root must be an absolute path.");
  }
  if (!TASK_ID_PATTERN.test(input.taskId)) {
    throw new Error("Browser download task binding is invalid.");
  }
  const safe = sanitizeFilename(input.suggestedFilename);
  const extension = extname(safe).slice(0, 20);
  const stem = safe.slice(0, Math.max(1, safe.length - extension.length));
  const name = `${stem.slice(0, 100)}-${randomUUID()}${extension}`;
  const bucket = createHash("sha256")
    .update(input.taskId)
    .digest("hex")
    .slice(0, 24);
  const directory = join(input.root, "downloads", bucket);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { path: join(directory, name), name };
}

function sanitizeFilename(value: string): string {
  const leaf = basename(value.trim() || "download");
  const safe = leaf
    .normalize("NFKC")
    .replace(/\p{Cc}/gu, "_")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return safe || "download";
}
