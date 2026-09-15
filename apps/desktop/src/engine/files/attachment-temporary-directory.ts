import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zerosDataDir } from "../db/paths";
import { runFile } from "../git/git-exec";
import {
  recordAttachmentTemporaryDirectory,
  pruneAttachmentTemporaryDirectories,
} from "./attachment-temporary-records";
export { pruneAttachmentTemporaryDirectories } from "./attachment-temporary-records";

const sweptRoots = new Set<string>();

/** A workspace can itself be nested inside another checkout or Design folder.
 * Temporary storage must be outside every enclosing repository/Design boundary. */
async function outsideOwnedFolders(candidate: string): Promise<boolean> {
  for (let parent = candidate; ; parent = path.dirname(parent)) {
    for (const marker of [".git", "design.toml"]) {
      try {
        await fs.lstat(path.join(parent, marker));
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
    if (path.dirname(parent) === parent) return true;
  }
}

// Foundation selects temporary space on the destination volume, including an
// external disk. The destination is an argv value, never executable source.
// No application automation or development tools are involved.
export const MACOS_ATTACHMENT_TEMP_SCRIPT = `
ObjC.import("Foundation");
function run(argv) {
  const error = Ref();
  const directory = $.NSFileManager.defaultManager.URLForDirectoryInDomainAppropriateForURLCreateError(
    $.NSItemReplacementDirectory, $.NSUserDomainMask,
    $.NSURL.fileURLWithPath(argv[0]), true, error
  );
  if (directory.isNil()) throw new Error("Cannot prepare attachment storage");
  return JSON.stringify(ObjC.unwrap(directory.path));
}`;

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

export interface AttachmentTemporaryDirectory {
  path: string;
  dispose: () => Promise<void>;
}

/** A copy can become visible in one rename only on its destination filesystem.
 * Keep every intermediate byte outside the workspace. Recovery uses the
 * separately persisted source, so these temporary files are disposable. */
export async function createAttachmentTemporaryDirectory(
  workspaceRoot: string,
): Promise<AttachmentTemporaryDirectory> {
  const workspace = await fs.realpath(workspaceRoot);
  const device = (await fs.stat(workspace)).dev;
  const dataRoot = zerosDataDir();
  if (!sweptRoots.has(dataRoot)) {
    sweptRoots.add(dataRoot);
    void pruneAttachmentTemporaryDirectories().catch(() => {});
  }
  const suitable = async (candidate: string): Promise<string | null> => {
    try {
      const real = await fs.realpath(candidate);
      if (within(workspace, real)) return null;
      const stat = await fs.stat(real);
      if (!stat.isDirectory() || stat.dev !== device) return null;
      return (await outsideOwnedFolders(real)) ? real : null;
    } catch {
      return null;
    }
  };
  const allocate = async (parent: string, replacementParent = false) => {
    // mkdtemp creates an unpredictable, owner-only directory. Recheck after
    // creation so a changed mount or symlink cannot redirect a copy into repo.
    const directory = await fs.mkdtemp(path.join(parent, "zeros-attachment-"));
    if (!(await suitable(directory))) {
      await fs.rmdir(directory).catch(() => {});
      throw new Error("Attachment temporary storage changed");
    }
    let forget: () => Promise<void>;
    try {
      forget = await recordAttachmentTemporaryDirectory(
        directory,
        workspace,
        replacementParent,
      );
    } catch (error) {
      await fs.rmdir(directory).catch(() => {});
      throw error;
    }
    return {
      path: directory,
      dispose: async () => {
        await fs.rm(directory, { recursive: true, force: true });
        if (replacementParent) await fs.rmdir(parent).catch(() => {});
        await forget();
      },
    };
  };

  // Existing private app data is also useful when TMPDIR is on another disk
  // or points into a checkout. Never create a fallback folder in the repo.
  const candidates = [os.tmpdir(), zerosDataDir()];
  if (process.platform !== "win32") candidates.push("/var/tmp");
  for (const candidate of new Set(candidates)) {
    const parent = await suitable(candidate);
    if (!parent) continue;
    try {
      return await allocate(parent);
    } catch (error) {
      if (
        !["EACCES", "EPERM", "ENOENT", "EROFS"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }

  if (process.platform === "darwin") {
    const { stdout } = await runFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MACOS_ATTACHMENT_TEMP_SCRIPT, workspace],
      { timeoutMs: 10_000, maxBufferBytes: 16 * 1024 },
    );
    const candidate: unknown = JSON.parse(stdout);
    if (typeof candidate !== "string" || !path.isAbsolute(candidate))
      throw new Error("Invalid attachment temporary directory");
    const parent = await suitable(candidate);
    if (!parent)
      throw new Error(
        "Attachment temporary storage must be outside the workspace on the same filesystem",
      );
    try {
      return await allocate(parent, true);
    } catch (error) {
      await fs.rmdir(parent).catch(() => {});
      throw error;
    }
  }
  // Mounted Linux workspaces and secondary Windows drives may not share a
  // filesystem with OS/app temporary storage. Allocate a short-lived private
  // sibling (or ancestor sibling), never a folder inside a surrounding repo.
  for (
    let ancestor = path.dirname(workspace);
    ancestor !== workspace;
    ancestor = path.dirname(ancestor)
  ) {
    const parent = await suitable(ancestor);
    if (parent) {
      try {
        return await allocate(parent);
      } catch (error) {
        if (
          !["EACCES", "EPERM", "ENOENT", "EROFS"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
    }
    if (path.dirname(ancestor) === ancestor) break;
  }
  throw new Error(
    "No private temporary storage is available on this workspace's filesystem",
  );
}
