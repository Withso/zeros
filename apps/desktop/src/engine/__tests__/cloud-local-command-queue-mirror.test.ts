import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudBootCommandClaimSchema } from "@zeros/protocol/cloud-commands";
import { canonicalCloudLocalCommandHistoryJson as canonical } from "@zeros/protocol/cloud-local-mirror";
import { CloudActorAuthorityRegistry } from "../agents/cloud-agent-lease";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { openSqlite } from "../db/sqlite";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(terminal = false) {
  const directory = mkdtempSync(join(tmpdir(), "zeros-mirror-ack-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "queue.sqlite"), now = 1_000_000;
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const actorSessionId = randomUUID(), actors = new CloudActorAuthorityRegistry({ scope, engineLive: () => true,
    time: { wall: () => now, monotonic: () => 0 } });
  actors.confirm({ scope, actorSessionId, authorityEpoch: 1, confirmedUntilMs: now + 9_000, fundingConsentVersion: 1,
    fundingGrant: { kind: "owner" }, actor: { userId: scope.fundingOwnerUserId, deviceId: randomUUID(), deviceKeyVersion: 1,
      fingerprint: "a".repeat(64), role: "owner" } });
  const captureHistory: NonNullable<ConstructorParameters<typeof CloudLocalCommandQueue>[0]["captureHistory"]> = input => {
    const record = { version: 1 as const, conversationId: input.conversationId, entityKind: "chat" as const,
      entityId: input.conversationId, schemaVersion: 1 as const, sourceRevision: 1, document: { version: 1, chat: { id: input.conversationId } } };
    const document = (kind: "record" | "manifest", value: unknown) => {
      const canonicalDocument = canonical(value), bytes = Buffer.byteLength(canonicalDocument);
      const sha256 = createHash("sha256").update(canonicalDocument).digest("hex");
      return { kind, sha256, canonicalDocument, parts: [{ version: 1 as const, kind, sha256, index: 0, count: 1, bytes,
        data: Buffer.from(canonicalDocument).toString("base64") }] };
    };
    const saved = document("record", record), manifest = { version: 1 as const, snapshot: "full" as const, scope: input.scope,
      conversationId: input.conversationId, restoreRevision: input.restoreRevision, deleted: false, tombstones: [],
      recordSequence: 1, eventSequence: 1, source: input.source,
      records: [{ entityKind: record.entityKind, entityId: record.entityId, schemaVersion: 1 as const, sourceRevision: 1, sha256: saved.sha256 }] };
    const bundle = document("manifest", manifest);
    return { nativeResult: input.nativeResult, manifest, documents: [saved, bundle], historyHead: { originWriterEpoch: scope.writerEpoch,
      source: input.source, deleted: false, history: { restoreRevision: input.restoreRevision, recordSequence: 1, eventSequence: 1, manifestSha256: bundle.sha256 } } };
  };
  const options = { file, scope, actors, engineLive: () => true, now: () => now,
    history: () => ({ recordSequence: 1, eventSequence: 1 }), ready: () => true, ...(terminal ? { captureHistory } : {}) };
  const queue = new CloudLocalCommandQueue(options);
  cleanup.push(() => queue.close());
  queue.handle({ kind: "mutate", admissionError: null, mutation: { conversationId: "chat", operationId: randomUUID(), expectedRevision: 0,
    action: { kind: "enqueue", commandId: randomUUID(), payload: { agentId: "claude", userMessageId: "turn", model: "fixture-model",
      modeRevision: 0, prompt: [{ type: "text", text: "Synthetic private queue fixture" }] } } } }, { actorSessionId, writerEpoch: scope.writerEpoch });
  if (terminal) {
    const claim = CloudBootCommandClaimSchema.parse(queue.handle({ kind: "claim", conversationId: "chat", claimId: randomUUID(),
      executionId: randomUUID() }, { writerEpoch: scope.writerEpoch }));
    queue.handle({ kind: "settle", result: { commandId: claim.commandId, claimId: claim.claimId, state: "failed",
      resultCode: "cloud_provider_prompt_auth_required", result: { version: 1 } } }, { writerEpoch: scope.writerEpoch });
  }
  const batch = queue.peekMirrorBatch()!, db = openSqlite(file);
  cleanup.push(() => db.close());
  return { queue, db, scope, batch, options, actorSessionId, ack: { version: 1 as const, writerEpoch: scope.writerEpoch, batchId: batch.batchId, through: batch.through } };
}
function drain(queue: CloudLocalCommandQueue) {
  const changes = [];
  for (let flight = 0; flight < 2048; flight++) {
    const batch = queue.peekMirrorBatch();
    if (!batch) { expect(queue.mirrorDrained()).toBe(true); return changes; }
    expect(batch.changes.length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(1024 * 1024);
    changes.push(...batch.changes);
    queue.acknowledgeMirror({ version: 1, writerEpoch: queue.scope.writerEpoch, batchId: batch.batchId, through: batch.through });
  }
  throw new Error("Synthetic mirror failed to drain");
}
function successor(f: ReturnType<typeof fixture>, limits?: ConstructorParameters<typeof CloudLocalCommandQueue>[0]["limits"]) {
  const scope = { ...f.scope, writerEpoch: randomUUID(), engineInstanceId: randomUUID(), bootId: randomUUID() };
  const actors = new CloudActorAuthorityRegistry({ scope, engineLive: () => true }); cleanup.push(() => actors.dispose());
  const options = { ...f.options, scope, actors, limits }, queue = new CloudLocalCommandQueue(options);
  cleanup.push(() => queue.close()); return { queue, options, scope };
}

describe("FULL queue ACK joins the exact persisted mirror flight", () => {
  it("republishes inherited current history after a writer handoff without redispatching its request", () => {
    const f = fixture(true), head = f.queue.currentHistoryHead("chat")!;
    expect(head.history).toHaveProperty("manifestSha256");
    for (let batch = f.queue.peekMirrorBatch(); batch; batch = f.queue.peekMirrorBatch())
      f.queue.acknowledgeMirror({ version: 1, writerEpoch: f.scope.writerEpoch, batchId: batch.batchId, through: batch.through });
    expect(f.queue.mirrorDrained()).toBe(true);
    const audit = f.db.prepare("SELECT id,state,actor,history,result FROM local_commands").all();
    f.queue.close();
    const scope = { ...f.scope, writerEpoch: randomUUID(), engineInstanceId: randomUUID(), bootId: randomUUID() };
    const actors = new CloudActorAuthorityRegistry({ scope, engineLive: () => true });
    cleanup.push(() => actors.dispose());
    const next = new CloudLocalCommandQueue({ ...f.options, scope, actors });
    cleanup.push(() => next.close());
    expect(next.currentHistoryHead("chat")).toEqual(head);
    expect(f.db.prepare("SELECT id,state,actor,history,result FROM local_commands").all()).toEqual(audit);
    expect(next.handle({ kind: "claim", conversationId: "chat", claimId: randomUUID(), executionId: randomUUID() },
      { writerEpoch: scope.writerEpoch })).toBeNull();
    const changes = [];
    for (let batch = next.peekMirrorBatch(); batch; batch = next.peekMirrorBatch()) {
      changes.push(...batch.changes);
      next.acknowledgeMirror({ version: 1, writerEpoch: scope.writerEpoch, batchId: batch.batchId, through: batch.through });
    }
    expect(changes.filter(change => change.historyHead).at(-1)?.historyHead).toEqual(head);
    expect(changes.some(change => change.entry && ["queued", "dispatching"].includes(change.entry.state))).toBe(false);
  });
  it.each(["edit", "prune", "delete"] as const)("republishes the latest %s fence instead of an older complete head", operation => {
    const f = fixture(true);
    const head = f.queue.publishHistoryMutation({ conversationId: "chat", mutationId: randomUUID(), operation, deleted: operation === "delete",
      recordSequence: 1, eventSequence: 1 });
    drain(f.queue); f.queue.close();
    const next = successor(f), changes = drain(next.queue);
    expect(changes.filter(change => change.historyHead).at(-1)?.historyHead).toEqual(head);
    expect(changes.some(change => change.historyPart || change.event)).toBe(false);
    expect(next.queue.currentHistoryHead("chat")).toEqual(head);
    expect(next.queue.handle({ kind: "claim", conversationId: "chat", claimId: randomUUID(), executionId: randomUUID() },
      { writerEpoch: next.scope.writerEpoch })).toBeNull();
  });
  it("keeps an inherited flight exact across lost ACK and same-writer restart, then stays drained", () => {
    const f = fixture(true); drain(f.queue); f.queue.close();
    const next = successor(f), batch = next.queue.peekMirrorBatch()!;
    expect(batch).not.toBeNull(); expect(next.queue.peekMirrorBatch()).toEqual(batch);
    const audit = f.db.prepare("SELECT id,state,actor,history,result FROM local_commands").all();
    next.queue.close();
    const reopened = new CloudLocalCommandQueue(next.options); cleanup.push(() => reopened.close());
    expect(reopened.peekMirrorBatch()).toEqual(batch);
    drain(reopened); reopened.close();
    const drained = new CloudLocalCommandQueue(next.options); cleanup.push(() => drained.close());
    expect(drained.peekMirrorBatch()).toBeNull(); expect(drained.mirrorDrained()).toBe(true);
    expect(f.db.prepare("SELECT id,state,actor,history,result FROM local_commands").all()).toEqual(audit);
  });
  it("advances an intrinsically oversized inherited bundle with a durable incomplete head and no redispatch", () => {
    const f = fixture(true), previous = f.queue.currentHistoryHead("chat")!;
    f.queue.publishHistoryMutation({ conversationId: "sibling", mutationId: randomUUID(), operation: "edit", deleted: false,
      recordSequence: 1, eventSequence: 1 });
    drain(f.queue);
    const audit = f.db.prepare("SELECT id,state,actor,history,result FROM local_commands").all();
    const documents = f.db.prepare("SELECT sha256,document FROM local_command_history_documents ORDER BY sha256").all();
    f.queue.close();
    // The compact head fits, but two parts plus head do not fit alongside the
    // reserved control jobs. This was a permanent command_limit on every peek.
    const next = successor(f,{ pending: 1, historyJobs: 5 });
    const first = next.queue.peekMirrorBatch()!;
    expect(first).not.toBeNull(); expect(next.queue.peekMirrorBatch()).toEqual(first);
    next.queue.close();
    const reopened = new CloudLocalCommandQueue(next.options); cleanup.push(() => reopened.close());
    expect(reopened.peekMirrorBatch()).toEqual(first);
    const changes = drain(reopened), head = reopened.currentHistoryHead("chat")!;
    expect(head).toMatchObject({ source: previous.source, history: { incompleteReason: "history_limit" } });
    expect(head.history.restoreRevision).toBeGreaterThan(previous.history.restoreRevision);
    expect(changes.some(change => change.conversationId === "sibling" && change.historyHead)).toBe(true);
    expect(changes.filter(change => change.conversationId === "chat" && change.historyHead).at(-1)?.historyHead).toEqual(head);
    expect(changes.some(change => change.historyPart || change.event)).toBe(false);
    expect(f.db.prepare("SELECT id,state,actor,history,result FROM local_commands").all()).toEqual(audit);
    expect(f.db.prepare("SELECT sha256,document FROM local_command_history_documents ORDER BY sha256").all()).toEqual(documents);
    expect(reopened.handle({ kind: "claim", conversationId: "chat", claimId: randomUUID(), executionId: randomUUID() },
      { writerEpoch: next.scope.writerEpoch })).toBeNull();
    expect(reopened.mirrorDrained()).toBe(true);
  });
  it("publishes every inherited command prerequisite before heads across a multi-flight backlog", () => {
    const f = fixture(true), latest = new Map([["chat",f.queue.currentHistoryHead("chat")!]]);
    for (let index = 0; index < 65; index++) {
      const conversationId = `chat-${String(index).padStart(3,"0")}`;
      f.queue.handle({ kind: "mutate", admissionError: null, mutation: { conversationId, operationId: randomUUID(), expectedRevision: 0,
        action: { kind: "enqueue", commandId: randomUUID(), payload: { agentId: "claude", userMessageId: "turn", model: "fixture-model",
          modeRevision: 0, prompt: [{ type: "text", text: "Synthetic inherited request" }] } } } },
      { actorSessionId: f.actorSessionId, writerEpoch: f.scope.writerEpoch });
      const claim = CloudBootCommandClaimSchema.parse(f.queue.handle({ kind: "claim", conversationId, claimId: randomUUID(), executionId: randomUUID() },
        { writerEpoch: f.scope.writerEpoch }));
      f.queue.handle({ kind: "settle", result: { commandId: claim.commandId, claimId: claim.claimId, state: "succeeded",
        resultCode: null, result: { version: 1 } } }, { writerEpoch: f.scope.writerEpoch });
      latest.set(conversationId,f.queue.currentHistoryHead(conversationId)!);
    }
    // Unacknowledged parts and heads survive this handoff too. They cannot
    // outrun command prerequisites merely because their jobs already exist.
    f.queue.close();
    const next = successor(f), changes = drain(next.queue), commands = new Set(), heads = new Map();
    for (const change of changes) {
      if (change.entry) {
        expect(["queued","dispatching"]).not.toContain(change.entry.state);
        commands.add(change.entry.commandId);
      }
      if (change.historyHead) {
        if (change.historyHead.source.kind === "command") expect(commands.has(change.historyHead.source.commandId)).toBe(true);
        heads.set(change.conversationId,change.historyHead);
      }
    }
    expect(heads).toEqual(latest); expect(commands.size).toBe(66);
    expect(changes.some(change => change.event)).toBe(false);
  });
  it.each(["boot", "range", "actor", "document", "stored-after", "stored-through"])("never prunes a corrupt %s flight", kind => {
    const f = fixture(), changed = structuredClone(f.batch), ack = { ...f.ack };
    const originalHead = f.db.prepare("SELECT value FROM local_command_metadata WHERE key='mirrorHead'").get();
    if (kind === "boot") changed.bootId = randomUUID();
    if (kind === "range") changed.after = changed.through;
    if (kind === "actor") changed.changes[0]!.actor!.scope.fundingOwnerEpoch++;
    f.db.prepare("UPDATE local_command_mirror_batches SET document=? WHERE writer_epoch=?")
      .run(kind === "document" ? "not-json" : JSON.stringify(changed), f.scope.writerEpoch);
    if (kind === "stored-after") f.db.prepare("UPDATE local_command_mirror_batches SET after_sequence=9 WHERE writer_epoch=?").run(f.scope.writerEpoch);
    if (kind === "stored-through") {
      f.db.prepare("UPDATE local_command_mirror_batches SET through_sequence=2 WHERE writer_epoch=?").run(f.scope.writerEpoch);
      ack.through = 2;
    }
    expect(() => f.queue.acknowledgeMirror(ack)).toThrow("command_response_invalid");
    expect(f.db.prepare("SELECT count(*) AS count FROM local_command_journal").get()).toEqual({ count: 1 });
    expect(f.db.prepare("SELECT count(*) AS count FROM local_command_mirror_batches").get()).toEqual({ count: 1 });
    expect(f.db.prepare("SELECT value FROM local_command_metadata WHERE key='mirrorHead'").get()).toEqual(originalHead);
  });
  it("commits the exact valid pending-flight ACK before draining the assigned journal", () => {
    const f = fixture();
    f.queue.acknowledgeMirror(f.ack);
    expect(f.queue.mirrorDrained()).toBe(true);
    expect(f.db.prepare("SELECT value FROM local_command_metadata WHERE key='mirrorHead'").get()).toEqual({ value: "1" });
    expect(f.db.prepare("SELECT count(*) AS count FROM local_commands").get()).toEqual({ count: 1 });
  });
  it("commits exact quota feedback before pruning, preserves native audit and restores the newer head after reopen", () => {
    const f = fixture(true), part = f.batch.changes.find(change => change.historyPart?.kind === "record")!.historyPart!;
    const audit = f.db.prepare("SELECT history,result FROM local_commands").get(), previous = f.queue.currentHistoryHead("chat")!;
    expect(previous.history).toHaveProperty("manifestSha256");
    f.queue.acknowledgeMirror({ ...f.ack, historyLimits: [{ conversationId: "chat", sha256: part.sha256 }] });
    const head = f.queue.currentHistoryHead("chat")!;
    expect(head).toMatchObject({ source: previous.source, history: { incompleteReason: "history_limit" } });
    expect(head.history.restoreRevision).toBeGreaterThan(previous.history.restoreRevision);
    expect(f.db.prepare("SELECT history,result FROM local_commands").get()).toEqual(audit);
    expect(f.db.prepare("SELECT conversation_id,sha256 FROM local_command_history_limits").all())
      .toEqual([{ conversation_id: "chat", sha256: part.sha256 }]);
    expect(f.db.prepare("SELECT value FROM local_command_metadata WHERE key='mirrorHead'").get()).toEqual({ value: String(f.batch.through) });
    expect(f.queue.mirrorDrained()).toBe(false);
    const next = f.queue.peekMirrorBatch()!;
    expect(next.after).toBe(f.batch.through);
    expect(next.changes.some(change => canonical(change.historyHead ?? null) === canonical(head))).toBe(true);
    f.queue.close();
    const reopened = new CloudLocalCommandQueue(f.options); cleanup.push(() => reopened.close());
    expect(reopened.currentHistoryHead("chat")).toEqual(head);
    expect(reopened.peekMirrorBatch()).toEqual(next);
  });
  it("rolls quota publication back with the cursor and exact flight when the later ACK commit fails", () => {
    const f = fixture(true), part = f.batch.changes.find(change => change.historyPart?.kind === "record")!.historyPart!;
    const previous = f.queue.currentHistoryHead("chat"), audit = f.db.prepare("SELECT history,result FROM local_commands").get();
    f.db.exec("CREATE TRIGGER fixture_reject_ack BEFORE INSERT ON local_command_metadata WHEN NEW.key='mirrorHead' BEGIN SELECT RAISE(ABORT,'fixture_ack_commit'); END");
    expect(() => f.queue.acknowledgeMirror({ ...f.ack, historyLimits: [{ conversationId: "chat", sha256: part.sha256 }] }))
      .toThrow("command_storage_unavailable");
    expect(f.queue.currentHistoryHead("chat")).toEqual(previous);
    expect(f.db.prepare("SELECT history,result FROM local_commands").get()).toEqual(audit);
    expect(f.db.prepare("SELECT count(*) AS n FROM local_command_history_limits").get()).toEqual({ n: 0 });
    expect(f.queue.peekMirrorBatch()).toEqual(f.batch);
    expect(f.db.prepare("SELECT value FROM local_command_metadata WHERE key='mirrorHead'").get()).toBeUndefined();
    f.db.exec("DROP TRIGGER fixture_reject_ack");
    f.queue.acknowledgeMirror({ ...f.ack, historyLimits: [{ conversationId: "chat", sha256: part.sha256 }] });
    expect(f.queue.currentHistoryHead("chat")!.history).toHaveProperty("incompleteReason", "history_limit");
  });
});
