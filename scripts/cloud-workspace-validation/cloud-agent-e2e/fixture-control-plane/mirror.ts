import { isDeepStrictEqual } from "node:util";
import { CloudAgentBootScopeSchema, type CloudAgentBootScope } from "@zeros/protocol/cloud-agent-bootstrap";
import { CloudBootCommandEntrySchema } from "@zeros/protocol/cloud-commands";
import { canonicalCloudLocalCommandHistoryJson, CloudLocalCommandMirrorBatchSchema, CloudLocalCommandMirrorAckSchema,
  cloudLocalCommandHistoryHeadMatchesManifest, type CloudLocalCommandMirrorAck, type CloudLocalCommandMirrorChange,
  type CloudLocalCommandHistoryHead, type CloudLocalCommandHistoryPart, type CloudCompactControlEvent,
  type CloudLocalCommandHistoryRecord, type CloudLocalCommandHistoryManifest,
  CloudLocalCommandWriterSealSchema, CloudLocalCommandWriterSealAckSchema, canonicalCloudLocalCommandWriterSealDescriptor,
  type CloudLocalCommandWriterSeal, type CloudLocalCommandWriterSealAck } from "@zeros/protocol/cloud-local-mirror";
import { assembleCloudHistoryDocument } from "../../../../apps/control-plane/src/cloud-workspaces/history-local-contract";
import { clone, FixtureRefusal, parse, ScopeSchema, sha256 } from "./contracts";

export const FixtureMirrorBodySchema = ScopeSchema.extend({ batch: CloudLocalCommandMirrorBatchSchema }).strict();
export const FixtureSealBodySchema = ScopeSchema.extend({ seal: CloudLocalCommandWriterSealSchema }).strict();
type Command = { conversationId: string; entry: ReturnType<typeof CloudBootCommandEntrySchema.parse>;
  history: CloudLocalCommandMirrorChange["history"]; actor: CloudLocalCommandMirrorChange["actor"];
  originWriterEpoch: string; intent: NonNullable<CloudLocalCommandMirrorChange["intent"]> };
type Blob = ReturnType<typeof assembleCloudHistoryDocument>;
type State = { through: number; historyBytes: number;
  batches: Map<string, { hash: string; ack: CloudLocalCommandMirrorAck }>;
  controls: Map<string, { revision: number; paused: boolean; nativeGoal?: CloudLocalCommandMirrorChange["nativeGoal"] }>;
  commands: Map<string, Command>; heads: Map<string, CloudLocalCommandHistoryHead>;
  parts: Map<string, Map<number, CloudLocalCommandHistoryPart>>; blobs: Map<string, Blob>;
  events: Map<number, { commandId: string; event: CloudCompactControlEvent; outboxSequence: number }> };
const empty = (): State => ({ through: 0, historyBytes: 0, batches: new Map(), controls: new Map(), commands: new Map(),
  heads: new Map(), parts: new Map(), blobs: new Map(), events: new Map() });
const canonical = canonicalCloudLocalCommandHistoryJson;
const conflict = (): never => { throw new FixtureRefusal("command_conflict"); };

// Same immediate FULL-flight pairing as production CP ingress. A complete
// receipt audit stays immutable; only the explicit staging head owns restore.
function hasPairedStagingHead(receipt: CloudLocalCommandMirrorChange, next: CloudLocalCommandMirrorChange | undefined): boolean {
  const entry = receipt.entry, audit = receipt.history, head = next?.historyHead;
  if (!entry || !audit || !("manifestSha256" in audit) || !next || !head || head.source.kind !== "command" ||
      next.sequence !== receipt.sequence + 1 || next.conversationId !== receipt.conversationId || next.revision !== receipt.revision || next.paused !== receipt.paused ||
      next.entry || next.history || next.historyPart || next.event || next.nativeGoal || next.actor || next.intent || next.credentialRun || next.originWriterEpoch ||
      head.originWriterEpoch !== receipt.originWriterEpoch || head.deleted || !("incompleteReason" in head.history) ||
      head.history.incompleteReason !== "capture_unavailable" || head.history.restoreRevision + 1 !== audit.restoreRevision ||
      head.history.recordSequence !== audit.recordSequence || head.history.eventSequence !== audit.eventSequence) return false;
  const source = { kind: "command", commandId: entry.commandId, intent: receipt.intent!, executionId: entry.executionId,
    nativeResultSha256: entry.result == null ? null : sha256(canonical(entry.result)) };
  return canonical(head.source) === canonical(source);
}

