import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Sqlite from "better-sqlite3";
import { CloudActorProvenanceSchema, type CloudAgentBootScope, type CloudActorProvenance } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudAcceptedWorkCommandSchema, CloudAcceptedWorkReceiptSchema, type CloudAcceptedWorkCommand, type CloudAcceptedWorkReceipt } from "@zeros/protocol/cloud-accepted-work";
import { CloudBootCommandMutationSchema, type CloudBootCommandMutation, type CloudBootCommandSnapshot } from "@zeros/protocol/cloud-commands";

export type AcceptedReservationInput = { mutation: CloudBootCommandMutation; actorSessionId: string; cwd: string; executionId: string;
  capabilityId: string; kid: string; capabilityExpiresAtMs: number };
export type AcceptedReservation = { command: CloudAcceptedWorkCommand; actor: CloudActorProvenance;
  capabilityId: string; kid: string; capabilityExpiresAtMs: number; receipt: CloudAcceptedWorkReceipt | null; state: "reserved" | "accepted" | "closed" };
export type AcceptedLedgerOptions = { scope: Readonly<CloudAgentBootScope>; now(): number; canonical(value: unknown): string;
  assertCurrent(): void;
  prepare(mutation: CloudBootCommandMutation, actorSessionId: string): CloudActorProvenance;
  commit(mutation: CloudBootCommandMutation, actor: CloudActorProvenance): CloudBootCommandSnapshot;
  snapshot(conversationId: string): CloudBootCommandSnapshot; retire(commandId: string): void;
  pendingLimit: number; commandLimit: number; changed?(): void };
type Row = { id: string; writer_epoch: string; request_sha256: string; reservation: string; mutation: string | null;
  receipt: string | null; state: AcceptedReservation["state"] };
function reject(): never { throw new Error("accepted_work_rejected"); }
function conflict(): never { throw new Error("accepted_work_conflict"); }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Uses the owning queue's WAL/FULL connection, so command and enrollment
 * acceptance share one durable transaction. Never a second dispatch source. */
export class CloudAcceptedWorkLedger {
  readonly scope: Readonly<CloudAgentBootScope>;
  private readonly observers = new Set<() => void>();
  constructor(private readonly db: Sqlite.Database, private readonly options: AcceptedLedgerOptions) {
    this.scope = options.scope;
    this.db.exec(`CREATE TABLE IF NOT EXISTS local_accepted_work(
      id TEXT PRIMARY KEY,writer_epoch TEXT NOT NULL,request_sha256 TEXT NOT NULL,reservation TEXT NOT NULL,
      mutation TEXT,receipt TEXT,state TEXT NOT NULL CHECK(state IN ('reserved','accepted','closed')));
      CREATE INDEX IF NOT EXISTS local_accepted_work_pending ON local_accepted_work(writer_epoch,state);`);
  }
  /** Called by the queue only after validating its inherited writer scope. */
  quarantine(): void { this.db.prepare("UPDATE local_accepted_work SET state='closed',mutation=NULL WHERE state<>'closed'").run(); }
  assertCurrent(): void { this.options.assertCurrent(); }
  observeChanges(listener: () => void): () => void {
    if (this.observers.size >= 16) throw new Error("accepted_work_limit");
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }
  /** Nested queue/ledger transactions publish only after their outer commit.
   * A rolled-back Stop must not abort work or release its actor hold. */
  publishChanges(): void {
    if (this.db.inTransaction) return;
    for (const listener of this.observers) try { listener(); } catch { /* observers cannot undo a durable commit */ }
  }

