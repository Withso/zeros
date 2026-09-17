import path from "node:path";
import { opendir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { designDirectoryNameFor } from "./directory-registry";
import { inspectSafeRegularFile, readSafeRegularFile } from "./safe-files";
const MAX_DESIGN_TEXT_BYTES = 2 * 1024 * 1024;
function designDirectory(workspacePath: string): string {
  return path.join(
    path.resolve(workspacePath),
    ...designDirectoryNameFor(workspacePath).split("/"),
  );
}
export const MAX_DESIGN_ASSETS = 128;
export const MAX_ASSET_SCAN_ENTRIES = 4096;
export const MAX_ASSET_DEPTH = 4;
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const MAX_ASSET_PREVIEW_BYTES = 512 * 1024;
export const MAX_ASSET_PREVIEW_TOTAL_BYTES = 4 * 1024 * 1024;
export const DESIGN_ASSET_MIME_TYPES = Object.freeze<Record<string, string>>({
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

export interface DesignAssetSummary {
  /** POSIX path relative to Zeros Design/. */
  path: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedAt: number;
  /** Bounded local preview used by the Assets panel and drag affordance. */
  dataUrl: string | null;
}

export function safeLocalReference(
  directory: string,
  reference: string,
): string | null {
  const clean = reference.trim();
  if (!clean || clean.startsWith("#")) return null;
  if (
    clean.startsWith("/") ||
    clean.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(clean)
  ) {
    return null;
  }
  const withoutQuery = clean.split(/[?#]/, 1)[0] ?? "";
  const resolved = path.resolve(directory, withoutQuery);
  return resolved.startsWith(`${path.resolve(directory)}${path.sep}`)
    ? resolved
    : null;
}

/** Read only a regular file whose canonical target stays under the canonical
 * design directory. This rejects both direct symlinks and symlinked parent
 * directories, so renderer/MCP reads cannot turn a local CSS reference into a
 * host-filesystem disclosure. */
export async function readSafeDesignText(
  directory: string,
  target: string,
): Promise<string | null> {
  const safe = await readSafeRegularFile(
    directory,
    target,
    MAX_DESIGN_TEXT_BYTES,
  );
  return safe?.body.toString("utf8") ?? null;
}

export async function readSafeDesignBuffer(
  directory: string,
  target: string,
): Promise<Buffer | null> {
  return (
    (await readSafeRegularFile(directory, target, MAX_ASSET_BYTES))?.body ??
    null
  );
}

export async function safeDesignFileMetadata(
  directory: string,
  target: string,
): Promise<{ size: number; modifiedAt: number } | null> {
  return inspectSafeRegularFile(directory, target, MAX_ASSET_BYTES);
}

/** Discover a bounded, symlink-free image catalog under assets/. Every path is
 * relative to the design directory so bridge and MCP callers never receive a
 * host path. Small previews are embedded once in the shared workspace snapshot. */
export async function listDesignAssets(
  workspacePath: string,
): Promise<DesignAssetSummary[]> {
  const directory = designDirectory(workspacePath);
  const assetsDirectory = path.join(directory, "assets");
  const files: string[] = [];
  let scanned = 0;
  const visit = async (current: string, depth: number): Promise<void> => {
    if (
      depth > MAX_ASSET_DEPTH ||
      files.length >= MAX_DESIGN_ASSETS ||
      scanned >= MAX_ASSET_SCAN_ENTRIES
    )
      return;
    const entries: Dirent[] = [];
    try {
      // readdir would allocate the complete directory before applying a
      // result limit. Count unsupported files and empty directories as work,
      // and let the async iterator close its descriptor on early exit.
      for await (const entry of await opendir(current)) {
        if (scanned >= MAX_ASSET_SCAN_ENTRIES) break;
        scanned += 1;
        entries.push(entry);
      }
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (files.length >= MAX_DESIGN_ASSETS) break;
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (
        entry.isFile() &&
        DESIGN_ASSET_MIME_TYPES[path.extname(entry.name).toLowerCase()]
      ) {
        files.push(target);
      }
    }
  };
  await visit(assetsDirectory, 0);

  const summaries: DesignAssetSummary[] = [];
  let previewBytes = 0;
  for (const target of files) {
    const mimeType =
      DESIGN_ASSET_MIME_TYPES[path.extname(target).toLowerCase()];
    if (!mimeType) continue;
    const info = await safeDesignFileMetadata(directory, target);
    if (!info) continue;
    let dataUrl: string | null = null;
    if (
      info.size <= MAX_ASSET_PREVIEW_BYTES &&
      previewBytes + info.size <= MAX_ASSET_PREVIEW_TOTAL_BYTES
    ) {
      const data = await readSafeDesignBuffer(directory, target);
      if (!data) continue;
      previewBytes += data.length;
      dataUrl = `data:${mimeType};base64,${data.toString("base64")}`;
    }
    const relative = path.relative(directory, target).split(path.sep).join("/");
    summaries.push({
      path: relative,
      name: path.basename(target),
      mimeType,
      size: info.size,
      modifiedAt: info.modifiedAt,
      dataUrl,
    });
  }
  return summaries;
}
