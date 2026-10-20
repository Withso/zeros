import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
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
import { CloudAgentBootScopeSchema, CloudAgentHistoryRecoveryResponseSchema, type CloudAgentBootScope,
  type CloudAgentHistoryRecoveryRequest, type CloudAgentHistoryRecoveryResponse } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudLocalCommandHistoryHeadSchema } from "@zeros/protocol/cloud-local-mirror";
import { checkpointHistoryMarker, importCheckpointHistory, parseCheckpointHistory, verifyCheckpointHistoryImport } from "./cloud-local-command-checkpoint-history";

const PART_BYTES = 16 * 1024 * 1024;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
// A complete retained ledger is disk I/O, not an interactive 100 ms read.
// Admit each synchronous proof only within this finite monotonic budget;
// nested inventories share its deadline instead of restarting the clock.
// Checks surround native reads; they cannot interrupt a SQLite call in flight.
const INVENTORY_BUDGET_MS = 5_000;
function inventoryDeadline(): number { return performance.now() + INVENTORY_BUDGET_MS; }
function checkInventoryDeadline(deadline: number): void {
  if (performance.now() > deadline) invalid("checkpoint_inventory_timeout");
}
/** Closed failure sites, mirrored by the standalone setup producer and CP
 * parser. No path, SQL, artifact content or provider output is diagnostic. */
export const CLOUD_LOCAL_COMMAND_CHECKPOINT_CODES = [
  "checkpoint_directory_metadata", "checkpoint_file_open_flags", "checkpoint_file_metadata", "checkpoint_part_path",
  "checkpoint_inventory_timeout", "checkpoint_seal_missing", "checkpoint_seal_document", "checkpoint_seal_ack",
  "checkpoint_writer_scope", "checkpoint_writer_unsealed", "checkpoint_journal_head", "checkpoint_mirror_head",
  "checkpoint_inventory_hash", "checkpoint_stream_head", "checkpoint_pending_work", "checkpoint_normal_head",
  "checkpoint_capture_read", "checkpoint_capture_identity", "checkpoint_manifest_size", "checkpoint_manifest_missing",
  "checkpoint_manifest_identity", "checkpoint_manifest_invalid", "checkpoint_workspace_mismatch", "checkpoint_expected_writer_mismatch",
  "checkpoint_part_missing", "checkpoint_part_size", "checkpoint_part_hash", "checkpoint_part_identity",
  "checkpoint_assembled_size", "checkpoint_assembled_hash", "checkpoint_restore_read", "checkpoint_restore_hash", "checkpoint_restore_identity",
] as const;
type CheckpointCode = typeof CLOUD_LOCAL_COMMAND_CHECKPOINT_CODES[number];
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

/** Custody of the exact restored predecessor, never permission to execute.
 * Only restoration with authenticated source lineage can mint this receipt;
 * copying its public fields cannot manufacture one. */
export type CloudLocalCommandPredecessor = Readonly<{ scope: Readonly<CloudAgentBootScope> }>;
type VerifiedTranscriptPair = { ledgerFile: string; ledger: Stats; normalFile: string; normal: Stats };
const verifiedTranscriptPairs = new WeakMap<object, VerifiedTranscriptPair>();
const restoredPredecessors = new WeakMap<CloudLocalCommandPredecessor, {
  file: string; dev: number; ino: number; seal: CloudLocalCommandWriterSeal;
  transcript: VerifiedTranscriptPair;
}>();
type HistoryOrigin = Readonly<{ scope: Readonly<CloudAgentBootScope>; recordSequence: number; eventSequence: number }>;
type RecoveryHistory = HistoryOrigin & { readonly origins: readonly HistoryOrigin[] };
const recoveryPrepareSchema = z.object({ version: z.literal(1), scope: CloudAgentBootScopeSchema,
  recoveryId: z.string().uuid(), predecessor: CloudAgentBootScopeSchema,
  checkpoint: CloudAgentHistoryRecoveryResponseSchema.shape.checkpoint,
  predecessorRecovery: CloudAgentHistoryRecoveryResponseSchema.shape.predecessorRecovery,
  history: z.object({ recordSequence: z.number().int().nonnegative().safe(), eventSequence: z.number().int().nonnegative().safe() }).strict(),
  mirroredSequence: z.number().int().nonnegative().safe(), mirrorHead: z.number().int().nonnegative().safe().optional(),
  journalHead: z.number().int().nonnegative().safe().optional(), retainedSha256: digest,
  checkpointOnly: z.object({ ownerDiscardReceiptId: z.string().uuid(), checkpointId: z.string().uuid(), sha256: digest }).strict().optional(),
}).strict().refine(value => value.checkpointOnly ? value.mirrorHead === undefined && value.journalHead === undefined :
  value.mirrorHead !== undefined && value.journalHead !== undefined);
type RecoveryCustody = { mirrorHead: number; journalHead: number; retainedSha256: string; checkpointOnly?: never } |
  { mirrorHead?: never; journalHead?: never; retainedSha256: string;
    checkpointOnly: { ownerDiscardReceiptId: string; checkpointId: string; sha256: string } };
const recoveredPredecessors = new WeakMap<CloudLocalCommandPredecessor, {
  file: string; dev: number; ino: number; authorization: CloudAgentHistoryRecoveryResponse;
  inventory: string; history: RecoveryHistory; credentialScope: Readonly<CloudAgentBootScope>; custody: RecoveryCustody;
}>();

export function verifiedCloudLocalCommandPredecessor(
  receipt: CloudLocalCommandPredecessor | null | undefined, file: string, db: Sqlite.Database, target?: CloudAgentBootScope,
): Readonly<CloudAgentBootScope> | null {
  if (!receipt) return null;
  const recovery = recoveredPredecessors.get(receipt);
  if (recovery) {
    if (!target || recovery.file !== path.resolve(file) || !sameRecoveryTarget(recovery.authorization, target)) return null;
    return verifiedCloudLocalCommandRecoveryHistory(receipt, db) ? recovery.credentialScope : null;
  }
  const proof = restoredPredecessors.get(receipt);
  if (!proof || proof.file !== path.resolve(file)) return null;
  try {
    const current = lstatSync(file);
    if (!current.isFile() || current.nlink !== 1 || current.dev !== proof.dev || current.ino !== proof.ino) return null;
    // The FULL writer/seal/ACK must still be the restored one at cutover.
    // A copied receipt, later writer or rolled-back file cannot authorize it.
    verifyLedger(db, proof.seal);
    return receipt.scope;
  } catch { return null; }
}

/** The exact sealed NORMAL snapshot is local transcript custody, not a new
 * complete mirror head. Only authenticated sealed restoration can mint this
 * capability. An unsealed recovery's ancestor must never supply newer rows. */
