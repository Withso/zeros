import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx, withUserTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { seedRecordedCloudWorkspaceActor } from "./recorded-actor-test-fixture.js";
import { activateLocalCloudCommandWriter, reserveLocalCloudCommandWriter, type CloudCommandEngineScope } from "./commands.js";
import { applyCompactCloudAgentEvent } from "./event-streams.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("durable compact cloud controls retain original run identity", () => {
  let pool: pg.Pool, engine: CloudCommandEngineScope, ownerId: string, bootId: string, writerEpoch: string, commandId: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    const workspace = await seedReadyCloudWorkspace(pool); ownerId = workspace.userId;
    engine = await seedRecordedCloudWorkspaceActor(pool, workspace); commandId = randomUUID();
    bootId = (await pool.query<{ runtime_boot_id: string }>("SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [engine.engineInstanceId])).rows[0]!.runtime_boot_id;
    writerEpoch = await withSystemTx(pool, tx => reserveLocalCloudCommandWriter(tx, engine, bootId, ownerId, 1));
    await withSystemTx(pool, async tx => {
      await activateLocalCloudCommandWriter(tx, engine, { bootId, writerEpoch });
      await tx.query(`INSERT INTO cloud_workspace_local_command_controls(workspace_id,org_id,writer_epoch,conversation_id,revision,paused)
        VALUES($1,$2,$3,'chat',1,false)`, [engine.workspaceId, engine.organizationId, writerEpoch]);
      const actor = { scope: { organizationId: engine.organizationId, workspaceId: engine.workspaceId, generation: engine.generation,
        engineInstanceId: engine.engineInstanceId, bootId, writerEpoch, fundingOwnerUserId: ownerId, fundingOwnerEpoch: 1 },
        actor: { userId: ownerId, deviceId: randomUUID(), deviceKeyVersion: 1, fingerprint: "a".repeat(64), role: "owner" },
        actorSessionId: randomUUID(), authorityEpoch: 1, confirmedUntilMs: 1, fundingConsentVersion: 1, fundingGrant: { kind: "owner" } };
      await tx.query(`INSERT INTO cloud_workspace_local_commands(workspace_id,org_id,id,conversation_id,writer_epoch,projection_epoch,
        user_message_id,agent_id,position,state,payload,actor_provenance,generation,execution_id,mirror_sequence,created_at,updated_at)
        VALUES($1,$2,$3,'chat',$4,$4,'turn','cursor',1,'dispatching',$5::jsonb,$6::jsonb,$7,'execution',1,now(),now())`,
      [engine.workspaceId, engine.organizationId, commandId, writerEpoch, JSON.stringify({ agentId: "cursor", userMessageId: "turn",
        modeRevision: 0, prompt: [{ type: "text", text: "Synthetic compact control" }] }), JSON.stringify(actor), engine.generation]);
    });
  });
  const parent = (outboxSequence = 2) => ({ organizationId: engine.organizationId, workspaceId: engine.workspaceId,
    writerEpoch, outboxSequence, conversationId: "chat", commandId });
  const request = (eventSequence = 9) => ({ version: 1, eventSequence, executionId: "execution", frame: {
    id: "frame", type: "AGENT_PERMISSION_REQUEST", source: "engine", timestamp: 1, agentId: "cursor",
    cloudStream: { streamId: engine.engineInstanceId, sequence: eventSequence }, permissionId: "permission",
    request: { sessionId: "execution", toolCall: { toolCallId: "tool", title: "Read", rawInput: { path: "file" } },
      options: [{ optionId: "project", name: "Allow for this project", kind: "allow_always_project" }] },
  } });
  const rows = () => withSystemTx(pool, tx => tx.query("SELECT * FROM cloud_workspace_local_agent_controls WHERE workspace_id=$1", [engine.workspaceId]));

  it("writes one exact native request, preserves VM cursor and leaves legacy streams untouched", async () => {
    expect(await withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, parent(), request()))).toEqual({ replayed: false });
    expect((await rows()).rows).toMatchObject([{ command_id: commandId, local_stream_id: engine.engineInstanceId,
      local_sequence: "9", outbox_sequence: "2", execution_id: "execution", user_message_id: "turn", frame: request().frame }]);
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_stream_events")).rows[0]?.count).toBe("0");
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_event_streams")).rows[0]?.count).toBe("0");
  });
  it("reconciles exact replay and refuses changed bytes without adding a second row", async () => {
    await withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, parent(), request()));
    expect(await withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, parent(), request()))).toEqual({ replayed: true });
    const changed = request(); changed.frame.timestamp = 2;
    await expect(withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, parent(), changed))).rejects.toMatchObject({ code: "event_conflict" });
    expect((await rows()).rowCount).toBe(1);
  });
  it("settles only the earlier request on the same original command and resolver", async () => {
    await withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, parent(), request()));
    const settled = { version: 1, eventSequence: 10, executionId: "execution", frame: {
      id: "settled", type: "AGENT_PERMISSION_SETTLED", source: "engine", timestamp: 2, agentId: "cursor",
      cloudStream: { streamId: engine.engineInstanceId, sequence: 10 }, permissionId: "permission", sessionId: "execution" } };
    await withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, parent(3), settled));
    expect((await rows()).rowCount).toBe(2);
    await expect(withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, { ...parent(4), commandId: randomUUID() }, settled)))
      .rejects.toMatchObject({ code: "event_conflict" });
  });
  it("refuses missing request and cross-tenant, conversation, execution or origin stream", async () => {
    await expect(withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, parent(), { version: 1, eventSequence: 10,
      executionId: "execution", frame: { id: "settled", type: "AGENT_PERMISSION_SETTLED", source: "engine",
        timestamp: 2, agentId: "cursor", permissionId: "permission", sessionId: "execution" } }))).rejects.toMatchObject({ code: "event_conflict" });
    for (const supplied of [{ ...parent(), organizationId: randomUUID() }, { ...parent(), conversationId: "other" }])
      await expect(withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, supplied, request()))).rejects.toMatchObject({ code: "event_conflict" });
    await expect(withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, parent(), { ...request(), executionId: "other" })))
      .rejects.toMatchObject({ code: "event_conflict" });
    const foreign = request(); foreign.frame.cloudStream.streamId = randomUUID();
    await expect(withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, parent(), foreign))).rejects.toMatchObject({ code: "event_conflict" });
    expect((await rows()).rowCount).toBe(0);
  });
  it("requires stored actor provenance even if terminal projection has no provider payload", async () => {
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_local_commands SET actor_provenance=NULL WHERE workspace_id=$1 AND id=$2", [engine.workspaceId, commandId]));
    await expect(withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, parent(), request()))).rejects.toMatchObject({ code: "event_conflict" });
    expect((await rows()).rowCount).toBe(0);
  });
  it("keeps raw tool control content system-only under direct user RLS", async () => {
    await withSystemTx(pool, tx => applyCompactCloudAgentEvent(tx, parent(), request()));
    expect((await withUserTx(pool, ownerId, tx => tx.query("SELECT * FROM cloud_workspace_local_agent_controls"))).rows).toEqual([]);
  });
});
