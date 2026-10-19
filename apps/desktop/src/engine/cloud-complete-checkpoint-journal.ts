import fs from "node:fs";
import path from "node:path";
import type Sqlite from "better-sqlite3";
import { openSqlite } from "./db/sqlite";
import {
  CompleteCheckpointSourceSchema, CompleteCheckpointJournalReadSchema, CompleteCheckpointJournalStateSchema,
  completeCheckpointScopeKey, sameCompleteCheckpointSource,
  type CompleteCheckpointSource, type CompleteCheckpointJournalState,
} from "./cloud-complete-checkpoint-contract";

const MAX_STATE_BYTES = 64 * 1024;
const TABLE = `CREATE TABLE complete_checkpoint_journal (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  version INTEGER NOT NULL CHECK(version=1),
  scope TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), state TEXT
)`;
type Row = { version: number; scope: string; revision: number; state: string | null };
export interface CompleteCheckpointJournal {
  read(signal: AbortSignal): Promise<{ revision: number; state: CompleteCheckpointJournalState | null }>;
  write(expectedRevision: number, state: CompleteCheckpointJournalState): Promise<boolean>;
  close(): void;
}
function refuse(): never { throw new Error("complete checkpoint journal unconfirmed"); }
const identity = (a: fs.Stats, b: fs.Stats): boolean => a.dev === b.dev && a.ino === b.ino
  && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
function privateMetadata(value: fs.Stats, directory: boolean): void {
  if ((directory ? !value.isDirectory() : !value.isFile() || value.nlink !== 1)
    || value.uid !== process.getuid?.() || (value.mode & 0o7777) !== (directory ? 0o700 : 0o600)) refuse();
}
function descriptorInfo(fd: number): string {
  const infoFd = fs.openSync(`/proc/self/fdinfo/${fd}`, fs.constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(4097);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(infoFd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size >= buffer.length) refuse();
    return buffer.subarray(0, size).toString("utf8");
  } finally { fs.closeSync(infoFd); }
}
function descriptorMount(fd: number): string {
  const info = descriptorInfo(fd);
  const ids = [...info.matchAll(/^mnt_id:\s*([1-9][0-9]*)$/gm)];
  if (ids.length !== 1) refuse();
  return ids[0]![1]!;
}
/** The driver does not expose sqlite3_file_control. A unique new FD is only
 * a candidate: SQLite can reuse a cached FD while an unrelated open adds one.
 * A native transaction lock below must positively bind that candidate too. */
function openDescriptors(): Map<number, fs.Stats> {
  const names = fs.readdirSync("/proc/self/fd");
  if (names.length > 4096) refuse();
  const result = new Map<number, fs.Stats>();
  for (const name of names) {
    if (!/^(0|[1-9][0-9]*)$/.test(name)) refuse();
    const fd = Number(name);
    try { result.set(fd, fs.fstatSync(fd)); }
    catch (error) {
      // readdir's own directory descriptor is closed before this loop.
      if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
    }
  }
  return result;
}
function verifyNativeReservation(sqliteFd: number): void {
  const reservations: number[] = [];
  for (const [fd] of openDescriptors()) {
    let info: string;
    try { info = descriptorInfo(fd); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const line of info.split("\n").filter(line => line.startsWith("lock:"))) {
      const lock = /^lock:\s+[0-9]+: (POSIX|FLOCK|OFDLCK)\s+ADVISORY\s+(READ|WRITE)\s+(-?[0-9]+)\s+[0-9a-f]+:[0-9a-f]+:[0-9]+\s+([0-9]+)\s+([0-9]+|EOF)$/.exec(line);
      if (!lock) refuse();
      if (lock[1] !== "POSIX" || lock[2] !== "WRITE" || lock[3] !== String(process.pid)) continue;
      const start = BigInt(lock[4]!), end = lock[5] === "EOF" ? null : BigInt(lock[5]!);
      // Unix SQLite's RESERVED byte. /proc fdinfo reports the open file
      // description owning the kernel lock, not every FD for the same inode.
      // A second transaction (including a reused replacement FD) is ambiguous.
      if (start <= 1073741825n && (end === null || end >= 1073741825n)) {
        if (start !== 1073741825n || end !== start) refuse();
        reservations.push(fd);
      }
    }
  }
  if (reservations.length !== 1 || reservations[0] !== sqliteFd) refuse();
}
function checkedState(raw: unknown, scope: string): CompleteCheckpointJournalState {
  const value = CompleteCheckpointJournalStateSchema.parse(raw);
  if (completeCheckpointScopeKey(value.source) !== scope
    || value.pending && (!sameCompleteCheckpointSource(value.pending.source, value.source)
      || value.pending.startedAtMs !== value.lastStartedAtMs)
    || value.lastComplete && (completeCheckpointScopeKey(value.lastComplete.source) !== scope
      || value.lastComplete.source.changeSequence > value.source.changeSequence
      || value.lastComplete.source.reconcileSequence > value.source.reconcileSequence)) refuse();
  return value;
}

