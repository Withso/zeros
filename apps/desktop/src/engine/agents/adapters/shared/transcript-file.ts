import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Provider output is a pointer, not permission to read arbitrary files. The
 * configured provider home is the trust anchor; none of its descendants may
 * redirect a transcript read. Resolving the anchor itself supports projected
 * homes and macOS's /tmp -> /private/tmp alias. */
export async function ownedTranscriptPath(root: string, candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) throw new Error("Transcript path must be absolute");
  const canonicalRoot = await realpath(root);
  const outside = (suffix: string) => !suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix);
  let suffix = relative(resolve(root), candidate);
  // A provider may serialize the canonical spelling of its configured home.
  if (outside(suffix)) suffix = relative(canonicalRoot, candidate);
  if (outside(suffix)) {
    throw new Error("Transcript is outside its provider home");
  }
  let current = canonicalRoot;
  for (const segment of suffix.split(sep)) {
    current = join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Transcript path contains a symlink");
  }
  if (await realpath(current) !== current) throw new Error("Transcript path changed");
  return current;
}

export async function openOwnedTranscript(
  root: string,
  candidate: string,
): Promise<{ handle: FileHandle; stat: Stats }> {
  const canonical = await ownedTranscriptPath(root, candidate);
  const before = await lstat(canonical);
  if (!before.isFile() || before.nlink !== 1) throw new Error("Transcript is not a private regular file");
  // NONBLOCK also protects against a file replaced by a FIFO between lstat
  // and open. NOFOLLOW closes the equivalent leaf-symlink race.
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    const afterPath = await ownedTranscriptPath(root, candidate);
    const after = await lstat(afterPath);
    if (!stat.isFile() || stat.nlink !== 1 || canonical !== afterPath ||
        before.dev !== stat.dev || before.ino !== stat.ino ||
        after.dev !== stat.dev || after.ino !== stat.ino) {
      throw new Error("Transcript changed during open");
    }
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
