import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace, seedSupportedCloudWorkspaceGeneration } from "./test-fixtures.js";
import { requireSupportedCloudWorkspaceGeneration } from "./supported-generation.js";
import { resolveDatabaseCloudWorkspaceSettings } from "./settings.js";
import { createCloudWorkspaceRoutes } from "./routes.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("saved supported cloud generation admission and catalog", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await resetMigratedTestDatabase(pool); });
  const scope = (fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>) => ({ ...fixture, generation: 1 });

  it("admits a valid saved Computer source and preserves the generation pin", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    const result = await withSystemTx(pool, tx => requireSupportedCloudWorkspaceGeneration(tx, scope(fixture)));
    expect(result.runtimePin.profile).toBe("zeros-cloud-worker-v4");
    const settings = await withSystemTx(pool, tx => resolveDatabaseCloudWorkspaceSettings(tx,
      { ...scope(fixture), actorUserId: fixture.userId, isPersonal: false }));
    expect(settings.sourceVersions.computerEnvironment).toMatchObject({ configId: result.source.configId });
    expect((await pool.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1", [fixture.workspaceId])).rows[0].current_generation).toBe(1);
  });
  it.each(["ready", "retired"])("keeps a workspace allocated from a %s named Computer supported in the catalog", async state => {
    const fixture = await seedReadyCloudWorkspace(pool);
    // Seed the already-accepted immutable generation; production INSERT is
    // covered separately by the named source/pin constraint tests.
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT set_config('app.system','on',true)");
      const template = (await tx.query("SELECT * FROM cloud_computer_templates WHERE org_id=$1", [fixture.organizationId])).rows[0];
      await tx.query("UPDATE cloud_computer_templates SET provider_resource_id='bx_23456789',manifest_sha256=$2 WHERE build_id=$1", [template.build_id, Buffer.alloc(32, 12)]);
      const named = (await tx.query(`INSERT INTO cloud_computer_template_snapshots
        (build_id,org_id,channel,account_scope,billing_org,source_sandbox_id,snapshot_name,manifest_sha256,
         state,save_requested_at,snapshot_id,size_bytes,tree_sha256,verified_at,ready_at,retire_requested_at,retired_at)
        VALUES($1,$2,'alpha',$3,$4,'bx_23456789','fixture-alpha-computer-v1',$5,$6,now(),'fixture_snapshot',4096,$5,now(),now(),
          CASE WHEN $6='retired' THEN now() END,CASE WHEN $6='retired' THEN now() END) RETURNING image_ref`,
      [template.build_id, fixture.organizationId, template.account_scope, template.billing_org, Buffer.alloc(32, 12), state])).rows[0];
      await tx.query("SET LOCAL session_replication_role=replica");
      await tx.query("UPDATE cloud_workspace_generations SET image_ref=$2 WHERE workspace_id=$1", [fixture.workspaceId, named.image_ref]);
      await tx.query("COMMIT");
    } catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }
    await expect(withSystemTx(pool, tx => requireSupportedCloudWorkspaceGeneration(tx, scope(fixture)))).resolves.toBeDefined();
    const user = await ensureUser(pool, { provider: "workos", providerSubject: `workos|${fixture.userId}`,
      email: `durable-${fixture.userId}@example.test`, displayName: "Owner" });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", user); await next(); });
    app.route("/", createCloudWorkspaceRoutes(pool, null, { workosEnabled: false }));
    const response = await app.request(`/v1/cloud-workspaces/${fixture.workspaceId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).workspace.error?.code).not.toBe("cloud_workspace_v2_required");
  });
  it("keeps separate supported workspace sources when a test has multiple owners", async () => {
    const one = await seedReadyCloudWorkspace(pool), two = await seedReadyCloudWorkspace(pool);
    const first = await withSystemTx(pool, tx => requireSupportedCloudWorkspaceGeneration(tx, scope(one)));
    const second = await withSystemTx(pool, tx => requireSupportedCloudWorkspaceGeneration(tx, scope(two)));
    expect(first.source.configId).not.toBe(second.source.configId);
    expect(first.runtimePin).toEqual(second.runtimePin);
  });
  it("seeds another exact generation without reusing the organization's Computer version", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await withSystemTx(pool, tx => seedSupportedCloudWorkspaceGeneration(tx, { ...fixture, ownerUserId: fixture.userId, generation: 2 }));
    const first = await withSystemTx(pool, tx => requireSupportedCloudWorkspaceGeneration(tx, scope(fixture)));
    const second = await withSystemTx(pool, tx => requireSupportedCloudWorkspaceGeneration(tx, { ...fixture, generation: 2 }));
    expect(second.source.configId).not.toBe(first.source.configId);
    expect(second.runtimePin).toEqual(first.runtimePin);
  });
  it.each([{ runtimeV4: false }, { runtimeV4: true, supportedGeneration: false }])("refuses saved historical execution %j without rewriting its source or pin", async options => {
    const fixture = await seedReadyCloudWorkspace(pool, options);
    const before = (await pool.query("SELECT runtime_id,image_ref FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rows;
    await expect(withSystemTx(pool, tx => requireSupportedCloudWorkspaceGeneration(tx, scope(fixture))))
      .rejects.toMatchObject({ code: "cloud_workspace_v2_required" });
    expect((await pool.query("SELECT runtime_id,image_ref FROM cloud_workspace_generations WHERE workspace_id=$1", [fixture.workspaceId])).rows).toEqual(before);
    expect((await pool.query("SELECT 1 FROM cloud_workspace_computer_sources WHERE workspace_id=$1", [fixture.workspaceId])).rowCount).toBe(0);
  });
  it.each(["no-source", "invalid-template", "invalid-manifest", "scalar-manifest"])("projects %s v4 as non-executing while retaining its catalog and management authority", async kind => {
    const fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: true, supportedGeneration: kind !== "no-source" });
    if (kind === "invalid-template") await pool.query("UPDATE cloud_computer_templates SET state='quarantined'");
    if (kind === "invalid-manifest" || kind === "scalar-manifest") {
      const owner = await pool.connect();
      try {
        await owner.query("BEGIN");
        await owner.query("SET LOCAL session_replication_role=replica");
        await owner.query("UPDATE cloud_computer_v2_builds SET repository_manifest=$1::jsonb", [JSON.stringify(kind === "invalid-manifest" ? [null] : ["invalid"])]);
        await owner.query("COMMIT");
      } catch (error) { await owner.query("ROLLBACK"); throw error; }
      finally { owner.release(); }
    }
    const user = await ensureUser(pool, { provider: "workos", providerSubject: `workos|${fixture.userId}`,
      email: `durable-${fixture.userId}@example.test`, displayName: "Owner" });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("user", user); await next(); });
    app.route("/", createCloudWorkspaceRoutes(pool, null, { workosEnabled: false }));
    app.onError((error, c) => {
      if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status);
      throw error;
    });
    const response = await app.request(`/v1/cloud-workspaces/${fixture.workspaceId}`);
    expect(response.status).toBe(200);
    const document = (await response.json()).workspace;
    expect(document).toMatchObject({ id: fixture.workspaceId, error: { code: "cloud_workspace_v2_required" },
      capabilities: { canWrite: false, canEdit: false, canManage: true, canStart: false, startUnavailableReason: "cloud_workspace_v2_required" } });
    const list = await app.request("/v1/cloud-workspaces");
    expect(list.status).toBe(200);
    expect((await list.json()).workspaces).toHaveLength(1);
  });
});