/** Cloud Linux only, opt-in. The caller provisions one private directory per
 * source. Explicit create/open prevents a missing journal from clearing prior
 * custody. This is a scheduling journal, never native retirement authority.
 * SQLite DELETE/EXTRA serializes CAS across processes and syncs the rollback
 * journal deletion; success additionally syncs the original file and directory.
 * No remote operation or retry holds this short transaction. */
export function openCompleteCheckpointJournal(options: {
  directory: string; source: CompleteCheckpointSource; mode: "create" | "open";
}): CompleteCheckpointJournal {
  let directoryFd: number | undefined, fileFd: number | undefined, db: Sqlite.Database | undefined;
  let sqliteFd: number | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { db?.close(); }
    finally {
      try { if (fileFd !== undefined) fs.closeSync(fileFd); }
      finally { if (directoryFd !== undefined) fs.closeSync(directoryFd); }
    }
  };
  try {
    if (process.platform !== "linux" || !fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY
      || !["create", "open"].includes(options.mode)) refuse();
    const source = CompleteCheckpointSourceSchema.parse(options.source), scope = completeCheckpointScopeKey(source);
    const directory = path.resolve(options.directory);
    if (directory !== options.directory || fs.realpathSync(directory) !== directory) refuse();
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const originalDirectory = fs.fstatSync(directoryFd); privateMetadata(originalDirectory, true);
    const file = `/proc/self/fd/${directoryFd}/journal.sqlite`;
    fileFd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      | (options.mode === "create" ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0), 0o600);
    const originalFile = fs.fstatSync(fileFd); privateMetadata(originalFile, false);
    const originalMount = descriptorMount(fileFd);
    const sidecars = () => {
      for (const suffix of ["-journal", "-wal", "-shm"]) {
        let value: fs.Stats;
        try { value = fs.lstatSync(`${file}${suffix}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        // DELETE mode may recover an original private rollback journal. Other
        // sidecars or linked bytes are unknown custody, never cleanup targets.
        if (suffix !== "-journal") refuse();
        privateMetadata(value, false);
      }
    };
    const guard = () => {
      if (closed || directoryFd === undefined || fileFd === undefined) refuse();
      const namedDirectory = fs.lstatSync(directory), namedFile = fs.lstatSync(file);
      privateMetadata(namedDirectory, true); privateMetadata(namedFile, false);
      if (fs.realpathSync(directory) !== directory || !identity(originalDirectory, namedDirectory)
        || !identity(originalDirectory, fs.fstatSync(directoryFd)) || !identity(originalFile, namedFile)
        || !identity(originalFile, fs.fstatSync(fileFd))) refuse();
      if (descriptorMount(fileFd) !== originalMount) refuse();
      if (sqliteFd !== undefined) {
        const sqliteFile = fs.fstatSync(sqliteFd); privateMetadata(sqliteFile, false);
        if (!identity(originalFile, sqliteFile) || descriptorMount(sqliteFd) !== originalMount) refuse();
      }
      sidecars();
    };
    guard();
    const beforeSqlite = openDescriptors();
    db = openSqlite(file, { fileMustExist: true });
    const afterSqlite = openDescriptors();
    const opened = [...afterSqlite].filter(([fd]) => !beforeSqlite.has(fd));
    if (opened.length !== 1) refuse();
    sqliteFd = opened[0]![0];
    const flags = [...descriptorInfo(sqliteFd).matchAll(/^flags:\s*([0-7]+)$/gm)];
    if (flags.length !== 1 || (Number.parseInt(flags[0]![1]!, 8) & 3) !== fs.constants.O_RDWR) refuse();
    guard();
    const database = db;
    // Configure the per-connection busy limit before any schema or journal I/O.
    database.exec("PRAGMA busy_timeout=25; PRAGMA trusted_schema=OFF;");
    // No schema/state is accepted and no application write is attempted until
    // the native connection owns this exact descriptor's RESERVED lock. The
    // synchronous probe has no remote I/O, changes no rows, and always unwinds.
    // Unknown VFS/lock behavior refuses; there is no pathname-only fallback.
    database.exec("BEGIN IMMEDIATE");
    try { verifyNativeReservation(sqliteFd); guard(); }
    finally { database.exec("ROLLBACK"); }
    guard();
    const layout = () => {
      const rows = database.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 2").all() as { name: string; sql: string }[];
      if (rows.length !== 1 || rows[0]?.name !== "complete_checkpoint_journal" || rows[0].sql !== TABLE) refuse();
    };
    if (options.mode === "open") layout();
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;");
    const mode = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const synchronous = database.prepare("PRAGMA synchronous").get() as { synchronous: number };
    if (mode.journal_mode !== "delete" || synchronous.synchronous !== 3) refuse();
    const durable = () => {
      guard();
      fs.fsyncSync(fileFd!); fs.fsyncSync(directoryFd!);
      guard();
    };
    if (options.mode === "create") {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(TABLE);
        database.prepare("INSERT INTO complete_checkpoint_journal VALUES(1,1,?,0,NULL)").run(scope);
        database.exec("COMMIT"); durable();
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* COMMIT may have completed: never delete or reset it. */ }
        throw error;
      }
    }
    const read = () => {
      guard(); layout();
      const row = database.prepare(`SELECT version,scope,revision,CASE WHEN state IS NULL THEN NULL
        WHEN typeof(state)='text' AND length(CAST(state AS BLOB))<=? THEN state ELSE 0 END AS state
        FROM complete_checkpoint_journal WHERE singleton=1`).get(MAX_STATE_BYTES) as Row | undefined;
      if (!row || row.version !== 1 || row.scope !== scope || row.state !== null
        && (typeof row.state !== "string" || Buffer.byteLength(row.state) > MAX_STATE_BYTES)) refuse();
      const state = row.state === null ? null : checkedState(JSON.parse(row.state), scope);
      const result = CompleteCheckpointJournalReadSchema.parse({ revision: row.revision, state });
      if ((result.revision === 0) !== (state === null)) refuse();
      guard(); return result;
    };
    read(); durable();
    return {
      async read(signal) {
        try {
          if (signal.aborted) refuse();
          const result = read();
          if (signal.aborted) refuse();
          return result;
        } catch { return refuse(); }
      },
      async write(expectedRevision, input) {
        let transaction = false;
        try {
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) refuse();
          const state = checkedState(input, scope), bytes = JSON.stringify(state);
          if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) refuse();
          guard();
          database.exec("BEGIN IMMEDIATE"); transaction = true;
          const current = read();
          if (current.revision !== expectedRevision) {
            database.exec("ROLLBACK"); transaction = false; guard(); return false;
          }
          if (current.state && (state.source.changeSequence < current.state.source.changeSequence
            || state.source.reconcileSequence < current.state.source.reconcileSequence
            || current.state.lastStartedAtMs !== null && (state.lastStartedAtMs === null || state.lastStartedAtMs < current.state.lastStartedAtMs)
            || current.state.lastComplete && (!state.lastComplete || state.lastComplete.cutAtMs < current.state.lastComplete.cutAtMs))) refuse();
          // A still-pending original attempt cannot be replaced by a successor
          // or have its source/deadline renewed by a second coordinator.
          if (current.state?.pending && state.pending
            && JSON.stringify(current.state.pending) !== JSON.stringify(state.pending)) refuse();
          if (current.state?.pending && state.lastComplete
            && JSON.stringify(current.state.lastComplete) !== JSON.stringify(state.lastComplete)) {
            const attempt = current.state.pending, receipt = state.lastComplete;
            if (state.pending !== null || receipt.attemptId !== attempt.id || !sameCompleteCheckpointSource(receipt.source, attempt.source)
              || receipt.cutAtMs < attempt.startedAtMs || receipt.ackAtMs >= attempt.deadlineAtMs) refuse();
          }
          if (database.prepare("UPDATE complete_checkpoint_journal SET revision=revision+1,state=? WHERE singleton=1 AND revision=?")
            .run(bytes, expectedRevision).changes !== 1) refuse();
          guard(); database.exec("COMMIT"); transaction = false;
          durable(); return true;
        } catch {
          if (transaction) try { database.exec("ROLLBACK"); } catch { /* Unknown commit stays recoverable. */ }
          return refuse();
        }
      },
      close,
    };
  } catch {
    try { close(); } catch { /* Preserve the closed error without leaking file paths. */ }
    return refuse();
  }
}
