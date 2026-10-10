import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudCommandSnapshotSchema, CloudBootCommandClaimSchema, CloudBootCommandSnapshotSchema,
  type CloudCommandEngineRequest, type CloudCommandResult, type CloudQueuedPrompt } from "@zeros/protocol/cloud-commands";
import { CloudActorAuthorityRegistry } from "../agents/cloud-agent-lease";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { openSqlite } from "../db/sqlite";
import { CloudCommandRuntime } from "../cloud-command-runtime";
import { CloudLocalCommandMirrorBatchSchema, canonicalCloudLocalCommandHistoryJson,
  type CloudLocalCommandHistoryRecord } from "@zeros/protocol/cloud-local-mirror";
import { createHash } from "node:crypto";
import type { CloudLocalCommandHistoryDocument } from "../cloud-local-command-queue-history";

const temporary: string[] = [];
const handles: CloudLocalCommandQueue[] = [];
const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 3,
  engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
const actor = { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 2,
  role: "owner" as const, fingerprint: "a".repeat(64) };
const actorSessionId = randomUUID();
const now = 1_000_000;
function fixture(options: { file?: string; writer?: typeof scope; limits?: ConstructorParameters<typeof CloudLocalCommandQueue>[0]["limits"];
  selectExecution?: ConstructorParameters<typeof CloudLocalCommandQueue>[0]["selectExecution"];
  captureHistory?: ConstructorParameters<typeof CloudLocalCommandQueue>[0]["captureHistory"] } = {}) {
  const writer = options.writer ?? scope;
  const directory = options.file ? null : mkdtempSync(join(tmpdir(), "zeros-local-queue-"));
  if (directory) temporary.push(directory);
  const file = options.file ?? join(directory!, "queue.sqlite");
  const engineLive = vi.fn(() => true);
  const actors = new CloudActorAuthorityRegistry({ scope: writer, engineLive, time: { wall: () => now, monotonic: () => 0 } });
  actors.confirm({ scope: writer, actor, actorSessionId, authorityEpoch: 1, confirmedUntilMs: now + 9_000,
    fundingConsentVersion: 1, fundingGrant: { kind: "owner" } });
  const history = vi.fn(() => ({ recordSequence: 7, eventSequence: 12 }));
  const ready = vi.fn(() => true);
  const queue = new CloudLocalCommandQueue({ file, scope: writer, actors, engineLive, now: () => now, history, ready, limits: options.limits,
    ...(options.selectExecution ? { selectExecution: options.selectExecution } : {}),
    ...(options.captureHistory ? { captureHistory: options.captureHistory } : {}) });
  handles.push(queue);
  const request = (input: CloudCommandEngineRequest, epoch = writer.writerEpoch, session = actorSessionId) =>
    queue.handle(input, { writerEpoch: epoch, actorSessionId: session });
  const snapshot = (conversationId = "chat") => CloudCommandSnapshotSchema.parse(request({ kind: "snapshot", conversationId }));
  const payload = (userMessageId = randomUUID()): CloudQueuedPrompt => ({ agentId: "claude", userMessageId, modeRevision: 0,
    model: "claude-sonnet-4-6", permissionMode: "default", prompt: [{ type: "text", text: "synthetic queue fixture" }] });
  const enqueue = (value = payload(), expectedRevision = snapshot().revision, conversationId = "chat") => ({ kind: "mutate" as const,
    mutation: { conversationId, operationId: randomUUID(), expectedRevision,
      action: { kind: "enqueue" as const, commandId: randomUUID(), payload: value } }, admissionError: null });
  const claim = (conversationId = "chat", claimId: string = randomUUID(), executionId: string = randomUUID()) =>
    CloudBootCommandClaimSchema.nullable().parse(request({ kind: "claim", conversationId, claimId, executionId }));
  return { queue, file, writer, actors, engineLive, history, ready, request, snapshot, payload, enqueue, claim };
}
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

type Capture = NonNullable<ConstructorParameters<typeof CloudLocalCommandQueue>[0]["captureHistory"]>;
function historyDocument(kind: "record" | "manifest", value: unknown): CloudLocalCommandHistoryDocument {
  const canonicalDocument = canonicalCloudLocalCommandHistoryJson(value), data = Buffer.from(canonicalDocument);
  const sha256 = createHash("sha256").update(data).digest("hex"), count = Math.ceil(data.length / (128 * 1024));
  return { kind, sha256, canonicalDocument, parts: Array.from({ length: count }, (_, index) => ({ version: 1, kind, sha256,
    index, count, bytes: data.length, data: data.subarray(index * 128 * 1024, (index + 1) * 128 * 1024).toString("base64") })) };
}
function canonicalCapture(records: (conversationId: string) => CloudLocalCommandHistoryRecord[] = conversationId => [{
  version: 1, conversationId, entityKind: "chat", entityId: conversationId, schemaVersion: 1, sourceRevision: 7,
  document: { version: 1, chat: { id: conversationId } },
}]): Capture {
  return input => {
    const values = records(input.conversationId), documents = values.map(record => historyDocument("record", record));
    const manifest = { version: 1 as const, snapshot: "full" as const, scope: input.scope, conversationId: input.conversationId,
      restoreRevision: input.restoreRevision, deleted: false, tombstones: [], recordSequence: 7, eventSequence: 12, source: input.source,
      records: values.map((record, index) => ({ entityKind: record.entityKind, entityId: record.entityId,
        schemaVersion: 1 as const, sourceRevision: 7, sha256: documents[index]!.sha256 })) };
    const saved = historyDocument("manifest", manifest);
    return { nativeResult: input.nativeResult, manifest, documents: [...documents, saved], historyHead: { originWriterEpoch: input.scope.writerEpoch,
      source: input.source, deleted: false, history: { restoreRevision: input.restoreRevision, recordSequence: 7, eventSequence: 12, manifestSha256: saved.sha256 } } };
  };
}
function settleCanonical(f: ReturnType<typeof fixture>, conversationId = "chat") {
  f.request(f.enqueue(f.payload(), f.snapshot(conversationId).revision, conversationId));
  const claim = f.claim(conversationId)!;
  f.request({ kind: "settle", result: { commandId: claim.commandId, claimId: claim.claimId, state: "succeeded",
    resultCode: null, result: { version: 1 } } });
  return claim;
}
function acknowledge(f: ReturnType<typeof fixture>, batch = f.queue.peekMirrorBatch()!) {
  f.queue.acknowledgeMirror({ version: 1, writerEpoch: f.writer.writerEpoch, batchId: batch.batchId, through: batch.through });
}
function stageCompact(f: ReturnType<typeof fixture>, claim: NonNullable<ReturnType<ReturnType<typeof fixture>["claim"]>>, changedCommandId?: string) {
  const snapshot = f.snapshot(claim.conversationId), document = canonicalCloudLocalCommandHistoryJson({ conversationId: claim.conversationId,
    revision: snapshot.revision, paused: snapshot.paused, originWriterEpoch: f.writer.writerEpoch, event: { version: 1, eventSequence: 13,
      executionId: claim.executionId, commandId: changedCommandId ?? claim.commandId, turnId: claim.payload.userMessageId,
      frame: { id: randomUUID(), type: "AGENT_QUESTION_SETTLED", timestamp: now, source: "engine", agentId: claim.payload.agentId,
        chatId: claim.conversationId, questionId: randomUUID(), outcome: { outcome: "dismissed" } } } });
  const db = openSqlite(f.file);
  try { db.prepare("INSERT INTO local_command_outbox_jobs(conversation_id,priority,document,bytes) VALUES(?,0,?,?)")
    .run(claim.conversationId,document,Buffer.byteLength(document)); }
  finally { db.close(); }
}

type MutationPublication = { conversationId: string; mutationId: string; operation: "edit" | "delete" | "prune" | "repair";
  deleted: boolean; recordSequence: number; eventSequence: number };
