import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { zerosDataDir } from "../db/paths";
import {
  ATTACHMENT_SOURCE_GRACE_MS,
  isAttachmentSourceId,
} from "@zeros/protocol/attachment-policy";

interface SourceIdentity {
  path: string;
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}
const identity = (sourcePath: string, stat: Stats): SourceIdentity => ({
  path: sourcePath,
  size: stat.size,
  dev: stat.dev,
  ino: stat.ino,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});
const directory = () => path.join(zerosDataDir(), "attachment-sources");
const cleanupCursor = new Map<string, string>();

/** Only Electron's File-aware preload can register a selected native path.
 * Persist the small capability privately so an interrupted draft can retry
 * after restart. Neither the source path nor its contents enter draft JSON. */
export async function registerAttachmentSource(
  sourcePath: string,
  size: number,
  sourceId: unknown = randomUUID(),
): Promise<string> {
  if (!isAttachmentSourceId(sourceId))
    throw new Error("Invalid attachment source");
  const resolved = await fs.realpath(sourcePath);
  const file = await fs.open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Choose a regular file to attach");
    if (!Number.isSafeInteger(size) || stat.size !== size)
      throw new Error("Attachment source changed — attach it again");
    await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
    const id = sourceId;
    const recordPath = path.join(directory(), `${id}.json`);
    const record = JSON.stringify(identity(resolved, stat));
    try {
      await fs.writeFile(recordPath, record, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        (await fs.readFile(recordPath, "utf8")) !== record
      )
        throw error;
      const now = new Date();
      await fs.utimes(recordPath, now, now);
    }
    return id;
  } finally {
    await file.close();
  }
}

/** Open the exact selected inode, checking again before the atomic publish.
 * A changed/deleted source must never silently become different prompt data. */
export async function withAttachmentSource<T>(
  id: unknown,
  copy: (
    file: fs.FileHandle,
    size: number,
    verify: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  if (!isAttachmentSourceId(id)) throw new Error("Invalid attachment source");
  const recordPath = path.join(directory(), `${id}.json`);
  const record = await fs.open(
    recordPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let source: SourceIdentity;
  try {
    const now = new Date();
    await record.utimes(now, now);
    source = JSON.parse(await record.readFile("utf8"));
  } finally {
    await record.close();
  }
  const file = await fs.open(
    source.path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const verify = async () => {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      JSON.stringify(identity(source.path, stat)) !== JSON.stringify(source)
    ) {
      throw new Error("Attachment source changed — attach it again");
    }
  };
  try {
    await verify();
    return await copy(file, source.size, verify);
  } finally {
    await file.close();
  }
}

/** Recovery records are capabilities, not copies of the selected files. Only
 * expired, unreferenced records in this private store are disposable. */
export async function pruneAttachmentSources(
  retained: ReadonlySet<string>,
): Promise<void> {
  const root = directory();
  if (!(await fs.lstat(root).catch(() => null))?.isDirectory()) return;
  const entries = await fs.opendir(root);
  let inspected = 0;
  const resumeAfter = cleanupCursor.get(root);
  let resumed = resumeAfter === undefined;
  let lastVisited: string | undefined;
  for await (const entry of entries) {
    if (!resumed) {
      if (entry.name === resumeAfter) resumed = true;
      continue;
    }
    if (++inspected > 1000) {
      cleanupCursor.set(root, lastVisited!);
      return;
    }
    lastVisited = entry.name;
    const id = entry.name.replace(/\.json$/, "");
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".json") ||
      !isAttachmentSourceId(id) ||
      retained.has(id)
    )
      continue;
    const file = path.join(root, entry.name);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.size > 16_384 ||
        Date.now() - before.mtimeMs < ATTACHMENT_SOURCE_GRACE_MS
      )
        continue;
      const record = JSON.parse(
        await handle.readFile("utf8"),
      ) as SourceIdentity;
      if (
        typeof record.path !== "string" ||
        !path.isAbsolute(record.path) ||
        ![
          record.size,
          record.dev,
          record.ino,
          record.mtimeMs,
          record.ctimeMs,
        ].every(Number.isFinite)
      )
        continue;
      const current = await fs.lstat(file);
      if (
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.mtimeMs !== before.mtimeMs ||
        current.ctimeMs !== before.ctimeMs ||
        retained.has(id)
      )
        continue;
      await handle.close();
      handle = undefined;
      await fs.unlink(file);
    } catch {
      // Unknown records remain untouched; cleanup never touches record.path.
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  cleanupCursor.delete(root);
}
