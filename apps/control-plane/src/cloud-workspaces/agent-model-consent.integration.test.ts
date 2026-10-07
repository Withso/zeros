import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudWorkspaceCollaborationService } from "./actors.js";
import { seedComputerToolsFixture } from "./computer-tools-test-fixture.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { DatabaseCloudAgentExecutionService } from "./agent-executions.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("explicit provider-wide self consent", () => {
  let pool: pg.Pool, f: Awaited<ReturnType<typeof seedComputerToolsFixture>>;
  let credentials: DatabaseCloudAgentCredentialService, executions: DatabaseCloudAgentExecutionService;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(() => pool.end()); afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv("CLOUD_RUNTIME_QUALIFICATION_MODE", "smoke");
    await resetMigratedTestDatabase(pool);
    f = await seedComputerToolsFixture(pool, false, { mode: "smoke", mcpQualified: false });
    credentials = new DatabaseCloudAgentCredentialService(pool, f.encryption);
    executions = new DatabaseCloudAgentExecutionService(pool, f.encryption, false);
  });
  const delegate = (allModels?: boolean, granteeUserId = f.owner.id) => ({ id: randomUUID(), credentialId: f.initiating.credentialId,
    expectedRevision: 1, workspaceId: f.fixture.workspaceId, granteeUserId, models: ["grok-4.6"],
    ...(allModels === undefined ? {} : { allModels }), expiresAt: new Date(Date.now()+3600_000).toISOString() });
  const admission = (delegationId: string, model: string) => ({ executionId: randomUUID(), delegationId, provider: "cursor", model,
    source: { kind: "session", actorSessionId: f.initiating.actorSessionId }, customization: { version: 3, repositoryServers: [] } });

  it("admits current qualified provider models beyond the original self-grant snapshot", async () => {
    const request = delegate(true);
    await credentials.delegate(f.owner.id, request);
    const grants = await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId);
    const grant = grants.delegations.find(row => row.id === request.id)!;
    expect(grant).toMatchObject({ allModels: true });
    expect(grant.models).toContain("grok-4.7");
    const turn = admission(request.id, "grok-4.7");
    const lease = await executions.admit(f.scope, turn, false, undefined, undefined, undefined, 1);
    expect(lease.model).toBe("grok-4.7");
    await expect(executions.validate(f.scope, lease.leaseId, true)).resolves.toHaveProperty("leaseId", lease.leaseId);
    await expect(executions.authorizeAction(f.scope, turn.executionId, f.initiating.actorSessionId)).resolves.toMatchObject({ authorized: true });
    for (const model of ["gpt-6.1-sol", "unknown-future-model"])
      await expect(executions.admit(f.scope, admission(request.id, model), false, undefined, undefined, undefined, 1)).rejects.toMatchObject({ code: "cloud_agent_model_not_authorized" });
  });
  it("preserves existing and explicitly restricted lists without widening them", async () => {
    for (const flag of [undefined, false]) {
      const request = delegate(flag); await credentials.delegate(f.owner.id, request);
      expect((await credentials.forWorkspace(f.owner.id, f.fixture.workspaceId)).delegations.find(row => row.id === request.id))
        .toMatchObject({ allModels: false, models: ["grok-4.6"] });
      await expect(executions.admit(f.scope, admission(request.id, "grok-4.7"), false, undefined, undefined, undefined, 1)).rejects.toMatchObject({ code: "cloud_agent_model_not_authorized" });
      expect((await executions.admit(f.scope, admission(request.id, "grok-4.6"), false, undefined, undefined, undefined, 1)).model).toBe("grok-4.6");
    }
  });
  it("rejects provider-wide grants to another member while preserving their explicit model consent", async () => {
    const otherFixture = await seedReadyCloudWorkspace(pool);
    const other = await f.actor(otherFixture.userId);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [f.fixture.organizationId, other.id]);
    await pool.query("INSERT INTO organization_seat_assignments(org_id,user_id,assigned_by) VALUES($1,$2,$3)", [f.fixture.organizationId, other.id, f.owner.id]);
    await new DatabaseCloudWorkspaceCollaborationService(pool).setSharing({ workspaceId: f.fixture.workspaceId, organizationId: f.fixture.organizationId,
      actorUserId: f.owner.id, sharingMode: "organization", expectedRevision: 1 });
    const restricted = delegate(false, other.id);
    await credentials.delegate(f.owner.id, restricted);
    await expect(credentials.delegate(f.owner.id, delegate(true, other.id))).rejects.toMatchObject({ status: 422 });
    await expect(pool.query("UPDATE cloud_agent_credential_delegations SET all_models=true WHERE id=$1", [restricted.id])).rejects.toMatchObject({ code: "23514" });
    expect((await credentials.forWorkspace(other.id, f.fixture.workspaceId)).delegations.find(row => row.id === restricted.id))
      .toMatchObject({ allModels: false, models: ["grok-4.6"] });
  });
  it("carries explicit organization consent into renewed self-grants and distinguishes idempotency", async () => {
    await credentials.organizationConnections(f.owner.id, f.fixture.organizationId);
    const selection = { expectedRevision: 0, credentialId: f.initiating.credentialId, credentialRevision: 1,
      models: ["grok-4.6"], allModels: true, consent: "zeros-managed" };
    await credentials.setOrganizationConnection(f.owner.id, f.fixture.organizationId, "cursor", selection);
    expect((await credentials.organizationConnections(f.owner.id, f.fixture.organizationId)).connections[0]).toMatchObject({ allModels: true });
    expect(await credentials.setOrganizationConnection(f.owner.id, f.fixture.organizationId, "cursor", selection)).toMatchObject({ replayed: true });
    await expect(credentials.setOrganizationConnection(f.owner.id, f.fixture.organizationId, "cursor", { ...selection, allModels: false })).rejects.toMatchObject({ status: 409 });
    const first = (await credentials.authorizeOrganizationForWorkspace(f.owner.id, f.fixture.workspaceId)).delegations.find(row => row.allModels)!;
    expect(first.models).toContain("grok-4.7");
    await pool.query("UPDATE cloud_agent_credential_delegations SET expires_at=now()+interval '30 seconds' WHERE id=$1", [first.id]);
    const renewed = (await credentials.authorizeOrganizationForWorkspace(f.owner.id, f.fixture.workspaceId)).delegations.find(row => row.allModels)!;
    expect(renewed.id).not.toBe(first.id);
    expect(renewed.models).toContain("grok-4.7");
  });
  it.each([
    ["model", "cloud_agent_model_not_authorized"],
    ["revoked", "cloud_agent_credential_revoked"],
    ["expired", "cloud_agent_credential_expired"],
    ["material", "cloud_agent_credential_expired"],
  ])("keeps the closed %s refusal in the command receipt after old-engine settlement", async (cause, code) => {
    const grant = delegate(false); await credentials.delegate(f.owner.id, grant);
    const commandId = randomUUID(), executionId = randomUUID(), model = cause === "model" ? "grok-4.7" : "grok-4.6";
    const commands = new DatabaseCloudWorkspaceCommandService({ pool });
    await commands.mutate({ ...f.scope, actorSessionId: f.initiating.actorSessionId }, {
      conversationId: "consent-refusal", operationId: randomUUID(), expectedRevision: 0,
      action: { kind: "enqueue", commandId, payload: { agentId: "cursor", model, userMessageId: randomUUID(),
        prompt: [{ type: "text", text: "Keep this prompt" }], modeRevision: 0, agentCredentialGrantId: grant.id } },
    });
    const claim = (await commands.claim(f.scope, "consent-refusal", executionId))!;
    if (cause === "revoked") await pool.query("UPDATE cloud_agent_credential_delegations SET revoked_at=now() WHERE id=$1", [grant.id]);
    if (cause === "expired") await pool.query("UPDATE cloud_agent_credential_delegations SET expires_at=now() WHERE id=$1", [grant.id]);
    if (cause === "material") await pool.query("UPDATE cloud_agent_credential_versions SET material_expires_at=now() WHERE credential_id=$1", [grant.credentialId]);
    await expect(executions.admit(f.scope, { ...admission(grant.id, model), executionId,
      source: { kind: "command", commandId, claimId: claim.claimId } }, false, undefined, undefined, undefined, 1)).rejects.toMatchObject({ status: 409, code });
    const settlement = { commandId, claimId: claim.claimId, state: "failed" as const, resultCode: "command_dispatch_rejected" };
    await commands.settle(f.scope, settlement);
    expect((await pool.query("SELECT state,result_code FROM cloud_workspace_commands WHERE id=$1", [commandId])).rows[0])
      .toEqual({ state: "failed", result_code: code });
    expect(await commands.settle(f.scope, settlement)).toMatchObject({ replayed: true });
    expect((await pool.query("SELECT count(*)::int n FROM cloud_agent_execution_leases WHERE execution_id=$1", [executionId])).rows[0].n).toBe(0);
  });

});
