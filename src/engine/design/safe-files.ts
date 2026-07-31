import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

export interface SafeRegularFileMetadata {
  size: number;
  modifiedAt: number;
}

export interface SafeRegularFile extends SafeRegularFileMetadata {
  body: Buffer;
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function canonicalPathForHandle(
  handle: FileHandle,
  target: string,
): Promise<string | null> {
  const descriptorRoots =
    process.platform === "linux"
      ? ["/proc/self/fd", "/dev/fd"]
      : ["/dev/fd", "/proc/self/fd"];
  for (const root of descriptorRoots) {
    const canonical = await realpath(path.join(root, String(handle.fd))).catch(
      () => null,
    );
    if (
      canonical &&
      canonical !== path.join(root, String(handle.fd)) &&
      !canonical.startsWith(`${root}${path.sep}`)
    ) {
      return canonical;
    }
  }

  // Descriptor links are unavailable on some hosts. Fall back to verifying
  // that the current canonical path still names the already-open inode.
  const canonical = await realpath(target).catch(() => null);
  if (!canonical) return null;
  const [opened, current] = await Promise.all([
    handle.stat(),
    stat(canonical).catch(() => null),
  ]);
  return current && opened.dev === current.dev && opened.ino === current.ino
    ? canonical
    : null;
}

async function openVerifiedRegularFile(
  root: string,
  target: string,
  maxBytes: number,
): Promise<{ handle: FileHandle; metadata: SafeRegularFileMetadata } | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
  const canonicalRoot = await realpath(root).catch(() => null);
  if (!canonicalRoot) return null;
  const resolvedTarget = path.resolve(target);
  if (
    !within(path.resolve(root), resolvedTarget) ||
    resolvedTarget === path.resolve(root)
  ) {
    return null;
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(resolvedTarget, flags).catch(() => null);
  if (!handle) return null;
  try {
    const [info, canonicalTarget] = await Promise.all([
      handle.stat(),
      canonicalPathForHandle(handle, resolvedTarget),
    ]);
    if (
      !canonicalTarget ||
      !within(canonicalRoot, canonicalTarget) ||
      !info.isFile() ||
      info.size > maxBytes
    ) {
      await handle.close();
      return null;
    }
    return {
      handle,
      metadata: { size: info.size, modifiedAt: info.mtimeMs },
    };
  } catch {
    await handle.close().catch(() => {});
    return null;
  }
}

export async function inspectSafeRegularFile(
  root: string,
  target: string,
  maxBytes: number,
): Promise<SafeRegularFileMetadata | null> {
  const opened = await openVerifiedRegularFile(root, target, maxBytes);
  if (!opened) return null;
  try {
    return opened.metadata;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function readSafeRegularFile(
  root: string,
  target: string,
  maxBytes: number,
): Promise<SafeRegularFile | null> {
  const opened = await openVerifiedRegularFile(root, target, maxBytes);
  if (!opened) return null;
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await opened.handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) return null;
    return {
      body: buffer.subarray(0, offset),
      size: offset,
      modifiedAt: opened.metadata.modifiedAt,
    };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}
