import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { zerosDataDir } from "../db/paths";

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

/** Only Electron's File-aware preload can register a selected native path.
 * Persist the small capability privately so an interrupted draft can retry
 * after restart. Neither the source path nor its contents enter draft JSON. */
export async function registerAttachmentSource(
  sourcePath: string,
  size: number,
  sourceId: unknown = randomUUID(),
): Promise<string> {
  if (typeof sourceId !== "string" || !/^[a-f0-9-]{36}$/.test(sourceId))
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
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    throw new Error("Invalid attachment source");
  const source: SourceIdentity = JSON.parse(
    await fs.readFile(path.join(directory(), `${id}.json`), "utf8"),
  );
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
