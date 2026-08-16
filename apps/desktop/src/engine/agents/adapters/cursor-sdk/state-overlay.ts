import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { zerosDataDir } from "../../../db/paths";

const MAX_STORE_FILE_BYTES = 128 * 1024 * 1024;
const STORE_FILES = [
  "agents.ndjson",
  "runs.ndjson",
  "run_events.ndjson",
  "checkpoints.ndjson",
] as const;
type StoreFile = (typeof STORE_FILES)[number];

interface RecordSnapshot {
  readonly records: Map<string, string>;
}

export interface CursorStateOverlay {
  readonly localRoot: string;
  readonly persistentRoot: string;
  readonly baseline: ReadonlyMap<StoreFile, RecordSnapshot>;
}

export interface CursorStatePromotionResult {
  readonly conflicts: readonly string[];
}

const promotionTails = new Map<string, Promise<void>>();

function workspaceKey(cwd: string): string {
  return createHash("sha256").update(path.resolve(cwd)).digest("hex");
}

function persistentRoot(cwd: string): string {
  return path.join(
    zerosDataDir(),
    "provider-state",
    "cursor",
    workspaceKey(cwd),
  );
}

async function assertPhysicalDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Cursor state root is not a physical directory");
  }
}

function keyFor(file: StoreFile, value: Record<string, unknown>): string {
  const stringField = (name: string): string => {
    const field = value[name];
    if (typeof field !== "string" || !field) {
      throw new Error(`${file} record is missing ${name}`);
    }
    return field;
  };
  switch (file) {
    case "agents.ndjson":
      return stringField("agentId");
    case "runs.ndjson":
      return `${stringField("agentId")}\0${stringField("runId")}`;
    case "run_events.ndjson": {
      const runId = stringField("runId");
      const seq = value.seq;
      if (!Number.isSafeInteger(seq) || (seq as number) < 0) {
        throw new Error(`${file} record is missing a valid seq`);
      }
      return `${runId}\0${String(seq)}`;
    }
    case "checkpoints.ndjson":
      return `${stringField("agentId")}\0${stringField("blobId")}`;
  }
}

async function readSnapshot(
  root: string,
  file: StoreFile,
): Promise<RecordSnapshot> {
  const target = path.join(root, file);
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_STORE_FILE_BYTES) {
      throw new Error(`${file} is not a bounded regular file`);
    }
    const text = await readFile(target, "utf8");
    const records = new Map<string, string>();
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`${file} contains invalid JSON at record ${index + 1}`);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${file} contains a non-object record`);
      }
      const record = value as Record<string, unknown>;
      records.set(keyFor(file, record), JSON.stringify(record));
    }
    return { records };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: new Map() };
    }
    throw error;
  }
}

async function snapshot(root: string): Promise<Map<StoreFile, RecordSnapshot>> {
  return new Map(
    await Promise.all(
      STORE_FILES.map(
        async (file) => [file, await readSnapshot(root, file)] as const,
      ),
    ),
  );
}

async function atomicWriteRecords(
  root: string,
  file: StoreFile,
  records: ReadonlyMap<string, string>,
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, file);
  const temporary = path.join(root, `.${file}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    const body =
      records.size > 0 ? `${[...records.values()].join("\n")}\n` : "";
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporary, target);
}

async function withPromotionLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = promotionTails.get(root) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = prior.catch(() => undefined).then(() => tail);
  promotionTails.set(root, queued);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (promotionTails.get(root) === queued) promotionTails.delete(root);
  }
}

/** Seed a per-execution writable overlay from Zeros' durable Cursor state.
 * Cursor's host may additionally seed an empty overlay from the pre-ZSR native
 * store, which is then promoted through the same merge path. */
export async function prepareCursorStateOverlay(
  localRoot: string,
  cwd: string,
): Promise<CursorStateOverlay> {
  if (!path.isAbsolute(localRoot) || !path.isAbsolute(cwd)) {
    throw new Error("Cursor state overlay requires absolute paths");
  }
  await assertPhysicalDirectory(localRoot);
  if ((await readdir(localRoot)).length !== 0) {
    throw new Error("Cursor state overlay must start empty");
  }
  const durable = persistentRoot(cwd);
  await mkdir(durable, { recursive: true, mode: 0o700 });
  await assertPhysicalDirectory(durable);
  for (const file of STORE_FILES) {
    try {
      await copyFile(path.join(durable, file), path.join(localRoot, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    localRoot,
    persistentRoot: durable,
    baseline: await snapshot(localRoot),
  };
}

/** Merge only records changed by this execution into the latest durable
 * snapshot. Distinct concurrent agents therefore compose. A same-record race
 * is never silently last-writer-wins: the durable value stays intact and the
 * contender is written to a recovery file for diagnosis/replay. */
export async function promoteCursorStateOverlay(
  overlay: CursorStateOverlay,
): Promise<CursorStatePromotionResult> {
  return withPromotionLock(overlay.persistentRoot, async () => {
    const local = await snapshot(overlay.localRoot);
    const current = await snapshot(overlay.persistentRoot);
    const conflicts: string[] = [];
    const conflictRecords = new Map<string, string[]>();

    for (const file of STORE_FILES) {
      const baselineRecords = overlay.baseline.get(file)?.records ?? new Map();
      const localRecords = local.get(file)?.records ?? new Map();
      const currentRecords = new Map(current.get(file)?.records ?? []);
      const candidateKeys = new Set([
        ...baselineRecords.keys(),
        ...localRecords.keys(),
      ]);
      let changed = false;
      for (const key of candidateKeys) {
        const before = baselineRecords.get(key);
        const next = localRecords.get(key);
        if (before === next) continue;
        const latest = currentRecords.get(key);
        if (latest !== before && latest !== next) {
          conflicts.push(
            `${file}:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
          );
          if (next !== undefined) {
            const rows = conflictRecords.get(file) ?? [];
            rows.push(next);
            conflictRecords.set(file, rows);
          }
          continue;
        }
        if (next === undefined) currentRecords.delete(key);
        else currentRecords.set(key, next);
        changed = true;
      }
      if (changed) {
        await atomicWriteRecords(overlay.persistentRoot, file, currentRecords);
      }
    }

    if (conflictRecords.size > 0) {
      const recovery = path.join(
        overlay.persistentRoot,
        "conflicts",
        `${Date.now()}-${randomUUID()}`,
      );
      await mkdir(recovery, { recursive: true, mode: 0o700 });
      for (const [file, records] of conflictRecords) {
        const handle = await open(path.join(recovery, file), "wx", 0o600);
        try {
          await handle.writeFile(`${records.join("\n")}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
    return { conflicts };
  });
}
