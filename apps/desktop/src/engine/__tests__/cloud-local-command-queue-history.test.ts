import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type Sqlite from "better-sqlite3";
import { canonicalCloudLocalCommandHistoryJson, CloudLocalCommandHistoryManifestSchema, CloudLocalCommandHistoryPartSchema, type CloudLocalCommandHistoryRecord } from "@zeros/protocol/cloud-local-mirror";
import { assembleCloudHistoryDocument } from "../../../../control-plane/src/cloud-workspaces/history-local-contract";
import { runMigrations } from "../db/migrations";
import { openSqlite } from "../db/sqlite";
const handles: Sqlite.Database[] = [];
const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2, engineInstanceId: randomUUID(),
  bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
const sha = (value: unknown) => createHash("sha256").update(canonicalCloudLocalCommandHistoryJson(value)).digest("hex");
function isRecord(value: ReturnType<typeof assembleCloudHistoryDocument>): value is ReturnType<typeof assembleCloudHistoryDocument> & {
  kind: "record"; document: CloudLocalCommandHistoryRecord;
} {
  return value.kind === "record" && "entityKind" in value.document;
}
function fixture() {
  const db = openSqlite(":memory:"); handles.push(db); runMigrations(db);
  db.pragma("synchronous = NORMAL");
  db.prepare("INSERT INTO chats(id,folder,agent_id,title,created_at,updated_at,rev) VALUES(?,?,?,?,?,?,?)")
    .run("chat", "/srv/zeros/workspace/managed", "cursor", "History", 1, 2, 1);
  const insert = db.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES(?,?,?,?,?,?,?)");
  insert.run("chat", "turn", 0, "text", JSON.stringify({ role: "user", text: "synthetic" }), 1, 2);
  insert.run("chat", "tool", 1, "tool", JSON.stringify({ title: "Read source", status: "completed", rawInput: { path: "source" }, rawOutput: "exact tool output" }), 2, 3);
  db.prepare("INSERT INTO turns(chat_id,turn_id,folder,agent_id,ord,started_at,ended_at,status,files,usage,rev) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run("chat", "turn", "/srv/zeros/workspace/managed", "cursor", 0, 1, 2, "completed", '[{"path":"file","status":"modified","additions":1,"deletions":0}]', '{"inputTokens":4,"outputTokens":8}', 4);
  db.prepare("UPDATE sync_meta SET next_rev=5 WHERE id=0").run();
  const commandId = randomUUID();
  const result = { version: 1, terminal: { commandId, conversationId: "chat", executionId: "execution", turnId: "turn", agentId: "cursor",
    status: "completed", stopReason: "end_turn", startedAt: 1, endedAt: 2,
    response: { stopReason: "end_turn", usage: { inputTokens: 4, outputTokens: 8 }, userMessageId: "turn" } } };
  const source = { kind: "command" as const, commandId, executionId: "execution", intent: { userMessageId: "turn", agentId: "cursor" }, nativeResultSha256: sha(result) };
  const input = { db, repositoryRoot: "/srv/zeros/workspace", scope, conversationId: "chat", source, nativeResult: result,
    restoreRevision: 1, eventSequence: 10, controls: [], redactDocument: (value: unknown) => value };
  return { db, input, result, source, insert };
}
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
async function capture(input: ReturnType<typeof fixture>["input"] | Record<string, unknown>) {
  const module = await import("../cloud-local-command-queue-history");
  return module.captureCloudLocalCommandHistory(input as Parameters<typeof module.captureCloudLocalCommandHistory>[0]);
}
describe("immutable full cloud history capture", () => {
  it("captures exact chat/tool/turn state and source proof without changing NORMAL durability", async () => {
    const f = fixture(), result = await capture(f.input);
    expect(result.historyHead.history).toMatchObject({ restoreRevision: 1, recordSequence: 4, eventSequence: 10, manifestSha256: expect.any(String) });
    const manifest = CloudLocalCommandHistoryManifestSchema.parse(result.manifest);
    expect(manifest.source).toEqual(f.source); expect(manifest.records.map(row => row.entityKind)).toEqual(["chat", "message", "message", "turn"]);
    const decoded = result.documents.map(document => assembleCloudHistoryDocument(document.parts));
    expect(decoded.filter(isRecord).find(value => value.document.entityKind === "chat")?.canonicalDocument).toContain('"folder":"managed"');
    expect(decoded.some(value => value.canonicalDocument.includes("exact tool output"))).toBe(true);
    expect(decoded.some(value => value.canonicalDocument.includes("inputTokens"))).toBe(true);
    expect(f.db.pragma("synchronous", { simple: true })).toBe(1);
  });
  it("never captures another conversation or a host path outside the admitted root", async () => {
    const f = fixture(); f.insert.run("foreign", "private", 0, "text", '{"text":"foreign content"}', 1, 1);
    const valid = await capture(f.input); expect(valid.documents.map(row => row.canonicalDocument).join("")).not.toContain("foreign content");
    f.db.prepare("UPDATE chats SET folder='/host/private' WHERE id='chat'").run();
    expect((await capture(f.input)).historyHead.history).toMatchObject({ incompleteReason: "capture_conflict" });
  });
  it("sends strict128KiB canonical parts that reassemble byte-for-byte in the CP decoder", async () => {
    const f = fixture(); f.insert.run("chat", "large", 2, "text", JSON.stringify({ text: "λ".repeat(100_000) }), 3, 4);
    const result = await capture(f.input), large = result.documents.find(value => value.canonicalDocument.includes("λλ"))!;
    expect(large.parts.length).toBeGreaterThan(1);
    for (const part of large.parts) { expect(CloudLocalCommandHistoryPartSchema.safeParse(part).success).toBe(true); expect(Buffer.from(part.data, "base64").length).toBeLessThanOrEqual(128 * 1024); }
    expect(assembleCloudHistoryDocument(large.parts).canonicalDocument).toBe(large.canonicalDocument);
  });
  it("keeps own prototype-like JSON data exactly in retained message bytes", async () => {
    const f = fixture(), payload = '{"__proto__":{"marker":"kept"},"nested":{"constructor":"value","prototype":"value"}}';
    f.db.prepare("UPDATE chat_messages SET payload=? WHERE msg_id='tool'").run(payload);
    const result = await capture(f.input), document = result.documents.map(value => assembleCloudHistoryDocument(value.parts))
      .filter(isRecord).find(value => value.document.entityKind === "message" && value.document.document.msgId === "tool")!;
    expect(document.document.document.payload).toBe(payload);
    expect(sha(document.document)).toBe(document.sha256);
  });
  it("freezes retained bytes and is deterministic after mutable rows later change", async () => {
    const f = fixture(), first = await capture(f.input), second = await capture(f.input);
    expect(first.documents).toEqual(second.documents); const bytes = first.documents.map(value => value.canonicalDocument);
    f.db.prepare("UPDATE chat_messages SET payload='{}' WHERE msg_id='tool'").run();
    expect(first.documents.map(value => value.canonicalDocument)).toEqual(bytes);
    expect(Object.isFrozen(first)).toBe(true); expect(first.documents.every(value => Object.isFrozen(value.parts))).toBe(true);
  });
  it("does not freeze or mutate the caller's native result while retaining an immutable detached outcome", async () => {
    const f = fixture(), result = await capture(f.input);
    expect(Object.isFrozen(f.result)).toBe(false);
    expect(result.nativeResult).not.toBe(f.result); expect(result.nativeResult).toEqual(f.result);
    expect(Object.isFrozen(result.nativeResult)).toBe(true);
  });
  it("retains the original permission request and settlement with their sparse live cursor", async () => {
    const f = fixture(), streamId = randomUUID();
    const common = { id: "request", timestamp: 1, source: "engine", agentId: "cursor", chatId: "chat", permissionId: "permission" };
    const request = { version: 1, executionId: "execution", commandId: f.source.commandId, turnId: "turn", eventSequence: 8,
      frame: { ...common, type: "AGENT_PERMISSION_REQUEST", cloudStream: { streamId, sequence: 8 }, request: {
        sessionId: "native", executionId: "execution", toolCall: { toolCallId: "tool", title: "Read source", rawInput: { path: "source" } },
        options: [{ optionId: "project", name: "Allow for this project", kind: "allow_always_project" }] } } };
    const settled = { ...request, eventSequence: 9, frame: { ...common, id: "settled", type: "AGENT_PERMISSION_SETTLED",
      cloudStream: { streamId, sequence: 9 }, sessionId: "native", executionId: "execution" } };
    const result = await capture({ ...f.input, controls: [request, settled] });
    const controls = result.documents.map(document => assembleCloudHistoryDocument(document.parts))
      .filter(isRecord).filter(value => value.document.entityKind === "control");
    expect(controls.map(value => value.document.document)).toEqual([request, settled]);
    expect(result.manifest?.eventSequence).toBe(10);
  });
  it("does not guess an unknown source record head as zero", async () => {
    const f = fixture(); f.db.prepare("DELETE FROM sync_meta WHERE id=0").run();
    const result = await capture(f.input);
    expect(result.historyHead.history).toMatchObject({ recordSequence: null, eventSequence: 10, incompleteReason: "capture_unavailable" });
    expect(result.nativeResult).toEqual(f.result); expect(result.documents).toEqual([]);
  });
  it("settles known native outcome honestly when no conversation was captured", async () => {
    const f = fixture(); f.db.prepare("DELETE FROM chats WHERE id='chat'").run();
    const result = await capture(f.input); expect(result.documents).toEqual([]); expect(result.nativeResult).toEqual(f.result);
    expect(result.historyHead.history).toMatchObject({ restoreRevision: 1, incompleteReason: "capture_unavailable" });
  });
  it.each(["intent", "result", "row-revision"])("refuses conflicting exact command %s proof", async mismatch => {
    const f = fixture();
    if (mismatch === "intent") f.input.source = { ...f.source, intent: { ...f.source.intent, userMessageId: "another-turn" } };
    if (mismatch === "result") f.input.source = { ...f.source, nativeResultSha256: "f".repeat(64) };
    if (mismatch === "row-revision") f.db.prepare("UPDATE turns SET rev=99 WHERE chat_id='chat'").run();
    const result = await capture(f.input); expect(result.historyHead.history).toMatchObject({ incompleteReason: "capture_conflict" }); expect(result.nativeResult).toEqual(f.result);
  });
  it("never presents a still-running exact native turn as final complete history", async () => {
    const f = fixture(); f.db.prepare("UPDATE turns SET status='running',ended_at=NULL WHERE chat_id='chat'").run();
    expect((await capture(f.input)).historyHead.history).toMatchObject({ incompleteReason: "capture_unavailable" });
  });
  it("detects a source-head change during capture and discards every partial artifact", async () => {
    const f = fixture(); let changed = false;
    f.input.redactDocument = value => { if (!changed) { changed = true; f.db.prepare("UPDATE sync_meta SET next_rev=6 WHERE id=0").run(); } return value; };
    const result = await capture(f.input); expect(result.documents).toEqual([]); expect(result.historyHead.history).toMatchObject({ incompleteReason: "capture_conflict" });
  });
  it("does not serialize raw data when original-run redaction fails", async () => {
    const f = fixture(); f.input.redactDocument = () => { throw new Error("private diagnostic"); };
    const result = await capture(f.input); expect(result.documents).toEqual([]); expect(result.historyHead.history).toMatchObject({ incompleteReason: "capture_unavailable" });
    expect(JSON.stringify(result.historyHead)).not.toContain("private diagnostic");
  });
  it.each(["message", "turn"])("refuses a redactor that rewrites the captured %s identity", async kind => {
    const f = fixture();
    f.input.redactDocument = value => {
      const document = value as Record<string, unknown>;
      if (kind === "message" && document.msgId === "tool") return { ...document, msgId: "foreign-message" };
      if (kind === "turn" && document.row) return { ...document, row: { ...document.row as Record<string, unknown>, turn_id: "foreign-turn" } };
      return document;
    };
    const result = await capture(f.input);
    expect(result.historyHead.history).toMatchObject({ incompleteReason: "capture_conflict" });
    expect(result.documents).toEqual([]); expect(result.nativeResult).toEqual(f.result);
  });
  it("treats16MiB as cumulative FULL-conversation capacity without truncating a successful outcome", async () => {
    const f = fixture(); for (let index = 0; index < 43; index++) f.insert.run("chat", `large-${index}`, index + 2, "text", JSON.stringify({ text: "x".repeat(400_000) }), 1, 4);
    const result = await capture(f.input); expect(result.historyHead.history).toMatchObject({ incompleteReason: "history_limit" });
    expect(result.documents).toEqual([]); expect(result.nativeResult).toEqual(f.result);
  });
  it("publishes authoritative deleted heads from actual tombstones, never a fabricated empty chat", async () => {
    const f = fixture(); f.db.prepare("DELETE FROM chats WHERE id='chat'").run();
    f.db.prepare("INSERT INTO sync_tombstones(kind,id,rev) VALUES('chat','chat',4)").run();
    const result = await capture({ ...f.input, source: { kind: "mutation", mutationId: randomUUID(), operation: "delete" } });
    expect(result.historyHead.deleted).toBe(true); expect(result.manifest?.records).toEqual([]);
    expect(result.manifest?.tombstones).toContainEqual({ entityKind: "chat", entityId: "chat", sourceRevision: 4 });
    expect(result.manifest?.source.kind).toBe("mutation");
  });
  it("retains removed full-snapshot identities as tombstones instead of resurrecting old records", async () => {
    const f = fixture(), prior = await capture(f.input);
    f.db.prepare("DELETE FROM chat_messages WHERE msg_id='tool'").run(); f.db.prepare("UPDATE sync_meta SET next_rev=6 WHERE id=0").run();
    const result = await capture({ ...f.input, source: { kind: "mutation", mutationId: randomUUID(), operation: "prune" }, restoreRevision: 2, previousManifest: prior.manifest });
    const removed = prior.manifest!.records.find(value => value.entityKind === "message" && value.sha256 !== prior.manifest!.records[1]!.sha256)!;
    expect(result.manifest?.tombstones).toContainEqual({ entityKind: "message", entityId: removed.entityId, sourceRevision: 5 });
    expect(result.manifest?.records.some(value => value.entityId === removed.entityId)).toBe(false);
  });
});