/** Bounded single-boot in-memory projection. It consumes real schemas/canonical
 * validators but does not claim PostgreSQL durability, historic writer recovery,
 * production identity, or native execution. No VM replay is synthesized here. */
export class FixtureMirrorProjection {
  private state = empty();
  private closed = false;
  private scope: CloudAgentBootScope | null = null;
  private sealed: { descriptor: CloudLocalCommandWriterSeal; ack: CloudLocalCommandWriterSealAck } | null = null;
  private readonly maximum: number;
  constructor(private readonly dependencies: { activeScope(): CloudAgentBootScope; maxHistoryBytes?: number }) {
    this.maximum = dependencies.maxHistoryBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 0 || this.maximum > 64 * 1024 * 1024) throw new FixtureRefusal("fixture_history_limit_invalid");
  }
  private current(): CloudAgentBootScope {
    if (this.closed) throw new FixtureRefusal("engine_authority_rejected", 401);
    try { return parse(CloudAgentBootScopeSchema, this.dependencies.activeScope(), "engine_authority_rejected"); }
    catch { throw new FixtureRefusal("engine_authority_rejected", 401); }
  }
  handle(raw: unknown): CloudLocalCommandMirrorAck {
    const scope = this.current(), batch = parse(CloudLocalCommandMirrorBatchSchema, raw, "invalid_command");
    if (this.sealed || scope.bootId !== batch.bootId || scope.writerEpoch !== batch.writerEpoch || (this.scope && !isDeepStrictEqual(this.scope, scope)))
      throw new FixtureRefusal("command_context_changed");
    let hash: string;
    try { hash = sha256(canonical(batch)); } catch { throw new FixtureRefusal("invalid_command", 422); }
    const previous = this.state.batches.get(batch.batchId);
    if (previous) { if (previous.hash !== hash) conflict(); return clone(previous.ack); }
    if (batch.after !== this.state.through) conflict();
    if (this.state.batches.size >= 2048) throw new FixtureRefusal("command_limit");
    // Copy container maps only. Stored values never mutate; every new value is
    // replaced in this private transaction and published only after all checks.
    const state: State = { ...this.state, batches: new Map(this.state.batches), controls: new Map(this.state.controls),
      commands: new Map(this.state.commands), heads: new Map(this.state.heads), parts: new Map(this.state.parts),
      blobs: new Map(this.state.blobs), events: new Map(this.state.events) };
    const historyLimits: NonNullable<CloudLocalCommandMirrorAck["historyLimits"]> = [], limited = new Set<string>();
    for (let changeIndex = 0; changeIndex < batch.changes.length; changeIndex++) {
      const change = batch.changes[changeIndex]!;
      const prior = state.controls.get(change.conversationId);
      if (prior && (prior.revision > change.revision || (prior.revision === change.revision &&
          (prior.paused !== change.paused || (change.nativeGoal !== undefined && !isDeepStrictEqual(change.nativeGoal, prior.nativeGoal)))))) conflict();
      if (!prior && state.controls.size >= 512) throw new FixtureRefusal("command_limit");
      state.controls.set(change.conversationId, { revision: change.revision, paused: change.paused,
        ...(change.nativeGoal ?? prior?.nativeGoal ? { nativeGoal: clone(change.nativeGoal ?? prior?.nativeGoal) } : {}) });
      if (change.entry) this.command(state, scope, change);
      if (change.event) this.event(state, scope, change);
      if (change.historyPart && this.part(state, scope, change.conversationId, change.historyPart)) {
        if (!historyLimits.some(pair => pair.conversationId === change.conversationId && pair.sha256 === change.historyPart!.sha256))
          historyLimits.push({ conversationId: change.conversationId, sha256: change.historyPart.sha256 });
        limited.add(change.conversationId);
      }
      let head = change.historyHead;
      if (!head && change.entry && change.history) {
        if ("manifestSha256" in change.history) {
          if (!hasPairedStagingHead(change, batch.changes[changeIndex + 1])) conflict();
        } else head = { originWriterEpoch: change.originWriterEpoch!, deleted: false,
          source: { kind: "command", commandId: change.entry.commandId, intent: change.intent!, executionId: change.entry.executionId,
            nativeResultSha256: change.entry.result == null ? null : sha256(canonical(change.entry.result)) }, history: change.history };
      }
      if (head) {
        if (limited.has(change.conversationId) && "manifestSha256" in head.history) head = { ...head, history: {
          restoreRevision: head.history.restoreRevision, recordSequence: head.history.recordSequence, eventSequence: head.history.eventSequence,
          incompleteReason: "history_limit" } };
        this.head(state, scope, change.conversationId, head);
      }
    }
    if (!isDeepStrictEqual(this.current(), scope)) throw new FixtureRefusal("command_context_changed");
    const ack = parse(CloudLocalCommandMirrorAckSchema, { version: 1, writerEpoch: batch.writerEpoch, batchId: batch.batchId, through: batch.through,
      ...(historyLimits.length ? { historyLimits } : {}) }, "fixture_mirror_response_invalid");
    state.through = batch.through; state.batches.set(batch.batchId, { hash, ack: clone(ack) });
    this.scope = clone(scope); this.state = state; return ack;
  }
  /** Projection/descriptor proof only. Private FULL inventory and native
   * retirement remain the real producer's responsibility, never this fixture. */
  seal(raw: unknown): CloudLocalCommandWriterSealAck {
    const scope = this.current(), seal = parse(CloudLocalCommandWriterSealSchema, raw, "invalid_command");
    if (!isDeepStrictEqual(seal.scope, scope) || (this.scope && !isDeepStrictEqual(this.scope, scope)))
      throw new FixtureRefusal("command_context_changed");
    if (sha256(canonicalCloudLocalCommandWriterSealDescriptor(seal)) !== seal.sha256) conflict();
    if (this.sealed) {
      if (!isDeepStrictEqual(this.sealed.descriptor, seal)) conflict();
      return clone(this.sealed.ack);
    }
    if (this.state.through !== seal.sequence || [...this.state.commands.values()].some(row => ["queued", "dispatching"].includes(row.entry.state))) conflict();
    let recordSequence = 0, eventSequence = 0;
    for (const history of [...this.state.commands.values()].map(row => row.history).concat([...this.state.heads.values()].map(row => row.history))) {
      recordSequence = Math.max(recordSequence, history?.recordSequence ?? 0);
      eventSequence = Math.max(eventSequence, history?.eventSequence ?? 0);
    }
    for (const event of this.state.events.values()) eventSequence = Math.max(eventSequence, event.event.eventSequence);
    if (recordSequence > seal.recordSequence || eventSequence > seal.eventSequence) conflict();
    const ack = parse(CloudLocalCommandWriterSealAckSchema, { version: 1, sealId: seal.sealId, writerEpoch: scope.writerEpoch,
      sequence: seal.sequence, recordSequence: seal.recordSequence, eventSequence: seal.eventSequence,
      inventorySha256: seal.inventorySha256, sha256: seal.sha256 }, "fixture_mirror_response_invalid");
    if (!isDeepStrictEqual(this.current(), scope)) throw new FixtureRefusal("command_context_changed");
    this.scope = clone(scope); this.sealed = { descriptor: clone(seal), ack: clone(ack) }; return ack;
  }
  private command(state: State, scope: CloudAgentBootScope, change: CloudLocalCommandMirrorChange): void {
    const entry = change.entry!, previous = state.commands.get(entry.commandId);
    if (change.originWriterEpoch !== scope.writerEpoch || entry.generation !== scope.generation ||
        (change.actor && (!isDeepStrictEqual(change.actor.scope, scope) || change.actor.actor.role === "viewer" ||
          change.actor.fundingConsentVersion !== 1 || !change.actor.fundingGrant))) conflict();
    if (!previous && state.commands.size >= 512) throw new FixtureRefusal("command_limit");
    const actor = change.actor ?? previous?.actor;
    if (entry.executionId !== null && !actor) conflict();
    if (previous && (previous.conversationId !== change.conversationId || previous.originWriterEpoch !== change.originWriterEpoch ||
        !isDeepStrictEqual(previous.intent, change.intent) || previous.entry.position !== entry.position || previous.entry.generation !== entry.generation ||
        Date.parse(previous.entry.createdAt) !== Date.parse(entry.createdAt) ||
        (previous.entry.executionId !== null && previous.entry.executionId !== entry.executionId) ||
        (previous.entry.executionId !== null && actor && !isDeepStrictEqual(actor, previous.actor)) ||
        (!["queued", "dispatching"].includes(previous.entry.state) &&
          (!isDeepStrictEqual(previous.entry, entry) || !isDeepStrictEqual(previous.history, change.history))) ||
        (previous.entry.state !== "queued" && entry.state === "queued"))) conflict();
    const terminal = entry.result?.terminal;
    if (terminal && ((entry.state === "failed" && terminal.status !== "failed") || (entry.state === "succeeded" && terminal.status !== "completed") ||
        (entry.state === "cancelled" && terminal.status !== "cancelled"))) conflict();
    state.commands.set(entry.commandId, { conversationId: change.conversationId, entry: clone(entry), history: clone(change.history), actor: clone(actor),
      originWriterEpoch: change.originWriterEpoch!, intent: clone(change.intent!) });
  }
  private event(state: State, scope: CloudAgentBootScope, change: CloudLocalCommandMirrorChange): void {
    const event = change.event!, frame = event.frame;
    const matches = [...state.commands].filter(([id, command]) => command.conversationId === change.conversationId && command.entry.executionId === event.executionId &&
      (event.commandId === undefined || event.commandId === id) && (change.entry === undefined || change.entry.commandId === id) &&
      (event.turnId === undefined || event.turnId === command.intent.userMessageId));
    if (matches.length !== 1) conflict();
    const [commandId, command] = matches[0]!;
    if (!command.actor || !isDeepStrictEqual(command.actor.scope, scope) || frame.agentId !== command.intent.agentId ||
        (frame.chatId !== undefined && frame.chatId !== command.conversationId) ||
        (frame.cloudStream && (frame.cloudStream.streamId !== scope.engineInstanceId || frame.cloudStream.sequence !== event.eventSequence)) ||
        ("request" in frame && frame.request.sessionId !== event.executionId) ||
        (frame.type === "AGENT_PERMISSION_SETTLED" && frame.sessionId !== event.executionId) ||
        (frame.type === "AGENT_QUESTION_REQUEST" && frame.questionId !== frame.request.questionId)) conflict();
    const prior = state.events.get(event.eventSequence);
    if (prior) { if (prior.commandId !== commandId || !isDeepStrictEqual(prior.event, event)) conflict(); return; }
    const resolver = "permissionId" in frame ? frame.permissionId : frame.questionId;
    const requestType = frame.type === "AGENT_PERMISSION_SETTLED" ? "AGENT_PERMISSION_REQUEST" : frame.type === "AGENT_QUESTION_SETTLED" ? "AGENT_QUESTION_REQUEST" : null;
    if (requestType && ![...state.events.values()].some(row => row.commandId === commandId && row.event.eventSequence < event.eventSequence &&
        row.event.executionId === event.executionId && row.event.frame.type === requestType &&
        ("permissionId" in row.event.frame ? row.event.frame.permissionId : row.event.frame.questionId) === resolver)) conflict();
    if (state.events.size >= 2048) throw new FixtureRefusal("command_limit");
    state.events.set(event.eventSequence, { commandId, event: clone(event), outboxSequence: change.sequence });
  }
  private part(state: State, scope: CloudAgentBootScope, conversationId: string, part: CloudLocalCommandHistoryPart): boolean {
    const stored = state.blobs.get(part.sha256);
    if (stored) {
      const bytes = Buffer.from(stored.canonicalDocument), expected = bytes.subarray(part.index * 128 * 1024, (part.index + 1) * 128 * 1024).toString("base64");
      if (stored.kind !== part.kind || stored.document.conversationId !== conversationId || bytes.length !== part.bytes ||
          part.count !== Math.ceil(bytes.length / (128 * 1024)) || expected !== part.data) conflict();
      return false;
    }
    const prior = state.parts.get(part.sha256), chunks = new Map(prior);
    if (chunks.has(part.index)) { if (!isDeepStrictEqual(chunks.get(part.index), part)) conflict(); return false; }
    if ([...chunks.values()].some(row => row.count !== part.count || row.kind !== part.kind || row.bytes !== part.bytes)) conflict();
    const bytes = Buffer.from(part.data, "base64").length;
    if (state.historyBytes + bytes > this.maximum) return true;
    chunks.set(part.index, clone(part)); state.parts.set(part.sha256, chunks); state.historyBytes += bytes;
    if (chunks.size === part.count) {
      let blob: Blob;
      try { blob = assembleCloudHistoryDocument([...chunks.values()]); } catch { conflict(); }
      if (blob!.document.conversationId !== conversationId || (blob!.kind === "manifest" &&
          !isDeepStrictEqual((blob!.document as CloudLocalCommandHistoryManifest).scope, scope))) conflict();
      if (state.historyBytes + Buffer.byteLength(blob!.canonicalDocument) > this.maximum) {
        state.parts.delete(part.sha256); state.historyBytes -= [...chunks.values()].reduce((size, row) => size + Buffer.from(row.data, "base64").length, 0);
        return true;
      }
      state.blobs.set(part.sha256, blob!); state.historyBytes += Buffer.byteLength(blob!.canonicalDocument);
    }
    return false;
  }
  private head(state: State, scope: CloudAgentBootScope, conversationId: string, head: CloudLocalCommandHistoryHead): void {
    if (head.originWriterEpoch !== scope.writerEpoch) conflict();
    const source = head.source;
    if (source.kind === "command") {
      const command = state.commands.get(source.commandId);
      if (!command || command.conversationId !== conversationId || !isDeepStrictEqual(command.intent, source.intent) ||
          command.entry.executionId !== source.executionId || (command.entry.result == null ? source.nativeResultSha256 !== null :
            sha256(canonical(command.entry.result)) !== source.nativeResultSha256)) conflict();
    }
    const previous = state.heads.get(conversationId);
    if (previous && previous.history.restoreRevision > head.history.restoreRevision) return;
    if (previous && previous.history.restoreRevision === head.history.restoreRevision) { if (!isDeepStrictEqual(previous, head)) conflict(); return; }
    if ("manifestSha256" in head.history) {
      const blob = state.blobs.get(head.history.manifestSha256);
      if (!blob || blob.kind !== "manifest") conflict();
      const manifest = blob!.document as CloudLocalCommandHistoryManifest;
      if (manifest.conversationId !== conversationId || !isDeepStrictEqual(manifest.scope, scope) ||
          !cloudLocalCommandHistoryHeadMatchesManifest(head, manifest, sha256(blob!.canonicalDocument))) conflict();
      let total = Buffer.byteLength(blob!.canonicalDocument);
      for (const ref of manifest.records) {
        const record = state.blobs.get(ref.sha256), document = record?.document as CloudLocalCommandHistoryRecord | undefined;
        if (!record || record.kind !== "record" || !document || document.conversationId !== conversationId || document.entityKind !== ref.entityKind ||
            document.entityId !== ref.entityId || document.schemaVersion !== ref.schemaVersion || document.sourceRevision !== ref.sourceRevision || ref.sourceRevision > manifest.recordSequence) conflict();
        total += Buffer.byteLength(record!.canonicalDocument);
        if (document!.entityKind === "control" && ![...state.events.values()].some(row => row.event.eventSequence <= manifest.eventSequence &&
            canonical(row.event) === canonical(document!.document))) conflict();
      }
      if (total > 16 * 1024 * 1024 || manifest.tombstones.some(row => row.sourceRevision > manifest.recordSequence)) conflict();
    }
    state.heads.set(conversationId, clone(head));
  }
  readCommand(commandId: string) { const row = this.state.commands.get(commandId); return row ? clone(row) : null; }
  readHistory(conversationId: string) {
    const historyHead = this.state.heads.get(conversationId), records: CloudLocalCommandHistoryRecord[] = [];
    if (historyHead && "manifestSha256" in historyHead.history) {
      const manifest = this.state.blobs.get(historyHead.history.manifestSha256)!.document as CloudLocalCommandHistoryManifest;
      for (const ref of manifest.records) records.push(clone(this.state.blobs.get(ref.sha256)!.document as CloudLocalCommandHistoryRecord));
    }
    return { complete: !!historyHead && "manifestSha256" in historyHead.history, historyHead: clone(historyHead ?? null), records };
  }
  assertTerminalConsistency(commandId: string, observed: { conversationId: string; entry: unknown }): void {
    const actual = this.state.commands.get(commandId), parsed = CloudBootCommandEntrySchema.safeParse(observed.entry);
    if (!actual || !parsed.success || ["queued", "dispatching"].includes(actual.entry.state) || actual.conversationId !== observed.conversationId ||
        !isDeepStrictEqual(actual.entry, parsed.data)) throw new FixtureRefusal("fixture_terminal_mismatch");
  }
  inspect() { return { source: "in-memory-fixture" as const, sealed: this.sealed !== null, mirroredSequence: this.state.through, commandCount: this.state.commands.size,
    batchCount: this.state.batches.size, headCount: this.state.heads.size, partCount: [...this.state.parts.values()].reduce((n, rows) => n + rows.size, 0),
    blobCount: this.state.blobs.size, compactEventCount: this.state.events.size, historyBytes: this.state.historyBytes }; }
  close(): void { this.closed = true; this.state = empty(); this.scope = null; this.sealed = null; }
}
