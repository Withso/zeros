import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

/** Operator documents are read through the descriptor whose type, ownership
 * and size were checked. Never reopen a checked path or follow a FIFO/link. */
export function readBoundedJsonFile(
  file: string,
  maximumBytes: number,
  ownerOnly = false,
): unknown {
  const invalid = () => new Error("Operator document is unsafe or invalid");
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 2 ||
    maximumBytes > 2 * 1024 * 1024
  )
    throw invalid();
  const resolved = path.resolve(file);
  const assertPrivateParent = () => {
    const parent = path.dirname(resolved);
    const directory = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(directory, { bigint: true });
      const named = lstatSync(parent, { bigint: true });
      if (
        !stat.isDirectory() ||
        (process.getuid && stat.uid !== BigInt(process.getuid())) ||
        (stat.mode & 0o077n) !== 0n ||
        !named.isDirectory() ||
        named.dev !== stat.dev ||
        named.ino !== stat.ino ||
        realpathSync(parent) !== parent ||
        (process.platform === "linux" &&
          realpathSync(`/proc/self/fd/${directory}`) !== parent)
      )
        throw invalid();
      return stat;
    } finally {
      closeSync(directory);
    }
  };
  const fd = openSync(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes: Buffer | undefined;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 2n ||
      before.size > BigInt(maximumBytes) ||
      (ownerOnly &&
        ((process.getuid && before.uid !== BigInt(process.getuid())) ||
          (before.mode & 0o077n) !== 0n)) ||
      realpathSync(resolved) !== resolved ||
      (process.platform === "linux" &&
        realpathSync(`/proc/self/fd/${fd}`) !== resolved)
    )
      throw invalid();
    const parentBefore = ownerOnly ? assertPrivateParent() : undefined;
    const assertNamedFile = () => {
      const named = lstatSync(resolved, { bigint: true });
      if (
        !named.isFile() ||
        named.dev !== before.dev ||
        named.ino !== before.ino
      )
        throw invalid();
    };
    assertNamedFile();
    bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      BigInt(length) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.gid !== after.gid ||
      before.nlink !== after.nlink ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw invalid();
    if (parentBefore) {
      const parentAfter = assertPrivateParent();
      if (
        parentBefore.dev !== parentAfter.dev ||
        parentBefore.ino !== parentAfter.ino ||
        parentBefore.uid !== parentAfter.uid ||
        parentBefore.gid !== parentAfter.gid ||
        parentBefore.mode !== parentAfter.mode
      )
        throw invalid();
    }
    assertNamedFile();
    try {
      return JSON.parse(bytes.toString("utf8", 0, length)) as unknown;
    } catch {
      throw invalid();
    }
  } finally {
    bytes?.fill(0);
    closeSync(fd);
  }
}
