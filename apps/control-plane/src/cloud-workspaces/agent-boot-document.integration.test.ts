import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace, ensureCloudPilotUser, withCloudFixtureOwnerTx } from "./test-fixtures.js";
import { createCloudWorkspaceRoutes } from "./routes.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("cloud boot document projection", () => {
  let pool: pg.Pool;
  let workspace: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let app: Hono;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    workspace = await seedReadyCloudWorkspace(pool);
    const user: AuthedUser = { id: workspace.userId, identity: { provider: "workos", subject: `workos|${workspace.userId}` },
      email: "boot-document@example.test", displayName: "Boot document fixture", avatarUrl: null, accountRevision: 1,
      accountStatus: "active", authentication: { sessionId: null, clientKind: "legacy", authTime: null, tokenExpiresAt: null }, staffRole: null };
    app = new Hono();
    app.use("*", async (c, next) => { c.set("user", user); await next(); });
    app.route("/", createCloudWorkspaceRoutes(pool, null, { workosEnabled: false }));
    app.onError((error, c) => {
      if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status);
      throw error;
    });
  });
  const baseline = [
    { provider: "claude", status: "known", adoptionId: randomUUID() },
    { provider: "codex", status: "missing" }, { provider: "cursor", status: "unknown" },
  ];
  const bind = async (state: "reserved" | "active" = "active") => {
    const bootId = (await pool.query<{ id: string }>("SELECT runtime_boot_id AS id FROM cloud_workspace_engine_instances WHERE id=$1", [workspace.engineInstanceId])).rows[0]!.id;
    const writerEpoch = randomUUID(), id = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_local_command_writers
      (workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
      VALUES($1,$2,1,$3,$4,$5,$6,1)`,
    [workspace.workspaceId, workspace.organizationId, workspace.engineInstanceId, bootId, writerEpoch, workspace.userId]);
    await pool.query(`INSERT INTO cloud_agent_boot_bindings
      (id,workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch,
       credentials_initialized,initial_adoptions) VALUES($1,$2,$3,1,$4,$5,$6,$7,1,true,$8)`,
    [id, workspace.workspaceId, workspace.organizationId, workspace.engineInstanceId, bootId, writerEpoch, workspace.userId, JSON.stringify(baseline)]);
    // Relational projection fixture only: production activation additionally
    // requires the real cache/FULL-ledger and native retirement proofs.
    if (state === "active") {
      await pool.query("UPDATE cloud_workspace_local_command_writers SET state='active',activated_at=now() WHERE writer_epoch=$1", [writerEpoch]);
      await pool.query("UPDATE cloud_workspaces SET agent_command_mode='boot-owner-v1',agent_boot_id=$2 WHERE id=$1", [workspace.workspaceId, id]);
    }
    return { id, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", bootId, writerEpoch,
      generation: 1, engineInstanceId: workspace.engineInstanceId, fundingOwnerUserId: workspace.userId, fundingOwnerEpoch: 1,
      initialAdoptions: baseline };
  };
  const documents = async () => {
    const detail = await app.request(`/v1/cloud-workspaces/${workspace.workspaceId}`);
    expect(detail.status).toBe(200);
    const list = await app.request("/v1/cloud-workspaces");
    expect(list.status).toBe(200);
    return [ (await detail.json()).workspace,
      (await list.json()).workspaces.find((item: { id: string }) => item.id === workspace.workspaceId) ];
  };

  it("omits credential state for legacy and merely reserved boot rows", async () => {
    for (const document of await documents()) expect(document).not.toHaveProperty("agentCredentials");
    await bind("reserved");
    for (const document of await documents()) expect(document).not.toHaveProperty("agentCredentials");
  });

  it("projects only exact nonsecret active binding in detail and catalog", async () => {
    const { id, ...expected } = await bind();
    for (const document of await documents()) {
      expect(document.agentCredentials).toEqual({ ...expected, status: "current" });
      expect(JSON.stringify(document.agentCredentials)).not.toContain(id);
      expect(Object.keys(document.agentCredentials).sort()).toEqual([...Object.keys(expected), "status"].sort());
    }
  });

  it("keeps owner-only Restart state through key epochs and A-B-A transfers", async () => {
    const bound = await bind();
    await pool.query("UPDATE cloud_agent_boot_bindings SET desired_cache_revision=2 WHERE id=$1", [bound.id]);
    for (const document of await documents()) expect(document.agentCredentials.status).toBe("current");
    const nextOwner = (await ensureCloudPilotUser(pool, { provider: "workos", providerSubject: `user_${randomUUID()}`,
      email: `new-owner-${randomUUID()}@example.test`, displayName: "Next owner" })).id;
    await withCloudFixtureOwnerTx(pool, async tx => {
      await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [workspace.organizationId, nextOwner]);
      await tx.query("INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES($1,$2,'active')", [workspace.organizationId, nextOwner]);
    });
    await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1", [workspace.workspaceId, nextOwner]);
    await pool.query("UPDATE cloud_workspaces SET owner_user_id=$2 WHERE id=$1", [workspace.workspaceId, workspace.userId]);
    for (const document of await documents()) expect(document.agentCredentials).toMatchObject({ status: "owner-changed",
      fundingOwnerUserId: workspace.userId, fundingOwnerEpoch: 1, bootId: bound.bootId, writerEpoch: bound.writerEpoch });
  });

  it("retains exact stopped binding without live admission or wake", async () => {
    const { id, ...expected } = await bind();
    await pool.query("UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=now() WHERE writer_epoch=$1", [expected.writerEpoch]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [expected.engineInstanceId]);
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [workspace.workspaceId]);
    const before = (await pool.query("SELECT state,last_heartbeat_at FROM cloud_workspace_engine_instances WHERE id=$1", [expected.engineInstanceId])).rows;
    for (const document of await documents()) expect(document.agentCredentials).toEqual({ ...expected, status: "current" });
    expect((await pool.query("SELECT state,last_heartbeat_at FROM cloud_workspace_engine_instances WHERE id=$1", [expected.engineInstanceId])).rows).toEqual(before);
    expect(id).not.toBe(expected.bootId);
  });
});
