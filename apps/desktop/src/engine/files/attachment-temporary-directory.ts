import fs from "node:fs/promises";
import { constants } from "node:fs";
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

/** Check candidate ancestors because a path outside the workspace can still be inside a marked checkout. */
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

// Foundation finds temp space on the destination volume; pass the workspace as argv, never script source.
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

/** Linux rejects rename across bind mounts that share st_dev, so compare the opened directories' kernel mount IDs. */
async function mountId(directory: string): Promise<string | null> {
  if (process.platform !== "linux") return null;
  const handle = await fs.open(directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
    const id = /^mnt_id:\s*(\d+)\s*$/m.exec(info)?.[1];
    if (!id) throw new Error("Cannot identify attachment storage mount");
    return id;
  } finally {
    await handle.close();
  }
}

/** Keep temporary bytes outside the workspace but on its mount for atomic publication; recovery retains the source separately. */
export async function createAttachmentTemporaryDirectory(
  workspaceRoot: string,
): Promise<AttachmentTemporaryDirectory> {
  const workspace = await fs.realpath(workspaceRoot);
  const device = (await fs.stat(workspace)).dev;
  const workspaceMount = await mountId(workspace);
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
      if (await mountId(real) !== workspaceMount) return null;
      return (await outsideOwnedFolders(real)) ? real : null;
    } catch {
      return null;
    }
  };
  const allocate = async (parent: string, replacementParent = false) => {
    // Recheck the owner-only directory after allocation in case a mount or symlink changed.
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

  // Private app data is a fallback when TMPDIR is on another volume or inside a checkout.
  const candidates = [os.tmpdir()];
  // A configured path is only a hint and must pass the same mount and ownership checks.
  if (process.env.ZEROS_ATTACHMENT_TEMP_DIR)
    candidates.push(process.env.ZEROS_ATTACHMENT_TEMP_DIR);
  candidates.push(zerosDataDir());
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
  // When OS temp is on another volume, try a sibling outside any enclosing checkout.
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
