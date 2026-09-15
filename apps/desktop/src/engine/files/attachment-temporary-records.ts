import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { zerosDataDir } from "../db/paths";

const registryRoot = () => path.join(zerosDataDir(), "attachment-temporaries");
const GRACE_MS = 86_400_000;
const UUID_FILE = /^[a-f0-9-]{36}\.json$/;
const cleanupCursor = new Map<string, string>();

interface TemporaryRecord {
  version: 1;
  path: string;
  workspace: string;
  dev: number;
  ino: number;
  pid: number;
  createdAt: number;
  replacementParent: boolean;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** The registry contains ownership metadata, never attachment bytes. */
export async function recordAttachmentTemporaryDirectory(
  directory: string,
  workspace: string,
  replacementParent: boolean,
): Promise<() => Promise<void>> {
  // A custom app-data override must not put cleanup metadata in the checkout.
  const data = path.resolve(zerosDataDir());
  if (within(workspace, data))
    throw new Error(
      "Attachment recovery storage must be outside the workspace",
    );
  await fs.mkdir(data, { recursive: true, mode: 0o700 });
  if (within(workspace, await fs.realpath(data)))
    throw new Error(
      "Attachment recovery storage must be outside the workspace",
    );
  const registry = registryRoot();
  await fs.mkdir(registry, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(registry)).isSymbolicLink())
    throw new Error("Invalid attachment recovery storage");
  const stat = await fs.lstat(directory);
  const record: TemporaryRecord = {
    version: 1,
    path: directory,
    workspace,
    dev: stat.dev,
    ino: stat.ino,
    pid: process.pid,
    createdAt: Date.now(),
    replacementParent,
  };
  const file = path.join(registry, `${randomUUID()}.json`);
  await fs.writeFile(file, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  return async () => {
    await fs.unlink(file).catch(() => {});
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM (and unknown errors) must retain another process's active copy.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Only prune recorded, unchanged directories whose owning process exited.
 * PID reuse errs toward retaining data. Never scan temporary folders by prefix. */
export async function pruneAttachmentTemporaryDirectories(): Promise<void> {
  const registry = registryRoot();
  if (!(await fs.lstat(registry).catch(() => null))?.isDirectory()) return;
  const entries = await fs.opendir(registry);
  let inspected = 0;
  const resumeAfter = cleanupCursor.get(registry);
  let resumed = resumeAfter === undefined;
  let lastVisited: string | undefined;
  for await (const entry of entries) {
    if (!resumed) {
      if (entry.name === resumeAfter) resumed = true;
      continue;
    }
    if (++inspected > 500) {
      cleanupCursor.set(registry, lastVisited!);
      return;
    }
    lastVisited = entry.name;
    if (!entry.isFile() || !UUID_FILE.test(entry.name)) continue;
    const file = path.join(registry, entry.name);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      if ((await handle.stat()).size > 16_384) continue;
      const record = JSON.parse(
        await handle.readFile("utf8"),
      ) as TemporaryRecord;
      if (
        record.version !== 1 ||
        !Number.isInteger(record.pid) ||
        record.pid < 1 ||
        !Number.isFinite(record.createdAt) ||
        Date.now() - record.createdAt < GRACE_MS ||
        typeof record.path !== "string" ||
        !path.isAbsolute(record.path) ||
        typeof record.workspace !== "string" ||
        !path.isAbsolute(record.workspace) ||
        within(record.workspace, record.path) ||
        !/^zeros-attachment-[a-zA-Z0-9_-]+$/.test(path.basename(record.path)) ||
        processAlive(record.pid)
      )
        continue;
      const stat = await fs.lstat(record.path).catch(() => null);
      if (stat) {
        if (
          !stat.isDirectory() ||
          stat.dev !== record.dev ||
          stat.ino !== record.ino ||
          (await fs.realpath(record.path)) !== record.path
        )
          continue;
        await fs.rm(record.path, { recursive: true, force: true });
        if (record.replacementParent === true)
          await fs.rmdir(path.dirname(record.path)).catch(() => {});
      }
      await fs.unlink(file);
    } catch {
      // Unreadable, malformed or changed ownership records are never authority
      // to delete a directory. One such record must not block other cleanups.
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  cleanupCursor.delete(registry);
}
