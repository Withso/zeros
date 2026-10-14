import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudWorkspaceHealthService } from "./health.js";
import { readPendingDeletionCapacity } from "./pending-deletion.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("legacy retired Boat deletion readiness label", () => {
  let pool: pg.Pool;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let service: DatabaseCloudWorkspaceHealthService;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: true });
    service = new DatabaseCloudWorkspaceHealthService(pool, {
      backgroundWorkersEnabled: true, setupExecutionEnabled: true, durabilityEnabled: true, outboxDeliveryEnabled: false,
    });
  });

  async function retiredDeletion(options: {
    generation?: number; retired?: boolean; receipt?: string | null; binding?: boolean;
    bindingResource?: string; observedState?: string; intent?: boolean; intentState?: string;
    errorCode?: string | null; requestedHoursAgo?: number; stage?: string; provider?: "boat" | "daytona";
  } = {}) {
    const generation = options.generation ?? 2;
    const resource = `bx_fixture${generation}`;
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_generations (
        workspace_id,generation,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,
        source_commit,created_by,provider_connection_id,created_at,retired_at,runtime_id,runtime_manifest_sha256,
        runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version)
        SELECT workspace_id,$2,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,
          source_commit,created_by,provider_connection_id,now()-interval '26 hours',
          CASE WHEN $3::boolean THEN now()-interval '25 hours' END,runtime_id,runtime_manifest_sha256,
          runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version
        FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`,
      [fixture.workspaceId, generation, options.retired !== false]);
      if (options.binding !== false) await tx.query(`INSERT INTO cloud_workspace_provider_bindings
        (workspace_id,generation,org_id,provider,provider_resource_id,observed_state,last_observed_at)
        VALUES($1,$2,$3,'boat',$4,$5,now())`,
      [fixture.workspaceId, generation, fixture.organizationId, options.bindingResource ?? resource, options.observedState ?? "archived"]);
      if (options.intent !== false) await addIntent(tx, generation, options.intentState ?? "observing",
        options.errorCode === undefined ? "provider_deletion_blocked" : options.errorCode);
      await tx.query(`INSERT INTO cloud_workspace_provider_operations
        (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,resource_id,
         deletion_requested_at,deletion_operation_id,deletion_progress_at,deletion_stage)
        VALUES($9,'fixture',$1,$2,$3,$4,repeat('a',64),$5,now()-make_interval(hours=>$6),$7,
          now()-make_interval(hours=>$6),$8)`,
      [fixture.workspaceId, generation, fixture.organizationId, `retirement-${generation}`, resource,
        options.requestedHoursAgo ?? 2, options.receipt === undefined ? `bdop_${"b".repeat(32)}` : options.receipt,
        options.stage ?? "blocked", options.provider ?? "boat"]);
    });
    return resource;
  }

  async function addIntent(tx: pg.PoolClient, generation: number, state: string, errorCode: string | null) {
    const id = randomUUID();
    await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,affects_workspace,
       state,error_code,created_at,updated_at,next_attempt_at,completed_at)
      VALUES($1,$2,$3,$4,'delete',$5,$6,false,$7::cloud_workspace_intent_state,$8,now()-interval '2 hours',now(),now()+interval '1 minute',
        CASE WHEN $7::cloud_workspace_intent_state IN ('failed','succeeded','superseded') THEN now() END)`,
    [id, fixture.workspaceId, generation, fixture.organizationId, `retirement-${id}`, randomBytes(32), state, errorCode]);
  }

  async function deletingWorkspace(status: "deleting" | "deleted", options: Parameters<typeof retiredDeletion>[0] = {}) {
    // Boat's retrying receipt is normalized to the persisted blocked stage.
    const resource = await retiredDeletion({ retired: false, stage: "blocked", ...options });
    await withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspaces
      SET current_generation=$2,status=$3::cloud_workspace_status,desired_state='deleted',
        deleted_at=CASE WHEN $3::text='deleted' THEN now() ELSE NULL END
      WHERE id=$1 AND org_id=$4`,
    [fixture.workspaceId, options.generation ?? 2, status, fixture.organizationId]));
    return resource;
  }

  it.each([
    ["deleting", "provider_deletion_blocked"], ["deleting", "provider_deletion_pending"],
    ["deleted", "provider_deletion_blocked"], ["deleted", "provider_deletion_pending"],
  ] as const)("defers Boat's accepted current-generation deletion for a %s workspace (%s)", async (status, errorCode) => {
    const resource = await deletingWorkspace(status, { errorCode });
    const before = await withSystemTx(pool, tx => readPendingDeletionCapacity(tx, fixture.organizationId));
    const result = await service.readForRelease();
    expect(result).toMatchObject({ stalledDeletionsDeferred: true, controlPlaneReady: true,
      health: { operationalState: "degraded", reasons: ["deletion_intent_stalled"] } });
    expect(await service.read()).toEqual(result.health);
    expect((await withSystemTx(pool, tx => readPendingDeletionCapacity(tx, fixture.organizationId))).pendingDeletion
      .map(({ workspaceId, generation, reserved, stage, state }) => ({ workspaceId, generation, reserved, stage, state })))
      .toEqual(before.pendingDeletion.map(({ workspaceId, generation, reserved, stage, state }) => ({ workspaceId, generation, reserved, stage, state })));
    expect((await pool.query(`SELECT operation.deleted_at,binding.deletion_verified_at,intent.state
      FROM cloud_workspace_provider_operations operation
      JOIN cloud_workspace_provider_bindings binding USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_lifecycle_intents intent USING(workspace_id,generation,org_id)
      WHERE operation.resource_id=$1`, [resource])).rows).toEqual([
      { deleted_at: null, deletion_verified_at: null, state: "observing" },
    ]);
  });

  it("defers accepted deletions of both a retired and a deleting current generation", async () => {
    await deletingWorkspace("deleted");
    await retiredDeletion({ generation: 3 });
    expect((await service.readForRelease()).stalledDeletionsDeferred).toBe(true);
  });

  it.each([
    { receipt: null }, { receipt: "foreign-receipt" }, { binding: false },
    { bindingResource: "bx_foreign" }, { observedState: "running" }, { intent: false },
    { intentState: "queued" }, { intentState: "dispatching" }, { intentState: "failed" },
    { errorCode: null }, { errorCode: "provider_absence_unconfirmed" }, { provider: "daytona" as const },
  ])("keeps unconfirmed current-generation deletion outside the legacy label: %j", async options => {
    await deletingWorkspace("deleted", options);
    await retiredDeletion({ generation: 3 });
    expect((await service.readForRelease()).stalledDeletionsDeferred).toBe(false);
  });

  it.each(["failed", "waiting_for_provider"] as const)(
    "does not use the legacy label for a separate %s deletion job", async state => {
      await deletingWorkspace("deleted");
      const other = await seedReadyCloudWorkspace(pool);
      await pool.query(`INSERT INTO workspace_deletion_jobs
        (workspace_id,org_id,requested_by,idempotency_key,state,created_at,completed_at,error_code)
        VALUES($1,$2,$3,'other-deletion',$4,now()-interval '25 hours',
          CASE WHEN $4::text='failed' THEN now() END,
          CASE WHEN $4::text='failed' THEN 'workspace_deletion_unknown_failure' END)`,
      [other.workspaceId, other.organizationId, other.userId, state]);
      const result = await service.readForRelease();
      expect(result.health.reasons).toContain("deletion_intent_stalled");
      expect(result.health.reasons).toContain(state === "failed" ? "deletion_jobs_failed" : "deletion_provider_stalled");
      expect(result.stalledDeletionsDeferred).toBe(false);
      expect(result).toMatchObject({ controlPlaneReady: true });
    },
  );

  it("defers a retired generation and retains health, accounting and deletion evidence", async () => {
    const resource = await retiredDeletion();
    const before = await withSystemTx(pool, tx => readPendingDeletionCapacity(tx, fixture.organizationId));
    const measured = await service.readForRelease();
    expect(measured).toMatchObject({ stalledDeletionsDeferred: true,
      health: { operationalState: "degraded", reasons: ["deletion_intent_stalled"] } });
    expect(await service.read()).toEqual(measured.health);
    const after = await withSystemTx(pool, tx => readPendingDeletionCapacity(tx, fixture.organizationId));
    const stableInventory = (inventory: typeof before) => inventory.pendingDeletion.map(entry => ({
      workspaceId: entry.workspaceId, generation: entry.generation, requestedAt: entry.requestedAt,
      lastProgressAt: entry.lastProgressAt, stage: entry.stage, state: entry.state, nextRetryAt: entry.nextRetryAt, reserved: entry.reserved,
    }));
    expect(stableInventory(after)).toEqual(stableInventory(before));
    expect(before.pendingDeletion).toMatchObject([{ workspaceId: fixture.workspaceId, generation: 2 }]);
    expect((await pool.query(`SELECT operation.deleted_at,binding.deletion_verified_at,intent.state
      FROM cloud_workspace_provider_operations operation
      JOIN cloud_workspace_provider_bindings binding USING(workspace_id,generation,org_id)
      JOIN cloud_workspace_lifecycle_intents intent USING(workspace_id,generation,org_id)
      WHERE operation.resource_id=$1`, [resource])).rows).toEqual([
      { deleted_at: null, deletion_verified_at: null, state: "observing" },
    ]);
  });

  it("needs no operator allowlist for several eligible retired generations", async () => {
    await retiredDeletion();
    await retiredDeletion({ generation: 3, requestedHoursAgo: 30 });
    expect((await service.readForRelease()).stalledDeletionsDeferred).toBe(true);
  });

  it("defers more retired generations than the former allowlist bound, but not with one disqualified", async () => {
    for (let generation = 2; generation <= 9; generation++) await retiredDeletion({ generation });
    expect((await service.readForRelease()).stalledDeletionsDeferred).toBe(true);
    await retiredDeletion({ generation: 10, receipt: null });
    expect((await service.readForRelease()).stalledDeletionsDeferred).toBe(false);
  });

  it("fails closed when one of several stalled generations is ineligible", async () => {
    await retiredDeletion();
    await retiredDeletion({ generation: 3, intentState: "failed" });
    expect((await service.readForRelease()).stalledDeletionsDeferred).toBe(false);
  });

  it("has nothing to defer without a stalled deletion", async () => {
    const measured = await service.readForRelease();
    expect(measured).toMatchObject({ stalledDeletionsDeferred: false, health: { operationalState: "healthy", reasons: [] } });
  });

  it("never defers the workspace's current generation, even if marked retired", async () => {
    await retiredDeletion();
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspaces SET current_generation=2 WHERE id=$1", [fixture.workspaceId]));
    expect((await service.readForRelease()).stalledDeletionsDeferred).toBe(false);
  });

  it.each([
    { retired: false }, { receipt: null }, { receipt: "foreign-receipt" }, { binding: false },
    { bindingResource: "bx_foreign" }, { observedState: "running" }, { intent: false },
    { intentState: "queued" }, { intentState: "dispatching" }, { intentState: "failed" },
    { errorCode: "provider_absence_unconfirmed" }, { provider: "daytona" as const },
  ])("refuses incomplete or mismatched retirement evidence: %j", async options => {
    await retiredDeletion(options);
    expect((await service.readForRelease()).stalledDeletionsDeferred).toBe(false);
  });

  it("cannot hide an unexplained stalled intent behind another allowed intent on the same generation", async () => {
    await retiredDeletion();
    await withSystemTx(pool, tx => addIntent(tx, 2, "observing", "provider_absence_unconfirmed"));
    expect((await service.readForRelease()).stalledDeletionsDeferred).toBe(false);
  });

  it("keeps an unbound provider-only journal outside the legacy label, including one from another organization", async () => {
    await retiredDeletion();
    const other = await seedReadyCloudWorkspace(pool);
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,resource_id,
       deletion_requested_at,deletion_operation_id)
      VALUES('boat','fixture',$1,1,$2,'unbound-deletion',repeat('c',64),'bx_unbound',now()-interval '2 hours',$3)`,
    [randomUUID(), other.organizationId, `bdop_${"d".repeat(32)}`]));
    expect((await service.readForRelease()).stalledDeletionsDeferred).toBe(false);
  });

  it("does not suppress other operational health failures", async () => {
    await retiredDeletion();
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,generation,org_id,operation,idempotency_key,request_sha256,affects_workspace,state,
       created_at,updated_at,next_attempt_at)
      VALUES($1,$2,1,$3,'wake','unrelated-lifecycle',$4,true,'queued',now()-interval '20 minutes',
        now()-interval '20 minutes',now()-interval '20 minutes')`,
    [randomUUID(), fixture.workspaceId, fixture.organizationId, randomBytes(32)]));
    const result = await service.readForRelease();
    expect(result.health.reasons).toContain("lifecycle_stalled");
    expect(result.stalledDeletionsDeferred).toBe(false);
  });

  it("keeps a separate legitimate waiting-for-uploads receipt out of the stall inventory", async () => {
    await retiredDeletion();
    await retiredDeletion({ generation: 3, stage: "waiting_for_uploads" });
    expect((await service.readForRelease()).stalledDeletionsDeferred).toBe(true);
  });
});
