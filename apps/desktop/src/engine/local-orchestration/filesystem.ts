// Files read or written by the engine on a sandboxed agent's behalf must
// remain inside their admitted directory even while the agent renames paths.

import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { resolveSystemPath } from "../files/bounded-read-sync";

// Darwin's public open(2) flag is not exposed by node:fs constants. Unlike
// O_NOFOLLOW, it rejects symlinks in every component of an absolute path.
// Darwin rejects combining these two flags with EINVAL.
const DARWIN_NOFOLLOW_ANY = 0x20000000;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export const LOCAL_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface LocalDirectory {
  handle: FileHandle;
  /** Only append single filenames to this path; never resolve it again. */
  path: string;
}

/** `directory` is already canonical. Linux walks from a pinned root without
 * following links; macOS applies the kernel's no-follow path resolver to all
 * later operations (including rename/unlink). Older hosts without that
 * resolver fail closed: admission keeps the HTTP and MCP paths available. */
export async function openLocalDirectory(directory: string): Promise<LocalDirectory> {
  if (process.platform === "darwin") {
    const guarded = `/.nofollow${resolveSystemPath(directory)}`;
    const handle = await open(guarded, constants.O_RDONLY | constants.O_DIRECTORY | DARWIN_NOFOLLOW_ANY);
    return { handle, path: guarded };
  }
  if (process.platform !== "linux") throw new Error("Safe Local file transport is unavailable on this host.");
  let handle = await open("/", DIRECTORY_FLAGS);
  try {
    for (const component of path.resolve(directory).split(path.sep).filter(Boolean)) {
      const next = await open(`/proc/self/fd/${handle.fd}/${component}`, DIRECTORY_FLAGS);
      await handle.close();
      handle = next;
    }
    return { handle, path: `/proc/self/fd/${handle.fd}` };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Open once, without following any mutable path component. The caller must
 * inspect and read this descriptor, never reopen the validated pathname. */
export async function openLocalFile(file: string): Promise<FileHandle> {
  if (process.platform === "darwin") return open(resolveSystemPath(file), constants.O_RDONLY | constants.O_NONBLOCK | DARWIN_NOFOLLOW_ANY);
  const directory = await openLocalDirectory(path.dirname(file));
  try {
    return await open(path.join(directory.path, path.basename(file)), LOCAL_READ_FLAGS);
  } finally {
    await directory.handle.close();
  }
}

/** Bounded even if the file grows after fstat. null means oversized. */
export async function readLocalText(handle: FileHandle, maxBytes: number): Promise<string | null> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let size = 0;
  while (size < buffer.length) {
    const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
    if (bytesRead === 0) break;
    size += bytesRead;
  }
  return size > maxBytes ? null : buffer.subarray(0, size).toString("utf8");
}
