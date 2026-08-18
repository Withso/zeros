import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream, mkdirSync } from "node:fs";
import { open, readdir, realpath, rm, stat, unlink } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { pipeline } from "node:stream/promises";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface ValidatedBrowserUpload {
  path: string;
  name: string;
  size: number;
}

export interface StagedBrowserUpload extends ValidatedBrowserUpload {
  /** Private single-file directory preserving the original basename exposed
   * to the page while keeping cleanup unambiguous. */
  directory: string;
}

/** Resolve symlinks on both sides and require the regular upload file to stay
 * below the Zeros workspace that owns this browser session. */
export async function validateBrowserUpload(
  requestedPath: string,
  workspaceRoot: string,
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<ValidatedBrowserUpload> {
  if (!isAbsolute(requestedPath) || !isAbsolute(workspaceRoot)) {
    throw new Error("Browser upload path and workspace root must be absolute.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Browser upload size limit is invalid.");
  }
  const [resolvedFile, resolvedRoot] = await Promise.all([
    realpath(requestedPath),
    realpath(workspaceRoot),
  ]);
  const rel = relative(resolvedRoot, resolvedFile);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(
      "Browser uploads must be files inside the owning workspace.",
    );
  }
  const metadata = await stat(resolvedFile);
  if (!metadata.isFile())
    throw new Error("Browser upload must be a regular file.");
  if (metadata.size < 1)
    throw new Error("Browser upload file must not be empty.");
  if (metadata.size > maxBytes) {
    throw new Error(`Browser upload file exceeds ${maxBytes} bytes.`);
  }
  return {
    path: resolvedFile,
    name: basename(resolvedFile),
    size: metadata.size,
  };
}

/** Freeze an approved upload candidate into a private app-owned file before
 * showing the external-transfer confirmation. Reading through a stable file
 * handle and checking that handle against a second canonical-path lookup
 * closes the validate→confirm→upload symlink/replacement race. */
export async function stageBrowserUpload(input: {
  requestedPath: string;
  workspaceRoot: string;
  root: string;
  browserSessionId: string;
  maxBytes?: number;
}): Promise<StagedBrowserUpload> {
  validateDownloadOwner(input.root, input.browserSessionId);
  const validated = await validateBrowserUpload(
    input.requestedPath,
    input.workspaceRoot,
    input.maxBytes,
  );
  const source = await open(
    validated.path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  let directory: string | null = null;
  try {
    const opened = await source.stat();
    const currentPath = await realpath(validated.path);
    const current = await stat(currentPath);
    if (
      currentPath !== validated.path ||
      !opened.isFile() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.size !== validated.size
    ) {
      throw new Error("Browser upload changed during validation; try again.");
    }

    directory = join(
      uploadDirectory(input.root, input.browserSessionId),
      randomUUID(),
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stagedPath = join(directory, sanitizeFilename(validated.name));
    await pipeline(
      source.createReadStream({ autoClose: false }),
      createWriteStream(stagedPath, { flags: "wx", mode: 0o600 }),
    );
    const staged = await stat(stagedPath);
    if (!staged.isFile() || staged.size !== opened.size) {
      throw new Error("Browser upload staging did not complete safely.");
    }
    return {
      path: stagedPath,
      name: basename(stagedPath),
      size: staged.size,
      directory,
    };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await source.close();
  }
}

export async function discardStagedBrowserUpload(
  upload: StagedBrowserUpload,
): Promise<void> {
  await rm(upload.directory, { recursive: true, force: true });
}

/** Staged uploads are capabilities for live WebContents only. A clean service
 * boot has no valid prior leases, so crash leftovers must not become durable
 * artifacts. */
export async function clearStagedBrowserUploads(root: string): Promise<void> {
  if (!isAbsolute(root)) {
    throw new Error("Browser upload staging root must be an absolute path.");
  }
  await rm(resolve(root, "uploads"), { recursive: true, force: true });
}

export function allocateBrowserDownload(input: {
  root: string;
  browserSessionId: string;
  suggestedFilename: string;
}): { path: string; name: string } {
  validateDownloadOwner(input.root, input.browserSessionId);
  const safe = sanitizeFilename(input.suggestedFilename);
  const extension = extname(safe).slice(0, 20);
  const stem = safe.slice(0, Math.max(1, safe.length - extension.length));
  const name = `${stem.slice(0, 100)}-${randomUUID()}${extension}`;
  const directory = downloadDirectory(input.root, input.browserSessionId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { path: join(directory, name), name };
}

/** Bound persisted downloads across close/reopen cycles for one opaque browser
 * session. The in-memory lease list alone is insufficient because downloads
 * intentionally outlive a WebContents lease. */
export async function pruneBrowserDownloads(
  root: string,
  browserSessionId: string,
  maxPerSession = 40,
): Promise<number> {
  validateDownloadOwner(root, browserSessionId);
  if (!Number.isSafeInteger(maxPerSession) || maxPerSession < 1) {
    throw new Error("Browser download retention limit is invalid.");
  }
  const directory = downloadDirectory(root, browserSessionId);
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => ({
        name: entry.name,
        modifiedAt: (await stat(join(directory, entry.name))).mtimeMs,
      })),
  );
  files.sort(
    (left, right) =>
      left.modifiedAt - right.modifiedAt || left.name.localeCompare(right.name),
  );
  const excess = files.slice(0, Math.max(0, files.length - maxPerSession));
  await Promise.all(
    excess.map(({ name }) =>
      unlink(join(directory, name)).catch(() => undefined),
    ),
  );
  return excess.length;
}

function validateDownloadOwner(root: string, browserSessionId: string): void {
  if (!isAbsolute(root)) {
    throw new Error("Browser download root must be an absolute path.");
  }
  if (!SESSION_ID_PATTERN.test(browserSessionId)) {
    throw new Error("Browser download session identity is invalid.");
  }
}

function downloadDirectory(root: string, browserSessionId: string): string {
  const bucket = createHash("sha256")
    .update(browserSessionId)
    .digest("hex")
    .slice(0, 24);
  return resolve(root, "downloads", bucket);
}

function uploadDirectory(root: string, browserSessionId: string): string {
  const bucket = createHash("sha256")
    .update(browserSessionId)
    .digest("hex")
    .slice(0, 24);
  return resolve(root, "uploads", bucket);
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
