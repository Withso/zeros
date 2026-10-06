import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { copyGenerationPins, loadGenerationSource } from "./generation-pins.js";
import { readCloudRuntimeResumeProofEpoch } from "./runtime-transition.js";
import { seedReadyCloudWorkspace, type ReadyCloudWorkspaceFixture } from "./test-fixtures.js";

(process.env.TEST_DATABASE_URL ? describe : describe.skip)("cloud runtime resume proof epoch", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: true });
  });

  const scope = () => ({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1 });
  const epoch = (overrides: Partial<ReturnType<typeof scope>> = {}) => withSystemTx(pool, async tx => {
    await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [fixture.workspaceId, fixture.organizationId]);
    return readCloudRuntimeResumeProofEpoch(tx, { ...scope(), ...overrides });
  });

  async function attest(engineId = fixture.engineInstanceId, complete = true) {
    await pool.query(`INSERT INTO cloud_workspace_setup_attestations (
      setup_run_id,workspace_id,generation,org_id,execution_fence,
      image_ref,image_source_commit,repository_revision,repository_commit,settings_version,settings_snapshot_sha256,
      engine_instance_id,engine_protocol_version,engine_health,durable_record_connected,
      runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,
      runtime_installer_receipt_sha256,runtime_boot_id,runtime_supervisor_session_id)
      SELECT run.id,run.workspace_id,run.generation,run.org_id,run.execution_fence,
        g.image_ref,g.source_commit,'main',$2,1,spec.settings_snapshot_sha256,engine.id,engine.protocol_version,'ready',true,
        g.runtime_id,g.runtime_manifest_sha256,g.runtime_base_image_id,g.runtime_base_compatibility_id,g.runtime_profile,g.runtime_engine_protocol_version,
        engine.runtime_installer_receipt_sha256,engine.runtime_boot_id,engine.runtime_supervisor_session_id
      FROM cloud_workspace_setup_runs run
      JOIN cloud_workspace_generations g USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_setup_specs spec USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_engine_instances engine ON engine.setup_run_id=run.id
      WHERE engine.id=$1`, [engineId, "c".repeat(40)]);
    if (complete) await pool.query(`UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL
      WHERE id=(SELECT setup_run_id FROM cloud_workspace_engine_instances WHERE id=$1)`, [engineId]);
  }

  async function stop() {
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
  }

  async function enroll({ sameFence = false, ready = false } = {}) {
    const engineId = randomUUID(), grantId = randomUUID();
    const source = (await pool.query("SELECT setup_run_id FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0];
    const runId = sameFence ? source.setup_run_id : randomUUID();
    if (!sameFence) await pool.query(`INSERT INTO cloud_workspace_setup_runs (
      id,workspace_id,generation,org_id,attempt,state,claim_count,execution_fence,lease_owner,lease_expires_at,last_heartbeat_at,started_at)
      VALUES($1,$2,1,$3,2,'running',1,1,'fixture',now()+interval '10 minutes',now(),now())`, [runId, fixture.workspaceId, fixture.organizationId]);
    await pool.query(`INSERT INTO cloud_workspace_endpoint_grants (
      id,workspace_id,generation,org_id,account_user_id,purpose,audience,token_hash,account_revision,authorization_revision,
      expires_at,consumed_at,setup_run_id,setup_execution_fence)
      VALUES($1,$2,1,$3,$4,'setup','fixture',digest($1::uuid::text,'sha256'),1,1,now()+interval '10 minutes',
        CASE WHEN $6::boolean THEN now() END,$5,1)`, [grantId, fixture.workspaceId, fixture.organizationId, fixture.userId, runId, ready]);
    await pool.query(`UPDATE cloud_workspace_engine_instances SET state='superseded',revoked_at=now()
      WHERE workspace_id=$1 AND state IN ('starting','ready')`, [fixture.workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_engine_instances (
      id,workspace_id,generation,org_id,account_user_id,setup_run_id,setup_execution_fence,registration_grant_id,protocol_version,
      state,bridge_token_hash,heartbeat_token_hash,registered_at,last_heartbeat_at,lease_expires_at,
      runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,
      runtime_installer_receipt_sha256,runtime_boot_id,runtime_supervisor_session_id)
      SELECT $1,workspace_id,generation,org_id,account_user_id,$2,1,$3,protocol_version,
        CASE WHEN $4::boolean THEN 'ready' ELSE 'starting' END,digest($1::uuid::text,'sha256'),
        CASE WHEN $4::boolean THEN digest($1::uuid::text,'sha256') END,
        CASE WHEN $4::boolean THEN now() END,CASE WHEN $4::boolean THEN now() END,
        CASE WHEN $4::boolean THEN now()+interval '10 minutes' END,
        runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version,
        runtime_installer_receipt_sha256,runtime_boot_id,$1
      FROM cloud_workspace_engine_instances WHERE id=$5`, [engineId, runId, grantId, ready, fixture.engineInstanceId]);
    return engineId;
  }

  async function addGeneration() {
    await withSystemTx(pool, async tx => {
      const source = await loadGenerationSource(tx, scope());
      const connection = (await tx.query("SELECT provider_connection_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1", [fixture.workspaceId])).rows[0];
      await copyGenerationPins(tx, { ...scope(), sourceGeneration: 1, targetGeneration: 2, actorUserId: fixture.userId,
        providerConnectionId: connection.provider_connection_id, legacyProfile: source.profile, qualificationMode: "full" });
    });
  }

  async function transition(state: string) {
    await addGeneration();
    const drain = randomUUID(), provision = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256)
      VALUES($1,$3,1,$4,'stop',$1::uuid::text,digest($1::uuid::text,'sha256')),($2,$3,2,$4,'create',$2::uuid::text,digest($2::uuid::text,'sha256'))`,
    [drain, provision, fixture.workspaceId, fixture.organizationId]);
    await pool.query(`INSERT INTO cloud_workspace_generation_transitions (
      id,workspace_id,org_id,operation,source_generation,template_generation,candidate_generation,state,drain_intent_id,provision_intent_id,completed_at)
      VALUES($1,$2,$3,'upgrade',1,1,2,$4,$5,$6,CASE WHEN $7::boolean THEN now() END)`,
    [randomUUID(), fixture.workspaceId, fixture.organizationId, state, drain, state === "draining" ? null : provision,
      ["succeeded", "rolled_back", "rollback_failed", "cancelled"].includes(state)]);
  }

  it("requires both exact engine attestation and completed setup", async () => {
    expect(await epoch()).toBeNull();
    await attest(fixture.engineInstanceId, false);
    expect(await epoch()).toBeNull();
    await pool.query("UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1", [fixture.workspaceId]);
    expect(await epoch()).toBe(fixture.engineInstanceId);
  });

  it("does not treat a succeeded setup row without attestation as completed evidence", async () => {
    await pool.query("UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1", [fixture.workspaceId]);
    expect(await epoch()).toBeNull();
  });

  it("retains completed evidence across a normal stop and queued same-generation resume", async () => {
    await attest();
    await stop();
    await pool.query(`UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=now()-interval '2 hours',lease_expires_at=now()-interval '1 hour'
      WHERE id=$1`, [fixture.engineInstanceId]);
    expect(await epoch()).toBe(fixture.engineInstanceId);
    await pool.query("INSERT INTO cloud_workspace_setup_runs(workspace_id,generation,org_id,attempt) VALUES($1,1,$2,2)", [fixture.workspaceId, fixture.organizationId]);
    await pool.query("UPDATE cloud_workspaces SET status='waking',desired_state='running' WHERE id=$1", [fixture.workspaceId]);
    expect(await epoch()).toBe(fixture.engineInstanceId);
  });

  it.each([false, true])("never falls back to old completed evidence after a replacement enrollment (ready=%s)", async ready => {
    await attest();
    await stop();
    const replacement = await enroll({ ready });
    // Transaction timestamps may tie or run backwards relative to lock acquisition.
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=now()-interval '1 day' WHERE id=$1", [replacement]);
    expect(await epoch()).toBeNull();
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [replacement]);
    expect(await epoch()).toBeNull();
  });

  it("uses a fresh epoch only after replacement enrollment completes", async () => {
    await attest();
    await stop();
    const replacement = await enroll({ ready: true });
    expect(await epoch()).toBeNull();
    await attest(replacement);
    expect(await epoch()).toBe(replacement);
    expect(replacement).not.toBe(fixture.engineInstanceId);
  });

  it("fails closed on multiple enrollments in the same setup fence", async () => {
    await attest(fixture.engineInstanceId, false);
    await stop();
    await enroll({ sameFence: true });
    await pool.query("UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1", [fixture.workspaceId]);
    expect(await epoch()).toBeNull();
  });

  it.each(["draining", "provisioning", "setting_up", "rolling_back", "rollback_failed"])("invalidates evidence during %s", async state => {
    await attest();
    await transition(state);
    expect(await epoch()).toBeNull();
  });

  it("retains the source epoch when a transition is cancelled before activation", async () => {
    await attest();
    await transition("cancelled");
    expect(await epoch()).toBe(fixture.engineInstanceId);
  });

  it("requires fresh completed enrollment after rollback instead of restoring the old epoch", async () => {
    await attest();
    await stop();
    await transition("rolled_back");
    expect(await epoch()).toBeNull();
    const replacement = await enroll({ ready: true });
    await attest(replacement);
    expect(await epoch()).toBe(replacement);
  });

  it("isolates organization/workspace/generation keys and refuses a stale generation", async () => {
    await attest();
    expect(await epoch({ organizationId: randomUUID() })).toBeNull();
    expect(await epoch({ workspaceId: randomUUID() })).toBeNull();
    expect(await epoch({ generation: 2 })).toBeNull();
    await addGeneration();
    await pool.query("UPDATE cloud_workspaces SET current_generation=2 WHERE id=$1", [fixture.workspaceId]);
    expect(await epoch()).toBeNull();
    expect(await epoch({ generation: 2 })).toBeNull();
  });

  it("returns no v4 epoch for a legacy runtime or deleted workspace", async () => {
    await attest();
    await pool.query("UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now() WHERE id=$1", [fixture.workspaceId]);
    expect(await epoch()).toBeNull();
    fixture = await seedReadyCloudWorkspace(pool);
    await attest();
    expect(await epoch()).toBeNull();
  });
});
