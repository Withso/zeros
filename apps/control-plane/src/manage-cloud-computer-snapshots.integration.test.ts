import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { seedReadyCloudWorkspace } from "./cloud-workspaces/test-fixtures.js";
import { seedRuntimeBase, seedRuntimeBundle } from "./cloud-workspaces/runtime-test-fixtures.js";
import { seedComputerTemplate, computerTestAccount, computerTestWallet } from "./cloud-workspaces/computer-workspace-test-fixtures.js";
import { ComputerTemplateSnapshots } from "./cloud-workspaces/computer-template-snapshots.js";
import type { ComputerNamedSnapshot, ComputerSnapshotIdentity } from "./cloud-workspaces/computer-template-snapshot-boat.js";
import { seedStoppedComputerJournal } from "./cloud-workspaces/computer-template-snapshot-test-fixtures.js";
import { manageCloudComputerSnapshots, validateComputerSnapshotMigration, type ComputerSnapshotMigrationInput } from "./manage-cloud-computer-snapshots.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("guarded one-time Computer snapshot migration", () => {
  let pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let input: ComputerSnapshotMigrationInput, snapshots: ComputerTemplateSnapshots;
  let capture: ReturnType<typeof vi.fn>, prove: ReturnType<typeof vi.fn>, get: ReturnType<typeof vi.fn>;
  let buildIds: string[];
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: false });
    buildIds = [];
    await withSystemTx(pool, async tx => {
      await seedRuntimeBase(tx); await seedRuntimeBundle(tx);
      for (const version of [1, 2]) {
        const row = await seedComputerTemplate(tx, { organizationId: fixture.organizationId, ownerUserId: fixture.userId,
          installationId: randomUUID(), repositories: [], version, sourceSandboxId: `bx_2345678${version + 1}` });
        buildIds.push(row.buildId);
        await tx.query("UPDATE cloud_computer_templates SET manifest_sha256=$2 WHERE build_id=$1", [row.buildId, Buffer.alloc(32, version)]);
        await seedStoppedComputerJournal(pool, tx, row.buildId, row.sourceSandboxId);
      }
      await tx.query("UPDATE cloud_computer_v2_heads SET previous_build_id=$2 WHERE org_id=$1", [fixture.organizationId, buildIds[0]]);
    });
    const slug = (await pool.query("SELECT slug FROM organizations WHERE id=$1", [fixture.organizationId])).rows[0].slug;
    input = { databaseUrl: process.env.TEST_DATABASE_URL!, channel: "alpha", execute: false, approvalId: randomUUID(),
      organizationId: fixture.organizationId, expectedOrganizationSlug: slug, actorUserId: fixture.userId,
      reason: "Save the two approved Computer templates under durable names", accountScope: computerTestAccount, billingOrg: computerTestWallet };
    const saved = new Map<string, ComputerNamedSnapshot>();
    capture = vi.fn(async (sourceSandboxId: string, name: string) => { saved.set(name, { name, sourceSandboxId,
      status: "ready", snapshotId: `capture_${name}`, sizeBytes: 4096 }); });
    prove = vi.fn(async (value: ComputerSnapshotIdentity) => ({ schema: "zeros.computer-saved-tree/v1" as const,
      sourceSandboxId: value.sourceSandboxId, snapshotId: value.snapshotId, treeSha256: "d".repeat(64), entryCount: 1 }));
    get = vi.fn(async name => saved.get(name) ?? null);
    snapshots = new ComputerTemplateSnapshots(pool, { channel: "alpha", accountScope: computerTestAccount, billingOrg: computerTestWallet, pollMs: 0,
      provider: { assertStopped: vi.fn(async () => {}), get, save: capture, prove, remove: vi.fn(async () => true) } });
  });
  const run = (changes: Partial<ComputerSnapshotMigrationInput> = {}) => manageCloudComputerSnapshots(pool,
    validateComputerSnapshotMigration({ ...input, ...changes }), () => snapshots);

  it("plans exactly active and previous without provider I/O or a write", async () => {
    const plan = await run();
    expect(plan.state).toBe("planned");
    expect(plan.templates.map(row => row.buildId).sort()).toEqual(buildIds.sort());
    expect(plan.templates.every(row => row.name.includes("-alpha-computer-v"))).toBe(true);
    expect(get).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
    expect((await pool.query("SELECT count(*) FROM cloud_computer_template_snapshots")).rows[0].count).toBe("0");
    expect((await pool.query("SELECT count(*) FROM audit_log WHERE action='cloud_computer.named_snapshot_migration_requested'")).rows[0].count).toBe("0");
  });

  it("requires exact approval, audits once and is replayable without duplicate saves", async () => {
    const plan = await run();
    await expect(run({ execute: true, approval: "unapproved" })).rejects.toThrow(/approval/i);
    expect(capture).not.toHaveBeenCalled();
    expect((await run({ execute: true, approval: plan.approval })).state).toBe("completed");
    expect(capture).toHaveBeenCalledTimes(2);
    expect((await run({ execute: true, approval: plan.approval })).state).toBe("replayed");
    expect(capture).toHaveBeenCalledTimes(2);
    expect((await pool.query("SELECT count(*) FROM audit_log WHERE action='cloud_computer.named_snapshot_migration_requested'")).rows[0].count).toBe("1");
  });

  it("refuses a stale head or changed actor/reason/account before dispatch", async () => {
    const plan = await run();
    for (const changed of [{ reason: "A different reason invalidates the reviewed approval" }, { accountScope: "foreign-account" }])
      await expect(run({ ...changed, execute: true, approval: plan.approval })).rejects.toThrow();
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_computer_v2_heads SET revision=revision+1 WHERE org_id=$1", [fixture.organizationId]));
    await expect(run({ execute: true, approval: plan.approval })).rejects.toThrow(/approval/i);
    expect(capture).not.toHaveBeenCalled();
  });

  it("resumes a partial migration from its audited receipt without replacing the first name", async () => {
    const plan = await run();
    prove.mockRejectedValueOnce(new Error("synthetic interrupted proof"));
    await expect(run({ execute: true, approval: plan.approval })).rejects.toThrow();
    expect((await run({ execute: true, approval: plan.approval })).state).toBe("completed");
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("refuses the application database role", async () => {
    const appPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=zeros_app", max: 1 });
    try { await expect(manageCloudComputerSnapshots(appPool, validateComputerSnapshotMigration(input), () => snapshots)).rejects.toThrow(/owner|role/i); }
    finally { await appPool.end(); }
  });

  it("refuses a stopped-source journal changed after planning", async () => {
    const plan = await run();
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_builder_vm_operations SET state='deleting' WHERE operation_key=$1", [`computer-build:${buildIds[0]}`]));
    await expect(run({ execute: true, approval: plan.approval })).rejects.toThrow(/journal/);
    expect(capture).not.toHaveBeenCalled();
  });

  it("refuses Personal owners even with a concrete UUID and matching slug", async () => {
    const organizationId = randomUUID();
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,'local-fixture','Local',$2,true,false)", [organizationId, fixture.userId]);
    await expect(run({ organizationId, expectedOrganizationSlug: "local-fixture" })).rejects.toThrow(/Personal|local/i);
    expect(capture).not.toHaveBeenCalled();
  });
});
