import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { LIMITS } from "./config.mjs";
import { invariant } from "./contracts.mjs";

const unchanged = (before, after) =>
  ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"].every(
    (key) => before[key] === after[key],
  );

/** The caller supplies a canonical root (including resolved pnpm package roots). */
export function readBoundedRegularFile(
  root,
  file,
  { allowExecutable = true } = {},
) {
  const full = resolve(root, file);
  invariant(
    full.startsWith(`${root}${sep}`) && realpathSync(full) === full,
    "File is outside its root or contains a symlink.",
  );
  const fd = openSync(
    full,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    invariant(
      before.isFile() &&
        (allowExecutable || (before.mode & 0o111) === 0) &&
        Number.isSafeInteger(before.size) &&
        before.size >= 0 &&
        before.size <= LIMITS.file,
      "File is not a bounded regular file with the expected permissions.",
    );
    // O_NOFOLLOW guards the leaf only. Recheck the parent path and the opened
    // inode before reading, then check them again before returning any bytes.
    const assertNamedFile = () =>
      invariant(
        realpathSync(full) === full && unchanged(before, lstatSync(full)),
        "File changed while being read.",
      );
    assertNamedFile();
    // Read at most the validated size plus one byte, even if a writer grows it.
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    invariant(
      length === before.size && unchanged(before, fstatSync(fd)),
      "File changed while being read.",
    );
    assertNamedFile();
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
