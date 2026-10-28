import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, mkdirSync } from "node:fs";
import path from "node:path";

/** Resolve only the OS-owned aliases macOS puts before temporary/configuration
 * paths. Mutable workspace descendants still reach the no-follow resolver. */
export function resolveSystemPath(file: string): string {
  const target = path.resolve(file);
  if (process.platform === "darwin") {
    for (const prefix of ["/tmp", "/var", "/etc"]) {
      if (target === prefix || target.startsWith(`${prefix}/`))
        return realpathSync(prefix) + target.slice(prefix.length);
    }
  }
  return target;
}

/** Descriptor-relative directory effects on Linux; Darwin's kernel no-follow
 * resolver covers every component for subsequent rename/unlink/mkdir too. */
export function openBoundedDirectorySync(directory: string, create = false): { fd: number; path: string; close(): void } {
  const target = resolveSystemPath(directory);
  if (process.platform === "darwin") {
    const guarded = `/.nofollow${target}`;
    if (create) mkdirSync(guarded, { recursive: true });
    const fd = openSync(guarded, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
    return { fd, path: guarded, close: () => closeSync(fd) };
  }
  if (process.platform !== "linux") throw new Error("Safe file operations are unavailable on this host.");
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let fd = openSync("/", flags);
  try {
    for (const component of target.split(path.sep).filter(Boolean)) {
      const child = `/proc/self/fd/${fd}/${component}`;
      if (create) { try { mkdirSync(child); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
      const next = openSync(child, flags); closeSync(fd); fd = next;
    }
    return { fd, path: `/proc/self/fd/${fd}`, close: () => closeSync(fd) };
  } catch (error) { closeSync(fd); throw error; }
}

/** Walk canonical directories through held descriptors. Only the caller's
 * independently approved root may be canonicalized; descendant links never
 * widen that authority. Darwin's kernel resolver rejects every symlink. */
export function openBoundedFileSync(file: string, root?: string): number {
  let target = path.resolve(file);
  if (root) {
    const relative = path.relative(path.resolve(root), target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("File is outside its approved root.");
    target = path.join(realpathSync(root), relative);
  } else target = resolveSystemPath(target);
  if (process.platform === "darwin")
    return openSync(target, constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000, 0o600);
  if (process.platform !== "linux") throw new Error("Safe configuration reads are unavailable on this host.");
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let directory = openSync("/", directoryFlags);
  try {
    for (const component of path.dirname(target).split(path.sep).filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${directory}/${component}`, directoryFlags);
      closeSync(directory);
      directory = next;
    }
    return openSync(`/proc/self/fd/${directory}/${path.basename(target)}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } finally { closeSync(directory); }
}

/** Read one inspected file generation without reopening its path or reading
 * unbounded growth. The caller owns the descriptor and its current position. */
export function readBoundedUtf8DescriptorSync(
  fd: number,
  maxBytes: number,
): string {
  return readBoundedBufferDescriptorSync(fd, maxBytes).toString("utf8");
}

export function readBoundedBufferDescriptorSync(fd: number, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("Invalid file read limit.");
  const info = fstatSync(fd);
  if (!info.isFile())
    throw Object.assign(new Error("Expected a regular file."), {
      code: info.isDirectory() ? "EISDIR" : "EINVAL",
    });
  if (info.size > maxBytes) throw new Error("File is too large.");
  const bytes = Buffer.alloc(info.size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  const after = fstatSync(fd);
  if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
    throw new Error("File changed during read.");
  return bytes.subarray(0, offset);
}

/** Symlinks to native configuration files remain supported. Nonblocking opens
 * let the descriptor check reject pipes and devices without waiting for data. */
export function readBoundedUtf8FileSync(
  file: string,
  maxBytes: number,
  policy?: { noFollow: true; root?: string },
): string {
  const fd = policy ? openBoundedFileSync(file, policy.root) : openSync(file, constants.O_RDONLY | constants.O_NONBLOCK, 0o600);
  try {
    return readBoundedUtf8DescriptorSync(fd, maxBytes);
  } finally {
    closeSync(fd);
  }
}
