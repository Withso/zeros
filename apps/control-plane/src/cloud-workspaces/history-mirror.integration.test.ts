import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx, type Tx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { CloudNativeResultSchema } from "./commands.js";
import { applyMirroredCloudAgentHistory } from "./history.js";
import { canonicalCloudHistoryJson, HISTORY_PART_BYTES, HISTORY_WORKSPACE_BYTES, type CloudLocalHistoryManifest, type CloudLocalHistoryRecord } from "./history-local-contract.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("atomic canonical cloud history projection", () => {
  let pool: pg.Pool, workspace: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let bootId: string, writerEpoch: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    workspace = await seedReadyCloudWorkspace(pool);
    bootId = (await pool.query<{ id: string }>("SELECT runtime_boot_id AS id FROM cloud_workspace_engine_instances WHERE id=$1", [workspace.engineInstanceId])).rows[0]!.id;
    writerEpoch = randomUUID(); const bindingId = randomUUID();
    // Genuine relational identity, not proof of production cache/native/FULL
    // activation. The mirror caller separately authenticates and locks it.
    await pool.query(`INSERT INTO cloud_workspace_local_command_writers(workspace_id,org_id,generation,engine_instance_id,
      boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch) VALUES($1,$2,1,$3,$4,$5,$6,1)`,
    [workspace.workspaceId, workspace.organizationId, workspace.engineInstanceId, bootId, writerEpoch, workspace.userId]);
    await pool.query(`INSERT INTO cloud_agent_boot_bindings(id,workspace_id,org_id,generation,engine_instance_id,
      boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,credentials_initialized)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,1,true)`,
    [bindingId, workspace.workspaceId, workspace.organizationId, workspace.engineInstanceId, bootId, writerEpoch, workspace.userId]);
    await pool.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now() WHERE writer_epoch=$1", [writerEpoch]);
    await pool.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1", [workspace.workspaceId, bindingId]);
  });
  const boot = () => ({ organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, generation: 1,
    engineInstanceId: workspace.engineInstanceId, bootId, writerEpoch, fundingOwnerUserId: workspace.userId, fundingOwnerEpoch: 1 });
  const parent = (outboxSequence = 1) => ({ organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, writerEpoch, outboxSequence });
  const record = (overrides: Partial<CloudLocalHistoryRecord> = {}): CloudLocalHistoryRecord => ({ version: 1, conversationId: "chat",
    entityKind: "message", entityId: "message", schemaVersion: 1, sourceRevision: 4,
    document: { version: 1, chatId: "chat", msgId: "message", ord: 1, kind: "tool_call", createdAt: 1,
      payload: JSON.stringify({ kind: "tool_call", status: "completed", toolCallId: "read", rawOutput: { text: "Preserved tool result" } }) }, ...overrides });
  const digest = (value: unknown) => createHash("sha256").update(canonicalCloudHistoryJson(value)).digest("hex");
  const parts = (kind: "record" | "manifest", document: unknown) => {
    const bytes = Buffer.from(canonicalCloudHistoryJson(document)), sha256 = digest(document);
    return Array.from({ length: Math.ceil(bytes.length / HISTORY_PART_BYTES) }, (_, index) => ({ version: 1, kind, sha256,
      index, count: Math.ceil(bytes.length / HISTORY_PART_BYTES), bytes: bytes.length,
      data: bytes.subarray(index * HISTORY_PART_BYTES, (index + 1) * HISTORY_PART_BYTES).toString("base64") }));
  };
  const manifest = (records: CloudLocalHistoryRecord[], revision = 1): CloudLocalHistoryManifest => ({ version: 1, snapshot: "full",
    scope: boot(), conversationId: "chat", restoreRevision: revision, deleted: false, tombstones: [], recordSequence: 4, eventSequence: 99,
    source: { kind: "mutation", mutationId: randomUUID(), operation: "repair" }, records: records.map(value => ({ entityKind: value.entityKind,
      entityId: value.entityId, schemaVersion: 1, sourceRevision: value.sourceRevision, sha256: digest(value) })) });
  const head = (value: CloudLocalHistoryManifest) => ({ originWriterEpoch: writerEpoch, source: value.source, deleted: value.deleted,
    history: { restoreRevision: value.restoreRevision, recordSequence: value.recordSequence, eventSequence: value.eventSequence, manifestSha256: digest(value) } });
  const mirror = (body: (tx: Tx) => Promise<unknown>) => withSystemTx(pool, async tx => {
    await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [workspace.workspaceId, workspace.organizationId]);
    await tx.query("SELECT writer_epoch FROM cloud_workspace_local_command_writers WHERE workspace_id=$1 AND writer_epoch=$2 FOR UPDATE", [workspace.workspaceId, writerEpoch]);
    return body(tx);
  });
  const stage = async (kind: "record" | "manifest", document: unknown) => {
    for (const historyPart of parts(kind, document)) await mirror(tx => applyMirroredCloudAgentHistory(tx, parent(), { conversationId: "chat", historyPart }));
  };
  const publish = (value: CloudLocalHistoryManifest, sequence = 2) => mirror(tx => applyMirroredCloudAgentHistory(tx, parent(sequence), { conversationId: "chat", historyHead: head(value) }));
  const heads = () => withSystemTx(pool, tx => tx.query("SELECT * FROM cloud_workspace_local_command_history_heads WHERE workspace_id=$1", [workspace.workspaceId]));
  const blobs = () => withSystemTx(pool, tx => tx.query("SELECT * FROM cloud_workspace_local_command_history_blobs WHERE workspace_id=$1", [workspace.workspaceId]));

  it("stores immutable verified canonical bytes once and leaves legacy history untouched", async () => {
    const value = record(); await stage("record", value); await stage("record", value);
    expect((await blobs()).rows).toMatchObject([{ canonical_document: canonicalCloudHistoryJson(value), kind: "record", origin_writer_epoch: writerEpoch }]);
    expect((await blobs()).rowCount).toBe(1);
    expect((await pool.query("SELECT count(*) FROM workspace_record_entities")).rows[0]!.count).toBe("0");
  });
  it("retains parts without exposing a blob until the entire deterministic prefix verifies", async () => {
    const value = record({ document: { text: "界".repeat(60_000) } }), chunks = parts("record", value);
    expect(chunks).toHaveLength(2);
    await mirror(tx => applyMirroredCloudAgentHistory(tx, parent(), { conversationId: "chat", historyPart: chunks[0] }));
    expect((await blobs()).rowCount).toBe(0); expect((await heads()).rowCount).toBe(0);
    await mirror(tx => applyMirroredCloudAgentHistory(tx, parent(2), { conversationId: "chat", historyPart: chunks[1] }));
    expect((await blobs()).rowCount).toBe(1);
  });
  it("rejects mismatched canonical digest and rolls back the last supplied part", async () => {
    const chunk = { ...parts("record", record())[0]!, sha256: "a".repeat(64) };
    await expect(mirror(tx => applyMirroredCloudAgentHistory(tx, parent(), { conversationId: "chat", historyPart: chunk })))
      .rejects.toMatchObject({ code: "cloud_history_conflict" });
    expect((await blobs()).rowCount).toBe(0);
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_local_command_history_parts")).rows[0]!.count).toBe("0");
  });
  it("rejects foreign conversation, boot, tenant and reserved/noncurrent writer", async () => {
    await expect(stage("record", record({ conversationId: "other" }))).rejects.toMatchObject({ code: "cloud_history_conflict" });
    const value = manifest([]); value.scope.bootId = randomUUID();
    await expect(stage("manifest", value)).rejects.toMatchObject({ code: "cloud_history_conflict" });
    await expect(mirror(tx => applyMirroredCloudAgentHistory(tx, { ...parent(), organizationId: randomUUID() }, { conversationId: "chat", historyPart: parts("record", record())[0] }))).rejects.toThrow();
    await expect(mirror(tx => applyMirroredCloudAgentHistory(tx, { ...parent(), writerEpoch: randomUUID() }, { conversationId: "chat", historyPart: parts("record", record())[0] }))).rejects.toThrow();
    expect((await blobs()).rowCount).toBe(0);
  });
  it("refuses orphan references instead of publishing a complete head", async () => {
    const value = manifest([record()]); await stage("manifest", value);
    await expect(publish(value)).rejects.toMatchObject({ code: "cloud_history_conflict" });
    expect((await heads()).rowCount).toBe(0);
  });
  it("validates every record identity and cumulative bundle before head publication", async () => {
    const r = record(), value = manifest([r]); value.records[0]!.entityId = "other";
    await stage("record", r); await stage("manifest", value);
    await expect(publish(value)).rejects.toMatchObject({ code: "cloud_history_conflict" });
    expect((await heads()).rowCount).toBe(0);
  });
  it("publishes complete full history including tool state and exact sparse VM cursors", async () => {
    const r = record(), value = manifest([r]); await stage("record", r); await stage("manifest", value); await publish(value);
    expect((await heads()).rows).toMatchObject([{ restore_revision: "1", record_sequence: "4", event_sequence: "99",
      complete: true, source: value.source, outbox_sequence: "2" }]);
    expect((await blobs()).rows.find(row => row.kind === "record")!.canonical_document).toContain("Preserved tool result");
    await expect(publish(value, 3)).resolves.toMatchObject({ historyLimit: false });
    expect((await heads()).rowCount).toBe(1);
  });
  it("a newer incomplete mutation fences old complete history without inventing native intent", async () => {
    const value = manifest([]); await stage("manifest", value); await publish(value);
    const source = { kind: "mutation", mutationId: randomUUID(), operation: "delete" };
    await mirror(tx => applyMirroredCloudAgentHistory(tx, parent(3), { conversationId: "chat", historyHead: {
      originWriterEpoch: writerEpoch, source, deleted: true,
      history: { restoreRevision: 2, recordSequence: null, eventSequence: null, incompleteReason: "capture_unavailable" } } }));
    expect((await heads()).rows).toMatchObject([{ restore_revision: "2", complete: false, deleted: true, source,
      manifest_sha256: null, record_sequence: null, event_sequence: null, incomplete_reason: "capture_unavailable" }]);
    await expect(publish(value, 4)).resolves.toMatchObject({ historyLimit: false });
    expect((await heads()).rows[0]!.restore_revision).toBe("2");
  });
  it("refuses equal-revision changed source including incomplete mutation operation", async () => {
    const source = { kind: "mutation", mutationId: randomUUID(), operation: "delete" };
    const historyHead = { originWriterEpoch: writerEpoch, source, deleted: true,
      history: { restoreRevision: 1, recordSequence: null, eventSequence: null, incompleteReason: "recovery_uncertain" } };
    await mirror(tx => applyMirroredCloudAgentHistory(tx, parent(), { conversationId: "chat", historyHead }));
    await expect(mirror(tx => applyMirroredCloudAgentHistory(tx, parent(2), { conversationId: "chat", historyHead: {
      ...historyHead, source: { ...source, operation: "repair" } } }))).rejects.toMatchObject({ code: "cloud_history_conflict" });
    expect((await heads()).rows[0]!.source).toEqual(source);
  });
  it("requires command manifest intent/execution/result to join the exact stored original command", async () => {
    const commandId = randomUUID(), result = CloudNativeResultSchema.parse({ version: 1, terminal: { commandId,
      conversationId: "chat", executionId: "execution", turnId: "turn", agentId: "cursor", status: "failed", stopReason: null,
      error: "Synthetic invalid credential", failure: { kind: "auth-required", message: "Synthetic invalid credential", stage: "prompt" } } });
    await mirror(async tx => {
      await tx.query(`INSERT INTO cloud_workspace_local_command_controls(workspace_id,org_id,writer_epoch,conversation_id,revision,paused)
        VALUES($1,$2,$3,'chat',1,false)`, [workspace.workspaceId, workspace.organizationId, writerEpoch]);
      const actor = { scope: boot(), actor: { userId: workspace.userId, deviceId: randomUUID(), deviceKeyVersion: 1,
        fingerprint: "a".repeat(64), role: "owner" }, actorSessionId: randomUUID(), authorityEpoch: 1,
        confirmedUntilMs: 1, fundingConsentVersion: 1, fundingGrant: { kind: "owner" } };
      await tx.query(`INSERT INTO cloud_workspace_local_commands(workspace_id,org_id,id,conversation_id,writer_epoch,projection_epoch,
        user_message_id,agent_id,position,state,payload,generation,execution_id,result,actor_provenance,mirror_sequence,created_at,updated_at)
        VALUES($1,$2,$3,'chat',$4,$4,'turn','cursor',1,'dispatching','{}',1,'execution',$5,$6,1,now(),now())`,
      [workspace.workspaceId, workspace.organizationId, commandId, writerEpoch, JSON.stringify(result), JSON.stringify(actor)]);
    });
    const value = manifest([]); value.source = { kind: "command", commandId,
      intent: { userMessageId: "turn", agentId: "cursor" }, executionId: "execution", nativeResultSha256: digest(result) };
    await stage("manifest", value); await publish(value);
    for (const source of [{ ...value.source, commandId: randomUUID() }, { ...value.source, executionId: "replacement" },
      { ...value.source, intent: { userMessageId: "later-turn", agentId: "cursor" } }, { ...value.source, nativeResultSha256: "b".repeat(64) }]) {
      const bad = { ...value, restoreRevision: 2, source }; await stage("manifest", bad);
      await expect(publish(bad, 3)).rejects.toMatchObject({ code: "cloud_history_conflict" });
    }
    await mirror(async tx => {
      await applyMirroredCloudAgentHistory(tx, parent(4), { conversationId: "chat", historyHead: head(value) });
      await tx.query(`UPDATE cloud_workspace_local_commands SET state='failed',payload=NULL,
        result_code='cloud_provider_prompt_auth_required',history_restore_revision=1,history_record_sequence=4,history_event_sequence=99,
        history_manifest_sha256=$3 WHERE workspace_id=$1 AND id=$2`, [workspace.workspaceId, commandId, Buffer.from(digest(value), "hex")]);
    });
    expect((await pool.query("SELECT state,payload,result,result_code FROM cloud_workspace_local_commands WHERE id=$1", [commandId])).rows)
      .toEqual([{ state: "failed", payload: null, result, result_code: "cloud_provider_prompt_auth_required" }]);
    await expect(pool.query("UPDATE cloud_workspace_local_commands SET result='{}' WHERE id=$1", [commandId]))
      .rejects.toMatchObject({ code: "23514" });
  });
  it("bounds the FULL cumulative conversation, not merely the latest record or turn", async () => {
    const records = Array.from({ length: 34 }, (_, index) => record({ entityId: `record-${index}`, document: { text: "x".repeat(500_000) } }));
    // Seed already verified immutable CAS rows to isolate finalization's real
    // byte-accounting query; individual decoder coverage is in the prior cases.
    await mirror(async tx => {
      for (const value of records) await tx.query(`INSERT INTO cloud_workspace_local_command_history_blobs(workspace_id,org_id,
        document_sha256,kind,canonical_document,origin_writer_epoch,verified_sequence) VALUES($1,$2,$3,'record',$4,$5,1)`,
      [workspace.workspaceId, workspace.organizationId, Buffer.from(digest(value), "hex"), canonicalCloudHistoryJson(value), writerEpoch]);
    });
    const value = manifest(records); await stage("manifest", value);
    await expect(publish(value)).rejects.toMatchObject({ code: "cloud_history_conflict" });
    expect((await heads()).rowCount).toBe(0);
  });
  it("reports part-only quota failure explicitly, without a successful dropped-part ACK", async () => {
    const value = record(), historyPart = parts("record", value)[0]!;
    const result = await mirror(tx => {
      const capacityPort = { query: (sql: string, values: unknown[]) => /sum\(octet_length\(data\)\)/.test(sql)
        ? Promise.resolve({ rows: [{ bytes: String(HISTORY_WORKSPACE_BYTES) }], rowCount: 1 }) : tx.query(sql, values) } as unknown as Tx;
      return applyMirroredCloudAgentHistory(capacityPort, parent(), { conversationId: "chat", historyPart });
    });
    expect(result).toEqual({ historyLimit: true });
    expect((await blobs()).rowCount).toBe(0);
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_local_command_history_parts")).rows[0]!.count).toBe("0");
  });
  it("publishes an honest quota-limited current head when final parts cannot be stored", async () => {
    const value = manifest([]);
    await mirror(async tx => {
      const capacityPort = { query: (sql: string, values: unknown[]) => /sum\(octet_length\(data\)\)/.test(sql)
        ? Promise.resolve({ rows: [{ bytes: String(HISTORY_WORKSPACE_BYTES) }], rowCount: 1 }) : tx.query(sql, values) } as unknown as Tx;
      expect(await applyMirroredCloudAgentHistory(capacityPort, parent(), { conversationId: "chat",
        historyPart: parts("manifest", value)[0]!, historyHead: head(value) })).toEqual({ historyLimit: true,
        historyHead: { ...head(value), history: { restoreRevision: 1, recordSequence: 4, eventSequence: 99, incompleteReason: "history_limit" } } });
    });
    expect((await heads()).rows).toMatchObject([{ restore_revision: "1", source: value.source, complete: false,
      manifest_sha256: null, incomplete_reason: "history_limit", record_sequence: "4", event_sequence: "99" }]);
  });
  it("commits known native outcome and original audit reference beside a quota-incomplete projection", async () => {
    const commandId = randomUUID(), result = CloudNativeResultSchema.parse({ version: 1, terminal: { commandId,
      conversationId: "chat", executionId: "execution", turnId: "turn", agentId: "cursor", status: "completed", stopReason: "end_turn" } });
    const value = manifest([]); value.source = { kind: "command", commandId, intent: { userMessageId: "turn", agentId: "cursor" },
      executionId: "execution", nativeResultSha256: digest(result) };
    await mirror(async tx => {
      await tx.query(`INSERT INTO cloud_workspace_local_command_controls(workspace_id,org_id,writer_epoch,conversation_id,revision,paused)
        VALUES($1,$2,$3,'chat',1,false)`, [workspace.workspaceId, workspace.organizationId, writerEpoch]);
      const actor = { scope: boot(), actor: { userId: workspace.userId, deviceId: randomUUID(), deviceKeyVersion: 1,
        fingerprint: "a".repeat(64), role: "owner" }, actorSessionId: randomUUID(), authorityEpoch: 1,
        confirmedUntilMs: 1, fundingConsentVersion: 1, fundingGrant: { kind: "owner" } };
      await tx.query(`INSERT INTO cloud_workspace_local_commands(workspace_id,org_id,id,conversation_id,writer_epoch,projection_epoch,
        user_message_id,agent_id,position,state,payload,generation,execution_id,result,actor_provenance,mirror_sequence,created_at,updated_at)
        VALUES($1,$2,$3,'chat',$4,$4,'turn','cursor',1,'dispatching','{}',1,'execution',$5,$6,1,now(),now())`,
      [workspace.workspaceId, workspace.organizationId, commandId, writerEpoch, JSON.stringify(result), JSON.stringify(actor)]);
      // Capacity-port injection exercises the exact checked1GiB boundary;
      // this is not a claim that the fixture writes1GiB of database content.
      const capacityPort = { query: (sql: string, values: unknown[]) => /sum\(octet_length\(data\)\)/.test(sql)
        ? Promise.resolve({ rows: [{ bytes: String(HISTORY_WORKSPACE_BYTES) }], rowCount: 1 }) : tx.query(sql, values) } as unknown as Tx;
      expect((await applyMirroredCloudAgentHistory(capacityPort, parent(), { conversationId: "chat",
        historyPart: parts("manifest", value)[0]!, historyHead: head(value) })).historyLimit).toBe(true);
      // entry.history is immutable local audit. Only the separate current
      // projection is remote-incomplete; the native outcome stays succeeded.
      await tx.query(`UPDATE cloud_workspace_local_commands SET state='succeeded',payload=NULL,history_restore_revision=1,
        history_record_sequence=4,history_event_sequence=99,history_manifest_sha256=$3 WHERE workspace_id=$1 AND id=$2`,
      [workspace.workspaceId, commandId, Buffer.from(digest(value), "hex")]);
    });
    expect((await pool.query("SELECT state,payload,result,history_manifest_sha256 FROM cloud_workspace_local_commands WHERE id=$1", [commandId])).rows)
      .toEqual([{ state: "succeeded", payload: null, result, history_manifest_sha256: Buffer.from(digest(value), "hex") }]);
    expect((await heads()).rows).toMatchObject([{ complete: false, manifest_sha256: null, incomplete_reason: "history_limit", source: value.source }]);
  });
  it("refuses unadmitted canonical control records rather than inventing settled permission state", async () => {
    const value = record({ entityKind: "control", entityId: "request", document: { version: 1, executionId: "execution", eventSequence: 9,
      frame: { id: "request", type: "AGENT_PERMISSION_SETTLED", source: "engine", timestamp: 1,
        agentId: "cursor", permissionId: "missing", sessionId: "execution" } } });
    const snapshot = manifest([value]); await stage("record", value); await stage("manifest", snapshot);
    await expect(publish(snapshot)).rejects.toMatchObject({ code: "cloud_history_conflict" });
    expect((await heads()).rowCount).toBe(0);
  });
  it("keeps raw canonical bytes and parts hidden from user RLS", async () => {
    await stage("record", record());
    for (const table of ["cloud_workspace_local_command_history_parts", "cloud_workspace_local_command_history_blobs"])
      expect((await withUserTx(pool, workspace.userId, tx => tx.query(`SELECT * FROM ${table}`))).rows).toEqual([]);
  });
  it("rolls back manifest/current head publication with the parent command transaction", async () => {
    const value = manifest([]); await stage("manifest", value);
    await expect(mirror(async tx => { await applyMirroredCloudAgentHistory(tx, parent(), { conversationId: "chat", historyHead: head(value) });
      throw new Error("Synthetic parent receipt failure"); })).rejects.toThrow("Synthetic parent receipt failure");
    expect((await heads()).rowCount).toBe(0);
  });
});