  reserve(input: AcceptedReservationInput): AcceptedReservation {
    this.assertCurrent();
    const mutation = CloudBootCommandMutationSchema.parse(input.mutation), action = mutation.action;
    if (action.kind !== "enqueue" || action.payload.operation || !Number.isSafeInteger(input.capabilityExpiresAtMs) ||
      input.capabilityExpiresAtMs <= this.options.now()) reject();
    const actor = this.options.prepare(mutation, input.actorSessionId);
    if (actor.fundingGrant?.kind !== "owner" || actor.fundingConsentVersion !== 1 || actor.actor.role !== "owner" ||
      actor.actor.userId !== this.scope.fundingOwnerUserId || !isDeepStrictEqual(actor.scope, this.scope)) reject();
    const command = CloudAcceptedWorkCommandSchema.parse({ commandId: action.commandId, conversationId: mutation.conversationId,
      turnId: action.payload.userMessageId, executionId: input.executionId, payloadSha256: hash(this.options.canonical(action.payload)),
      provider: action.payload.agentId, model: action.payload.model, cwd: input.cwd });
    const serialized = this.options.canonical(mutation);
    if (Buffer.byteLength(serialized) > 192 * 1024) throw new Error("accepted_work_limit");
    const requestHash = hash(this.options.canonical({ mutation, actorSessionId: input.actorSessionId, command }));
    const value = this.db.transaction(() => {
      const previous = this.row(command.commandId);
      if (previous) {
        if (previous.writer_epoch !== this.scope.writerEpoch || previous.request_sha256 !== requestHash) conflict();
        const existing = this.read(previous);
        if (existing.state === "closed" || existing.capabilityExpiresAtMs <= this.options.now()) reject();
        if (existing.state === "reserved" && (existing.capabilityId !== input.capabilityId || existing.kid !== input.kid ||
          existing.capabilityExpiresAtMs !== input.capabilityExpiresAtMs)) conflict();
        return existing;
      }
      const pending = (this.db.prepare(`SELECT
        (SELECT count(*) FROM local_commands WHERE state IN ('queued','dispatching'))+
        (SELECT count(*) FROM local_accepted_work WHERE state='reserved') AS n`).get() as { n: number }).n;
      const retained = (this.db.prepare(`SELECT (SELECT count(*) FROM local_commands)+
        (SELECT count(*) FROM local_accepted_work accepted WHERE NOT EXISTS(SELECT 1 FROM local_commands command WHERE command.id=accepted.id)) AS n`)
        .get() as { n: number }).n;
      if (pending >= this.options.pendingLimit || retained >= this.options.commandLimit) throw new Error("accepted_work_limit");
      if (this.db.prepare("SELECT 1 FROM local_commands WHERE id=?").get(command.commandId)) conflict();
      const reservation = { command, actor, capabilityId: input.capabilityId, kid: input.kid, capabilityExpiresAtMs: input.capabilityExpiresAtMs };
      this.db.prepare("INSERT INTO local_accepted_work(id,writer_epoch,request_sha256,reservation,mutation,state) VALUES(?,?,?,?,?,'reserved')")
        .run(command.commandId, this.scope.writerEpoch, requestHash, this.options.canonical(reservation), serialized);
      return { ...reservation, receipt: null, state: "reserved" as const };
    })();
    this.options.changed?.();
    return value;
  }