export function readVerifiedCloudLocalCommandSealedTranscript<T>(receipt: CloudLocalCommandPredecessor | null | undefined,
  ledger: Sqlite.Database, seal: CloudLocalCommandWriterSeal, read: (normal: Sqlite.Database) => T): T {
  const proof = receipt && restoredPredecessors.get(receipt);
  if (!proof || !isDeepStrictEqual(seal, proof.seal)) invalid("checkpoint_writer_scope");
  const source = proof.transcript;
  const current = () => {
    const main = (ledger.prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find(row => row.name === "main");
    if (main?.file !== source.ledgerFile) invalid("checkpoint_writer_scope");
    unchangedTranscriptFile(source.ledgerFile, source.ledger); unchangedTranscriptFile(source.normalFile, source.normal);
  };
  current();
  // Pin the descriptor before SQLite opens its read view. The selected file
  // cannot be redirected by replacing its pathname between the checks.
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) invalid("checkpoint_file_open_flags");
  const descriptor = openSync(source.normalFile,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let normal: Sqlite.Database | undefined;
  try {
    const pinned = () => { if (!stable(source.normal,fstatSync(descriptor))) invalid("checkpoint_restore_identity"); };
    pinned(); current();
    normal = openSqlite(`${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${descriptor}`, { readonly: true, fileMustExist: true });
    normal.pragma("busy_timeout = 25"); normal.pragma("query_only = ON");
    const snapshot = normal;
    const result = snapshot.transaction(() => {
      pinned(); current();
      const head = snapshot.prepare("SELECT next_rev-1 AS rev FROM sync_meta WHERE id=0").get() as { rev: number } | undefined;
      if (head?.rev !== seal.recordSequence) invalid("checkpoint_normal_head");
      return read(snapshot);
    })();
    pinned(); current(); return result;
  } finally { normal?.close(); closeSync(descriptor); }
}

function sameRecoveryTarget(authorization: CloudAgentHistoryRecoveryResponse,
  target: Pick<CloudAgentBootScope, "organizationId" | "workspaceId" | "generation" | "engineInstanceId" | "bootId"> &
    Partial<Pick<CloudAgentBootScope, "fundingOwnerUserId" | "fundingOwnerEpoch">>): boolean {
  return (["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId"] as const)
    .every(key => authorization[key] === target[key]) &&
    (target.fundingOwnerUserId === undefined || target.fundingOwnerUserId === authorization.fundingOwnerUserId) &&
    (target.fundingOwnerEpoch === undefined || target.fundingOwnerEpoch === authorization.fundingOwnerEpoch);
}

/** Read-only history custody, not a fabricated complete seal. The private
 * receipt must still refer to the same FULL file and every retained fence. */
export function verifiedCloudLocalCommandRecoveryHistory(
  receipt: CloudLocalCommandPredecessor, db: Sqlite.Database,
): RecoveryHistory | null {
  const proof = recoveredPredecessors.get(receipt);
  if (!proof) return null;
  try {
    const current = lstatSync(proof.file);
    if (!current.isFile() || current.nlink !== 1 || current.dev !== proof.dev || current.ino !== proof.ino ||
        recoveryInventory(db) !== proof.inventory) return null;
    return proof.history;
  } catch { return null; }
}

export function cloudLocalCommandHistoryRecoveryId(receipt: CloudLocalCommandPredecessor | null | undefined): string | null {
  return receipt ? recoveredPredecessors.get(receipt)?.authorization.recoveryId ?? null : null;
}

function recoveryPrepareDocument(proof: NonNullable<ReturnType<typeof recoveredPredecessors.get>>, target: CloudAgentBootScope): string {
  if (!sameRecoveryTarget(proof.authorization, target)) invalid("checkpoint_writer_scope");
  return canonicalCloudLocalCommandHistoryJson(recoveryPrepareSchema.parse({ version: 1, scope: target,
    recoveryId: proof.authorization.recoveryId, predecessor: proof.authorization.predecessor,
    checkpoint: proof.authorization.checkpoint,
    ...(proof.authorization.predecessorRecovery ? { predecessorRecovery: proof.authorization.predecessorRecovery } : {}),
    history: { recordSequence: proof.history.recordSequence, eventSequence: proof.history.eventSequence },
    mirroredSequence: proof.authorization.mirroredSequence, ...proof.custody }));
}

/** Pinned by CP atomically with activation. A later unsealed recovery can
 * authenticate exactly this small record and its prior committed hash link. */
export function cloudLocalCommandHistoryRecoveryCustodySha256(receipt: CloudLocalCommandPredecessor | null | undefined,
  target: CloudAgentBootScope): string | null {
  const proof = receipt && recoveredPredecessors.get(receipt);
  return proof ? hash(recoveryPrepareDocument(proof, target)) : null;
}

/** Boot supplies this inside the FULL credential namespace transaction. */
export function verifyAndPrepareCloudLocalCommandPredecessor(
  receipt: CloudLocalCommandPredecessor | null | undefined, file: string, db: Sqlite.Database, target: CloudAgentBootScope,
): Readonly<CloudAgentBootScope> | null {
  const previous = verifiedCloudLocalCommandPredecessor(receipt, file, db, target);
  if (!previous || !receipt) return null;
  const proof = recoveredPredecessors.get(receipt);
  if (!proof) return previous;
  if (!db.inTransaction) return null;
  const document = recoveryPrepareDocument(proof, target);
  // This exact record commits with the credential namespace. No network await
  // or CP activation occurs in this FULL transaction. On a later boot it is
  // only evidence to request fresh CP authority, never a local capability.
  db.exec("CREATE TABLE IF NOT EXISTS local_command_history_recovery_prepares(writer_epoch TEXT PRIMARY KEY,document TEXT NOT NULL)");
  const old = db.prepare("SELECT document FROM local_command_history_recovery_prepares WHERE writer_epoch=?").get(target.writerEpoch) as
    { document: string } | undefined;
  if (old ? old.document !== document : (db.prepare("SELECT count(*) n FROM local_command_history_recovery_prepares").get() as { n: number }).n >= 4096)
    invalid("checkpoint_writer_scope");
  db.prepare("INSERT OR IGNORE INTO local_command_history_recovery_prepares(writer_epoch,document) VALUES(?,?)").run(target.writerEpoch, document);
  return previous;
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function invalid(code: CheckpointCode): never { throw new CloudCommandRuntimeError(code); }
function json(value: string, code: CheckpointCode): unknown {
  try { return JSON.parse(value); } catch { return invalid(code); }
}
function stable(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && after.nlink === 1;
}
function unchangedTranscriptFile(file: string, before: Stats): void {
  const current = lstatSync(file);
  if (!current.isFile() || realpathSync(file) !== file || !stable(before, current)) invalid("checkpoint_restore_identity");
  // A mutable WAL cannot extend an immutable verified main-file snapshot.
  try { if (lstatSync(`${file}-wal`).size !== 0) invalid("checkpoint_normal_head"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function directory(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(file) !== path.resolve(file) ||
      (process.getuid && stat.uid !== process.getuid())) invalid("checkpoint_directory_metadata");
}
async function readHandle(file: string, maxBytes: number): Promise<{ handle: FileHandle; before: Stats }> {
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) invalid("checkpoint_file_open_flags");
  await directory(path.dirname(file));
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes ||
        (process.getuid && before.uid !== process.getuid()) || !stable(before, await fs.lstat(file))) invalid("checkpoint_file_metadata");
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

async function moveRegular(source: string, destination: string, maxBytes: number): Promise<void> {
  const { handle } = await readHandle(source, maxBytes);
  try { await directory(path.dirname(destination)); await fs.rename(source, destination); }
  finally { await handle.close(); }
}

/** Boat restore does not preserve children reliably when their directory is
 * renamed. Keep the published directories in place, invalidate the manifest
 * before replacing parts, and publish that regular file last. */
async function publishCheckpoint(root: string, staging: string, manifest: CloudLocalCommandCheckpointManifest,
  assertFrozen: () => void): Promise<void> {
  const parent = path.dirname(root), backup = path.join(parent, `.previous-checkpoint-${randomUUID()}`);
  for (const file of [root, path.join(root, "ledger"), path.join(root, "normal")]) {
    await fs.mkdir(file, { recursive: true, mode: 0o700 }); await directory(file);
  }
  await syncDirectory(root); await syncDirectory(parent);
  await fs.mkdir(backup, { mode: 0o700 });
  const oldParts: string[] = [], newParts: string[] = [];
  let oldManifest = false, newManifest = false, keepBackup = false;
  try {
    for (const kind of ["ledger", "normal"]) await fs.mkdir(path.join(backup, kind), { mode: 0o700 });
    assertFrozen();
    try {
      await moveRegular(path.join(root, "manifest.json"), path.join(backup, "manifest.json"), MAX_MANIFEST_BYTES);
      oldManifest = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await syncDirectory(root); await syncDirectory(backup);
    for (const kind of ["ledger", "normal"]) {
      for (const name of (await fs.readdir(path.join(root, kind))).sort()) {
        if (!/^[0-9]{6}\.part$/.test(name)) invalid("checkpoint_part_path");
        assertFrozen();
        const relative = `${kind}/${name}`;
        await moveRegular(path.join(root, relative), path.join(backup, relative), PART_BYTES);
        oldParts.push(relative);
      }
      await syncDirectory(path.join(root, kind)); await syncDirectory(path.join(backup, kind));
    }
    for (const file of manifest.files) {
      for (const part of file.parts) {
        assertFrozen();
        await moveRegular(path.join(staging, part.path), path.join(root, part.path), PART_BYTES);
        newParts.push(part.path);
      }
      await syncDirectory(path.join(root, file.kind));
    }
    assertFrozen();
    await moveRegular(path.join(staging, "manifest.json"), path.join(root, "manifest.json"), MAX_MANIFEST_BYTES);
    newManifest = true;
    await syncDirectory(root); await syncDirectory(parent);
  } catch (error) {
    try {
      if (newManifest) await fs.unlink(path.join(root, "manifest.json"));
      await syncDirectory(root);
      for (const relative of newParts) await fs.unlink(path.join(root, relative));
      for (const relative of oldParts) await moveRegular(path.join(backup, relative), path.join(root, relative), PART_BYTES);
      for (const kind of ["ledger", "normal"]) await syncDirectory(path.join(root, kind));
      if (oldManifest) await moveRegular(path.join(backup, "manifest.json"), path.join(root, "manifest.json"), MAX_MANIFEST_BYTES);
      await syncDirectory(root); await syncDirectory(parent);
    } catch {
      // An incomplete rollback must not expose a mixed pair as a checkpoint.
      // Retain the backup for diagnosis instead of deleting the predecessor.
      keepBackup = true;
      await fs.unlink(path.join(root, "manifest.json")).catch(() => undefined);
      await syncDirectory(root).catch(() => undefined);
    }
    throw error;
  } finally {
    if (!keepBackup) await fs.rm(backup, { recursive: true, force: true });
  }
}

/** This digest is engine-private. It is not a CP claim that a wire descriptor
 * reconstructs the native scope or proves predecessor retirement. */
export function cloudLocalCommandSealInventory(db: Sqlite.Database, seal: Pick<CloudLocalCommandWriterSeal,
  "scope" | "sequence" | "recordSequence" | "eventSequence">): string {
  return sealInventory(db, seal, inventoryDeadline());
}
function sealInventory(db: Sqlite.Database, seal: Pick<CloudLocalCommandWriterSeal,
  "scope" | "sequence" | "recordSequence" | "eventSequence">, deadline: number): string {
  const digest = createHash("sha256");
  digest.update(canonicalCloudLocalCommandHistoryJson(seal));
  for (const [table, order] of [["local_command_history_heads", "conversation_id"], ["local_commands", "id"],
    ["local_command_actions", "operation_id"], ["local_command_history_mutations", "mutation_id"]] as const) {
    checkInventoryDeadline(deadline);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) continue;
    for (const row of recoveryRows(db, table, order, deadline)) digest.update(canonicalCloudLocalCommandHistoryJson(row));
  }
  // Preserve every legacy hash when the table is absent or empty. A tagged,
  // ordered nonempty section binds all recovery records into subsequent seals.
  if (hasTable(db, "local_command_history_recovery_prepares")) {
    let started = false;
    for (const row of recoveryRows(db, "local_command_history_recovery_prepares", "writer_epoch", deadline)) {
      if (!started) { digest.update("\0local_command_history_recovery_prepares:v1\0"); started = true; }
      digest.update(canonicalCloudLocalCommandHistoryJson(row));
    }
  }
  if (hasTable(db, "local_command_recovered_history_mutations")) {
    let started = false;
    for (const row of recoveryRows(db, "local_command_recovered_history_mutations", "mutation_id", deadline)) {
      if (!started) { digest.update("\0local_command_recovered_history_mutations:v1\0"); started = true; }
      digest.update(canonicalCloudLocalCommandHistoryJson(row));
    }
  }
  if (hasTable(db, "local_command_checkpoint_history")) {
    let started = false;
    for (const row of recoveryRows(db, "local_command_checkpoint_history", "recovery_id", deadline)) {
      if (!started) { digest.update("\0local_command_checkpoint_history:v1\0"); started = true; }
      digest.update(canonicalCloudLocalCommandHistoryJson(row));
    }
  }
  checkInventoryDeadline(deadline);
  return digest.digest("hex");
}

function verifyLedger(db: Sqlite.Database, seal: CloudLocalCommandWriterSeal, deadline = inventoryDeadline()): void {
  checkInventoryDeadline(deadline);
  const metadata = (key: string) => (db.prepare("SELECT value FROM local_command_metadata WHERE key=?").get(key) as
    { value: string } | undefined)?.value;
  const stored = db.prepare("SELECT document,ack FROM local_command_writer_seals WHERE writer_epoch=?").get(seal.scope.writerEpoch) as
    { document: string; ack: string | null } | undefined;
  if (!stored?.ack) invalid("checkpoint_seal_missing");
  if (!isDeepStrictEqual(json(stored.document, "checkpoint_seal_document"), seal)) invalid("checkpoint_seal_document");
  const ack = CloudLocalCommandWriterSealAckSchema.safeParse(json(stored.ack, "checkpoint_seal_ack"));
  if (!ack.success || !cloudLocalCommandWriterSealAckMatchesSeal(ack.data, seal)) invalid("checkpoint_seal_ack");
  if (!isDeepStrictEqual(json(metadata("writer") ?? "null", "checkpoint_writer_scope"), seal.scope)) invalid("checkpoint_writer_scope");
  if (metadata("sealedWriter") !== seal.scope.writerEpoch) invalid("checkpoint_writer_unsealed");
  if (Number(metadata("journalHead") ?? "0") !== seal.sequence) invalid("checkpoint_journal_head");
  if (Number(metadata("mirrorHead") ?? "0") !== seal.sequence) invalid("checkpoint_mirror_head");
  if (sealInventory(db, { scope: seal.scope, sequence: seal.sequence,
    recordSequence: seal.recordSequence, eventSequence: seal.eventSequence }, deadline) !== seal.inventorySha256) invalid("checkpoint_inventory_hash");
  const stream = db.prepare("SELECT head FROM local_command_streams WHERE stream_id=? AND writer_epoch=?").get(
    seal.scope.engineInstanceId, seal.scope.writerEpoch) as { head: number } | undefined;
  if (!stream || stream.head !== seal.eventSequence) invalid("checkpoint_stream_head");
  const pending = (table: string, predicate: string, ...parameters: string[]) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table) &&
    !!db.prepare(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`).get(...parameters);
  if (metadata("historyProjectionWriter") === seal.scope.writerEpoch ||
      pending("local_commands", "writer_epoch=? AND state IN ('queued','dispatching')", seal.scope.writerEpoch) ||
      pending("local_commands", "mirror_dirty=1") || pending("local_command_controls", "mirror_dirty=1") ||
      pending("local_command_actions", "writer_epoch=? AND state='dispatching'", seal.scope.writerEpoch) ||
      pending("local_command_control_owners", "settled=0 AND command_id IN (SELECT id FROM local_commands WHERE writer_epoch=?)", seal.scope.writerEpoch) ||
      pending("local_command_journal", "writer_epoch=?", seal.scope.writerEpoch) ||
      pending("local_command_mirror_batches", "writer_epoch=?", seal.scope.writerEpoch) || pending("local_command_outbox_jobs", "1=1")) invalid("checkpoint_pending_work");
  checkInventoryDeadline(deadline);
}
function verifyPair(ledgerFile: string, normalFile: string, seal: CloudLocalCommandWriterSeal): void {
  const deadline = inventoryDeadline();
  const ledger = openSqlite(ledgerFile, { readonly: true, fileMustExist: true });
  try {
    ledger.pragma("busy_timeout = 25"); verifyLedger(ledger, seal, deadline);
    const normal = openSqlite(normalFile, { readonly: true, fileMustExist: true });
    try {
      normal.pragma("busy_timeout = 25");
      const head = normal.prepare("SELECT next_rev-1 AS rev FROM sync_meta WHERE id=0").get() as { rev: number } | undefined;
      if (head?.rev !== seal.recordSequence) invalid("checkpoint_normal_head");
      checkInventoryDeadline(deadline);
    } finally { normal.close(); }
  } finally { ledger.close(); }
  checkInventoryDeadline(deadline);
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
            if (!result.bytesRead) invalid("checkpoint_capture_read"); consumed += result.bytesRead;
          }
          input.assertFrozen(); fileDigest.update(bytes);
          const relative = `${kind}/${String(parts.length).padStart(6, "0")}.part`;
          await writeDurable(path.join(staging, relative), bytes);
          parts.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
        }
        if (!stable(before, await handle.stat()) || !stable(before, await fs.lstat(source))) invalid("checkpoint_capture_identity");
        files.push({ kind, bytes: before.size, sha256: fileDigest.digest("hex"), parts });
        await syncDirectory(target);
      } finally { await handle.close(); }
    }
    input.assertFrozen(); verifyPair(input.ledgerFile, input.normalFile, input.seal);
    const manifest = CloudLocalCommandCheckpointManifestSchema.parse({ version: 1, seal: input.seal, files });
    const bytes = Buffer.from(canonicalCloudLocalCommandHistoryJson(manifest));
    if (bytes.length > MAX_MANIFEST_BYTES) invalid("checkpoint_manifest_size");
    await writeDurable(path.join(staging, "manifest.json"), bytes); await syncDirectory(staging);
    input.assertFrozen();
    await publishCheckpoint(root, staging, manifest, input.assertFrozen);
    return manifest;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

/** Private restored candidates are never runnable writer authority. Return
 * them only after every chunk, whole-file digest and persisted seal/ACK pair
 * has been independently verified for the authenticated workspace. */
export async function verifyCloudLocalCommandCheckpoint(input: { root: string; scope: { organizationId: string; workspaceId: string };
  expectedWriterEpoch?: string }):
  Promise<{ manifest: CloudLocalCommandCheckpointManifest; ledgerFile: string; normalFile: string; cleanup(): Promise<void> }> {
  const root = path.resolve(input.root);
  let opened: Awaited<ReturnType<typeof readHandle>>;
  try { await directory(root); opened = await readHandle(path.join(root, "manifest.json"), MAX_MANIFEST_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") invalid("checkpoint_manifest_missing");
    throw error;
  }
  const { handle, before } = opened;
  let manifest: CloudLocalCommandCheckpointManifest;
  try {
    const bytes = await handle.readFile();
    if (bytes.length !== before.size || !stable(before, await handle.stat())) invalid("checkpoint_manifest_identity");
    const parsed = CloudLocalCommandCheckpointManifestSchema.safeParse(json(bytes.toString("utf8"), "checkpoint_manifest_invalid"));
    if (!parsed.success) invalid("checkpoint_manifest_invalid");
    manifest = parsed.data;
  } finally { await handle.close(); }
  if (manifest.seal.scope.organizationId !== input.scope.organizationId || manifest.seal.scope.workspaceId !== input.scope.workspaceId) invalid("checkpoint_workspace_mismatch");
  // The authenticated enrollment selects the current predecessor. Blob
  // custody alone cannot distinguish an old, valid checkpoint on an empty VM.
  // Check before allocating a candidate or installing either database file.
  if (input.expectedWriterEpoch !== undefined && (!z.string().uuid().safeParse(input.expectedWriterEpoch).success ||
      manifest.seal.scope.writerEpoch !== input.expectedWriterEpoch)) invalid("checkpoint_expected_writer_mismatch");
  const restored = path.join(root, `.verified-${randomUUID()}`); await fs.mkdir(restored, { mode: 0o700 });
  try {
    const assembled = new Map<"ledger" | "normal", Stats>();
    for (const file of manifest.files) {
      const destination = await fs.open(path.join(restored, `${file.kind}.sqlite`),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        const fileDigest = createHash("sha256"); let total = 0;
        for (const part of file.parts) {
          const source = path.join(root, part.path);
          let opened: Awaited<ReturnType<typeof readHandle>>;
          try { opened = await readHandle(source, PART_BYTES); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") invalid("checkpoint_part_missing");
            throw error;
          }
          const { handle, before } = opened;
          try {
            const bytes = await handle.readFile();
            if (bytes.length !== part.bytes || bytes.length !== before.size) invalid("checkpoint_part_size");
            if (hash(bytes) !== part.sha256) invalid("checkpoint_part_hash");
            if (!stable(before, await handle.stat()) || !stable(before, await fs.lstat(source))) invalid("checkpoint_part_identity");
            fileDigest.update(bytes); total += bytes.length; await destination.writeFile(bytes);
          } finally { await handle.close(); }
        }
        if (total !== file.bytes) invalid("checkpoint_assembled_size");
        if (fileDigest.digest("hex") !== file.sha256) invalid("checkpoint_assembled_hash");
        await destination.sync();
        // Bind the exact descriptor that received the verified bytes. A later
        // install await must never bless a replacement or changed candidate.
        const identity = await destination.stat();
        if (!identity.isFile() || identity.nlink !== 1 || identity.size !== file.bytes) invalid("checkpoint_assembled_size");
        assembled.set(file.kind,identity);
      } finally { await destination.close(); }
    }
    const ledgerFile = path.join(restored, "ledger.sqlite"), normalFile = path.join(restored, "normal.sqlite");
    const transcript = { ledgerFile, ledger: assembled.get("ledger")!, normalFile, normal: assembled.get("normal")! };
    unchangedTranscriptFile(ledgerFile,transcript.ledger); unchangedTranscriptFile(normalFile,transcript.normal);
    verifyPair(ledgerFile, normalFile, manifest.seal);
    unchangedTranscriptFile(ledgerFile,transcript.ledger); unchangedTranscriptFile(normalFile,transcript.normal);
    const verified = { manifest, ledgerFile, normalFile, cleanup: () => fs.rm(restored, { recursive: true, force: true }) };
    verifiedTranscriptPairs.set(verified,transcript);
    return verified;
  } catch (error) { await fs.rm(restored, { recursive: true, force: true }); throw error; }
}

/** Install only immutable history/audit custody. The boot owner constructs a
 * different writer epoch after rebuilding from the read-only candidate; this
 * operation never claims, replays or resumes an original native execution. */
export async function restoreCloudLocalCommandCheckpointLedger(input: { root: string; file: string;
  scope: { organizationId: string; workspaceId: string }; expectedWriterEpoch?: string }):
  Promise<Awaited<ReturnType<typeof verifyCloudLocalCommandCheckpoint>> & { predecessor: CloudLocalCommandPredecessor | null }> {
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
            if (!result.bytesRead) invalid("checkpoint_restore_read"); consumed += result.bytesRead;
          }
          digest.update(bytes); await destination.writeFile(bytes);
        }
        if (digest.digest("hex") !== verified.manifest.files[0].sha256) invalid("checkpoint_restore_hash");
        if (!stable(before, await handle.stat())) invalid("checkpoint_restore_identity");
        await destination.sync();
      } finally { await handle.close(); await destination.close(); }
      // No companion/native writer is opened at this stage. Old sidecars
      // cannot add a different WAL generation to the verified main file.
      await fs.rm(`${file}-wal`, { force: true }); await fs.rm(`${file}-shm`, { force: true });
      await fs.rename(temporary, file); await syncDirectory(parent);
    } finally { await fs.rm(temporary, { force: true }); }
    let predecessor: CloudLocalCommandPredecessor | null = null;
    if (input.expectedWriterEpoch !== undefined) {
      const scope = Object.freeze({ ...verified.manifest.seal.scope });
      const published = await fs.lstat(file);
      const transcript = verifiedTranscriptPairs.get(verified);
      if (!transcript) invalid("checkpoint_restore_identity");
      unchangedTranscriptFile(transcript.ledgerFile,transcript.ledger); unchangedTranscriptFile(transcript.normalFile,transcript.normal);
      predecessor = Object.freeze({ scope });
      restoredPredecessors.set(predecessor, { file, dev: published.dev, ino: published.ino,
        seal: Object.freeze({ ...verified.manifest.seal, scope }), transcript });
    }
    return { ...verified, predecessor };
  } catch (error) { await verified.cleanup(); throw error; }
}

const recoveryTables = [
  ["local_command_metadata", "key"], ["local_command_controls", "conversation_id"], ["local_commands", "id"],
  ["local_command_operations", "id"], ["local_command_journal", "writer_epoch,sequence"],
  ["local_command_mirror_batches", "writer_epoch"], ["local_command_history_heads", "conversation_id"],
  ["local_command_history_documents", "sha256"], ["local_command_history_mutations", "mutation_id"],
  ["local_command_outbox_jobs", "id"], ["local_command_history_limits", "conversation_id,sha256"],
  ["local_command_writer_seals", "writer_epoch"], ["local_command_streams", "stream_id"],
  ["local_command_events", "stream_id,sequence"], ["local_command_control_owners", "resolver_id"],
  ["local_command_compact_controls", "stream_id,sequence"], ["local_command_credential_uses", "command_id"],
  ["local_command_actions", "operation_id"], ["local_credential_control_metadata", "key"],
  ["local_credential_control_scopes", "writer_epoch"], ["local_credential_start_fences", "mutation_id"],
  ["local_credential_control_operations", "request_id"], ["local_credential_retirement_floors", "mutation_id,provider,credential_id"],
  ["local_command_history_recovery_prepares", "writer_epoch"],
  ["local_command_checkpoint_history", "recovery_id"],
  ["local_command_recovered_history_mutations", "mutation_id"],
] as const;
function hasTable(db: Sqlite.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function* recoveryRows(db: Sqlite.Database, table: string, order: string, deadline: number): Generator<Record<string, unknown>> {
  for (let offset = 0;; offset += 64) {
    checkInventoryDeadline(deadline);
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 64 OFFSET ?`).all(offset) as Record<string, unknown>[];
    checkInventoryDeadline(deadline);
    if (!rows.length) return;
    for (const row of rows) {
      checkInventoryDeadline(deadline);
      yield row;
    }
  }
}
function recoveryInventory(db: Sqlite.Database, deadline = inventoryDeadline()): string {
  const digest = createHash("sha256");
  for (const [table, order] of recoveryTables) {
    checkInventoryDeadline(deadline);
    digest.update(table);
    if (!hasTable(db, table)) { digest.update("absent"); continue; }
    for (const row of recoveryRows(db, table, order, deadline)) digest.update(canonicalCloudLocalCommandHistoryJson(row));
  }
  checkInventoryDeadline(deadline);
  return digest.digest("hex");
}

/** The older sealed file proves a floor. It must not replace newer FULL
 * identities, accepted ACKs, delete/edit heads or credential tombstones. */
function verifyRecoveryBaseline(ledger: Sqlite.Database, baseline: Sqlite.Database, deadline: number): void {
  const stableRows = [
    ["local_commands", "id", "id,conversation_id,writer_epoch,generation,user_message_id,agent_id,created_at"],
    ["local_command_operations", "id", "*"],
    ["local_command_writer_seals", "writer_epoch", "*"],
    ["local_credential_start_fences", "mutation_id", "*"],
    ["local_credential_control_operations", "request_id", "*"],
    ["local_credential_retirement_floors", "mutation_id,provider,credential_id", "*"],
    ["local_command_history_recovery_prepares", "writer_epoch", "*"],
    ["local_command_checkpoint_history", "recovery_id", "*"],
    ["local_command_recovered_history_mutations", "mutation_id", "*"],
  ] as const;
  for (const [table, keys, columns] of stableRows) {
    checkInventoryDeadline(deadline);
    if (!hasTable(baseline, table)) continue;
    if (!hasTable(ledger, table)) invalid("checkpoint_inventory_hash");
    for (let offset = 0;; offset += 64) {
      checkInventoryDeadline(deadline);
      const old = baseline.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${keys} LIMIT 64 OFFSET ?`).all(offset) as Record<string, unknown>[];
      checkInventoryDeadline(deadline);
      if (!old.length) break;
      for (const row of old) {
        checkInventoryDeadline(deadline);
        const key = keys.split(","), current = ledger.prepare(`SELECT ${columns} FROM ${table} WHERE ${key.map(name => `${name}=?`).join(" AND ")}`)
          .get(...key.map(name => row[name])) as Record<string, unknown> | undefined;
        if (!current) invalid("checkpoint_inventory_hash");
        for (const [column, value] of Object.entries(row)) {
          // The old ACK can be confirmed after capture; it cannot be forgotten.
          if (column === "ack_delivered" && Number(current[column]) >= Number(value)) continue;
          if (current[column] !== value) invalid("checkpoint_inventory_hash");
        }
      }
    }
  }
  for (const raw of recoveryRows(baseline, "local_command_history_heads", "conversation_id", deadline)) {
    const row = raw as { conversation_id: string; restore_revision: number; document: string };
    checkInventoryDeadline(deadline);
    const current = ledger.prepare("SELECT restore_revision,document FROM local_command_history_heads WHERE conversation_id=?")
      .get(row.conversation_id) as { restore_revision: number; document: string } | undefined;
    if (!current || current.restore_revision < row.restore_revision || current.restore_revision === row.restore_revision && current.document !== row.document)
      invalid("checkpoint_inventory_hash");
  }
  checkInventoryDeadline(deadline);
}

/** A prepared queue may advance a head to recovery_uncertain while parking
 * inherited work. It may never roll it behind an immutable edit/delete or
 * terminal-command receipt, even if NORMAL restore fences were lost. */
function verifyRecoveryHistoryFences(db: Sqlite.Database, deadline: number): void {
  const fence = (conversationId: unknown, document: unknown) => {
    checkInventoryDeadline(deadline);
    if (typeof conversationId !== "string" || typeof document !== "string" || Buffer.byteLength(document) > 64 * 1024)
      invalid("checkpoint_inventory_hash");
    const parsed = CloudLocalCommandHistoryHeadSchema.safeParse(json(document, "checkpoint_inventory_hash"));
    if (!parsed.success || canonicalCloudLocalCommandHistoryJson(parsed.data) !== document) invalid("checkpoint_inventory_hash");
    const current = db.prepare("SELECT restore_revision,document FROM local_command_history_heads WHERE conversation_id=?")
      .get(conversationId) as { restore_revision: number; document: string } | undefined;
    if (!current || current.restore_revision < parsed.data.history.restoreRevision ||
        current.restore_revision === parsed.data.history.restoreRevision && current.document !== document)
      invalid("checkpoint_inventory_hash");
  };
  for (const row of recoveryRows(db, "local_command_history_mutations", "mutation_id", deadline)) fence(row.conversation_id, row.history_head);
  for (const row of recoveryRows(db, "local_commands", "id", deadline))
    if (row.mirror_history_head !== null && row.mirror_history_head !== undefined) fence(row.conversation_id, row.mirror_history_head);
  checkInventoryDeadline(deadline);
}

function recoveryScope(db: Sqlite.Database, table: "local_command_metadata" | "local_credential_control_metadata", key: string): CloudAgentBootScope {
  const row = db.prepare(`SELECT value FROM ${table} WHERE key=?`).get(key) as { value: string } | undefined;
  const scope = CloudAgentBootScopeSchema.safeParse(row && json(row.value, "checkpoint_writer_scope"));
  if (!scope.success) invalid("checkpoint_writer_scope");
  return scope.data;
}
function storedRecoveryPrepare(db: Sqlite.Database, writerEpoch: string): z.infer<typeof recoveryPrepareSchema> {
  if (!hasTable(db, "local_command_history_recovery_prepares")) invalid("checkpoint_writer_scope");
  const row = db.prepare("SELECT document FROM local_command_history_recovery_prepares WHERE writer_epoch=?").get(writerEpoch) as { document: string } | undefined;
  if (!row || Buffer.byteLength(row.document) > 16 * 1024) invalid("checkpoint_writer_scope");
  const parsed = recoveryPrepareSchema.safeParse(json(row.document, "checkpoint_writer_scope"));
  if (!parsed.success || parsed.data.scope.writerEpoch !== writerEpoch || canonicalCloudLocalCommandHistoryJson(parsed.data) !== row.document)
    invalid("checkpoint_writer_scope");
  return parsed.data;
}

function priorHistoryScope(source: CloudAgentBootScope, target: CloudAgentBootScope): boolean {
  return source.organizationId === target.organizationId && source.workspaceId === target.workspaceId &&
    source.writerEpoch !== target.writerEpoch && source.engineInstanceId !== target.engineInstanceId &&
    source.generation <= target.generation && source.fundingOwnerEpoch <= target.fundingOwnerEpoch;
}

/** The root is supplied by fresh CP authority, or by an acknowledged seal
 * covering these exact rows. No unanchored prepare can authorize history. */
function recoveryHistoryChain(db: Sqlite.Database, target: CloudAgentBootScope,
  anchor: NonNullable<CloudAgentHistoryRecoveryResponse["predecessorRecovery"]>, deadline: number,
  origins: Map<string, HistoryOrigin>): void {
  const seen = new Set<string>();
  for (let count = 0;; count++) {
    checkInventoryDeadline(deadline);
    if (count >= 4096 || seen.has(target.writerEpoch)) invalid("checkpoint_writer_scope");
    seen.add(target.writerEpoch);
    const record = storedRecoveryPrepare(db, target.writerEpoch);
    if (!isDeepStrictEqual(record.scope, target) || record.recoveryId !== anchor.recoveryId ||
        hash(canonicalCloudLocalCommandHistoryJson(record)) !== anchor.custodySha256 || !priorHistoryScope(record.predecessor, target))
      invalid("checkpoint_inventory_hash");
    const origin = Object.freeze({ scope: Object.freeze({ ...record.predecessor }), ...record.history });
    const previous = origins.get(origin.scope.writerEpoch);
    if (previous && !isDeepStrictEqual(previous, origin)) invalid("checkpoint_inventory_hash");
    origins.set(origin.scope.writerEpoch, origin);
    if (record.checkpointOnly) {
      const check=()=>checkInventoryDeadline(deadline);
      const proof = checkpointHistoryMarker(db, record.predecessor.writerEpoch,check);
      if (!proof || proof.recoveryId !== record.recoveryId || !sameRecoveryTarget(proof, record.scope) ||
          proof.checkpointOnly?.sha256 !== record.checkpointOnly.sha256 || proof.checkpointOnly.ownerDiscardReceiptId !== record.checkpointOnly.ownerDiscardReceiptId ||
          proof.checkpointOnly.checkpointId !== record.checkpointOnly.checkpointId) invalid("checkpoint_inventory_hash");
      for (const retained of parseCheckpointHistory(proof,check).origins) {
        check();
        const prior = origins.get(retained.scope.writerEpoch);
        if (prior && (!isDeepStrictEqual(prior.scope, retained.scope) || prior.recordSequence < retained.recordSequence || prior.eventSequence < retained.eventSequence))
          invalid("checkpoint_inventory_hash");
        if (!prior) origins.set(retained.scope.writerEpoch, Object.freeze(retained));
      }
    }
    if (origins.size > 4096) invalid("checkpoint_writer_scope");
    checkInventoryDeadline(deadline);
    if (!record.predecessorRecovery) return;
    target = record.predecessor; anchor = record.predecessorRecovery;
  }
}

/** Later normal restores can retain an unsealed mutation origin only through
 * an acknowledged successor's inventory. Prepared, never-activated writers
 * without a seal are skipped; an authenticated hash link may still name one
 * that CP explicitly committed on an earlier activated recovery. */
export function verifiedCloudLocalCommandSealedHistoryOrigins(db: Sqlite.Database,
  seal: CloudLocalCommandWriterSeal): readonly HistoryOrigin[] {
  return sealedHistoryOrigins(db, seal, inventoryDeadline());
}
function sealedHistoryOrigins(db: Sqlite.Database, seal: CloudLocalCommandWriterSeal, deadline: number): readonly HistoryOrigin[] {
  checkInventoryDeadline(deadline);
  const present = hasTable(db, "local_command_history_recovery_prepares") &&
    !!db.prepare("SELECT 1 FROM local_command_history_recovery_prepares LIMIT 1").get();
  checkInventoryDeadline(deadline);
  if (!present) return [];
  verifyLedger(db, seal, deadline);
  const origins = new Map<string, HistoryOrigin>();
  let count = 0;
  for (const row of recoveryRows(db, "local_command_history_recovery_prepares", "writer_epoch", deadline)) {
    if (++count > 4096 || typeof row.writer_epoch !== "string") invalid("checkpoint_writer_scope");
    const record = storedRecoveryPrepare(db, row.writer_epoch);
    const stored = db.prepare("SELECT document,ack FROM local_command_writer_seals WHERE writer_epoch=?").get(row.writer_epoch) as
      { document: string; ack: string | null } | undefined;
    if (!stored?.ack) continue;
    const ancestor = CloudLocalCommandWriterSealSchema.safeParse(json(stored.document, "checkpoint_seal_document"));
    const ack = CloudLocalCommandWriterSealAckSchema.safeParse(json(stored.ack, "checkpoint_seal_ack"));
    if (!ancestor.success || !ack.success || !isDeepStrictEqual(ancestor.data.scope, record.scope) ||
        hash(canonicalCloudLocalCommandWriterSealDescriptor(ancestor.data)) !== ancestor.data.sha256 ||
        !cloudLocalCommandWriterSealAckMatchesSeal(ack.data, ancestor.data) ||
        record.scope.writerEpoch !== seal.scope.writerEpoch && !priorHistoryScope(record.scope, seal.scope)) invalid("checkpoint_seal_ack");
    recoveryHistoryChain(db, record.scope, { recoveryId: record.recoveryId,
      custodySha256: hash(canonicalCloudLocalCommandHistoryJson(record)) }, deadline, origins);
  }
  checkInventoryDeadline(deadline);
  return Object.freeze([...origins.values()]);
}

/** At most the two observed namespaces may be offered for CP verification.
 * No hint chooses the history source or authorizes an older checkpoint. */
export async function cloudLocalCommandHistoryRecoveryCustody(file: string, expectedWriterEpoch: string):
  Promise<NonNullable<CloudAgentHistoryRecoveryRequest["preparedCustody"]> | null> {
  try {
    if (await absentRecoveryLedger(file)) return null;
    const { handle, before } = await readHandle(file, MAX_BYTES);
    try {
      const db = openSqlite(file, { readonly: true, fileMustExist: true });
      try {
        const result = db.transaction(() => {
          const deadline=inventoryDeadline();
          if (checkpointHistoryMarker(db, expectedWriterEpoch,()=>checkInventoryDeadline(deadline))) return null;
          const epochs = new Set([recoveryScope(db, "local_command_metadata", "writer").writerEpoch,
            recoveryScope(db, "local_credential_control_metadata", "scope").writerEpoch]);
          epochs.delete(expectedWriterEpoch);
          return [...epochs].sort().map(writerEpoch => ({ writerEpoch, recoveryId: storedRecoveryPrepare(db, writerEpoch).recoveryId }));
        })();
        if (!stable(before, await handle.stat()) || !stable(before, await fs.lstat(file))) invalid("checkpoint_restore_identity");
        return result;
      } finally { db.close(); }
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof CloudCommandRuntimeError) throw error;
    invalid("checkpoint_restore_read");
  }
}

/** These bytes may not change during a prepared, never-activated cutover.
 * Namespace retirement and queued -> uncertain are allowed; accepted IDs,
 * credential ACKs/floors, mutation fences, source journal and content stay. */
function retainedRecoveryFingerprint(db: Sqlite.Database, sourceWriter: string, deadline: number): string {
  const digest = createHash("sha256");
  const selections = [
    ["local_commands", "id", "id,conversation_id,writer_epoch,generation,user_message_id,agent_id,created_at,mirror_history_head"],
    ["local_command_operations", "id", "*"], ["local_command_writer_seals", "writer_epoch", "*"],
    ["local_credential_start_fences", "mutation_id", "mutation_id,identity_sha256,selectors,fence_epoch,phase,desired_revision,proof_id"],
    ["local_credential_control_operations", "request_id", "request_id,request_sha256,acknowledgement,ack_bytes,ack_delivered"],
    ["local_credential_retirement_floors", "mutation_id,provider,credential_id", "mutation_id,provider,credential_id,cache_revision,connection_revision"],
    ["local_command_history_mutations", "mutation_id", "*"], ["local_command_history_documents", "sha256", "*"],
    ["local_command_recovered_history_mutations", "mutation_id", "*"],
    ["local_command_history_limits", "conversation_id,sha256", "*"],
    ["local_command_journal", "writer_epoch,sequence", "*"], ["local_command_mirror_batches", "writer_epoch", "*"],
  ] as const;
  for (const [table, order, columns] of selections) {
    checkInventoryDeadline(deadline);
    digest.update(table);
    if (!hasTable(db, table)) { digest.update("absent"); continue; }
    const journal = table === "local_command_journal" || table === "local_command_mirror_batches";
    for (let offset = 0;; offset += 64) {
      checkInventoryDeadline(deadline);
      const rows = db.prepare(`SELECT ${columns} FROM ${table} ${journal ? "WHERE writer_epoch=?" : ""} ORDER BY ${order} LIMIT 64 OFFSET ?`)
        .all(...(journal ? [sourceWriter, offset] : [offset]));
      checkInventoryDeadline(deadline);
      if (!rows.length) break;
      for (const row of rows) {
        checkInventoryDeadline(deadline);
        digest.update(canonicalCloudLocalCommandHistoryJson(row));
      }
    }
  }
  checkInventoryDeadline(deadline);
  return digest.digest("hex");
}

function verifyPreparedRecoveryCustody(db: Sqlite.Database, authorization: CloudAgentHistoryRecoveryResponse,
  scope: CloudAgentBootScope, fingerprint: string): Extract<RecoveryCustody, { mirrorHead: number }> | null {
  if (isDeepStrictEqual(scope, authorization.predecessor)) return null;
  const allowed = authorization.preparedCustody?.find(item => isDeepStrictEqual(item.scope, scope));
  if (!allowed || scope.organizationId !== authorization.organizationId || scope.workspaceId !== authorization.workspaceId ||
      scope.engineInstanceId === authorization.engineInstanceId || scope.generation > authorization.generation ||
      scope.fundingOwnerUserId !== authorization.fundingOwnerUserId || scope.fundingOwnerEpoch !== authorization.fundingOwnerEpoch)
    invalid("checkpoint_writer_scope");
  const prepare = storedRecoveryPrepare(db, scope.writerEpoch);
  if (prepare.checkpointOnly || prepare.mirrorHead === undefined || prepare.journalHead === undefined ||
      prepare.recoveryId !== allowed.recoveryId || !isDeepStrictEqual(prepare.scope, scope) ||
      !isDeepStrictEqual(prepare.predecessor, authorization.predecessor) || !isDeepStrictEqual(prepare.checkpoint, authorization.checkpoint) ||
      !isDeepStrictEqual(prepare.predecessorRecovery, authorization.predecessorRecovery) ||
      prepare.mirroredSequence !== authorization.mirroredSequence || prepare.retainedSha256 !== fingerprint)
    invalid("checkpoint_inventory_hash");
  return { mirrorHead: prepare.mirrorHead, journalHead: prepare.journalHead, retainedSha256: prepare.retainedSha256 };
}

function verifyRecoveryJournal(db: Sqlite.Database, source: string, mirrorHead: number, journalHead: number): void {
  const row = db.prepare("SELECT count(*) n,min(sequence) first,max(sequence) last FROM local_command_journal WHERE writer_epoch=?")
    .get(source) as { n: number; first: number | null; last: number | null };
  if (journalHead < mirrorHead || row.n !== journalHead - mirrorHead ||
      row.n > 0 && (row.first !== mirrorHead + 1 || row.last !== journalHead)) invalid("checkpoint_journal_head");
}

async function absentRecoveryLedger(file: string): Promise<boolean> {
  try { await fs.lstat(file); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { await fs.lstat(file + suffix); invalid("checkpoint_restore_identity"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return true;
}

async function recoverCheckpointOnlyLedger(input: {
  file: string; assertCurrent?(): void;
  scope: Pick<CloudAgentBootScope, "organizationId" | "workspaceId" | "generation" | "engineInstanceId" | "bootId">;
}, verified: Awaited<ReturnType<typeof verifyCloudLocalCommandCheckpoint>>, authorization: CloudAgentHistoryRecoveryResponse) {
  if (!input.assertCurrent || !authorization.checkpointOnly || authorization.preparedCustody?.length) invalid("checkpoint_writer_scope");
  const deadline=inventoryDeadline();
  const current=()=>{input.assertCurrent!();checkInventoryDeadline(deadline);}, file=path.resolve(input.file), parent=path.dirname(file);
  const parsed=parseCheckpointHistory(authorization,current);
  if (!parsed.origins.some(item=>isDeepStrictEqual(item.scope,verified.manifest.seal.scope))) invalid("checkpoint_writer_scope");
  current();
  if (await absentRecoveryLedger(file)) {
    current(); await fs.mkdir(parent,{recursive:true,mode:0o700}); current(); await directory(parent); current();
    const temporary=path.join(parent,`.checkpoint-history-${randomUUID()}`);
    try {
      const transcript=verifiedTranscriptPairs.get(verified);
      if(!transcript) invalid("checkpoint_restore_identity");
      unchangedTranscriptFile(transcript.ledgerFile,transcript.ledger);
      const baseline=openSqlite(verified.ledgerFile,{readonly:true,fileMustExist:true});
      let baselineInventory:string;
      try {baselineInventory=recoveryInventory(baseline,deadline);} finally {baseline.close();}
      unchangedTranscriptFile(transcript.ledgerFile,transcript.ledger); current();
      await fs.copyFile(verified.ledgerFile,temporary,constants.COPYFILE_EXCL); current();
      unchangedTranscriptFile(transcript.ledgerFile,transcript.ledger);
      const copied=await readHandle(temporary,MAX_BYTES); current();
      try {
        const digest=createHash("sha256");
        for(let offset=0;offset<copied.before.size;offset+=PART_BYTES) {
          const bytes=Buffer.alloc(Math.min(PART_BYTES,copied.before.size-offset)); let consumed=0;
          while(consumed<bytes.length) {
            const read=await copied.handle.read(bytes,consumed,bytes.length-consumed,offset+consumed); current();
            if(!read.bytesRead) invalid("checkpoint_restore_read"); consumed+=read.bytesRead;
          }
          digest.update(bytes);
        }
        if(copied.before.size!==verified.manifest.files[0].bytes || digest.digest("hex")!==verified.manifest.files[0].sha256)
          invalid("checkpoint_restore_hash");
      } finally { await copied.handle.close(); }
      current();
      const db=openSqlite(temporary,{fileMustExist:true});
      try {
        db.pragma("journal_mode = DELETE"); db.pragma("synchronous = FULL");
        // Verify the actual SQLite reader after opening it, as well as the
        // copied bytes. No changed native custody may enter the CP projection.
        verifyLedger(db,verified.manifest.seal,deadline); current();
        if(recoveryInventory(db,deadline)!==baselineInventory)invalid("checkpoint_inventory_hash"); current();
        importCheckpointHistory(db,authorization,current);
      } finally { db.close(); }
      const durable=await fs.open(temporary,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try { await durable.sync(); current(); } finally { await durable.close(); }
      if(!await absentRecoveryLedger(file)) invalid("checkpoint_restore_identity"); current();
      // Atomic no-replace publication. A racing file or sidecar never gets
      // overwritten, and a crash retains the exact CP marker for fresh auth.
      await fs.link(temporary,file); current(); await fs.unlink(temporary); current(); await syncDirectory(parent); current();
    } finally { await fs.rm(temporary,{force:true}); }
  }
  current();
  const {handle,before}=await readHandle(file,MAX_BYTES); current();
  try {
    const db=openSqlite(file,{readonly:true,fileMustExist:true});
    try {
      const state=db.transaction(()=>{
        const snapshot=verifyCheckpointHistoryImport(db,authorization,current);
        const writer=recoveryScope(db,"local_command_metadata","writer");
        const credentialScope=hasTable(db,"local_credential_control_metadata")?
          recoveryScope(db,"local_credential_control_metadata","scope"):verified.manifest.seal.scope;
        for(const scope of [writer,credentialScope]) {
          if(isDeepStrictEqual(scope,verified.manifest.seal.scope)) continue;
          const prepare=storedRecoveryPrepare(db,scope.writerEpoch);
          if(!sameRecoveryTarget(authorization,scope) || prepare.recoveryId!==authorization.recoveryId ||
            !isDeepStrictEqual(prepare.scope,scope) || prepare.checkpointOnly?.sha256!==authorization.checkpointOnly!.sha256)
            invalid("checkpoint_writer_scope");
        }
        verifyRecoveryHistoryFences(db,deadline);
        const bounds={recordSequence:Math.max(verified.manifest.seal.recordSequence,...snapshot.origins.map(item=>item.recordSequence)),
          eventSequence:Math.max(verified.manifest.seal.eventSequence,...snapshot.origins.map(item=>item.eventSequence))};
        return {credentialScope:Object.freeze({...credentialScope}),inventory:recoveryInventory(db,deadline),
          custody:{retainedSha256:retainedRecoveryFingerprint(db,authorization.predecessor.writerEpoch,deadline),checkpointOnly:{
            ownerDiscardReceiptId:authorization.checkpointOnly!.ownerDiscardReceiptId,checkpointId:authorization.checkpointOnly!.checkpointId,
            sha256:authorization.checkpointOnly!.sha256}},
          history:Object.freeze({scope:Object.freeze({...authorization.predecessor}),...bounds,origins:Object.freeze(snapshot.origins)})};
      })();
      if(!stable(before,await handle.stat()) || !stable(before,await fs.lstat(file))) invalid("checkpoint_restore_identity"); current();
      const predecessor=Object.freeze({scope:state.history.scope});
      recoveredPredecessors.set(predecessor,{file,dev:before.dev,ino:before.ino,authorization,...state});
      return {...verified,ledgerFile:file,predecessor};
    } finally { db.close(); }
  } finally { await handle.close(); }
}

/** Called only after strict restore names incomplete predecessor custody and
 * the authenticated CP explicitly authorizes this exact unsealed source.
 * The surviving FULL ledger stays in place, including WAL and every ACK.
 * Missing/corrupt custody never falls back to copying the older sealed file. */
export async function recoverCloudLocalCommandCheckpointLedger(input: {
  root: string; file: string; expectedWriterEpoch: string;
  scope: Pick<CloudAgentBootScope, "organizationId" | "workspaceId" | "generation" | "engineInstanceId" | "bootId">;
  authorization: CloudAgentHistoryRecoveryResponse;
  assertCurrent?(): void;
}): Promise<Awaited<ReturnType<typeof verifyCloudLocalCommandCheckpoint>> & { predecessor: CloudLocalCommandPredecessor }> {
  const parsed = CloudAgentHistoryRecoveryResponseSchema.safeParse(input.authorization);
  if (!parsed.success || !sameRecoveryTarget(parsed.data, input.scope) ||
      parsed.data.predecessor.writerEpoch !== input.expectedWriterEpoch ||
      parsed.data.predecessor.organizationId !== input.scope.organizationId || parsed.data.predecessor.workspaceId !== input.scope.workspaceId ||
      parsed.data.predecessor.engineInstanceId === input.scope.engineInstanceId || parsed.data.predecessor.generation > input.scope.generation ||
      parsed.data.predecessor.fundingOwnerEpoch > parsed.data.fundingOwnerEpoch) invalid("checkpoint_expected_writer_mismatch");
  const authorization = parsed.data;
  const verified = await verifyCloudLocalCommandCheckpoint({ ...input, expectedWriterEpoch: authorization.checkpoint.writerEpoch });
  const file = path.resolve(input.file);
  try {
    if (verified.manifest.seal.sha256 !== authorization.checkpoint.sha256) invalid("checkpoint_seal_document");
    input.assertCurrent?.();
    if (authorization.checkpointOnly) return await recoverCheckpointOnlyLedger(input, verified, authorization);
    const { handle, before } = await readHandle(file, MAX_BYTES);
    try {
      const deadline = inventoryDeadline();
      const ledger = openSqlite(file, { readonly: true, fileMustExist: true });
      const baseline = openSqlite(verified.ledgerFile, { readonly: true, fileMustExist: true });
      try {
        const state = ledger.transaction(() => {
          const metadata = (key: string) => (ledger.prepare("SELECT value FROM local_command_metadata WHERE key=?").get(key) as { value: string } | undefined)?.value;
          const writer = recoveryScope(ledger, "local_command_metadata", "writer");
          const credentialScope = recoveryScope(ledger, "local_credential_control_metadata", "scope");
          const retainedSha256 = retainedRecoveryFingerprint(ledger, authorization.predecessor.writerEpoch, deadline);
          const commandCustody = verifyPreparedRecoveryCustody(ledger, authorization, writer, retainedSha256);
          const credentialCustody = verifyPreparedRecoveryCustody(ledger, authorization, credentialScope, retainedSha256);
          const observed = new Set([writer.writerEpoch, credentialScope.writerEpoch]); observed.delete(authorization.predecessor.writerEpoch);
          if ((authorization.preparedCustody ?? []).some(item => !observed.has(item.scope.writerEpoch)) ||
              commandCustody && !credentialCustody || commandCustody && credentialCustody && !isDeepStrictEqual(commandCustody, credentialCustody))
            invalid("checkpoint_writer_scope");
          const counter = (key: string) => {
            const value = metadata(key) ?? "0";
            if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) invalid("checkpoint_journal_head");
            return Number(value);
          };
          // A lost mirror ACK is valid: its still-persisted journal may cover
          // the CP floor. Never require the engine to invent an ACK or erase it.
          const custody = commandCustody ?? { mirrorHead: counter("mirrorHead"), journalHead: counter("journalHead"), retainedSha256 };
          if (custody.mirrorHead > authorization.mirroredSequence || custody.journalHead < authorization.mirroredSequence ||
              credentialCustody && !isDeepStrictEqual(custody, credentialCustody))
            invalid("checkpoint_mirror_head");
          verifyRecoveryJournal(ledger, authorization.predecessor.writerEpoch, custody.mirrorHead, custody.journalHead);
          const seal = ledger.prepare("SELECT ack FROM local_command_writer_seals WHERE writer_epoch=?")
            .get(authorization.predecessor.writerEpoch) as { ack: string | null } | undefined;
          if (seal?.ack) invalid("checkpoint_seal_ack");
          verifyRecoveryBaseline(ledger, baseline, deadline);
          verifyRecoveryHistoryFences(ledger, deadline);
          const origins = new Map(sealedHistoryOrigins(baseline, verified.manifest.seal, deadline)
            .map(origin => [origin.scope.writerEpoch, origin]));
          if (authorization.predecessorRecovery) recoveryHistoryChain(ledger, authorization.predecessor,
            authorization.predecessorRecovery, deadline, origins);
          else if (hasTable(ledger, "local_command_history_recovery_prepares") &&
              ledger.prepare("SELECT 1 FROM local_command_history_recovery_prepares WHERE writer_epoch=?").get(authorization.predecessor.writerEpoch))
            invalid("checkpoint_writer_scope");
          let recordSequence = verified.manifest.seal.recordSequence, eventSequence = verified.manifest.seal.eventSequence;
          for (const row of recoveryRows(ledger, "local_command_history_heads", "conversation_id", deadline)) {
            const head = CloudLocalCommandHistoryHeadSchema.parse(json(String(row.document), "checkpoint_inventory_hash"));
            recordSequence = Math.max(recordSequence, head.history.recordSequence ?? 0);
            eventSequence = Math.max(eventSequence, head.history.eventSequence ?? 0);
          }
          return { inventory: recoveryInventory(ledger, deadline), custody, credentialScope: Object.freeze(credentialScope),
            history: Object.freeze({ scope: Object.freeze({ ...authorization.predecessor }), recordSequence, eventSequence,
              origins: Object.freeze([...origins.values()]) }) };
        })();
        if (!stable(before, await handle.stat()) || !stable(before, await fs.lstat(file))) invalid("checkpoint_restore_identity");
        checkInventoryDeadline(deadline);
        const predecessor = Object.freeze({ scope: state.history.scope });
        recoveredPredecessors.set(predecessor, { file, dev: before.dev, ino: before.ino, authorization, ...state });
        return { ...verified, ledgerFile: file, predecessor };
      } finally { baseline.close(); ledger.close(); }
    } finally { await handle.close(); }
  } catch (error) {
    await verified.cleanup();
    if (error instanceof CloudCommandRuntimeError) throw error;
    invalid("checkpoint_restore_read");
  }
}
