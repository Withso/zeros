import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Sqlite from "better-sqlite3";
import { openSqlite } from "./db/sqlite";
import {
  CompleteCheckpointSourceSchema, CompleteCheckpointJournalReadSchema, CompleteCheckpointJournalStateSchema,
  completeCheckpointScopeKey, sameCompleteCheckpointSource,
  type CompleteCheckpointSource, type CompleteCheckpointJournalState,
} from "./cloud-complete-checkpoint-contract";

const MAX_STATE_BYTES = 64 * 1024;
// Linux x86-64/arm64 UAPI. Node does not export O_PATH. Unlike a separate
// read/write FD, closing this reference cannot drop SQLite's process locks.
const O_PATH = 0o10000000;
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
function descriptorFlags(fd: number): number {
  const flags = [...descriptorInfo(fd).matchAll(/^flags:\s*([0-7]+)$/gm)];
  if (flags.length !== 1) refuse();
  const value = Number.parseInt(flags[0]![1]!, 8);
  if (!Number.isSafeInteger(value)) refuse();
  return value;
}
/** Close the creator before publishing the canonical name. Thereafter the
 * adapter owns only an O_PATH reference and SQLite owns every data FD. A
 * writer opening the newly published journal is safe even if our open fails. */
function createOriginalJournal(file: string): number {
  const staging = `${file}.${randomUUID()}.new`;
  let original: fs.Stats | undefined, reference: number | undefined, staged = true;
  try {
    const creator = fs.openSync(staging, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW
      | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      original = fs.fstatSync(creator); privateMetadata(original, false);
      // Derive the path-only reference from the held no-follow creator, not
      // by reopening its checked staging name. The proc alias intentionally
      // follows this exact live FD; O_NOFOLLOW here would pin the alias itself.
      reference = fs.openSync(`/proc/self/fd/${creator}`, O_PATH);
      const pinned = fs.fstatSync(reference); privateMetadata(pinned, false);
      if (!identity(original, pinned) || descriptorMount(reference) !== descriptorMount(creator)
        || (descriptorFlags(reference) & O_PATH) !== O_PATH) refuse();
    }
    finally { fs.closeSync(creator); }
    const held = fs.fstatSync(reference); privateMetadata(held, false);
    if (!identity(original, held) || !identity(held, fs.lstatSync(staging))
      || (descriptorFlags(reference) & O_PATH) !== O_PATH) refuse();
    // link, unlike rename, cannot replace existing custody. Remove only our
    // original staging link, then require the single canonical link below.
    fs.linkSync(staging, file);
    if (!identity(held, fs.lstatSync(staging)) || !identity(held, fs.lstatSync(file))) refuse();
    fs.unlinkSync(staging); staged = false;
    privateMetadata(fs.fstatSync(reference), false);
    const result = reference; reference = undefined; return result;
  } finally {
    try { if (reference !== undefined) fs.closeSync(reference); }
    finally {
      if (staged && original !== undefined) {
        try { if (identity(original, fs.lstatSync(staging))) fs.unlinkSync(staging); }
        catch { /* Opening already failed; retain unknown staging names. */ }
      }
    }
  }
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
    if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)
      || !fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY
      || !["create", "open"].includes(options.mode)) refuse();
    const source = CompleteCheckpointSourceSchema.parse(options.source), scope = completeCheckpointScopeKey(source);
    const directory = path.resolve(options.directory);
    if (directory !== options.directory || fs.realpathSync(directory) !== directory) refuse();
    directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const originalDirectory = fs.fstatSync(directoryFd); privateMetadata(originalDirectory, true);
    const file = `/proc/self/fd/${directoryFd}/journal.sqlite`;
    fileFd = options.mode === "create" ? createOriginalJournal(file)
      : fs.openSync(file, O_PATH | fs.constants.O_NOFOLLOW);
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
      if ((descriptorFlags(fileFd) & O_PATH) !== O_PATH || descriptorMount(fileFd) !== originalMount) refuse();
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
    if ((descriptorFlags(sqliteFd) & (O_PATH | 3)) !== fs.constants.O_RDWR) refuse();
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
      // The positively bound native reader is also the durability FD. Never
      // reopen the journal for fsync: closing that FD could unlock a peer.
      fs.fsyncSync(sqliteFd!); fs.fsyncSync(directoryFd!);
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