  commit(commandId: string, input: CloudAcceptedWorkReceipt, recheck: () => void): CloudBootCommandSnapshot {
    this.assertCurrent();
    const receipt = CloudAcceptedWorkReceiptSchema.parse(input);
    const snapshot = this.db.transaction(() => {
      const row = this.row(commandId);
      if (!row || row.writer_epoch !== this.scope.writerEpoch || row.state === "closed") reject();
      const reservation = this.read(row);
      if (!isDeepStrictEqual(receipt.scope, this.scope) || !isDeepStrictEqual(receipt.command, reservation.command) ||
        !isDeepStrictEqual(receipt.actor, reservation.actor.actor) || receipt.actorSessionId !== reservation.actor.actorSessionId ||
        receipt.capabilityId !== reservation.capabilityId || receipt.kid !== reservation.kid ||
        receipt.capabilityExpiresAtMs !== reservation.capabilityExpiresAtMs) conflict();
      if (Math.min(receipt.capabilityExpiresAtMs, receipt.providerExpiresAtMs) <= this.options.now()) reject();
      recheck();
      if (row.state === "accepted") {
        if (!isDeepStrictEqual(reservation.receipt, receipt)) conflict();
        return this.options.snapshot(receipt.command.conversationId);
      }
      if (!row.mutation) reject();
      // Both writes use this queue's existing FULL connection. No ACK or
      // pending-actor release can observe only one half of acceptance.
      this.db.prepare("UPDATE local_accepted_work SET state='accepted',receipt=?,mutation=NULL WHERE id=?")
        .run(this.options.canonical(receipt), commandId);
      const mutation = CloudBootCommandMutationSchema.parse(JSON.parse(row.mutation));
      const current = this.options.prepare(mutation, reservation.actor.actorSessionId);
      if (!isDeepStrictEqual(current.actor, reservation.actor.actor) || !isDeepStrictEqual(current.scope, reservation.actor.scope) ||
        current.authorityEpoch !== reservation.actor.authorityEpoch || current.fundingConsentVersion !== 1 || current.fundingGrant?.kind !== "owner") reject();
      const result = this.options.commit(mutation, reservation.actor);
      recheck();
      return result;
    })();
    this.options.changed?.();
    return snapshot;
  }
  get(commandId: string): AcceptedReservation | undefined {
    const row = this.row(commandId);
    return row?.writer_epoch === this.scope.writerEpoch ? this.read(row) : undefined;
  }
  close(commandId: string): void {
    this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE local_accepted_work SET state='closed',mutation=NULL WHERE id=? AND writer_epoch=? AND state<>'closed'")
        .run(commandId, this.scope.writerEpoch);
      if (changed.changes) this.options.retire(commandId);
    })();
    if (!this.db.inTransaction) {
      this.publishChanges();
      this.options.changed?.();
    }
  }
  closeConversation(conversationId?: string): void {
    this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id FROM local_accepted_work WHERE writer_epoch=? AND state<>'closed'
        AND (? IS NULL OR json_extract(reservation,'$.command.conversationId')=?)`)
        .all(this.scope.writerEpoch, conversationId ?? null, conversationId ?? null) as Array<{ id: string }>;
      for (const row of rows) this.close(row.id);
    })();
    this.publishChanges();
  }
  has(commandId: string): boolean { return !!this.db.prepare("SELECT 1 FROM local_accepted_work WHERE id=? AND receipt IS NOT NULL").get(commandId); }
  reservedCount(): number { return (this.db.prepare("SELECT count(*) AS n FROM local_accepted_work WHERE state='reserved'").get() as { n: number }).n; }
  pendingActorSessions(): readonly string[] {
    return (this.db.prepare("SELECT * FROM local_accepted_work WHERE writer_epoch=? AND state='reserved'")
      .all(this.scope.writerEpoch) as Row[]).map(row => this.read(row).actor.actorSessionId);
  }
  private row(commandId: string): Row | undefined { return this.db.prepare("SELECT * FROM local_accepted_work WHERE id=?").get(commandId) as Row | undefined; }
  private read(row: Row): AcceptedReservation {
    const raw = JSON.parse(row.reservation) as Omit<AcceptedReservation, "receipt" | "state">;
    const actor = CloudActorProvenanceSchema.parse(raw.actor), command = CloudAcceptedWorkCommandSchema.parse(raw.command);
    if (!isDeepStrictEqual(actor.scope, this.scope) || !Number.isSafeInteger(raw.capabilityExpiresAtMs) ||
      typeof raw.capabilityId !== "string" || typeof raw.kid !== "string") reject();
    return { command, actor, capabilityId: raw.capabilityId, kid: raw.kid, capabilityExpiresAtMs: raw.capabilityExpiresAtMs,
      receipt: row.receipt ? CloudAcceptedWorkReceiptSchema.parse(JSON.parse(row.receipt)) : null, state: row.state };
  }
}
