import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { publishCloudWorkspacePath } from "../files/cloud-workspace-ownership";
import { zerosDataDir } from "../db/paths";

const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const portable = (value: string) => value.normalize("NFC").toLowerCase();

/** Every segment uses its exact portable spelling and its own inode. This is
 * also used for prospective paths, before creating any parent directories. */
export function assertSafeDesignStoragePath(
  root: string,
  relative: string,
  createParents = false,
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
    const spelling = readdirSync(parent).find(
      (entry) => portable(entry) === portable(part),
    );
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
        (index < parts.length - 1
          ? !info.isDirectory()
          : !info.isFile() || info.nlink !== 1)
      )
        throw new Error(
          "Design storage must use real directories and unlinked regular files.",
        );
    } else if (index < parts.length - 1) {
      if (createParents) mkdirSync(candidate);
      else return path.join(parent, ...parts.slice(index));
    }
    parent = candidate;
  }
  return parent;
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
    const content = bytes.subarray(0, offset);
    const source = content.toString("utf8");
    if (strictUtf8 && !Buffer.from(source, "utf8").equals(content))
      throw new Error("Design source is not valid UTF-8; repair it before migration.");
    return source;
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
  temporaryToken: string;
  afterPrepare?: () => void;
  /** Recheck migration inputs after preparing the temporary, before publish. */
  beforePublish?: () => void;
}
function atomicWrite(root: string, relative: string, source: string, mode = 0o600, options?: DesignStorageAtomicOptions): void {
  const target = assertSafeDesignStoragePath(root, relative, true);
  if (options && !/^[a-f0-9]{32}$/.test(options.temporaryToken))
    throw new Error("Invalid Design migration temporary identity.");
  const temporaryFile = `${relative}.${options?.temporaryToken ?? randomUUID()}.zeros-tmp`;
  const temporary = assertSafeDesignStoragePath(root, temporaryFile);
  if (options && existsSync(temporary)) {
    unlinkSync(temporary);
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
  try {
    writeFileSync(fd, source, "utf8");
    fchmodSync(fd, mode);
    publishCloudWorkspacePath(temporary, fd);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // A crash here leaves only this migration's checked, deterministic temporary.
  // The next attempt safely replaces it before publishing the successor.
  options?.afterPrepare?.();
  try {
    options?.beforePublish?.();
    assertSafeDesignStoragePath(root, relative);
    renameSync(temporary, target);
    syncDirectory(path.dirname(target));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
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

export { atomicWrite as atomicWriteDesignStorageFile, syncDirectory as syncDesignStorageDirectory };