const historyMutation = (operation: MutationPublication["operation"] = "edit"): MutationPublication => ({
  conversationId: "chat", mutationId: randomUUID(), operation, deleted: operation === "delete", recordSequence: 7, eventSequence: 12,
});
describe("FULL accepted history mutation publication", () => {
  it("reads only the durable acknowledged mirror cursor without materializing local work", () => {
    const f = fixture(); expect(f.queue.mirroredSequence).toBe(0);
    f.request(f.enqueue()); const first = f.queue.peekMirrorBatch()!;
    expect(f.queue.mirroredSequence).toBe(0); acknowledge(f, first);
    expect(f.queue.mirroredSequence).toBe(first.through);
    f.queue.publishHistoryMutation(historyMutation());
    expect(f.queue.mirroredSequence).toBe(first.through);
    const next = f.queue.peekMirrorBatch()!; expect(next.through).toBeGreaterThan(first.through);
    expect(f.queue.mirroredSequence).toBe(first.through); acknowledge(f, next);
    f.queue.close(); const reopened = fixture({ file: f.file });
    expect(reopened.queue.mirroredSequence).toBe(next.through);
  });
  it.each(["", "-1", "1.5", "garbage", "Infinity", "9007199254740992"])("refuses corrupt ACK metadata %s instead of inventing a zero cursor", value => {
    const f = fixture(), db = openSqlite(f.file);
    try { db.prepare("INSERT INTO local_command_metadata(key,value) VALUES('mirrorHead',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value); }
    finally { db.close(); }
    expect(() => f.queue.mirroredSequence).toThrow("command_storage_unavailable");
  });
  it("does not expose a confirmed cursor from a closed or inactive original ledger", () => {
    const f = fixture(); f.engineLive.mockReturnValue(false);
    expect(() => f.queue.mirroredSequence).toThrow("engine_authority_rejected");
    f.engineLive.mockReturnValue(true); f.queue.close();
    expect(() => f.queue.mirroredSequence).toThrow("engine_authority_rejected");
  });
  it.each(["edit", "delete", "prune", "repair"] as const)("publishes the accepted %s source without fabricating native intent", operation => {
    const f = fixture(), input = historyMutation(operation), head = f.queue.publishHistoryMutation(input);
    expect(head).toEqual({ originWriterEpoch: scope.writerEpoch, source: { kind: "mutation", mutationId: input.mutationId, operation },
      deleted: input.deleted, history: { restoreRevision: 1, recordSequence: 7, eventSequence: 12, incompleteReason: "capture_unavailable" } });
    expect(f.queue.currentHistoryHead("chat")).toEqual(head);
    expect(f.queue.mirrorDrained()).toBe(false);
    const batch = f.queue.peekMirrorBatch()!;
    expect(CloudLocalCommandMirrorBatchSchema.parse(batch).changes).toEqual([expect.objectContaining({ conversationId: "chat", historyHead: head })]);
    expect(batch.changes[0]!.entry).toBeUndefined(); expect(batch.changes[0]!.intent).toBeUndefined();
    acknowledge(f, batch); expect(f.queue.mirrorDrained()).toBe(true);
    expect(f.snapshot().receipts).toEqual([]);
  });
  it("retains mutation identity before ACK and fences a complete command head without changing its audit", () => {
    const f = fixture({ captureHistory: canonicalCapture() }); settleCanonical(f);
    const audit = f.snapshot().receipts[0]!, previous = f.queue.currentHistoryHead("chat")!, input = historyMutation("delete");
    const head = f.queue.publishHistoryMutation(input);
    expect(head.history.restoreRevision).toBe(previous.history.restoreRevision + 1);
    expect(head).toMatchObject({ deleted: true, source: { kind: "mutation" }, history: { incompleteReason: "capture_unavailable" } });
    expect(f.snapshot().receipts[0]).toEqual(audit);
    const db = openSqlite(f.file, { readonly: true });
    try { expect(db.prepare("SELECT count(*) AS n FROM local_command_history_documents").get()).toEqual({ n: 2 }); }
    finally { db.close(); }
    const batch = f.queue.peekMirrorBatch()!;
    expect(batch.changes.some(change => canonicalCloudLocalCommandHistoryJson(change.historyHead ?? null) === canonicalCloudLocalCommandHistoryJson(head))).toBe(true);
    expect(Math.max(...batch.changes.map(change => change.historyHead?.history.restoreRevision ?? 0))).toBe(head.history.restoreRevision);
  });
  it("makes an exact accepted mutation retry durable without regressing a later current head", () => {
    const f = fixture(), original = historyMutation(), saved = f.queue.publishHistoryMutation(original);
    const later = f.queue.publishHistoryMutation(historyMutation("delete")), batch = f.queue.peekMirrorBatch()!;
    expect(f.queue.publishHistoryMutation(original)).toEqual(saved);
    expect(f.queue.peekMirrorBatch()).toEqual(batch); expect(f.queue.currentHistoryHead("chat")).toEqual(later);
    acknowledge(f, batch); f.queue.close();
    const reopened = fixture({ file: f.file });
    expect(reopened.queue.publishHistoryMutation(original)).toEqual(saved);
    expect(reopened.queue.currentHistoryHead("chat")).toEqual(later); expect(reopened.queue.mirrorDrained()).toBe(true);
  });
  it.each(["conversation", "operation", "deleted", "recordSequence", "eventSequence"])("refuses changed %s under an immutable mutation ID", field => {
    const f = fixture(), original = historyMutation(), saved = f.queue.publishHistoryMutation(original);
    const changed = { ...original, ...(field === "conversation" ? { conversationId: "another-chat" } : field === "operation" ? { operation: "repair" as const } :
      field === "deleted" ? { deleted: true } : { [field]: original[field as "recordSequence" | "eventSequence"] + 1 }) };
    expect(() => f.queue.publishHistoryMutation(changed)).toThrow("command_conflict");
    expect(f.queue.currentHistoryHead("chat")).toEqual(saved);
  });
  it.each(["recordSequence", "eventSequence"] as const)("does not publish unconfirmed %s heads", field => {
    const f = fixture(), input = historyMutation();
    expect(() => f.queue.publishHistoryMutation({ ...input, [field]: input[field] + 1 })).toThrow("command_conflict");
    expect(f.queue.currentHistoryHead("chat")).toBeNull(); expect(f.queue.mirrorDrained()).toBe(true);
  });
  it("rolls back head, identity and staged publication if the FULL outbox write fails", () => {
    const f = fixture(), input = historyMutation(), db = openSqlite(f.file);
    try {
      db.exec("CREATE TRIGGER reject_mutation_job BEFORE INSERT ON local_command_outbox_jobs BEGIN SELECT RAISE(ABORT,'synthetic storage refusal'); END");
      expect(() => f.queue.publishHistoryMutation(input)).toThrow("command_storage_unavailable");
      expect(f.queue.currentHistoryHead("chat")).toBeNull(); expect(f.queue.mirrorDrained()).toBe(true);
      db.exec("DROP TRIGGER reject_mutation_job");
      expect(f.queue.publishHistoryMutation(input).history.restoreRevision).toBe(1);
    } finally { db.close(); }
  });
  it.each(["fenced", "sealed", "lost-engine"] as const)("refuses new mutation publication after %s", state => {
    const f = fixture(), input = historyMutation();
    if (state === "fenced") f.queue.fenceAcceptance();
    if (state === "sealed") { const db = openSqlite(f.file); try {
      db.prepare("INSERT INTO local_command_metadata(key,value) VALUES('sealedWriter',?)").run(scope.writerEpoch);
    } finally { db.close(); } }
    if (state === "lost-engine") f.engineLive.mockReturnValue(false);
    expect(() => f.queue.publishHistoryMutation(input)).toThrow(state === "lost-engine" ? "engine_authority_rejected" : "cloud_command_writer_retired");
  });
  it("reserves compact-control staging space before acknowledging another mutation", () => {
    const f = fixture({ limits: { pending: 1, historyJobs: 5 } }); f.queue.publishHistoryMutation(historyMutation());
    expect(() => f.queue.publishHistoryMutation(historyMutation("repair"))).toThrow("command_limit");
    expect(f.queue.currentHistoryHead("chat")!.history.restoreRevision).toBe(1);
  });
});

describe("passive FULL history read revision", () => {
  it("starts at zero, advances for exact current-head changes and preserves exact mutation retries", () => {
    const f = fixture(), input = historyMutation();
    expect(f.queue.historyReadRevision).toBe(0);
    const saved = f.queue.publishHistoryMutation(input);
    expect(f.queue.historyReadRevision).toBe(1);
    expect(f.queue.publishHistoryMutation(input)).toEqual(saved);
    expect(f.queue.historyReadRevision).toBe(1);
    f.queue.publishHistoryMutation({ ...historyMutation(), conversationId: "sibling" });
    expect(f.queue.historyReadRevision).toBe(2);
    const peek = vi.spyOn(f.queue, "peekMirrorBatch");
    expect(f.queue.historyReadRevision).toBe(2); expect(peek).not.toHaveBeenCalled();
    const batch = f.queue.peekMirrorBatch()!; acknowledge(f, batch);
    expect(f.queue.historyReadRevision).toBe(2);
    f.queue.close(); const reopened = fixture({ file: f.file });
    expect(reopened.queue.historyReadRevision).toBe(2);
  });
  it("keeps an identical installed head inert and commits its counter with the changed head", () => {
    const f = fixture(), saved = f.queue.publishHistoryMutation(historyMutation());
    const store = f.queue as unknown as { db: ReturnType<typeof openSqlite>;
      saveHistoryHead(conversationId: string, head: typeof saved): void };
    store.db.transaction(() => store.saveHistoryHead("chat", saved))();
    expect(f.queue.historyReadRevision).toBe(1);
    expect(() => store.db.transaction(() => {
      store.saveHistoryHead("chat", { ...saved, history: { ...saved.history, restoreRevision: saved.history.restoreRevision + 1 } });
      throw new Error("synthetic rollback");
    })()).toThrow("synthetic rollback");
    expect(f.queue.historyReadRevision).toBe(1); expect(f.queue.currentHistoryHead("chat")).toEqual(saved);
  });
  it("advances on native terminal, quota feedback and uncertain predecessor rollover without mirroring side effects", () => {
    const f = fixture({ captureHistory: canonicalCapture() }); settleCanonical(f);
    const completed = f.queue.historyReadRevision;
    expect(completed).toBeGreaterThan(0);
    const batch = f.queue.peekMirrorBatch()!, part = batch.changes.find(change => change.historyPart)?.historyPart;
    expect(part).toBeDefined();
    f.queue.acknowledgeMirror({ version: 1, writerEpoch: scope.writerEpoch, batchId: batch.batchId, through: batch.through,
      historyLimits: [{ conversationId: "chat", sha256: part!.sha256 }] });
    expect(f.queue.historyReadRevision).toBe(completed + 1);
    f.request(f.enqueue(f.payload(), f.snapshot("pending").revision, "pending"));
    const previous = f.queue.historyReadRevision;
    f.queue.close(); const reopened = fixture({ file: f.file, writer: { ...scope, writerEpoch: randomUUID(), bootId: randomUUID(), generation: 4 } });
    expect(reopened.queue.currentHistoryHead("pending")!.history).toMatchObject({ incompleteReason: "recovery_uncertain" });
    expect(reopened.queue.historyReadRevision).toBe(previous + 1);
  });
  it("seeds retained heads from an older ledger before recovery and persists the positive seed", () => {
    const f = fixture(); f.queue.publishHistoryMutation(historyMutation());
    f.queue.close(); const db = openSqlite(f.file);
    try { db.prepare("DELETE FROM local_command_metadata WHERE key='historyReadRevision'").run(); }
    finally { db.close(); }
    const restored = fixture({ file: f.file });
    expect(restored.queue.historyReadRevision).toBe(1);
    restored.queue.publishHistoryMutation(historyMutation("delete"));
    expect(restored.queue.historyReadRevision).toBe(2);
    restored.queue.close(); expect(fixture({ file: f.file }).queue.historyReadRevision).toBe(2);
  });
  it("rolls back the current-head revision when its staged publication fails", () => {
    const f = fixture(), db = openSqlite(f.file);
    try {
      db.exec("CREATE TRIGGER reject_history_revision_job BEFORE INSERT ON local_command_outbox_jobs BEGIN SELECT RAISE(ABORT,'synthetic storage refusal'); END");
      expect(() => f.queue.publishHistoryMutation(historyMutation())).toThrow("command_storage_unavailable");
      expect(f.queue.historyReadRevision).toBe(0); expect(f.queue.currentHistoryHead("chat")).toBeNull();
      db.exec("DROP TRIGGER reject_history_revision_job");
      f.queue.publishHistoryMutation(historyMutation()); expect(f.queue.historyReadRevision).toBe(1);
    } finally { db.close(); }
  });
  it.each(["", "-1", "1.5", "garbage", "Infinity", "9007199254740992", "01", "1e2"])("refuses corrupt history read revision %s", value => {
    const f = fixture(), db = openSqlite(f.file);
    try { db.prepare("INSERT INTO local_command_metadata(key,value) VALUES('historyReadRevision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value); }
    finally { db.close(); }
    expect(() => f.queue.historyReadRevision).toThrow("command_storage_unavailable");
    expect(() => f.queue.publishHistoryMutation(historyMutation())).toThrow("command_storage_unavailable");
    expect(f.queue.currentHistoryHead("chat")).toBeNull();
    f.queue.close(); expect(() => fixture({ file: f.file })).toThrow("command_storage_unavailable");
  });
  it("rejects revision overflow without committing a new head or outbox", () => {
    const f = fixture(), db = openSqlite(f.file);
    try { db.prepare("INSERT INTO local_command_metadata(key,value) VALUES('historyReadRevision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(Number.MAX_SAFE_INTEGER)); }
    finally { db.close(); }
    expect(f.queue.historyReadRevision).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => f.queue.publishHistoryMutation(historyMutation())).toThrow("command_storage_unavailable");
    expect(f.queue.historyReadRevision).toBe(Number.MAX_SAFE_INTEGER);
    expect(f.queue.currentHistoryHead("chat")).toBeNull(); expect(f.queue.mirrorDrained()).toBe(true);
  });
  it("does not invent a fresh zero after metadata loss from a live populated ledger", () => {
    const f = fixture(); f.queue.publishHistoryMutation(historyMutation());
    const db = openSqlite(f.file);
    try { db.prepare("DELETE FROM local_command_metadata WHERE key='historyReadRevision'").run(); }
    finally { db.close(); }
    expect(() => f.queue.historyReadRevision).toThrow("command_storage_unavailable");
  });
  it("rejects a canonical zero counter on a populated ledger", () => {
    const f = fixture(); f.queue.publishHistoryMutation(historyMutation());
    const db = openSqlite(f.file);
    try { db.prepare("UPDATE local_command_metadata SET value='0' WHERE key='historyReadRevision'").run(); }
    finally { db.close(); }
    expect(() => f.queue.historyReadRevision).toThrow("command_storage_unavailable");
    f.queue.close(); expect(() => fixture({ file: f.file })).toThrow("command_storage_unavailable");
  });
  it("refuses an identical install when its stored counter is corrupt", () => {
    const f = fixture(), saved = f.queue.publishHistoryMutation(historyMutation());
    const store = f.queue as unknown as { db: ReturnType<typeof openSqlite>;
      saveHistoryHead(conversationId: string, head: typeof saved): void };
    store.db.prepare("UPDATE local_command_metadata SET value='garbage' WHERE key='historyReadRevision'").run();
    expect(() => store.db.transaction(() => store.saveHistoryHead("chat", saved))()).toThrow("command_storage_unavailable");
    expect(f.queue.currentHistoryHead("chat")).toEqual(saved);
  });
  it("refuses passive access after original queue closure or engine authority loss", () => {
    const f = fixture(); f.engineLive.mockReturnValue(false);
    expect(() => f.queue.historyReadRevision).toThrow("engine_authority_rejected");
    f.engineLive.mockReturnValue(true); f.queue.close();
    expect(() => f.queue.historyReadRevision).toThrow("engine_authority_rejected");
  });
});

describe("FULL canonical history sink", () => {
  it("never sequences a complete head past an earlier same-chat part that does not fit", () => {
    const f = fixture({ captureHistory: canonicalCapture(conversationId => [{ version: 1, conversationId, entityKind: "chat",
      entityId: conversationId, schemaVersion: 1, sourceRevision: 7, document: { text: "x".repeat(conversationId === "a" ? 485_000 : 350_000) } }]) });
    settleCanonical(f, "a"); settleCanonical(f, "b");
    const batch = f.queue.peekMirrorBatch()!, parts = batch.changes.filter(change => change.conversationId === "b" && change.historyPart);
    expect(parts.length).toBeGreaterThan(0);
    expect(batch.changes.some(change => change.conversationId === "b" && change.historyHead && "manifestSha256" in change.historyHead.history)).toBe(false);
    expect(f.queue.peekMirrorBatch()).toEqual(batch);
  });
  it("selects another chat's staged jobs beyond a long older chat's prefix", () => {
    const f = fixture({ captureHistory: canonicalCapture(conversationId => Array.from({ length: conversationId === "a" ? 130 : 1 }, (_, index) => ({
      version: 1, conversationId, entityKind: "message", entityId: `message-${index}`, schemaVersion: 1, sourceRevision: 7, document: { text: "Synthetic" },
    }))) });
    settleCanonical(f, "a"); settleCanonical(f, "b");
    const batch = f.queue.peekMirrorBatch()!;
    expect(batch.changes.some(change => change.conversationId === "b" && change.historyPart)).toBe(true);
    expect(batch.changes.filter(change => change.conversationId === "a" && change.historyPart)).toHaveLength(4);
  });
  it("retains canonical bytes once and stages references rather than another encoded copy", () => {
    const f = fixture({ captureHistory: canonicalCapture() }); settleCanonical(f);
    const db = openSqlite(f.file, { readonly: true });
    try {
      const jobs = db.prepare("SELECT document FROM local_command_outbox_jobs").all() as { document: string }[];
      expect(jobs.filter(job => JSON.parse(job.document).historyPart).every(job => !Object.hasOwn(JSON.parse(job.document).historyPart, "data"))).toBe(true);
    } finally { db.close(); }
    const batch = f.queue.peekMirrorBatch()!;
    expect(batch.changes.filter(change => change.historyPart)).toHaveLength(2);
  });
  it("revalidates a retained content-addressed record before using it in a later manifest", () => {
    const capture = canonicalCapture(); let calls = 0;
    const f = fixture({ captureHistory: input => {
      const saved = capture(input); calls++;
      return calls === 1 ? saved : { ...saved, documents: saved.documents.filter(document => document.kind === "manifest") };
    } });
    settleCanonical(f); const db = openSqlite(f.file);
    try {
      const record = db.prepare("SELECT document FROM local_command_history_documents WHERE kind='record'").get() as { document: string };
      const altered = JSON.parse(record.document); altered.document.chat.id = "else";
      const bytes = canonicalCloudLocalCommandHistoryJson(altered);
      db.prepare("UPDATE local_command_history_documents SET document=?,bytes=? WHERE kind='record'").run(bytes, Buffer.byteLength(bytes));
      settleCanonical(f);
      expect(f.queue.currentHistoryHead("chat")!.history).toMatchObject({ incompleteReason: "capture_conflict" });
      expect(f.snapshot().receipts).toHaveLength(2);
      expect(f.snapshot().receipts.every(receipt => receipt.state === "succeeded")).toBe(true);
    } finally { db.close(); }
  });
  it("refuses invented known heads in an incomplete capture while keeping the native outcome", () => {
    const f = fixture({ captureHistory: input => ({ nativeResult: input.nativeResult, documents: [], historyHead: {
      originWriterEpoch: input.scope.writerEpoch, source: input.source, deleted: false,
      history: { restoreRevision: input.restoreRevision, recordSequence: 99, eventSequence: 12, incompleteReason: "history_limit" },
    } }) });
    settleCanonical(f);
    expect(f.queue.currentHistoryHead("chat")!.history).toMatchObject({ recordSequence: 7, eventSequence: 12, incompleteReason: "capture_conflict" });
    expect(f.snapshot().receipts[0]!.state).toBe("succeeded");
  });
  it.each(["source", "native-result", "scope", "parts", "digest"])("settles honestly on %s capture corruption without retaining partial artifacts", kind => {
    const capture = canonicalCapture(), f = fixture({ captureHistory: input => {
      const saved = structuredClone(capture(input));
      if (kind === "source" && saved.historyHead.source.kind === "command") saved.historyHead.source.commandId = randomUUID();
      if (kind === "scope") saved.manifest!.scope.workspaceId = randomUUID();
      return { ...saved, nativeResult: kind === "native-result" ? { version: 1, replayed: true } : saved.nativeResult,
        documents: saved.documents.map((document, index) => index === 0 && kind === "parts" ? { ...document, parts: [] } :
          index === 0 && kind === "digest" ? { ...document, sha256: "a".repeat(64) } : document) };
    } });
    settleCanonical(f);
    expect(f.queue.currentHistoryHead("chat")!.history).toMatchObject({ incompleteReason: "capture_conflict" });
    const db = openSqlite(f.file, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM local_command_history_documents").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM local_command_outbox_jobs").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT state,result FROM local_commands").get()).toMatchObject({ state: "succeeded", result: '{"version":1}' });
    } finally { db.close(); }
  });
  it.each(["historyBytes", "historyJobs"] as const)("preserves the actual terminal when %s capacity is exhausted", limit => {
    const f = fixture({ captureHistory: canonicalCapture(), limits: { [limit]: limit === "historyBytes" ? 16 * 1024 * 1024 : 1 } });
    f.request(f.enqueue()); const claim = f.claim()!;
    if (limit === "historyBytes") {
      // A capacity loss after durable admission cannot erase a known native
      // outcome. All pressure blobs themselves remain valid canonical records.
      const db = openSqlite(f.file);
      try { for (let index = 0; index < 34; index++) {
        const saved = historyDocument("record", { version: 1, conversationId: "pressure", entityKind: "message", entityId: `pressure-${index}`,
          schemaVersion: 1, sourceRevision: 0, document: { text: "x".repeat(500_000) } });
        db.prepare("INSERT INTO local_command_history_documents VALUES(?,?,?,?)").run(saved.sha256,saved.kind,saved.canonicalDocument,Buffer.byteLength(saved.canonicalDocument));
      } } finally { db.close(); }
    }
    f.request({ kind: "settle", result: { commandId: claim.commandId, claimId: claim.claimId, state: "succeeded", resultCode: null, result: { version: 1 } } });
    expect(f.snapshot().receipts[0]).toMatchObject({ state: "succeeded", result: { version: 1 } });
    expect(f.queue.currentHistoryHead("chat")!.history).toMatchObject({ incompleteReason: "history_limit" });
  });
  it.each(["local_command_history_documents", "local_command_outbox_jobs", "local_command_history_heads"])("rolls back native settlement and all artifacts if %s commit fails", table => {
    const f = fixture({ captureHistory: canonicalCapture() }); f.request(f.enqueue()); const claim = f.claim()!, db = openSqlite(f.file);
    try {
      db.exec(`CREATE TRIGGER deny_history BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic'); END`);
      const result = { commandId: claim.commandId, claimId: claim.claimId, state: "succeeded" as const, resultCode: null, result: { version: 1 as const } };
      expect(() => f.request({ kind: "settle", result })).toThrow("command_storage_unavailable");
      expect(f.snapshot().pending[0]!.state).toBe("dispatching");
      for (const name of ["local_command_history_documents", "local_command_outbox_jobs", "local_command_history_heads"])
        expect(db.prepare(`SELECT count(*) AS n FROM ${name}`).get()).toEqual({ n: 0 });
      db.exec("DROP TRIGGER deny_history"); f.request({ kind: "settle", result });
      expect(f.snapshot().receipts[0]!.state).toBe("succeeded");
    } finally { db.close(); }
  });
  it("rolls back job dequeue and sequence assignment together with a failed flight insert", () => {
    const f = fixture({ captureHistory: canonicalCapture() }); settleCanonical(f); const db = openSqlite(f.file);
    try {
      const jobs = db.prepare("SELECT * FROM local_command_outbox_jobs").all(), journal = db.prepare("SELECT * FROM local_command_journal").all();
      db.exec("CREATE TRIGGER deny_flight BEFORE INSERT ON local_command_mirror_batches BEGIN SELECT RAISE(ABORT,'Synthetic'); END");
      expect(() => f.queue.peekMirrorBatch()).toThrow("command_storage_unavailable");
      expect(db.prepare("SELECT * FROM local_command_outbox_jobs").all()).toEqual(jobs);
      expect(db.prepare("SELECT * FROM local_command_journal").all()).toEqual(journal);
      db.exec("DROP TRIGGER deny_flight"); const batch = f.queue.peekMirrorBatch()!;
      expect(f.queue.peekMirrorBatch()).toEqual(batch); acknowledge(f, batch);
      expect(f.queue.mirrorDrained()).toBe(true);
    } finally { db.close(); }
  });
  it("rejects a staged complete head whose source disagrees with its retained manifest", () => {
    const f = fixture({ captureHistory: canonicalCapture() }); settleCanonical(f); const db = openSqlite(f.file);
    try {
      const saved = db.prepare("SELECT id,document FROM local_command_outbox_jobs WHERE json_extract(document,'$.historyHead') IS NOT NULL").get() as { id: number; document: string };
      const changed = JSON.parse(saved.document); changed.historyHead.source.commandId = randomUUID();
      const document = canonicalCloudLocalCommandHistoryJson(changed);
      db.prepare("UPDATE local_command_outbox_jobs SET document=?,bytes=? WHERE id=?").run(document, Buffer.byteLength(document), saved.id);
      expect(() => f.queue.peekMirrorBatch()).toThrow("command_storage_unavailable");
      expect(f.snapshot().receipts[0]).toMatchObject({ state: "succeeded", result: { version: 1 } });
      expect(db.prepare("SELECT count(*) AS n FROM local_command_mirror_batches").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
  it("commits quota feedback from the first partial flight as a newer head, keeping immutable native audit", () => {
    const f = fixture({ captureHistory: canonicalCapture(conversationId => [{ version: 1, conversationId, entityKind: "chat",
      entityId: conversationId, schemaVersion: 1, sourceRevision: 7, document: { text: "x".repeat(450_000) } }]) });
    settleCanonical(f); const before = f.queue.currentHistoryHead("chat")!, batch = f.queue.peekMirrorBatch()!;
    const rejected = batch.changes.find(change => change.historyPart)!.historyPart!.sha256;
    f.queue.acknowledgeMirror({ version: 1, writerEpoch: scope.writerEpoch, batchId: batch.batchId, through: batch.through,
      historyLimits: [{ conversationId: "chat", sha256: rejected }] });
    expect(f.queue.currentHistoryHead("chat")!.history).toMatchObject({ restoreRevision: before.history.restoreRevision + 1, incompleteReason: "history_limit" });
    const next = f.queue.peekMirrorBatch()!;
    expect(next.changes.some(change => change.historyPart || (change.historyHead && "manifestSha256" in change.historyHead.history))).toBe(false);
    const db = openSqlite(f.file, { readonly: true });
    try { expect(JSON.parse((db.prepare("SELECT history FROM local_commands").get() as { history: string }).history)).toEqual(before.history); }
    finally { db.close(); }
    f.queue.close(); const reopened = fixture({ file: f.file });
    expect(reopened.queue.peekMirrorBatch()).toEqual(next);
    expect(reopened.queue.currentHistoryHead("chat")!.history).toMatchObject({ incompleteReason: "history_limit" });
    expect(reopened.claim()).toBeNull();
  });
  it("prunes rejected older jobs even when a newer incomplete head already fences the chat", () => {
    const capture = canonicalCapture(conversationId => [{ version: 1, conversationId, entityKind: "chat", entityId: conversationId,
      schemaVersion: 1, sourceRevision: 7, document: { text: "x".repeat(450_000) } }]);
    let calls = 0;
    const f = fixture({ captureHistory: input => ++calls === 1 ? capture(input) : { nativeResult: input.nativeResult, documents: [],
      historyHead: { originWriterEpoch: input.scope.writerEpoch, source: input.source, deleted: false,
        history: { restoreRevision: input.restoreRevision, recordSequence: 7, eventSequence: 12, incompleteReason: "capture_unavailable" } } } });
    settleCanonical(f); settleCanonical(f); const before = f.queue.currentHistoryHead("chat")!, batch = f.queue.peekMirrorBatch()!;
    const rejected = batch.changes.find(change => change.historyPart)!.historyPart!.sha256;
    f.queue.acknowledgeMirror({ version: 1, writerEpoch: scope.writerEpoch, batchId: batch.batchId, through: batch.through,
      historyLimits: [{ conversationId: "chat", sha256: rejected }] });
    expect(f.queue.currentHistoryHead("chat")).toEqual(before);
    expect(f.queue.peekMirrorBatch()).toBeNull(); expect(f.queue.mirrorDrained()).toBe(true);
  });
  it("prunes only rejected old bundles while retaining a newer independent complete snapshot", () => {
    let calls = 0;
    const f = fixture({ captureHistory: input => {
      const index = ++calls;
      return canonicalCapture(conversationId => [{ version: 1, conversationId, entityKind: "chat", entityId: conversationId,
        schemaVersion: 1, sourceRevision: 7, document: { text: String(index).repeat(450_000) } }])(input);
    } });
    settleCanonical(f); settleCanonical(f); const before = f.queue.currentHistoryHead("chat")!, batch = f.queue.peekMirrorBatch()!;
    const rejected = batch.changes.find(change => change.historyPart)!.historyPart!.sha256;
    f.queue.acknowledgeMirror({ version: 1, writerEpoch: scope.writerEpoch, batchId: batch.batchId, through: batch.through,
      historyLimits: [{ conversationId: "chat", sha256: rejected }] });
    expect(f.queue.currentHistoryHead("chat")).toEqual(before);
    const next = f.queue.peekMirrorBatch()!;
    expect(next.changes.some(change => change.historyPart?.sha256 === rejected)).toBe(false);
    expect(next.changes.some(change => change.historyPart?.kind === "manifest" && change.historyPart.sha256 !==
      ("manifestSha256" in before.history ? before.history.manifestSha256 : null))).toBe(false);
    expect(next.changes.some(change => change.historyPart)).toBe(true);
  });
  it("rolls back feedback, head, jobs and ACK together when newer-head commit fails", () => {
    const f = fixture({ captureHistory: canonicalCapture() }); settleCanonical(f);
    const batch = f.queue.peekMirrorBatch()!, before = f.queue.currentHistoryHead("chat"), db = openSqlite(f.file);
    try {
      db.exec("CREATE TRIGGER deny_feedback BEFORE INSERT ON local_command_history_heads BEGIN SELECT RAISE(ABORT,'Synthetic'); END");
      const rejected = batch.changes.find(change => change.historyPart)!.historyPart!.sha256;
      const ack = { version: 1 as const, writerEpoch: scope.writerEpoch, batchId: batch.batchId, through: batch.through,
        historyLimits: [{ conversationId: "chat", sha256: rejected }] };
      expect(() => f.queue.acknowledgeMirror(ack)).toThrow("command_storage_unavailable");
      expect(f.queue.peekMirrorBatch()).toEqual(batch); expect(f.queue.currentHistoryHead("chat")).toEqual(before);
      expect(db.prepare("SELECT count(*) AS n FROM local_command_history_limits").get()).toEqual({ n: 0 });
      db.exec("DROP TRIGGER deny_feedback"); f.queue.acknowledgeMirror(ack);
      expect(f.queue.currentHistoryHead("chat")!.history).toMatchObject({ incompleteReason: "history_limit" });
    } finally { db.close(); }
  });
  it("caps cumulative full-conversation history at 16 MiB without losing or truncating the actual native result", () => {
    let calls = 0;
    const f = fixture({ captureHistory: input => canonicalCapture(conversationId => Array.from({ length: ++calls === 1 ? 38 : 41 }, (_, index) => ({
      version: 1, conversationId, entityKind: "message", entityId: `message-${index}`, schemaVersion: 1, sourceRevision: 7,
      document: { text: "x".repeat(410_000) },
    })))(input) });
    settleCanonical(f); const first = f.queue.currentHistoryHead("chat")!; expect(first.history).toHaveProperty("manifestSha256");
    settleCanonical(f);
    expect(f.queue.currentHistoryHead("chat")!.history).toMatchObject({ incompleteReason: "history_limit" });
    expect(f.queue.currentHistoryHead("chat")!.history.restoreRevision).toBeGreaterThan(first.history.restoreRevision);
    expect(f.snapshot().receipts.map(receipt => receipt.state)).toEqual(["succeeded", "succeeded"]);
    const db = openSqlite(f.file, { readonly: true });
    try { expect(db.prepare("SELECT count(*) AS n FROM local_command_history_documents").get()).toEqual({ n: 39 }); }
    finally { db.close(); }
  });
  it("assigns a genuine compact control using reserved capacity before same-chat bulk", () => {
    const f = fixture({ captureHistory: canonicalCapture(), limits: { pending: 1, journalEntries: 8 } });
    const claim = settleCanonical(f); stageCompact(f, claim);
    const batch = f.queue.peekMirrorBatch()!;
    expect(batch.changes.some(change => change.event?.commandId === claim.commandId)).toBe(true);
    expect(batch.changes.some(change => change.historyPart)).toBe(false);
    acknowledge(f, batch); expect(f.queue.mirrorDrained()).toBe(false);
    const next = f.queue.peekMirrorBatch()!;
    expect(next.changes.some(change => change.historyPart)).toBe(true);
  });
  it.each(["historyJobs", "historyBytes"] as const)("leaves independent %s staging capacity for compact controls", limit => {
    const f = fixture({ captureHistory: canonicalCapture(), limits: { pending: 1,
      ...(limit === "historyJobs" ? { historyJobs: 6 } : { historyBytes: 16 * 1024 * 1024 }) } });
    f.request(f.enqueue()); const claim = f.claim()!;
    if (limit === "historyBytes") {
      const saved = historyDocument("record", { version: 1, conversationId: "chat", entityKind: "message", entityId: "pressure",
        schemaVersion: 1, sourceRevision: 7, document: { text: "x".repeat(128_000) } });
      const document = canonicalCloudLocalCommandHistoryJson({ historyPart: saved.parts[0] }), bytes = Buffer.byteLength(document);
      const db = openSqlite(f.file);
      try {
        db.prepare("INSERT INTO local_command_history_documents VALUES(?,?,?,?)").run(saved.sha256,saved.kind,saved.canonicalDocument,Buffer.byteLength(saved.canonicalDocument));
        for (let index = 0; index <= Math.floor((16 * 1024 * 1024 - 512 * 1024) / bytes); index++)
          db.prepare("INSERT INTO local_command_outbox_jobs(conversation_id,priority,document,bytes) VALUES('chat',10,?,?)").run(document,bytes);
      } finally { db.close(); }
    }
    f.request({ kind: "settle", result: { commandId: claim.commandId, claimId: claim.claimId, state: "succeeded", resultCode: null, result: { version: 1 } } });
    expect(f.queue.currentHistoryHead("chat")!.history).toMatchObject({ incompleteReason: "history_limit" });
    stageCompact(f, claim);
    const batch = f.queue.peekMirrorBatch()!;
    expect(batch.changes.some(change => change.event?.commandId === claim.commandId)).toBe(true);
    if (limit === "historyJobs") expect(batch.changes.some(change => change.historyPart)).toBe(false);
    else expect(batch.changes.find(change => change.event)!.sequence).toBeLessThan(batch.changes.find(change => change.historyPart)!.sequence);
  });
  it("leaves a lost-ACK flight immutable and assigns another chat's new control before remaining parts", () => {
    const f = fixture({ captureHistory: canonicalCapture(conversationId => [{ version: 1, conversationId, entityKind: "chat",
      entityId: conversationId, schemaVersion: 1, sourceRevision: 7, document: { text: "x".repeat(450_000) } }]) });
    settleCanonical(f, "a"); const first = f.queue.peekMirrorBatch()!;
    const claim = settleCanonical(f, "b"); stageCompact(f, claim);
    expect(f.queue.peekMirrorBatch()).toEqual(first);
    acknowledge(f, first); const next = f.queue.peekMirrorBatch()!;
    const event = next.changes.find(change => change.event)!;
    expect(event.event!.commandId).toBe(claim.commandId);
    expect(event.sequence).toBeLessThan(next.changes.find(change => change.historyPart)!.sequence);
  });
  it("refuses a compact job whose command is not the recorded parent", () => {
    const f = fixture({ captureHistory: canonicalCapture() }), claim = settleCanonical(f);
    stageCompact(f, claim, randomUUID());
    expect(() => f.queue.peekMirrorBatch()).toThrow("command_storage_unavailable");
    expect(f.snapshot().receipts[0]!.state).toBe("succeeded");
  });
  it.each(["enqueue", "fork"] as const)("reserves the full artifact allowance before accepting %s", kind => {
    const f = fixture({ limits: { historyBytes: 16 * 1024 * 1024 - 1 } }), request = f.enqueue();
    const mutation = { ...request.mutation, action: { ...request.mutation.action, kind, payload: { ...request.mutation.action.payload,
      ...(kind === "fork" ? { operation: { version: 1 as const, kind: "fork" as const, strategy: "transcript" as const, sourceConversationId: "source" } } : {}) } } };
    expect(() => f.request({ ...request, mutation })).toThrow("command_limit");
    expect(f.snapshot().pending).toEqual([]);
    const db = openSqlite(f.file, { readonly: true });
    try { expect(db.prepare("SELECT count(*) AS n FROM local_command_operations").get()).toEqual({ n: 0 }); }
    finally { db.close(); }
  });
  it("counts all pending reservations and releases one only after removal or settlement", () => {
    const f = fixture({ captureHistory: canonicalCapture(), limits: { historyBytes: 32 * 1024 * 1024 + 64 * 1024 } });
    const first = f.enqueue(), second = f.enqueue(f.payload(), 0, "other"); f.request(first); f.request(second);
    expect(() => f.request(f.enqueue(f.payload(), 0, "third"))).toThrow("command_limit");
    f.request({ kind: "mutate", mutation: { conversationId: "chat", operationId: randomUUID(), expectedRevision: f.snapshot().revision,
      action: { kind: "edit", commandId: first.mutation.action.commandId, payload: first.mutation.action.payload } }, admissionError: null });
    expect(() => f.request(f.enqueue(f.payload(), 0, "third"))).toThrow("command_limit");
    f.request({ kind: "mutate", mutation: { conversationId: "other", operationId: randomUUID(), expectedRevision: f.snapshot("other").revision,
      action: { kind: "remove", commandId: second.mutation.action.commandId } }, admissionError: null });
    f.request(f.enqueue(f.payload(), 0, "third"));
    const claim = f.claim()!;
    f.request({ kind: "settle", result: { commandId: claim.commandId, claimId: claim.claimId, state: "succeeded", resultCode: null, result: { version: 1 } } });
    f.request(f.enqueue(f.payload(), 0, "fourth"));
    expect(f.snapshot("third").pending).toHaveLength(1); expect(f.snapshot("fourth").pending).toHaveLength(1);
  });
  it("includes retained CAS bytes in the next acceptance budget", () => {
    const f = fixture({ captureHistory: canonicalCapture(), limits: { pending: 1, historyBytes: 16 * 1024 * 1024 } });
    settleCanonical(f);
    expect(() => f.request(f.enqueue())).toThrow("command_limit");
    expect(f.snapshot().pending).toEqual([]); expect(f.snapshot().receipts[0]!.state).toBe("succeeded");
  });
  it("keeps immutable receipt and fresh interim/complete revisions distinct in the same flight", () => {
    const f = fixture({ captureHistory: canonicalCapture() }); settleCanonical(f);
    const first = f.queue.peekMirrorBatch()!, index = first.changes.findIndex(change => change.entry?.state === "succeeded");
    const receipt = first.changes[index]!, interim = first.changes[index + 1]!;
    expect(receipt.historyHead).toBeUndefined(); expect(receipt.history).toHaveProperty("manifestSha256");
    expect(interim.entry).toBeUndefined(); expect(interim.conversationId).toBe(receipt.conversationId);
    expect(interim.sequence).toBe(receipt.sequence + 1); expect(interim.revision).toBe(receipt.revision);
    expect(interim.historyHead).toMatchObject({ source: { kind: "command", commandId: receipt.entry!.commandId,
      executionId: receipt.entry!.executionId, intent: receipt.intent }, deleted: false,
      history: { restoreRevision: receipt.history!.restoreRevision - 1, incompleteReason: "capture_unavailable" } });
    expect(f.queue.currentHistoryHead("chat")!.history.restoreRevision).toBe(receipt.history!.restoreRevision);
  });
});

describe("engine-local cloud command ledger", () => {
  it("atomically retains verified canonical bytes, native outcome and ordered mirror jobs", () => {
    const captureHistory: NonNullable<ConstructorParameters<typeof CloudLocalCommandQueue>[0]["captureHistory"]> = input => {
      const record = { version: 1 as const, conversationId: input.conversationId, entityKind: "chat" as const,
        entityId: input.conversationId, schemaVersion: 1 as const, sourceRevision: 7, document: { version: 1, chat: { id: input.conversationId } } };
      const document = (kind: "record" | "manifest", value: unknown) => {
        const canonicalDocument = canonicalCloudLocalCommandHistoryJson(value), bytes = Buffer.byteLength(canonicalDocument);
        const sha256 = createHash("sha256").update(canonicalDocument).digest("hex");
        return { kind, sha256, canonicalDocument, parts: [{ version: 1 as const, kind, sha256, index: 0, count: 1, bytes,
          data: Buffer.from(canonicalDocument).toString("base64") }] };
      };
      const saved = document("record", record);
      const manifest = { version: 1 as const, snapshot: "full" as const, scope: input.scope, conversationId: input.conversationId,
        restoreRevision: input.restoreRevision, deleted: false, tombstones: [], recordSequence: 7, eventSequence: 12, source: input.source,
        records: [{ entityKind: record.entityKind, entityId: record.entityId, schemaVersion: 1 as const, sourceRevision: 7, sha256: saved.sha256 }] };
      const bundle = document("manifest", manifest);
      return { nativeResult: input.nativeResult, manifest, documents: [saved, bundle], historyHead: { originWriterEpoch: scope.writerEpoch,
        source: input.source, deleted: false, history: { restoreRevision: input.restoreRevision, recordSequence: 7, eventSequence: 12, manifestSha256: bundle.sha256 } } };
    };
    const f = fixture({ captureHistory }); f.request(f.enqueue()); const claim = f.claim()!;
    f.request({ kind: "settle", result: { commandId: claim.commandId, claimId: claim.claimId, state: "succeeded", resultCode: null, result: { version: 1 } } });
    const db = openSqlite(f.file, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM local_command_history_documents").get()).toEqual({ n: 2 });
      expect(db.prepare("SELECT state,result FROM local_commands").get()).toMatchObject({ state: "succeeded", result: '{"version":1}' });
    } finally { db.close(); }
    const batch = CloudLocalCommandMirrorBatchSchema.parse(f.queue.peekMirrorBatch());
    const parts = batch.changes.filter(change => change.historyPart);
    expect(parts).toHaveLength(2);
    const head = [...batch.changes].reverse().find(change => change.historyHead && "manifestSha256" in change.historyHead.history)!;
    expect(head.sequence).toBeGreaterThan(parts.at(-1)!.sequence);
    expect(f.queue.currentHistoryHead("chat")).toEqual(head.historyHead);
  });
  it("keeps a known native outcome mirrorable with honest incomplete history, including a terminal-first flight", () => {
    const f = fixture(); f.request(f.enqueue()); const claim = f.claim()!;
    const first = f.queue.peekMirrorBatch()!;
    f.queue.acknowledgeMirror({ version: 1, writerEpoch: scope.writerEpoch, batchId: first.batchId, through: first.through });
    const result = { version: 1 as const, terminal: { commandId: claim.commandId, conversationId: claim.conversationId,
      executionId: claim.executionId, turnId: claim.payload.userMessageId, agentId: claim.payload.agentId,
      status: "failed" as const, stopReason: null, failure: { kind: "auth-required" as const, stage: "prompt" as const, message: "Synthetic" } } };
    f.request({ kind: "settle", result: { commandId: claim.commandId, claimId: claim.claimId, state: "failed",
      resultCode: "cloud_provider_prompt_auth_required", result } });
    const batch = f.queue.peekMirrorBatch()!;
    expect(CloudLocalCommandMirrorBatchSchema.parse(batch)).toEqual(batch);
    expect(batch.changes[0]).toMatchObject({ entry: { payload: null, result },
      history: { restoreRevision: expect.any(Number), recordSequence: 7, eventSequence: 12, incompleteReason: "capture_unavailable" },
      historyHead: { source: { kind: "command", commandId: claim.commandId }, deleted: false } });
  });
  it("publishes an explicit newer recovery head without making inherited intent runnable", () => {
    const f = fixture(); f.request(f.enqueue()); f.queue.close(); const recovered = fixture({ file: f.file });
    const batch = recovered.queue.peekMirrorBatch()!;
    expect(CloudLocalCommandMirrorBatchSchema.parse(batch)).toEqual(batch);
    expect(batch.changes.find(change => change.entry?.state === "uncertain")).toMatchObject({
      history: { incompleteReason: "recovery_uncertain" }, historyHead: { source: { kind: "command" } } });
    expect(recovered.claim()).toBeNull();
  });
  it("chooses native ownership from the exact authorized pending intent before the FULL claim commit", () => {
    const executionId = randomUUID(), selectExecution = vi.fn(() => ({ executionId }));
    const f = fixture({ selectExecution }), send = f.enqueue(); f.request(send);
    const claim = f.claim()!;
    expect(claim.executionId).toBe(executionId);
    expect(selectExecution).toHaveBeenCalledWith(expect.objectContaining({ commandId: claim.commandId, claimId: claim.claimId,
      conversationId: "chat", payload: send.mutation.action.payload,
      actor: expect.objectContaining({ provenance: expect.objectContaining({ actorSessionId }) }) }));
    expect(f.snapshot().pending[0]!.executionId).toBe(executionId);
    const retry = f.claim("chat", claim.claimId, executionId);
    expect(retry).toEqual(claim); expect(selectExecution).toHaveBeenCalledTimes(1);
  });
  it("parks a start-fenced preclaim without writing a dispatch marker", () => {
    const selectExecution = vi.fn(() => null), f = fixture({ selectExecution });
    f.request(f.enqueue()); expect(f.claim()).toBeNull();
    expect(f.snapshot().pending[0]).toMatchObject({ state: "queued", executionId: null });
  });
  it("dispatches the FULL local queue's actor-bound execution rather than the actorless candidate", async () => {
    const executionId = randomUUID(), f = fixture({ selectExecution: () => ({ executionId }) });
    let execution: string | null = null;
    const prepare = vi.fn(async (claim: { executionId: string }) => { execution = claim.executionId; });
    const runtime = new CloudCommandRuntime({ request: async () => { throw new Error("Unexpected CP request"); },
      validate: () => {}, execution: () => execution, prepare, retire: async () => {},
      dispatch: async () => ({ state: "succeeded", resultCode: null }), cancel: async () => {}, changed: () => {} });
    try {
      runtime.installLocalQueue(f.queue); const send = f.enqueue();
      await runtime.handle({ kind: "mutate", mutation: send.mutation }, actorSessionId);
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
      expect(prepare.mock.calls[0]![0]).toMatchObject({ executionId });
      await vi.waitFor(async () => expect(await runtime.handle({ kind: "snapshot", conversationId: "chat" }, actorSessionId))
        .toMatchObject({ receipts: [{ state: "succeeded", executionId }] }));
    } finally { await runtime.close(); }
  });
  it("releases the exact unused preselection when Stop wins the FULL claim gap", async () => {
    const f = fixture({ selectExecution: () => ({ executionId: randomUUID() }) });
    const prepare = vi.fn(async () => {}), retire = vi.fn(async () => {});
    const runtime = new CloudCommandRuntime({ request: async () => { throw new Error("Unexpected CP request"); },
      validate: () => {}, execution: () => null, prepare, retire,
      dispatch: async () => ({ state: "succeeded", resultCode: null }), cancel: async () => {}, changed: () => {} });
    const original = f.queue.handle.bind(f.queue);
    vi.spyOn(f.queue, "handle").mockImplementation((value, context) => {
      const result = original(value, context);
      if ((value as { kind: string }).kind === "claim" && result)
        void runtime.handle({ kind: "stop", conversationId: "chat", operationId: randomUUID() }, actorSessionId);
      return result;
    });
    try {
      runtime.installLocalQueue(f.queue); const send = f.enqueue();
      await runtime.handle({ kind: "mutate", mutation: send.mutation }, actorSessionId);
      await vi.waitFor(() => expect(retire).toHaveBeenCalledTimes(1));
      expect(retire).toHaveBeenCalledWith(expect.objectContaining({ commandId: send.mutation.action.commandId }),
        { state: "cancelled", resultCode: "stopped_before_dispatch" });
      expect(prepare).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
  });
  it("uses the grant-free boot payload for native goal claims and refuses legacy delegation fields", () => {
    const f = fixture(), payload = { ...f.payload(), agentId: "codex", model: "qualified-model", permissionMode: "ask",
      operation: { version: 1, kind: "goal", action: "set", update: { objective: "Synthetic goal", tokenBudget: null } } };
    const send = f.enqueue(payload as CloudQueuedPrompt);
    const accepted = CloudBootCommandSnapshotSchema.parse(f.request(send));
    expect(accepted.pending[0]!.payload).toEqual(payload);
    const claim = CloudBootCommandClaimSchema.parse(f.request({ kind: "claim", conversationId: "chat",
      executionId: randomUUID(), claimId: randomUUID() }));
    expect(claim.payload).toEqual(payload);
    const other = fixture(), delegated = other.enqueue({ ...other.payload(), agentCredentialGrantId: randomUUID() });
    expect(() => other.request(delegated)).toThrow("invalid_command");
    expect(other.snapshot().pending).toEqual([]);
  });

  it("cuts the single engine pump over to the genuine FULL local ledger without a CP request", async () => {
    const f = fixture(), remote = vi.fn(async () => { throw new Error("Unexpected CP queue request"); });
    const dispatch = vi.fn(async () => ({ state: "succeeded" as const, resultCode: null }));
    let execution: string | null = null;
    const runtime = new CloudCommandRuntime({ request: remote, validate: () => {}, execution: () => execution,
      prepare: async claim => { execution = claim.executionId; }, retire: async () => { execution = null; },
      dispatch, cancel: async () => {}, changed: () => {} });
    try {
      runtime.installLocalQueue(f.queue);
      const send = f.enqueue();
      const accepted = await runtime.handle({ kind: "mutate", mutation: send.mutation }, actorSessionId);
      expect(accepted).toMatchObject({ pending: [{ commandId: send.mutation.action.commandId, state: "queued" }] });
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () => expect(await runtime.handle({ kind: "snapshot", conversationId: "chat" }, actorSessionId))
        .toMatchObject({ receipts: [{ state: "succeeded" }] }));
      expect(remote).not.toHaveBeenCalled();
      expect(() => runtime.installLocalQueue({ ...f.queue } as CloudLocalCommandQueue)).toThrow();
    } finally { await runtime.close(); }
  });
  it("commits the exact live payload, actor, operation and revision before acknowledging acceptance", () => {
    const f = fixture(), send = f.enqueue();
    const accepted = CloudCommandSnapshotSchema.parse(f.request(send));
    expect(accepted).toMatchObject({ revision: 1, replayed: false, pending: [{ commandId: send.mutation.action.commandId,
      state: "queued", payload: send.mutation.action.payload, executionId: null, generation: 3 }] });
    const db = openSqlite(f.file, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM local_command_operations").get()).toEqual({ n: 1 });
      const row = db.prepare("SELECT actor, writer_epoch, user_message_id FROM local_commands").get() as { actor: string; writer_epoch: string; user_message_id: string };
      expect(JSON.parse(row.actor)).toMatchObject({ actor, actorSessionId, authorityEpoch: 1, confirmedUntilMs: now + 9_000 });
      expect(row.writer_epoch).toBe(scope.writerEpoch);
      expect(row.user_message_id).toBe(send.mutation.action.payload.userMessageId);
    } finally { db.close(); }
  });

  it("uses cloud-only FULL commits without changing the shared Local SQLite connection", () => {
    const f = fixture(), db = openSqlite(f.file, { readonly: true });
    try { expect(f.queue.durability()).toEqual({ journalMode: "wal", synchronous: "full" }); }
    finally { db.close(); }
    const local = openSqlite(":memory:");
    try { local.pragma("synchronous = NORMAL"); expect(local.pragma("synchronous", { simple: true })).toBe(1); }
    finally { local.close(); }
  });

  it("resolves a lost acknowledgement with the same operation after context/revision changes, and rejects changed content or actor", () => {
    const f = fixture(), send = f.enqueue();
    f.request(send);
    const retried = f.request({ ...send, admissionError: "command_context_changed" });
    expect(retried).toMatchObject({ revision: 1, replayed: true });
    expect(f.snapshot().pending).toHaveLength(1);
    expect(() => f.request({ ...send, mutation: { ...send.mutation, action: { ...send.mutation.action, payload: f.payload() } } })).toThrow("command_conflict");
    const otherSession = randomUUID();
    f.actors.confirm({ scope, actor: { ...actor, deviceId: randomUUID(), fingerprint: "b".repeat(64) }, actorSessionId: otherSession,
      authorityEpoch: 1, confirmedUntilMs: now + 9_000, fundingConsentVersion: 1, fundingGrant: { kind: "owner" } });
    expect(() => f.request(send, scope.writerEpoch, otherSession)).toThrow("command_conflict");
  });

  it("preserves separate user-message uniqueness, FIFO and one active claim per conversation", () => {
    const f = fixture(), first = f.enqueue(); f.request(first);
    expect(() => f.request(f.enqueue(first.mutation.action.payload))).toThrow("command_conflict");
    const second = f.enqueue(); f.request(second);
    const a = f.claim()!;
    expect(a).toMatchObject({ commandId: first.mutation.action.commandId, dispatchAllowed: true, actor });
    expect(f.claim()).toBeNull();
    expect(f.claim("chat", a.claimId, a.executionId)).toEqual(a);
    f.request({ kind: "settle", result: { commandId: a.commandId, claimId: a.claimId, state: "succeeded", resultCode: null } });
    expect(f.claim()?.commandId).toBe(second.mutation.action.commandId);
  });

  it("marks dispatching durably before returning a claim and never redispatches after process recovery", () => {
    const f = fixture(); f.request(f.enqueue()); const claimed = f.claim()!;
    f.queue.close();
    const restarted = fixture({ file: f.file });
    expect(restarted.snapshot()).toMatchObject({ paused: true, pending: [], receipts: [{ commandId: claimed.commandId,
      state: "uncertain", executionId: claimed.executionId, resultCode: "engine_interrupted", payload: null }] });
    expect(restarted.claim("chat", claimed.claimId, claimed.executionId)).toBeNull();
    expect(() => restarted.request({ kind: "settle", result: { commandId: claimed.commandId, claimId: claimed.claimId,
      state: "succeeded", resultCode: null } })).toThrow("command_conflict");
  });

  it("quarantines queued-looking inherited rows without assuming a mirror gap proves non-execution", () => {
    const f = fixture(), send = f.enqueue(); f.request(send); f.queue.close();
    const writer = { ...scope, bootId: randomUUID(), writerEpoch: randomUUID(), engineInstanceId: randomUUID() };
    const restored = fixture({ file: f.file, writer });
    expect(restored.snapshot()).toMatchObject({ paused: true, pending: [], receipts: [{ commandId: send.mutation.action.commandId,
      state: "uncertain", resultCode: "queue_recovery_required" }] });
    const revision = restored.snapshot().revision;
    restored.request({ kind: "mutate", mutation: { conversationId: "chat", expectedRevision: revision,
      operationId: randomUUID(), action: { kind: "resume" } }, admissionError: null });
    expect(restored.claim()).toBeNull();
    expect(() => restored.request(send, scope.writerEpoch)).toThrow("cloud_command_writer_retired");
  });

  it("refuses an old unknown-ACK send on an empty replacement ledger rather than accepting it under a new epoch", () => {
    const old = fixture(), unknown = old.enqueue();
    const replacement = fixture({ writer: { ...scope, bootId: randomUUID(), writerEpoch: randomUUID(), engineInstanceId: randomUUID() } });
    expect(() => replacement.request(unknown, scope.writerEpoch)).toThrow("cloud_command_writer_retired");
    expect(replacement.snapshot().pending).toEqual([]);
  });

  it("checks actual funding consent at acceptance and delayed dispatch, while a disconnected but unexpired actor remains valid", () => {
    const f = fixture(), send = f.enqueue(); f.request(send);
    // The ledger has no socket dependency. Its recorded principal has a real
    // confirmed deadline and can be reauthorized after the socket goes away.
    expect(f.claim()?.dispatchAllowed).toBe(true);
    const other = fixture(), memberSession = randomUUID();
    other.actors.confirm({ scope, actor: { ...actor, userId: randomUUID(), role: "developer" }, actorSessionId: memberSession,
      authorityEpoch: 1, confirmedUntilMs: now + 9_000, fundingConsentVersion: null, fundingGrant: null });
    expect(() => other.request(other.enqueue(), scope.writerEpoch, memberSession)).toThrow("cloud_actor_authority_rejected");
    const revoked = fixture(); revoked.request(revoked.enqueue()); revoked.actors.revoke(actorSessionId);
    expect(revoked.claim()).toMatchObject({ dispatchAllowed: false });
    const stopped = fixture(); stopped.request(stopped.enqueue()); stopped.engineLive.mockReturnValue(false);
    expect(() => stopped.claim()).toThrow("engine_authority_rejected");
  });

  it("accepts a run-capable member only with the CP-confirmed versioned role grant", () => {
    const f = fixture(), memberSession = randomUUID(), member = { ...actor, userId: randomUUID(), role: "prompter" as const };
    f.actors.confirm({ scope, actor: member, actorSessionId: memberSession, authorityEpoch: 1, confirmedUntilMs: now + 9_000,
      fundingConsentVersion: 1, fundingGrant: { kind: "share", grantId: randomUUID(), grantRevision: 2 } });
    const send = f.enqueue();
    expect(f.request(send, scope.writerEpoch, memberSession)).toMatchObject({ revision: 1 });
    expect(f.claim()).toMatchObject({ dispatchAllowed: true, actor: member });
  });

  it("parks before dispatch while a background credential revision is pending, then pins the actual selected next-run revision", () => {
    const f = fixture(), send = f.enqueue(); f.ready.mockReturnValue(false); f.request(send);
    expect(f.claim()).toBeNull(); expect(f.snapshot().pending[0]?.state).toBe("queued");
    f.ready.mockReturnValue(true); const claim = f.claim()!;
    const info = { version: 1 as const, bootId: scope.bootId, writerEpoch: scope.writerEpoch, cacheRevision: 2, provider: "claude" as const,
      fundingOwnerUserId: scope.fundingOwnerUserId, fundingOwnerEpoch: scope.fundingOwnerEpoch,
      credentialId: randomUUID(), credentialRevision: 2, connectionRevision: 3, adoptionId: randomUUID(),
      materialVersion: 1, displayName: "Synthetic provider account" };
    f.queue.recordCredentialSelection(claim, info); f.queue.recordCredentialSelection(claim, info);
    expect(() => f.queue.recordCredentialSelection(claim, { ...info, cacheRevision: 3 })).toThrow("command_conflict");
    expect(f.queue.peekMirrorBatch()?.changes.at(-1)).toMatchObject({ credentialRun: info, entry: { state: "dispatching" } });
  });

  it("makes Stop monotonic/idempotent and keeps it available when mutation receipt capacity is exhausted", () => {
    const f = fixture({ limits: { operations: 1 } }), send = f.enqueue(); f.request(send);
    const stop = { kind: "stop" as const, conversationId: "chat", operationId: randomUUID() };
    expect(f.request(stop)).toMatchObject({ paused: true, revision: 2 });
    expect(f.request(stop)).toMatchObject({ paused: true, revision: 2 });
    expect(f.claim()).toBeNull();
    expect(() => f.request(f.enqueue())).toThrow("command_limit");
    expect(f.snapshot().pending).toHaveLength(1);
  });

  it("allows queued edits/removal but forbids changing user-message identity or editing a dispatched command", () => {
    const f = fixture(), send = f.enqueue(); f.request(send);
    const edit = (payload: CloudQueuedPrompt) => ({ kind: "mutate" as const, mutation: { conversationId: "chat", operationId: randomUUID(),
      expectedRevision: f.snapshot().revision, action: { kind: "edit" as const, commandId: send.mutation.action.commandId, payload } }, admissionError: null });
    expect(() => f.request(edit(f.payload()))).toThrow("command_conflict");
    const next = { ...send.mutation.action.payload, prompt: [{ type: "text" as const, text: "edited synthetic fixture" }] };
    f.request(edit(next)); const claim = f.claim()!; expect(claim.payload).toEqual(next);
    expect(() => f.request(edit(next))).toThrow("command_conflict");
  });

  it("rolls back the entire acceptance on a real SQLite write failure", () => {
    const f = fixture(), send = f.enqueue(), db = openSqlite(f.file);
    db.exec("CREATE TRIGGER fail_operation BEFORE INSERT ON local_command_operations BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
    try { expect(() => f.request(send)).toThrow("command_storage_unavailable"); }
    finally { db.exec("DROP TRIGGER fail_operation"); db.close(); }
    expect(f.snapshot()).toMatchObject({ revision: 0, pending: [], receipts: [] });
    expect(f.request(send)).toMatchObject({ revision: 1, replayed: false });
  });

  it("commits exact empty successful native outcomes and matching history watermark, and retries terminal storage without replay", () => {
    const f = fixture(), send = f.enqueue(); f.request(send); const claim = f.claim()!;
    const result: CloudCommandResult = { commandId: claim.commandId, claimId: claim.claimId, state: "succeeded", resultCode: null,
      result: { version: 1, terminal: { commandId: claim.commandId, conversationId: "chat", executionId: claim.executionId,
        turnId: claim.payload.userMessageId, agentId: "claude", status: "completed", stopReason: "end_turn", response: {
          effectiveModel: "claude-sonnet-4-6", usage: { inputTokens: 2, outputTokens: 0 }, userMessageId: claim.payload.userMessageId } } } };
    expect(f.request({ kind: "settle", result })).toMatchObject({ replayed: false, receipts: [{ payload: null, result: result.result }] });
    expect(f.request({ kind: "settle", result })).toMatchObject({ replayed: true });
    expect(() => f.request({ kind: "settle", result: { ...result, resultCode: "changed" } })).toThrow("command_conflict");
    expect(f.queue.peekMirrorBatch()?.changes.at(-1)).toMatchObject({ entry: { commandId: claim.commandId, result: result.result },
      history: { recordSequence: 7, eventSequence: 12 } });
    expect(f.claim()).toBeNull();
  });

  it("does not settle a user-bubble-only failed turn as success or accept a terminal owned by another turn", () => {
    const f = fixture(); f.request(f.enqueue()); const claim = f.claim()!;
    const foreign = { version: 1 as const, terminal: { commandId: claim.commandId, conversationId: "chat", executionId: claim.executionId,
      turnId: randomUUID(), agentId: "claude", status: "failed" as const, stopReason: null, error: "Synthetic authentication failure" } };
    expect(() => f.request({ kind: "settle", result: { commandId: claim.commandId, claimId: claim.claimId, state: "succeeded",
      resultCode: null, result: foreign } })).toThrow("command_conflict");
    expect(f.snapshot().pending[0]?.state).toBe("dispatching");
  });

  it("persists stable bounded mirror batches, exact ACKs and no terminal regression across lost mirror replies", () => {
    const f = fixture(); f.request(f.enqueue());
    const batch = f.queue.peekMirrorBatch()!;
    expect(f.queue.peekMirrorBatch()).toEqual(batch);
    expect(batch).toMatchObject({ version: 1, writerEpoch: scope.writerEpoch, after: 0, through: 1 });
    expect(batch.changes.map(change => change.sequence)).toEqual([1]);
    expect(() => f.queue.acknowledgeMirror({ version: 1, writerEpoch: scope.writerEpoch, batchId: batch.batchId, through: batch.through + 1 })).toThrow("command_response_invalid");
    f.queue.close(); const reopened = fixture({ file: f.file });
    // Recovery appends an uncertain record; the already-published batch is
    // retried byte-for-byte before the newer quarantine state.
    expect(reopened.queue.peekMirrorBatch()).toEqual(batch);
    reopened.queue.acknowledgeMirror({ version: 1, writerEpoch: scope.writerEpoch, batchId: batch.batchId, through: batch.through });
    expect(reopened.queue.peekMirrorBatch()?.changes[0]?.entry?.state).toBe("uncertain");
    expect(reopened.queue.mirrorDrained()).toBe(false);
  });
});
