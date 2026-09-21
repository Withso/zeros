import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { withSystemTx, withUserTx } from "../db.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";
import { DatabaseCloudWorkspaceCommandService, type CloudCommandEngineScope, type CloudCommandMutation } from "./commands.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("durable cloud commands", () => {
  let pool: pg.Pool, fixture: ReadyCloudWorkspaceFixture, service: DatabaseCloudWorkspaceCommandService, scope: CloudCommandEngineScope;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    scope = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1,
      engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken };
    service = new DatabaseCloudWorkspaceCommandService({ pool });
  });
  const payload = () => ({ agentId: "claude", userMessageId: randomUUID(), prompt: [{ type: "text", text: "fixture prompt" }], modeRevision: 0 });
  const enqueue = (expectedRevision = 0, conversationId = "conversation"): CloudCommandMutation => ({
    conversationId, operationId: randomUUID(), expectedRevision,
    action: { kind: "enqueue", commandId: randomUUID(), payload: payload() },
  });
  const action = (kind: "pause" | "resume", expectedRevision: number): CloudCommandMutation => ({
    conversationId: "conversation", operationId: randomUUID(), expectedRevision, action: { kind },
  });
  async function seedPreviousEngine() {
    const oldId = randomUUID(), grantId = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_endpoint_grants
        SELECT (jsonb_populate_record(NULL::cloud_workspace_endpoint_grants,
          to_jsonb(g) || jsonb_build_object('id',$2::text,'token_hash',$3::bytea))).*
        FROM cloud_workspace_endpoint_grants g
        WHERE id=(SELECT registration_grant_id FROM cloud_workspace_engine_instances WHERE id=$1)`,
      [scope.engineInstanceId, grantId, randomBytes(32)]);
      await tx.query(`INSERT INTO cloud_workspace_engine_instances
        SELECT (jsonb_populate_record(NULL::cloud_workspace_engine_instances, to_jsonb(e) ||
          jsonb_build_object('id',$2::text,'registration_grant_id',$3::text,'bridge_token_hash',$4::bytea,
            'heartbeat_token_hash',$5::bytea,'state','revoked','revoked_at',now()))).*
        FROM cloud_workspace_engine_instances e WHERE id=$1`,
      [scope.engineInstanceId, oldId, grantId, randomBytes(32), randomBytes(32)]);
    });
    return oldId;
  }

  it("persists admission before dispatch and resolves identical retries without duplicated work", async () => {
    const input = enqueue();
    const first = await service.mutate(scope, input);
    expect(first).toMatchObject({ revision: 1, replayed: false, pending: [{ state: "queued" }] });
    expect(await service.mutate(scope, input)).toMatchObject({ revision: 1, replayed: true });
    const claim = await service.claim(scope, "conversation", "execution");
    expect(claim?.payload).toEqual(input.action.kind === "enqueue" ? input.action.payload : null);
    expect(await service.claim(scope, "conversation", "execution")).toBeNull();
    const result = { commandId: claim!.commandId, claimId: claim!.claimId, state: "succeeded" as const, resultCode: null };
    expect(await service.settle(scope, result)).toMatchObject({ revision: 3, replayed: false, pending: [], receipts: [{ state: "succeeded", payload: null }] });
    expect(await service.settle(scope, result)).toMatchObject({ revision: 3, replayed: true });
    await expect(service.settle(scope, { ...result, state: "failed" })).rejects.toMatchObject({ code: "command_conflict" });
    expect(await service.mutate(scope, input)).toMatchObject({ replayed: true, pending: [] });
  });

  it("deletes owned command history when the workspace is physically purged", async () => {
    await service.mutate(scope, enqueue());
    const claim = (await service.claim(scope, "conversation", "execution"))!;
    await service.settle(scope, { commandId: claim.commandId, claimId: claim.claimId, state: "succeeded", resultCode: null });
    await withSystemTx(pool, tx => tx.query(`DELETE FROM cloud_workspaces WHERE id=$1`, [scope.workspaceId]));
    expect((await withSystemTx(pool, tx => tx.query(`SELECT * FROM cloud_workspace_commands WHERE workspace_id=$1`, [scope.workspaceId]))).rows).toEqual([]);
  });

  it("replays exactly one engine claim after a lost reply, including after Stop", async () => {
    await service.mutate(scope, enqueue());
    const claimId = randomUUID();
    const claim = await service.claim(scope, "conversation", "execution", claimId);
    expect(claim?.claimId).toBe(claimId);
    expect(await service.claim(scope, "conversation", "execution", claimId)).toEqual(claim);
    await service.stop(scope, "conversation", randomUUID());
    expect(await service.claim(scope, "conversation", "execution", claimId)).toEqual(claim);
    await expect(service.claim(scope, "other", "execution", claimId)).rejects.toMatchObject({ code: "command_conflict" });
    await expect(service.claim(scope, "conversation", "other", claimId)).rejects.toMatchObject({ code: "command_conflict" });
    const settled = await service.settle(scope, { commandId: claim!.commandId, claimId, state: "cancelled", resultCode: "stopped_before_dispatch" });
    await service.mutate(scope, enqueue(settled.revision));
    await service.mutate(scope, action("resume", settled.revision + 1));
    expect(await service.claim(scope, "conversation", "execution", claimId)).toBeNull();
    expect(await service.claim(scope, "conversation", "execution", randomUUID())).not.toBeNull();
  });

  it("rejects cross-device revision races and idempotency identity reuse", async () => {
    const input = enqueue();
    const outcomes = await Promise.allSettled([service.mutate(scope, input), service.mutate(scope, enqueue())]);
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(x => x.status === "rejected")).toHaveLength(1);
    const successful = outcomes[0]!.status === "fulfilled" ? input : null;
    if (successful) await expect(service.mutate(scope, { ...input, conversationId: "another" })).rejects.toMatchObject({ code: "command_conflict" });
    expect((await service.snapshot(scope, "conversation")).pending).toHaveLength(1);
  });

  it("does not execute a durable user message twice through different command identities", async () => {
    const input = enqueue(); await service.mutate(scope, input);
    const claim = (await service.claim(scope, "conversation", "execution"))!;
    await service.settle(scope, { commandId: claim.commandId, claimId: claim.claimId, state: "succeeded", resultCode: null });
    if (input.action.kind !== "enqueue") throw new Error("fixture");
    await expect(service.mutate(scope, { ...input, operationId: randomUUID(), expectedRevision: 3,
      action: { ...input.action, commandId: randomUUID() } })).rejects.toMatchObject({ code: "command_conflict" });
  });

  it("returns an old admission receipt after mode changes but refuses a new stale-context command", async () => {
    const input = enqueue(); await service.mutate(scope, input);
    expect(await service.mutate(scope, input, "command_context_changed")).toMatchObject({ replayed: true, revision: 1 });
    await expect(service.mutate(scope, enqueue(1), "command_context_changed")).rejects.toMatchObject({ code: "command_context_changed" });
    expect((await service.snapshot(scope, "conversation")).pending).toHaveLength(1);
  });

  it("keeps Stop paused through late completion, edits and new enqueues until explicit Resume", async () => {
    await service.mutate(scope, enqueue());
    const claim = (await service.claim(scope, "conversation", "execution"))!;
    const followup = enqueue(2);
    await service.mutate(scope, followup);
    await service.mutate(scope, action("pause", 3));
    const commandId = followup.action.kind === "enqueue" ? followup.action.commandId : "";
    const editedPayload = followup.action.kind === "enqueue" ? { ...followup.action.payload, prompt: [{ type: "text", text: "edited" }] } : payload();
    await service.mutate(scope, { conversationId: "conversation", operationId: randomUUID(), expectedRevision: 4,
      action: { kind: "edit", commandId, payload: editedPayload } });
    await service.settle(scope, { commandId: claim.commandId, claimId: claim.claimId, state: "cancelled", resultCode: "stopped_by_user" });
    await service.mutate(scope, enqueue(6));
    expect((await service.snapshot(scope, "conversation")).paused).toBe(true);
    expect(await service.claim(scope, "conversation", "execution")).toBeNull();
    await service.mutate(scope, action("resume", 7));
    expect((await service.claim(scope, "conversation", "execution"))?.commandId).toBe(commandId);
  });

  it("does not edit a dispatched command or settle it with another claim", async () => {
    await service.mutate(scope, enqueue());
    const claim = (await service.claim(scope, "conversation", "execution"))!;
    await expect(service.mutate(scope, { conversationId: "conversation", operationId: randomUUID(), expectedRevision: 2,
      action: { kind: "remove", commandId: claim.commandId } })).rejects.toMatchObject({ code: "command_conflict" });
    await expect(service.settle(scope, { commandId: claim.commandId, claimId: randomUUID(), state: "succeeded", resultCode: null })).rejects.toMatchObject({ code: "command_conflict" });
  });

  it("persists an idempotent Stop even when another device changes the revision", async () => {
    const input = enqueue(); await service.mutate(scope, input);
    const operationId = randomUUID();
    const stopped = await service.stop(scope, "conversation", operationId);
    expect(stopped).toMatchObject({ paused: true, revision: 2, replayed: false });
    await service.mutate(scope, enqueue(2));
    expect(await service.stop(scope, "conversation", operationId)).toMatchObject({ paused: true, revision: 3, replayed: true });
    await expect(service.stop(scope, "other", operationId)).rejects.toMatchObject({ code: "command_conflict" });
    expect(await service.claim(scope, "conversation", "execution")).toBeNull();
  });

  it("keeps independent conversations isolated and refuses stale or cross-tenant engine authority", async () => {
    await service.mutate(scope, enqueue(0, "first"));
    await service.mutate(scope, enqueue(0, "second"));
    expect((await service.claim(scope, "first", "execution-a"))?.conversationId).toBe("first");
    expect((await service.claim(scope, "second", "execution-b"))?.conversationId).toBe("second");
    for (const wrong of [{ organizationId: randomUUID() }, { generation: 2 }, { heartbeatToken: "zwh_" + "x".repeat(43) }]) {
      await expect(service.snapshot({ ...scope, ...wrong }, "first")).rejects.toThrow("authority");
    }
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now()-interval '2 seconds',lease_expires_at=now()-interval '1 second' WHERE id=$1`, [scope.engineInstanceId]));
    await expect(service.claim(scope, "first", "execution-c")).rejects.toThrow("authority");
  });

  it("recovers unknown dispatch outcomes as uncertain without replaying them", async () => {
    await service.mutate(scope, enqueue());
    const claim = (await service.claim(scope, "conversation", "execution"))!;
    await service.mutate(scope, enqueue(2));
    // Seed a prior engine into the dispatched row while keeping a current,
    // qualified engine authority. This models replacement at the same generation.
    const oldId = await seedPreviousEngine();
    await withSystemTx(pool, async tx => {
      await tx.query(`UPDATE cloud_workspace_commands SET engine_instance_id=$2 WHERE workspace_id=$1 AND id=$3`, [scope.workspaceId, oldId, claim.commandId]);
    });
    const snapshot = await service.snapshot(scope, "conversation");
    expect(snapshot).toMatchObject({ paused: true, pending: [{ state: "queued" }], receipts: [{ state: "uncertain", resultCode: "engine_interrupted" }] });
    expect(await service.claim(scope, "conversation", "replacement-execution")).toBeNull();
    expect(snapshot.receipts[0]?.payload).toBeNull();
    expect((await service.read(scope, claim.commandId)).payload).toEqual(claim.payload);
    await service.mutate(scope, action("resume", snapshot.revision));
    expect((await service.claim(scope, "conversation", "replacement-execution"))?.commandId).not.toBe(claim.commandId);
  });

  it("pauses undispatched work when the engine is replaced within the same generation", async () => {
    await service.mutate(scope, enqueue());
    const oldId = await seedPreviousEngine();
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_commands SET engine_instance_id=$2 WHERE workspace_id=$1`, [scope.workspaceId, oldId]));
    const snapshot = await service.snapshot(scope, "conversation");
    expect(snapshot).toMatchObject({ paused: true, pending: [{ state: "queued" }] });
    expect(await service.claim(scope, "conversation", "replacement")).toBeNull();
    await service.mutate(scope, action("resume", snapshot.revision));
    expect(await service.claim(scope, "conversation", "replacement")).not.toBeNull();
  });

  it("bounds queue payloads and never accepts credential or execution overrides", async () => {
    const input = enqueue();
    if (input.action.kind !== "enqueue") throw new Error("fixture");
    for (const extra of [{ env: { API_KEY: "not-a-real-key" } }, { cwd: "/private" }, { executionId: "forged" }]) {
      await expect(service.mutate(scope, { ...input, action: { ...input.action, payload: { ...input.action.payload, ...extra } } })).rejects.toMatchObject({ code: "invalid_command" });
    }
    await expect(service.mutate(scope, { ...input, action: { ...input.action, payload: { ...input.action.payload, prompt: [{ type: "text", text: "x".repeat(200000) }] } } })).rejects.toMatchObject({ code: "command_limit" });
    for (let n = 0; n < 32; n++) await service.mutate(scope, enqueue(n));
    await expect(service.mutate(scope, enqueue(32))).rejects.toMatchObject({ code: "command_limit" });
    // Stop remains available at capacity.
    expect(await service.mutate(scope, action("pause", 32))).toMatchObject({ paused: true });
  });

  it("does not expose prompts through organization-wide SQL readers", async () => {
    await service.mutate(scope, enqueue());
    const result = await withUserTx(pool, fixture.userId, tx => tx.query("SELECT * FROM cloud_workspace_commands"));
    expect(result.rows).toEqual([]);
  });
});
