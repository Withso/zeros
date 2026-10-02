import fs from "node:fs";
import path from "node:path";

export const GUARDED_FILE_BYTES = 2_000_000;

export class WorkspaceFileGuardError extends Error {}

export function isCanonicalWorkspaceFilePath(candidate: string): boolean {
  return (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= 4096 &&
    !candidate.includes("\\") &&
    Array.from(candidate).every(
      (character) =>
        character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
    ) &&
    !candidate.startsWith("/") &&
    !/^[A-Za-z]:/.test(candidate) &&
    candidate
      .split("/")
      .every(
        (part) =>
          !!part &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== ".git",
      )
  );
}

const changed = () =>
  new WorkspaceFileGuardError(
    "The file changed. Refresh it before saving; your draft is still available.",
  );
const refused = () =>
  new WorkspaceFileGuardError(
    "Use a regular file at its original workspace-relative path; aliases are refused.",
  );
const fingerprint = (info: fs.Stats) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`;

/** A guarded edit cannot switch owners or disguise Design source through a
 * symlink/hardlink. Resolve the trusted root, then inspect each real entry. */
export function assertGuardedWorkspaceFilePath(
  cwd: string,
  relative: string,
): string {
  if (!isCanonicalWorkspaceFilePath(relative)) throw refused();
  let current = fs.realpathSync(cwd);
  const segments = relative.split("/");
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    try {
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1))
        throw refused();
      if (i < segments.length - 1) {
        if (!info.isDirectory() || fs.existsSync(path.join(current, ".git")))
          throw refused();
      } else if (!info.isFile()) throw refused();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // An absent suffix is safe only for an explicitly absent snapshot. The
      // content comparison below owns that distinction.
      current = path.join(current, ...segments.slice(i + 1));
      break;
    }
  }
  return current;
}

/** Compare bounded UTF-8 bytes through one non-following descriptor. Return a
 * generation identity so an identical-content inode replacement also fails
 * closed between temporary-file preparation and final atomic rename. */
export function inspectExpectedFileContent(
  target: string,
  expected: string | null,
): string {
  if (
    expected !== null &&
    (typeof expected !== "string" ||
      Buffer.byteLength(expected, "utf8") > GUARDED_FILE_BYTES)
  )
    throw refused();
  let fd: number;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (expected === null) return "absent";
      throw changed();
    }
    throw refused();
  }
  try {
    if (expected === null) throw changed();
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > GUARDED_FILE_BYTES
    )
      throw refused();
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(target);
    if (
      count !== before.size ||
      fingerprint(before) !== fingerprint(after) ||
      fingerprint(named) !== fingerprint(after) ||
      named.isSymbolicLink() ||
      !bytes.subarray(0, count).equals(Buffer.from(expected, "utf8"))
    )
      throw changed();
    return fingerprint(after);
  } finally {
    fs.closeSync(fd);
  }
}

export function inspectExpectedWorkspaceContent(
  cwd: string,
  relative: string,
  expected: string | null,
): string {
  try {
    return inspectExpectedFileContent(
      assertGuardedWorkspaceFilePath(cwd, relative),
      expected,
    );
  } catch (error) {
    if (error instanceof WorkspaceFileGuardError) throw error;
    throw changed();
  }
}
