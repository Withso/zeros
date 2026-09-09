import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** Read one inspected file generation without reopening its path or reading
 * unbounded growth. The caller owns the descriptor and its current position. */
export function readBoundedUtf8DescriptorSync(
  fd: number,
  maxBytes: number,
): string {
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
  if (offset !== info.size) throw new Error("File changed during read.");
  return bytes.subarray(0, offset).toString("utf8");
}

/** Symlinks to native configuration files remain supported. Nonblocking opens
 * let the descriptor check reject pipes and devices without waiting for data. */
export function readBoundedUtf8FileSync(
  file: string,
  maxBytes: number,
): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK, 0o600);
  try {
    return readBoundedUtf8DescriptorSync(fd, maxBytes);
  } finally {
    closeSync(fd);
  }
}
