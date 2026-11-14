import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { portableDesignName } from "@zeros/protocol/design-path";
import { zerosDataDir } from "../db/paths";

const MAX_METADATA_BYTES = 16 * 1024 * 1024;

// A page migration checks every path of a page folder, each against a full
// listing of its parent, so the listings grow with the square of the folder.
// Inside one synchronous pass a directory's listing is reused. Every change
// this process makes to a directory forgets the listings, because timestamps
// can be too coarse to show it (Linux updates them per clock tick). The stamp
// catches changes other processes make, only as finely as the filesystem
// records them; the check and the write that follows are not atomic anyway.
let listings: Map<string, { stamp: string; spellings: Map<string, string> }> | null = null;

/** Record a change this process made to `directory`'s entries: reused
 * listings are forgotten, and a caller batching directory syncs adds it to
 * `pending` for `syncDesignStorageDirectories`. */
export function changedDesignStorageDirectory(directory: string, pending?: Set<string>): void {
  pending?.add(directory);
  if (!listings) return;
  let key: string;
  try {
    key = realpathSync(directory);
  } catch {
    listings.clear();
    return;
  }
  listings.delete(key);
}

/** Sync each directory a batch changed, once. */
export function syncDesignStorageDirectories(pending: Set<string>): void {
  for (const directory of pending) syncDirectory(directory);
  pending.clear();
}

/** `mkdir -p`, then sync every parent whose entries it changed. */
export function makeDurableDesignStorageDirectory(directory: string): void {
  const first = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (first === undefined) return;
  const created = path.relative(path.dirname(first), directory).split(path.sep);
  let parent = path.dirname(first);
  for (const part of created) {
    changedDesignStorageDirectory(parent);
    syncDirectory(parent);
    parent = path.join(parent, part);
  }
}

/** Run synchronous storage work that reuses unchanged directory listings. */
export function withDesignStorageListings<T>(run: () => T): T {
  if (listings) return run();
  listings = new Map();
  try {
    const result = run();
    if (result instanceof Promise) throw new Error("Design storage listings are reused only by synchronous work.");
    return result;
  } finally {
    listings = null;
  }
}

/** The first listed entry of `directory` with `part`'s portable name. */
function listedSpelling(directory: string, part: string): string | undefined {
  const key = portableDesignName(part);
  if (!listings) return readdirSync(directory).find((entry) => portableDesignName(entry) === key);
  const info = lstatSync(directory, { bigint: true });
  const stamp = `${info.dev}:${info.ino}:${info.size}:${info.nlink}:${info.mtimeNs}:${info.ctimeNs}`;
  let listing = listings.get(directory);
  if (listing?.stamp !== stamp) {
    const spellings = new Map<string, string>();
    for (const entry of readdirSync(directory)) {
      const name = portableDesignName(entry);
      if (!spellings.has(name)) spellings.set(name, entry);
    }
    listing = { stamp, spellings };
    listings.set(directory, listing);
  }
  return listing.spellings.get(key);
}

/** Every segment uses its exact portable spelling and its own inode. This is
 * also used for prospective paths, before creating any parent directories. */
export function assertSafeDesignStoragePath(
  root: string,
  relative: string,
  createParents = false,
  /** A directory leaf gets the checks of an intermediate component; callers
   * otherwise append a sentinel file name, which lists the whole directory. */
  leaf: "file" | "directory" = "file",
): string {
  const parts = relative.split("/");
  if (
    !relative ||
    path.isAbsolute(relative) ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        Array.from(part).some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ),
    )
  )
    throw new Error("Unsafe Design storage path.");
  let parent = realpathSync(root);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index],
      candidate = path.join(parent, part);
    const spelling = listedSpelling(parent, part);
    if (spelling !== undefined && spelling !== part)
      throw new Error("Design storage path has ambiguous spelling.");
    let info;
    try {
      info = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (info) {
      if (
        info.isSymbolicLink() ||
        realpathSync(candidate) !== candidate ||
        (index < parts.length - 1 || leaf === "directory"
          ? !info.isDirectory()
          : !info.isFile() || info.nlink !== 1)
      )
        throw new Error(
          "Design storage must use real directories and unlinked regular files.",
        );
    } else if (index < parts.length - 1) {
      if (createParents) {
        mkdirSync(candidate);
        changedDesignStorageDirectory(parent);
      } else return path.join(parent, ...parts.slice(index));
    }
    parent = candidate;
  }
  return parent;
}

/** Large metadata (a 26k-frame canvas is ~8 MB) is re-read several times per
 * request to compare generations. Identical bytes decode to the identical
 * string, so a read returns the one decoded before: nothing decodes again,
 * and comparing two reads of unchanged bytes is a pointer check. */
const MIN_REUSED_DECODE_BYTES = 256 * 1024;
const MAX_REUSED_DECODE_BYTES = 32 * 1024 * 1024;
const reusedDecodes = new Map<string, { bytes: Buffer; source: string; strict?: boolean }>();
let reusedDecodeBytes = 0;

