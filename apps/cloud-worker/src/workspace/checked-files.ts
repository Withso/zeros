import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { WorkspaceError, type WorkspaceScope } from "./scope";

export const descriptorPath = (handle: FileHandle): string => `/proc/self/fd/${handle.fd}`;

/** The worker is Linux-only. Held descriptors close the stat/read and
 * parent/rename gaps without a new native filesystem dependency. Symlinks are
 * allowed only when their resolved target remains in this checkout. */
export class CheckedFiles {
  constructor(readonly scope: WorkspaceScope) {}

  async assertDescriptor(handle: FileHandle): Promise<void> {
    const [root, target] = await Promise.all([realpath(this.scope.root), realpath(descriptorPath(handle))]);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).includes(".git") || target.endsWith(" (deleted)")) throw new WorkspaceError("VALIDATION_FAILED", "The file moved outside the workspace.");
  }

  private async resolved(path: string): Promise<string> {
    const [root, target] = await Promise.all([realpath(this.scope.root), realpath(path)]);
    if (target !== root && !target.startsWith(root + sep)) throw new WorkspaceError("VALIDATION_FAILED", "The path resolves outside the workspace.");
    if (relative(root, target).split(sep).includes(".git")) throw new WorkspaceError("VALIDATION_FAILED", "Git metadata is not a workspace file.");
    return target;
  }

  async file(value: unknown): Promise<FileHandle> {
    const target = await this.resolved(this.scope.path(value));
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      await this.assertDescriptor(handle);
      if (!(await handle.stat()).isFile()) throw new WorkspaceError("VALIDATION_FAILED", "This path is not a regular file.");
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  async directory(value: unknown = this.scope.root, create = false): Promise<FileHandle> {
    const target = this.scope.path(value, true);
    let handle = await open(await this.resolved(this.scope.root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const part of relative(this.scope.root, target).split(sep).filter(Boolean)) {
        await this.assertDescriptor(handle);
        const childPath = `${descriptorPath(handle)}/${part}`;
        if (create) await mkdir(childPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
        const resolved = await this.resolved(childPath);
        const next = await open(resolved, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await handle.close(); handle = next;
      }
      await this.assertDescriptor(handle);
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  async writeParent(value: unknown): Promise<{ parent: FileHandle; mode: number }> {
    const path = this.scope.path(value);
    // A final symlink outside the checkout is refused even though atomic
    // replacement would not follow it. Keep read/write policy symmetric.
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info) {
      if (info.isSymbolicLink()) await this.resolved(path);
      else if (!info.isFile()) throw new WorkspaceError("VALIDATION_FAILED", "This path is not a regular file.");
    }
    const parent = await this.directory(resolve(dirname(path)), true);
    return { parent, mode: info && !info.isSymbolicLink() ? info.mode & 0o777 : 0o644 };
  }
}
