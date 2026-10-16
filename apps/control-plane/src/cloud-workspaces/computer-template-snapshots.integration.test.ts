import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace, seedCanonicalCloudWorkspaceAuthority, seedSupportedCloudWorkspaceGeneration,
  withCloudFixtureOwnerTx } from "./test-fixtures.js";
import { seedComputerTemplate, computerTestAccount, computerTestWallet } from "./computer-workspace-test-fixtures.js";
import { ComputerTemplateSnapshots } from "./computer-template-snapshots.js";
import type { ComputerNamedSnapshot, ComputerSnapshotIdentity, ComputerTemplateSnapshotProvider } from "./computer-template-snapshot-boat.js";
import { selectComputerWorkspaceSource } from "./computer-workspace-source.js";
import { seedRuntimeBase, seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { computerTemplateCleanupPending } from "./computer-template-retention.js";
import { seedStoppedComputerJournal } from "./computer-template-snapshot-test-fixtures.js";
import { confirmWorkspaceDeletion, seedWorkspaceDeletionGraph } from "./deletion-test-fixtures.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("durable Computer snapshot publication and retirement", () => {
  let pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let snapshots: ComputerTemplateSnapshots, provider: ComputerTemplateSnapshotProvider;
  let saved: Map<string, ComputerNamedSnapshot>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    await withSystemTx(pool, async tx => { await seedRuntimeBase(tx); await seedRuntimeBundle(tx); });
    saved = new Map();
    provider = {
      assertStopped: vi.fn(async () => {}),
      get: vi.fn(async name => saved.get(name) ?? null),
      save: vi.fn(async (sourceSandboxId, name) => { saved.set(name, { name, sourceSandboxId, status: "ready", snapshotId: `capture_${name}`, sizeBytes: 4096 }); }),
      prove: vi.fn(async (value: ComputerSnapshotIdentity) => ({ schema: "zeros.computer-saved-tree/v1", sourceSandboxId: value.sourceSandboxId,
        snapshotId: value.snapshotId, treeSha256: "d".repeat(64), entryCount: 1 })),
      remove: vi.fn(async value => { saved.delete(value.name); return true; }),
    };
    snapshots = new ComputerTemplateSnapshots(pool, { provider, channel: "alpha", accountScope: computerTestAccount,
      billingOrg: computerTestWallet, pollMs: 0 });
  });
  async function seed(version = 1) {
    return withSystemTx(pool, async tx => {
      const template = await seedComputerTemplate(tx, { organizationId: fixture.organizationId, ownerUserId: fixture.userId,
        installationId: randomUUID(), repositories: [], sourceSandboxId: `bx_2345678${version + 1}`, version });
      await tx.query("UPDATE cloud_computer_templates SET manifest_sha256=$2 WHERE build_id=$1", [template.buildId, Buffer.alloc(32, 12)]);
      await seedStoppedComputerJournal(pool, tx, template.buildId, template.sourceSandboxId);
      return template;
    });
  }
  async function capture(buildId: string) {
    // The operator commits this receipt before any provider operation.
    const approvalId = randomUUID();
    await withSystemTx(pool, tx => tx.query(`INSERT INTO audit_log(org_id,actor_id,action,subject)
      VALUES($1,$2,'cloud_computer.named_snapshot_migration_requested',$3)`,
    [fixture.organizationId, fixture.userId, JSON.stringify({ approvalId, channel: "alpha", accountScope: computerTestAccount,
      billingOrg: computerTestWallet, buildIds: [buildId] })]));
    return snapshots.capture({ buildId, approvalId, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  }
  async function acceptNamedGeneration(buildId: string, pinSource = true, workspaceId = fixture.workspaceId) {
    return withSystemTx(pool, async tx => {
      const selected = await selectComputerWorkspaceSource(tx, { organizationId: fixture.organizationId,
        qualificationMode: "full", accountScope: computerTestAccount, billingOrg: computerTestWallet });
      const row = selected!;
      await tx.query(`INSERT INTO cloud_workspace_generations
        (workspace_id,generation,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,
         created_by,provider_connection_id,runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version)
        SELECT workspace_id,2,org_id,provider,$2,architecture,cpu_millicores,memory_mib,$3,$4,created_by,provider_connection_id,
          $5,$6,$7,$8,$9,$10 FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`,
      [workspaceId, row.imageRef, row.storageMiB, row.sourceCommit, row.runtime.runtimeId, row.runtime.manifestSha256,
        row.runtime.baseImageId, row.runtime.baseCompatibilityId, row.runtime.profile, row.runtime.engineProtocolVersion]);
      if (pinSource) await tx.query(`INSERT INTO cloud_workspace_computer_sources(workspace_id,generation,org_id,build_id,template_id,config_id)
        VALUES($1,2,$2,$3,$3,$4)`, [workspaceId, fixture.organizationId, buildId, row.source.configId]);
    });
  }
  async function closeCreate(workspaceId = fixture.workspaceId, bound = false) {
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,resource_id,create_closed_at,create_attempts_tracked)
      VALUES('boat',$1,$2,2,$3,$4,$5,$6,CASE WHEN $6::text IS NULL THEN now() END,true)`,
    [computerTestAccount, workspaceId, fixture.organizationId, `fixture-create:${workspaceId}`, "a".repeat(64),
      bound ? "bx_abcdefgh" : null]));
  }

  it("changes new allocation pins only after ready identity and saved-tree proof, and replays without another save", async () => {
    const template = await seed();
    const select = () => withSystemTx(pool, tx => selectComputerWorkspaceSource(tx, { organizationId: fixture.organizationId,
      qualificationMode: "full", accountScope: computerTestAccount, billingOrg: computerTestWallet }));
    expect((await select())?.imageRef).toBe(`boat-template:${template.sourceSandboxId}`);
    const result = await capture(template.buildId);
    expect(result.imageRef).toMatch(/^boat-computer:.*@sha256:/);
    expect((await select())?.imageRef).toBe(result.imageRef);
    expect(provider.assertStopped).toHaveBeenCalledWith(template.sourceSandboxId);
    expect(provider.prove).toHaveBeenCalledWith(expect.objectContaining({ name: result.name, sourceSandboxId: template.sourceSandboxId }));
    expect(await capture(template.buildId)).toEqual(result);
    expect(provider.save).toHaveBeenCalledTimes(1);
  });

  it("never switches pins after a sanitation or exact-artifact proof failure", async () => {
    const template = await seed();
    vi.mocked(provider.prove).mockRejectedValue(new Error("fixture failure"));
    await expect(capture(template.buildId)).rejects.toThrow();
    const row = await withSystemTx(pool, async tx => (await tx.query("SELECT state FROM cloud_computer_template_snapshots WHERE build_id=$1", [template.buildId])).rows[0]);
    expect(row.state).not.toBe("ready");
  });

  it("rejects a named generation without its exact Computer source in the same transaction", async () => {
    const first = await seed(); await capture(first.buildId);
    await expect(acceptNamedGeneration(first.buildId, false)).rejects.toThrow(/exact source pin/);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId])).rowCount).toBe(0);
    await expect(acceptNamedGeneration(first.buildId)).resolves.toBeUndefined();
  });

  it("retains accepted or unknown workspace creates until positively closed, even after generation retirement", async () => {
    const first = await seed(); await capture(first.buildId); await acceptNamedGeneration(first.buildId);
    await seed(2);
    expect(await snapshots.reconcile()).toBe(0);
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_provider_operations
        (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,create_attempts_tracked)
        VALUES('boat',$1,$2,2,$3,'fixture-create',$4,true)`, [computerTestAccount, fixture.workspaceId, fixture.organizationId, "a".repeat(64)]);
      await tx.query("UPDATE cloud_workspace_generations SET retired_at=now() WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId]);
    });
    expect(await snapshots.reconcile()).toBe(0);
    expect(provider.remove).not.toHaveBeenCalled();
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_provider_operations SET create_closed_at=now() WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId]));
    expect(await snapshots.reconcile()).toBe(0);
    await pool.query("UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now(),data_deleted_at=now() WHERE id=$1", [fixture.workspaceId]);
    expect(await snapshots.reconcile()).toBe(1);
  });

  it.each([
    { status: "ready", dataDeleted: false },
    { status: "stopped", dataDeleted: false },
    { status: "archived", dataDeleted: false },
    { status: "deleted", dataDeleted: false },
    { status: "archived", dataDeleted: true },
  ])("retains a bound source for $status with dataDeleted=$dataDeleted, including retired generations", async ({ status, dataDeleted }) => {
    const first = await seed(); await capture(first.buildId); await acceptNamedGeneration(first.buildId);
    await closeCreate(fixture.workspaceId, true);
    await seed(2);
    await pool.query("UPDATE cloud_workspace_generations SET retired_at=now() WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId]);
    await pool.query(`UPDATE cloud_workspaces SET status=$2::text::cloud_workspace_status,desired_state=$3,deleted_at=CASE WHEN $2::text='deleted' THEN now() END,
      data_deleted_at=CASE WHEN $4 THEN now() END WHERE id=$1`,
    [fixture.workspaceId, status, status === "ready" ? "running" : (status === "stopped" || status === "archived") ? "stopped" : "deleted", dataDeleted]);
    expect(await snapshots.reconcile()).toBe(0);
    expect(provider.remove).not.toHaveBeenCalled();
    await pool.query("UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now(),data_deleted_at=now() WHERE id=$1", [fixture.workspaceId]);
    expect(await snapshots.reconcile()).toBe(1);
  });

  it("retains an unknown dispatched create after workspace data deletion until it is positively closed", async () => {
    const first = await seed(); await capture(first.buildId); await acceptNamedGeneration(first.buildId);
    await seed(2);
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspace_provider_operations
        (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,create_attempts_tracked)
        VALUES('boat',$1,$2,2,$3,'fixture-unknown-create',$4,true)`, [computerTestAccount, fixture.workspaceId, fixture.organizationId, "a".repeat(64)]);
      await tx.query("UPDATE cloud_workspace_generations SET retired_at=now() WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId]);
      await tx.query("UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now(),data_deleted_at=now() WHERE id=$1", [fixture.workspaceId]);
    });
    expect(await snapshots.reconcile()).toBe(0);
    expect(provider.remove).not.toHaveBeenCalled();
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_workspace_provider_operations SET create_closed_at=now() WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId]));
    expect(await snapshots.reconcile()).toBe(1);
  });

  it("retains a migrated template while an allocated workspace still has its legacy fork pin", async () => {
    const first = await seed();
    // Accept before named publication, preserving the old generation's bytes.
    await acceptNamedGeneration(first.buildId);
    await closeCreate(fixture.workspaceId, true);
    const pin = (await pool.query("SELECT image_ref FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId])).rows[0].image_ref;
    expect(pin).toBe(`boat-template:${first.sourceSandboxId}`);
    await capture(first.buildId);
    await seed(2);
    expect(await snapshots.reconcile()).toBe(0);
    expect(provider.remove).not.toHaveBeenCalled();
    expect((await pool.query("SELECT image_ref FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=2", [fixture.workspaceId])).rows[0].image_ref).toBe(pin);
  });

  it("preserves a shared named artifact through D1 erasure and releases only the erased workspace's hold", async () => {
    const erased = await seedWorkspaceDeletionGraph(pool, false);
    fixture = erased;
    const first = await seed(2); await capture(first.buildId); await acceptNamedGeneration(first.buildId); await closeCreate();
    const siblingId = randomUUID();
    await withCloudFixtureOwnerTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspaces(id,org_id,team_id,created_by,owner_user_id,assignee_user_id,
        display_name,repository_id,repository_forge,repository_owner,repository_name,repository_revision)
        SELECT $2,org_id,team_id,created_by,owner_user_id,assignee_user_id,'Sibling fixture',repository_id,
          repository_forge,repository_owner,repository_name,repository_revision FROM cloud_workspaces WHERE id=$1`,
      [fixture.workspaceId, siblingId]);
      const input = { workspaceId: siblingId, organizationId: fixture.organizationId, ownerUserId: fixture.userId };
      await seedCanonicalCloudWorkspaceAuthority(tx, input);
      await seedSupportedCloudWorkspaceGeneration(tx, input);
    });
    await pool.query("UPDATE cloud_computer_v2_heads SET active_build_id=$2 WHERE org_id=$1", [fixture.organizationId, first.buildId]);
    await acceptNamedGeneration(first.buildId, true, siblingId); await closeCreate(siblingId);
    await seed(4);
    await confirmWorkspaceDeletion(pool, erased);
    expect(await snapshots.reconcile()).toBe(0);
    const worker = new CloudWorkspaceOperationsWorker(pool, erased.objects, { workerId: "named-artifact-purge-fixture" });
    await worker.runOnce();
    expect((await pool.query("SELECT state FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state)
      .toBe("waiting_for_provider");
    // The synthetic generation-2 create was positively closed without an
    // allocation. D1 still requires its confirmed absence binding before purge.
    await pool.query(`INSERT INTO cloud_workspace_provider_bindings
      (workspace_id,generation,org_id,provider,observed_state,deletion_verified_at)
      VALUES($1,2,$2,'boat','deleted',now())`, [fixture.workspaceId, fixture.organizationId]);
    await worker.runOnce();
    expect((await pool.query("SELECT state FROM workspace_deletion_jobs WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].state).toBe("succeeded");
    expect((await pool.query("SELECT state FROM cloud_computer_template_snapshots WHERE build_id=$1", [first.buildId])).rows[0].state).toBe("ready");
    expect(await snapshots.reconcile()).toBe(0);
    expect(provider.remove).not.toHaveBeenCalled();
    await pool.query("UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=now(),data_deleted_at=now() WHERE id=$1", [siblingId]);
    expect(await snapshots.reconcile()).toBe(1);
  });

  it("keeps the shared named-artifact table outside workspace, generation and engine cascades", async () => {
    const roots = ["cloud_workspaces", "cloud_workspace_generations", "cloud_workspace_engine_instances"];
    const graph = (await pool.query<{ child: string }>(`WITH RECURSIVE dependent(oid) AS (
      SELECT unnest($1::regclass[])::oid
      UNION SELECT fk.conrelid FROM pg_constraint fk JOIN dependent ON dependent.oid=fk.confrelid WHERE fk.contype='f' AND fk.confdeltype='c'
    ) SELECT oid::regclass::text AS child FROM dependent`, [roots])).rows.map(row => row.child);
    expect(graph).toContain("cloud_agent_boot_bindings");
    expect((await pool.query(`SELECT confrelid::regclass::text AS parent FROM pg_constraint
      WHERE conrelid='cloud_workspace_computer_sources'::regclass AND contype='f'`)).rows)
      .toContainEqual({ parent: "cloud_workspace_generations" });
    expect(graph).not.toContain("cloud_computer_template_snapshots");
    expect((await pool.query(`SELECT confrelid::regclass::text AS parent FROM pg_constraint
      WHERE conrelid='cloud_computer_template_snapshots'::regclass AND contype='f'`)).rows)
      .toEqual([{ parent: "cloud_computer_templates" }]);
  });

  it("reconciles a lost accepted save reply after a proof failure without dispatching twice", async () => {
    const first = await seed();
    const original = vi.mocked(provider.save).getMockImplementation()!;
    vi.mocked(provider.save).mockImplementationOnce(async (...args) => { await original(...args); throw new Error("fixture lost save reply"); });
    vi.mocked(provider.prove).mockRejectedValueOnce(new Error("fixture interrupted proof"));
    await expect(capture(first.buildId)).rejects.toThrow();
    await capture(first.buildId);
    expect(provider.save).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a pre-existing name even when its source happens to match", async () => {
    const first = await seed();
    vi.mocked(provider.get).mockImplementation(async name => ({ name, sourceSandboxId: first.sourceSandboxId,
      snapshotId: "fixture_foreign_capture", status: "ready", sizeBytes: 4096 }));
    await expect(capture(first.buildId)).rejects.toThrow();
    expect(provider.save).not.toHaveBeenCalled();
    expect(provider.remove).not.toHaveBeenCalled();
  });

  it("requires a durable operator receipt and refuses another account or channel", async () => {
    const template = await seed();
    await expect(snapshots.capture({ buildId: template.buildId, approvalId: randomUUID(), deadlineAt: new Date(Date.now() + 1000).toISOString() })).rejects.toThrow();
    expect(provider.save).not.toHaveBeenCalled();
    const foreign = new ComputerTemplateSnapshots(pool, { provider, channel: "beta", accountScope: "another-account", billingOrg: computerTestWallet, pollMs: 0 });
    await expect(foreign.capture({ buildId: template.buildId, workerFence: 1, deadlineAt: new Date(Date.now() + 1000).toISOString() })).rejects.toThrow();
    expect(provider.assertStopped).not.toHaveBeenCalled();
  });

  it("requires the exact archived builder journal even when the template still says ready", async () => {
    const template = await seed();
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_builder_vm_operations SET state='deleting' WHERE operation_key=$1", [`computer-build:${template.buildId}`]));
    await expect(capture(template.buildId)).rejects.toThrow();
    expect(provider.assertStopped).not.toHaveBeenCalled();
    expect(provider.save).not.toHaveBeenCalled();
  });

  it("retains exactly current and previous names, leaving historical template metadata intact", async () => {
    const first = await seed(1); await capture(first.buildId);
    const second = await seed(2); await capture(second.buildId);
    const third = await seed(3); await capture(third.buildId);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_computer_v2_heads SET previous_build_id=$2 WHERE org_id=$1", [fixture.organizationId, second.buildId]));
    expect(await snapshots.reconcile()).toBe(1);
    expect(saved.size).toBe(2);
    expect(await snapshots.reconcile()).toBe(0);
    expect(provider.remove).toHaveBeenCalledTimes(1);
    const templates = await withSystemTx(pool, tx => tx.query("SELECT state FROM cloud_computer_templates WHERE org_id=$1", [fixture.organizationId]));
    expect(templates.rows.every(row => row.state === "ready")).toBe(true);
  });

  it("cannot rewrite a published name, snapshot, owner or proof in the database", async () => {
    const template = await seed(); await capture(template.buildId);
    for (const [column, value] of [["snapshot_name", "another-name"], ["snapshot_id", "another-snapshot"],
      ["channel", "beta"], ["source_sandbox_id", "bx_abcdefgh"]]) {
      await expect(withSystemTx(pool, tx => tx.query(`UPDATE cloud_computer_template_snapshots SET ${column}=$2 WHERE build_id=$1`, [template.buildId, value])))
        .rejects.toThrow();
    }
  });

  it("allocates increasing versions even after a slug changes and never exposes a digest suffix", async () => {
    const first = await seed();
    const a = await capture(first.buildId);
    await pool.query("UPDATE organizations SET slug='renamed-fixture' WHERE id=$1", [fixture.organizationId]);
    const second = await seed(2);
    const b = await capture(second.buildId);
    expect(a.name).toMatch(/-alpha-computer-v1$/);
    expect(b.name).toBe("renamed-fixture-alpha-computer-v2");
  });

  it("never reuses sequence allocations rolled back or consumed concurrently in different transactions", async () => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const first = (await tx.query("SELECT nextval('cloud_computer_snapshot_alpha_version') AS n")).rows[0].n;
      const other = (await pool.query("SELECT nextval('cloud_computer_snapshot_alpha_version') AS n")).rows[0].n;
      await tx.query("ROLLBACK");
      const next = (await pool.query("SELECT nextval('cloud_computer_snapshot_alpha_version') AS n")).rows[0].n;
      expect(BigInt(other)).toBe(BigInt(first) + 1n);
      expect(BigInt(next)).toBe(BigInt(other) + 1n);
    } finally { tx.release(); }
  });

  it("never lets a Beta reconciler read or delete an Alpha Computer name", async () => {
    await capture((await seed(1)).buildId);
    await seed(2);
    const beta = new ComputerTemplateSnapshots(pool, { provider, channel: "beta", accountScope: computerTestAccount,
      billingOrg: computerTestWallet, pollMs: 0 });
    vi.mocked(provider.get).mockClear();
    expect(await beta.reconcile()).toBe(0);
    expect(provider.get).not.toHaveBeenCalled();
    expect(provider.remove).not.toHaveBeenCalled();
  });

  it("refuses Activate after the named artifact retires even while its stopped template remains ready", async () => {
    const first = await seed(1); await capture(first.buildId);
    await seed(2);
    expect(await snapshots.reconcile()).toBe(1);
    const service = new DatabaseCloudComputerV2Service(pool, {} as CloudWorkspaceBackendConfig);
    await expect(service.activate(fixture.organizationId, fixture.userId, 1, { operationId: randomUUID(), expectedRevision: 2 }))
      .rejects.toMatchObject({ status: 409, code: "cloud_computer_not_built", message: expect.stringMatching(/Rebuild/) });
  });

  it("holds organization erasure until named deletion is positively confirmed", async () => {
    const first = await seed(1); await capture(first.buildId);
    const journal = { find: async () => ({ operation_key: `computer-build:${first.buildId}`, purpose: "computer-build" as const,
      state: "deleted" as const, sandbox_id: first.sourceSandboxId, deletion_operation_id: null, create_closed_at: null }) };
    expect(await withSystemTx(pool, tx => computerTemplateCleanupPending(tx, fixture.organizationId, journal))).toBe(true);
    await pool.query("UPDATE cloud_computer_v2_heads SET active_build_id=NULL,previous_build_id=NULL WHERE org_id=$1", [fixture.organizationId]);
    await snapshots.reconcile();
    expect(await withSystemTx(pool, tx => computerTemplateCleanupPending(tx, fixture.organizationId, journal))).toBe(false);
  });
});
