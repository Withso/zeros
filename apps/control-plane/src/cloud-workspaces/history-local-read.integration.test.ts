import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudWorkspaceDurableRecordService } from "./durable-record.js";
import { CloudBootCommandSnapshotSchema, CloudBootCommandEntrySchema, CloudNativeResultSchema,
  CloudLocalCommandWriterSealSchema, CloudLocalCommandWriterSealAckSchema, DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { applyMirroredCloudAgentHistory, DatabaseCloudWorkspaceHistoryService } from "./history.js";
import { createCloudWorkspaceHistoryRoutes } from "./history-routes.js";
import { canonicalCloudHistoryJson, CloudStoppedHistoryMetadataSchema, HISTORY_PART_BYTES,
  type CloudLocalHistoryManifest, type CloudLocalHistoryRecord, type CloudMirroredHistoryHead } from "./history-local-contract.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("passive current-head cloud history", () => {
  let pool: pg.Pool, workspace: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let bootId: string, writerEpoch: string, bindingId: string;
  let history: DatabaseCloudWorkspaceHistoryService;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    workspace = await seedReadyCloudWorkspace(pool);
    history = new DatabaseCloudWorkspaceHistoryService(pool);
    await new DatabaseCloudWorkspaceDurableRecordService({ pool, workosEnabled: false }).append({
      ...scope(), generation: 1, engineInstanceId: workspace.engineInstanceId, heartbeatToken: workspace.heartbeatToken,
      expectedRevision: 0, idempotencyKey: randomUUID(), mutations: [
        { entityKind: "chat", entityId: "chat", schemaVersion: 1, operation: "upsert", occurredAt: new Date().toISOString(),
          document: { version: 1, chat: { id: "chat", folder: ".", title: "Old legacy title" } } },
        { entityKind: "message", entityId: `m:${createHash("sha256").update("chat\0old-message").digest("hex")}`,
          schemaVersion: 1, operation: "upsert", occurredAt: new Date().toISOString(), document: { version: 1, chatId: "chat",
            msgId: "old-message", ord: 1, kind: "text", createdAt: 1, payload: JSON.stringify({ role: "assistant", text: "Old legacy needle" }) } },
      ],
    });
    bootId = (await pool.query<{ id: string }>("SELECT runtime_boot_id AS id FROM cloud_workspace_engine_instances WHERE id=$1", [workspace.engineInstanceId])).rows[0]!.id;
    writerEpoch = randomUUID(); bindingId = randomUUID();
    // Real relational identity and canonical mirror helpers. This fixture
    // does not prove production native/cache activation or a FULL VM seal.
    await pool.query(`INSERT INTO cloud_workspace_local_command_writers(workspace_id,org_id,generation,engine_instance_id,
      boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch) VALUES($1,$2,1,$3,$4,$5,$6,1)`,
    [workspace.workspaceId, workspace.organizationId, workspace.engineInstanceId, bootId, writerEpoch, workspace.userId]);
    await pool.query(`INSERT INTO cloud_agent_boot_bindings(id,workspace_id,org_id,generation,engine_instance_id,
      boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,credentials_initialized)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,1,true)`,
    [bindingId, workspace.workspaceId, workspace.organizationId, workspace.engineInstanceId, bootId, writerEpoch, workspace.userId]);
    await pool.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now(),mirrored_sequence=20 WHERE writer_epoch=$1", [writerEpoch]);
    await pool.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1", [workspace.workspaceId, bindingId]);
  });
  const scope = () => ({ workspaceId: workspace.workspaceId, organizationId: workspace.organizationId, accountUserId: workspace.userId });
  const boot = () => ({ organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, generation: 1,
    engineInstanceId: workspace.engineInstanceId, bootId, writerEpoch, fundingOwnerUserId: workspace.userId, fundingOwnerEpoch: 1 });
  const parent = (outboxSequence = 2) => ({ organizationId: workspace.organizationId, workspaceId: workspace.workspaceId, writerEpoch, outboxSequence });
  const digest = (value: unknown) => createHash("sha256").update(canonicalCloudHistoryJson(value)).digest("hex");
  const mirror = <T,>(body: (tx: Tx) => Promise<T>) => withSystemTx(pool, async tx => {
    await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [workspace.workspaceId, workspace.organizationId]);
    await tx.query("SELECT writer_epoch FROM cloud_workspace_local_command_writers WHERE workspace_id=$1 AND writer_epoch=$2 FOR UPDATE", [workspace.workspaceId, writerEpoch]);
    return body(tx);
  });
  async function stage(kind: "record" | "manifest", document: unknown, conversationId = "chat") {
    const bytes = Buffer.from(canonicalCloudHistoryJson(document));
    for (let index = 0; index < Math.ceil(bytes.length / HISTORY_PART_BYTES); index++) {
      await mirror(tx => applyMirroredCloudAgentHistory(tx, parent(), { conversationId, historyPart: { version: 1, kind,
        sha256: digest(document), index, count: Math.ceil(bytes.length / HISTORY_PART_BYTES), bytes: bytes.length,
        data: bytes.subarray(index * HISTORY_PART_BYTES, (index + 1) * HISTORY_PART_BYTES).toString("base64") } }));
    }
  }
  const chat = (conversationId = "chat"): CloudLocalHistoryRecord => ({ version: 1, conversationId, entityKind: "chat",
    entityId: conversationId, schemaVersion: 1, sourceRevision: 4,
    document: { version: 1, chat: { id: conversationId, folder: ".", title: "Current canonical title" } } });
  const message = (ord: number, kind = "text", payload: unknown = { role: ord === 1 ? "user" : "assistant", text: `Canonical needle ${ord}` }, conversationId = "chat"):
  CloudLocalHistoryRecord => ({ version: 1, conversationId, entityKind: "message", entityId: `message-${ord}`, schemaVersion: 1,
    sourceRevision: 4, document: { version: 1, chatId: conversationId, msgId: `message-${ord}`, ord, kind, createdAt: ord, payload: JSON.stringify(payload) } });
  const manifest = (records: CloudLocalHistoryRecord[], restoreRevision = 1, conversationId = "chat"): CloudLocalHistoryManifest => ({
    version: 1, snapshot: "full", scope: boot(), conversationId, restoreRevision, deleted: false, tombstones: [],
    recordSequence: 4, eventSequence: 99, source: { kind: "mutation", mutationId: randomUUID(), operation: "repair" },
    records: records.map(value => ({ entityKind: value.entityKind, entityId: value.entityId, schemaVersion: 1, sourceRevision: value.sourceRevision, sha256: digest(value) })),
  });
  async function publish(records = [chat(), message(1), message(2)], restoreRevision = 1, conversationId = "chat") {
    const value = manifest(records, restoreRevision, conversationId);
    for (const record of records) await stage("record", record, conversationId);
    await stage("manifest", value, conversationId);
    await mirror(tx => applyMirroredCloudAgentHistory(tx, parent(restoreRevision + 2), { conversationId, historyHead: {
      originWriterEpoch: writerEpoch, source: value.source, deleted: false, history: { restoreRevision, recordSequence: 4,
        eventSequence: 99, manifestSha256: digest(value) } } }));
    return value;
  }
  async function incomplete(restoreRevision = 2, conversationId = "chat", deleted = false) {
    const head: CloudMirroredHistoryHead = { originWriterEpoch: writerEpoch,
      source: { kind: "mutation", mutationId: randomUUID(), operation: deleted ? "delete" : "edit" }, deleted,
      history: { restoreRevision, recordSequence: null, eventSequence: null, incompleteReason: "capture_conflict" } };
    await mirror(tx => applyMirroredCloudAgentHistory(tx, parent(restoreRevision + 2), { conversationId, historyHead: head }));
    return head;
  }
  async function sealWriter(recordSequence = 4, eventSequence = 99) {
    const descriptor = { version: 1, scope: boot(), sealId: randomUUID(), sequence: 20, recordSequence, eventSequence,
      // Opaque relational fixture inventory, not a verified FULL/native seal.
      inventorySha256: digest({ writerEpoch, recordSequence, eventSequence }) };
    const seal = CloudLocalCommandWriterSealSchema.parse({ ...descriptor, sha256: digest(descriptor) });
    await new DatabaseCloudWorkspaceCommandService({ pool }).seal({ organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId, generation: 1, engineInstanceId: workspace.engineInstanceId,
      heartbeatToken: workspace.heartbeatToken }, seal);
    return seal;
  }
  async function stop(sealOnStop = true) {
    if (sealOnStop) await sealWriter();
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [workspace.workspaceId]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [workspace.engineInstanceId]);
    await pool.query("UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=now() WHERE writer_epoch=$1", [writerEpoch]);
  }
  const metadata = (page: unknown) => CloudStoppedHistoryMetadataSchema.parse({
    projection: (page as { projection?: unknown }).projection, historyHeads: (page as { historyHeads?: unknown }).historyHeads,
  });
  const rowState = async () => (await pool.query(`SELECT workspace.status,workspace.desired_state,workspace.updated_at,
    engine.state AS engine_state,engine.last_heartbeat_at FROM cloud_workspaces workspace
    JOIN cloud_workspace_engine_instances engine ON engine.id=$2 WHERE workspace.id=$1`, [workspace.workspaceId, workspace.engineInstanceId])).rows;
  async function queueRows(foreignTerminal = false) {
    const queuedId = randomUUID(), receiptId = randomUUID();
    const payload = { agentId: "cursor", userMessageId: "queued-turn", prompt: [{ type: "text", text: "Queued test" }], modeRevision: 1, model: "test-model" };
    const result = CloudNativeResultSchema.parse({ version: 1, terminal: { commandId: foreignTerminal ? randomUUID() : receiptId, conversationId: "chat", executionId: "execution",
      turnId: "failed-turn", agentId: "cursor", status: "failed", stopReason: null, error: "Synthetic invalid credential",
      failure: { kind: "auth-required", stage: "prompt", message: "Synthetic invalid credential" } } });
    await pool.query(`INSERT INTO cloud_workspace_local_command_controls(workspace_id,org_id,writer_epoch,conversation_id,revision,paused)
      VALUES($1,$2,$3,'chat',3,false)`, [workspace.workspaceId, workspace.organizationId, writerEpoch]);
    await pool.query(`INSERT INTO cloud_workspace_local_commands(workspace_id,org_id,id,conversation_id,writer_epoch,projection_epoch,
      user_message_id,agent_id,position,state,payload,generation,mirror_sequence,created_at,updated_at)
      VALUES($1,$2,$3,'chat',$4,$4,'queued-turn','cursor',2,'queued',$5,1,18,now(),now())`,
    [workspace.workspaceId, workspace.organizationId, queuedId, writerEpoch, JSON.stringify(payload)]);
    await pool.query(`INSERT INTO cloud_workspace_local_commands(workspace_id,org_id,id,conversation_id,writer_epoch,projection_epoch,
      user_message_id,agent_id,position,state,payload,generation,execution_id,result_code,result,history_restore_revision,
      history_incomplete_reason,mirror_sequence,created_at,updated_at)
      VALUES($1,$2,$3,'chat',$4,$4,'failed-turn','cursor',1,'failed',NULL,1,'execution','cloud_provider_prompt_auth_required',$5,1,
        'capture_unavailable',17,now(),now())`, [workspace.workspaceId, workspace.organizationId, receiptId, writerEpoch, JSON.stringify(result)]);
    return { queuedId, receiptId, payload, result };
  }

  it("stores the exact immutable retired writer seal and matching ACK for stopped reads", async () => {
    await publish(); await stop();
    const writer = (await pool.query(`SELECT state,sealed_sequence,seal_record_sequence,seal_event_sequence,seal,seal_ack
      FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1`, [writerEpoch])).rows[0]!;
    const seal = CloudLocalCommandWriterSealSchema.parse(writer.seal), ack = CloudLocalCommandWriterSealAckSchema.parse(writer.seal_ack);
    const { sha256, ...descriptor } = seal, { scope: _scope, ...sealed } = seal;
    expect(seal).toMatchObject({ scope: boot(), sequence: 20, recordSequence: 4, eventSequence: 99 });
    expect(sha256).toBe(digest(descriptor));
    expect(ack).toEqual({ ...sealed, writerEpoch });
    expect(writer).toMatchObject({ state: "retired", sealed_sequence: "20", seal_record_sequence: "4", seal_event_sequence: "99" });
    await expect(pool.query("UPDATE cloud_workspace_local_command_writers SET seal_event_sequence=98 WHERE writer_epoch=$1", [writerEpoch]))
      .rejects.toMatchObject({ code: "23514" });
    expect((await pool.query(`SELECT state,sealed_sequence,seal_record_sequence,seal_event_sequence,seal,seal_ack
      FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1`, [writerEpoch])).rows[0]).toEqual(writer);
  });
  it("uses canonical current history and the mirrored stamp while stopped, without waking or rewriting state", async () => {
    const nativeTool = { kind: "tool_call", status: "completed", toolCallId: "read", rawOutput: { text: "Preserved tool result" } };
    const value = await publish([chat(), message(1), message(2, "tool_call", nativeTool)]); await stop();
    const before = await rowState(), chats = await history.chats({ ...scope(), limit: 100 });
    expect(chats).toMatchObject({ revision: 20, chats: [{ id: "chat", title: "Current canonical title" }], chatDeletions: [],
      projection: { ...boot(), mode: "boot-owner-v1", mirroredSequence: 20, sealedSequence: 20, complete: true },
      historyHeads: [{ conversationId: "chat", source: value.source, restoreRevision: 1, manifestSha256: digest(value), recordSequence: 4, eventSequence: 99 }] });
    metadata(chats);
    const messages = await history.messages({ ...scope(), chatId: "chat", limit: 1 });
    expect(messages.messages.map(row => row.msgId)).toEqual(["message-1", "message-2"]);
    expect(JSON.parse(messages.messages[1]!.payload)).toEqual(nativeTool); metadata(messages);
    expect(JSON.stringify(messages)).not.toContain("Old legacy needle");
    expect(await rowState()).toEqual(before);
  });
  it("returns a structured newer incomplete restore fence instead of old complete or legacy history", async () => {
    await publish(); const head = await incomplete(); await stop();
    const page = await history.messages({ ...scope(), chatId: "chat", limit: 100 });
    expect(page).toMatchObject({ messages: [], projection: { complete: false }, historyHeads: [{ conversationId: "chat",
      source: head.source, restoreRevision: 2, manifestSha256: null, recordSequence: null, eventSequence: null, incompleteReason: "capture_conflict" }] });
    expect(JSON.stringify(page)).not.toContain("Old legacy needle"); metadata(page);
  });
  it("keeps authoritative deletion heads on every relevant page after filtering deleted chat payload", async () => {
    await publish(); const head = await incomplete(2, "chat", true); await stop();
    const page = await history.chats({ ...scope(), limit: 100 });
    expect(page).toMatchObject({ chats: [], chatDeletions: ["chat"], historyHeads: [{ deleted: true, source: head.source, restoreRevision: 2 }] });
    expect(await history.messages({ ...scope(), chatId: "chat", limit: 100 })).toMatchObject({ messages: [], historyHeads: [{ deleted: true }] });
    expect(await history.search({ ...scope(), query: "needle", limit: 100 })).toMatchObject({ hits: [], historyHeads: [{ deleted: true }] });
  });
  it("keeps a missing current head unknown instead of manufacturing a complete empty conversation", async () => {
    await pool.query(`INSERT INTO cloud_workspace_local_command_controls(workspace_id,org_id,writer_epoch,conversation_id,revision,paused)
      VALUES($1,$2,$3,'chat',1,false)`, [workspace.workspaceId, workspace.organizationId, writerEpoch]); await stop();
    const page = await history.messages({ ...scope(), chatId: "chat", limit: 100 });
    expect(page).toMatchObject({ messages: [], projection: { complete: false }, historyHeads: [] }); metadata(page);
  });
  it("keeps heads unique and page-scoped and computes completeness for that page only", async () => {
    await publish([chat("a")], 1, "a"); await incomplete(1, "b"); await stop();
    const first = await history.chats({ ...scope(), limit: 1 });
    expect(first).toMatchObject({ chats: [{ id: "a" }], nextCursor: "a", historyHeads: [{ conversationId: "a" }], projection: { complete: true } });
    expect(metadata(first).historyHeads).toHaveLength(1);
    const next = await history.chats({ ...scope(), limit: 1, afterId: "a", revision: first.revision });
    expect(next).toMatchObject({ chats: [], nextCursor: null, historyHeads: [{ conversationId: "b" }], projection: { complete: false } });
    expect(metadata(next).historyHeads).toHaveLength(1);
  });
  it.each([
    { name: "unsealed", sealed: false, record: 4, event: 99, complete: false },
    { name: "short sparse event seal", sealed: true, record: 4, event: 98, complete: false },
    { name: "matching retired seal", sealed: true, record: 4, event: 99, complete: true },
  ])("requires an exact retired seal: $name", async ({ sealed, record, event, complete }) => {
    // Preserve the bounded stopped-read negative: a genuine earlier seal
    // undercovers this newer staged head. The direct helper insertion is a
    // read-defence fixture, not a permitted live mirror append after sealing.
    const shortSeal = sealed && event < 99;
    if (shortSeal) await sealWriter(record, event);
    await publish();
    expect(await history.chats({ ...scope(), limit: 100 })).toMatchObject({ projection: { complete: false, sealedSequence: shortSeal ? 20 : null } });
    await stop(sealed && !shortSeal);
    expect(await history.chats({ ...scope(), limit: 100 })).toMatchObject({ projection: { complete } });
    const proof = (await pool.query("SELECT seal,seal_ack FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1", [writerEpoch])).rows[0]!;
    if (sealed) {
      expect(CloudLocalCommandWriterSealSchema.parse(proof.seal)).toMatchObject({ recordSequence: record, eventSequence: event });
      expect(CloudLocalCommandWriterSealAckSchema.parse(proof.seal_ack)).toMatchObject({ recordSequence: record, eventSequence: event });
    } else expect(proof).toEqual({ seal: null, seal_ack: null });
  });
  it("allows a known empty complete snapshot and later repair without restoring a delayed older snapshot", async () => {
    const old = await publish([chat()]); await stop();
    expect(await history.messages({ ...scope(), chatId: "chat", limit: 100 })).toMatchObject({ messages: [], projection: { complete: true } });
    await incomplete(2); await publish([chat(), message(3)], 3);
    await mirror(tx => applyMirroredCloudAgentHistory(tx, parent(6), { conversationId: "chat", historyHead: {
      originWriterEpoch: writerEpoch, source: old.source, deleted: false, history: { restoreRevision: 1, recordSequence: 4, eventSequence: 99, manifestSha256: digest(old) } } }));
    expect(await history.messages({ ...scope(), chatId: "chat", limit: 100 })).toMatchObject({ messages: [{ msgId: "message-3" }], historyHeads: [{ restoreRevision: 3 }] });
  });
  it("returns canonical search windows with scope-bound cursors, not legacy hits", async () => {
    await publish([chat(), message(1), message(2), message(3)]); await stop();
    const first = await history.search({ ...scope(), query: "Canonical needle", chatId: "chat", limit: 1 });
    expect(first.hits).toHaveLength(1); expect(first.nextCursor).not.toBeNull(); metadata(first);
    const next = await history.search({ ...scope(), query: "Canonical needle", chatId: "chat", limit: 2, cursor: first.nextCursor!, revision: first.revision });
    expect(new Set([...first.hits, ...next.hits].map(row => row.msgId)).size).toBe(3);
    expect(JSON.stringify(next)).not.toContain("old-message");
    await expect(history.search({ ...scope(), query: "Different", chatId: "chat", limit: 2, cursor: first.nextCursor!, revision: first.revision })).rejects.toMatchObject({ status: 422 });
  });
  it("refuses a stale search cursor after an unsealed stopped projection advances", async () => {
    await publish([chat(), message(1), message(2), message(3)]); await stop(false);
    const first = await history.search({ ...scope(), query: "Canonical needle", chatId: "chat", limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    expect(metadata(first).projection).toMatchObject({ complete: false, sealedSequence: null });
    await pool.query("UPDATE cloud_workspace_local_command_writers SET mirrored_sequence=21 WHERE writer_epoch=$1", [writerEpoch]);
    await expect(history.search({ ...scope(), query: "Canonical needle", chatId: "chat", limit: 2, cursor: first.nextCursor!, revision: first.revision })).rejects.toMatchObject({ status: 409 });
  });
  it("rechecks the current actor, tenant and workspace on every stopped page", async () => {
    await publish(); await stop(); const other = await seedReadyCloudWorkspace(pool);
    for (const override of [{ accountUserId: other.userId }, { organizationId: other.organizationId }, { workspaceId: other.workspaceId }]) {
      await expect(history.chats({ ...scope(), ...override, limit: 100 })).rejects.toMatchObject({ status: 404 });
      await expect(history.messages({ ...scope(), ...override, chatId: "chat", limit: 100 })).rejects.toMatchObject({ status: 404 });
    }
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [workspace.organizationId, workspace.userId]);
    await expect(history.chats({ ...scope(), limit: 100 })).rejects.toMatchObject({ status: 404 });
  });
  it("retains missing-pointer database denial and refuses corrupt initialized local metadata without legacy fallback", async () => {
    await publish(); await stop();
    await expect(pool.query("UPDATE cloud_workspaces SET agent_boot_id=NULL WHERE id=$1", [workspace.workspaceId])).rejects.toMatchObject({ code: "23514" });
    const other = await seedReadyCloudWorkspace(pool), otherWriter = randomUUID(), otherBinding = randomUUID();
    const otherBoot = (await pool.query<{ id: string }>("SELECT runtime_boot_id AS id FROM cloud_workspace_engine_instances WHERE id=$1", [other.engineInstanceId])).rows[0]!.id;
    await pool.query(`INSERT INTO cloud_workspace_local_command_writers(workspace_id,org_id,generation,engine_instance_id,
      boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch) VALUES($1,$2,1,$3,$4,$5,$6,1)`,
    [other.workspaceId, other.organizationId, other.engineInstanceId, otherBoot, otherWriter, other.userId]);
    // The DB bounds this array, while the passive reader must also validate
    // its strict semantic three-provider shape. No constraint is disabled.
    await pool.query(`INSERT INTO cloud_agent_boot_bindings(id,workspace_id,org_id,generation,engine_instance_id,
      boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,credentials_initialized,initial_adoptions)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,1,true,$8)`, [otherBinding, other.workspaceId, other.organizationId, other.engineInstanceId,
      otherBoot, otherWriter, other.userId, JSON.stringify(Array.from({ length: 3 }, () => ({ provider: "cursor", status: "unknown" })))]);
    await pool.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now() WHERE writer_epoch=$1", [otherWriter]);
    await pool.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1", [other.workspaceId, otherBinding]);
    const corruptScope = { workspaceId: other.workspaceId, organizationId: other.organizationId, accountUserId: other.userId };
    await expect(history.chats({ ...corruptScope, limit: 100 })).rejects.toThrow();
    await expect(history.messages({ ...corruptScope, chatId: "chat", limit: 100 })).rejects.toThrow();
  });
  it("serves authenticated no-store stopped history and refuses caller-supplied authority fields", async () => {
    await publish(); await stop(); const app = new Hono(); let account = workspace.userId;
    app.use("*", async (c, next) => { c.set("user", { id: account } as AuthedUser); await next(); });
    app.route("/", createCloudWorkspaceHistoryRoutes(pool));
    app.onError((error, c) => { if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status); throw error; });
    const root = `/v1/organizations/${workspace.organizationId}/cloud-workspaces/${workspace.workspaceId}/history`;
    for (const suffix of ["/chats", "/messages/chat", "/search?query=needle"]) {
      const response = await app.request(root + suffix); expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store"); metadata(await response.json());
    }
    expect((await app.request(root + "/chats?writerEpoch=" + writerEpoch)).status).toBe(422);
    account = (await seedReadyCloudWorkspace(pool)).userId;
    expect((await app.request(root + "/messages/chat")).status).toBe(404);
  });
  it("reads the mirrored grant-free queue and exact native receipt without CP claiming or rewriting them", async () => {
    const rows = await queueRows(); await incomplete(1); await stop(false);
    const before = (await pool.query("SELECT * FROM cloud_workspace_local_commands ORDER BY position")).rows;
    const snapshot = await history.commands({ ...scope(), conversationId: "chat" });
    const parsed = CloudBootCommandSnapshotSchema.parse(snapshot.queue);
    expect(parsed).toMatchObject({ version: 1, conversationId: "chat", revision: 3, paused: false,
      pending: [{ commandId: rows.queuedId, payload: rows.payload }], receipts: [{ commandId: rows.receiptId, payload: null, result: rows.result }] });
    const receipt = await history.receipt({ ...scope(), commandId: rows.receiptId });
    expect(receipt.receipt.conversationId).toBe("chat");
    expect(CloudBootCommandEntrySchema.parse(receipt.receipt.entry)).toMatchObject({ commandId: rows.receiptId, state: "failed", payload: null,
      resultCode: "cloud_provider_prompt_auth_required", result: rows.result });
    expect(metadata(receipt).projection).toMatchObject({ complete: false, sealedSequence: null });
    expect((await pool.query("SELECT * FROM cloud_workspace_local_commands ORDER BY position")).rows).toEqual(before);
    await expect(history.receipt({ ...scope(), commandId: randomUUID() })).rejects.toMatchObject({ status: 404 });
  });
  it("exposes only the scoped authenticated no-store commands and command receipt routes", async () => {
    const rows = await queueRows(); await incomplete(1); await stop(false); const app = new Hono(); let account = workspace.userId;
    app.use("*", async (c, next) => { c.set("user", { id: account } as AuthedUser); await next(); });
    app.route("/", createCloudWorkspaceHistoryRoutes(pool));
    app.onError((error, c) => { if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status); throw error; });
    const root = `/v1/organizations/${workspace.organizationId}/cloud-workspaces/${workspace.workspaceId}/history`;
    for (const suffix of ["/commands?conversationId=chat", `/commands/${rows.receiptId}`]) {
      const response = await app.request(root + suffix); expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store"); metadata(await response.json());
    }
    expect((await app.request(root + "/commands?conversationId=chat&actorSessionId=" + randomUUID())).status).toBe(422);
    expect((await app.request(root + "/commands/not-a-uuid")).status).toBe(422);
    account = (await seedReadyCloudWorkspace(pool)).userId;
    expect((await app.request(root + `/commands/${rows.receiptId}`)).status).toBe(404);
  });
  it("refuses a receipt carrying another native command's terminal rather than relabeling it", async () => {
    const rows = await queueRows(true); await incomplete(1); await stop(false);
    await expect(history.receipt({ ...scope(), commandId: rows.receiptId })).rejects.toMatchObject({ code: "cloud_history_unavailable" });
    await expect(history.commands({ ...scope(), conversationId: "chat" })).rejects.toMatchObject({ code: "cloud_history_unavailable" });
  });
});
