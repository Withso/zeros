import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { manageCloudOwnerCheckpointRecovery } from "../manage-cloud-owner-checkpoint-recovery.js";
import { ownerRecoveryConfig, seedOwnerCheckpointRecovery } from "./owner-checkpoint-recovery-test-fixtures.js";
import { seedFinalSave, seedFinalSaveEngine } from "./final-save-test-fixtures.js";
import { completeCloudWorkspaceGenerationTransition, rollbackCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { ownerRecoveryTarget } from "../cloud-owner-checkpoint-recovery-contract.js";
import { ensureCloudPilotUser, withCloudFixtureOwnerTx } from "./test-fixtures.js";
import { requestManagedComputeStop } from "./compute-credit-stop.js";
import { runFinalSaveRecovery } from "./final-save-service.js";
import { scheduleFinalSaveRecovery } from "./final-save-recovery.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { DatabaseCloudWorkspaceHealthService } from "./health.js";
import { DatabaseCloudWorkspaceDurableRecordService } from "./durable-record.js";
import type { CloudProviderResource, CloudWorkspaceProvider } from "./provider.js";
import { seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { seedComputerTemplate, computerTestAccount, computerTestWallet } from "./computer-workspace-test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("never-started owner recovery candidate cleanup", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });

  type RecordChange = "createdAt" | "branch" | "canonicalId" | "missingCreatedAt" | "otherMetadata" | "tombstone" | "extraEvent" | "afterFailure";
  async function failedCandidate(options: { localV1?: boolean; setupSucceeded?: boolean; recordChange?: RecordChange } = {}) {
    const records = new DatabaseCloudWorkspaceDurableRecordService({ pool, workosEnabled: false });
    let metadata: Record<string, unknown> = {};
    const source = await seedOwnerCheckpointRecovery(pool, { beforeCheckpoint: options.recordChange ? async f => {
      metadata = { version: 1, canonicalId: f.scope.workspaceId, organizationId: f.scope.organizationId,
        branch: "fixture", baseBranch: "main", status: "in-progress", viewMode: "code",
        prNumber: null, prState: null, prUrl: null, createdAt: Date.now() - 60_000 };
      await records.append({ ...f.scope, expectedRevision: 0, idempotencyKey: randomUUID(), mutations: [{
        entityKind: "metadata", entityId: "primary-workspace-v1", operation: "upsert", schemaVersion: 1,
        document: metadata, occurredAt: new Date().toISOString(),
      }] });
    } : undefined });
    const config = { databaseUrl: process.env.TEST_DATABASE_URL!, config: ownerRecoveryConfig, workosEnabled: false };
    const plan = await manageCloudOwnerCheckpointRecovery(pool, source.requestInput, config);
    const accepted = await manageCloudOwnerCheckpointRecovery(pool, source.requestInput, { ...config, execute: true, approval: plan.approval });
    const generation = accepted.candidateGeneration;
    const resourceId = "bx_new23456", leaseId = randomUUID();
    await pool.query(`UPDATE cloud_workspace_provider_bindings SET provider_resource_id=$3,observed_state='running',last_observed_at=clock_timestamp()
      WHERE workspace_id=$1 AND generation=$2`, [source.scope.workspaceId, generation, resourceId]);
    // The provider observer publishes setting_up before the candidate's
    // registration/initial durable-record synchronization can run.
    expect((await pool.query(`UPDATE cloud_workspaces SET status='setting_up'
      WHERE id=$1 AND current_generation=$2 AND desired_state='running' RETURNING id`, [source.scope.workspaceId, generation])).rowCount).toBe(1);
    await pool.query("UPDATE cloud_workspace_generation_transitions SET state='setting_up' WHERE id=$1", [accepted.transitionId]);
    const candidate = await withSystemTx(pool, tx => seedFinalSaveEngine(tx, { ...source.fixture, generation }));
    await pool.query(`UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=$2,final_save_version=1
      WHERE id=$1`, [candidate.engineInstanceId, options.localV1 === false ? null : 1]);
    if (options.recordChange) {
      const document: Record<string, unknown> = { ...metadata, createdAt: Date.now() };
      if (options.recordChange === "branch") document.branch = "new-user-work";
      if (options.recordChange === "canonicalId") document.canonicalId = randomUUID();
      if (options.recordChange === "missingCreatedAt") delete document.createdAt;
      await records.append({ ...candidate, expectedRevision: 1, idempotencyKey: randomUUID(), mutations: [{
        entityKind: "metadata", entityId: options.recordChange === "otherMetadata" ? "another-record" : "primary-workspace-v1",
        operation: options.recordChange === "tombstone" ? "tombstone" : "upsert", schemaVersion: 1,
        ...(options.recordChange === "tombstone" ? {} : { document }), occurredAt: new Date().toISOString(),
      }, ...(options.recordChange === "extraEvent" ? [{ entityKind: "metadata" as const, entityId: "additional-user-work",
        operation: "upsert" as const, schemaVersion: 1, document: { changed: true }, occurredAt: new Date().toISOString() }] : [])] });
    }
    await pool.query(`UPDATE cloud_workspace_setup_runs SET state=$3,completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,
      error_code=$4 WHERE workspace_id=$1 AND generation=$2`,
    [source.scope.workspaceId, generation, options.setupSucceeded ? "succeeded" : "failed", options.setupSucceeded ? null : "setup_checkpoint_restore_invalid"]);
    const provision = (await pool.query(`SELECT provision_intent_id FROM cloud_workspace_generation_transitions WHERE id=$1`, [accepted.transitionId])).rows[0];
    await pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state='succeeded',completed_at=clock_timestamp() WHERE id=$1`, [provision.provision_intent_id]);
    await pool.query(`INSERT INTO managed_compute_allocation_leases
      (id,workspace_id,org_id,generation,billing_epoch,user_id,lifecycle_intent_id,provider,provider_resource_id,
       policy_id,seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,state,funded_until,provider_expires_at)
      VALUES($1,$2,$3,$4,1,$5,$6,'boat',$7,'fixture',1000,1,1,600,'active',now()+interval '10 minutes',now()+interval '9 minutes')`,
    [leaseId, candidate.workspaceId, candidate.organizationId, generation, source.fixture.userId, provision.provision_intent_id, resourceId]);
    expect(await withSystemTx(pool, tx => rollbackCloudWorkspaceGenerationTransition(tx, {
      workspaceId: candidate.workspaceId, organizationId: candidate.organizationId, candidateGeneration: generation,
      errorCode: "setup_checkpoint_restore_invalid", errorMessage: "Synthetic missing replacement history custody",
    }))).toBe(true);
    if (options.recordChange === "afterFailure") {
      // Keep the immutable record as produced and move only this synthetic
      // setup failure earlier, so the batch is outside its allowed lifetime.
      await pool.query(`UPDATE cloud_workspace_setup_runs SET completed_at=(SELECT min(created_at)-interval '1 millisecond'
        FROM workspace_record_batches WHERE workspace_id=$1 AND generation=$2) WHERE workspace_id=$1 AND generation=$2`,
      [candidate.workspaceId, generation]);
    }
    // Independent compute retirement follows the failed setup, exactly as it
    // does in the incident. It owns a separate non-workspace-affecting Stop.
    await requestManagedComputeStop(pool, { leaseId, reason: "engine_unavailable", force: true });
    const intents = (await pool.query<{ id: string; operation: string }>(`SELECT id,operation FROM cloud_workspace_lifecycle_intents
      WHERE workspace_id=$1 AND generation=$2 AND operation IN ('stop','delete') ORDER BY operation::text`, [candidate.workspaceId, generation])).rows;
    expect(intents.map(row => row.operation)).toEqual(["delete", "stop"]);
    await pool.query(`UPDATE cloud_workspace_final_save_recoveries SET state='blocked',
      failure_started_at=coalesce(failure_started_at,clock_timestamp()),first_failure=coalesce(first_failure,'custody'),
      last_failure='custody',next_attempt_at=clock_timestamp()-interval '1 second'
      WHERE lifecycle_intent_id=ANY($1::uuid[])`, [intents.map(row => row.id)]);
    const rows = () => pool.query(`SELECT lifecycle_intent_id,state,checkpoint_id,proven_request_id,
      cloud_final_save_proven(lifecycle_intent_id) AS proven FROM cloud_workspace_final_save_recoveries
      WHERE lifecycle_intent_id=ANY($1::uuid[]) ORDER BY lifecycle_intent_id`, [intents.map(row => row.id)]);
    return { source, candidate, transitionId: accepted.transitionId!, generation, resourceId, leaseId, intents, rows };
  }

  it("retires both blocked candidate captures without inventing saved proof or touching the source", async () => {
    const f = await failedCandidate();
    const original = await f.source.row();
    const point = (await pool.query("SELECT * FROM workspace_checkpoints WHERE id=$1", [f.source.checkpointId])).rows[0];
    expect(await runFinalSaveRecovery(pool, f.candidate.workspaceId, false)).toBe(2);
    expect((await f.rows()).rows).toEqual(f.intents.map(({ id }) => ({ lifecycle_intent_id: id, state: "not_required",
      checkpoint_id: null, proven_request_id: null, proven: false })).sort((a, b) => a.lifecycle_intent_id.localeCompare(b.lifecycle_intent_id)));
    expect(await f.source.row()).toEqual(original);
    expect((await pool.query("SELECT * FROM workspace_checkpoints WHERE id=$1", [f.source.checkpointId])).rows[0]).toEqual(point);
    expect(await runFinalSaveRecovery(pool, f.candidate.workspaceId, false)).toBe(0);
  });

  it("lets the ordinary reconciler retire only that allocation and clears the candidate health blockers", async () => {
    const f = await failedCandidate();
    await runFinalSaveRecovery(pool, f.candidate.workspaceId, false);
    // Independent metering must still settle before DELETE; this test starts
    // at that existing consumer boundary and does not bypass it in product.
    await pool.query("UPDATE managed_compute_allocation_leases SET state='settled',settled_at=clock_timestamp() WHERE id=$1", [f.leaseId]);
    let resource: CloudProviderResource | null = { resourceId: f.resourceId, state: "running", target: "test-region",
      workspaceId: f.candidate.workspaceId, generation: f.generation, organizationId: f.candidate.organizationId, metadata: {} };
    const provider = { name: "boat", find: vi.fn(async () => resource ? [resource] : []), inspect: vi.fn(async () => resource),
      stop: vi.fn(async () => { resource = resource ? { ...resource, state: "stopped" } : null; return resource; }),
      delete: vi.fn(async () => { resource = null; }), verifyAbsence: vi.fn(async () => true),
      verifyManagedResourceOwnership: vi.fn(async () => true), create: vi.fn(), start: vi.fn(), archive: vi.fn(),
    } as unknown as CloudWorkspaceProvider;
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const worker = new CloudWorkspaceReconciler({ pool, provider, workerId: "candidate-cleanup", logger });
    for (let i = 0; i < 3; i++) await worker.runOnce(f.candidate.workspaceId);
    expect((await pool.query(`SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=ANY($1::uuid[])`, [f.intents.map(row => row.id)])).rows)
      .toEqual([{ state: "succeeded" }, { state: "succeeded" }]);
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.start).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    const reasons = (await new DatabaseCloudWorkspaceHealthService(pool, { backgroundWorkersEnabled: false,
      setupExecutionEnabled: true, durabilityEnabled: true, outboxDeliveryEnabled: true }).read()).reasons;
    expect(reasons).not.toContain("final_save_blocked");
    expect(reasons).not.toContain("final_save_worker_stalled");
    expect(reasons).not.toContain("lifecycle_stalled");
  });

  it("admits only the restored primary metadata createdAt normalization before failed history startup", async () => {
    const f = await failedCandidate({ recordChange: "createdAt" });
    const before = (await pool.query(`SELECT batch.*,event.document FROM workspace_record_batches batch
      JOIN workspace_record_events event ON event.batch_id=batch.id WHERE batch.workspace_id=$1 AND batch.generation=$2`,
    [f.candidate.workspaceId, f.generation])).rows;
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ first_revision: "2", last_revision: "2", event_count: 1, engine_instance_id: f.candidate.engineInstanceId });
    expect(await runFinalSaveRecovery(pool, f.candidate.workspaceId, false)).toBe(2);
    expect((await f.rows()).rows.every(row => row.state === "not_required" && !row.proven)).toBe(true);
    expect((await pool.query(`SELECT batch.*,event.document FROM workspace_record_batches batch
      JOIN workspace_record_events event ON event.batch_id=batch.id WHERE batch.workspace_id=$1 AND batch.generation=$2`,
    [f.candidate.workspaceId, f.generation])).rows).toEqual(before);
    expect((await pool.query("SELECT record_batch_id FROM cloud_workspace_unstarted_candidate_cleanup ORDER BY lifecycle_intent_id")).rows)
      .toEqual([{ record_batch_id: before[0].id }, { record_batch_id: before[0].id }]);
    await expect(pool.query(`INSERT INTO workspace_record_events
      (workspace_id,org_id,revision,batch_id,entity_kind,entity_id,operation,schema_version,document,occurred_at)
      VALUES($1,$2,3,$3,'metadata','late-user-work','upsert',1,'{"new":true}',clock_timestamp())`,
    [f.candidate.workspaceId, f.candidate.organizationId, before[0].id])).rejects.toMatchObject({ code: "40001" });
  });

  it.each<RecordChange>(["branch", "canonicalId", "missingCreatedAt", "otherMetadata", "tombstone", "extraEvent", "afterFailure"])(
    "refuses candidate records with %s instead of calling them restored metadata", async recordChange => {
      const f = await failedCandidate({ recordChange });
      await runFinalSaveRecovery(pool, f.candidate.workspaceId, false);
      expect(await countReceipts()).toBe(0);
      for (const intent of f.intents) await expect(claim(intent.id)).rejects.toMatchObject({ code: "40001" });
    });

  it.each([{ localV1: false }, { setupSucceeded: true }])("refuses a candidate without positive never-started evidence %j", async options => {
    const f = await failedCandidate(options);
    await runFinalSaveRecovery(pool, f.candidate.workspaceId, false);
    expect((await f.rows()).rows.every(row => row.state === "blocked" && !row.proven)).toBe(true);
    for (const intent of f.intents) await expect(pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',
      lease_owner='old-worker',lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1`, [intent.id])).rejects.toMatchObject({ code: "40001" });
  });

  it("keeps an unrelated workspace's ordinary unsaved Stop blocked", async () => {
    const f = await failedCandidate(), other = await seedFinalSave(pool);
    await runFinalSaveRecovery(pool, f.candidate.workspaceId, false);
    await expect(pool.query(`UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',lease_owner='other',
      lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1`, [other.intentId])).rejects.toMatchObject({ code: "40001" });
    expect((await other.row()).state).toBe("capturing");
  });

  type Fixture = Awaited<ReturnType<typeof failedCandidate>>;
  const countReceipts = async () => (await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_unstarted_candidate_cleanup")).rows[0].n;
  const claim = (id: string) => withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='dispatching',
    attempt_count=attempt_count+1,dispatched_at=clock_timestamp(),lease_owner='held-provider',
    lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1 RETURNING id`, [id]));
  const mutations: [string, (f: Fixture) => Promise<unknown>][] = [
    ["native custody", f => pool.query("UPDATE cloud_workspace_final_save_recoveries SET custody_id=$2 WHERE lifecycle_intent_id=ANY($1::uuid[])", [f.intents.map(row => row.id), randomUUID()])],
    ["a delivered capture", f => pool.query(`UPDATE workspace_checkpoint_requests SET delivery_count=1,last_delivered_at=clock_timestamp()
      WHERE workspace_id=$1 AND generation=$2`, [f.candidate.workspaceId, f.generation])],
    ["current generation", f => pool.query("UPDATE cloud_workspaces SET current_generation=$2 WHERE id=$1", [f.candidate.workspaceId, f.generation])],
    ["a changed provider binding", f => pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id='bx_changed9' WHERE workspace_id=$1 AND generation=$2", [f.candidate.workspaceId, f.generation])],
    ["a different enrolled incarnation", f => withSystemTx(pool, tx => seedFinalSaveEngine(tx, { ...f.source.fixture, generation: f.generation, setupAttempt: 2 }))],
    ["an invalidated checkpoint", f => pool.query("UPDATE workspace_checkpoints SET state='invalid',invalidated_at=clock_timestamp() WHERE id=$1", [f.source.checkpointId])],
  ];
  it.each(mutations)("refuses %s instead of interpreting absent history as permission", async (_name, mutate) => {
    const f = await failedCandidate();
    await mutate(f);
    await runFinalSaveRecovery(pool, f.candidate.workspaceId, false);
    expect(await countReceipts()).toBe(0);
    for (const intent of f.intents) await expect(claim(intent.id)).rejects.toMatchObject({ code: "40001" });
  });

  it("holds the retired incarnation before dispatch and after a worker loses its claim", async () => {
    const f = await failedCandidate();
    await runFinalSaveRecovery(pool, f.candidate.workspaceId, false);
    for (const [name, mutate] of mutations.filter(([name]) => ["current generation", "a changed provider binding", "a different enrolled incarnation"].includes(name))) {
      await expect(mutate(f), name).rejects.toMatchObject({ code: "40001" });
    }
    const intent = f.intents[0]!;
    expect((await claim(intent.id)).rowCount).toBe(1);
    await pool.query("UPDATE cloud_workspace_lifecycle_intents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [intent.id]);
    await expect(pool.query("UPDATE managed_compute_allocation_leases SET provider_resource_id='bx_changed9' WHERE id=$1", [f.leaseId])).rejects.toMatchObject({ code: "40001" });
    expect((await pool.query("SELECT settled_at FROM cloud_workspace_final_save_dispatches WHERE lifecycle_intent_id=$1", [intent.id])).rows)
      .toEqual([{ settled_at: null }]);
  });

  it("does not require both recovery deadlines to become due in the same batch", async () => {
    const f = await failedCandidate(), stop = f.intents.find(row => row.operation === "stop")!, deletion = f.intents.find(row => row.operation === "delete")!;
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE lifecycle_intent_id=$1", [deletion.id]);
    expect(await runFinalSaveRecovery(pool, f.candidate.workspaceId, false)).toBe(1);
    await claim(stop.id);
    await pool.query("UPDATE cloud_workspace_final_save_recoveries SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE lifecycle_intent_id=$1", [deletion.id]);
    expect(await runFinalSaveRecovery(pool, f.candidate.workspaceId, false)).toBe(1);
    expect((await f.rows()).rows.every(row => row.state === "not_required" && !row.proven)).toBe(true);
    expect(await countReceipts()).toBe(2);
  });

  it("keeps old retry/expiry writes terminal and refuses late capture delivery", async () => {
    const f = await failedCandidate();
    await runFinalSaveRecovery(pool, f.candidate.workspaceId, false);
    const before = (await pool.query("SELECT * FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=ANY($1::uuid[]) ORDER BY lifecycle_intent_id", [f.intents.map(row => row.id)])).rows;
    const stop = f.intents.find(row => row.operation === "stop")!;
    const attempt = (await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE lifecycle_intent_id=$1", [stop.id])).rows[0];
    for (const intent of f.intents) {
      await withSystemTx(pool, tx => scheduleFinalSaveRecovery(tx, { intentId: intent.id, failure: "authority", blocked: true }));
      await pool.query(`UPDATE cloud_workspace_final_save_recoveries SET state='blocked',next_attempt_at=clock_timestamp(),
        last_failure='authority',retry_count=retry_count+1 WHERE lifecycle_intent_id=$1`, [intent.id]);
    }
    await pool.query("UPDATE workspace_checkpoint_requests SET error_code='late-worker-error' WHERE id=$1", [attempt.id]);
    expect((await pool.query("SELECT * FROM workspace_checkpoint_requests WHERE id=$1", [attempt.id])).rows[0]).toEqual(attempt);
    await expect(pool.query("UPDATE workspace_checkpoint_requests SET state='delivered',completed_at=NULL WHERE id=$1", [attempt.id])).rejects.toThrow();
    expect((await pool.query("SELECT * FROM cloud_workspace_final_save_recoveries WHERE lifecycle_intent_id=ANY($1::uuid[]) ORDER BY lifecycle_intent_id", [f.intents.map(row => row.id)])).rows).toEqual(before);
    expect(await runFinalSaveRecovery(pool, f.candidate.workspaceId, false)).toBe(0);
  });

  it("requires atomic retirement and prevents unreceipted not-required state", async () => {
    const f = await failedCandidate(), intent = f.intents[0]!;
    await expect(pool.query("UPDATE cloud_workspace_final_save_recoveries SET state='not_required' WHERE lifecycle_intent_id=$1", [intent.id])).rejects.toMatchObject({ code: "23514" });
    await expect(withSystemTx(pool, tx => tx.query("INSERT INTO cloud_workspace_unstarted_candidate_cleanup SELECT * FROM cloud_unstarted_candidate_source($1)", [intent.id]))).rejects.toMatchObject({ code: "23514" });
    expect(await countReceipts()).toBe(0);
  });

  it("keeps receipts append-only and hidden from owner-context reads", async () => {
    const f = await failedCandidate();
    await runFinalSaveRecovery(pool, f.candidate.workspaceId, false);
    await expect(pool.query("UPDATE cloud_workspace_unstarted_candidate_cleanup SET checkpoint_id=$1", [randomUUID()])).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("DELETE FROM cloud_workspace_unstarted_candidate_cleanup")).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("TRUNCATE cloud_workspace_unstarted_candidate_cleanup")).rejects.toMatchObject({ code: "55000" });
    await withUserTx(pool, f.source.fixture.userId, async tx => {
      expect((await tx.query("SELECT * FROM cloud_workspace_unstarted_candidate_cleanup")).rows).toEqual([]);
      expect((await tx.query("SELECT cloud_final_save_dispatchable($1) AS allowed", [f.intents[0]!.id])).rows).toEqual([{ allowed: false }]);
    });
    const functions = (await pool.query(`SELECT p.proname,p.prosecdef,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
        AND p.proname LIKE '%unstarted_candidate%'`)).rows;
    expect(functions).toHaveLength(7);
    expect(functions.every(row => !row.prosecdef && !row.public_execute)).toBe(true);
  });

  it("retains the earlier setup fence against reappearing engine authority", async () => {
    const f = await failedCandidate();
    await expect(pool.query("UPDATE cloud_workspace_engine_instances SET state='ready',revoked_at=NULL WHERE id=$1", [f.candidate.engineInstanceId]))
      .rejects.toMatchObject({ code: "23514" });
    await runFinalSaveRecovery(pool, f.candidate.workspaceId, false);
    await expect(pool.query(`UPDATE cloud_workspace_setup_runs SET state='running',completed_at=NULL,lease_owner='late-setup',
      lease_expires_at=clock_timestamp()+interval '1 minute' WHERE workspace_id=$1 AND generation=$2`, [f.candidate.workspaceId, f.generation]))
      .rejects.toMatchObject({ code: "40001" });
  });

  const reserveWriter = (f: Fixture) => pool.query(`INSERT INTO cloud_workspace_local_command_writers
    (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
    SELECT workspace_id,org_id,generation,id,runtime_boot_id,gen_random_uuid(),account_user_id,1
    FROM cloud_workspace_engine_instances WHERE id=$1`, [f.candidate.engineInstanceId]);

  it("refuses even an unactivated writer reservation before cleanup and fences late reservations", async () => {
    const f = await failedCandidate();
    await reserveWriter(f);
    await runFinalSaveRecovery(pool, f.candidate.workspaceId, false);
    expect(await countReceipts()).toBe(0);
    for (const intent of f.intents) await expect(claim(intent.id)).rejects.toMatchObject({ code: "40001" });
  });

  it("serializes a late writer with receipt admission at the original workspace lock", async () => {
    const f = await failedCandidate();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<void>(resolve => { entered = resolve; });
    const transaction = withSystemTx(pool, async tx => {
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [f.candidate.organizationId]);
      await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE", [f.candidate.workspaceId]);
      for (const intent of f.intents) expect((await tx.query("SELECT adopt_cloud_unstarted_candidate_cleanup($1) AS adopted", [intent.id])).rows[0].adopted).toBe(true);
      entered(); await held;
    });
    try { await acquired; await expect(reserveWriter(f)).rejects.toMatchObject({ code: "55P03" }); }
    finally { release(); await transaction; }
    await expect(reserveWriter(f)).rejects.toMatchObject({ code: "40001" });
    expect(await countReceipts()).toBe(2);
  });

  it("revalidates checkpoint custody after provider inspection before any Stop or Delete", async () => {
    const f = await failedCandidate();
    await runFinalSaveRecovery(pool, f.candidate.workspaceId, false);
    await pool.query("UPDATE managed_compute_allocation_leases SET state='settled',settled_at=clock_timestamp() WHERE id=$1", [f.leaseId]);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), inspected = new Promise<void>(resolve => { entered = resolve; });
    const resource = { resourceId: f.resourceId, state: "running", target: "test-region", workspaceId: f.candidate.workspaceId,
      organizationId: f.candidate.organizationId, generation: f.generation, metadata: {} };
    const stop = vi.fn(), deletion = vi.fn();
    const provider = { name: "boat", find: async () => [resource], inspect: async () => { entered(); await held; return resource; },
      stop, delete: deletion } as unknown as CloudWorkspaceProvider;
    const worker = new CloudWorkspaceReconciler({ pool, provider, workerId: "candidate-held-inspection", logger: { error: vi.fn() } });
    const work = worker.runOnce(f.candidate.workspaceId);
    try {
      await inspected;
      await pool.query("UPDATE workspace_checkpoints SET state='invalid',invalidated_at=clock_timestamp() WHERE id=$1", [f.source.checkpointId]);
    } finally { release(); await work; }
    expect(stop).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
    expect((await pool.query("SELECT settled_at FROM cloud_workspace_final_save_dispatches WHERE workspace_id=$1", [f.candidate.workspaceId])).rows)
      .toEqual([{ settled_at: null }]);
  });

  async function retryCandidate(settled = true) {
    const f = await failedCandidate({ recordChange: "createdAt" });
    await runFinalSaveRecovery(pool, f.candidate.workspaceId, false);
    if (settled) {
      await pool.query("UPDATE managed_compute_allocation_leases SET state='settled',settled_at=clock_timestamp() WHERE id=$1", [f.leaseId]);
      const provider = { name: "boat", find: async () => [], inspect: async () => null,
        verifyAbsence: async () => true, verifyManagedResourceOwnership: async () => true,
        stop: vi.fn(), delete: vi.fn(), create: vi.fn(), start: vi.fn() } as unknown as CloudWorkspaceProvider;
      const worker = new CloudWorkspaceReconciler({ pool, provider, workerId: "retry-cleanup", logger: { error: vi.fn() } });
      for (let i=0;i<3;i++) await worker.runOnce(f.candidate.workspaceId);
      expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=ANY($1::uuid[])", [f.intents.map(row=>row.id)])).rows)
        .toEqual([{state:"succeeded"},{state:"succeeded"}]);
    }
    const computer = await withSystemTx(pool, async tx => {
      const runtime = await seedRuntimeBundle(tx, { digit: "3", releaseOrder: 3 });
      const installationId = (await tx.query("SELECT installation_id FROM cloud_computer_v2_config_repositories WHERE config_id=$1 LIMIT 1", [f.source.computer.configId])).rows[0].installation_id;
      const selected = await seedComputerTemplate(tx, { organizationId:f.candidate.organizationId,ownerUserId:f.source.fixture.userId,
        installationId,version:21,runtimeId:runtime.pin.runtimeId,sourceSandboxId:"bx_3456789a",repositories:f.source.computer.repositories });
      await tx.query("UPDATE cloud_computer_templates SET manifest_sha256=$2 WHERE build_id=$1", [selected.buildId,Buffer.alloc(32,21)]);
      await tx.query(`INSERT INTO cloud_computer_template_snapshots
        (build_id,org_id,channel,account_scope,billing_org,source_sandbox_id,snapshot_name,manifest_sha256,
         state,save_requested_at,snapshot_id,size_bytes,tree_sha256,verified_at,ready_at)
        VALUES($1,$2,'alpha',$3,$4,$5,'fixture-alpha-computer-v21',$6,'ready',now(),'fixture_snapshot_21',4096,$6,now(),now())`,
      [selected.buildId,f.candidate.organizationId,computerTestAccount,computerTestWallet,selected.sourceSandboxId,Buffer.alloc(32,21)]);
      await tx.query("UPDATE cloud_computer_templates SET named_snapshot_required=true WHERE build_id=$1", [selected.buildId]);
      return {...selected,runtimeId:runtime.pin.runtimeId};
    });
    const request = {...f.source.requestInput,operationId:randomUUID(),computerBuildId:computer.buildId,computerConfigId:computer.configId,runtimeId:computer.runtimeId,
      retry:{ownerDiscardReceiptId:f.source.requestInput.operationId,failedTransitionId:f.transitionId,
        failedCandidateGeneration:f.generation,cleanupStopIntentId:f.intents.find(row=>row.operation==="stop")!.id,
        cleanupDeleteIntentId:f.intents.find(row=>row.operation==="delete")!.id}};
    const options = {databaseUrl:process.env.TEST_DATABASE_URL!,config:ownerRecoveryConfig,workosEnabled:false};
    return {...f,request,options,computer};
  }

  it("owner retry explicitly plans and admits the next corrected runtime after exact candidate cleanup", async()=>{
    const f=await retryCandidate(), original=await f.source.row();
    const plan=await manageCloudOwnerCheckpointRecovery(pool,f.request,f.options);
    expect(plan).toMatchObject({state:"planned",candidateGeneration:f.generation+1,transitionId:null});
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1",[f.candidate.workspaceId])).rows[0].current_generation).toBe(1);
    const accepted=await manageCloudOwnerCheckpointRecovery(pool,f.request,{...f.options,execute:true,approval:plan.approval});
    expect(accepted).toMatchObject({state:"restoring",candidateGeneration:f.generation+1});
    expect(await manageCloudOwnerCheckpointRecovery(pool,f.request,{...f.options,execute:true,approval:plan.approval}))
      .toEqual({...accepted,state:"unchanged"});
    expect(await f.source.row()).toEqual(original);
    expect((await pool.query("SELECT runtime_id,recovery_checkpoint_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=$2",
      [f.candidate.workspaceId,accepted.candidateGeneration])).rows).toEqual([{runtime_id:f.computer.runtimeId,recovery_checkpoint_id:f.source.checkpointId}]);
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[f.source.intentId])).rows[0].state).toBe("superseded");
    await pool.query("UPDATE cloud_workspaces SET status='setting_up' WHERE id=$1",[f.candidate.workspaceId]);
    const target=await withSystemTx(pool,tx=>seedFinalSaveEngine(tx,{...f.source.fixture,generation:accepted.candidateGeneration}));
    await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1",[target.engineInstanceId]);
    expect((await pool.query("SELECT cloud_owner_discard_history_receipt($1) AS receipt",[target.engineInstanceId])).rows[0].receipt)
      .toBe(f.source.requestInput.operationId);
  });

  it("owner retry never allocates implicitly from the original receipt replay", async()=>{
    const f=await retryCandidate();
    const replay=await manageCloudOwnerCheckpointRecovery(pool,f.source.requestInput,f.options);
    expect(replay).toMatchObject({state:"unchanged",transitionId:f.transitionId,transitionState:"rollback_failed",candidateGeneration:f.generation});
    expect((await pool.query("SELECT max(generation) AS n FROM cloud_workspace_generations WHERE workspace_id=$1",[f.candidate.workspaceId])).rows[0].n).toBe(f.generation);
  });

  it("owner retry refuses before both exact cleanup intents settle", async()=>{
    const f=await retryCandidate(false);
    await expect(manageCloudOwnerCheckpointRecovery(pool,f.request,f.options)).rejects.toThrow();
    expect((await pool.query("SELECT max(generation) AS n FROM cloud_workspace_generations WHERE workspace_id=$1",[f.candidate.workspaceId])).rows[0].n).toBe(f.generation);
  });

  it.each(["target", "authority", "checkpoint", "runtime", "cleanup", "funding"] as const)(
    "owner retry refuses %s drift after the plan without allocating", async kind => {
      const f=await retryCandidate(), plan=await manageCloudOwnerCheckpointRecovery(pool,f.request,f.options);
      const request=structuredClone(f.request), options={...f.options,execute:true,approval:plan.approval};
      if(kind==="target") {
        const target=new URL(options.databaseUrl); target.hostname=target.hostname==="localhost"?"127.0.0.1":"localhost";
        options.databaseUrl=target.toString();
        expect(ownerRecoveryTarget(options.databaseUrl,request.channel)).not.toBe(ownerRecoveryTarget(f.options.databaseUrl,request.channel));
      }
      if(kind==="authority")await pool.query("UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1",[f.candidate.workspaceId]);
      if(kind==="checkpoint")await pool.query("UPDATE workspace_checkpoints SET state='invalid',invalidated_at=clock_timestamp() WHERE id=$1",[f.source.checkpointId]);
      if(kind==="runtime")request.runtimeId=f.source.requestInput.runtimeId;
      if(kind==="cleanup")request.retry.cleanupDeleteIntentId=randomUUID();
      if(kind==="funding") {
        const other=(await ensureCloudPilotUser(pool,{provider:"workos",providerSubject:`user_${randomUUID()}`,
          email:`retry-${randomUUID()}@example.test`,displayName:"Retry funding fixture"})).id;
        await withCloudFixtureOwnerTx(pool,async tx=>{
          await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",[f.candidate.organizationId,other]);
          await tx.query("INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES($1,$2,'active')",[f.candidate.organizationId,other]);
        });
        await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1",[f.candidate.workspaceId,other]);
        await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1",[f.candidate.workspaceId,f.source.fixture.userId]);
      }
      await expect(manageCloudOwnerCheckpointRecovery(pool,request,options)).rejects.toThrow();
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_recovery_retries")).rows[0].n).toBe(0);
      expect((await pool.query("SELECT max(generation) AS n FROM cloud_workspace_generations WHERE workspace_id=$1",[f.candidate.workspaceId])).rows[0].n).toBe(f.generation);
    });

  it("owner retry rolls back its receipt and pins if candidate creation fails",async()=>{
    const f=await retryCandidate(), original=await f.source.row();
    const plan=await manageCloudOwnerCheckpointRecovery(pool,f.request,f.options);
    await pool.query(`CREATE FUNCTION fixture_fail_retry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic candidate rejection' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER fixture_fail_retry BEFORE INSERT ON cloud_workspace_generations FOR EACH ROW EXECUTE FUNCTION fixture_fail_retry()`);
    await expect(manageCloudOwnerCheckpointRecovery(pool,f.request,{...f.options,execute:true,approval:plan.approval})).rejects.toMatchObject({code:"23514"});
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_recovery_retries")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT current_generation,desired_state FROM cloud_workspaces WHERE id=$1",[f.candidate.workspaceId])).rows[0])
      .toEqual({current_generation:1,desired_state:"stopped"});
    expect(await f.source.row()).toEqual(original);
  });

  it("owner retry remains immutable, system-only and exact across replay and another workspace",async()=>{
    const f=await retryCandidate(), other=await seedFinalSave(pool), before=await other.row();
    const plan=await manageCloudOwnerCheckpointRecovery(pool,f.request,f.options);
    const accepted=await manageCloudOwnerCheckpointRecovery(pool,f.request,{...f.options,execute:true,approval:plan.approval});
    await expect(pool.query("UPDATE cloud_workspace_owner_recovery_retries SET reason='Changed retry evidence'")).rejects.toMatchObject({code:"55000"});
    await expect(pool.query("DELETE FROM cloud_workspace_owner_recovery_retries")).rejects.toMatchObject({code:"55000"});
    await expect(pool.query("TRUNCATE cloud_workspace_owner_recovery_retries")).rejects.toMatchObject({code:"55000"});
    await withUserTx(pool,f.source.fixture.userId,async tx=>{
      expect((await tx.query("SELECT * FROM cloud_workspace_owner_recovery_retries")).rows).toEqual([]);
    });
    await expect(manageCloudOwnerCheckpointRecovery(pool,{...f.request,operationId:randomUUID()},f.options))
      .rejects.toMatchObject({code:"owner_recovery_replay_mismatch"});
    expect(await manageCloudOwnerCheckpointRecovery(pool,f.request,{...f.options,execute:true,approval:plan.approval}))
      .toEqual({...accepted,state:"unchanged"});
    expect(await other.row()).toEqual(before);
    expect((await pool.query("SELECT cloud_final_save_deletion_claimable($1,$2) AS allowed",[other.scope.workspaceId,other.scope.organizationId])).rows[0].allowed).toBe(false);
  });

  it.each(["complete","rollback"] as const)("owner retry %s retains the original discard and suppresses only lost-source N-1 cleanup",async mode=>{
    const f=await retryCandidate(), plan=await manageCloudOwnerCheckpointRecovery(pool,f.request,f.options);
    const accepted=await manageCloudOwnerCheckpointRecovery(pool,f.request,{...f.options,execute:true,approval:plan.approval});
    await withSystemTx(pool,tx=>mode==="complete"
      ? completeCloudWorkspaceGenerationTransition(tx,{...f.candidate,generation:accepted.candidateGeneration})
      : rollbackCloudWorkspaceGenerationTransition(tx,{...f.candidate,candidateGeneration:accepted.candidateGeneration,
        errorCode:"setup_failed",errorMessage:"Synthetic corrected candidate failure"}));
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE id=$1",[accepted.transitionId])).rows[0].state)
      .toBe(mode==="complete"?"succeeded":"rollback_failed");
    expect((await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,operation,idempotency_key,request_sha256,affects_workspace,generation_transition_id)
      VALUES($1::uuid,$2,$3,1,'delete',$1::text,digest($1::text,'sha256'),false,$4) RETURNING id`,
    [randomUUID(),f.candidate.workspaceId,f.candidate.organizationId,accepted.transitionId])).rows).toEqual([]);
    expect((await pool.query("SELECT cloud_final_save_proven($1) AS proven",[f.source.intentId])).rows[0].proven).toBe(false);
    expect((await pool.query("SELECT state FROM cloud_workspace_generation_transitions WHERE id=$1",[f.transitionId])).rows[0].state).toBe("rollback_failed");
  });

  it("owner retry runs the real CLI through an authenticated restricted migration-owner login",async()=>{
    const f=await retryCandidate(), directory=await mkdtemp(path.join(tmpdir(),"owner-retry-cli-"));
    const suffix=randomUUID().replaceAll("-",""), ownerRole=`w3_retry_owner_${suffix}`,loginRole=`w3_retry_login_${suffix}`;
    const password=randomUUID(), principal=(await pool.query("SELECT current_user AS name")).rows[0].name as string;
    await pool.query(`CREATE ROLE ${ownerRole} NOLOGIN; CREATE ROLE ${loginRole} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)};
      GRANT ${ownerRole} TO ${loginRole}; GRANT USAGE ON SCHEMA public TO ${ownerRole};
      GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ownerRole}; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${ownerRole};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ownerRole};
      ALTER TABLE cloud_workspace_owner_discard_receipts OWNER TO ${ownerRole};
      ALTER TABLE cloud_workspace_owner_recovery_retries OWNER TO ${ownerRole}`);
    try {
      const filename=path.join(directory,"request.json"),databaseUrl=new URL(process.env.TEST_DATABASE_URL!);
      databaseUrl.username=loginRole;databaseUrl.password=password;
      await writeFile(filename,JSON.stringify({...f.request,channel:"development"}),{mode:0o600});
      const env:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:"test",DATABASE_URL:databaseUrl.toString(),DATABASE_MIGRATION_ROLE:ownerRole,
        AUTH0_DOMAIN:"tenant.example.test",AUTH_AUDIENCE:"https://api.example.test",GITHUB_APP_ID:"123",GITHUB_APP_CLIENT_ID:"fixture-client",
        GITHUB_APP_CLIENT_SECRET:"fixture-secret",GITHUB_OAUTH_CALLBACK_URL:"https://api.example.test/v1/github/oauth/callback",
        GITHUB_APP_WEBHOOK_SECRET:"fixture-webhook",GITHUB_APP_SLUG:"fixture-app",
        GITHUB_APP_PRIVATE_KEY:generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString(),
        CLOUD_WORKSPACES_ENABLED:"true",CLOUD_WORKSPACE_PROVIDER:"boat",BOAT_API_KEY:"fixture-provider",
        BOAT_ACCOUNT_SCOPE:ownerRecoveryConfig.boat!.accountScope,BOAT_BILLING_ORG:ownerRecoveryConfig.boat!.billingOrg,
        BOAT_SNAPSHOT_ID:"fixture-immutable-v1",BOAT_IMAGE_BUILD_SHA256:"c".repeat(64),BOAT_TTL_SECONDS:"3600",
        BOAT_COMPUTE_POLICY_ID:"fixture-v1",BOAT_SECONDS_PER_DOLLAR:"100000",CLOUD_WORKSPACE_STORAGE_MIB:"40960",
        ZEROS_CLOUD_SOURCE_COMMIT:"a".repeat(40),CONTROL_PLANE_OWNER_RECOVERY_REQUEST_FILE:filename};
      const invoke=(execute=false,approval?:string)=>JSON.parse(execFileSync(process.execPath,
        ["--import","tsx",fileURLToPath(new URL("../manage-cloud-owner-checkpoint-recovery.ts",import.meta.url)),...(execute?["--execute"]:[])],
        {env:{...env,...(approval?{CONTROL_PLANE_OWNER_RECOVERY_APPROVAL:approval}:{})},encoding:"utf8",timeout:15_000}));
      const plan=invoke(); expect(plan.state).toBe("planned");
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_recovery_retries")).rows[0].n).toBe(0);
      const accepted=invoke(true,plan.approval); expect(accepted.state).toBe("restoring");
      expect(invoke(true,plan.approval)).toEqual({...accepted,state:"unchanged"});
    } finally {
      const quoted=`"${principal.replaceAll('"','""')}"`;
      await pool.query(`ALTER TABLE cloud_workspace_owner_discard_receipts OWNER TO ${quoted};
        ALTER TABLE cloud_workspace_owner_recovery_retries OWNER TO ${quoted};
        DROP OWNED BY ${ownerRole}; DROP ROLE ${loginRole}; DROP ROLE ${ownerRole}`);
      await rm(directory,{recursive:true,force:true});
    }
  },30_000);
});
