import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Sqlite from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalCloudLocalCommandHistoryJson as canonical, canonicalCloudLocalCommandWriterSealDescriptor,
  type CloudLocalCommandHistoryHead, type CloudLocalCommandHistoryManifest, type CloudLocalCommandHistoryRecord,
  type CloudLocalCommandWriterSeal } from "@zeros/protocol/cloud-local-mirror";
import { captureCloudLocalCommandHistory } from "../cloud-local-command-queue-history";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { runMigrations } from "../db/migrations";
import { openSqlite } from "../db/sqlite";

const handles: Sqlite.Database[] = [], roots: string[] = [];
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 2, engineInstanceId: randomUUID(),
  bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
const repositoryRoot = "/srv/zeros/workspace";
function normal() { const db = openSqlite(":memory:"); handles.push(db); runMigrations(db); db.pragma("synchronous=NORMAL"); return db; }
function snapshot(db: Sqlite.Database) {
  return { chats: db.prepare("SELECT * FROM chats ORDER BY id").all(), messages: db.prepare("SELECT * FROM chat_messages ORDER BY chat_id,ord").all(),
    turns: db.prepare("SELECT * FROM turns ORDER BY chat_id,ord").all(), settings: db.prepare("SELECT * FROM settings ORDER BY key").all(),
    head: db.prepare("SELECT * FROM sync_meta").all(), tombstones: db.prepare("SELECT * FROM sync_tombstones ORDER BY kind,id").all() };
}
function fixture(payload = '{"title":"Read source","status":"completed","rawOutput":"exact tool output"}') {
  const source = normal(), db = normal(), root = mkdtempSync(join(tmpdir(), "zeros-canonical-rebuild-")); roots.push(root);
  source.prepare("INSERT INTO chats(id,folder,agent_id,title,session_id,provider_binding,created_at,updated_at,rev) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("chat", repositoryRoot + "/managed", "cursor", "History", "old-native-session", '{"version":1,"kind":"native","providerId":"cursor","resumeId":"old-native-session"}', 1, 2, 1);
  source.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES(?,?,?,?,?,?,?)")
    .run("chat", "turn", 0, "text", '{"role":"user","text":"synthetic"}', 1, 2);
  source.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES(?,?,?,?,?,?,?)")
    .run("chat", "tool", 1, "tool", payload, 2, 3);
  source.prepare("INSERT INTO turns(chat_id,turn_id,folder,agent_id,ord,started_at,ended_at,status,files,usage,rev) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run("chat", "turn", repositoryRoot + "/managed", "cursor", 0, 1, 2, "completed", '[{"path":"source","additions":1}]', '{"inputTokens":4,"outputTokens":8}', 4);
  source.prepare("UPDATE sync_meta SET next_rev=5 WHERE id=0").run();
  const commandId = randomUUID(), result = { version: 1, terminal: { commandId, conversationId: "chat", executionId: "old-execution",
    turnId: "turn", agentId: "cursor", status: "completed", stopReason: "end_turn", startedAt: 1, endedAt: 2,
    response: { stopReason: "end_turn", userMessageId: "turn" } } };
  const commandSource = { kind: "command" as const, commandId, executionId: "old-execution", intent: { userMessageId: "turn", agentId: "cursor" }, nativeResultSha256: digest(result) };
  const captureInput = { db: source, repositoryRoot, scope, conversationId: "chat", source: commandSource, nativeResult: result,
    restoreRevision: 1, eventSequence: 10, controls: [], redactDocument: (value: unknown) => value };
  const capture = captureCloudLocalCommandHistory(captureInput);
  expect(capture.manifest).toBeDefined();
  const file = join(root, "full.sqlite");
  const queue = new CloudLocalCommandQueue({ file, scope, engineLive: () => true, ready: () => true,
    history: () => ({ recordSequence: 4, eventSequence: 10 }), actors: {
      authorizeCurrent: () => { throw new Error("unused"); }, reauthorizeRecorded: () => { throw new Error("unused"); } } });
  queue.close();
  const full = openSqlite(file); handles.push(full);
  const insertDocument = full.prepare("INSERT OR REPLACE INTO local_command_history_documents(sha256,kind,document,bytes) VALUES(?,?,?,?)");
  for (const item of capture.documents) insertDocument.run(item.sha256,item.kind,item.canonicalDocument,Buffer.byteLength(item.canonicalDocument));
  full.prepare("INSERT INTO local_command_controls(conversation_id) VALUES('chat')").run();
  full.prepare(`INSERT INTO local_commands(id,conversation_id,position,state,payload,actor,user_message_id,agent_id,writer_epoch,generation,
    execution_id,result,created_at,updated_at) VALUES(?, 'chat',1,'succeeded',NULL,?,'turn','cursor',?,?,'old-execution',?,'1','2')`)
    .run(commandId,canonical({ scope }),scope.writerEpoch,scope.generation,canonical(result));
  const setHead = (head: CloudLocalCommandHistoryHead) => full.prepare(`INSERT INTO local_command_history_heads(conversation_id,restore_revision,document)
    VALUES('chat',?,?) ON CONFLICT(conversation_id) DO UPDATE SET restore_revision=excluded.restore_revision,document=excluded.document`)
    .run(head.history.restoreRevision,canonical(head));
  setHead(capture.historyHead);
  const descriptor = { version: 1 as const, scope, sealId: randomUUID(), sequence: 12, recordSequence: 4, eventSequence: 10, inventorySha256: "a".repeat(64) };
  const sourceSeal: CloudLocalCommandWriterSeal = { ...descriptor,
    sha256: createHash("sha256").update(canonicalCloudLocalCommandWriterSealDescriptor(descriptor)).digest("hex") };
  full.exec("CREATE TABLE local_command_writer_seals(writer_epoch TEXT PRIMARY KEY,document TEXT NOT NULL,ack TEXT)");
  const writeSeal = (seal: CloudLocalCommandWriterSeal) => {
    const { scope: originScope, ...fields } = seal;
    full.prepare("INSERT OR REPLACE INTO local_command_writer_seals(writer_epoch,document,ack) VALUES(?,?,?)")
      .run(originScope.writerEpoch,canonical(seal),canonical({ ...fields, writerEpoch: originScope.writerEpoch }));
  };
  writeSeal(sourceSeal);
  for (const [key,value] of [["sealedWriter",scope.writerEpoch],["journalHead","12"],["mirrorHead","12"]])
    full.prepare("INSERT OR REPLACE INTO local_command_metadata(key,value) VALUES(?,?)").run(key,value);
  const ledger = openSqlite(file,{ readonly: true, fileMustExist: true }); handles.push(ledger);
  const input = { db, ledger, repositoryRoot, scope, sourceSeal, conversationId: "chat" };
  const writeManifest = (manifest: CloudLocalCommandHistoryManifest) => {
    const bytes = canonical(manifest), sha256 = digest(manifest); insertDocument.run(sha256,"manifest",bytes,Buffer.byteLength(bytes));
    setHead({ ...capture.historyHead, originWriterEpoch: manifest.scope.writerEpoch, source: manifest.source, deleted: manifest.deleted,
      history: { restoreRevision: manifest.restoreRevision, recordSequence: manifest.recordSequence, eventSequence: manifest.eventSequence, manifestSha256: sha256 } });
  };
  const stale = () => {
    db.prepare("INSERT INTO chats(id,folder,title,session_id,provider_binding,created_at,updated_at,rev) VALUES('chat',?,'stale','stale-native','{}',1,1,1)")
      .run(repositoryRoot + "/managed");
    db.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,content,created_at,rev) VALUES('chat','stale',9,'text','{\"text\":\"stale answer\"}','stale answer',1,1)").run();
    db.prepare("INSERT INTO turns(chat_id,turn_id,ord,started_at,status,rev) VALUES('chat','stale',9,1,'running',1)").run();
  };
  return { input, db, source, full, ledger, capture, captureInput, result, commandSource, insertDocument, setHead, writeManifest, writeSeal, stale };
}
afterEach(() => { for (const db of handles.splice(0).reverse()) db.close(); for (const root of roots.splice(0)) rmSync(root,{ recursive: true, force: true }); });
async function rebuild(input: ReturnType<typeof fixture>["input"]) {
  const module = await import("../cloud-local-command-queue-history-rebuild");
  return module.rebuildCloudLocalCommandHistory(input);
}

describe("verified canonical FULL to NORMAL rebuild", () => {
  it("restores exact conversation/tool/turn state from a read-only FULL candidate and clears native binding", async () => {
    const f = fixture(); f.stale(); const before = f.ledger.prepare("SELECT * FROM local_commands").all();
    const result = await rebuild(f.input);
    expect(result).toMatchObject({ conversationId: "chat", historyHead: f.capture.historyHead, restored: true });
    expect(f.db.prepare("SELECT folder,title,session_id,provider_binding FROM chats WHERE id='chat'").get())
      .toEqual({ folder: repositoryRoot + "/managed", title: "History", session_id: null, provider_binding: null });
    expect(f.db.prepare("SELECT msg_id,ord,payload FROM chat_messages WHERE chat_id='chat' ORDER BY ord").all()).toEqual([
      { msg_id: "turn", ord: 0, payload: '{"role":"user","text":"synthetic"}' },
      { msg_id: "tool", ord: 1, payload: '{"title":"Read source","status":"completed","rawOutput":"exact tool output"}' }]);
    expect(f.db.prepare("SELECT status,files,usage FROM turns WHERE chat_id='chat'").get())
      .toEqual({ status: "completed", files: '[{"path":"source","additions":1}]', usage: '{"inputTokens":4,"outputTokens":8}' });
    expect(f.db.prepare("SELECT count(*) AS n FROM chat_messages_fts WHERE chat_messages_fts MATCH 'source'").get()).toEqual({ n: 1 });
    expect(f.ledger.prepare("SELECT * FROM local_commands").all()).toEqual(before);
    expect(f.db.pragma("synchronous",{ simple: true })).toBe(1);
  });
  it("is idempotent without new sync revisions or writes on the second identical rebuild", async () => {
    const f = fixture(); const first = await rebuild(f.input), before = snapshot(f.db);
    const changes = f.db.prepare("SELECT total_changes() AS n").get();
    expect(await rebuild(f.input)).toEqual(first); expect(snapshot(f.db)).toEqual(before);
    expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  });
  it("keeps prototype-like keys and native tool payload bytes inert and exact", async () => {
    const payload = '{"__proto__":{"marker":"kept"},"nested":{"constructor":"kept","prototype":"kept"}}';
    const f = fixture(payload); await rebuild(f.input);
    expect(f.db.prepare("SELECT payload FROM chat_messages WHERE msg_id='tool'").get()).toEqual({ payload });
    expect(({} as Record<string,unknown>).marker).toBeUndefined();
  });
  it.each(["incomplete","deleted"])("latest %s head removes stale normalized rows and fences an older complete snapshot", async kind => {
    const f = fixture(); f.stale(); const newest: CloudLocalCommandHistoryHead = { ...f.capture.historyHead,
      source: { kind: "mutation", mutationId: randomUUID(), operation: kind === "deleted" ? "delete" : "repair" }, deleted: kind === "deleted",
      history: { restoreRevision: 2, recordSequence: null, eventSequence: null, incompleteReason: "capture_unavailable" } };
    f.setHead(newest); const result = await rebuild(f.input);
    expect(result).toMatchObject({ historyHead: newest, restored: false });
    expect(f.db.prepare("SELECT count(*) AS n FROM chat_messages WHERE chat_id='chat'").get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT count(*) AS n FROM turns WHERE chat_id='chat'").get()).toEqual({ n: 0 });
    if(kind === "deleted") expect(f.db.prepare("SELECT * FROM chats WHERE id='chat'").get()).toBeUndefined();
    else expect(f.db.prepare("SELECT session_id,provider_binding FROM chats WHERE id='chat'").get()).toEqual({ session_id: null, provider_binding: null });
    const before = snapshot(f.db); f.setHead(f.capture.historyHead);
    await expect(rebuild(f.input)).rejects.toThrow("cloud_history_rebuild_refused"); expect(snapshot(f.db)).toEqual(before);
  });
  it("applies a verified full deletion manifest with its actual tombstone", async () => {
    const f = fixture(); f.stale(); f.source.prepare("DELETE FROM chats WHERE id='chat'").run();
    f.source.prepare("INSERT INTO sync_tombstones(kind,id,rev) VALUES('chat','chat',4)").run();
    const capture = captureCloudLocalCommandHistory({ ...f.captureInput, source: { kind: "mutation", mutationId: randomUUID(), operation: "delete" },
      restoreRevision: 2, nativeResult: null });
    for (const item of capture.documents) f.insertDocument.run(item.sha256,item.kind,item.canonicalDocument,Buffer.byteLength(item.canonicalDocument));
    f.setHead(capture.historyHead); expect(await rebuild(f.input)).toMatchObject({ historyHead: capture.historyHead, restored: false });
    expect(f.db.prepare("SELECT * FROM chats WHERE id='chat'").get()).toBeUndefined();
    expect(f.db.prepare("SELECT kind,id FROM sync_tombstones WHERE kind='chat'").all()).toEqual([{ kind: "chat", id: "chat" }]);
  });
  it("replaces a full snapshot, removing old tails and preserving foreign Local/sibling data", async () => {
    const f = fixture(); f.stale();
    f.db.prepare("INSERT INTO chats(id,folder,title,rev) VALUES('local','/personal/local','Local',7)").run();
    f.db.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES('local','keep',0,'text','{}',1,7)").run();
    const sibling = f.db.prepare("SELECT * FROM chats WHERE id='local'").get(); await rebuild(f.input);
    expect(f.db.prepare("SELECT * FROM chats WHERE id='local'").get()).toEqual(sibling);
    expect(f.db.prepare("SELECT * FROM chat_messages WHERE chat_id='local'").all()).toHaveLength(1);
    expect(f.db.prepare("SELECT * FROM chat_messages WHERE msg_id='stale'").all()).toEqual([]);
  });
  it("refuses a colliding Local conversation outside the trusted repository", async () => {
    const f = fixture(); f.stale(); f.db.prepare("UPDATE chats SET folder='/personal/local' WHERE id='chat'").run(); const before = snapshot(f.db);
    await expect(rebuild(f.input)).rejects.toThrow("cloud_history_rebuild_refused"); expect(snapshot(f.db)).toEqual(before);
  });
  it.each(["scope","seal-digest","writer","missing","digest","kind","bytes","head-source","command-result","manifest-scope","reference","folder"])("refuses %s mismatch before any NORMAL mutation", async mismatch => {
    const f = fixture(); f.stale(); const before = snapshot(f.db), manifest = structuredClone(f.capture.manifest!);
    if(mismatch === "scope") f.input.scope = { ...scope, workspaceId: randomUUID() };
    if(mismatch === "seal-digest") f.input.sourceSeal = { ...f.input.sourceSeal, sha256: "f".repeat(64) };
    if(mismatch === "writer") f.full.prepare("UPDATE local_command_metadata SET value=? WHERE key='writer'").run(canonical({ ...scope, bootId: randomUUID() }));
    if(mismatch === "missing") f.full.prepare("DELETE FROM local_command_history_documents WHERE sha256=?").run(manifest.records[0]!.sha256);
    if(mismatch === "digest") f.full.prepare("UPDATE local_command_history_documents SET document=replace(document,'History','Changed') WHERE sha256=?").run(manifest.records[0]!.sha256);
    if(mismatch === "kind") f.full.prepare("UPDATE local_command_history_documents SET kind='manifest' WHERE sha256=?").run(manifest.records[0]!.sha256);
    if(mismatch === "bytes") f.full.prepare("UPDATE local_command_history_documents SET bytes=bytes+1 WHERE sha256=?").run(manifest.records[0]!.sha256);
    if(mismatch === "head-source") f.setHead({ ...f.capture.historyHead, source: { ...f.commandSource, executionId: "other" } });
    if(mismatch === "command-result") f.full.prepare("UPDATE local_commands SET result='{}'").run();
    if(mismatch === "manifest-scope") { manifest.scope = { ...scope, fundingOwnerEpoch: 2 }; f.writeManifest(manifest); }
    if(mismatch === "reference") { manifest.records[0] = { ...manifest.records[0]!, entityId: "another-chat" }; f.writeManifest(manifest); }
    if(mismatch === "folder") {
      const row = f.full.prepare("SELECT document FROM local_command_history_documents WHERE sha256=?").get(manifest.records[0]!.sha256) as { document: string };
      const record = JSON.parse(row.document) as CloudLocalCommandHistoryRecord;
      record.document = { version: 1, chat: { ...record.document.chat as Record<string,unknown>, folder: "../escape" } };
      const bytes = canonical(record), sha256 = digest(record); f.insertDocument.run(sha256,"record",bytes,Buffer.byteLength(bytes));
      manifest.records[0] = { ...manifest.records[0]!, sha256 }; f.writeManifest(manifest);
    }
    await expect(rebuild(f.input)).rejects.toThrow("cloud_history_rebuild_refused"); expect(snapshot(f.db)).toEqual(before);
  });
  it("refuses a different head at the same restore revision", async () => {
    const f = fixture(); await rebuild(f.input); const before = snapshot(f.db);
    f.setHead({ ...f.capture.historyHead, history: { restoreRevision: 1, recordSequence: 4, eventSequence: 10, incompleteReason: "history_limit" } });
    await expect(rebuild(f.input)).rejects.toThrow("cloud_history_rebuild_refused"); expect(snapshot(f.db)).toEqual(before);
  });
  it("rolls back the whole normalized replacement if one SQLite write fails", async () => {
    const f = fixture(); f.stale(); const before = snapshot(f.db);
    f.db.exec("CREATE TRIGGER deny_restore BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    await expect(rebuild(f.input)).rejects.toThrow("cloud_history_rebuild_refused"); expect(snapshot(f.db)).toEqual(before);
  });
  it.each(["missing-seal","missing-ack","foreign-ack","changed-seal"])("refuses %s even when the caller supplies a syntactically valid source seal", async mismatch => {
    const f = fixture(); f.stale(); const before = snapshot(f.db);
    if(mismatch === "missing-seal") f.full.prepare("DELETE FROM local_command_writer_seals").run();
    if(mismatch === "missing-ack") f.full.prepare("UPDATE local_command_writer_seals SET ack=NULL").run();
    if(mismatch === "foreign-ack") {
      const { scope: originScope, ...fields } = f.input.sourceSeal;
      f.full.prepare("UPDATE local_command_writer_seals SET ack=?")
        .run(canonical({ ...fields, writerEpoch: originScope.writerEpoch, sealId: randomUUID() }));
    }
    if(mismatch === "changed-seal") f.full.prepare("UPDATE local_command_writer_seals SET document=?")
      .run(canonical({ ...f.input.sourceSeal, inventorySha256: "b".repeat(64) }));
    await expect(rebuild(f.input)).rejects.toThrow("cloud_history_rebuild_refused"); expect(snapshot(f.db)).toEqual(before);
  });
  it("retains an earlier command's boot and funding provenance without native resurrection", async () => {
    const f = fixture(), origin = { ...scope, generation: 1, engineInstanceId: randomUUID(), bootId: randomUUID(),
      writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID() };
    f.full.prepare("UPDATE local_commands SET actor=?,writer_epoch=?,generation=?").run(canonical({ scope: origin }),origin.writerEpoch,origin.generation);
    const manifest = structuredClone(f.capture.manifest!); manifest.scope = origin; f.writeManifest(manifest);
    const result = await rebuild(f.input);
    expect(result.historyHead.originWriterEpoch).toBe(origin.writerEpoch);
    expect(result.historyHead.source).toEqual(f.commandSource);
    expect(f.db.prepare("SELECT session_id,provider_binding,provider_metadata FROM chats WHERE id='chat'").get())
      .toEqual({ session_id: null, provider_binding: null, provider_metadata: null });
    expect(f.ledger.prepare("SELECT writer_epoch,actor FROM local_commands").get())
      .toEqual({ writer_epoch: origin.writerEpoch, actor: canonical({ scope: origin }) });
  });
  it("newer incomplete history removes an already rebuilt transcript without resurrecting old CAS", async () => {
    const f = fixture(); await rebuild(f.input);
    const newest: CloudLocalCommandHistoryHead = { originWriterEpoch: scope.writerEpoch,
      source: { kind: "mutation", mutationId: randomUUID(), operation: "repair" }, deleted: false,
      history: { restoreRevision: 2, recordSequence: 4, eventSequence: 10, incompleteReason: "history_limit" } };
    f.setHead(newest); expect(await rebuild(f.input)).toMatchObject({ historyHead: newest, restored: false });
    expect(f.db.prepare("SELECT * FROM chat_messages WHERE chat_id='chat'").all()).toEqual([]);
    expect(f.db.prepare("SELECT * FROM turns WHERE chat_id='chat'").all()).toEqual([]);
    const before = snapshot(f.db); f.setHead(f.capture.historyHead);
    await expect(rebuild(f.input)).rejects.toThrow("cloud_history_rebuild_refused"); expect(snapshot(f.db)).toEqual(before);
  });
  it.each(["complete","incomplete"])("preserves a sealed predecessor mutation's %s current head", async kind => {
    const f = fixture(), origin = { ...scope, generation: 1, bootId: randomUUID(), engineInstanceId: randomUUID(), writerEpoch: randomUUID() };
    const descriptor = { ...f.input.sourceSeal, scope: origin }; const originSeal = { ...descriptor,
      sha256: createHash("sha256").update(canonicalCloudLocalCommandWriterSealDescriptor(descriptor)).digest("hex") };
    f.writeSeal(originSeal);
    const source = { kind: "mutation" as const, mutationId: randomUUID(), operation: "repair" as const };
    if(kind === "complete") { const manifest = structuredClone(f.capture.manifest!); manifest.scope = origin; manifest.source = source; f.writeManifest(manifest); }
    else f.setHead({ originWriterEpoch: origin.writerEpoch, source, deleted: false,
      history: { restoreRevision: 2, recordSequence: null, eventSequence: null, incompleteReason: "capture_unavailable" } });
    expect(await rebuild(f.input)).toMatchObject({ restored: kind === "complete", historyHead: { originWriterEpoch: origin.writerEpoch, source } });
  });
  it.each(["missing","unacknowledged","foreign"])("refuses %s predecessor mutation origin proof without using old complete data", async mismatch => {
    const f = fixture(); f.stale(); const before = snapshot(f.db);
    const origin = { ...scope, generation: 1, bootId: randomUUID(), engineInstanceId: randomUUID(), writerEpoch: randomUUID() };
    const descriptor = { ...f.input.sourceSeal, scope: mismatch === "foreign" ? { ...origin, workspaceId: randomUUID() } : origin };
    const originSeal = { ...descriptor, sha256: createHash("sha256").update(canonicalCloudLocalCommandWriterSealDescriptor(descriptor)).digest("hex") };
    f.writeSeal(originSeal);
    if(mismatch === "missing") f.full.prepare("DELETE FROM local_command_writer_seals WHERE writer_epoch=?").run(origin.writerEpoch);
    if(mismatch === "unacknowledged") f.full.prepare("UPDATE local_command_writer_seals SET ack=NULL WHERE writer_epoch=?").run(origin.writerEpoch);
    const manifest = structuredClone(f.capture.manifest!); manifest.scope = origin;
    manifest.source = { kind: "mutation", mutationId: randomUUID(), operation: "repair" }; f.writeManifest(manifest);
    await expect(rebuild(f.input)).rejects.toThrow("cloud_history_rebuild_refused"); expect(snapshot(f.db)).toEqual(before);
  });
  it("returns a detached immutable source intent for snapshot fencing", async () => {
    const f = fixture(), result = await rebuild(f.input);
    const source = result.historyHead.source;
    expect(source.kind).toBe("command");
    if(source.kind !== "command") throw new Error("expected command source");
    expect(Object.isFrozen(source.intent)).toBe(true);
    expect(() => { source.intent.userMessageId = "replacement"; }).toThrow(TypeError);
    expect(f.capture.historyHead.source).toEqual(f.commandSource);
  });
});
