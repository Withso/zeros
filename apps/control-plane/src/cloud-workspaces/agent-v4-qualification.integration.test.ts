import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAgentExecutionAuthoritySchema, CloudAgentExecutionLeaseSchema } from "../../../../packages/protocol/src/cloud-agent-execution.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedComputerToolsFixture } from "./computer-tools-test-fixture.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { DatabaseCloudAgentExecutionService } from "./agent-executions.js";
import { DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { withSystemTx } from "../db.js";
import { markAdminWorkspace } from "./computer-admin-workspaces.js";
import { RUNTIME_QUALIFICATION_KINDS } from "./runtime-qualification.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("v4 smoke agent discovery and admission", () => {
  let pool: pg.Pool;
  let f: Awaited<ReturnType<typeof seedComputerToolsFixture>>;
  let credentials: DatabaseCloudAgentCredentialService;
  let executions: DatabaseCloudAgentExecutionService;
  const input = () => ({ executionId: randomUUID(), delegationId: f.initiating.delegationId,
    provider: "cursor" as const, model: "grok-4.6",
    source: { kind: "session" as const, actorSessionId: f.initiating.actorSessionId } });
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 }); });
  afterAll(async () => { await pool.end(); });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv("CLOUD_RUNTIME_QUALIFICATION_MODE", "smoke");
    await resetMigratedTestDatabase(pool);
    f = await seedComputerToolsFixture(pool, false, { mode: "smoke", mcpQualified: false });
    credentials = new DatabaseCloudAgentCredentialService(pool, f.encryption);
    executions = new DatabaseCloudAgentExecutionService(pool, f.encryption, false);
  });

  it("offers basic turns without inventing MCP or native qualification", async () => {
    expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations).toEqual([
      expect.objectContaining({ id: f.initiating.delegationId, runtimeQualified: true, mcpQualified: false }),
    ]);
  });

  it("allows unknown engines, including unadvertised v3 runtimes", async () => {
    expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations[0])
      .toMatchObject({ runtimeQualified: true, runtimeUpgradeRequired: false, mcpQualified: false });
    await executions.admit(f.scope, { ...input(), customization: { version: 3, repositoryServers: [] } });
    expect((await pool.query("SELECT agent_customization_version FROM cloud_workspace_engine_instances WHERE id=$1", [f.scope.engineInstanceId])).rows[0].agent_customization_version).toBe(3);
    // Proof belongs to the exact live engine, never to a retired instance.
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [f.scope.engineInstanceId]);
    expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations[0])
      .toMatchObject({ runtimeQualified: false, runtimeUpgradeRequired: false });
  });

  it.each([1, 2])("records required-only v%s evidence even though admission rejects", async version => {
    const request = { ...input(), customization: { version, repositoryServers: [] } };
    await expect(executions.admit(f.scope, request))
      .rejects.toMatchObject({ status: 409, code: "cloud_runtime_upgrade_required" });
    expect((await pool.query("SELECT agent_customization_version FROM cloud_workspace_engine_instances WHERE id=$1", [f.scope.engineInstanceId])).rows[0].agent_customization_version).toBe(version);
    expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations[0])
      .toMatchObject({ runtimeQualified: false, runtimeUpgradeRequired: true, mcpQualified: false });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_agent_execution_leases WHERE execution_id=$1", [request.executionId])).rows[0].n).toBe(0);
    // A proved v3 admission upgrades that evidence without borrowing runtime dates.
    await executions.admit(f.scope, { ...input(), customization: { version: 3, repositoryServers: [] } });
    expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations[0])
      .toMatchObject({ runtimeQualified: true, runtimeUpgradeRequired: false });
    await expect(executions.admit(f.scope, { ...input(), customization: { version, repositoryServers: [] } }))
      .rejects.toMatchObject({ code: "cloud_runtime_upgrade_required" });
    expect((await pool.query("SELECT agent_customization_version FROM cloud_workspace_engine_instances WHERE id=$1", [f.scope.engineInstanceId])).rows[0].agent_customization_version).toBe(3);
  });

  it("does not record capability on an unauthorized admission", async () => {
    await expect(executions.admit(f.scope, { ...input(), delegationId: randomUUID(), customization: { version: 3, repositoryServers: [] } }))
      .rejects.toMatchObject({ status: 403 });
    expect((await pool.query("SELECT agent_customization_version FROM cloud_workspace_engine_instances WHERE id=$1", [f.scope.engineInstanceId])).rows[0].agent_customization_version).toBeNull();
  });

  it("retains the specific denial when an older engine settles a generic failure", async () => {
    const commands = new DatabaseCloudWorkspaceCommandService({ pool }), commandId = randomUUID(), executionId = randomUUID();
    await commands.mutate({ ...f.scope, actorSessionId: f.initiating.actorSessionId }, {
      conversationId: "old-engine", operationId: randomUUID(), expectedRevision: 0,
      action: { kind: "enqueue", commandId, payload: { agentId: "cursor", model: "grok-4.6", userMessageId: randomUUID(),
        prompt: [{ type: "text", text: "Keep this prompt" }], modeRevision: 0, agentCredentialGrantId: f.initiating.delegationId } },
    });
    const claim = (await commands.claim(f.scope, "old-engine", executionId))!;
    await expect(executions.admit(f.scope, { ...input(), executionId,
      source: { kind: "command", commandId, claimId: claim.claimId }, customization: { version: 2, repositoryServers: [] } }))
      .rejects.toMatchObject({ code: "cloud_runtime_upgrade_required" });
    const receipt = async () => (await pool.query("SELECT state,result_code FROM cloud_workspace_commands WHERE id=$1", [commandId])).rows[0];
    expect(await receipt()).toEqual({ state: "dispatching", result_code: "cloud_runtime_upgrade_required" });
    const settlement = { commandId, claimId: claim.claimId, state: "failed" as const, resultCode: "command_dispatch_rejected" };
    await commands.settle(f.scope, settlement);
    expect(await receipt()).toEqual({ state: "failed", result_code: "cloud_runtime_upgrade_required" });
    expect(await commands.settle(f.scope, settlement)).toMatchObject({ replayed: true });
  });

  it("discovers and admits all five smoke-qualified credential kinds", async () => {
    for (const kind of RUNTIME_QUALIFICATION_KINDS) {
      await pool.query(`INSERT INTO cloud_runtime_qualifications(runtime_id,base_compatibility_id,credential_kind,profile,enabled,mcp_qualified,native_capabilities,evidence,qualified_at)
        SELECT runtime_id,base_compatibility_id,$1,profile,enabled,mcp_qualified,native_capabilities,evidence,qualified_at
        FROM cloud_runtime_qualifications WHERE credential_kind='cursor-api-key' ON CONFLICT DO NOTHING`, [kind]);
      const credentialId = randomUUID(), delegationId = randomUUID();
      const material = kind === "codex-chatgpt" ? { kind, accessToken: "synthetic-chatgpt-access", accountId: "synthetic-account", expiresAt: Math.floor(Date.now()/1000)+3600 } :
        kind === "claude-setup-token" ? { kind, accessToken: "synthetic-claude-access" } : { kind, apiKey: "synthetic-provider-key" };
      await credentials.put({ ownerUserId: f.owner.id, credentialId, operationId: randomUUID(), expectedRevision: 0, displayName: "Fixture", material });
      await credentials.delegate(f.owner.id, { id: delegationId, credentialId, expectedRevision: 1, workspaceId: f.fixture.workspaceId,
        granteeUserId: f.owner.id, models: ["fixture-model"], expiresAt: new Date(Date.now()+3600_000).toISOString() });
      expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations.find(grant => grant.id === delegationId))
        .toMatchObject({ kind, runtimeQualified: true, mcpQualified: false });
      const lease = await executions.admit(f.scope, { ...input(), delegationId, provider: kind.split("-")[0], model: "fixture-model",
        customization: { version: 3, repositoryServers: [] } }, false, 1);
      expect(CloudAgentExecutionAuthoritySchema.safeParse(lease).success).toBe(true);
      expect(lease.credentialKind).toBe(kind);
    }
  });

  it("requires MCP for marked computer administration in both discovery and execution", async () => {
    await withSystemTx(pool, tx => markAdminWorkspace(tx, { workspaceId: f.fixture.workspaceId, orgId: f.fixture.organizationId, creatorUserId: f.owner.id }));
    expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations[0]).toMatchObject({ runtimeQualified: false, mcpQualified: false });
    await expect(executions.admit(f.scope, { ...input(), customization: { version: 3, repositoryServers: [] } })).rejects.toMatchObject({ status: 403 });
  });

  it.each([1, 2, 3] as const)("keeps v%s customization snapshots when the runtime has MCP proof", async version => {
    await resetMigratedTestDatabase(pool);
    f = await seedComputerToolsFixture(pool, false, { mode: "smoke", mcpQualified: true });
    credentials = new DatabaseCloudAgentCredentialService(pool, f.encryption);
    executions = new DatabaseCloudAgentExecutionService(pool, f.encryption, false);
    const request = { ...input(), customization: { version, repositoryServers: [{ name: "fixture", transport: "stdio", command: "node", args: ["fixture.mjs"] }] } };
    expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations[0]).toMatchObject({ runtimeQualified: true, runtimeUpgradeRequired: false, mcpQualified: true });
    const lease = await executions.admit(f.scope, request, false, 1);
    expect(CloudAgentExecutionAuthoritySchema.safeParse(lease).success).toBe(true);
    expect(lease.customization?.servers).toHaveLength(1);
    if (version >= 2) expect(lease.customization?.history).toBeDefined();
    expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations[0]?.runtimeUpgradeRequired).toBe(false);
    expect(await executions.admit(f.scope, request, false, 1)).toEqual(lease);
    await expect(executions.admit(f.scope, { ...request, customization: undefined })).rejects.toMatchObject({ status: 403 });
    await pool.query("UPDATE cloud_runtime_qualifications SET enabled=false,mcp_qualified=false,revoked_at=now()");
    await expect(executions.validate(f.scope, lease.leaseId, true)).rejects.toMatchObject({ status: 403 });
  });

  it("omits empty native proof from admission and renewal responses", async () => {
    const lease = await executions.admit(f.scope, input(), false, 1);
    expect(CloudAgentExecutionAuthoritySchema.safeParse(lease).success).toBe(true);
    expect(lease).not.toHaveProperty("nativeCapabilities");
    const renewed = await executions.validate(f.scope, lease.leaseId, true, undefined, false, 1);
    expect(CloudAgentExecutionLeaseSchema.safeParse(renewed).success).toBe(true);
    expect(renewed).not.toHaveProperty("nativeCapabilities");
  });

  it("admits the v4 gateway's optional customization request as an explicit basic turn", async () => {
    const request = { ...input(), customization: { version: 3, repositoryServers: [] } };
    const lease = await executions.admit(f.scope, request, false, 1);
    expect(CloudAgentExecutionAuthoritySchema.safeParse(lease).success).toBe(true);
    expect(lease).not.toHaveProperty("customization");
    expect(await executions.admit(f.scope, request, false, 1)).toEqual(lease);
    await expect(executions.validate(f.scope, lease.leaseId, true)).resolves.toHaveProperty("leaseId", lease.leaseId);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_customization_execution_snapshots")).rows[0].n).toBe(0);
    for (const version of [1, 2]) {
      await expect(executions.admit(f.scope, { ...input(), customization: { version, repositoryServers: [] } })).rejects.toMatchObject({ status: 409, code: "cloud_runtime_upgrade_required" });
    }
  });

  it("keeps native commands gated on the exact runtime capability", async () => {
    const commands = new DatabaseCloudWorkspaceCommandService({ pool }), commandId = randomUUID(), executionId = randomUUID();
    await commands.mutate({ ...f.scope, actorSessionId: f.initiating.actorSessionId }, {
      conversationId: "fork-destination", operationId: randomUUID(), expectedRevision: 0,
      action: { kind: "fork", commandId, payload: { agentId: "cursor", model: "grok-4.6", userMessageId: randomUUID(),
        prompt: [{ type: "text", text: "" }], modeRevision: 0, agentCredentialGrantId: f.initiating.delegationId,
        operation: { version: 1, kind: "fork", sourceConversationId: "source", strategy: "transcript" } } },
    });
    const claim = (await commands.claim(f.scope, "fork-destination", executionId))!;
    await expect(executions.admit(f.scope, { ...input(), executionId,
      source: { kind: "command", commandId, claimId: claim.claimId } })).rejects.toMatchObject({ status: 403 });
  });

  it("keeps discovery and admission closed when smoke mode is disabled or qualification is revoked", async () => {
    vi.stubEnv("CLOUD_RUNTIME_QUALIFICATION_MODE", "full");
    expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations[0]?.runtimeQualified).toBe(false);
    await expect(executions.admit(f.scope, input())).rejects.toMatchObject({ status: 403 });
    vi.stubEnv("CLOUD_RUNTIME_QUALIFICATION_MODE", "smoke");
    await pool.query("UPDATE cloud_runtime_qualifications SET enabled=false,mcp_qualified=false,revoked_at=now()");
    expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations[0]?.runtimeQualified).toBe(false);
    await expect(executions.admit(f.scope, input())).rejects.toMatchObject({ status: 403 });
  });
});
