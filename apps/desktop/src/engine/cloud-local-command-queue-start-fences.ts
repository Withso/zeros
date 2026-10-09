import { createHash, randomUUID } from "node:crypto";
import type Sqlite from "better-sqlite3";
import { z } from "zod";
import { CloudAgentBootScopeSchema, CloudAgentCredentialRunInfoSchema,
  type CloudAgentBootScope, type CloudAgentCredentialRunInfo } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudAgentProviderSchema } from "@zeros/protocol/cloud-agent-execution";
import { openSqlite } from "./db/sqlite";

const revision = z.number().int().positive().safe();
const uuid = z.string().uuid();
/** Private, CP-authored background controls. Selectors intentionally cover all
 * revisions of a source, including old active captures and idle native hosts. */
export const CloudAgentCredentialControlSelectorSchema = z.object({
  provider: CloudAgentProviderSchema, credentialId: uuid,
}).strict();
const controlIdentity = {
  ...CloudAgentBootScopeSchema.shape, version: z.literal(1), mutationId: uuid,
  controlRequestId: uuid, fenceEpoch: revision,
};
export const CloudAgentCredentialControlRequestSchema = z.object({
  ...controlIdentity,
  selectors: z.array(CloudAgentCredentialControlSelectorSchema).min(1).max(32)
    .refine(values => new Set(values.map(value => `${value.provider}:${value.credentialId}`)).size === values.length),
  operation: z.enum(["pause-starts", "publish-desired", "retire", "release"]),
  desiredCacheRevision: revision.nullable(),
}).strict().refine(value => (value.operation === "publish-desired") === (value.desiredCacheRevision !== null));
export type CloudAgentCredentialControlRequest = z.infer<typeof CloudAgentCredentialControlRequestSchema>;

const activityScope = z.object({
  executionId: uuid, conversationId: uuid, commandId: uuid.nullable(),
  phase: z.enum(["launch-reserved", "foreground", "background", "idle"]),
  credentialRun: CloudAgentCredentialRunInfoSchema,
}).strict();
const activityCount = z.number().int().min(0).max(1_000_000);
export const CloudAgentCredentialControlActivitySchema = z.object({
  complete: z.boolean(), foreground: activityCount, reservedLaunches: activityCount,
  background: activityCount, idleHosts: activityCount, scopes: z.array(activityScope).max(256),
}).strict().superRefine((value, context) => {
  if (!value.complete) return;
  const counts = { foreground: 0, "launch-reserved": 0, background: 0, idle: 0 };
  for (const scope of value.scopes) counts[scope.phase]++;
  if (counts.foreground !== value.foreground || counts["launch-reserved"] !== value.reservedLaunches ||
      counts.background !== value.background || counts.idle !== value.idleHosts)
    context.addIssue({ code: "custom", message: "Incomplete activity binding" });
});
export const CloudAgentCredentialControlAcknowledgementSchema = z.object({
  ...controlIdentity, controlRevision: revision,
  phase: z.enum(["fenced", "waiting-ready", "ready", "retiring", "retired", "released", "failed"]),
  mutationFenced: z.boolean(), startsFenced: z.boolean(),
  desiredCacheRevision: revision.nullable(), readyCacheRevision: revision.nullable(),
  activity: CloudAgentCredentialControlActivitySchema, proofId: uuid.nullable(),
}).strict().superRefine((value, context) => {
  const issue = () => context.addIssue({ code: "custom", message: "Invalid credential control binding" });
  const terminalUnfenced = value.phase === "ready" || value.phase === "released";
  if (value.mutationFenced === terminalUnfenced || (!terminalUnfenced && !value.startsFenced)) issue();
  if (value.phase === "ready" && (value.desiredCacheRevision === null || value.readyCacheRevision === null ||
      value.desiredCacheRevision > value.readyCacheRevision)) issue();
  if (value.phase === "waiting-ready" && value.desiredCacheRevision === null) issue();
  if (value.phase === "retired") {
    const activity = value.activity;
    if (value.proofId === null || !activity.complete || activity.foreground || activity.reservedLaunches ||
        activity.background || activity.idleHosts || activity.scopes.length) issue();
  } else if (value.proofId !== null) issue();
  for (const item of value.activity.scopes) {
    const run = item.credentialRun;
    if (run.bootId !== value.bootId || run.writerEpoch !== value.writerEpoch ||
        run.fundingOwnerUserId !== value.fundingOwnerUserId || run.fundingOwnerEpoch !== value.fundingOwnerEpoch) issue();
  }
});
export type CloudAgentCredentialControlAcknowledgement = z.infer<typeof CloudAgentCredentialControlAcknowledgementSchema>;

