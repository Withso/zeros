import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type Sqlite from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { canonicalCloudLocalCommandHistoryJson, CloudLocalCommandWriterSealSchema, CloudLocalCommandWriterSealAckSchema,
  cloudLocalCommandWriterSealAckMatchesSeal, type CloudLocalCommandWriterSeal, type CloudLocalCommandWriterSealAck } from "@zeros/protocol/cloud-local-mirror";
import { CloudCommandRuntimeError } from "./cloud-command-client";
import { isCloudLocalCommandQueue, type CloudLocalCommandQueue } from "./cloud-local-command-queue";
import { openSqlite } from "./db/sqlite";
import { captureCloudLocalCommandCheckpoint, cloudLocalCommandSealInventory, type CloudLocalCommandCheckpointManifest } from "./cloud-local-command-queue-checkpoint";

/** Separate from source retirement: an acknowledged seal proves only the
 * frozen, drained projection of this original FULL writer. CP may replace it
 * only after its independently verified native/provider retirement proof. */
export class CloudLocalCommandWriterLifecycle {
  private readonly db: Sqlite.Database;
  private closed = false;
  private normalFile: string | null = null;
  private frozenSealHash: string | null = null;
  constructor(private readonly options: { file: string; queue: CloudLocalCommandQueue; normalDb(): Sqlite.Database;
    heads(normal?: Sqlite.Database): { recordSequence: number; eventSequence: number }; assertQuiescent(): void }) {
    if (!isCloudLocalCommandQueue(options.queue) || !options.queue.ownsDatabase(options.file))
      throw new CloudCommandRuntimeError("engine_authority_rejected");
    this.db = openSqlite(options.file,{ fileMustExist: true });
    try {
      this.db.pragma("synchronous = FULL"); this.db.pragma("busy_timeout = 25"); this.assertLive();
      this.db.exec("CREATE TABLE IF NOT EXISTS local_command_writer_seals(writer_epoch TEXT PRIMARY KEY,document TEXT NOT NULL,ack TEXT)");
    } catch (error) { this.db.close(); throw error; }
  }
  private assertLive(): void {
    if (this.closed || !this.options.queue.ownsDatabase(this.options.file)) throw new CloudCommandRuntimeError("engine_authority_rejected");
    this.options.queue.durability();
    const writer = this.db.prepare("SELECT value FROM local_command_metadata WHERE key='writer'").get() as { value: string };
    if (!writer || !isDeepStrictEqual(JSON.parse(writer.value),this.options.queue.scope))
      throw new CloudCommandRuntimeError("engine_authority_rejected");
  }
  begin(): void { this.assertLive(); this.options.queue.fenceAcceptance(); }
  get seal(): CloudLocalCommandWriterSeal | null {
    this.assertLive(); const row = this.db.prepare("SELECT document FROM local_command_writer_seals WHERE writer_epoch=?").get(this.options.queue.scope.writerEpoch) as { document: string } | undefined;
    return row ? CloudLocalCommandWriterSealSchema.parse(JSON.parse(row.document)) : null;
  }
  get acknowledged(): boolean {
    this.assertLive(); return !!this.db.prepare("SELECT 1 FROM local_command_writer_seals WHERE writer_epoch=? AND ack IS NOT NULL").get(this.options.queue.scope.writerEpoch);
  }
  private exists(table: string, predicate: string, ...parameters: string[]): boolean {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return false;
    return !!this.db.prepare(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`).get(...parameters);
  }
  private checkpointNormal(): void {
    const normal = this.options.normalDb();
    try {
      const main = (normal.prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find(value => value.name === "main");
      if (!main?.file || normal.inTransaction || (normal.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode !== "wal")
        throw new Error();
      const file = realpathSync(main.file);
      if (this.normalFile && this.normalFile !== file) throw new Error();
      this.normalFile = file;
      const previous = (normal.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
      try {
        // The synchronous boundary is bounded; a lock must not freeze Stop or
        // all bridge I/O for the NORMAL database's usual five-second timeout.
        normal.pragma("busy_timeout = 25");
        const proof = normal.prepare("PRAGMA main.wal_checkpoint(FULL)").get() as { busy: number; log: number; checkpointed: number };
        if (!proof || proof.busy !== 0 || !Number.isSafeInteger(proof.log) || proof.log < 0 || proof.checkpointed !== proof.log) throw new Error();
      } finally { normal.pragma(`busy_timeout = ${previous}`); }
    } catch { throw new CloudCommandRuntimeError("command_storage_unavailable"); }
  }
  private assertFrozenHead(seal: CloudLocalCommandWriterSeal): void {
    this.options.assertQuiescent();
    if (!this.normalFile) throw new CloudCommandRuntimeError("command_storage_unavailable");
    // A successful freeze closes the engine's NORMAL handle. Read its exact
    // file without reopening the writer; an old descriptor is never evidence
    // that a failed freeze or a later callback left the same source head.
    const normal = openSqlite(this.normalFile, { readonly: true, fileMustExist: true });
    try {
      normal.pragma("busy_timeout = 25");
      const heads = this.options.heads(normal);
      if (heads.recordSequence !== seal.recordSequence || heads.eventSequence !== seal.eventSequence)
        throw new CloudCommandRuntimeError("command_conflict");
    } finally { normal.close(); }
  }
  createSeal(): CloudLocalCommandWriterSeal {
    this.assertLive(); const previous = this.seal; if (previous) return previous;
    if (this.options.queue.accepting || !this.options.queue.mirrorDrained()) throw new CloudCommandRuntimeError("command_conflict");
    this.options.assertQuiescent(); this.checkpointNormal();
    return this.db.transaction(() => {
      this.assertLive(); this.options.assertQuiescent();
      const scope = this.options.queue.scope, heads = this.options.heads();
      const values = this.db.prepare("SELECT key,value FROM local_command_metadata WHERE key IN ('journalHead','mirrorHead')").all() as { key: string; value: string }[];
      const read = (key: string) => Number(values.find(value => value.key === key)?.value ?? "0");
      const sequence = read("journalHead");
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence !== read("mirrorHead") || !this.options.queue.mirrorDrained() ||
          this.exists("local_command_mirror_batches","writer_epoch=?",scope.writerEpoch) ||
          this.exists("local_commands","writer_epoch=? AND state IN ('queued','dispatching')",scope.writerEpoch) ||
          this.exists("local_command_actions","writer_epoch=? AND state='dispatching'",scope.writerEpoch) ||
          this.exists("local_command_control_owners","settled=0 AND command_id IN (SELECT id FROM local_commands WHERE writer_epoch=?)",scope.writerEpoch))
        throw new CloudCommandRuntimeError("command_conflict");
      const stream = this.db.prepare("SELECT head FROM local_command_streams WHERE stream_id=? AND writer_epoch=?").get(scope.engineInstanceId,scope.writerEpoch) as { head: number } | undefined;
      if (!stream || stream.head !== heads.eventSequence || !Number.isSafeInteger(heads.recordSequence) || heads.recordSequence < 0)
        throw new CloudCommandRuntimeError("command_conflict");
      const inventorySha256 = cloudLocalCommandSealInventory(this.db, { scope,sequence,...heads });
      const descriptor = { version: 1 as const, scope,sealId: randomUUID(),sequence,...heads,inventorySha256 };
      const sha256 = createHash("sha256").update(canonicalCloudLocalCommandHistoryJson(descriptor)).digest("hex");
      const seal = CloudLocalCommandWriterSealSchema.parse({ ...descriptor,sha256 });
      this.db.prepare("INSERT INTO local_command_writer_seals VALUES(?,?,NULL)").run(scope.writerEpoch,canonicalCloudLocalCommandHistoryJson(seal));
      this.db.prepare("INSERT INTO local_command_metadata(key,value) VALUES('sealedWriter',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(scope.writerEpoch);
      return seal;
    })();
  }
  acknowledge(input: CloudLocalCommandWriterSealAck): void {
    this.assertLive(); const seal = this.seal, parsed = CloudLocalCommandWriterSealAckSchema.safeParse(input);
    if (!seal || !parsed.success || !cloudLocalCommandWriterSealAckMatchesSeal(parsed.data,seal)) throw new CloudCommandRuntimeError("command_response_invalid");
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT ack FROM local_command_writer_seals WHERE writer_epoch=?").get(seal.scope.writerEpoch) as { ack: string | null };
      const bytes = canonicalCloudLocalCommandHistoryJson(parsed.data);
      if (row.ack && row.ack !== bytes) throw new CloudCommandRuntimeError("command_response_invalid");
      if (row.ack === bytes) return;
      this.db.prepare("UPDATE local_command_writer_seals SET ack=? WHERE writer_epoch=?").run(bytes,seal.scope.writerEpoch);
    })();
  }
  async captureCheckpoint(root: string): Promise<CloudLocalCommandCheckpointManifest> {
    this.assertLive(); const seal = this.seal;
    if (!seal || !this.acknowledged || this.frozenSealHash !== seal.sha256 || !this.normalFile)
      throw new CloudCommandRuntimeError("command_conflict");
    this.assertFrozenHead(seal);
    const proof = this.db.prepare("PRAGMA main.wal_checkpoint(FULL)").get() as { busy: number; log: number; checkpointed: number };
    if (this.db.inTransaction || proof?.busy !== 0 || !Number.isSafeInteger(proof.log) || proof.log < 0 || proof.log !== proof.checkpointed)
      throw new CloudCommandRuntimeError("command_storage_unavailable");
    return captureCloudLocalCommandCheckpoint({ root, ledgerFile: this.options.file, normalFile: this.normalFile, seal,
      assertFrozen: () => {
        this.assertLive();
        if (!this.acknowledged || this.seal?.sha256 !== seal.sha256 || !this.options.queue.mirrorDrained())
          throw new CloudCommandRuntimeError("command_conflict");
        this.assertFrozenHead(seal);
      } });
  }
  async drainAndSeal(options: { mirror: { flush(input?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void> };
    retireNative(): Promise<void>; waitForWork(): Promise<void>; freezeNormal(): void;
    request(seal: CloudLocalCommandWriterSeal, signal: AbortSignal): Promise<unknown>; timeoutMs?: number }): Promise<void> {
    this.begin();
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new CloudCommandRuntimeError("command_conflict");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const wait = <T>(flight: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const failed = () => { cleanup(); reject(new CloudCommandRuntimeError("command_service_unavailable")); };
      const cleanup = () => controller.signal.removeEventListener("abort", failed);
      if (controller.signal.aborted) { void flight.catch(() => {}); failed(); return; }
      controller.signal.addEventListener("abort", failed, { once: true });
      flight.then(value => { cleanup(); if (controller.signal.aborted) failed(); else resolve(value); }, error => { cleanup(); reject(error); });
    });
    try {
      let seal = this.seal;
      if (!seal) {
        await wait(options.retireNative()); await wait(options.waitForWork());
        await wait(options.mirror.flush({ signal: controller.signal, timeoutMs }));
        if (controller.signal.aborted) throw new CloudCommandRuntimeError("command_service_unavailable");
        seal = this.createSeal();
      }
      // The FULL descriptor may have committed before freezeNormal failed.
      // Re-establish quiescence, durability and current heads before retrying
      // that immutable descriptor. A known successful freeze needs no writer
      // reopen, but its current file/head proof is still checked every time.
      this.options.assertQuiescent();
      if (this.frozenSealHash !== seal.sha256) this.checkpointNormal();
      this.assertFrozenHead(seal);
      options.freezeNormal(); this.frozenSealHash = seal.sha256;
      if (!this.acknowledged) {
        const reply = CloudLocalCommandWriterSealAckSchema.parse(await wait(options.request(seal,controller.signal)));
        this.assertFrozenHead(seal);
        this.acknowledge(reply);
      }
    } finally { clearTimeout(timer); }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
