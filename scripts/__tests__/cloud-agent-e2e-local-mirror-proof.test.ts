import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { canonicalCloudLocalCommandHistoryJson as canonical } from "@zeros/protocol/cloud-local-mirror";
import { readFixtureLocalMirrorProof, LocalMirrorProofSchema } from "../cloud-workspace-validation/cloud-agent-e2e/local-mirror-proof";

const sha = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE local_command_metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE local_commands(id TEXT,conversation_id TEXT,writer_epoch TEXT,position INTEGER,state TEXT,payload TEXT,
      execution_id TEXT,generation INTEGER,result_code TEXT,result TEXT,created_at TEXT,updated_at TEXT,history TEXT,
      user_message_id TEXT,agent_id TEXT,mirror_dirty INTEGER DEFAULT 0);
    CREATE TABLE local_command_controls(conversation_id TEXT,mirror_dirty INTEGER);
    CREATE TABLE local_command_history_heads(conversation_id TEXT,document TEXT);
    CREATE TABLE local_command_history_documents(sha256 TEXT,kind TEXT,document TEXT,bytes INTEGER);
    CREATE TABLE local_command_journal(sequence INTEGER); CREATE TABLE local_command_outbox_jobs(id INTEGER);
    CREATE TABLE local_command_mirror_batches(writer_epoch TEXT);`);
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const commandId = randomUUID(), conversationId = randomUUID(), timestamp = "2026-10-08T00:00:00Z";
  const result = { version: 1 }, intent = { userMessageId: randomUUID(), agentId: "claude" };
  const source = { kind: "command", commandId, executionId: "execution", intent, nativeResultSha256: sha(result) };
  const history = { restoreRevision: 1, recordSequence: 4, eventSequence: 9, incompleteReason: "capture_unavailable" };
  const head = { originWriterEpoch: scope.writerEpoch, source, deleted: false, history };
  db.prepare("INSERT INTO local_command_metadata VALUES('writer',?)").run(canonical(scope));
  db.prepare("INSERT INTO local_command_metadata VALUES('mirrorHead','0'),('journalHead','0')").run();
  db.prepare(`INSERT INTO local_commands(id,conversation_id,writer_epoch,position,state,payload,execution_id,generation,result_code,result,created_at,updated_at,history)
    VALUES(?,?,?,1,'failed',NULL,'execution',1,'cloud_provider_prompt_auth_required',?,?,?,?)`)
    .run(commandId, conversationId, scope.writerEpoch, canonical(result), timestamp, timestamp, canonical(history));
  db.prepare("UPDATE local_commands SET user_message_id=?,agent_id=?").run(intent.userMessageId, intent.agentId);
  db.prepare("INSERT INTO local_command_history_heads VALUES(?,?)").run(conversationId, canonical(head));
  const entry = { commandId, position: 1, state: "failed", payload: null, executionId: "execution", generation: 1,
    resultCode: "cloud_provider_prompt_auth_required", result, createdAt: timestamp, updatedAt: timestamp };
  return { db, scope, commandId, conversationId, result, entry, head, history };
}
function complete(f: ReturnType<typeof fixture>) {
  const record = { version: 1, conversationId: f.conversationId, entityKind: "message", entityId: "message", schemaVersion: 1,
    sourceRevision: 4, document: { text: "private-native-prose-sentinel" } };
  const manifest = { version: 1, snapshot: "full", scope: f.scope, conversationId: f.conversationId, restoreRevision: 1,
    deleted: false, tombstones: [], recordSequence: 4, eventSequence: 9, source: f.head.source,
    records: [{ entityKind: "message", entityId: "message", schemaVersion: 1, sourceRevision: 4, sha256: sha(record) }] };
  const history = { restoreRevision: 1, recordSequence: 4, eventSequence: 9, manifestSha256: sha(manifest) };
  for (const [kind, value] of [["record", record], ["manifest", manifest]] as const) f.db.prepare("INSERT INTO local_command_history_documents VALUES(?,?,?,?)")
    .run(sha(value), kind, canonical(value), Buffer.byteLength(canonical(value)));
  f.db.prepare("UPDATE local_commands SET history=?").run(canonical(history));
  f.db.prepare("UPDATE local_command_history_heads SET document=?").run(canonical({ ...f.head, history }));
  return { record, manifest, history };
}
describe("closed independent SQLite mirror proof", () => {
  it("hashes an exact settled local receipt and honest incomplete head without retaining prose", () => {
    const f = fixture(); try {
      const result = readFixtureLocalMirrorProof(f.db, { scope: f.scope, commandId: f.commandId, conversationId: f.conversationId });
      expect(LocalMirrorProofSchema.parse(result)).toMatchObject({ receiptSha256: sha(f.entry), auditSha256: sha(f.history), headSha256: sha(f.head),
        history: "incomplete", incompleteReason: "capture_unavailable", recordCount: 0, recordsSha256: null, outboxPending: false });
      expect(JSON.stringify(result)).not.toContain("private-native-prose-sentinel");
    } finally { f.db.close(); }
  });
  it("verifies actual canonical CAS bytes before reporting complete metadata hashes", () => {
    const f = fixture(); try {
      const c = complete(f), proof = readFixtureLocalMirrorProof(f.db, { scope: f.scope, commandId: f.commandId, conversationId: f.conversationId });
      expect(proof).toMatchObject({ history: "complete", recordsSha256: sha([c.record]), recordCount: 1,
        recordBytes: Buffer.byteLength(canonical(c.record)), auditSha256: sha(c.history), incompleteReason: null });
      expect(JSON.stringify(proof)).not.toContain("private-native-prose-sentinel");
    } finally { f.db.close(); }
  });
  it.each(["writer", "receipt", "head", "missing-record", "changed-bytes", "wrong-manifest", "foreign-record", "source-provider", "source-turn"])("refuses %s proof with a closed failure", kind => {
    const f = fixture(); try {
      if (kind === "source-provider") f.head.source.intent.agentId = "codex";
      if (kind === "source-turn") f.head.source.intent.userMessageId = randomUUID();
      const c = complete(f);
      if (kind === "writer") f.db.prepare("UPDATE local_command_metadata SET value=?").run(canonical({ ...f.scope, writerEpoch: randomUUID() }));
      if (kind === "receipt") f.db.prepare("UPDATE local_commands SET state='dispatching',payload='{}'").run();
      if (kind === "head") f.db.prepare("DELETE FROM local_command_history_heads").run();
      if (kind === "missing-record") f.db.prepare("DELETE FROM local_command_history_documents WHERE kind='record'").run();
      if (kind === "changed-bytes") f.db.prepare("UPDATE local_command_history_documents SET document='{}' WHERE kind='record'").run();
      if (kind === "wrong-manifest") f.db.prepare("UPDATE local_command_history_documents SET kind='record' WHERE kind='manifest'").run();
      if (kind === "foreign-record") {
        const record = { ...c.record, conversationId: randomUUID() }, manifest = { ...c.manifest, records: [{ ...c.manifest.records[0]!, sha256: sha(record) }] };
        f.db.prepare("UPDATE local_command_history_documents SET sha256=?,document=?,bytes=? WHERE kind='record'")
          .run(sha(record), canonical(record), Buffer.byteLength(canonical(record)));
        f.db.prepare("UPDATE local_command_history_documents SET sha256=?,document=?,bytes=? WHERE kind='manifest'")
          .run(sha(manifest), canonical(manifest), Buffer.byteLength(canonical(manifest)));
        f.db.prepare("UPDATE local_command_history_heads SET document=?").run(canonical({ ...f.head, history: { ...c.history, manifestSha256: sha(manifest) } }));
      }
      expect(() => readFixtureLocalMirrorProof(f.db, { scope: f.scope, commandId: f.commandId, conversationId: f.conversationId }))
        .toThrow("fixture_inspection_failed");
    } finally { f.db.close(); }
  });
  it.each(["dirty-command", "dirty-control", "journal", "job", "unknown-ack-flight", "head-gap"])("keeps %s visible until exact local drain", kind => {
    const f = fixture(); try {
      if (kind === "dirty-command") f.db.prepare("UPDATE local_commands SET mirror_dirty=1").run();
      if (kind === "dirty-control") f.db.prepare("INSERT INTO local_command_controls VALUES(?,1)").run(f.conversationId);
      if (kind === "journal") f.db.prepare("INSERT INTO local_command_journal VALUES(1)").run();
      if (kind === "job") f.db.prepare("INSERT INTO local_command_outbox_jobs VALUES(1)").run();
      if (kind === "unknown-ack-flight") f.db.prepare("INSERT INTO local_command_mirror_batches VALUES(?)").run(f.scope.writerEpoch);
      if (kind === "head-gap") f.db.prepare("UPDATE local_command_metadata SET value='1' WHERE key='journalHead'").run();
      expect(readFixtureLocalMirrorProof(f.db, { scope: f.scope, commandId: f.commandId, conversationId: f.conversationId }).outboxPending).toBe(true);
    } finally { f.db.close(); }
  });
  it("refuses invalid durable cursors even when no pending rows remain", () => {
    const f = fixture(); try {
      f.db.prepare("UPDATE local_command_metadata SET value='invalid' WHERE key='mirrorHead'").run();
      expect(() => readFixtureLocalMirrorProof(f.db, { scope: f.scope, commandId: f.commandId, conversationId: f.conversationId })).toThrow("fixture_inspection_failed");
    } finally { f.db.close(); }
  });
});