const exchangeIdentity = {
  version: z.literal(1), mode: z.literal("boot-owner-v1"),
  organizationId: uuid, workspaceId: uuid, generation: revision, engineInstanceId: uuid,
  bootId: uuid, writerEpoch: uuid,
};
/** One bounded inventory ACK per exchange; authentication resolves the funder,
 * the mutation and the selectors from CP rows rather than caller fields. */
export const CloudAgentCredentialControlExchangeRequestSchema = z.object({
  ...exchangeIdentity, acknowledgements: z.array(CloudAgentCredentialControlAcknowledgementSchema).max(1),
}).strict().superRefine((value, context) => {
  for (const ack of value.acknowledgements)
    if (ack.organizationId !== value.organizationId || ack.workspaceId !== value.workspaceId ||
        ack.generation !== value.generation || ack.engineInstanceId !== value.engineInstanceId ||
        ack.bootId !== value.bootId || ack.writerEpoch !== value.writerEpoch)
      context.addIssue({ code: "custom", message: "Invalid credential control scope" });
});
export type CloudAgentCredentialControlExchangeRequest = z.infer<typeof CloudAgentCredentialControlExchangeRequestSchema>;
export const CloudAgentCredentialControlExchangeResponseSchema = z.object({
  version: z.literal(1), mode: z.literal("boot-owner-v1"),
  controls: z.array(CloudAgentCredentialControlRequestSchema).max(16),
}).strict();
export type CloudAgentCredentialControlExchangeResponse = z.infer<typeof CloudAgentCredentialControlExchangeResponseSchema>;

type Selector = z.infer<typeof CloudAgentCredentialControlSelectorSchema>;
type Activity = z.infer<typeof CloudAgentCredentialControlActivitySchema>;
type Phase = CloudAgentCredentialControlAcknowledgement["phase"];
type FenceRow = { mutation_id: string; identity_sha256: string; selectors: string; fence_epoch: number;
  phase: Phase; desired_revision: number | null; proof_id: string | null };
type OperationRow = { request_sha256: string; acknowledgement: string | null };
type Options = { file: string; scope: CloudAgentBootScope; engineLive(): boolean;
  activity(selectors: readonly Selector[]): unknown;
  /** Trusted current/captured source metadata, recorded before irreversible
   * retirement. Unknown floors can never authorize a later association. */
  associationFloor?(provider: Selector["provider"], credentialId: string): Readonly<{ cacheRevision: number; connectionRevision: number }> | null;
  /** The genuine factory invalidates publications synchronously before its
   * first await and resolves only after positive exact native retirement. */
  retire(selectors: readonly Selector[]): Promise<void>;
  markDesired(revision: number): void; readyRevision(): number | null; synchronize(): Promise<void>;
  maxOperations?: number; maxMutations?: number };
export class CloudCredentialControlError extends Error {
  constructor(readonly code: "credential_control_authority_rejected" | "credential_control_conflict" |
    "credential_control_limit" | "credential_control_storage_unavailable" | "credential_control_invalid") {
    super(code); this.name = "CloudCredentialControlError";
  }
}
const emptyUnknown = (): Activity => ({ complete: false, foreground: 0, reservedLaunches: 0, background: 0, idleHosts: 0, scopes: [] });
const encode = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown): string => createHash("sha256").update(encode(value)).digest("hex");

/** Engine-only FULL ledger. These controls are admitted only by the verified
 * private CP background exchange, never from workspace RPCs or native frames.
 * A synchronous fence precedes activity/refresh/retirement. Control retries
 * are safe and do not replay a native prompt or extend any source lease. */
