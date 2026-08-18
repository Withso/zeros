import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { zerosDataDir } from "../../../db/paths";
import { CURSOR_STATE_RECOVERY_HOLD_FILE } from "../../session-paths";

const MAX_STORE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_STORE_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_STORE_RECORDS = 250_000;
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
  readonly recovery?: {
    readonly generationRoot: string;
    readonly markerPath: string;
    readonly baselineRoot: string;
  };
}

export interface CursorStatePromotionResult {
  readonly conflicts: readonly string[];
}

export interface CursorStateRecoveryResult {
  readonly discovered: number;
  readonly recovered: number;
  readonly preserved: number;
  readonly conflicts: number;
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
  if ((await realpath(directory)) !== directory) {
    throw new Error("Cursor state root is not canonical");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (
      !new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw error;
    }
  } finally {
    await handle.close();
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
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      target,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > MAX_STORE_FILE_BYTES
    ) {
      throw new Error(`${file} is not a bounded regular file`);
    }
    const contents = await handle.readFile();
    if (contents.byteLength > MAX_STORE_FILE_BYTES) {
      throw new Error(`${file} is not a bounded regular file`);
    }
    const records = new Map<string, string>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let offset = 0;
    let lineNumber = 0;
    let recordCount = 0;
    while (offset < contents.byteLength) {
      lineNumber += 1;
      const newline = contents.indexOf(0x0a, offset);
      const end = newline === -1 ? contents.byteLength : newline;
      if (end - offset > MAX_STORE_RECORD_BYTES) {
        throw new Error(`${file} contains an oversized record`);
      }
      let line: string;
      try {
        line = decoder.decode(contents.subarray(offset, end));
      } catch {
        throw new Error(`${file} contains invalid UTF-8 at record ${lineNumber}`);
      }
      offset = newline === -1 ? contents.byteLength : newline + 1;
      if (!line.trim()) continue;
      recordCount += 1;
      if (recordCount > MAX_STORE_RECORDS) {
        throw new Error(`${file} exceeded its record limit`);
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`${file} contains invalid JSON at record ${lineNumber}`);
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
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`${file} is not a bounded regular file`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function snapshot(root: string): Promise<Map<StoreFile, RecordSnapshot>> {
  await assertPhysicalDirectory(root);
  // Read sequentially. All four files can independently reach the byte cap;
  // parallel readFile/decode calls would multiply transient trusted-engine
  // memory before any per-record bound could reject hostile state.
  const result = new Map<StoreFile, RecordSnapshot>();
  for (const file of STORE_FILES) {
    result.set(file, await readSnapshot(root, file));
  }
  return result;
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
  await syncDirectory(root);
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

/** The durable per-workspace store itself, ready to be written directly.
 *
 * This is the LOCAL HOST-PARITY path: no per-execution overlay, no merge
 * baseline, no crash-recovery hold — because there is nothing transient to
 * reconcile. It restores the pre-ZSR arrangement, where every session in a
 * workspace shared one on-disk agent store, and it keeps the location Zeros has
 * been using so existing chats resume against their own history instead of
 * starting from an empty store.
 *
 * The overlay path below stays for the isolated/cloud profile, where the
 * provider's HOME is a projection that disappears at teardown and per-session
 * state genuinely has to be copied in and merged back out. */
export async function durableCursorStateRoot(cwd: string): Promise<string> {
  if (!path.isAbsolute(cwd)) {
    throw new Error("Cursor state root requires an absolute workspace path");
  }
  const durable = persistentRoot(cwd);
  await mkdir(durable, { recursive: true, mode: 0o700 });
  await assertPhysicalDirectory(durable);
  return durable;
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
  const baseline = await snapshot(durable);
  for (const file of STORE_FILES) {
    const records = baseline.get(file)?.records;
    if (records && records.size > 0) {
      await atomicWriteRecords(localRoot, file, records);
    }
  }
  return {
    localRoot,
    persistentRoot: durable,
    baseline,
  };
}

/** Persist the immutable merge baseline outside the Cursor-writable state
 * directory before its host starts. A later engine can then finish the same
 * record-level CAS promotion after a hard crash. */
export async function armCursorStateRecovery(
  overlay: CursorStateOverlay,
): Promise<CursorStateOverlay> {
  if (overlay.recovery) return overlay;
  const providerRoot = path.dirname(overlay.localRoot);
  const generationRoot = path.dirname(providerRoot);
  if (
    path.basename(overlay.localRoot) !== "cursor" ||
    path.basename(providerRoot) !== "provider"
  ) {
    throw new Error("Cursor crash recovery requires a generation-private root");
  }
  await assertPhysicalDirectory(generationRoot);
  await assertPhysicalDirectory(providerRoot);
  await assertPhysicalDirectory(overlay.localRoot);
  const durableBase = path.join(zerosDataDir(), "provider-state", "cursor");
  const persistentKey = path.relative(durableBase, overlay.persistentRoot);
  if (
    !/^[a-f0-9]{64}$/.test(persistentKey) ||
    path.basename(overlay.persistentRoot) !== persistentKey
  ) {
    throw new Error("Cursor crash recovery has an invalid persistence key");
  }
  const baselineRoot = path.join(generationRoot, ".cursor-state-baseline");
  const markerPath = path.join(generationRoot, CURSOR_STATE_RECOVERY_HOLD_FILE);
  try {
    await mkdir(baselineRoot, { mode: 0o700 });
  } catch (error) {
    // A leftover baseline means a PREVIOUS overlay on this same generation root
    // never finished promoting (its hold is still armed for boot recovery).
    // Reusing the root now would merge against the wrong baseline, so refuse —
    // and say why, because a pooled utility boundary can reach this path.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Cursor state from an earlier execution on this boundary has not been " +
          "promoted yet; its crash-recovery hold is still armed",
      );
    }
    throw error;
  }
  await chmod(baselineRoot, 0o700);
  try {
    for (const file of STORE_FILES) {
      const records = overlay.baseline.get(file)?.records;
      if (records && records.size > 0) {
        await atomicWriteRecords(baselineRoot, file, records);
      }
    }
    await syncDirectory(baselineRoot);
    const temporary = path.join(
      generationRoot,
      `.${CURSOR_STATE_RECOVERY_HOLD_FILE}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ version: 1, persistentKey })}\n`,
        "utf8",
      );
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    try {
      await rename(temporary, markerPath);
      await syncDirectory(generationRoot);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  } catch (error) {
    await rm(baselineRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    ...overlay,
    recovery: { generationRoot, markerPath, baselineRoot },
  };
}

async function clearCursorStateRecovery(
  recovery: NonNullable<CursorStateOverlay["recovery"]>,
): Promise<void> {
  // Promotion is already durable. Remove the marker first so a crash during
  // disposable-baseline cleanup cannot replay an already-promoted overlay.
  await rm(recovery.markerPath, { force: true });
  await syncDirectory(recovery.generationRoot);
  // The baseline is no longer authoritative once the marker deletion is
  // durable. A cleanup-only filesystem error must not turn a successful state
  // promotion into a failed teardown (and strand an otherwise retired
  // boundary); the generation reaper removes any residue later.
  await rm(recovery.baselineRoot, { recursive: true, force: true }).catch(
    () => undefined,
  );
}

/** Merge only records changed by this execution into the latest durable
 * snapshot. Distinct concurrent agents therefore compose. A same-record race
 * is never silently last-writer-wins: the durable value stays intact and the
 * contender is written to a recovery file for diagnosis/replay. */
export async function promoteCursorStateOverlay(
  overlay: CursorStateOverlay,
): Promise<CursorStatePromotionResult> {
  const result = await withPromotionLock(overlay.persistentRoot, async () => {
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
  if (overlay.recovery) await clearCursorStateRecovery(overlay.recovery);
  // Return the generation-private state root to the empty state
  // prepareCursorStateOverlay requires. Two things need this. A pooled utility
  // boundary (containment/utility-boundary-pool.ts) serves several one-shots in
  // turn from one boundary, so the SECOND `listSessions`/key validation on it
  // would otherwise fail its "must start empty" assertion. And a live session
  // whose Cursor host is replaced mid-life re-prepares against the same root.
  // Deleting is safe precisely here and nowhere earlier: the merge above is
  // durable and the crash-recovery hold is already cleared, so these bytes are
  // no longer authoritative for anything.
  await clearCursorStateRoot(overlay.localRoot);
  return result;
}

/** Empty (but keep) a Cursor state root. Only the four known store files and
 * the SDK's own scratch are removed; an unexpected entry is left alone so an
 * upstream layout change surfaces as a loud "must start empty" refusal on the
 * next prepare instead of a silent delete of provider state. */
async function clearCursorStateRoot(localRoot: string): Promise<void> {
  for (const file of STORE_FILES) {
    await rm(path.join(localRoot, file), { force: true }).catch(
      () => undefined,
    );
  }
  await syncDirectory(localRoot).catch(() => undefined);
}

async function readCursorRecoveryKey(markerPath: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      markerPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("Cursor recovery marker has unsafe metadata");
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size <= 0 ||
      metadata.size > 1024 ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("Cursor recovery marker has unsafe metadata");
    }
    const parsed = JSON.parse((await handle.readFile()).toString("utf8")) as {
      version?: unknown;
      persistentKey?: unknown;
    };
    if (
      parsed.version !== 1 ||
      typeof parsed.persistentKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.persistentKey)
    ) {
      throw new Error("Cursor recovery marker is malformed");
    }
    return parsed.persistentKey;
  } finally {
    await handle.close();
  }
}

/** Reconcile Cursor JSONL state left by a hard engine crash. The caller must
 * first prove host process domains and external VM mounts retired. Malformed or
 * unreadable state is retained as a GC hold for a later retry. */
export async function recoverCursorStateOverlays(options: {
  readonly sessionsRoot: string;
}): Promise<CursorStateRecoveryResult> {
  let sessions;
  try {
    sessions = await readdir(options.sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { discovered: 0, recovered: 0, preserved: 0, conflicts: 0 };
    }
    throw error;
  }
  let discovered = 0;
  let recovered = 0;
  let preserved = 0;
  let conflicts = 0;
  for (const session of sessions) {
    if (!session.isDirectory() || session.isSymbolicLink()) continue;
    const boundaryRoot = path.join(
      options.sessionsRoot,
      session.name,
      "boundary",
    );
    let generations;
    try {
      generations = await readdir(boundaryRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      preserved += 1;
      continue;
    }
    for (const generation of generations) {
      if (!generation.isDirectory() || generation.isSymbolicLink()) continue;
      const generationRoot = path.join(boundaryRoot, generation.name);
      const markerPath = path.join(
        generationRoot,
        CURSOR_STATE_RECOVERY_HOLD_FILE,
      );
      let markerMetadata;
      try {
        markerMetadata = await lstat(markerPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        discovered += 1;
        preserved += 1;
        continue;
      }
      discovered += 1;
      if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
        preserved += 1;
        continue;
      }
      const baselineRoot = path.join(generationRoot, ".cursor-state-baseline");
      const localRoot = path.join(generationRoot, "provider", "cursor");
      const recovery = { generationRoot, markerPath, baselineRoot };
      let overlay: CursorStateOverlay;
      try {
        const persistentKey = await readCursorRecoveryKey(markerPath);
        let localMetadata;
        try {
          localMetadata = await lstat(localRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!localMetadata) {
          await clearCursorStateRecovery(recovery);
          recovered += 1;
          continue;
        }
        if (!localMetadata.isDirectory() || localMetadata.isSymbolicLink()) {
          throw new Error("Cursor recovery source is not a physical directory");
        }
        await assertPhysicalDirectory(baselineRoot);
        overlay = {
          localRoot,
          persistentRoot: path.join(
            zerosDataDir(),
            "provider-state",
            "cursor",
            persistentKey,
          ),
          baseline: await snapshot(baselineRoot),
          recovery,
        };
        await mkdir(overlay.persistentRoot, {
          recursive: true,
          mode: 0o700,
        });
        await assertPhysicalDirectory(overlay.persistentRoot);
      } catch {
        preserved += 1;
        continue;
      }
      try {
        const result = await promoteCursorStateOverlay(overlay);
        conflicts += result.conflicts.length;
        recovered += 1;
      } catch {
        preserved += 1;
      }
    }
  }
  return { discovered, recovered, preserved, conflicts };
}
