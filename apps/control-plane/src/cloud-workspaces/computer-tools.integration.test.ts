import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import { withSystemTx, withUserTx, type Tx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudAgentExecutionService } from "./agent-executions.js";
import { createCloudAgentExecutionRoutes, CLOUD_AGENT_EXECUTION_PATH } from "./agent-credential-routes.js";
import { adminComputerToolsVersion, markAdminWorkspace } from "./computer-admin-workspaces.js";
import { computerToolOperationId, type UpdateRepositorySetupScript } from "./computer-tools.js";
import { seedComputerToolsFixture } from "./computer-tools-test-fixture.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import type { CloudComputerToolRequest } from "./computer-tools-contract.js";
import { DatabaseCloudWorkspaceCollaborationService } from "./actors.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("admin workspace computer tools", () => {
  let pool: pg.Pool, f: Awaited<ReturnType<typeof seedComputerToolsFixture>>;
  let service: DatabaseCloudAgentExecutionService;
  let setup: ReturnType<typeof vi.fn<UpdateRepositorySetupScript>>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => { await pool.end(); });
  async function initialize(marked = true) {
    await resetMigratedTestDatabase(pool);
    f = await seedComputerToolsFixture(pool, marked);
    const receipts = new Map<string, { request: string; version: number }>();
    // C4 is injected: this database-backed substitute verifies the narrow
    // transaction contract without introducing a second production writer.
    setup = vi.fn(async (input: Parameters<UpdateRepositorySetupScript>[0], tx: Tx) => {
      const old = receipts.get(input.operationId);
      if (old) {
        if (old.request !== JSON.stringify(input)) throw new HttpError(409, "changed", "Changed");
        return { version: old.version };
      }
      const head = (await tx.query<{ current_version: string; document: Record<string, unknown> }>(`SELECT head.current_version,version.document
        FROM repository_settings_heads head JOIN repository_settings_versions version ON version.org_id=head.org_id
          AND version.repository_id=head.repository_id AND version.scope=head.scope AND version.version=head.current_version
        WHERE head.org_id=$1 AND head.repository_id=$2 AND head.scope='cloud' FOR UPDATE OF head`, [input.orgId, input.repositoryId])).rows[0];
      if (Number(head?.current_version ?? 0) !== input.expectedSettingsVersion) throw new HttpError(409, "changed", "Changed");
      const version = input.expectedSettingsVersion + 1;
      await tx.query(`INSERT INTO repository_settings_versions(org_id,repository_id,scope,version,document,created_by)
        VALUES($1,$2,'cloud',$3,$4::jsonb,$5)`, [input.orgId, input.repositoryId, version,
        JSON.stringify({ ...head?.document, setupCommands: input.script ? [{ command: input.script, timeoutSeconds: input.timeoutSeconds }] : [] }), input.actorUserId]);
      await tx.query(`INSERT INTO repository_settings_heads(org_id,repository_id,scope,current_version) VALUES($1,$2,'cloud',$3)
        ON CONFLICT(org_id,repository_id,scope) DO UPDATE SET current_version=EXCLUDED.current_version`, [input.orgId, input.repositoryId, version]);
      receipts.set(input.operationId, { request: JSON.stringify(input), version });
      return { version };
    });
    service = new DatabaseCloudAgentExecutionService(pool, f.encryption, false, undefined, { computer: f.computer, updateRepositorySetupScript: setup });
  }
  beforeEach(() => initialize());
  function call(tool: unknown, options: { callId?: string; leaseId?: string; scope?: Partial<typeof f.scope>; extra?: object } = {}) {
    const { heartbeatToken, ...scope } = { ...f.scope, ...options.scope };
    return createCloudAgentExecutionRoutes(service).request(CLOUD_AGENT_EXECUTION_PATH, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${heartbeatToken}` },
      body: JSON.stringify({ ...scope, request: { kind: "computer-tool", leaseId: options.leaseId ?? f.initiating.leaseId,
        toolCallId: options.callId ?? randomUUID(), tool, ...options.extra } }) });
  }
  async function ok(tool: CloudComputerToolRequest, options: Parameters<typeof call>[1] = {}) {
    const response = await call(tool, options);
    if (response.status !== 200) throw new Error(`Computer tool HTTP ${response.status}: ${await response.text()}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json()).result;
  }
  const config = () => ok({ name: "GetComputerConfiguration", arguments: { computerId: f.fixture.organizationId } });
  const create = (expectedRevision = 1, previousBuildId: string | null = null): CloudComputerToolRequest => ({ name: "CreateComputerConfiguration",
    arguments: { installScript: "echo updated", timeoutSeconds: 180, expectedRevision, previousBuildId } });
  const list = { name: "ListComputers", arguments: {} } as const;

  it("runs all five tools with exact preserved repo/env refs and no saved secret or provider metadata", async () => {
    const before = await config();
    expect(before.repositories).toEqual([{ repositoryId: f.fixture.repositoryId, owner: "withso", name: "zeros", requestedRef: null,
      settingsVersion: 0, setupCommands: [] }]);
    expect(before.environment).toEqual([{ name: "APPLICATION_SECRET", set: true }]);
    expect((await ok(list)).computers).toEqual([expect.objectContaining({ computerId: f.fixture.organizationId,
      capabilities: { computerToolsVersion: 1, configure: true, updateRepositorySetupScript: true } })]);
    const accepted = await ok(create());
    expect(accepted).toMatchObject({ revision: 2, version: 1 });
    const after = await config();
    expect(after).toMatchObject({ installScript: "echo updated", timeoutSeconds: 180, revision: 2, latestBuildId: accepted.buildId });
    const refs = await pool.query(`SELECT binding_id,binding_version FROM cloud_computer_environment_refs WHERE config_id=ANY($1::uuid[]) ORDER BY config_id`, [[before.configId, after.configId]]);
    expect(refs.rows).toHaveLength(2); expect(refs.rows[0]).toEqual(refs.rows[1]);
    expect(after.repositories).toEqual(before.repositories);
    const changed = await ok({ name: "UpdateRepositorySetupScript", arguments: { repositoryId: f.fixture.repositoryId,
      expectedSettingsVersion: 0, script: "echo setup", timeoutSeconds: 30 } }, { callId: "native-setup" });
    expect(changed).toEqual({ version: 1 });
    expect(setup.mock.calls[0]![0]).toEqual({ orgId: f.fixture.organizationId, repositoryId: f.fixture.repositoryId, expectedSettingsVersion: 0,
      script: "echo setup", timeoutSeconds: 30, actorUserId: f.fixture.userId, operationId: computerToolOperationId(f.initiating.leaseId, "native-setup") });
    const final = await config();
    expect(final.revision).toBe(2);
    expect(final.repositories[0]).toMatchObject({ settingsVersion: 1, setupCommands: [{ command: "echo setup", timeoutSeconds: 30 }] });
    expect((await pool.query("SELECT id FROM cloud_computer_v2_builds")).rowCount).toBe(1);
    await f.computer.claimNextBuild(1);
    await f.computer.appendBuildLog(accepted.buildId, 1, { stage: "install", stream: "stdout",
      text: "synthetic-org-environment-value synthetic-private-provider-key https://provider.example.test/private-access" });
    const status = await ok({ name: "GetComputerBuildStatus", arguments: { buildId: accepted.buildId } });
    expect(status).toMatchObject({ buildId: accepted.buildId, version: 1, state: "running", activated: false, cursor: 1,
      lines: [{ text: "[cloud workspace setup output withheld]" }] });
    const output = JSON.stringify([before, after, final, accepted, status]);
    for (const privateValue of ["synthetic-org-environment-value", "synthetic-private-provider-key", "zeros-v2-test-private-provider-id", "private-access", "installationId", "bindingId"])
      expect(output.includes(privateValue)).toBe(false);
  });
  it("returns 409 when the revision changed without a new build", async () => {
    await f.computer.saveDraft(f.fixture.organizationId, f.fixture.userId, { ...f.draft, installScript: "admin changed", expectedRevision: 1 });
    const response = await call(create());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ result: { conflict: true, revision: 2, latestBuildId: null } });
    expect((await pool.query("SELECT id FROM cloud_computer_v2_builds")).rowCount).toBe(0);
    expect((await config()).installScript).toBe("admin changed");
  });
  it("requires the previous build as well as revision and explicitly supersedes a pending build", async () => {
    const first = await ok(create());
    expect((await call(create(first.revision, null))).status).toBe(409);
    const second = await ok(create(first.revision, first.buildId));
    expect(second).toMatchObject({ revision: 3, version: 2 });
    expect((await ok({ name: "GetComputerBuildStatus", arguments: { buildId: first.buildId } })).state).toBe("superseded");
    await service.release(f.scope, f.initiating.leaseId);
    expect((await f.computer.getBuild(f.fixture.organizationId, f.fixture.userId, second.buildId)).state).toBe("queued");
  });
  it("replays the original C1 receipt across later edits, and rejects changed input under the same native identity", async () => {
    const first = await ok(create(), { callId: "native-build" });
    await f.computer.saveDraft(f.fixture.organizationId, f.fixture.userId, { ...f.draft, expectedRevision: first.revision, installScript: "later edit" });
    expect(await ok(create(), { callId: "native-build" })).toEqual(first);
    expect((await call({ name: "CreateComputerConfiguration", arguments: { ...create().arguments, installScript: "different" } }, { callId: "native-build" })).status).toBe(409);
    expect((await pool.query("SELECT operation_id FROM cloud_computer_v2_operations")).rows).toEqual([
      { operation_id: computerToolOperationId(f.initiating.leaseId, "native-build") },
    ]);
    expect((await config()).installScript).toBe("later edit");
  });
  it("keeps setup edits versioned without a build and forwards stable replay identity to C4", async () => {
    const tool = { name: "UpdateRepositorySetupScript", arguments: { repositoryId: f.fixture.repositoryId,
      expectedSettingsVersion: 0, script: "echo setup", timeoutSeconds: 30 } } as const;
    expect(await ok(tool, { callId: "setup-replay" })).toEqual({ version: 1 });
    expect(await ok(tool, { callId: "setup-replay" })).toEqual({ version: 1 });
    expect((await call(tool)).status).toBe(409);
    expect((await call({ ...tool, arguments: { ...tool.arguments, repositoryId: randomUUID() } })).status).toBe(403);
    expect((await config()).revision).toBe(1);
    expect((await pool.query("SELECT id FROM cloud_computer_v2_builds")).rowCount).toBe(0);
  });
  it("returns the last 200 lines and advances the polling cursor", async () => {
    const accepted = await ok(create());
    // Persisted C1/C3 log input is already redacted; use safe synthetic lines.
    await pool.query(`INSERT INTO cloud_computer_build_logs(build_id,org_id,seq,stream,stage,text)
      SELECT $1,$2,i,'system','install','safe line '||i FROM generate_series(1,240) i`, [accepted.buildId, f.fixture.organizationId]);
    const status = await ok({ name: "GetComputerBuildStatus", arguments: { buildId: accepted.buildId } });
    expect(status.lines).toHaveLength(200); expect(status.lines[0].text).toBe("safe line 41");
    expect(status).toMatchObject({ cursor: 240, truncated: true });
    expect((await ok({ name: "GetComputerBuildStatus", arguments: { buildId: accepted.buildId, after: status.cursor } })).lines).toEqual([]);
  });
  it("does not grant a capability to an ordinary workspace", async () => {
    await initialize(false);
    expect(await withSystemTx(pool, tx => adminComputerToolsVersion(tx, f.scope, f.fixture.userId, "cursor-api-key"))).toBeUndefined();
    expect((await call(list)).status).toBe(403);
  });
  it("marks the immutable creator transactionally under forced system RLS", async () => {
    const row = (await pool.query("SELECT workspace_id,org_id,creator_user_id FROM cloud_computer_admin_workspaces")).rows[0];
    expect(row).toEqual({ workspace_id: f.fixture.workspaceId, org_id: f.fixture.organizationId, creator_user_id: f.fixture.userId });
    expect(await withSystemTx(pool, tx => adminComputerToolsVersion(tx, f.scope, f.fixture.userId, "cursor-api-key"))).toBe(1);
    expect((await withUserTx(pool, f.fixture.userId, tx => tx.query("SELECT * FROM cloud_computer_admin_workspaces"))).rowCount).toBe(0);
    await expect(pool.query("UPDATE cloud_computer_admin_workspaces SET creator_user_id=$2 WHERE workspace_id=$1", [f.fixture.workspaceId, randomUUID()])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("DELETE FROM cloud_computer_admin_workspaces WHERE workspace_id=$1", [f.fixture.workspaceId])).rejects.toMatchObject({ code: "23514" });
    await expect(withSystemTx(pool, tx => markAdminWorkspace(tx, { workspaceId: f.fixture.workspaceId, orgId: randomUUID(), creatorUserId: f.fixture.userId }))).rejects.toThrow();
    const other = await seedReadyCloudWorkspace(pool);
    await pool.query("UPDATE cloud_workspaces SET sharing_mode='private' WHERE id=$1", [other.workspaceId]);
    await expect(withSystemTx(pool, async tx => {
      await markAdminWorkspace(tx, { workspaceId: other.workspaceId, orgId: other.organizationId, creatorUserId: other.userId });
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    expect((await pool.query("SELECT 1 FROM cloud_computer_admin_workspaces WHERE workspace_id=$1", [other.workspaceId])).rowCount).toBe(0);
  });
  it.each(["admin", "member"])("does not inherit creator authority for another %s collaborator", async role => {
    const other = await seedReadyCloudWorkspace(pool);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,$3)", [f.fixture.organizationId, other.userId, role]);
    await pool.query("INSERT INTO organization_seat_assignments(org_id,user_id,assigned_by) VALUES($1,$2,$3)", [f.fixture.organizationId, other.userId, f.fixture.userId]);
    await new DatabaseCloudWorkspaceCollaborationService(pool).setSharing({ workspaceId: f.fixture.workspaceId, organizationId: f.fixture.organizationId,
      actorUserId: f.fixture.userId, sharingMode: "organization", expectedRevision: 1 });
    const otherLease = await f.lease(await f.actor(other.userId));
    expect((await call(list, { leaseId: otherLease.leaseId })).status).toBe(403);
  });
  it.each(["staff", "role", "membership", "credential", "lease", "expired", "runtime", "mcp"])("rechecks %s loss between calls", async reason => {
    await ok(list);
    if (reason === "staff") await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1", [f.fixture.userId]);
    if (reason === "role") await pool.query("UPDATE organization_members SET role='member' WHERE org_id=$1 AND user_id=$2", [f.fixture.organizationId, f.fixture.userId]);
    if (reason === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.fixture.organizationId, f.fixture.userId]);
    if (reason === "credential") await pool.query("UPDATE cloud_agent_credentials SET revoked_at=now() WHERE id=$1", [f.initiating.credentialId]);
    if (reason === "lease") await service.release(f.scope, f.initiating.leaseId);
    if (reason === "expired") await pool.query("UPDATE cloud_agent_execution_leases SET created_at=now()-interval '1 hour',expires_at=now()-interval '1 second' WHERE id=$1", [f.initiating.leaseId]);
    if (reason === "runtime") await pool.query("UPDATE cloud_runtime_bundles SET revoked_at=now() WHERE runtime_id=$1", [f.runtimeId]);
    if (reason === "mcp") await pool.query("UPDATE cloud_runtime_qualifications SET enabled=false,mcp_qualified=false,revoked_at=now() WHERE runtime_id=$1", [f.runtimeId]);
    expect([401,403]).toContain((await call(list)).status);
    expect([401,403]).toContain((await call(create())).status);
    expect((await pool.query("SELECT id FROM cloud_computer_v2_builds")).rowCount).toBe(0);
  });
  it.each(["org", "generation", "engine", "heartbeat", "lease", "computer", "build"])("rejects a wrong %s without exposing diagnostics", async key => {
    const response = await call(key === "computer" ? { name: "GetComputerConfiguration", arguments: { computerId: randomUUID() } } :
      key === "build" ? { name: "GetComputerBuildStatus", arguments: { buildId: randomUUID() } } : list,
    key === "lease" ? { leaseId: randomUUID() } : { scope: key === "org" ? { organizationId: randomUUID() } : key === "generation" ? { generation: 3 } :
      key === "engine" ? { engineInstanceId: randomUUID() } : key === "heartbeat" ? { heartbeatToken: `zwh_${"x".repeat(43)}` } : {} });
    expect([401,403]).toContain(response.status);
    expect(await response.text()).toMatch(/^\{"error":"(engine_authority_rejected|cloud_agent_authority_rejected)"\}$/);
  });
  it("rejects extra fields and arbitrary control-plane operations", async () => {
    for (const key of ["orgId", "actorUserId", "operationId", "environment", "repositories", "url"])
      expect((await call({ name: "CreateComputerConfiguration", arguments: { ...create().arguments, [key]: "forbidden" } })).status).toBe(422);
    expect((await call(list, { extra: { actorUserId: f.fixture.userId } })).status).toBe(422);
    expect((await call({ name: "ActivateComputer", arguments: {} })).status).toBe(422);
  });
});