function decodeDesignStorageBytes(target: string, content: Buffer, strictUtf8: boolean): string {
  const reusable = content.length >= MIN_REUSED_DECODE_BYTES && content.length <= MAX_REUSED_DECODE_BYTES / 2;
  let entry = reusable ? reusedDecodes.get(target) : undefined;
  if (entry && !entry.bytes.equals(content)) {
    reusedDecodes.delete(target);
    reusedDecodeBytes -= entry.bytes.length;
    entry = undefined;
  }
  if (!entry) {
    entry = { bytes: content, source: content.toString("utf8") };
    if (reusable) {
      reusedDecodes.set(target, entry);
      reusedDecodeBytes += content.length;
      while (reusedDecodeBytes > MAX_REUSED_DECODE_BYTES) {
        const [oldest, value] = reusedDecodes.entries().next().value!;
        reusedDecodes.delete(oldest);
        reusedDecodeBytes -= value.bytes.length;
      }
    }
  } else {
    reusedDecodes.delete(target);
    reusedDecodes.set(target, entry);
  }
  if (strictUtf8) {
    entry.strict ??= Buffer.from(entry.source, "utf8").equals(content);
    if (!entry.strict)
      throw new Error(
        "Design source is not valid UTF-8; repair it before migration.",
      );
  }
  return entry.source;
}

export function readDesignStorageFile(
  root: string,
  relative: string,
  limit = MAX_METADATA_BYTES,
  strictUtf8 = false,
): string | null {
  let target: string;
  try {
    target = assertSafeDesignStoragePath(root, relative);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let fd: number;
  try {
    fd = openSync(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit)
      throw new Error("Unsafe or oversized Design metadata file.");
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0,
      count = 0;
    do {
      count = readSync(fd, bytes, offset, bytes.length - offset, null);
      offset += count;
    } while (count && offset < bytes.length);
    if (offset !== info.size)
      throw new Error("Design metadata changed during read.");
    const current = lstatSync(target);
    if (
      current.ino !== info.ino ||
      current.dev !== info.dev ||
      current.mtimeMs !== info.mtimeMs ||
      current.nlink !== 1
    )
      throw new Error("Design metadata changed during read.");
    return decodeDesignStorageBytes(target, bytes.subarray(0, offset), strictUtf8);
  } finally {
    closeSync(fd);
  }
}

export function designPrivateStorageDirectory(workspace: string): string {
  const key = createHash("sha256")
    .update(path.resolve(workspace))
    .digest("hex")
    .slice(0, 32);
  return path.join(zerosDataDir(), "design-storage", key);
}
function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export interface DesignStorageAtomicOptions {
  /** An admitted migration owns this exact temporary name across restarts. */
  temporaryToken?: string;
  afterPrepare?: () => void;
  /** Recheck migration inputs after preparing the temporary, before publish. */
  beforePublish?: () => void;
  /** The caller syncs this write's directory later, with the rest of its
   * batch: the directory is added here instead of synced after the rename. */
  deferDirectorySync?: Set<string>;
}
function atomicWrite(
  root: string,
  relative: string,
  source: string,
  mode = 0o600,
  options?: DesignStorageAtomicOptions,
): void {
  const target = assertSafeDesignStoragePath(root, relative, true);
  if (options?.temporaryToken !== undefined && !/^[a-f0-9]{32}$/.test(options.temporaryToken))
    throw new Error("Invalid Design migration temporary identity.");
  const temporaryFile = `${relative}.${options?.temporaryToken ?? randomUUID()}.zeros-tmp`;
  const temporary = assertSafeDesignStoragePath(root, temporaryFile);
  if (options?.temporaryToken && existsSync(temporary)) {
    unlinkSync(temporary);
    changedDesignStorageDirectory(path.dirname(target));
    syncDirectory(path.dirname(target));
  }
  const fd = openSync(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    mode,
  );
  changedDesignStorageDirectory(path.dirname(target));
  try {
    writeFileSync(fd, source, "utf8");
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // A crash here leaves only this migration's checked, deterministic temporary.
  // The next attempt safely replaces it before publishing the successor.
  options?.afterPrepare?.();
  try {
    assertSafeDesignStoragePath(root, relative);
    options?.beforePublish?.();
    renameSync(temporary, target);
    changedDesignStorageDirectory(path.dirname(target), options?.deferDirectorySync);
    if (!options?.deferDirectorySync) syncDirectory(path.dirname(target));
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
      changedDesignStorageDirectory(path.dirname(target));
    }
  }
}
export function writePrivateDesignState(
  workspace: string,
  name: string,
  source: string,
  options?: DesignStorageAtomicOptions,
): string {
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(name))
    throw new Error("Invalid private Design state name.");
  const root = designPrivateStorageDirectory(workspace);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  atomicWrite(root, name, source, 0o600, options);
  return path.join(root, name);
}

export {
  atomicWrite as atomicWriteDesignStorageFile,
  syncDirectory as syncDesignStorageDirectory,
};
