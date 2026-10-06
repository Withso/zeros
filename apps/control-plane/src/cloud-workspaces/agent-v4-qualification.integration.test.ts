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

  it("keeps customization snapshots and history when an exact runtime does have MCP proof", async () => {
    await resetMigratedTestDatabase(pool);
    f = await seedComputerToolsFixture(pool, false, { mode: "smoke", mcpQualified: true });
    credentials = new DatabaseCloudAgentCredentialService(pool, f.encryption);
    executions = new DatabaseCloudAgentExecutionService(pool, f.encryption, false);
    const request = { ...input(), customization: { version: 3, repositoryServers: [{ name: "fixture", transport: "stdio", command: "node", args: ["fixture.mjs"] }] } };
    expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations[0]).toMatchObject({ runtimeQualified: true, mcpQualified: true });
    const lease = await executions.admit(f.scope, request, false, 1);
    expect(CloudAgentExecutionAuthoritySchema.safeParse(lease).success).toBe(true);
    expect(lease.customization?.servers).toHaveLength(1);
    expect(lease.customization?.history).toBeDefined();
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
      await expect(executions.admit(f.scope, { ...input(), customization: { version, repositoryServers: [] } })).rejects.toMatchObject({ status: 403 });
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
