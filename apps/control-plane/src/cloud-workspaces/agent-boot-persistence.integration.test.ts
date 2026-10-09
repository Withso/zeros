import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace, ensureCloudPilotUser, withCloudFixtureOwnerTx } from "./test-fixtures.js";
import { readCurrentCloudAgentBootBinding } from "./agent-boot-credentials.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("authoritative cloud boot funding epoch", () => {
  let pool: pg.Pool;
  let workspace: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let nextOwner: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    workspace = await seedReadyCloudWorkspace(pool);
    nextOwner = (await ensureCloudPilotUser(pool, { provider: "workos", providerSubject: `user_${randomUUID()}`,
      email: `funding-${randomUUID()}@example.test`, displayName: "Funding owner fixture" })).id;
    await withCloudFixtureOwnerTx(pool, async tx => {
      await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [workspace.organizationId, nextOwner]);
      await tx.query("INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES($1,$2,'active')", [workspace.organizationId, nextOwner]);
    });
  });
  const read = async () => (await pool.query<{ epoch: string; mode: string; pointer: string | null; owner: string; creator: string }>(
    `SELECT agent_funding_owner_epoch::text AS epoch, agent_command_mode AS mode, agent_boot_id AS pointer,
      owner_user_id AS owner,created_by AS creator FROM cloud_workspaces WHERE id=$1`, [workspace.workspaceId])).rows[0];

  it("starts legacy cloud with no binding and a real epoch", async () => {
    expect(await read()).toEqual({ epoch: "1", mode: "legacy", pointer: null, owner: workspace.userId, creator: workspace.userId });
  });
  it("uses owner rather than immutable creator after transfer", async () => {
    await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1", [workspace.workspaceId, nextOwner]);
    expect(await read()).toMatchObject({ epoch: "2", owner: nextOwner, creator: workspace.userId });
  });
  it("increments every actual transfer including A-B-A", async () => {
    await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1", [workspace.workspaceId, nextOwner]);
    await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1", [workspace.workspaceId, workspace.userId]);
    expect(await read()).toMatchObject({ epoch: "3", owner: workspace.userId });
  });
  it("does not increment for a repeated owner or unrelated workspace metadata", async () => {
    await pool.query("UPDATE cloud_workspaces SET owner_user_id=owner_user_id,display_name='Renamed fixture' WHERE id=$1", [workspace.workspaceId]);
    expect(await read()).toMatchObject({ epoch: "1", owner: workspace.userId });
  });
  it("does not increment for role or credential policy changes", async () => {
    await pool.query("UPDATE cloud_workspace_members SET role='manager' WHERE workspace_id=$1 AND user_id=$2", [workspace.workspaceId, workspace.userId]);
    expect(await read()).toMatchObject({ epoch: "1" });
  });
  it.each([0, 2, 9007199254740992])("refuses an independent epoch rewrite to %s", async epoch => {
    await expect(pool.query("UPDATE cloud_workspaces SET agent_funding_owner_epoch=$2 WHERE id=$1", [workspace.workspaceId, epoch]))
      .rejects.toMatchObject({ code: "23514" });
    expect(await read()).toMatchObject({ epoch: "1" });
  });
  it("refuses caller-selected boot pointer or local mode without exact activated writer", async () => {
    await expect(pool.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1' WHERE id=$1", [workspace.workspaceId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE cloud_workspaces SET agent_boot_id=$2 WHERE id=$1", [workspace.workspaceId, randomUUID()]))
      .rejects.toMatchObject({ code: expect.stringMatching(/^235/) });
    expect(await read()).toMatchObject({ mode: "legacy", pointer: null });
  });

  it("refuses a caller-selected initial funding epoch", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Keep the unrelated generation/billing FKs deferred, so this negative
      // observes the before-insert authority guard, not commit-time fixture FKs.
      await expect(client.query(`INSERT INTO cloud_workspaces
      (id,org_id,team_id,created_by,display_name,repository_forge,repository_owner,repository_name,
       repository_revision,repository_id,owner_user_id,assignee_user_id,agent_funding_owner_epoch)
      SELECT $2,org_id,team_id,created_by,'Initial epoch fixture',repository_forge,repository_owner,repository_name,
        repository_revision,repository_id,owner_user_id,assignee_user_id,2 FROM cloud_workspaces WHERE id=$1`,
      [workspace.workspaceId, randomUUID()])).rejects.toMatchObject({ code: "23514" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  const reserve = async () => {
    const bootId = (await pool.query<{ boot_id: string }>(
      "SELECT runtime_boot_id AS boot_id FROM cloud_workspace_engine_instances WHERE id=$1", [workspace.engineInstanceId])).rows[0]!.boot_id;
    const writerEpoch = randomUUID();
    // This fixture exercises the relational guards, not the activation API's
    // native/cache/FULL-ledger proof. No production path uses this shortcut.
    await pool.query(`INSERT INTO cloud_workspace_local_command_writers
      (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
      VALUES($1,$2,1,$3,$4,$5,$6,1)`,
    [workspace.workspaceId, workspace.organizationId, workspace.engineInstanceId, bootId, writerEpoch, workspace.userId]);
    return { organizationId: workspace.organizationId, workspaceId: workspace.workspaceId,
      generation: 1, engineInstanceId: workspace.engineInstanceId, bootId, writerEpoch,
      fundingOwnerUserId: workspace.userId, fundingOwnerEpoch: 1 };
  };
  const insertBinding = async (scope: Awaited<ReturnType<typeof reserve>>) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO cloud_agent_boot_bindings
      (id,workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, scope.workspaceId, scope.organizationId, scope.generation, scope.engineInstanceId,
      scope.bootId, scope.writerEpoch, scope.fundingOwnerUserId, scope.fundingOwnerEpoch]);
    return id;
  };
  const initialize = (id: string) => pool.query(
    "UPDATE cloud_agent_boot_bindings SET credentials_initialized=true WHERE id=$1", [id]);
  const markActive = (scope: Awaited<ReturnType<typeof reserve>>) => pool.query(
    "UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now() WHERE workspace_id=$1 AND writer_epoch=$2",
    [scope.workspaceId, scope.writerEpoch]);
  const point = (id: string) => pool.query(
    "UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1", [workspace.workspaceId, id]);
  const passiveRead = () => withCloudFixtureOwnerTx(pool, tx => readCurrentCloudAgentBootBinding(tx,
    { organizationId: workspace.organizationId, workspaceId: workspace.workspaceId }));

  it("reads authoritative legacy without recovering or waking an engine", async () => {
    const before = await pool.query("SELECT state,last_heartbeat_at FROM cloud_workspace_engine_instances WHERE id=$1", [workspace.engineInstanceId]);
    await expect(passiveRead()).resolves.toEqual({ mode: "legacy" });
    expect((await pool.query("SELECT state,last_heartbeat_at FROM cloud_workspace_engine_instances WHERE id=$1", [workspace.engineInstanceId])).rows)
      .toEqual(before.rows);
  });

  it.each(["bootId", "engineInstanceId", "fundingOwnerUserId", "fundingOwnerEpoch"] as const)(
    "refuses a transplanted binding %s against the actual reserved writer", async field => {
      const scope = await reserve();
      const hostile = { ...scope, [field]: field === "fundingOwnerEpoch" ? 2 : randomUUID() };
      await expect(insertBinding(hostile)).rejects.toMatchObject({ code: "23514" });
    });

  it("refuses binding creation after the genuine engine is revoked", async () => {
    const scope = await reserve();
    await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=now(),state='revoked' WHERE id=$1", [scope.engineInstanceId]);
    await expect(insertBinding(scope)).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses binding creation after the genuine engine authority expires", async () => {
    const scope = await reserve();
    await pool.query(`UPDATE cloud_workspace_engine_instances SET registered_at=now()-interval '2 minutes',
      last_heartbeat_at=now()-interval '1 minute',lease_expires_at=now()-interval '1 second' WHERE id=$1`, [scope.engineInstanceId]);
    await expect(insertBinding(scope)).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps a reserved binding private until initialized and active", async () => {
    const scope = await reserve(), id = await insertBinding(scope);
    await expect(point(id)).rejects.toMatchObject({ code: "23514" });
    await initialize(id);
    await expect(point(id)).rejects.toMatchObject({ code: "23514" });
    await expect(passiveRead()).resolves.toEqual({ mode: "legacy" });
    await markActive(scope);
    await point(id);
    await expect(passiveRead()).resolves.toMatchObject({ mode: "boot-owner-v1",
      binding: { id, ...scope, writerState: "active", status: "current" } });
  });

  it("uses the private binding pointer, never a guessed wire boot witness", async () => {
    const scope = await reserve(), id = await insertBinding(scope);
    await initialize(id); await markActive(scope);
    expect(id).not.toBe(scope.bootId);
    await expect(point(scope.bootId)).rejects.toMatchObject({ code: "23514" });
    await point(id);
    await expect(pool.query("UPDATE cloud_workspaces SET agent_command_mode='legacy',agent_boot_id=NULL WHERE id=$1", [scope.workspaceId]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("retains exact stopped history identity and dirty metadata without live admission", async () => {
    const scope = await reserve(), id = await insertBinding(scope);
    await initialize(id); await markActive(scope); await point(id);
    await pool.query("UPDATE cloud_agent_boot_bindings SET desired_cache_revision=2 WHERE id=$1", [id]);
    await pool.query(`UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=now()
      WHERE workspace_id=$1 AND writer_epoch=$2`, [scope.workspaceId, scope.writerEpoch]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=now(),state='revoked' WHERE id=$1", [scope.engineInstanceId]);
    await expect(passiveRead()).resolves.toMatchObject({ mode: "boot-owner-v1",
      binding: { id, ...scope, writerState: "retired", cacheRevision: 1, desiredCacheRevision: 2 } });
  });

  it("keeps the original funder and reports A-B-A as an owner change", async () => {
    const scope = await reserve(), id = await insertBinding(scope);
    await initialize(id); await markActive(scope); await point(id);
    await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1", [scope.workspaceId, nextOwner]);
    await expect(passiveRead()).resolves.toMatchObject({ binding: { ...scope, status: "owner-changed" } });
    await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1", [scope.workspaceId, workspace.userId]);
    await expect(passiveRead()).resolves.toMatchObject({ binding: { ...scope, status: "owner-changed" } });
  });

  it("prevents mutable identity, regressed readiness and rewriting the trusted initial baseline", async () => {
    const scope = await reserve(), id = await insertBinding(scope);
    await initialize(id);
    await expect(pool.query("UPDATE cloud_agent_boot_bindings SET boot_id=$2 WHERE id=$1", [id, randomUUID()]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE cloud_agent_boot_bindings SET credentials_initialized=false WHERE id=$1", [id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`UPDATE cloud_agent_boot_bindings SET initial_adoptions=
      '[{"provider":"claude","status":"missing"},{"provider":"codex","status":"missing"},{"provider":"cursor","status":"missing"}]' WHERE id=$1`, [id]))
      .rejects.toMatchObject({ code: "23514" });
    await pool.query("UPDATE cloud_agent_boot_bindings SET desired_cache_revision=2 WHERE id=$1", [id]);
    await expect(pool.query("UPDATE cloud_agent_boot_bindings SET desired_cache_revision=1 WHERE id=$1", [id]))
      .rejects.toMatchObject({ code: "23514" });
    await markActive(scope);
    await expect(point(id)).rejects.toMatchObject({ code: "23514" });
  });
});
