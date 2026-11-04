import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdtemp, open, readlink, rename, rm, rmdir, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TurnResetHost } from "@zeros/protocol/turns";
import { CheckedFiles, descriptorPath } from "./checked-files";
import { commandRunner, type CommandOptions } from "./commands";
import { WorkspaceError, type WorkspaceScope } from "./scope";
import { withResetIndex } from "./turn-reset-index";

const LIMIT = 64 * 1024 * 1024;
const oid = (value: string) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value) ? value : null;

export function turnResetHost(scope: WorkspaceScope, snapshot: TurnResetHost["snapshot"]): TurnResetHost {
  const checked = new CheckedFiles(scope), run = commandRunner(scope.root);
  const available = new Map<string, Promise<boolean>>();
  const git = async (args: string[], options: CommandOptions = {}) =>
    (await run("git", args, { maxBuffer: LIMIT, ...options })).stdout;
  const contents = async (file: FileHandle): Promise<Buffer> => {
      const before = await file.stat();
      if (!before.isFile()) throw new WorkspaceError("FILE_CHANGED", "The file changed during turn reset.");
      if (before.size > LIMIT) throw new WorkspaceError("GIT_OUTPUT_TOO_LARGE", "This turn file is too large to reset.");
      const data = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await file.stat();
      await checked.assertDescriptor(file);
      if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw new WorkspaceError("FILE_CHANGED", "The file changed during turn reset.");
      return data.subarray(0, offset);
  };
  const read = async (path: string): Promise<Buffer | null> => {
    let file;
    try { file = await checked.file(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try { return await contents(file); }
    finally { await file.close(); }
  };
  const capturedContents = async (path: string | null): Promise<Buffer | null> => {
    if (path === null) return null;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { return await contents(file); }
    finally { await file.close(); }
  };
  const publish = async (parent: FileHandle, target: string, temporary: string | undefined, matches: (captured: string | null) => Promise<boolean>) => {
    await checked.assertDescriptor(parent);
    const retirement = await mkdtemp(join(descriptorPath(parent), ".zeros-reset-")), captured = join(retirement, "original");
    let retained = false;
    try {
      try { await rename(target, captured); retained = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!await matches(retained ? captured : null)) throw new WorkspaceError("FILE_CHANGED", "The file changed during turn reset.");
      await checked.assertDescriptor(parent);
      if (temporary) {
        try { await link(temporary, target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceError("FILE_CHANGED", "The file changed during turn reset.");
          throw error;
        }
      }
      if (retained) { await unlink(captured); retained = false; }
    } finally {
      // Inspect the captured entry, never a public path that another writer can
      // replace. On conflict, no-overwrite restoration keeps both versions;
      // the private alias remains recoverable even if restoration loses a race.
      if (retained) await link(captured, target).catch(() => {});
      await rmdir(retirement).catch(() => {});
    }
  };
  const contentOid = async (path: string, contents: Buffer | null) => contents === null ? null :
    oid((await git(["hash-object", `--path=${scope.relative(path)}`, "--stdin"], { input: contents })).trim());
  const diskBlobOid = async (path: string) => contentOid(path, await read(path));
  const revision = (value: string) => {
    if (!oid(value)) throw new WorkspaceError("VALIDATION_FAILED", "Invalid turn snapshot.");
    return value;
  };
  const readDiskText: TurnResetHost["readDiskText"] = async path => {
    try {
      const data = await read(path);
      return data ? { text: data.toString("utf8"), isBinary: data.includes(0) } : null;
    } catch { return null; }
  };
  const restore = async (path: string, rev: string | null, expected?: string | null, stagedOid?: string) => {
    const relative = scope.relative(path), { parent } = await checked.writeParent(relative);
    const target = join(descriptorPath(parent), basename(relative)), temporary = `${target}.${randomUUID()}.reset`;
    let scratch: string | undefined;
    try {
      const publishFile = async () => {
        if (rev) {
          scratch = await mkdtemp(join(tmpdir(), "zeros-turn-restore-"));
          const isolated = commandRunner(scope.root, { GIT_INDEX_FILE: join(scratch, "index") });
          await isolated("git", ["read-tree", revision(rev)]);
          await isolated("git", ["checkout-index", `--prefix=${scratch}/files/`, "--", relative]);
          const source = join(scratch, "files", relative), info = await lstat(source);
          if (info.isSymbolicLink()) await symlink(await readlink(source), temporary);
          else if (info.isFile()) await copyFile(source, temporary, constants.COPYFILE_EXCL);
          else throw new WorkspaceError("VALIDATION_FAILED", "Unsupported turn file type.");
        }
        const current = await diskBlobOid(relative);
        if (expected !== undefined && current !== expected)
          throw new WorkspaceError("FILE_CHANGED", "The file changed during turn reset.");
        await publish(parent, target, rev ? temporary : undefined,
          async captured => await contentOid(relative, await capturedContents(captured)) === current);
      };
      if (stagedOid) await withResetIndex(scope.root, relative, rev ? revision(rev) : null, stagedOid, publishFile);
      else await publishFile();
    } finally {
      await unlink(temporary).catch(() => {}); await parent.close();
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  };
  return {
    snapshotAvailable: rev => {
      let checking = available.get(rev);
      if (!checking) { checking = git(["cat-file", "-e", `${revision(rev)}^{tree}`]).then(() => true, () => false); available.set(rev, checking); }
      return checking;
    },
    blobOid: async (rev, path) => oid((await git(["rev-parse", `${revision(rev)}:${scope.relative(path)}`]).catch(() => "")).trim()),
    indexBlobOid: async path => oid((await git(["rev-parse", `:0:${scope.relative(path)}`]).catch(() => "")).trim()),
    diskBlobOid, readDiskText,
    showText: async (rev, path) => {
      try { const text = await git(["show", `${revision(rev)}:${scope.relative(path)}`]); return { text, isBinary: text.includes("\0") }; }
      catch { return null; }
    },
    restoreIndex: (path, rev) => git(["restore", `--source=${revision(rev)}`, "--staged", "--", `:(literal)${scope.relative(path)}`]),
    removeIndex: path => git(["update-index", "--force-remove", "--", scope.relative(path)]),
    restore,
    restoreStaged: (path, rev, expected) => restore(path, rev, expected, expected),
    mergeText: async (ours, base, theirs) => {
      const scratch = await mkdtemp(join(tmpdir(), "zeros-turn-merge-"));
      try {
        const paths = ["ours", "base", "theirs"].map(name => join(scratch, name));
        await Promise.all(paths.map((path, index) => writeFile(path, [ours, base, theirs][index]!, { flag: "wx", mode: 0o600 })));
        const result = await run("git", ["merge-file", "-p", "-q", ...paths], { maxBuffer: LIMIT, allowExitCodes: [1, 2, 3, 4, 5, 127] });
        return { merged: result.stdout, conflict: result.code !== 0 };
      } finally { await rm(scratch, { recursive: true, force: true }); }
    },
    publishMerge: async (path, merged, expected) => {
      const { parent, mode } = await checked.writeParent(path);
      const target = join(descriptorPath(parent), basename(scope.relative(path))), temporary = `${target}.${randomUUID()}.merge`;
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
        try { await file.writeFile(merged); await file.chmod(mode); } finally { await file.close(); }
        if ((await readDiskText(path))?.text !== expected) return false;
        await publish(parent, target, temporary, async captured => (await capturedContents(captured))?.toString("utf8") === expected);
        return true;
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === "FILE_CHANGED") return false;
        throw error;
      } finally { await unlink(temporary).catch(() => {}); await parent.close(); }
    },
    snapshot,
    // Durable undo records decide which refs survive; pruning before their
    // atomic save could remove the only copy of an earlier undo's turn trees.
    prune: async () => {},
  };
}
