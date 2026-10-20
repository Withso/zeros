import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { manageCloudOwnerCheckpointRecovery } from "../manage-cloud-owner-checkpoint-recovery.js";
import { ownerRecoveryConfig, seedOwnerCheckpointRecovery } from "./owner-checkpoint-recovery-test-fixtures.js";
import { seedFinalSave, seedFinalSaveEngine } from "./final-save-test-fixtures.js";
import { rollbackCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { requestManagedComputeStop } from "./compute-credit-stop.js";
import { runFinalSaveRecovery } from "./final-save-service.js";
import { scheduleFinalSaveRecovery } from "./final-save-recovery.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { DatabaseCloudWorkspaceHealthService } from "./health.js";
import { DatabaseCloudWorkspaceDurableRecordService } from "./durable-record.js";
import type { CloudProviderResource, CloudWorkspaceProvider } from "./provider.js";

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
});