export class CloudCredentialStartFences {
  readonly scope: Readonly<CloudAgentBootScope>;
  private readonly db: Sqlite.Database;
  private readonly flights = new Map<string, { hash: string; promise: Promise<CloudAgentCredentialControlAcknowledgement> }>();
  private readonly maxOperations: number;
  private readonly maxMutations: number;
  private closed = false;
  constructor(private readonly options: Options) {
    this.scope = Object.freeze(CloudAgentBootScopeSchema.parse(options.scope));
    this.maxOperations = options.maxOperations ?? 2048; this.maxMutations = options.maxMutations ?? 512;
    if (![this.maxOperations, this.maxMutations].every(value => Number.isSafeInteger(value) && value > 0) ||
        this.maxOperations > 8192 || this.maxMutations > 1024) throw new CloudCredentialControlError("credential_control_invalid");
    this.db = openSqlite(options.file);
    try {
      this.db.pragma("journal_mode = WAL"); this.db.pragma("synchronous = FULL"); this.db.pragma("busy_timeout = 25");
      this.db.exec(`CREATE TABLE IF NOT EXISTS local_credential_control_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_credential_start_fences(mutation_id TEXT PRIMARY KEY,identity_sha256 TEXT NOT NULL,
          selectors TEXT NOT NULL,fence_epoch INTEGER NOT NULL,phase TEXT NOT NULL,desired_revision INTEGER,proof_id TEXT);
        CREATE TABLE IF NOT EXISTS local_credential_control_operations(request_id TEXT PRIMARY KEY,request_sha256 TEXT NOT NULL,
          acknowledgement TEXT,ack_bytes INTEGER NOT NULL DEFAULT 0,ack_delivered INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS local_credential_retirement_floors(mutation_id TEXT NOT NULL,provider TEXT NOT NULL,
          credential_id TEXT NOT NULL,cache_revision INTEGER,connection_revision INTEGER,PRIMARY KEY(mutation_id,provider,credential_id));`);
      const columns = this.db.prepare("PRAGMA table_info(local_credential_control_operations)").all() as { name: string }[];
      if (!columns.some(column => column.name === "ack_delivered"))
        this.db.exec("ALTER TABLE local_credential_control_operations ADD COLUMN ack_delivered INTEGER NOT NULL DEFAULT 0");
      this.transaction(() => {
        const old = this.db.prepare("SELECT value FROM local_credential_control_metadata WHERE key='scope'").get() as { value: string } | undefined;
        // An unverified mixed/rolled-back writer cannot activate inherited
        // controls or claim that the old native holders have been retired.
        if (old && old.value !== encode(this.scope)) throw new CloudCredentialControlError("credential_control_authority_rejected");
        this.db.prepare("INSERT OR IGNORE INTO local_credential_control_metadata(key,value) VALUES('scope',?)").run(encode(this.scope));
        this.db.prepare("INSERT OR IGNORE INTO local_credential_control_metadata(key,value) VALUES('revision','0')").run();
      });
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }
  private transaction<T>(work: () => T): T {
    try { return this.db.transaction(work)(); }
    catch (error) { if (error instanceof CloudCredentialControlError) throw error;
      throw new CloudCredentialControlError("credential_control_storage_unavailable"); }
  }
  private live(): void {
    let live = false; try { live = !this.closed && this.options.engineLive(); } catch { /* fail closed */ }
    if (!live) throw new CloudCredentialControlError("credential_control_authority_rejected");
  }
  private row(id: string): FenceRow | undefined {
    return this.db.prepare("SELECT * FROM local_credential_start_fences WHERE mutation_id=?").get(id) as FenceRow | undefined;
  }
  private rows(): FenceRow[] { return this.db.prepare("SELECT * FROM local_credential_start_fences").all() as FenceRow[]; }
  private matches(row: FenceRow, selectors: readonly Selector[]): boolean {
    const recorded = z.array(CloudAgentCredentialControlSelectorSchema).parse(JSON.parse(row.selectors));
    return selectors.some(value => recorded.some(item => value.provider === item.provider && value.credentialId === item.credentialId));
  }
  private readyRevision(): number | null {
    try { const value = this.options.readyRevision(); return revision.safeParse(value).success ? value : null; } catch { return null; }
  }
  private desiredRevision(): number {
    return (this.db.prepare("SELECT coalesce(max(desired_revision),0) AS n FROM local_credential_start_fences").get() as { n: number }).n;
  }
  /** No requester is called here. The opaque factory checks this at selection,
   * reservation and immediately before actual native write. Entered native
   * descendants use their captured lifetime, not a new-start permission. */
  canStart(input: CloudAgentCredentialRunInfo): boolean {
    try {
      this.live(); const parsed = CloudAgentCredentialRunInfoSchema.parse(input);
      if (parsed.bootId !== this.scope.bootId || parsed.writerEpoch !== this.scope.writerEpoch ||
          parsed.fundingOwnerUserId !== this.scope.fundingOwnerUserId || parsed.fundingOwnerEpoch !== this.scope.fundingOwnerEpoch) return false;
      const ready = this.readyRevision();
      if (ready === null || ready < this.desiredRevision() || parsed.cacheRevision !== ready) return false;
      return !this.rows().some(row => {
        if (row.phase === "released" || row.phase === "ready" || !this.matches(row,[parsed])) return false;
        if (row.phase !== "retired" || !row.proof_id) return true;
        const floor = this.db.prepare(`SELECT cache_revision,connection_revision FROM local_credential_retirement_floors
          WHERE mutation_id=? AND provider=? AND credential_id=?`).get(row.mutation_id,parsed.provider,parsed.credentialId) as
          { cache_revision: number | null; connection_revision: number | null } | undefined;
        return !floor || floor.cache_revision === null || floor.connection_revision === null ||
          parsed.cacheRevision <= floor.cache_revision || parsed.connectionRevision <= floor.connection_revision;
      });
    } catch { return false; }
  }
  private activity(request: CloudAgentCredentialControlRequest): Activity {
    try {
      const value = CloudAgentCredentialControlActivitySchema.parse(this.options.activity(request.selectors));
      for (const item of value.scopes) {
        const run = item.credentialRun;
        if (run.bootId !== this.scope.bootId || run.writerEpoch !== this.scope.writerEpoch ||
            run.fundingOwnerUserId !== this.scope.fundingOwnerUserId || run.fundingOwnerEpoch !== this.scope.fundingOwnerEpoch ||
            !request.selectors.some(selector => selector.provider === run.provider && selector.credentialId === run.credentialId)) return emptyUnknown();
      }
      if (Buffer.byteLength(encode(value)) > 256 * 1024) return emptyUnknown();
      return value;
    } catch { return emptyUnknown(); }
  }
  private startsFenced(request: CloudAgentCredentialControlRequest): boolean {
    const ready = this.readyRevision();
    return ready === null || ready < this.desiredRevision() || this.rows().some(row =>
      row.phase !== "released" && row.phase !== "ready" && this.matches(row, request.selectors));
  }
  private begin(request: CloudAgentCredentialControlRequest): CloudAgentCredentialControlAcknowledgement | null {
    return this.transaction(() => {
      const hash = digest(request), old = this.db.prepare("SELECT * FROM local_credential_control_operations WHERE request_id=?")
        .get(request.controlRequestId) as OperationRow | undefined;
      if (old) {
        if (old.request_sha256 !== hash) throw new CloudCredentialControlError("credential_control_conflict");
        if (old.acknowledgement) return CloudAgentCredentialControlAcknowledgementSchema.parse(JSON.parse(old.acknowledgement));
      }
      const identity = digest({ scope: this.scope, mutationId: request.mutationId, fenceEpoch: request.fenceEpoch, selectors: request.selectors });
      const row = this.row(request.mutationId);
      if (row && row.identity_sha256 !== identity) throw new CloudCredentialControlError("credential_control_conflict");
      if (!row && !["pause-starts", "release"].includes(request.operation)) throw new CloudCredentialControlError("credential_control_conflict");
      if (row && request.operation === "release" && !["fenced", "released"].includes(row.phase)) throw new CloudCredentialControlError("credential_control_conflict");
      if (row && request.operation === "publish-desired" && (!["fenced", "waiting-ready", "failed"].includes(row.phase) ||
          row.phase === "failed" && row.desired_revision === null || row.desired_revision !== null && row.desired_revision !== request.desiredCacheRevision))
        throw new CloudCredentialControlError("credential_control_conflict");
      if (row && request.operation === "retire" && (!["fenced", "retiring", "retired", "failed"].includes(row.phase) || row.desired_revision !== null))
        throw new CloudCredentialControlError("credential_control_conflict");
      if (!old) {
        const count = (this.db.prepare("SELECT count(*) AS n FROM local_credential_control_operations").get() as { n: number }).n;
        // Existing removal/cancel has reserved monotonic capacity; exhaustion
        // cannot silently unfence or evict the tombstone to make room.
        const reserved = !!row && ["retire", "release"].includes(request.operation);
        if (count >= this.maxOperations && !reserved || count >= this.maxOperations + this.maxMutations * 2 ||
            (this.db.prepare("SELECT coalesce(sum(ack_bytes),0) AS n FROM local_credential_control_operations").get() as { n: number }).n >= 32 * 1024 * 1024 ||
            !row && (this.db.prepare("SELECT count(*) AS n FROM local_credential_start_fences").get() as { n: number }).n >= this.maxMutations)
          throw new CloudCredentialControlError("credential_control_limit");
        this.db.prepare("INSERT INTO local_credential_control_operations(request_id,request_sha256) VALUES(?,?)").run(request.controlRequestId, hash);
      }
      const phase: Phase = request.operation === "release" ? "released" : request.operation === "retire" ? "retiring"
        : request.operation === "publish-desired" ? "waiting-ready" : row?.phase ?? "fenced";
      this.db.prepare(`INSERT INTO local_credential_start_fences(mutation_id,identity_sha256,selectors,fence_epoch,phase,desired_revision,proof_id)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(mutation_id) DO UPDATE SET phase=excluded.phase,desired_revision=excluded.desired_revision`)
        .run(request.mutationId, identity, encode(request.selectors), request.fenceEpoch, row?.phase === "retired" ? "retired" : phase,
          request.desiredCacheRevision ?? row?.desired_revision ?? null, row?.proof_id ?? null);
      if (request.operation === "retire") {
        for (const selector of request.selectors) {
          let floor: ReturnType<NonNullable<Options["associationFloor"]>> = null;
          try {
            const value = this.options.associationFloor?.(selector.provider,selector.credentialId);
            if (value && revision.safeParse(value.cacheRevision).success && revision.safeParse(value.connectionRevision).success) floor = value;
          } catch { /* Unknown source cannot authorize re-association. */ }
          this.db.prepare(`INSERT OR IGNORE INTO local_credential_retirement_floors(mutation_id,provider,credential_id,cache_revision,connection_revision)
            VALUES(?,?,?,?,?)`).run(request.mutationId,selector.provider,selector.credentialId,floor?.cacheRevision ?? null,floor?.connectionRevision ?? null);
        }
      }
      return null;
    });
  }
  private finish(request: CloudAgentCredentialControlRequest, phase?: Phase): CloudAgentCredentialControlAcknowledgement {
    this.live();
    return this.transaction(() => {
      const row = this.row(request.mutationId)!;
      if (phase && row.phase !== "retired") {
        const proof = phase === "retired" ? randomUUID() : null;
        this.db.prepare("UPDATE local_credential_start_fences SET phase=?,proof_id=? WHERE mutation_id=?").run(phase, proof, request.mutationId);
        row.phase = phase; row.proof_id = proof;
      }
      const metadata = this.db.prepare("SELECT value FROM local_credential_control_metadata WHERE key='revision'").get() as { value: string };
      const next = Number(metadata.value) + 1;
      if (!Number.isSafeInteger(next)) throw new CloudCredentialControlError("credential_control_limit");
      const activity = this.activity(request);
      if (row.phase === "retired" && (!activity.complete || activity.foreground || activity.reservedLaunches || activity.background || activity.idleHosts || activity.scopes.length))
        throw new CloudCredentialControlError("credential_control_conflict");
      const acknowledgement = CloudAgentCredentialControlAcknowledgementSchema.parse({ ...this.scope, version: 1,
        mutationId: request.mutationId, controlRequestId: request.controlRequestId, fenceEpoch: request.fenceEpoch, controlRevision: next,
        phase: row.phase, mutationFenced: !["released", "ready"].includes(row.phase), startsFenced: this.startsFenced(request),
        desiredCacheRevision: row.desired_revision, readyCacheRevision: this.readyRevision(), activity, proofId: row.proof_id });
      this.db.prepare("UPDATE local_credential_control_metadata SET value=? WHERE key='revision'").run(String(next));
      const body = encode(acknowledgement);
      this.db.prepare("UPDATE local_credential_control_operations SET acknowledgement=?,ack_bytes=? WHERE request_id=?")
        .run(body, Buffer.byteLength(body), request.controlRequestId);
      return acknowledgement;
    });
  }
  handle(value: unknown): Promise<CloudAgentCredentialControlAcknowledgement> {
    try {
      this.live(); const parsed = CloudAgentCredentialControlRequestSchema.safeParse(value);
      if (!parsed.success) throw new CloudCredentialControlError("credential_control_invalid");
      const request = parsed.data;
      if (Object.entries(this.scope).some(([key, item]) => request[key as keyof typeof request] !== item))
        throw new CloudCredentialControlError("credential_control_authority_rejected");
      const hash = digest(request), flight = this.flights.get(request.controlRequestId);
      if (flight) return hash === flight.hash ? flight.promise : Promise.reject(new CloudCredentialControlError("credential_control_conflict"));
      const replay = this.begin(request);
      if (replay) return Promise.resolve(replay);
      const work = (async () => {
        const row = this.row(request.mutationId)!;
        if (request.operation === "publish-desired") {
          try {
            this.options.markDesired(request.desiredCacheRevision!);
            await this.options.synchronize(); this.live();
            const ready = this.readyRevision();
            return this.finish(request, ready !== null && ready >= request.desiredCacheRevision! ? "ready" : "waiting-ready");
          } catch { return this.finish(request, "failed"); }
        }
        if (request.operation === "retire" && row.phase !== "retired") {
          try {
            await this.options.retire(request.selectors); this.live();
            const activity = this.activity(request);
            return this.finish(request, activity.complete && !activity.foreground && !activity.reservedLaunches && !activity.background && !activity.idleHosts && !activity.scopes.length
              ? "retired" : "failed");
          } catch { return this.finish(request, "failed"); }
        }
        return this.finish(request);
      })().finally(() => { this.flights.delete(request.controlRequestId); });
      this.flights.set(request.controlRequestId, { hash, promise: work });
      return work;
    } catch (error) { return Promise.reject(error); }
  }
  /** Delivery is a FULL outbox receipt. A lost exchange response retains this
   * exact ACK/body until a successful strict current-scope response arrives. */
  pendingAcknowledgement(): CloudAgentCredentialControlAcknowledgement | null {
    this.live();
    const row = this.db.prepare(`SELECT acknowledgement FROM local_credential_control_operations
      WHERE acknowledgement IS NOT NULL AND ack_delivered=0 ORDER BY json_extract(acknowledgement,'$.controlRevision') LIMIT 1`)
      .get() as { acknowledgement: string } | undefined;
    return row ? CloudAgentCredentialControlAcknowledgementSchema.parse(JSON.parse(row.acknowledgement)) : null;
  }
  confirmAcknowledgement(input: CloudAgentCredentialControlAcknowledgement): void {
    this.live(); const ack = CloudAgentCredentialControlAcknowledgementSchema.parse(input);
    this.transaction(() => {
      const row = this.db.prepare("SELECT acknowledgement FROM local_credential_control_operations WHERE request_id=?")
        .get(ack.controlRequestId) as { acknowledgement: string | null } | undefined;
      if (!row?.acknowledgement || digest(JSON.parse(row.acknowledgement)) !== digest(ack))
        throw new CloudCredentialControlError("credential_control_conflict");
      this.db.prepare("UPDATE local_credential_control_operations SET ack_delivered=1 WHERE request_id=?").run(ack.controlRequestId);
    });
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
