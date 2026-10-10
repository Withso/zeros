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
  return { queue, db, scope, batch, options, ack: { version: 1 as const, writerEpoch: scope.writerEpoch, batchId: batch.batchId, through: batch.through } };
}

describe("FULL queue ACK joins the exact persisted mirror flight", () => {
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
