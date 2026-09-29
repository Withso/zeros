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

  it("persists a fork identity and lineage across retries and rejects foreign authority",async()=>{
    const input=enqueue(0,"destination");
    input.action={kind:"fork",commandId:randomUUID(),payload:{...payload(),model:"claude-sonnet-4-6",agentCredentialGrantId:randomUUID(),
      operation:{version:1,kind:"fork",sourceConversationId:"source",strategy:"transcript"}}};
    await service.mutate(scope,input);
    expect(await service.mutate(scope,input)).toMatchObject({replayed:true,pending:[{payload:{operation:{sourceConversationId:"source"}}}]});
    await expect(service.mutate({...scope,workspaceId:randomUUID()},input)).rejects.toThrow();
    await expect(service.mutate(scope,{...input,operationId:randomUUID(),expectedRevision:1},"command_not_found")).rejects.toThrow();
    const claim=(await service.claim(scope,"destination","fork-execution"))!;
    await service.settle(scope,{commandId:claim.commandId,claimId:claim.claimId,state:"succeeded",resultCode:null});
    expect(await service.mutate(scope,input)).toMatchObject({replayed:true,pending:[],receipts:[{state:"succeeded"}]});
  });

  it("admits goal reads after Stop without resuming prompts and retains the confirmed goal receipt",async()=>{
    await service.mutate(scope,enqueue());
    await service.stop(scope,"conversation",randomUUID());
    const input=enqueue(2);
    input.action={kind:"enqueue",commandId:randomUUID(),payload:{...payload(),agentId:"codex",model:"gpt-5.4",agentCredentialGrantId:randomUUID(),
      operation:{version:1,kind:"goal",action:"get"}}};
    await service.mutate(scope,input);
    expect(await service.claim(scope,"conversation","legacy-worker",undefined,false)).toBeNull();
    const claim=await service.claim(scope,"conversation","goal-execution");
    expect(claim?.commandId).toBe(input.action.commandId);
    const goal={objective:"Persist this goal",status:"paused" as const,tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:1};
    await service.settle(scope,{commandId:claim!.commandId,claimId:claim!.claimId,state:"succeeded",resultCode:null,result:{version:1,goal}});
    const reloaded=new DatabaseCloudWorkspaceCommandService({pool});
    expect(await reloaded.snapshot(scope,"conversation")).toMatchObject({paused:true,receipts:[{result:{version:1,goal}}]});
    expect(await reloaded.claim(scope,"conversation","prompt-execution")).toBeNull();
  });

  it("retains confirmed live goals through Stop, reload and receipt-window eviction",async()=>{
    const input=enqueue();if(input.action.kind!=="enqueue")throw new Error("fixture");input.action.payload.agentId="codex";
    await service.mutate(scope,input);const claim=(await service.claim(scope,"conversation","goal-live"))!;
    const goal={objective:"Confirmed",status:"active" as const,tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:1};
    const confirmation={kind:"confirm-goal" as const,commandId:claim.commandId,claimId:claim.claimId,sequence:1,goal};
    const first=await service.confirmGoal(scope,confirmation);
    expect(await service.confirmGoal(scope,confirmation)).toEqual(first);
    const cleared=await service.confirmGoal(scope,{...confirmation,sequence:2,goal:null});
    expect(cleared.revision).toBeGreaterThan(first.revision);
    expect(await service.confirmGoal(scope,confirmation)).toEqual(cleared);
    await expect(service.confirmGoal({...scope,generation:2},confirmation)).rejects.toThrow();
    await expect(service.confirmGoal(scope,{...confirmation,claimId:randomUUID()})).rejects.toThrow();
    await expect(service.confirmGoal(scope,{...confirmation,sequence:2})).rejects.toMatchObject({code:"command_conflict"});
    const reload=new DatabaseCloudWorkspaceCommandService({pool});
    expect(await reload.snapshot(scope,"conversation")).toMatchObject({nativeGoal:cleared,pending:[{state:"dispatching"}]});
    await service.stop(scope,"conversation",randomUUID());
    const terminal={commandId:claim.commandId,claimId:claim.claimId,state:"cancelled" as const,resultCode:"stopped_by_user",result:{version:1 as const,goal}};
    await service.settle(scope,terminal);await service.settle(scope,terminal);
    await withSystemTx(pool,tx=>tx.query(`INSERT INTO cloud_workspace_commands
      (workspace_id,org_id,id,conversation_id,position,state,payload,generation,engine_instance_id,user_message_id,updated_at)
      SELECT $1,$2,gen_random_uuid(),'conversation',n,'failed',NULL,$3,$4,'later-'||n,now()+interval '1 second'
      FROM generate_series(2,52) AS n`,[scope.workspaceId,scope.organizationId,scope.generation,scope.engineInstanceId]));
    const snapshot=await reload.snapshot(scope,"conversation");
    expect(snapshot.receipts).toHaveLength(50);expect(snapshot.receipts.some(row=>row.commandId===claim.commandId)).toBe(false);
    expect(snapshot.nativeGoal).toEqual(cleared);
  });

  it("orders goal confirmations by execution revision when a utility overtakes a paused prompt",async()=>{
    const prompt=enqueue();if(prompt.action.kind!=="enqueue")throw new Error("fixture");prompt.action.payload.agentId="codex";
    await service.mutate(scope,prompt);await service.stop(scope,"conversation",randomUUID());
    const utility=enqueue(2);utility.action={kind:"enqueue",commandId:randomUUID(),payload:{...payload(),agentId:"codex",model:"gpt-5.4",agentCredentialGrantId:randomUUID(),operation:{version:1,kind:"goal",action:"get"}}};
    await service.mutate(scope,utility);
    const first=(await service.claim(scope,"conversation","utility"))!;
    const goal={objective:"Finish",status:"active" as const,tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:1};
    await service.confirmGoal(scope,{kind:"confirm-goal",commandId:first.commandId,claimId:first.claimId,sequence:1,goal});
    const settled=await service.settle(scope,{commandId:first.commandId,claimId:first.claimId,state:"succeeded",resultCode:null});
    await service.mutate(scope,action("resume",settled.revision));
    const later=(await service.claim(scope,"conversation","prompt"))!;expect(later.commandId).toBe(prompt.action.commandId);
    const completed={...goal,status:"complete" as const,tokensUsed:50,updatedAt:3};
    const confirmed=await service.confirmGoal(scope,{kind:"confirm-goal",commandId:later.commandId,claimId:later.claimId,sequence:1,goal:completed});
    await service.settle(scope,{commandId:later.commandId,claimId:later.claimId,state:"failed",resultCode:"agent_prompt_failed"});
    expect((await service.snapshot(scope,"conversation")).nativeGoal).toEqual(confirmed);
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
