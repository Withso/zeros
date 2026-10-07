import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthedUser } from "../auth.js";
import { HttpError } from "../authz.js";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import { DatabaseCloudWorkspaceSetupMaterialService } from "./setup-materials.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { reserveWriterSlot } from "./pro-sharing.js";
import { copyGenerationPins } from "./generation-pins.js";
import {
  ensureCloudPilotUser, seedReadyProCloudWorkspace,
  withCloudFixtureOwnerTx, type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

d("passive cloud workspace UI metadata", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;
  let actorId: string;
  let app: Hono;
  let materials: DatabaseCloudWorkspaceSetupMaterialService;
  const path = () => `/v1/organizations/${fixture.organizationId}/cloud-workspaces/${fixture.workspaceId}`;
  const request = (suffix = "", input?: { name: string; version: number }, key = randomUUID()) => app.request(`${path()}${suffix}`, {
    method: input ? "PATCH" : "GET",
    headers: input ? { "content-type": "application/json", "idempotency-key": key } : {},
    body: input ? JSON.stringify(input) : undefined,
  });
  const document = async () => {
    const result = await request();
    expect(result.status).toBe(200);
    return (await result.json()).workspace;
  };
  const ports = () => request("/detected-ports?generation=1");
  const heartbeat = (observedPorts?: Array<{ port: number; protocol: "tcp" }>) => materials.heartbeat({
    token: fixture.heartbeatToken, workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    generation: 1, engineInstanceId: fixture.engineInstanceId,
    ...(observedPorts === undefined ? {} : { observedPorts }),
  });
  const collaborator = async (role: "viewer" | "developer" | "manager") => {
    const user = await ensureCloudPilotUser(pool, {
      provider: "workos", providerSubject: `user_${randomUUID()}`,
      email: `member-${randomUUID()}@example.test`, displayName: "Collaborator",
    });
    await withCloudFixtureOwnerTx(pool, async tx => {
      await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [fixture.organizationId, user.id]);
      await tx.query("INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES($1,$2,'active')", [fixture.organizationId, user.id]);
      await tx.query(`INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source)
        VALUES($1,'pro','active',true,'operator')`, [user.id]);
      await tx.query("INSERT INTO cloud_workspace_members(workspace_id,org_id,user_id,role) VALUES($1,$2,$3,$4)",
        [fixture.workspaceId, fixture.organizationId, user.id, role]);
      if (role !== "viewer") await reserveWriterSlot(tx, fixture.workspaceId, { userId: user.id });
    });
    return user.id;
  };

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedReadyProCloudWorkspace(pool);
    await withSystemTx(pool, tx => tx.query(`INSERT INTO workos_organization_links
      (organization_id,workos_organization_id,external_id,state) VALUES($1::uuid,$2,$1::uuid::text,'active')`,
    [fixture.organizationId, `org_${fixture.organizationId}`]));
    actorId = fixture.userId;
    app = new Hono();
    app.use("*", async (c, next) => { c.set("user", { id: actorId } as AuthedUser); await next(); });
    app.route("/", createCloudWorkspaceRoutes(pool, null));
    app.onError((error, c) => {
      if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status);
      throw error;
    });
    materials = new DatabaseCloudWorkspaceSetupMaterialService({
      pool, setupAudience: "https://fixture.test/setup", engineRegistrationAudience: "https://fixture.test/register",
      engineHeartbeatAudience: "https://fixture.test/heartbeat", engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
      enginePort: 39393, setupSecretKeyV1: Buffer.alloc(32).toString("base64url"),
      github: { mint: async () => { throw new Error("Unexpected repository request"); }, revoke: async () => undefined },
      accountIdentityProvider: "workos", accountAuth: {
        jwksUrl: "https://fixture.test/jwks", audience: "https://fixture.test", issuers: ["https://fixture.test/"],
        contract: "zeros-access-v1", clientId: "client_fixture",
      },
    });
  });

  it("keeps unknown scans unknown and records the first confirmed empty scan", async () => {
    expect((await ports()).status).toBe(200);
    expect(await (await ports()).json()).toMatchObject({ generation: 1, status: "ready", observedAt: null, ports: null });
    await heartbeat();
    expect(await (await ports()).json()).toMatchObject({ observedAt: null, ports: null });
    await heartbeat([]);
    expect(await (await ports()).json()).toMatchObject({
      version: 1, organizationId: fixture.organizationId, workspaceId: fixture.workspaceId,
      observedAt: expect.any(String), ports: [],
    });
  });

  it("returns only bounded active TCP observations and closes disappeared listeners", async () => {
    await heartbeat([{ port: 3000, protocol: "tcp" }, { port: 4000, protocol: "tcp" }]);
    await pool.query("UPDATE workspace_ports SET process_label=$2 WHERE workspace_id=$1 AND port=3000", [fixture.workspaceId, `App\t${"x".repeat(116)}`]);
    const observed = await (await ports()).json();
    expect(observed.ports.map((port: { port: number }) => port.port)).toEqual([3000, 4000]);
    expect(observed.ports[0].processLabel).toHaveLength(119);
    expect(observed.ports[0].processLabel).not.toContain("\t");
    await heartbeat([{ port: 4000, protocol: "tcp" }]);
    expect((await (await ports()).json()).ports.map((port: { port: number }) => port.port)).toEqual([4000]);
    await pool.query(`INSERT INTO workspace_ports(workspace_id,generation,org_id,port,protocol,health,observed_at)
      SELECT $1,1,$2,value,'tcp','observed',now() FROM generate_series(5000,5129) value`, [fixture.workspaceId, fixture.organizationId]);
    expect((await (await ports()).json()).ports).toHaveLength(128);
    await heartbeat([]);
    expect((await (await ports()).json()).ports).toEqual([]);
  });

  it("rejects a generation mismatch and invalid query without exposing replacement observations", async () => {
    await heartbeat([{ port: 3000, protocol: "tcp" }]);
    await withSystemTx(pool, async tx => {
      const provider = (await tx.query<{ provider_connection_id: string }>(
        "SELECT provider_connection_id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1", [fixture.workspaceId])).rows[0]!;
      await copyGenerationPins(tx, { ...fixture, sourceGeneration: 1, targetGeneration: 2, actorUserId: fixture.userId,
        providerConnectionId: provider.provider_connection_id, qualificationMode: "full" });
      await tx.query("UPDATE cloud_workspaces SET current_generation=2 WHERE id=$1", [fixture.workspaceId]);
    });
    const stale = await ports();
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "cloud_workspace_generation_changed" } });
    expect(await (await request("/detected-ports?generation=2")).json()).toMatchObject({ generation: 2, ports: null });
    expect((await request("/detected-ports?generation=0")).status).toBe(422);
    expect((await request("/detected-ports?generation=1.5")).status).toBe(422);
    expect((await request("/detected-ports")).status).toBe(422);
  });

  it("authorizes reads by exact workspace, including stopped data, with no engine renewal", async () => {
    await heartbeat([]);
    actorId = await collaborator("viewer");
    expect((await ports()).status).toBe(200);
    await pool.query("UPDATE cloud_workspaces SET status='stopped',desired_state='stopped' WHERE id=$1", [fixture.workspaceId]);
    const before = (await pool.query("SELECT last_heartbeat_at,lease_expires_at FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0];
    expect(await (await ports()).json()).toMatchObject({ status: "stopped", ports: [] });
    expect((await pool.query("SELECT last_heartbeat_at,lease_expires_at FROM cloud_workspace_engine_instances WHERE id=$1", [fixture.engineInstanceId])).rows[0]).toEqual(before);
    actorId = (await seedReadyProCloudWorkspace(pool)).userId;
    expect((await ports()).status).toBe(404);
    expect((await app.request(path().replace(fixture.organizationId, randomUUID()) + "/detected-ports?generation=1")).status).toBe(404);
  });

  it("rejects an expired engine heartbeat without marking an empty scan as confirmed", async () => {
    await pool.query(`UPDATE cloud_workspace_engine_instances
      SET last_heartbeat_at=clock_timestamp()-interval '2 minutes',lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE id=$1`, [fixture.engineInstanceId]);
    await expect(heartbeat([])).rejects.toMatchObject({ code: "engine_heartbeat_rejected" });
    expect(await (await ports()).json()).toMatchObject({ observedAt: null, ports: null });
  });

  it("renames metadata once under CAS while preserving repository, generation and lifecycle", async () => {
    const initial = await document();
    const key = randomUUID();
    const input = { name: "  New Display Name  ", version: initial.version };
    const result = await request("", input, key);
    expect(result.status).toBe(200);
    expect((await result.json()).workspace).toMatchObject({ name: "New Display Name", version: initial.version + 1,
      repository: initial.repository, generation: initial.generation, status: initial.status, desiredState: initial.desiredState });
    const replay = await request("", input, key);
    expect(replay.status).toBe(200);
    expect((await replay.json()).workspace).toMatchObject({ name: "New Display Name", version: initial.version + 1 });
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].count).toBe("0");
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_metadata_requests WHERE workspace_id=$1", [fixture.workspaceId])).rows[0].count).toBe("1");
    expect((await request("", { name: "Changed payload", version: initial.version }, key)).status).toBe(409);
    const conflict = await request("", { name: "Stale mutation", version: initial.version });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "cloud_workspace_version_conflict" } });
    expect((await document()).name).toBe("New Display Name");
  });

  it("preserves no-op versions and never lets a retry overwrite a later rename", async () => {
    const initial = await document();
    const noop = await request("", { name: initial.name, version: initial.version });
    expect((await noop.json()).workspace.version).toBe(initial.version);
    const key = randomUUID(), first = { name: "First", version: initial.version };
    expect((await request("", first, key)).status).toBe(200);
    expect((await request("", { name: "Later", version: initial.version + 1 })).status).toBe(200);
    expect((await (await request("", first, key)).json()).workspace).toMatchObject({ name: "Later", version: initial.version + 2 });
  });

  it("serializes competing CAS writes and identical concurrent retries", async () => {
    const initial = await document();
    const competing = await Promise.all([
      request("", { name: "Left", version: initial.version }),
      request("", { name: "Right", version: initial.version }),
    ]);
    expect(competing.map(result => result.status).sort()).toEqual([200, 409]);
    const current = await document(), key = randomUUID();
    const retry = { name: "Same retry", version: current.version };
    const identical = await Promise.all([request("", retry, key), request("", retry, key)]);
    expect(identical.map(result => result.status)).toEqual([200, 200]);
    expect((await document()).version).toBe(current.version + 1);
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_metadata_requests WHERE org_id=$1 AND idempotency_key=$2", [fixture.organizationId, key])).rows[0].count).toBe("1");
  });

  it("allows managers while refusing viewer/developer, outsiders and revoked receipt replay", async () => {
    const version = (await document()).version;
    for (const role of ["viewer", "developer"] as const) {
      actorId = await collaborator(role);
      expect((await request("", { name: "Forbidden", version })).status).toBe(403);
    }
    const managerId = await collaborator("manager");
    actorId = managerId;
    const key = randomUUID(), input = { name: "Managed", version };
    expect((await request("", input, key)).status).toBe(200);
    await pool.query("DELETE FROM cloud_workspace_members WHERE workspace_id=$1 AND user_id=$2", [fixture.workspaceId, managerId]);
    expect((await request("", input, key)).status).toBe(403);
    actorId = (await seedReadyProCloudWorkspace(pool)).userId;
    expect((await request("", { name: "Outside", version: version + 1 })).status).toBe(404);
    expect((await withUserTx(pool, fixture.userId, tx => tx.query("SELECT * FROM cloud_workspace_metadata_requests"))).rows).toEqual([]);
  });

  it("scopes idempotency to the organization and refuses reuse by a different workspace or actor", async () => {
    const version = (await document()).version, key = randomUUID();
    const input = { name: "First", version };
    expect((await request("", input, key)).status).toBe(200);
    actorId = await collaborator("manager");
    expect((await request("", input, key)).status).toBe(409);
    actorId = fixture.userId;
    const otherId = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query(`INSERT INTO cloud_workspaces(id,org_id,team_id,created_by,owner_user_id,assignee_user_id,display_name,
        repository_forge,repository_owner,repository_name,repository_revision,repository_id,current_billing_epoch)
        SELECT $2,org_id,team_id,created_by,owner_user_id,assignee_user_id,'Other',repository_forge,repository_owner,repository_name,repository_revision,repository_id,current_billing_epoch
        FROM cloud_workspaces WHERE id=$1`, [fixture.workspaceId, otherId]);
      await tx.query("INSERT INTO cloud_workspace_members(workspace_id,org_id,user_id,role) VALUES($1,$2,$3,'owner')", [otherId, fixture.organizationId, fixture.userId]);
      await tx.query(`INSERT INTO workspace_billing_epochs(workspace_id,billing_epoch,org_id,billing_owner_user_id,
        entitlement_scope,entitlement_plan,entitlement_revision,created_by)
        SELECT $2,billing_epoch,org_id,billing_owner_user_id,entitlement_scope,entitlement_plan,entitlement_revision,created_by
        FROM workspace_billing_epochs WHERE workspace_id=$1 AND ended_at IS NULL`, [fixture.workspaceId, otherId]);
      await tx.query(`INSERT INTO cloud_workspace_generations
        (workspace_id,generation,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,
         created_by,provider_connection_id,runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,
         runtime_profile,runtime_engine_protocol_version)
        SELECT $2,1,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,
         created_by,provider_connection_id,runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,
         runtime_profile,runtime_engine_protocol_version FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`,
      [fixture.workspaceId, otherId]);
      await tx.query(`INSERT INTO cloud_workspace_computer_sources(workspace_id,generation,org_id,build_id,template_id,config_id,checkout_source)
        SELECT $2,1,org_id,build_id,template_id,config_id,checkout_source FROM cloud_workspace_computer_sources
        WHERE workspace_id=$1 AND generation=1`, [fixture.workspaceId, otherId]);
    });
    const different = await app.request(path().replace(fixture.workspaceId, otherId), {
      method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(input),
    });
    expect(different.status).toBe(409);
  });

  it("rejects malformed names, versions and missing keys before persisting metadata", async () => {
    const version = (await document()).version;
    for (const name of ["", " ", "x".repeat(121), "bad\nname", "\nGood", "Good\t"]) expect((await request("", { name, version })).status).toBe(422);
    expect((await request("", { name: "Good", version: -1 })).status).toBe(422);
    expect((await app.request(path(), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Good", version }) })).status).toBe(422);
    expect((await pool.query("SELECT count(*) FROM cloud_workspace_metadata_requests")).rows[0].count).toBe("0");
  });

  it("projects only a bounded creator label through an authorized document", async () => {
    expect((await document()).createdByDisplayName).toBe("Durable Workspace Owner");
    await pool.query("UPDATE users SET display_name=$2 WHERE id=$1", [fixture.userId, `Creator\t${"x".repeat(130)}`]);
    actorId = await collaborator("viewer");
    expect((await document()).createdByDisplayName).toHaveLength(120);
    await pool.query("UPDATE users SET display_name=NULL WHERE id=$1", [fixture.userId]);
    expect((await document()).createdByDisplayName).toBeNull();
    actorId = (await seedReadyProCloudWorkspace(pool)).userId;
    expect((await request()).status).toBe(404);
  });
});
