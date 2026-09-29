import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudIdleStop } from "./idle-stop.js";
import { DatabaseCloudWorkspaceBlobService } from "./object-store.js";
import { DatabaseCloudWorkspaceContentService } from "./content-record.js";
import { CloudWorkspaceSetupWorker, CloudWorkspaceSetupError, type CloudWorkspaceSetupExecution, type CloudWorkspaceSetupResult } from "./setup-worker.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import type { CloudWorkspaceProvider, CloudProviderResource } from "./provider.js";
import { CloudProviderError } from "./provider.js";
import { withSystemTx, withUserTx } from "../db.js";
import { deferCloudRecoveryResourceBlock } from "./automatic-recovery.js";
import { Hono } from "hono";
import { HttpError } from "../authz.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import { previousBackendRecoveryRollback } from "./lifecycle-compatibility-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const recoveryConfig = { provider: "boat", imageRef: "qualified-image", sourceCommit: "b".repeat(40), architecture: "linux/amd64",
  cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480, settingsSecretEncryptionKeys: {}, currentSettingsSecretEncryptionKeyVersion: null } as CloudWorkspaceBackendConfig;
suite("automatic Boat checkpoint recovery", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let setupRunId: string;
  let checkpointId: string;
  let blobs: DatabaseCloudWorkspaceBlobService;
  let content: DatabaseCloudWorkspaceContentService;
  let admittedEngine: { engineInstanceId: string; heartbeatToken: string; generation: number };
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    // This fixture isolates recovery admission from the separately tested
    // managed lease coordinator; it never contacts or qualifies a provider.
    await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=false WHERE provider='boat'");
    const { workspaceId, organizationId, engineInstanceId } = fixture;
    const scope = { workspaceId, organizationId, engineInstanceId, generation: 1, heartbeatToken: fixture.heartbeatToken };
    await pool.query(`UPDATE provider_connections SET provider='boat' WHERE id=(SELECT provider_connection_id FROM cloud_workspace_generations WHERE workspace_id=$1)`, [workspaceId]);
    await pool.query("UPDATE cloud_workspace_generations SET provider='boat' WHERE workspace_id=$1", [workspaceId]);
    await pool.query("UPDATE cloud_workspace_provider_bindings SET provider='boat' WHERE workspace_id=$1", [workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_setup_attestations (setup_run_id,workspace_id,generation,org_id,execution_fence,
      image_ref,image_source_commit,repository_revision,repository_commit,settings_version,settings_snapshot_sha256,
      engine_instance_id,engine_protocol_version,engine_health,durable_record_connected)
      SELECT sr.id,sr.workspace_id,1,sr.org_id,sr.execution_fence,g.image_ref,g.source_commit,'main',$2,1,ss.settings_snapshot_sha256,$3,11,'ready',true
      FROM cloud_workspace_setup_runs sr JOIN cloud_workspace_generations g USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_setup_specs ss USING(workspace_id,generation,org_id) WHERE sr.workspace_id=$1`, [workspaceId, "c".repeat(40), engineInstanceId]);
    await pool.query("UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE workspace_id=$1", [workspaceId]);
    const objects = new Map<string, Buffer>();
    blobs = new DatabaseCloudWorkspaceBlobService({ pool, workosEnabled: false, encryptionKeyV1: randomBytes(32).toString("base64url"),
      objectStore: { async putIfAbsent(key, value) { if (objects.has(key)) return "already_exists"; objects.set(key, value); return "created"; },
        async get(key) { return objects.get(key) ?? null; }, async delete(key) { objects.delete(key); },
        async deleteAndFence(key) { objects.delete(key); }, async sweepAbandonedUploads() { return 0; } } });
    content = new DatabaseCloudWorkspaceContentService({ pool, workosEnabled: false });
    const file = await blobs.put({ ...scope, bytes: Buffer.from("durable") });
    const manifest = await blobs.put({ ...scope, bytes: Buffer.from("{}") });
    const appended = await content.append({ ...scope, expectedRevision: 0, idempotencyKey: randomUUID(), gitBaseCommit: "a".repeat(40), gitHeadRef: null,
      mutations: [{ path: "file.txt", operation: "upsert", entryType: "file", mode: 33188, blobId: file.id, contentSha256: file.plaintextSha256, sizeBytes: 7 }] });
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=now()-interval '11 minutes' WHERE id=$1", [engineInstanceId]);
    const directive = (await new DatabaseCloudIdleStop(pool, false).request(scope, randomUUID()))!;
    checkpointId = (await content.commitCheckpoint({ ...scope, requestId: directive.id, idempotencyKey: randomUUID(), contentRevision: appended.revision,
      reason: "before_stop", manifestBlobId: manifest.id, artifactBlobId: null, inclusionPolicy: {}, fileCount: 1, totalBytes: 7, integritySha256: manifest.plaintextSha256 })).checkpointId;
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE workspace_id=$1", [workspaceId]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE workspace_id=$1", [workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256,state,completed_at)
      VALUES($1,$2,1,$3,$4,'wake',$5,$6,'succeeded',now())`, [randomUUID(), workspaceId, organizationId, fixture.userId, randomUUID(), Buffer.alloc(32)]);
    setupRunId = (await pool.query(`INSERT INTO cloud_workspace_setup_runs(workspace_id,generation,org_id,attempt,state) VALUES($1,1,$2,2,'queued') RETURNING id`, [workspaceId, organizationId])).rows[0].id;
    await pool.query("UPDATE cloud_workspaces SET status='setting_up',authority_epoch=authority_epoch+1 WHERE id=$1", [workspaceId]);
    await pool.query(`INSERT INTO cloud_workspace_quotas(org_id,max_workspaces,max_running_workspaces,max_cpu_millicores,max_memory_mib,max_storage_mib)
      VALUES($1,10,10,100000,100000,1000000) ON CONFLICT(org_id) DO UPDATE SET max_storage_mib=1000000`, [organizationId]);
  });
  const worker = (code: string) => new CloudWorkspaceSetupWorker({ pool, recoveryConfig, intervalMs: 1000, maxClaims: 2,
    sanitizeLog: value => value, executor: { async execute() { throw new CloudWorkspaceSetupError(code, "do not persist diagnostic-secret", true); } } });
  async function drain() {
    let resource: CloudProviderResource = { workspaceId: fixture.workspaceId, generation: 1, resourceId: `sandbox-${fixture.workspaceId}`, state: "running", target: null, metadata: {} };
    const provider: CloudWorkspaceProvider = { name: "boat", async find() { return [resource]; }, async inspect() { return resource; },
      async create() { throw new Error("Allocation must wait for drain"); }, async start() { throw new Error("The source must stay stopped"); },
      async stop() { resource = { ...resource, state: "stopped" }; return resource; }, async archive() { return resource; }, async delete() {}, async *listManaged() {} };
    await new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1000 }).runOnce();
    expect((await pool.query("SELECT observed_state FROM cloud_workspace_provider_bindings WHERE workspace_id=$1 AND generation=1", [fixture.workspaceId])).rows[0].observed_state).toBe("stopped");
  }
  async function exhaust(code = "setup_immutable_runtime_missing") {
    const subject = worker(code);
    await subject.runOnce();
    await pool.query("UPDATE cloud_workspace_setup_runs SET next_attempt_at=now() WHERE id=$1", [setupRunId]);
    await subject.runOnce();
    return subject;
  }
  function route(path = "", body?: unknown, key = randomUUID()) {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: fixture.userId }); await next(); });
    app.route("/", createCloudWorkspaceRoutes(pool, recoveryConfig, { workosEnabled: false }));
    app.onError((error, c) => error instanceof HttpError ? c.json({ code: error.code }, error.status) : c.json({ code: "unexpected_error" }, 500));
    return app.request(`/v1/organizations/${fixture.organizationId}/cloud-workspaces/${fixture.workspaceId}${path}`, {
      method: path ? "POST" : "GET", headers: { "idempotency-key": key, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function ready(execution: CloudWorkspaceSetupExecution): Promise<CloudWorkspaceSetupResult> {
    const engineId = randomUUID();
    admittedEngine = { engineInstanceId: engineId, generation: execution.generation, heartbeatToken: `zwh_${randomBytes(32).toString("base64url")}` };
    // Exercise the actual database admission and attestation contracts. The
    // external image/helper is a fixture, just as in setup-worker integration.
    await withSystemTx(pool, async tx => {
      const grant = (await tx.query(`INSERT INTO cloud_workspace_endpoint_grants(workspace_id,generation,org_id,account_user_id,
        purpose,audience,token_hash,account_revision,authorization_revision,expires_at,consumed_at,setup_run_id,setup_execution_fence)
        VALUES($1,$2,$3,$4,'setup','https://control.example.test/internal/v1/cloud-workspaces/engine/register',$5,1,1,
          now()+interval '5 minutes',now(),$6,$7) RETURNING id`,
      [execution.workspaceId, execution.generation, execution.organizationId, fixture.userId, randomBytes(32), execution.setupRunId, execution.executionFence])).rows[0].id;
      await tx.query(`INSERT INTO cloud_workspace_engine_instances(id,workspace_id,generation,org_id,account_user_id,
        setup_run_id,setup_execution_fence,registration_grant_id,protocol_version,state,bridge_token_hash,heartbeat_token_hash,
        registered_at,last_heartbeat_at,lease_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10,$11,now(),now(),now()+interval '2 minutes')`,
      [engineId, execution.workspaceId, execution.generation, execution.organizationId, fixture.userId,
        execution.setupRunId, execution.executionFence, grant, CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, randomBytes(32), createHash("sha256").update(admittedEngine.heartbeatToken).digest()]);
    });
    return { readiness: { version: 1, setupRunId: execution.setupRunId, workspaceId: execution.workspaceId,
      organizationId: execution.organizationId, generation: execution.generation, executionFence: execution.executionFence,
      image: { ref: execution.image.ref, sourceCommit: execution.image.sourceCommit! },
      repository: { revision: execution.repository.revision, commit: "c".repeat(40) },
      settings: { version: execution.settings.version, sha256: execution.settings.sha256 },
      engine: { instanceId: engineId, protocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION, health: "ready", durableRecordConnected: true } } };
  }
  it.each(["setup_immutable_runtime_missing", "setup_immutable_inventory_invalid"])("enqueues exactly one durable recovery for repeated %s", async code => {
    const subject = await exhaust(code);
    expect((await pool.query("SELECT last_error_code FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].last_error_code).toBe("recovery_restoring");
    await drain();
    await Promise.all([subject.runOnce(), worker(code).runOnce()]);
    const transitions = (await pool.query("SELECT operation,state,candidate_generation FROM cloud_workspace_generation_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rows;
    expect(transitions).toEqual([{ operation: "recover", state: "provisioning", candidate_generation: 2 }]);
    expect((await pool.query("SELECT recovery_checkpoint_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId])).rows[0].recovery_checkpoint_id).toBe(checkpointId);
    expect((await pool.query("SELECT log_excerpt FROM cloud_workspace_setup_runs WHERE id=$1", [setupRunId])).rows[0].log_excerpt).not.toContain("diagnostic-secret");
  });
  it("preserves the source and asks for recovery when the latest checkpoint is only periodic", async () => {
    await pool.query("UPDATE workspace_checkpoint_requests SET reason='manual',idle_engine_instance_id=NULL WHERE workspace_id=$1", [fixture.workspaceId]);
    await exhaust();
    expect((await pool.query("SELECT status,last_error_code,current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ status: "failed", last_error_code: "recovery_needed", current_generation: 1 });
  });
  it("waits durably for capacity without allocating a generation", async () => {
    await pool.query("UPDATE cloud_workspace_quotas SET max_storage_mib=20480 WHERE org_id=$1", [fixture.organizationId]);
    const subject = await exhaust(); await drain(); await subject.runOnce();
    expect((await pool.query("SELECT last_error_code,current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ last_error_code: "recovery_waiting_for_capacity", current_generation: 1 });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].n).toBe(1);
  });
  it("does not infer immutable loss from generic bootstrap, auth or repository failures", async () => {
    await exhaust("setup_provider_bootstrap_unavailable");
    expect((await pool.query("SELECT last_error_code,current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ last_error_code: "setup_provider_bootstrap_unavailable", current_generation: 1 });
  });
  it.each(["missing", "invalid", "later_admission"])("preserves the source for a %s recovery point", async condition => {
    if (condition === "missing") await pool.query("UPDATE workspace_content_heads SET current_checkpoint_id=NULL WHERE workspace_id=$1", [fixture.workspaceId]);
    if (condition === "invalid") await pool.query("UPDATE workspace_checkpoints SET state='invalid',invalidated_at=now() WHERE id=$1", [checkpointId]);
    if (condition === "later_admission") await pool.query("UPDATE cloud_workspace_engine_instances SET registered_at=now() WHERE id=$1", [fixture.engineInstanceId]);
    await exhaust();
    expect((await pool.query("SELECT current_generation,last_error_code FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ current_generation: 1, last_error_code: "recovery_needed" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_generation_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].n).toBe(0);
  });
  it.each(["stop", "archive", "delete", "account", "policy"])("cancels an enqueued replacement after %s changes", async operation => {
    const subject = await exhaust();
    if (operation === "account") await pool.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [fixture.userId]);
    else if (operation === "policy") await pool.query("UPDATE organizations SET authorization_revision=authorization_revision+1 WHERE id=$1", [fixture.organizationId]);
    else await pool.query("UPDATE cloud_workspaces SET desired_state=$2 WHERE id=$1", [fixture.workspaceId, { stop: "stopped", archive: "archived", delete: "deleted" }[operation]]);
    await subject.runOnce();
    expect((await pool.query("SELECT state FROM cloud_workspace_restore_incidents WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("cancelled");
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].n).toBe(1);
  });
  it("bounds a capacity wait and keeps the source quarantined after its deadline", async () => {
    const subject = await exhaust(); await drain();
    await pool.query("UPDATE cloud_workspace_quotas SET max_storage_mib=20480 WHERE org_id=$1", [fixture.organizationId]);
    await subject.runOnce();
    await pool.query("UPDATE cloud_workspace_restore_incidents SET deadline_at=now()-interval '1 second',next_attempt_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await worker("setup_immutable_runtime_missing").runOnce();
    expect((await pool.query("SELECT last_error_code FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].last_error_code).toBe("recovery_needed");
    expect((await withSystemTx(pool, tx => tx.query("SELECT cloud_workspace_runtime_authority_live($1,1,$2,false) AS live", [fixture.workspaceId, fixture.userId]))).rows[0].live).toBe(false);
  });
  it.each(["compute_credit_exhausted", "provider_vm_quota_exhausted"])("keeps the single candidate while %s blocks allocation and never rolls back to the corrupt source", async code => {
    const subject = await exhaust(); await drain(); await subject.runOnce();
    const transition = (await pool.query("SELECT id,provision_intent_id FROM cloud_workspace_generation_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rows[0];
    const provider: CloudWorkspaceProvider = { name: "boat", async find() { return []; }, async inspect() { return null; },
      async create() { throw new CloudProviderError(code, "fixture", false); }, async start() { throw new Error("must not wake source"); },
      async stop() { throw new Error("source already drained"); }, async archive() { throw new Error("unused"); }, async delete() {}, async *listManaged() {} };
    await new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1000 }).runOnce();
    expect((await pool.query("SELECT state FROM cloud_workspace_restore_incidents WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state)
      .toBe(code === "compute_credit_exhausted" ? "waiting_for_funding" : "waiting_for_capacity");
    await pool.query("UPDATE cloud_workspace_restore_incidents SET deadline_at=now()-interval '1 second',next_attempt_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    expect(await withSystemTx(pool, tx => deferCloudRecoveryResourceBlock(tx, {workspaceId:fixture.workspaceId,transitionId:transition.id,intentId:transition.provision_intent_id,code:"compute_credit_exhausted"}))).toBe(false);
    await subject.runOnce();
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE id=$1", [transition.id])).rows[0].state).toBe("rollback_failed");
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND operation='wake' AND state IN ('queued','observing')", [fixture.workspaceId])).rows[0].n).toBe(0);
  });
  it("refuses a wake of the quarantined source after the owner cancels automatic recovery", async () => {
    const subject = await exhaust();
    expect((await route("/stop")).status).toBe(202);
    await subject.runOnce();
    expect((await pool.query("SELECT state FROM cloud_workspace_restore_incidents WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("cancelled");
    const response = await route("/wake");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "recovery_needed" });
    expect((await (await route()).json()).workspace.recovery.state).toBe("recovery_needed");
    await pool.query("UPDATE cloud_workspace_restore_incidents SET updated_at=now()-interval '31 days' WHERE workspace_id=$1", [fixture.workspaceId]);
    await subject.runOnce();
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_restore_incidents WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].n).toBe(1);
  });
  it("exposes acknowledgement when a source checkpoint does not prove the candidate generation lossless", async () => {
    const subject = await exhaust(); await drain(); await subject.runOnce();
    const response = await route();
    expect(response.status).toBe(200);
    expect((await response.json()).workspace.recovery.needsAcknowledgement).toBe(true);
  });
  it("shares explicit recovery admission, requires acknowledgement, and replays the same accepted transition", async () => {
    await pool.query("UPDATE workspace_checkpoint_requests SET reason='manual',idle_engine_instance_id=NULL WHERE workspace_id=$1", [fixture.workspaceId]);
    await exhaust();
    const body = { operation: "recover", sourceGeneration: 1, checkpointId };
    const refused = await route("/generations", body);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ code: "recovery_acknowledgement_required" });
    const key = randomUUID();
    const accepted = await route("/generations", { ...body, allowDataLoss: true }, key);
    const result = await accepted.json();
    expect(accepted.status, JSON.stringify(result)).toBe(202);
    expect(result.transition).toMatchObject({ operation: "recover", sourceGeneration: 1, candidateGeneration: 2 });
    const replay = await route("/generations", { ...body, allowDataLoss: true }, key);
    expect(replay.status).toBe(200);
    expect((await replay.json()).transition.id).toBe(result.transition.id);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_generation_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].n).toBe(1);
    expect(result.workspace.recovery.state).toBe("restoring");
  });
  it("fences an older recovery rollback and terminates its overdue job without starting the source", async () => {
    const subject = await exhaust(); await drain(); await subject.runOnce();
    await withSystemTx(pool, tx => previousBackendRecoveryRollback(tx, fixture));
    const workspace = (await pool.query("SELECT status,desired_state,current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0];
    const rejectedWake = (await pool.query("SELECT id FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND generation=1 AND operation='wake' AND error_code='recovery_needed'", [fixture.workspaceId])).rows[0];
    expect(rejectedWake).toBeDefined();
    await expect(withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',lease_owner='previous-worker',lease_expires_at=now()+interval '1 minute' WHERE id=$1", [rejectedWake.id])))
      .rejects.toThrow("workspace generation is quarantined");
    let starts = 0;
    const resource: CloudProviderResource = { workspaceId: fixture.workspaceId, generation: 1, resourceId: `sandbox-${fixture.workspaceId}`, state: "stopped", target: null, metadata: {} };
    const provider: CloudWorkspaceProvider = { name: "boat", async find() { return [resource]; }, async inspect() { return resource; },
      async create() { throw new Error("unused"); }, async start() { starts++; return { ...resource, state: "running" }; },
      async stop() { return resource; }, async archive() { return resource; }, async delete() {}, async *listManaged() {} };
    await new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1000 }).runOnce();
    await pool.query("UPDATE cloud_workspace_restore_incidents SET deadline_at=now()-interval '1 second',next_attempt_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await subject.runOnce();
    expect(workspace).toEqual({ status: "failed", desired_state: "stopped", current_generation: 1 });
    expect(starts).toBe(0);
    expect((await pool.query("SELECT state FROM cloud_workspace_restore_incidents WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("recovery_needed");
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("rollback_failed");
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND generation=1 AND operation='wake' AND state IN ('queued','observing','dispatching')", [fixture.workspaceId])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND generation=2 AND operation='delete'", [fixture.workspaceId])).rows[0].n).toBeGreaterThan(0);
  });
  it.each(["database", "worker"])("repairs a previously published recovery rollback through the %s", async repair => {
    const subject = await exhaust(); await drain(); await subject.runOnce();
    // Model a row published before the rollout guard was installed. Only
    // this disposable fixture bypasses that trigger; normal writes cannot.
    await pool.query("ALTER TABLE cloud_workspace_generation_transitions DISABLE TRIGGER cloud_workspace_reject_recovery_rollback");
    try {
      await pool.query("UPDATE cloud_workspace_generation_transitions SET state='rolling_back' WHERE workspace_id=$1", [fixture.workspaceId]);
      await pool.query("UPDATE cloud_workspaces SET current_generation=1,status='failed',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    } finally {
      await pool.query("ALTER TABLE cloud_workspace_generation_transitions ENABLE TRIGGER cloud_workspace_reject_recovery_rollback");
    }
    if (repair === "database") await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_generation_transitions SET state=state WHERE workspace_id=$1", [fixture.workspaceId]));
    else {
      await pool.query("UPDATE cloud_workspace_restore_incidents SET next_attempt_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
      await subject.runOnce();
    }
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("rollback_failed");
    expect((await pool.query("SELECT state FROM cloud_workspace_restore_incidents WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("recovery_needed");
    expect((await pool.query("SELECT operation,generation FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND state='queued' ORDER BY generation", [fixture.workspaceId])).rows)
      .toEqual([{ operation: "stop", generation: 1 }, { operation: "delete", generation: 2 }]);
  });
  it("terminates a recovery deadline when its candidate is no longer current", async () => {
    const subject = await exhaust(); await drain(); await subject.runOnce();
    // A stale transition cannot be rolled back over a separately published
    // generation. The job must still leave the immediately-due work queue.
    await pool.query(`INSERT INTO cloud_workspace_generations(workspace_id,generation,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,created_by,provider_connection_id)
      SELECT workspace_id,3,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,created_by,provider_connection_id
      FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=2`, [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspaces SET current_generation=3 WHERE id=$1", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_restore_incidents SET deadline_at=now()-interval '1 second',next_attempt_at=now() WHERE workspace_id=$1", [fixture.workspaceId]);
    await subject.runOnce();
    expect((await pool.query("SELECT state FROM cloud_workspace_restore_incidents WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("recovery_needed");
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].current_generation).toBe(3);
  });
  it.each(["stopped", "archived"])("checks the running-workspace quota before manual recovery from %s", async state => {
    await pool.query("UPDATE cloud_workspaces SET status=$2::text::cloud_workspace_status,desired_state=$2::text::cloud_workspace_desired_state WHERE id=$1", [fixture.workspaceId, state]);
    await pool.query("UPDATE cloud_workspace_quotas SET max_running_workspaces=1 WHERE org_id=$1", [fixture.organizationId]);
    const otherId = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspaces(id,org_id,team_id,created_by,display_name,repository_forge,repository_owner,repository_name,repository_revision,repository_id,owner_user_id,assignee_user_id,status,desired_state)
        SELECT $2,org_id,team_id,created_by,'quota fixture',repository_forge,repository_owner,repository_name,repository_revision,repository_id,owner_user_id,assignee_user_id,'ready','running' FROM cloud_workspaces WHERE id=$1`, [fixture.workspaceId, otherId]);
      await tx.query(`INSERT INTO cloud_workspace_generations(workspace_id,generation,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,created_by,provider_connection_id)
        SELECT $2,1,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,created_by,provider_connection_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`, [fixture.workspaceId, otherId]);
      await tx.query(`INSERT INTO cloud_workspace_members(workspace_id,org_id,user_id,role) SELECT $2,org_id,owner_user_id,'owner' FROM cloud_workspaces WHERE id=$1`, [fixture.workspaceId, otherId]);
      await tx.query(`INSERT INTO workspace_billing_epochs(workspace_id,billing_epoch,org_id,billing_owner_user_id,entitlement_scope,entitlement_plan,entitlement_revision,created_by)
        SELECT $2,1,org_id,billing_owner_user_id,entitlement_scope,entitlement_plan,entitlement_revision,created_by FROM workspace_billing_epochs WHERE workspace_id=$1 AND billing_epoch=1`, [fixture.workspaceId, otherId]);
    });
    const response = await route("/generations", { operation: "recover", sourceGeneration: 1, checkpointId });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "cloud_quota_exceeded" });
    expect((await pool.query("SELECT desired_state,current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0]).toEqual({ desired_state: state, current_generation: 1 });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].n).toBe(1);
  });
  it("does not reserve a second running-workspace slot for automatic recovery", async () => {
    await pool.query("UPDATE cloud_workspace_quotas SET max_running_workspaces=1 WHERE org_id=$1", [fixture.organizationId]);
    const subject = await exhaust(); await drain(); await subject.runOnce();
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("provisioning");
  });
  it("keeps raw provider incident identity system-only behind the authorized workspace document", async () => {
    await exhaust();
    expect((await withUserTx(pool, fixture.userId, tx => tx.query("SELECT id FROM cloud_workspace_restore_incidents"))).rowCount).toBe(0);
    const response = await route();
    expect(response.status).toBe(200);
    expect((await response.text())).not.toContain(`sandbox-${fixture.workspaceId}`);
  });
  it("recovers into the currently qualified organization image and preserves its accepted replay", async () => {
    await exhaust("setup_provider_bootstrap_unavailable");
    const { DatabaseCloudComputerService } = await import("./computer.js");
    const { cloudWorkspaceProvisioningProfile } = await import("./provisioning-profile.js");
    const computer = new DatabaseCloudComputerService(pool, recoveryConfig);
    await computer.save(fixture.organizationId, fixture.userId, { expectedRevision: 0, operationId: randomUUID(), sources: [],
      document: { repositories: [], installScript: "true", timeoutSeconds: 30 } });
    const id = randomUUID(), name = `zeros-org-${id.replaceAll("-", "")}`, imageRef = `boat:${name}@sha256:${"b".repeat(64)}`;
    await pool.query(`INSERT INTO cloud_computer_builds(id,org_id,profile_id,version,requested_by,repository_owner,repository_name)
      SELECT $1,org_id,profile_id,1,$3,'','' FROM cloud_computers WHERE org_id=$2`, [id, fixture.organizationId, fixture.userId]);
    await pool.query(`INSERT INTO cloud_computer_images(id,org_id,account_scope,snapshot_name,snapshot_id,image_ref,base_image_ref,base_source_commit,
      recipe_sha256,build_sha256,source_contract,image_contract,profile,state,attested_at,attestation_sha256)
      VALUES($1,$2,'fixture',$3,'snapshot-fixture',$4,$5,$6,$7,$7,$7,$7,$8,'attested',now(),$7)`,
      [id, fixture.organizationId, name, imageRef, recoveryConfig.imageRef, recoveryConfig.sourceCommit, "b".repeat(64), cloudWorkspaceProvisioningProfile(recoveryConfig, "boat")]);
    await pool.query("UPDATE cloud_computer_builds SET state='succeeded',completed_at=now() WHERE id=$1", [id]);
    for (const ref of [recoveryConfig.imageRef, imageRef]) await pool.query(`INSERT INTO cloud_agent_runtime_qualifications
      (provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled,qualified_at)
      VALUES('boat',$1,$2,'codex-api-key','zeros-cloud-worker-v3',true,clock_timestamp())`, [ref, "c".repeat(64)]);
    await computer.activate(fixture.organizationId, fixture.userId, 1, 1, id);
    await pool.query("UPDATE cloud_agent_runtime_qualifications SET enabled=false WHERE image_ref=$1", [imageRef]);
    const body = { operation: "recover", sourceGeneration: 1, checkpointId };
    const blocked = await route("/generations", body);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ code: "cloud_computer_qualification_required" });
    await pool.query("UPDATE cloud_agent_runtime_qualifications SET enabled=true WHERE image_ref=$1", [imageRef]);
    const key = randomUUID(), accepted = await route("/generations", body, key);
    expect(accepted.status, JSON.stringify(await accepted.json())).toBe(202);
    expect((await pool.query("SELECT image_ref,computer_image_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId])).rows[0])
      .toEqual({ image_ref: imageRef, computer_image_id: id });
    expect((await route("/generations", body, key)).status).toBe(200);
  });
  it("keeps an explicitly recovered source quarantined after its replacement is cancelled", async () => {
    await pool.query("UPDATE workspace_checkpoint_requests SET reason='manual',idle_engine_instance_id=NULL WHERE workspace_id=$1", [fixture.workspaceId]);
    await exhaust("setup_provider_bootstrap_unavailable");
    expect((await route("/generations", { operation: "recover", sourceGeneration: 1, checkpointId, allowDataLoss: true })).status).toBe(202);
    expect((await route("/stop")).status).toBe(202);
    const wake = await route("/wake");
    expect(wake.status).toBe(409);
    expect(await wake.json()).toEqual({ code: "recovery_needed" });
  });
  it("recovers a transient mismatch in the same generation without a replacement", async () => {
    await worker("setup_immutable_inventory_invalid").runOnce();
    await pool.query("UPDATE cloud_workspace_setup_runs SET next_attempt_at=now() WHERE id=$1", [setupRunId]);
    await new CloudWorkspaceSetupWorker({ pool, recoveryConfig, intervalMs: 1000, maxClaims: 2, sanitizeLog: value => value, executor: { execute: ready } }).runOnce();
    expect((await pool.query("SELECT status,current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ status: "ready", current_generation: 1 });
    expect((await pool.query("SELECT state FROM cloud_workspace_restore_incidents WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("cancelled");
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].n).toBe(1);
    await pool.query("UPDATE cloud_workspace_restore_incidents SET updated_at=now()-interval '31 days' WHERE workspace_id=$1", [fixture.workspaceId]);
    await worker("setup_immutable_inventory_invalid").runOnce();
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_restore_incidents WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].n).toBe(0);
  });
  it("publishes qualified candidate readiness, then prevents a second automatic replacement within an hour", async () => {
    const subject = await exhaust(); await drain(); await subject.runOnce();
    expect((await pool.query("SELECT retired_at FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1", [fixture.workspaceId])).rows[0].retired_at).toBeNull();
    let resource: CloudProviderResource | null = null;
    const provider: CloudWorkspaceProvider = { name: "boat", async find() { return resource ? [resource] : []; }, async inspect() { return resource; },
      async create() { resource = { workspaceId: fixture.workspaceId, generation: 2, resourceId: `candidate-${fixture.workspaceId}`, state: "running", target: null, metadata: {} }; return resource; },
      async start() { throw new Error("unused"); }, async stop() { throw new Error("source is already stopped"); },
      async archive() { throw new Error("unused"); }, async delete() {}, async *listManaged() {} };
    await new CloudWorkspaceReconciler({ pool, provider, intervalMs: 1000 }).runOnce();
    expect((await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].status).toBe("setting_up");
    await new CloudWorkspaceSetupWorker({ pool, recoveryConfig, intervalMs: 1000, sanitizeLog: value => value, executor: { execute: ready } }).runOnce();
    expect((await pool.query("SELECT status,current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0])
      .toEqual({ status: "ready", current_generation: 2 });
    expect((await pool.query("SELECT state FROM cloud_workspace_restore_incidents WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("succeeded");
    expect((await (await route()).json()).workspace.recovery.state).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND generation=1 AND operation='delete' AND state='queued'", [fixture.workspaceId])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT integrity_sha256 FROM workspace_checkpoints WHERE id=$1", [checkpointId])).rows[0].integrity_sha256)
      .toEqual(createHash("sha256").update("{}").digest());
    // A later cold wake in the now-healthy replacement has its own final
    // checkpoint and setup identity. It still shares the workspace's budget.
    const scope = { ...admittedEngine!, workspaceId: fixture.workspaceId, organizationId: fixture.organizationId };
    await pool.query("UPDATE cloud_workspace_engine_instances SET created_at=now()-interval '11 minutes' WHERE id=$1", [scope.engineInstanceId]);
    const manifest = await blobs.put({ ...scope, bytes: Buffer.from("{}") });
    const changedFile = await blobs.put({ ...scope, bytes: Buffer.from("next") });
    const changed = await content.append({ ...scope, expectedRevision: 1, idempotencyKey: randomUUID(), gitBaseCommit: "a".repeat(40), gitHeadRef: null,
      mutations: [{ path: "file.txt", operation: "upsert", entryType: "file", mode: 33188, blobId: changedFile.id, contentSha256: changedFile.plaintextSha256, sizeBytes: 4 }] });
    const directive = (await new DatabaseCloudIdleStop(pool, false).request(scope, randomUUID()))!;
    await content.commitCheckpoint({ ...scope, requestId: directive.id, idempotencyKey: randomUUID(), contentRevision: changed.revision,
      reason: "before_stop", manifestBlobId: manifest.id, artifactBlobId: null, inclusionPolicy: {}, fileCount: 1, totalBytes: 4, integritySha256: manifest.plaintextSha256 });
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE workspace_id=$1 AND generation=2 AND operation='stop'", [fixture.workspaceId]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [scope.engineInstanceId]);
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    const wake = await route("/wake");
    expect(wake.status).toBe(202);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=now() WHERE id=$1", [(await wake.json()).intent.id]);
    await pool.query("UPDATE cloud_workspaces SET status='setting_up' WHERE id=$1", [fixture.workspaceId]);
    setupRunId = (await pool.query("INSERT INTO cloud_workspace_setup_runs(workspace_id,generation,org_id,attempt,state) VALUES($1,2,$2,2,'queued') RETURNING id", [fixture.workspaceId, fixture.organizationId])).rows[0].id;
    await exhaust();
    expect((await pool.query("SELECT state,reason FROM cloud_workspace_restore_incidents WHERE workspace_id=$1 AND source_generation=2", [fixture.workspaceId])).rows[0])
      .toEqual({ state: "recovery_needed", reason: "automatic_recovery_rate_limited" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].n).toBe(2);
  });
});
