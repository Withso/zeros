import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type Sqlite from "better-sqlite3";
import { CloudAgentBootScopeSchema } from "@zeros/protocol/cloud-agent-bootstrap";
import { openSqlite } from "./db/sqlite";
import { CompleteCheckpointSourceSchema, type CompleteCheckpointSource } from "./cloud-complete-checkpoint-contract";
import { nativeLayout, nativeRefuse as refuse, mapPeriodicNativeRow, validatePeriodicNativeRow, PERIODIC_NATIVE_POLICY,
  periodicNativePolicySha256, type PeriodicDatabase } from "./cloud-complete-checkpoint-native-policy";

const integer = z.number().int().nonnegative().safe(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const limitsSchema = z.object({ maxRows: integer.min(1).max(1_000_000), maxBytes: integer.min(1).max(2 ** 40),
  maxRowBytes: integer.min(1).max(16 * 1024 * 1024) }).strict();
const fileSchema = z.object({ name: z.enum(["normal.sqlite", "normal.sqlite-wal", "normal.sqlite-journal",
  "ledger.sqlite", "ledger.sqlite-wal", "ledger.sqlite-journal"]), bytes: integer, sha256: digest }).strict();
const manifestSchema = z.object({ version: z.literal(1), kind: z.literal("complete-periodic-native"),
  source: CompleteCheckpointSourceSchema, cutAtMs: integer, inventorySha256: digest,
  policySha256: z.literal(periodicNativePolicySha256), files: z.array(fileSchema).min(2).max(6),
  heads: z.object({ recordSequence: integer, eventSequence: integer, journalSequence: integer }).strict(),
  coverage: z.array(z.object({ database: z.enum(["normal", "ledger"]), table: z.string(), rows: integer, exportedRows: integer,
    disposition: z.enum(["data", "authority", "regenerate", "empty"]) }).strict()).max(128),
  rows: integer, recordsBytes: integer, recordsSha256: digest, limits: limitsSchema,
}).strict();
export type PeriodicNativeManifest = z.infer<typeof manifestSchema> & { manifestSha256: string };
export type PeriodicNativeRecord = { database: PeriodicDatabase; table: string; rowid: number; values: Record<string, unknown> };
const encode = (value: unknown) => JSON.stringify(value);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const CHUNK = 256 * 1024;
const stable = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
  && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function privateMetadata(info: fs.Stats, directory = false): void {
  if ((directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
    || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== (directory ? 0o700 : 0o600)) refuse();
}
function pinnedDirectory(directory: string) {
  if (process.platform !== "linux" || path.resolve(directory) !== directory || fs.realpathSync(directory) !== directory) refuse();
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
  try {
    const original = fs.fstatSync(fd); privateMetadata(original, true);
    const guard = () => {
      const named = fs.lstatSync(directory), current = fs.fstatSync(fd);
      privateMetadata(named, true); privateMetadata(current, true);
      if ([named, current].some(info => info.dev !== original.dev || info.ino !== original.ino)
        || fs.realpathSync(directory) !== directory) refuse();
    };
    guard(); return { fd, file: (name: string) => `/proc/self/fd/${fd}/${name}`, guard, close: () => fs.closeSync(fd) };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function pinnedFile(file: string) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const original = fs.fstatSync(fd); privateMetadata(original);
    const guard = () => { if (!stable(original, fs.fstatSync(fd)) || !stable(original, fs.lstatSync(file))) refuse(); };
    guard(); return { fd, original, guard, close: () => fs.closeSync(fd) };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function write(fd: number, bytes: Buffer, guard: () => void) {
  for (let offset = 0; offset < bytes.length;) {
    guard(); const count = fs.writeSync(fd, bytes, offset, Math.min(CHUNK, bytes.length - offset));
    if (count <= 0) refuse(); offset += count;
  }
  guard();
}
function closeAll(actions: (() => void)[]): void {
  let failed = false;
  for (const close of actions) try { close(); } catch { failed = true; }
  if (failed) refuse();
}
function cell(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { sqliteBlob: Buffer.from(value).toString("base64") };
  if (value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value)
    && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  return refuse();
}
function schema(db: Sqlite.Database, kind: PeriodicDatabase) {
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  if (hash(encode(objects)) !== nativeLayout[kind].objectsSha256) refuse();
  const tables = nativeLayout[kind].tables as Record<string, { columns: string[]; sqlSha256: string }>;
  if (!isDeepStrictEqual(Object.keys(tables).sort(), Object.keys(PERIODIC_NATIVE_POLICY[kind]).sort())) refuse();
  for (const [name, expected] of Object.entries(tables)) {
    const columns = db.prepare(`PRAGMA table_xinfo("${name}")`).all() as { name: string }[];
    if (!isDeepStrictEqual(columns.map(column => column.name), expected.columns)) refuse();
  }
  const check = db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
  if (check.length !== 1 || check[0]?.quick_check !== "ok") refuse();
}
function cutHeads(normal: Sqlite.Database, ledger: Sqlite.Database, source: CompleteCheckpointSource,
  limits: z.infer<typeof limitsSchema>, guard: () => void) {
  const meta = (key: string) => (ledger.prepare("SELECT value FROM local_command_metadata WHERE key=?").get(key) as { value: string } | undefined)?.value;
  const writer = CloudAgentBootScopeSchema.parse(JSON.parse(meta("writer") ?? "null"));
  if ((["organizationId", "workspaceId", "generation", "engineInstanceId", "writerEpoch"] as const).some(key => writer[key] !== source[key])
    || meta("sealedWriter") === source.writerEpoch || meta("acceptanceFenced") === source.writerEpoch || meta("schema") !== "1") refuse();
  const recordSequence = integer.parse((normal.prepare("SELECT next_rev-1 AS n FROM sync_meta WHERE id=0").get() as { n: number } | undefined)?.n);
  const stream = ledger.prepare("SELECT head FROM local_command_streams WHERE stream_id=? AND writer_epoch=?")
    .get(source.engineInstanceId, source.writerEpoch) as { head: number } | undefined;
  const eventSequence = integer.parse(stream?.head);
  const rawJournal = meta("journalHead") ?? "0";
  if (!/^(0|[1-9][0-9]*)$/.test(rawJournal)) refuse();
  const journalSequence = integer.parse(Number(rawJournal));
  if (ledger.prepare("SELECT 1 FROM local_commands WHERE history IS NOT NULL AND length(CAST(history AS BLOB))>? LIMIT 1").get(limits.maxRowBytes)) refuse();
  let count = 0;
  for (const row of ledger.prepare("SELECT history FROM local_commands WHERE writer_epoch=? AND history IS NOT NULL").iterate(source.writerEpoch) as Iterable<{ history: string }>) {
    guard(); if (++count > limits.maxRows) refuse();
    const value = JSON.parse(row.history) as { recordSequence?: unknown; eventSequence?: unknown };
    if (integer.parse(value.recordSequence) > recordSequence || integer.parse(value.eventSequence) > eventSequence) refuse();
  }
  return { recordSequence, eventSequence, journalSequence };
}
function checkFiles(files: z.infer<typeof fileSchema>[], maxBytes: number): string[] {
  const names = files.map(file => file.name).sort();
  if (new Set(names).size !== names.length || !names.includes("normal.sqlite") || !names.includes("ledger.sqlite")) refuse();
  for (const base of ["normal", "ledger"]) if (names.includes(`${base}.sqlite-wal` as typeof names[number])
    && names.includes(`${base}.sqlite-journal` as typeof names[number])) refuse();
  if (files.reduce((n, file) => n + file.bytes, 0) > maxBytes) refuse();
  return names;
}
function checkCoverage(manifest: z.infer<typeof manifestSchema>) {
  const expected = new Map<string, number>(); let total = 0, scanned = 0;
  for (const database of ["normal", "ledger"] as const) for (const [table, mode] of Object.entries(PERIODIC_NATIVE_POLICY[database])) {
    const entries = manifest.coverage.filter(row => row.database === database && row.table === table);
    if (entries.length !== 1) refuse();
    const row = entries[0]!, excluded = ["authority", "regenerate", "empty"].includes(mode);
    if (row.disposition !== (excluded ? mode : "data") || row.exportedRows > row.rows
      || (excluded && row.exportedRows !== 0) || (mode === "empty" && row.rows !== 0)
      || (!excluded && mode !== "metadata" && row.exportedRows !== row.rows)
      || (mode === "metadata" && row.rows - row.exportedRows > 2)) refuse();
    if (!["regenerate", "empty"].includes(mode)) scanned += row.rows;
    total += row.exportedRows; expected.set(`${database}:${table}`, row.exportedRows);
  }
  if (manifest.coverage.length !== expected.size || total !== manifest.rows || scanned > manifest.limits.maxRows) refuse();
  return expected;
}

/** Only consumes a complete, externally verified immutable main/WAL inventory.
 * Its byte copies are recovered in a separate private directory. It never
 * opens the writer's files, acquires a final seal or returns a storage ACK.
 * Limits are required attempt inputs, not measured deployment defaults. */
export function exportPeriodicNative(options: {
  stagedDirectory: string; targetDirectory: string; files: z.infer<typeof fileSchema>[];
  source: CompleteCheckpointSource; cutAtMs: number; inventorySha256: string;
  limits: z.infer<typeof limitsSchema>; guard(): void;
}): PeriodicNativeManifest {
  let source: ReturnType<typeof pinnedDirectory> | undefined, target: ReturnType<typeof pinnedDirectory> | undefined;
  const inputs: ReturnType<typeof pinnedFile>[] = [], databases: Sqlite.Database[] = [];
  let output: number | undefined, published = false;
  try {
    const scope = CompleteCheckpointSourceSchema.parse(options.source), cutAtMs = integer.parse(options.cutAtMs);
    const inventorySha256 = digest.parse(options.inventorySha256), limits = limitsSchema.parse(options.limits);
    const files = z.array(fileSchema).min(2).max(6).parse(options.files);
    source = pinnedDirectory(options.stagedDirectory);
    const names = checkFiles(files, limits.maxBytes);
    if (!isDeepStrictEqual(fs.readdirSync(source.file(".")).sort(), names)) refuse();
    options.guard();
    // No path reuse, including a previous failed attempt's private directory.
    if (path.resolve(options.targetDirectory) !== options.targetDirectory
      || fs.realpathSync(path.dirname(options.targetDirectory)) !== path.dirname(options.targetDirectory)) refuse();
    fs.mkdirSync(options.targetDirectory, { mode: 0o700 }); target = pinnedDirectory(options.targetDirectory);
    fs.mkdirSync(target.file("working"), { mode: 0o700 });
    const guard = () => { options.guard(); source!.guard(); target!.guard(); for (const file of inputs) file.guard(); };
    for (const file of files) {
      const original = pinnedFile(source.file(file.name)); inputs.push(original);
      if (original.original.size !== file.bytes) refuse();
      const copy = fs.openSync(target.file(`working/${file.name}`), fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        const buffer = Buffer.alloc(CHUNK), sha = createHash("sha256"); let offset = 0;
        while (offset < file.bytes) {
          guard(); const count = fs.readSync(original.fd, buffer, 0, Math.min(CHUNK, file.bytes - offset), offset);
          if (!count) refuse(); const bytes = buffer.subarray(0, count); sha.update(bytes); write(copy, bytes, guard); offset += count;
        }
        if (sha.digest("hex") !== file.sha256) refuse();
        fs.fsyncSync(copy); guard();
      } finally { fs.closeSync(copy); }
    }
    const open = (name: PeriodicDatabase) => {
      const db = openSqlite(target!.file(`working/${name}.sqlite`), { fileMustExist: true }); databases.push(db);
      db.exec("PRAGMA busy_timeout=25; PRAGMA trusted_schema=OFF;");
      // SQLite recovery touches only the disposable staged pair. Query-only
      // follows recovery; no migration or native writer constructor is called.
      db.prepare("SELECT count(*) FROM sqlite_master").get();
      db.exec("PRAGMA query_only=ON; BEGIN"); schema(db, name); guard(); return db;
    };
    const normal = open("normal"), ledger = open("ledger"), heads = cutHeads(normal, ledger, scope, limits, guard);
    output = fs.openSync(target.file("records.jsonl"), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    let rows = 0, recordsBytes = 0, scanned = 0; const sha = createHash("sha256");
    const coverage: z.infer<typeof manifestSchema>["coverage"] = [];
    for (const [database, db] of [["normal", normal], ["ledger", ledger]] as const) {
      for (const [table, disposition] of Object.entries(PERIODIC_NATIVE_POLICY[database])) {
        guard();
        const count = integer.parse((db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n);
        const covered: z.infer<typeof manifestSchema>["coverage"][number] = { database, table, rows: count, exportedRows: 0,
          disposition: ["authority", "regenerate", "empty"].includes(disposition)
            ? disposition as "authority" | "regenerate" | "empty" : "data" };
        coverage.push(covered);
        if (disposition === "empty" && count) refuse();
        if (["regenerate", "empty"].includes(disposition)) continue;
        if ((scanned += count) > limits.maxRows) refuse();
        const columns = (nativeLayout[database].tables as Record<string, { columns: string[] }>)[table]!.columns;
        const size = columns.map(column => `coalesce(length(CAST("${column}" AS BLOB)),0)`).join("+");
        if (db.prepare(`SELECT 1 FROM "${table}" WHERE (${size})>? LIMIT 1`).get(limits.maxRowBytes)) refuse();
        let cursor: number | null = null, observed = 0;
        for (;;) {
          guard();
          const page = db.prepare(`SELECT rowid AS __cut_rowid,* FROM "${table}" ${cursor === null ? "" : "WHERE rowid>?"} ORDER BY rowid LIMIT 64`)
            .all(...(cursor === null ? [] : [cursor])) as Record<string, unknown>[];
          if (!page.length) break;
          for (const raw of page) {
            if (!Number.isSafeInteger(raw.__cut_rowid)) refuse();
            cursor = raw.__cut_rowid as number; observed++;
            const row = Object.fromEntries(columns.map(column => [column, cell(raw[column])]));
            const values = mapPeriodicNativeRow(database, table, row);
            if (!values) continue;
            validatePeriodicNativeRow(database, table, values); covered.exportedRows++;
            const bytes = Buffer.from(`${encode({ database, table, rowid: cursor, values })}\n`);
            if (bytes.length > limits.maxRowBytes || (recordsBytes += bytes.length) > limits.maxBytes || ++rows > limits.maxRows) refuse();
            write(output, bytes, guard); sha.update(bytes);
          }
        }
        if (observed !== count) refuse();
      }
    }
    fs.fsyncSync(output); fs.closeSync(output); output = undefined;
    while (databases.length) {
      const db = databases[databases.length - 1]!; db.exec("ROLLBACK"); db.close(); databases.pop();
    }
    // The exported directory contains no old runnable SQLite database/sidecar.
    fs.rmSync(target.file("working"), { recursive: true }); guard();
    const manifest = manifestSchema.parse({ version: 1, kind: "complete-periodic-native", source: scope, cutAtMs,
      inventorySha256, policySha256: periodicNativePolicySha256, files, heads, coverage, rows, recordsBytes,
      recordsSha256: sha.digest("hex"), limits });
    checkCoverage(manifest);
    output = fs.openSync(target.file("manifest.json"), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    published = true; const bytes = Buffer.from(encode(manifest)); write(output, bytes, guard);
    fs.fsyncSync(output); fs.closeSync(output); output = undefined; fs.fsyncSync(target.fd); guard();
    return { ...manifest, manifestSha256: hash(bytes) };
  } catch {
    if (published && target) try { fs.unlinkSync(target.file("manifest.json")); fs.fsyncSync(target.fd); } catch { /* No success returned. */ }
    return refuse();
  } finally {
    closeAll([...databases.map(db => () => db.close()), () => { if (output !== undefined) fs.closeSync(output); },
      ...inputs.map(file => () => file.close()), () => target?.close(), () => source?.close()]);
  }
}

/** Streaming verified reader. Records are inert data, not native SQL. Any
 * consumer must defer publication until the entire file and final guard pass. */
export function visitPeriodicNative(options: { directory: string; expected: PeriodicNativeManifest; guard(): void },
  visit: (record: PeriodicNativeRecord) => void): void {
  let directory: ReturnType<typeof pinnedDirectory> | undefined, manifest: ReturnType<typeof pinnedFile> | undefined;
  let input: ReturnType<typeof pinnedFile> | undefined;
  try {
    const { manifestSha256, ...document } = options.expected;
    const expected = manifestSchema.parse(document); digest.parse(manifestSha256);
    if (hash(encode(expected)) !== manifestSha256 || expected.rows > expected.limits.maxRows || expected.recordsBytes > expected.limits.maxBytes) refuse();
    checkFiles(expected.files, expected.limits.maxBytes); const remaining = checkCoverage(expected);
    directory = pinnedDirectory(options.directory);
    if (!isDeepStrictEqual(fs.readdirSync(directory.file(".")).sort(), ["manifest.json", "records.jsonl"])) refuse();
    manifest = pinnedFile(directory.file("manifest.json"));
    if (manifest.original.size > 128 * 1024) refuse();
    const raw = fs.readFileSync(manifest.fd);
    if (hash(raw) !== manifestSha256 || !isDeepStrictEqual(JSON.parse(raw.toString("utf8")), expected)) refuse();
    input = pinnedFile(directory.file("records.jsonl"));
    if (input.original.size !== expected.recordsBytes) refuse();
    const guard = () => { options.guard(); directory!.guard(); manifest!.guard(); input!.guard(); };
    const buffer = Buffer.alloc(CHUNK), sha = createHash("sha256"); let pending = Buffer.alloc(0), offset = 0, rows = 0;
    const keys = new Set<string>();
    while (offset < expected.recordsBytes) {
      guard(); const count = fs.readSync(input.fd, buffer, 0, Math.min(CHUNK, expected.recordsBytes - offset), offset);
      if (!count) refuse(); const bytes = buffer.subarray(0, count); sha.update(bytes); offset += count;
      pending = Buffer.concat([pending, bytes]);
      for (;;) {
        const index = pending.indexOf(10); if (index < 0) break;
        if (index + 1 > expected.limits.maxRowBytes || ++rows > expected.rows) refuse();
        const line = pending.subarray(0, index).toString("utf8"), entry = JSON.parse(line) as PeriodicNativeRecord;
        pending = pending.subarray(index + 1);
        if (encode(entry) !== line || !isDeepStrictEqual(Object.keys(entry).sort(), ["database", "rowid", "table", "values"])
          || !["normal", "ledger"].includes(entry.database) || typeof entry.table !== "string"
          || !Number.isSafeInteger(entry.rowid) || !entry.values || typeof entry.values !== "object" || Array.isArray(entry.values)) refuse();
        const key = encode([entry.database, entry.table, entry.rowid]);
        validatePeriodicNativeRow(entry.database, entry.table, entry.values);
        const tableKey = `${entry.database}:${entry.table}`, count = remaining.get(tableKey);
        if (count === undefined || count < 1 || keys.has(key)) refuse();
        remaining.set(tableKey, count - 1);
        keys.add(key); visit(entry); guard();
      }
      if (pending.length > expected.limits.maxRowBytes) refuse();
    }
    if (pending.length || rows !== expected.rows || sha.digest("hex") !== expected.recordsSha256
      || [...remaining.values()].some(value => value !== 0)) refuse();
    guard();
  } catch { return refuse(); }
  finally { closeAll([() => input?.close(), () => manifest?.close(), () => directory?.close()]); }
}
/** Small local oracle. Production transfer consumes visitPeriodicNative. */
export function readPeriodicNative(options: Parameters<typeof visitPeriodicNative>[0]): PeriodicNativeRecord[] {
  if (options.expected.recordsBytes > 64 * 1024 * 1024) refuse();
  const rows: PeriodicNativeRecord[] = []; visitPeriodicNative(options, row => rows.push(row)); return rows;
}
export function restorePeriodicNativeOracle(options: Parameters<typeof visitPeriodicNative>[0] & { destination: string }): void {
  let db: Sqlite.Database | undefined, fd: number | undefined, parent: ReturnType<typeof pinnedDirectory> | undefined;
  try {
    if (path.resolve(options.destination) !== options.destination) refuse();
    parent = pinnedDirectory(path.dirname(options.destination));
    const file = parent.file(path.basename(options.destination));
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const info = fs.fstatSync(fd);
    db = openSqlite(file, { fileMustExist: true });
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA trusted_schema=OFF; BEGIN IMMEDIATE; CREATE TABLE periodic_origin(document TEXT NOT NULL); CREATE TABLE periodic_data(database_name TEXT NOT NULL,table_name TEXT NOT NULL,source_rowid INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(database_name,table_name,source_rowid))");
    const insert = db.prepare("INSERT INTO periodic_data VALUES(?,?,?,?)");
    visitPeriodicNative(options, row => { insert.run(row.database, row.table, row.rowid, encode(row.values)); });
    db.prepare("INSERT INTO periodic_origin VALUES(?)").run(encode(options.expected));
    options.guard(); parent.guard(); db.exec("COMMIT"); db.close(); db = undefined;
    fs.fsyncSync(fd); fs.fsyncSync(parent.fd); parent.guard(); options.guard();
    const current = fs.lstatSync(file); privateMetadata(current);
    if (info.ino !== current.ino || info.dev !== current.dev) refuse();
  } catch { return refuse(); }
  finally { closeAll([() => db?.close(), () => { if (fd !== undefined) fs.closeSync(fd); }, () => parent?.close()]); }
}
