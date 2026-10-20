import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { manageCloudOwnerCheckpointRecovery } from "../manage-cloud-owner-checkpoint-recovery.js";
import { ownerRecoveryConfig, seedOwnerCheckpointRecovery } from "./owner-checkpoint-recovery-test-fixtures.js";
import { seedFinalSaveEngine } from "./final-save-test-fixtures.js";
import { DatabaseCloudAgentBootService } from "./agent-boot-credentials.js";
import { DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { canonicalCloudHistoryJson } from "./history-local-contract.js";
import { ensureCloudPilotUser, withCloudFixtureOwnerTx } from "./test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("owner-discard checkpoint-only history recovery", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });

  async function candidate() {
    const ancestorWriter = randomUUID(), mutationId = randomUUID();
    const source = await seedOwnerCheckpointRecovery(pool, { beforeCheckpoint: async f => {
      const previous = (await pool.query("SELECT * FROM cloud_workspace_engine_instances WHERE id=$1", [f.scope.engineInstanceId])).rows[0];
      const ancestorEngine = randomUUID(), grant = randomUUID(), boot = randomUUID();
      await pool.query(`INSERT INTO cloud_workspace_endpoint_grants
        (id,workspace_id,generation,org_id,account_user_id,purpose,audience,token_hash,account_revision,authorization_revision,
         expires_at,consumed_at,setup_run_id,setup_execution_fence)
        SELECT $2,workspace_id,generation,org_id,account_user_id,'setup','fixture',$3,1,1,
          now()+interval '10 minutes',now(),setup_run_id,setup_execution_fence
        FROM cloud_workspace_engine_instances WHERE id=$1`, [f.scope.engineInstanceId, grant, randomBytes(32)]);
      // A retained historical ancestor must precede the already-enrolled
      // fixture source; subsequent real enrollment still receives the next ID.
      const names = (await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='cloud_workspace_engine_instances' ORDER BY ordinal_position`))
        .rows.map(row => `"${row.column_name}"`).join(",");
      expect(Number(previous.enrollment_order)).toBeGreaterThan(1);
      await pool.query("SELECT setval('cloud_workspace_engine_instances_enrollment_order_seq',$1,false)", [Number(previous.enrollment_order)-1]);
      await pool.query(`INSERT INTO cloud_workspace_engine_instances (${names}) OVERRIDING SYSTEM VALUE
        SELECT ${names} FROM jsonb_populate_record(NULL::cloud_workspace_engine_instances,
          (SELECT to_jsonb(engine)||$2::jsonb FROM cloud_workspace_engine_instances engine WHERE id=$1))`,
      [f.scope.engineInstanceId, JSON.stringify({ id: ancestorEngine, registration_grant_id: grant, runtime_boot_id: boot,
        enrollment_order: Number(previous.enrollment_order) - 1, state: "revoked", revoked_at: new Date(Date.now()-300_000).toISOString(),
        registered_at: new Date(Date.now()-600_000).toISOString(),
        heartbeat_token_hash: `\\x${randomBytes(32).toString("hex")}`, bridge_token_hash: `\\x${randomBytes(32).toString("hex")}` })]);
      await pool.query("SELECT setval('cloud_workspace_engine_instances_enrollment_order_seq',(SELECT max(enrollment_order) FROM cloud_workspace_engine_instances),true)");
      const scope = { ...f.directive.finalSave!.source, engineInstanceId: ancestorEngine, bootId: boot, writerEpoch: ancestorWriter };
      const descriptor = { version: 1, scope: { organizationId: scope.organizationId, workspaceId: scope.workspaceId,
        generation: scope.generation, engineInstanceId: ancestorEngine, bootId: boot, writerEpoch: ancestorWriter,
        fundingOwnerUserId: scope.fundingOwnerUserId, fundingOwnerEpoch: scope.fundingOwnerEpoch },
        sealId: randomUUID(), sequence: 0, recordSequence: 0, eventSequence: 0, inventorySha256: "a".repeat(64) };
      const seal = { ...descriptor, sha256: createHash("sha256").update(canonicalCloudHistoryJson(descriptor)).digest("hex") };
      const { scope: _scope, ...ack } = seal;
      await pool.query(`INSERT INTO cloud_workspace_local_command_writers
        (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,
         state,activated_at,retired_at,sealed_sequence,seal_record_sequence,seal_event_sequence,seal,seal_ack)
        VALUES($1,$2,1,$3,$4,$5,$6,1,'retired',now()-interval '10 minutes',now()-interval '5 minutes',0,0,0,$7,$8)`,
      [f.scope.workspaceId, f.scope.organizationId, ancestorEngine, boot, ancestorWriter, f.fixture.userId,
        JSON.stringify(seal), JSON.stringify({ ...ack, writerEpoch: ancestorWriter })]);
      const writer = f.directive.finalSave!.source;
      await new DatabaseCloudWorkspaceCommandService({ pool }).mirror(f.scope, { version: 1,
        bootId: writer.bootId, writerEpoch: writer.writerEpoch,
        batchId: randomUUID(), after: 0, through: 1, changes: [{ sequence: 1, conversationId: "deleted-chat", revision: 1, paused: true,
          historyHead: { originWriterEpoch: writer.writerEpoch, source: { kind: "mutation", mutationId, operation: "delete" }, deleted: true,
            history: { restoreRevision: 1, recordSequence: 0, eventSequence: 0, incompleteReason: "capture_unavailable" } } }] });
    } });
    const options = { databaseUrl: process.env.TEST_DATABASE_URL!, config: ownerRecoveryConfig, workosEnabled: false };
    const plan = await manageCloudOwnerCheckpointRecovery(pool, source.requestInput, options);
    const accepted = await manageCloudOwnerCheckpointRecovery(pool, source.requestInput, { ...options, execute: true, approval: plan.approval });
    await pool.query("UPDATE cloud_workspaces SET status='setting_up' WHERE id=$1", [source.scope.workspaceId]);
    await pool.query("UPDATE cloud_workspace_generation_transitions SET state='setting_up' WHERE id=$1", [accepted.transitionId]);
    const target = await withSystemTx(pool, tx => seedFinalSaveEngine(tx, { ...source.fixture, generation: accepted.candidateGeneration }));
    await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1", [target.engineInstanceId]);
    const { heartbeatToken: _token, ...identity } = target;
    const service = new DatabaseCloudAgentBootService(pool, { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } }, false);
    const request = { ...identity, version: 1, mode: "boot-owner-v1" };
    return { source, target, accepted, service, request, ancestorWriter, mutationId };
  }

  it("authorizes the exact fresh candidate from owner discard and retains the CP delete fence", async () => {
    const f = await candidate();
    const result = await f.service.execute(f.target, "recover-history", { ...f.request, checkpointOnly: true }) as {
      coverage: string; checkpointOnly: { ownerDiscardReceiptId: string; checkpointId: string; document: string; sha256: string };
    };
    expect(result.coverage).toBe("unknown");
    expect(result.checkpointOnly).toMatchObject({ ownerDiscardReceiptId: f.accepted.receiptId, checkpointId: f.source.checkpointId });
    expect(createHash("sha256").update(result.checkpointOnly.document).digest("hex")).toBe(result.checkpointOnly.sha256);
    expect(JSON.parse(result.checkpointOnly.document)).toMatchObject({ heads: [{ conversationId: "deleted-chat", head: {
      deleted: true, source: { mutationId: f.mutationId }, history: { incompleteReason: "capture_unavailable" } } }] });
    expect(await f.service.execute(f.target, "recover-history", { ...f.request, checkpointOnly: true })).toEqual(result);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_local_command_writers WHERE state='active'")).rows[0].n).toBe(0);
  });

  it("does not infer positive source retirement for an ordinary surviving-ledger request", async () => {
    const f = await candidate();
    await expect(f.service.execute(f.target, "recover-history", f.request)).rejects.toMatchObject({ status: 403 });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_agent_history_recoveries")).rows[0].n).toBe(0);
  });

  it("refuses a checkpoint-only request after the retained source checkpoint is invalidated", async () => {
    const f = await candidate();
    await pool.query("UPDATE workspace_checkpoints SET state='invalid',invalidated_at=clock_timestamp() WHERE id=$1", [f.source.checkpointId]);
    await expect(f.service.execute(f.target, "recover-history", { ...f.request, checkpointOnly: true })).rejects.toMatchObject({ status: 403 });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_agent_history_recoveries")).rows[0].n).toBe(0);
  });

  it("activates exactly the frozen gap and rejects ordinary replay or changing the snapshot", async () => {
    const f=await candidate();
    const recovered=await f.service.execute(f.target,"recover-history",{...f.request,checkpointOnly:true}) as {recoveryId:string};
    await expect(f.service.execute(f.target,"recover-history",f.request)).rejects.toMatchObject({status:403});
    const boot=await f.service.execute(f.target,"bootstrap",f.request) as {bootId:string;writerEpoch:string;cacheRevision:number};
    const activated=await f.service.execute(f.target,"activate",{...f.request,bootId:boot.bootId,writerEpoch:boot.writerEpoch,
      expectedCacheRevision:boot.cacheRevision,historyRecoveryId:recovered.recoveryId,historyRecoveryCustodySha256:"a".repeat(64)});
    expect(activated).toMatchObject({activated:true,writerEpoch:boot.writerEpoch});
    expect(await f.service.execute(f.target,"recover-history",{...f.request,checkpointOnly:true})).toEqual(recovered);
    await expect(pool.query("UPDATE cloud_agent_checkpoint_history_snapshots SET document='{}' WHERE recovery_id=$1",[recovered.recoveryId])).rejects.toMatchObject({code:"55000"});
    await expect(pool.query("DELETE FROM cloud_agent_checkpoint_history_snapshots WHERE recovery_id=$1",[recovered.recoveryId])).rejects.toMatchObject({code:"55000"});
    await expect(pool.query("TRUNCATE cloud_agent_checkpoint_history_snapshots")).rejects.toMatchObject({code:"55000"});
    await withUserTx(pool,f.source.fixture.userId,async tx=>{
      expect((await tx.query("SELECT * FROM cloud_agent_checkpoint_history_snapshots")).rows).toEqual([]);
    });
  });

  it("cascades the frozen body when its parent history recovery is purged",async()=>{
    const f=await candidate();
    const recovered=await f.service.execute(f.target,"recover-history",{...f.request,checkpointOnly:true}) as {recoveryId:string};
    await withSystemTx(pool,tx=>tx.query("DELETE FROM cloud_agent_history_recoveries WHERE id=$1",[recovered.recoveryId]));
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_agent_checkpoint_history_snapshots")).rows[0].n).toBe(0);
    expect((await f.source.row()).state).toBe("discarded");
  });

  it.each(["checkpoint","runtime","funding"])("refuses activation after %s changes without publishing a successor",async kind=>{
    const f=await candidate();
    const recovered=await f.service.execute(f.target,"recover-history",{...f.request,checkpointOnly:true}) as {recoveryId:string};
    const boot=await f.service.execute(f.target,"bootstrap",f.request) as {bootId:string;writerEpoch:string;cacheRevision:number};
    if(kind==="checkpoint")await pool.query("UPDATE workspace_checkpoints SET state='invalid',invalidated_at=clock_timestamp() WHERE id=$1",[f.source.checkpointId]);
    if(kind==="runtime")await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=clock_timestamp() WHERE id=$1",[f.target.engineInstanceId]);
    if(kind==="funding") {
      const other=(await ensureCloudPilotUser(pool,{provider:"workos",providerSubject:`user_${randomUUID()}`,
        email:`history-${randomUUID()}@example.test`,displayName:"History funding fixture"})).id;
      await withCloudFixtureOwnerTx(pool,async tx=>{
        await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",[f.target.organizationId,other]);
        await tx.query("INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES($1,$2,'active')",[f.target.organizationId,other]);
      });
      await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1",[f.target.workspaceId,other]);
      await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1",[f.target.workspaceId,f.source.fixture.userId]);
    }
    await expect(f.service.execute(f.target,"activate",{...f.request,bootId:boot.bootId,writerEpoch:boot.writerEpoch,
      expectedCacheRevision:boot.cacheRevision,historyRecoveryId:recovered.recoveryId,historyRecoveryCustodySha256:"a".repeat(64)})).rejects.toThrow();
    expect((await pool.query("SELECT activated_at FROM cloud_agent_history_recoveries WHERE id=$1",[recovered.recoveryId])).rows[0].activated_at).toBeNull();
    expect((await pool.query("SELECT state FROM cloud_workspace_local_command_writers WHERE writer_epoch=$1",[boot.writerEpoch])).rows[0].state).toBe("reserved");
  });
});
