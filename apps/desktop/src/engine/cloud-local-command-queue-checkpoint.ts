import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type Sqlite from "better-sqlite3";
import { z } from "zod";
import { canonicalCloudLocalCommandHistoryJson, canonicalCloudLocalCommandWriterSealDescriptor,
  CloudLocalCommandWriterSealSchema, CloudLocalCommandWriterSealAckSchema, cloudLocalCommandWriterSealAckMatchesSeal,
  type CloudLocalCommandWriterSeal } from "@zeros/protocol/cloud-local-mirror";
import { CloudCommandRuntimeError } from "./cloud-command-client";
import { openSqlite } from "./db/sqlite";

const PART_BYTES = 16 * 1024 * 1024;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const partSchema = z.object({ path: z.string().regex(/^(ledger|normal)\/[0-9]{6}\.part$/),
  bytes: z.number().int().positive().max(PART_BYTES), sha256: digest }).strict();
const fileSchema = z.object({ kind: z.enum(["ledger", "normal"]), bytes: z.number().int().positive().max(MAX_BYTES),
  sha256: digest, parts: z.array(partSchema).min(1).max(128) }).strict().superRefine((file, context) => {
  if (file.parts.length !== Math.ceil(file.bytes / PART_BYTES) || file.parts.some((part, index) =>
    part.path !== `${file.kind}/${String(index).padStart(6, "0")}.part` ||
    part.bytes !== Math.min(PART_BYTES, file.bytes - index * PART_BYTES)))
    context.addIssue({ code: "custom", message: "Invalid checkpoint part inventory" });
});
export const CloudLocalCommandCheckpointManifestSchema = z.object({ version: z.literal(1),
  seal: CloudLocalCommandWriterSealSchema, files: z.tuple([fileSchema, fileSchema]) }).strict().superRefine((value, context) => {
  if (value.files[0].kind !== "ledger" || value.files[1].kind !== "normal" ||
      value.files.reduce((sum, file) => sum + file.bytes, 0) > MAX_BYTES ||
      hash(canonicalCloudLocalCommandWriterSealDescriptor(value.seal)) !== value.seal.sha256)
    context.addIssue({ code: "custom", message: "Invalid sealed checkpoint" });
});
export type CloudLocalCommandCheckpointManifest = z.infer<typeof CloudLocalCommandCheckpointManifestSchema>;

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function invalid(): never { throw new CloudCommandRuntimeError("command_storage_unavailable"); }
function stable(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && after.nlink === 1;
}
async function directory(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(file) !== path.resolve(file) ||
      (process.getuid && stat.uid !== process.getuid())) invalid();
}
async function readHandle(file: string, maxBytes: number): Promise<{ handle: FileHandle; before: Stats }> {
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) invalid();
  await directory(path.dirname(file));
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes ||
        (process.getuid && before.uid !== process.getuid()) || !stable(before, await fs.lstat(file))) invalid();
    return { handle, before };
  } catch (error) { await handle.close(); throw error; }
}
async function writeDurable(file: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(file: string): Promise<void> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** This digest is engine-private. It is not a CP claim that a wire descriptor
 * reconstructs the native scope or proves predecessor retirement. */
export function cloudLocalCommandSealInventory(db: Sqlite.Database, seal: Pick<CloudLocalCommandWriterSeal,
  "scope" | "sequence" | "recordSequence" | "eventSequence">): string {
  const digest = createHash("sha256");
  digest.update(canonicalCloudLocalCommandHistoryJson(seal));
  const deadline = performance.now() + 100;
  for (const [table, order] of [["local_command_history_heads", "conversation_id"], ["local_commands", "id"],
    ["local_command_actions", "operation_id"], ["local_command_history_mutations", "mutation_id"]]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) continue;
    for (let offset = 0;; offset += 64) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 64 OFFSET ?`).all(offset);
      if (!rows.length) break;
      for (const row of rows) {
        if (performance.now() > deadline) invalid();
        digest.update(canonicalCloudLocalCommandHistoryJson(row));
      }
    }
  }
  return digest.digest("hex");
}

function verifyLedger(db: Sqlite.Database, seal: CloudLocalCommandWriterSeal): void {
  const metadata = (key: string) => (db.prepare("SELECT value FROM local_command_metadata WHERE key=?").get(key) as
    { value: string } | undefined)?.value;
  const stored = db.prepare("SELECT document,ack FROM local_command_writer_seals WHERE writer_epoch=?").get(seal.scope.writerEpoch) as
    { document: string; ack: string | null } | undefined;
  if (!stored?.ack || !isDeepStrictEqual(JSON.parse(stored.document), seal) ||
      !cloudLocalCommandWriterSealAckMatchesSeal(CloudLocalCommandWriterSealAckSchema.parse(JSON.parse(stored.ack)), seal) ||
      !isDeepStrictEqual(JSON.parse(metadata("writer") ?? "null"), seal.scope) || metadata("sealedWriter") !== seal.scope.writerEpoch ||
      Number(metadata("journalHead") ?? "0") !== seal.sequence || Number(metadata("mirrorHead") ?? "0") !== seal.sequence ||
      cloudLocalCommandSealInventory(db, { scope: seal.scope, sequence: seal.sequence,
        recordSequence: seal.recordSequence, eventSequence: seal.eventSequence }) !== seal.inventorySha256) invalid();
  const stream = db.prepare("SELECT head FROM local_command_streams WHERE stream_id=? AND writer_epoch=?").get(
    seal.scope.engineInstanceId, seal.scope.writerEpoch) as { head: number } | undefined;
  if (!stream || stream.head !== seal.eventSequence) invalid();
  const pending = (table: string, predicate: string, ...parameters: string[]) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table) &&
    !!db.prepare(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`).get(...parameters);
  if (pending("local_commands", "writer_epoch=? AND state IN ('queued','dispatching')", seal.scope.writerEpoch) ||
      pending("local_commands", "mirror_dirty=1") || pending("local_command_controls", "mirror_dirty=1") ||
      pending("local_command_actions", "writer_epoch=? AND state='dispatching'", seal.scope.writerEpoch) ||
      pending("local_command_control_owners", "settled=0 AND command_id IN (SELECT id FROM local_commands WHERE writer_epoch=?)", seal.scope.writerEpoch) ||
      pending("local_command_journal", "writer_epoch=?", seal.scope.writerEpoch) ||
      pending("local_command_mirror_batches", "writer_epoch=?", seal.scope.writerEpoch) || pending("local_command_outbox_jobs", "1=1")) invalid();
}
function verifyPair(ledgerFile: string, normalFile: string, seal: CloudLocalCommandWriterSeal): void {
  const ledger = openSqlite(ledgerFile, { readonly: true, fileMustExist: true });
  try {
    ledger.pragma("busy_timeout = 25"); verifyLedger(ledger, seal);
    const normal = openSqlite(normalFile, { readonly: true, fileMustExist: true });
    try {
      normal.pragma("busy_timeout = 25");
      const head = normal.prepare("SELECT next_rev-1 AS rev FROM sync_meta WHERE id=0").get() as { rev: number } | undefined;
      if (head?.rev !== seal.recordSequence) invalid();
    } finally { normal.close(); }
  } finally { ledger.close(); }
}

