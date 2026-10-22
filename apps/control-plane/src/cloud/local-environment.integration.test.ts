import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUser } from "../auth.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudAgentCredentialService } from "../agent-credentials/agent-credentials.js";
import { cloudAgentModels } from "../agent-credentials/agent-models.js";
import { bindFixture } from "../../../../scripts/dev-environment/hosted-fixtures.mjs";
import { seedLocalFixture } from "../../../../scripts/dev-environment/local-fixtures.mjs";
import { drainLocalCloudResources } from "../../../../scripts/dev-environment/local-cleanup.mjs";
import { inventoryLocalWorkspaces } from "../../../../scripts/dev-environment/database.mjs";
import { cloudV2SandboxName, cloudV2SnapshotName } from "./resource-names.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const owner = "a".repeat(24), instanceId = "11111111-1111-4111-8111-111111111111";
const organizationId = "33333333-3333-4333-8333-333333333333";
const encryptionKey = Buffer.alloc(32, 7).toString("base64url");
const sandboxName = (kind: "build" | "ws", id: string) => cloudV2SandboxName("development", kind, id, owner);
const snapshotName = (org: string, version: number) => cloudV2SnapshotName("development", org, version, owner);

database("cloud:local seed and confirmed resource drain", () => {
  let pool: pg.Pool, runtime: pg.Pool, vault: DatabaseCloudAgentCredentialService;
  const role = `cloud_local_test_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 });
    const password = randomBytes(24).toString("hex");
    await pool.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOBYPASSRLS PASSWORD ${pg.escapeLiteral(password)}`);
    await pool.query(`GRANT zeros_app TO ${role}`);
    const target = new URL(process.env.TEST_DATABASE_URL!);
    target.username = role; target.password = password;
    runtime = new pg.Pool({ connectionString: target.toString(), max: 2 });
    vault = new DatabaseCloudAgentCredentialService(runtime, { keys: { 1: encryptionKey }, currentKeyVersion: 1 });
  });
  afterAll(async () => {
    await runtime?.end();
    if (pool) {
      await pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
      await pool.end();
    }
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await pool.query(`CREATE TABLE zeros_cloud_local_identity(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),owner text NOT NULL,instance_id uuid NOT NULL)`);
    await pool.query("INSERT INTO zeros_cloud_local_identity(owner,instance_id) VALUES($1,$2)", [owner, instanceId]);
    // Production's local runtime inherits public USAGE from zeros_app. Keep
    // this NOINHERIT test login stricter and grant only the marker read here.
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON zeros_cloud_local_identity TO ${role}`);
  });

  function seedRequest() {
    const fixture = bindFixture({}, { workosUserId: "user_localfixture", workosOrganizationId: "org_localfixture",
      expectedEmail: "local-fixture@example.test", expectedOrganizationSlug: "local-fixture", computeAllowance: "pro-monthly", bootstrapOrganization: true });
    return { owner, instanceId, fixture, encryptionKey,
      fixtureProof: { userId: fixture.workosUserId, email: fixture.expectedEmail, organizationId: fixture.workosOrganizationId,
        externalId: organizationId, name: "Local fixture", membershipId: "om_localfixture", membershipUpdatedAt: new Date().toISOString(), verifiedAt: Date.now() },
      githubProof: { installationId: 123, appId: 456, repository: "example/project", accountLogin: "example", accountType: "Organization",
        targetType: "Organization", allRepositories: false, createdAt: new Date().toISOString(), verifiedAt: Date.now() },
      credentials: [
        { provider: "claude", material: { kind: "claude-api-key", apiKey: "claude-local-fixture-value" } },
        { provider: "codex", material: { kind: "codex-api-key", apiKey: "codex-local-fixture-value" } },
        { provider: "cursor", material: { kind: "cursor-api-key", apiKey: "cursor-local-fixture-value" } },
      ],
    };
  }
  const seed = (request = seedRequest()) => seedLocalFixture({ runtime, migration: pool, withSystemTx, request, vault, models: cloudAgentModels });
  const signIn = () => ensureUser(pool, { provider: "workos", providerSubject: "user_localfixture", email: "local-fixture@example.test", displayName: "Fixture" });

  it("waits for normal sign-in, then seeds an idempotent bounded fixture through the real vault", async () => {
    const request = seedRequest();
    await expect(seed(request)).resolves.toEqual({ seeded: false, needsSignIn: true });
    expect((await pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n).toBe(0);
    const user = await signIn();
    const result = { seeded: true, userId: user.id, organizationId, providers: ["claude", "codex", "cursor"] };
    await expect(seed(request)).resolves.toEqual(result);
    const first = await vault.organizationConnections(user.id, organizationId);
    expect(first.connections).toHaveLength(3);
    expect(first.connections.every(row => row.connected)).toBe(true);
    await expect(seed(request)).resolves.toEqual(result);
    const repeated = await vault.organizationConnections(user.id, organizationId);
    expect(repeated.credentials).toEqual(first.credentials);
    expect(repeated.connections).toEqual(first.connections.map(row => ({ ...row, health: { ...row.health, observedAt: expect.any(String) } })));
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_agent_credential_versions")).rows[0].n).toBe(3);
    expect((await pool.query("SELECT cloud_workspaces_allowed FROM organizations WHERE id=$1", [organizationId])).rows[0].cloud_workspaces_allowed).toBe(true);
    expect((await pool.query("SELECT role,workos_membership_id FROM organization_members WHERE org_id=$1", [organizationId])).rows).toEqual([{ role: "owner", workos_membership_id: "om_localfixture" }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM teams WHERE org_id=$1", [organizationId])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_github_connections WHERE org_id=$1", [organizationId])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT staff_role FROM users WHERE id=$1", [user.id])).rows[0].staff_role).toBeNull();
    expect((await pool.query("SELECT valid_until FROM account_entitlements WHERE user_id=$1", [user.id])).rows[0].valid_until.toISOString()).toBe(request.fixture.endsAt);
    const connection = first.connections.find(row => row.provider === "claude")!;
    await vault.setOrganizationConnection(user.id, organizationId, "claude", { expectedRevision: connection.revision, credentialId: null });
    await seed(request);
    expect((await vault.organizationConnections(user.id, organizationId)).connections.find(row => row.provider === "claude")?.credentialId).toBeNull();
  });

  it("refuses expired provider proofs and conflicting local ownership", async () => {
    await signIn();
    const request = seedRequest();
    await expect(seed({ ...request, fixtureProof: { ...request.fixtureProof, verifiedAt: Date.now() - 120_000 } })).rejects.toThrow(/proof/);
    await seed(request);
    await pool.query("UPDATE organizations SET slug='different' WHERE id=$1", [organizationId]);
    await expect(seed(request)).rejects.toThrow(/conflicts/);
    expect((await pool.query("SELECT slug FROM organizations WHERE id=$1", [organizationId])).rows[0].slug).toBe("different");
  });

  async function resources() {
    const user = await signIn(); await seed({ ...seedRequest(), credentials: [] });
    const workspaceId = randomUUID(), buildId = randomUUID(), snapshot = snapshotName(organizationId, 1);
    await pool.query(`INSERT INTO cloud_v2_computer_builds(id,org_id,version,recipe,state,builder_sandbox_id,snapshot_id,created_by)
      VALUES($1,$2,1,'{}','succeeded','bx_33333333',$3,$4)`, [buildId, organizationId, snapshot, user.id]);
    await pool.query("INSERT INTO cloud_v2_computers(org_id,active_build_id,snapshot_name) VALUES($1,$2,$3)", [organizationId, buildId, snapshot]);
    await pool.query(`INSERT INTO cloud_v2_workspaces(id,org_id,creator_user_id,name,repository,branch,base_branch,state,boat_sandbox_id,worker_token_hash)
      VALUES($1,$2,$3,'Test','example/project','work','main','running','bx_22222222',$4)`, [workspaceId, organizationId, user.id, randomBytes(32)]);
    await pool.query("INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,expires_at) VALUES($1,$2,'proxy',now()+interval '1 hour')", [randomBytes(32), workspaceId]);
    const rows = new Map<string, unknown>([
      ["/sandboxes/bx_22222222", { sandbox: { id: "bx_22222222", name: sandboxName("ws", workspaceId) } }],
      ["/sandboxes/bx_33333333", { sandbox: { id: "bx_33333333", name: sandboxName("build", buildId) } }],
      [`/named-snapshots/${snapshot}`, { snapshot: { name: snapshot, status: "ready" } }],
      ["/sandboxes/bx_44444444", { sandbox: { id: "bx_44444444", name: "unrelated-alpha-workspace" } }],
    ]);
    const fail = new Set<string>(), sticky = new Set<string>();
    const provider = { request: vi.fn(async (path: string, input: { method?: string; confirmDelete?: string } = {}) => {
      expect(["GET", "DELETE"]).toContain(input.method ?? "GET");
      if (path.startsWith("/sandboxes?")) return { sandboxes: [...rows].filter(([key]) => key.startsWith("/sandboxes/")).map(([, value]) => (value as { sandbox: unknown }).sandbox), pageInfo: { hasMore: false } };
      if (input.method === "DELETE") {
        expect(input.confirmDelete).toBe(path.split("/").at(-1));
        // Provider deletion must follow the durable fence, including tokens.
        expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_tokens")).rows[0].n).toBe(0);
        expect((await pool.query("SELECT worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [workspaceId])).rows[0].worker_token_hash).toBeNull();
        if (fail.has(path)) throw new Error("provider unavailable");
        if (!sticky.has(path)) rows.delete(path);
        return { ok: true };
      }
      if (!rows.has(path)) throw Object.assign(new Error("gone"), { code: "provider_not_found", httpStatus: 404 });
      return rows.get(path);
    }) };
    const drain = (overrides = {}) => drainLocalCloudResources({ runtime, withSystemTx, request: { owner, instanceId, backendStopped: true, ...overrides }, provider, sandboxName, snapshotName });
    return { workspaceId, buildId, snapshot, rows, provider, fail, sticky, drain };
  }

  it("deletes only this instance's VM, builder and snapshot and persists confirmed absence", async () => {
    const f = await resources();
    await expect(f.drain()).resolves.toEqual({ complete: true, pending: 0 });
    expect([...f.rows.keys()]).toEqual(["/sandboxes/bx_44444444"]);
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0].state).toBe("deleted");
    const build = (await pool.query("SELECT builder_deleted_at,snapshot_deleted_at,cleanup_requested_at,snapshot_id FROM cloud_v2_computer_builds WHERE id=$1", [f.buildId])).rows[0];
    expect(build).toMatchObject({ builder_deleted_at: expect.any(Date), snapshot_deleted_at: expect.any(Date), cleanup_requested_at: expect.any(Date), snapshot_id: null });
    expect((await pool.query("SELECT active_build_id,snapshot_name FROM cloud_v2_computers")).rows).toEqual([{ active_build_id: null, snapshot_name: null }]);
    await expect(f.drain()).resolves.toEqual({ complete: true, pending: 0 });
  });

  it("counts RLS-protected workspaces for the local inventory", async () => {
    const f = await resources();
    await expect(inventoryLocalWorkspaces(runtime, withSystemTx)).resolves.toEqual({ remainingWorkspaces: 1 });
    await f.drain();
    await expect(inventoryLocalWorkspaces(runtime, withSystemTx)).resolves.toEqual({ remainingWorkspaces: 0 });
  });

  it("keeps failed or merely accepted deletes pending and recovers after a lost delete response", async () => {
    const f = await resources(), path = "/sandboxes/bx_22222222";
    f.fail.add(path);
    expect(await f.drain()).toMatchObject({ complete: false, pending: 1 });
    expect((await pool.query("SELECT state,boat_sandbox_id FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0]).toEqual({ state: "deleting", boat_sandbox_id: "bx_22222222" });
    f.fail.clear(); f.sticky.add(path);
    expect(await f.drain()).toMatchObject({ complete: false, pending: 1 });
    f.rows.delete(path); // Provider completed while the launcher was down.
    await expect(f.drain()).resolves.toEqual({ complete: true, pending: 0 });
  });

  it("recovers a lost create id by exact names from complete inventory without creating anything", async () => {
    const f = await resources();
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id=NULL,state='failed' WHERE id=$1", [f.workspaceId]);
    await pool.query("UPDATE cloud_v2_computer_builds SET builder_sandbox_id=NULL,builder_create_pending=true,operation_until=now()-interval '1 second' WHERE id=$1", [f.buildId]);
    await expect(f.drain()).resolves.toEqual({ complete: true, pending: 0 });
    expect([...f.rows.keys()]).toEqual(["/sandboxes/bx_44444444"]);
  });

  it("fences in-flight builds and retains their resources until the provider operation settles", async () => {
    const f = await resources();
    await pool.query("UPDATE cloud_v2_computer_builds SET state='building',operation_until=now()+interval '35 minutes' WHERE id=$1", [f.buildId]);
    expect(await f.drain()).toEqual({ complete: false, pending: 1 });
    expect((await pool.query("SELECT state,cleanup_requested_at FROM cloud_v2_computer_builds WHERE id=$1", [f.buildId])).rows[0]).toMatchObject({ state: "cancelled", cleanup_requested_at: expect.any(Date) });
    expect(f.rows.has(`/named-snapshots/${f.snapshot}`)).toBe(true);
    await pool.query("UPDATE cloud_v2_computer_builds SET operation_until=now()-interval '1 second' WHERE id=$1", [f.buildId]);
    await expect(f.drain()).resolves.toEqual({ complete: true, pending: 0 });
  });

  it("keeps a claimed workspace create pending until its dispatch horizon expires", async () => {
    const f = await resources();
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id=NULL,state='creating',next_attempt_at=now()+interval '2 minutes' WHERE id=$1", [f.workspaceId]);
    expect(await f.drain()).toEqual({ complete: false, pending: 1 });
    expect(f.rows.has("/sandboxes/bx_22222222")).toBe(true);
    const first = (await pool.query("SELECT next_attempt_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0].next_attempt_at;
    expect(await f.drain()).toEqual({ complete: false, pending: 1 });
    expect((await pool.query("SELECT next_attempt_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId])).rows[0].next_attempt_at).toEqual(first);
    await pool.query("UPDATE cloud_v2_workspaces SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [f.workspaceId]);
    await expect(f.drain()).resolves.toEqual({ complete: true, pending: 0 });
  });

  it("retains a snapshot pointer outside the instance namespace for operator reconciliation", async () => {
    const f = await resources(), other = "zeros-alpha-foreign-v1";
    await pool.query("UPDATE cloud_v2_computer_builds SET snapshot_id=$2 WHERE id=$1", [f.buildId, other]);
    await pool.query("UPDATE cloud_v2_computers SET snapshot_name=$1", [other]);
    expect(await f.drain()).toEqual({ complete: false, pending: 1 });
    expect(f.provider.request.mock.calls.some(([path]) => path === `/named-snapshots/${other}`)).toBe(false);
    expect((await pool.query("SELECT snapshot_name FROM cloud_v2_computers")).rows[0].snapshot_name).toBe(other);
  });

  it("refuses a foreign receipt or resource name without touching that resource", async () => {
    const f = await resources();
    await expect(f.drain({ instanceId: randomUUID() })).rejects.toThrow(/another instance/);
    expect(f.provider.request).not.toHaveBeenCalled();
    f.rows.set("/sandboxes/bx_22222222", { sandbox: { id: "bx_22222222", name: "unrelated-alpha-workspace" } });
    expect(await f.drain()).toEqual({ complete: false, pending: 1 });
    expect(f.rows.has("/sandboxes/bx_22222222")).toBe(true);
  });
});
