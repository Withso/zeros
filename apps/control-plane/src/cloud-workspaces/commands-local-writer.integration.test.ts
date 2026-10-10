import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withSystemTx, withUserTx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { seedRecordedCloudWorkspaceActor } from "./recorded-actor-test-fixture.js";
import { DatabaseCloudWorkspaceCommandService, reserveLocalCloudCommandWriter, activateLocalCloudCommandWriter,
  type CloudCommandEngineScope } from "./commands.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("one negotiated local cloud command writer", () => {
  let pool: pg.Pool, scope: CloudCommandEngineScope, ownerUserId: string, bootId: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool); const workspace = await seedReadyCloudWorkspace(pool);
    scope = await seedRecordedCloudWorkspaceActor(pool, workspace); ownerUserId = workspace.userId;
    const witness = await withSystemTx(pool, tx => tx.query<{ runtime_boot_id: string }>(
      "SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [scope.engineInstanceId]));
    bootId = witness.rows[0]!.runtime_boot_id;
  });
  const reserve = () => withSystemTx(pool, tx => reserveLocalCloudCommandWriter(tx, scope, bootId, ownerUserId, 1));
  const activate = (writerEpoch: string) => withSystemTx(pool, tx => activateLocalCloudCommandWriter(tx, scope, { bootId, writerEpoch }));

  it("reserves an immutable epoch without activating and reconciles the identical boot retry", async () => {
    const writerEpoch = await reserve(); expect(await reserve()).toBe(writerEpoch);
    const row = await withSystemTx(pool, tx => tx.query("SELECT * FROM cloud_workspace_local_command_writers WHERE workspace_id=$1", [scope.workspaceId]));
    expect(row.rows).toMatchObject([{ state: "reserved", writer_epoch: writerEpoch, boot_id: bootId,
      funding_owner_user_id: ownerUserId, funding_owner_epoch: "1", funding_scope: "workspace-roles-v1", mirrored_sequence: "0" }]);
    await expect(withSystemTx(pool, tx => reserveLocalCloudCommandWriter(tx, scope, randomUUID(), ownerUserId, 1)))
      .rejects.toMatchObject({ code: "command_conflict" });
    await expect(withSystemTx(pool, tx => reserveLocalCloudCommandWriter(tx, scope, bootId, ownerUserId, 2)))
      .rejects.toMatchObject({ code: "command_conflict" });
  });
  it("durably retains immutable exact mirror feedback for a lost response retry", async () => {
    const epoch = await reserve(), batchId = randomUUID();
    const ack = { version: 1, writerEpoch: epoch, batchId, through: 1,
      historyLimits: [{ conversationId: "chat", sha256: "a".repeat(64) }] };
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_local_command_mirror_batches
      (workspace_id,org_id,writer_epoch,batch_id,request_sha256,after_sequence,through_sequence,ack)
      VALUES($1,$2,$3,$4,$5,0,1,$6::jsonb)`, [scope.workspaceId, scope.organizationId, epoch, batchId, Buffer.alloc(32), JSON.stringify(ack)]));
    const saved = await withSystemTx(pool, tx => tx.query("SELECT ack FROM cloud_workspace_local_command_mirror_batches WHERE batch_id=$1", [batchId]));
    expect(saved.rows[0]!.ack).toEqual(ack);
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_local_command_mirror_batches SET ack=$2::jsonb WHERE batch_id=$1",
      [batchId, JSON.stringify({ ...ack, historyLimits: [] })]))).rejects.toMatchObject({ code: "23514" });
  });
  it("refuses null or conflicting raw mirror acknowledgement identity", async () => {
    const epoch = await reserve();
    for (const change of [{ version: null }, { writerEpoch: null }, { batchId: null }, { through: null }, { through: 2 }]) {
      const batchId = randomUUID(), ack = { version: 1, writerEpoch: epoch, batchId, through: 1, ...change };
      await expect(withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_local_command_mirror_batches
        (workspace_id,org_id,writer_epoch,batch_id,request_sha256,after_sequence,through_sequence,ack)
        VALUES($1,$2,$3,$4,$5,0,1,$6::jsonb)`, [scope.workspaceId, scope.organizationId, epoch, batchId, Buffer.alloc(32), JSON.stringify(ack)])))
        .rejects.toMatchObject({ code: "23514" });
    }
  });

  it("does not activate a ledger with legacy queued or dispatched work", async () => {
    const legacy = new DatabaseCloudWorkspaceCommandService({ pool });
    await legacy.mutate(scope, { conversationId: "chat", operationId: randomUUID(), expectedRevision: 0,
      action: { kind: "enqueue", commandId: randomUUID(), payload: { agentId: "claude", userMessageId: randomUUID(),
        modeRevision: 0, prompt: [{ type: "text", text: "synthetic cutover" }] } } });
    const epoch = await reserve(); await expect(activate(epoch)).rejects.toMatchObject({ code: "command_conflict" });
    const claim = (await legacy.claim(scope, "chat", "legacy-native"))!;
    await expect(activate(epoch)).rejects.toMatchObject({ code: "command_conflict" });
    await legacy.settle(scope, { commandId: claim.commandId, claimId: claim.claimId, state: "cancelled", resultCode: "stopped_by_user" });
    await activate(epoch); await activate(epoch);
    const row = await withSystemTx(pool, tx => tx.query("SELECT state FROM cloud_workspace_local_command_writers WHERE workspace_id=$1", [scope.workspaceId]));
    expect(row.rows).toEqual([{ state: "active" }]);
  });

  it("fences every legacy mutable dispatcher after activation while keeping old authorized receipts readable", async () => {
    const legacy = new DatabaseCloudWorkspaceCommandService({ pool }); const epoch = await reserve(); await activate(epoch);
    const mutate = { conversationId: "chat", operationId: randomUUID(), expectedRevision: 0,
      action: { kind: "enqueue" as const, commandId: randomUUID(), payload: { agentId: "claude", userMessageId: randomUUID(),
        modeRevision: 0, prompt: [{ type: "text" as const, text: "synthetic refusal" }] } } };
    await expect(legacy.mutate(scope, mutate)).rejects.toMatchObject({ code: "command_conflict" });
    await expect(legacy.claim(scope, "chat", "stale-cp-dispatcher")).rejects.toMatchObject({ code: "command_conflict" });
    await expect(legacy.stop(scope, "chat", randomUUID())).rejects.toMatchObject({ code: "command_conflict" });
    expect(await legacy.snapshot(scope, "chat")).toMatchObject({ pending: [], receipts: [] });
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_commands WHERE workspace_id=$1", [scope.workspaceId])).rows[0]?.count).toBe("0");
  });

  it("refuses foreign/missing funding owner and foreign engine authority without creator fallback", async () => {
    await expect(withSystemTx(pool, tx => reserveLocalCloudCommandWriter(tx, { ...scope, engineInstanceId: randomUUID() }, bootId, ownerUserId, 1))).rejects.toThrow();
    await expect(withSystemTx(pool, tx => reserveLocalCloudCommandWriter(tx, scope, bootId, randomUUID(), 1)))
      .rejects.toMatchObject({ code: "command_conflict" });
    // The authoritative workspace schema itself refuses a missing owner;
    // never manufacture an invalid row by bypassing its membership trigger.
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspaces SET owner_user_id=NULL WHERE id=$1", [scope.workspaceId])))
      .rejects.toMatchObject({ code: "23503" });
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_local_command_writers")).rows[0]?.count).toBe("0");
  });

  it("preserves an active writer's exact boot/epoch and never manufactures a seal", async () => {
    const epoch = await reserve(); await activate(epoch);
    // The writer seal, native scope retirement and new engine admission are
    // separate proofs. Even a direct attempted identity rewrite is rejected.
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_local_command_writers SET boot_id=$2 WHERE workspace_id=$1", [scope.workspaceId, randomUUID()])))
      .rejects.toMatchObject({ code: "23514" });
    await expect(activate(randomUUID())).rejects.toMatchObject({ code: "command_conflict" });
    const states = await withSystemTx(pool, tx => tx.query("SELECT state,sealed_sequence FROM cloud_workspace_local_command_writers WHERE workspace_id=$1", [scope.workspaceId]));
    expect(states.rows).toEqual([{ state: "active", sealed_sequence: null }]);
  });

  it("denies user-table reads and cross-tenant projection parts while system authority is scoped explicitly", async () => {
    await reserve();
    const hidden = await withUserTx(pool, ownerUserId, tx => tx.query("SELECT * FROM cloud_workspace_local_command_writers"));
    expect(hidden.rowCount).toBe(0);
    const scoped = await withSystemTx(pool, tx => tx.query("SELECT count(*) FROM cloud_workspace_local_command_writers WHERE workspace_id=$1 AND org_id=$2", [scope.workspaceId, randomUUID()]));
    expect(scoped.rows[0]?.count).toBe("0");
  });

  it("retains the exact incomplete mutation source and rejects a changed operation at the same restore revision", async () => {
    const epoch = await reserve(), mutationId = randomUUID();
    const source = { kind: "mutation", mutationId, operation: "delete" };
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_local_command_history_heads
      (workspace_id,org_id,projection_epoch,origin_writer_epoch,conversation_id,restore_revision,
       complete,deleted,incomplete_reason,source_kind,source_id,source,outbox_sequence)
      VALUES($1,$2,$3,$3,'chat',2,false,true,'capture_unavailable','mutation',$4,$5::jsonb,1)`,
    [scope.workspaceId, scope.organizationId, epoch, mutationId, JSON.stringify(source)]));
    const read = () => withSystemTx(pool, tx => tx.query(`SELECT source,restore_revision,deleted
      FROM cloud_workspace_local_command_history_heads WHERE workspace_id=$1 AND projection_epoch=$2`, [scope.workspaceId, epoch]));
    expect((await read()).rows).toEqual([{ source, restore_revision: "2", deleted: true }]);
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_local_command_history_heads
      SET source=$3::jsonb WHERE workspace_id=$1 AND projection_epoch=$2`,
    [scope.workspaceId, epoch, JSON.stringify({ ...source, operation: "repair" })])))
      .rejects.toMatchObject({ code: "23514" });
    expect((await read()).rows[0]?.source).toEqual(source);
    await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_local_command_history_heads
      SET source=$3::jsonb,restore_revision=3,outbox_sequence=2 WHERE workspace_id=$1 AND projection_epoch=$2`,
    [scope.workspaceId, epoch, JSON.stringify({ ...source, mutationId: randomUUID() })])))
      .rejects.toMatchObject({ code: "23514" });
  });

  it.each(["kind", "mutationId", "operation", "commandId"])("refuses raw JSON null %s rather than SQL CHECK unknown", async field => {
    const epoch = await reserve(), sourceId = randomUUID(), kind = field === "commandId" ? "command" : "mutation";
    const source = kind === "command" ? { kind, commandId: sourceId, intent: { agentId: "codex", userMessageId: "turn" },
      executionId: null, nativeResultSha256: null } : { kind, mutationId: sourceId, operation: "delete" };
    await expect(withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_local_command_history_heads
      (workspace_id,org_id,projection_epoch,origin_writer_epoch,conversation_id,restore_revision,
       complete,deleted,incomplete_reason,source_kind,source_id,source,outbox_sequence)
      VALUES($1,$2,$3,$3,'chat',2,false,true,'capture_unavailable',$4,$5,$6::jsonb,1)`,
    [scope.workspaceId, scope.organizationId, epoch, kind, sourceId, JSON.stringify({ ...source, [field]: null })])))
      .rejects.toMatchObject({ code: "23514" });
  });
});
