import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("organization agent accounts", () => {
  let pool: pg.Pool, service: DatabaseCloudAgentCredentialService;
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 5,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
    service = new DatabaseCloudAgentCredentialService(pool, {
      keys: { 1: randomBytes(32).toString("base64url") },
      currentKeyVersion: 1,
    });
  });
  async function account(name = "Subscription") {
    return (
      await service.put({
        ownerUserId: fixture.userId,
        organizationId: fixture.organizationId,
        credentialId: randomUUID(),
        operationId: randomUUID(),
        expectedRevision: 0,
        displayName: name,
        material: {
          kind: "claude-setup-token",
          accessToken: "synthetic-setup-token-for-tests",
        },
      })
    ).credential;
  }
  function select(credentialId: string, expectedRevision = 0) {
    return service.setOrganizationConnection(
      fixture.userId,
      fixture.organizationId,
      "claude",
      {
        expectedRevision,
        credentialId,
        credentialRevision: 1,
        models: ["claude-haiku-4-5"],
        consent: "zeros-managed",
      },
    );
  }
  it("connects multiple private accounts before a workspace exists and isolates organizations", async () => {
    await pool.query("DELETE FROM cloud_workspaces WHERE id=$1", [
      fixture.workspaceId,
    ]);
    const first = await account("First"),
      second = await account("Second");
    await select(second.id);
    const result = await service.organizationConnections(
      fixture.userId,
      fixture.organizationId,
    );
    expect(result.credentials.map((row) => row.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(result.connections).toMatchObject([
      {
        provider: "claude",
        credentialId: second.id,
        revision: 1,
        connected: true,
      },
    ]);
    const another = await seedReadyCloudWorkspace(pool, {
      ownerUserId: fixture.userId,
    });
    expect(
      (
        await service.organizationConnections(
          fixture.userId,
          another.organizationId,
        )
      ).credentials,
    ).toEqual([]);
    expect(
      (await pool.query("SELECT 1 FROM cloud_agent_credential_delegations"))
        .rowCount,
    ).toBe(0);
  });
  it("issues reusable exact-workspace grants only for the acting member's explicit selection", async () => {
    const credential = await account();
    await select(credential.id);
    const first = await service.authorizeOrganizationForWorkspace(
      fixture.userId,
      fixture.workspaceId,
    );
    const again = await service.authorizeOrganizationForWorkspace(
      fixture.userId,
      fixture.workspaceId,
    );
    expect(first.delegations).toHaveLength(1);
    expect(again.delegations).toEqual(first.delegations);
    expect(
      (
        await pool.query(
          "SELECT owner_user_id,grantee_user_id,workspace_id,models FROM cloud_agent_credential_delegations",
        )
      ).rows,
    ).toEqual([
      {
        owner_user_id: fixture.userId,
        grantee_user_id: fixture.userId,
        workspace_id: fixture.workspaceId,
        models: ["claude-haiku-4-5"],
      },
    ]);
    const other = await seedReadyCloudWorkspace(pool);
    await expect(
      service.organizationConnections(other.userId, fixture.organizationId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.authorizeOrganizationForWorkspace(
        other.userId,
        fixture.workspaceId,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("reports qualification for the current image and credential kind without replacing account consent", async () => {
    const credential = await account();
    await select(credential.id);
    const scope = (await pool.query(
      "SELECT provider,image_ref FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1",
      [fixture.workspaceId],
    )).rows[0];
    const first = await service.authorizeOrganizationForWorkspace(fixture.userId, fixture.workspaceId);
    expect(first.delegations).toMatchObject([{ runtimeQualified: false }]);
    // Grants are offered to the live engine, so a qualification must match its
    // exact runtime contract and profile and carry MCP proof.
    await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=2,agent_runtime_profile='zeros-cloud-worker-v3',agent_runtime_contract_sha256=$2 WHERE id=$1",
      [fixture.engineInstanceId, "a".repeat(64)]);
    const qualify = (imageRef: string, contract: string, mcpQualified: boolean) => pool.query(`INSERT INTO cloud_agent_runtime_qualifications
      (provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled,mcp_qualified)
      VALUES ($1,$2,$3,'claude-setup-token','zeros-cloud-worker-v3',true,$4)`,
    [scope.provider, imageRef, contract, mcpQualified]);
    const delegations = async () => (await service.forWorkspace(fixture.userId, fixture.workspaceId)).delegations;
    await qualify(`${scope.image_ref}-another-image`, "a".repeat(64), true);
    expect(await delegations()).toMatchObject([{ id: first.delegations[0]!.id, runtimeQualified: false }]);
    await qualify(scope.image_ref, "b".repeat(64), true);
    expect(await delegations()).toMatchObject([{ runtimeQualified: false }]);
    await qualify(scope.image_ref, "a".repeat(64), false);
    expect(await delegations()).toMatchObject([{ runtimeQualified: false }]);
    await pool.query("UPDATE cloud_agent_runtime_qualifications SET mcp_qualified=true WHERE image_ref=$1 AND runtime_contract_sha256=$2",
      [scope.image_ref, "a".repeat(64)]);
    expect(await delegations()).toMatchObject([{ id: first.delegations[0]!.id, runtimeQualified: true }]);
    await pool.query("UPDATE cloud_agent_runtime_qualifications SET enabled=false WHERE image_ref=$1", [scope.image_ref]);
    expect((await service.forWorkspace(fixture.userId, fixture.workspaceId)).delegations)
      .toMatchObject([{ runtimeQualified: false }]);
  });
  it("uses compare-and-set, invalidates old grants on switching, and disconnects without deleting another org's credentials", async () => {
    const a = await account("A"),
      b = await account("B");
    await select(a.id);
    await service.authorizeOrganizationForWorkspace(
      fixture.userId,
      fixture.workspaceId,
    );
    await expect(select(b.id)).rejects.toMatchObject({ status: 409 });
    await select(b.id, 1);
    expect(
      (await service.forWorkspace(fixture.userId, fixture.workspaceId))
        .delegations,
    ).toEqual([]);
    await service.authorizeOrganizationForWorkspace(
      fixture.userId,
      fixture.workspaceId,
    );
    await service.setOrganizationConnection(
      fixture.userId,
      fixture.organizationId,
      "claude",
      { expectedRevision: 2, credentialId: null },
    );
    expect(
      (await service.forWorkspace(fixture.userId, fixture.workspaceId))
        .delegations,
    ).toEqual([]);
    expect(
      (
        await service.organizationConnections(
          fixture.userId,
          fixture.organizationId,
        )
      ).credentials,
    ).toHaveLength(2);
  });
  it("requires renewed consent after credential rotation or membership authority changes", async () => {
    const credential = await account();
    await select(credential.id);
    await pool.query(
      "UPDATE organization_members SET authorization_revision=authorization_revision+1 WHERE org_id=$1 AND user_id=$2",
      [fixture.organizationId, fixture.userId],
    );
    expect(
      (
        await service.organizationConnections(
          fixture.userId,
          fixture.organizationId,
        )
      ).connections[0]?.connected,
    ).toBe(false);
    expect(
      (
        await service.authorizeOrganizationForWorkspace(
          fixture.userId,
          fixture.workspaceId,
        )
      ).delegations,
    ).toEqual([]);
  });
  it("never turns organization consent into authorization for administrator-owned compute", async () => {
    const credential = await account();
    await select(credential.id);
    const connection = (
      await pool.query(
        "SELECT provider_connection_id AS id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1",
        [fixture.workspaceId],
      )
    ).rows[0].id;
    await pool.query(
      `UPDATE provider_connection_versions SET credential_source='delegated',endpoint='https://app.daytona.io/api',
      key_version=1,nonce=$2,ciphertext=$3,auth_tag=$4,credential_sha256=$5 WHERE connection_id=$1`,
      [
        connection,
        randomBytes(12),
        randomBytes(32),
        randomBytes(16),
        randomBytes(32),
      ],
    );
    await pool.query(
      "UPDATE provider_connections SET credential_source='delegated' WHERE id=$1",
      [connection],
    );
    expect(
      (
        await service.authorizeOrganizationForWorkspace(
          fixture.userId,
          fixture.workspaceId,
        )
      ).delegations,
    ).toEqual([]);
  });
});