export function cloudLocalCommandCheckpointRoot(data: string, repository: string): string {
  return path.join(data, "cloud-local-command-checkpoints", hash(path.resolve(repository)));
}

/** Called only by the original lifecycle after ACK, positive freeze, and a
 * bounded FULL checkpoint of its ledger. The proof is rechecked across every
 * asynchronous file read; no mutable SQLite/WAL path enters the archive. */
export async function captureCloudLocalCommandCheckpoint(input: { root: string; ledgerFile: string; normalFile: string;
  seal: CloudLocalCommandWriterSeal; assertFrozen(): void }): Promise<CloudLocalCommandCheckpointManifest> {
  input.assertFrozen();
  const root = path.resolve(input.root), parent = path.dirname(root);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 }); await directory(parent);
  const staging = path.join(parent, `.checkpoint-${randomUUID()}`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    const files: CloudLocalCommandCheckpointManifest["files"][number][] = [];
    for (const [kind, source] of [["ledger", input.ledgerFile], ["normal", input.normalFile]] as const) {
      input.assertFrozen();
      const target = path.join(staging, kind); await fs.mkdir(target, { mode: 0o700 });
      const { handle, before } = await readHandle(source, MAX_BYTES);
      try {
        const fileDigest = createHash("sha256"), parts: z.infer<typeof partSchema>[] = [];
        for (let offset = 0; offset < before.size; offset += PART_BYTES) {
          input.assertFrozen();
          const bytes = Buffer.alloc(Math.min(PART_BYTES, before.size - offset));
          let consumed = 0;
          while (consumed < bytes.length) {
            const result = await handle.read(bytes, consumed, bytes.length - consumed, offset + consumed);
            if (!result.bytesRead) invalid(); consumed += result.bytesRead;
          }
          input.assertFrozen(); fileDigest.update(bytes);
          const relative = `${kind}/${String(parts.length).padStart(6, "0")}.part`;
          await writeDurable(path.join(staging, relative), bytes);
          parts.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
        }
        if (!stable(before, await handle.stat()) || !stable(before, await fs.lstat(source))) invalid();
        files.push({ kind, bytes: before.size, sha256: fileDigest.digest("hex"), parts });
        await syncDirectory(target);
      } finally { await handle.close(); }
    }
    input.assertFrozen(); verifyPair(input.ledgerFile, input.normalFile, input.seal);
    const manifest = CloudLocalCommandCheckpointManifestSchema.parse({ version: 1, seal: input.seal, files });
    const bytes = Buffer.from(canonicalCloudLocalCommandHistoryJson(manifest));
    if (bytes.length > MAX_MANIFEST_BYTES) invalid();
    await writeDurable(path.join(staging, "manifest.json"), bytes); await syncDirectory(staging);
    input.assertFrozen();
    const backup = path.join(parent, `.previous-checkpoint-${randomUUID()}`);
    let moved = false;
    try {
      try { await directory(root); await fs.rename(root, backup); moved = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await fs.rename(staging, root); await syncDirectory(parent);
    } catch (error) {
      if (moved) await fs.rename(backup, root).catch(() => {});
      throw error;
    }
    if (moved) await fs.rm(backup, { recursive: true, force: true });
    return manifest;
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
}

/** Private restored candidates are never runnable writer authority. Return
 * them only after every chunk, whole-file digest and persisted seal/ACK pair
 * has been independently verified for the authenticated workspace. */
export async function verifyCloudLocalCommandCheckpoint(input: { root: string; scope: { organizationId: string; workspaceId: string };
  expectedWriterEpoch?: string }):
  Promise<{ manifest: CloudLocalCommandCheckpointManifest; ledgerFile: string; normalFile: string; cleanup(): Promise<void> }> {
  const root = path.resolve(input.root); await directory(root);
  const { handle, before } = await readHandle(path.join(root, "manifest.json"), MAX_MANIFEST_BYTES);
  let manifest: CloudLocalCommandCheckpointManifest;
  try {
    const bytes = await handle.readFile();
    if (bytes.length !== before.size || !stable(before, await handle.stat())) invalid();
    manifest = CloudLocalCommandCheckpointManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  } finally { await handle.close(); }
  if (manifest.seal.scope.organizationId !== input.scope.organizationId || manifest.seal.scope.workspaceId !== input.scope.workspaceId) invalid();
  // The authenticated enrollment selects the current predecessor. Blob
  // custody alone cannot distinguish an old, valid checkpoint on an empty VM.
  // Check before allocating a candidate or installing either database file.
  if (input.expectedWriterEpoch !== undefined && (!z.string().uuid().safeParse(input.expectedWriterEpoch).success ||
      manifest.seal.scope.writerEpoch !== input.expectedWriterEpoch)) invalid();
  const restored = path.join(root, `.verified-${randomUUID()}`); await fs.mkdir(restored, { mode: 0o700 });
  try {
    for (const file of manifest.files) {
      const destination = await fs.open(path.join(restored, `${file.kind}.sqlite`),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const fileDigest = createHash("sha256"); let total = 0;
        for (const part of file.parts) {
          const source = path.join(root, part.path), { handle, before } = await readHandle(source, PART_BYTES);
          try {
            const bytes = await handle.readFile();
            if (bytes.length !== part.bytes || bytes.length !== before.size || hash(bytes) !== part.sha256 ||
                !stable(before, await handle.stat()) || !stable(before, await fs.lstat(source))) invalid();
            fileDigest.update(bytes); total += bytes.length; await destination.writeFile(bytes);
          } finally { await handle.close(); }
        }
        if (total !== file.bytes || fileDigest.digest("hex") !== file.sha256) invalid();
        await destination.sync();
      } finally { await destination.close(); }
    }
    const ledgerFile = path.join(restored, "ledger.sqlite"), normalFile = path.join(restored, "normal.sqlite");
    verifyPair(ledgerFile, normalFile, manifest.seal);
    return { manifest, ledgerFile, normalFile, cleanup: () => fs.rm(restored, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(restored, { recursive: true, force: true }); throw error; }
}

/** Install only immutable history/audit custody. The boot owner constructs a
 * different writer epoch after rebuilding from the read-only candidate; this
 * operation never claims, replays or resumes an original native execution. */
export async function restoreCloudLocalCommandCheckpointLedger(input: { root: string; file: string;
  scope: { organizationId: string; workspaceId: string }; expectedWriterEpoch?: string }): ReturnType<typeof verifyCloudLocalCommandCheckpoint> {
  const verified = await verifyCloudLocalCommandCheckpoint(input);
  const file = path.resolve(input.file), parent = path.dirname(file);
  try {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 }); await directory(parent);
    try {
      const { handle } = await readHandle(file, MAX_BYTES); await handle.close();
      const existing = openSqlite(file, { readonly: true, fileMustExist: true });
      try { verifyLedger(existing, verified.manifest.seal); } finally { existing.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = path.join(parent, `.restored-ledger-${randomUUID()}`);
    try {
      const { handle, before } = await readHandle(verified.ledgerFile, MAX_BYTES);
      const destination = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const digest = createHash("sha256");
        for (let offset = 0; offset < before.size; offset += PART_BYTES) {
          const bytes = Buffer.alloc(Math.min(PART_BYTES, before.size - offset)); let consumed = 0;
          while (consumed < bytes.length) {
            const result = await handle.read(bytes, consumed, bytes.length - consumed, offset + consumed);
            if (!result.bytesRead) invalid(); consumed += result.bytesRead;
          }
          digest.update(bytes); await destination.writeFile(bytes);
        }
        if (digest.digest("hex") !== verified.manifest.files[0].sha256 || !stable(before, await handle.stat())) invalid();
        await destination.sync();
      } finally { await handle.close(); await destination.close(); }
      // No companion/native writer is opened at this stage. Old sidecars
      // cannot add a different WAL generation to the verified main file.
      await fs.rm(`${file}-wal`, { force: true }); await fs.rm(`${file}-shm`, { force: true });
      await fs.rename(temporary, file); await syncDirectory(parent);
    } finally { await fs.rm(temporary, { force: true }); }
    return verified;
  } catch (error) { await verified.cleanup(); throw error; }
}
