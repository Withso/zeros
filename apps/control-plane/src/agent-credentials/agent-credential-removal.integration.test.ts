import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx, withUserTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedCredentialOwner } from "./test-fixtures.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("durable Settings credential removal", () => {
  let pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedCredentialOwner>>;
  let service: DatabaseCloudAgentCredentialService, credentialId: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    fixture = await seedCredentialOwner(pool);
    service = new DatabaseCloudAgentCredentialService(pool, { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } });
    credentialId = randomUUID();
    await service.put({ ownerUserId: fixture.userId, organizationId: fixture.organizationId,
      credentialId, operationId: randomUUID(), expectedRevision: 0, displayName: "Test account",
      material: { kind: "cursor-api-key", apiKey: "synthetic-removal-key" } });
    await service.setOrganizationConnection(fixture.userId, fixture.organizationId, "cursor", {
      credentialId, credentialRevision: 1, expectedRevision: 0, models: ["auto"], consent: "zeros-managed",
    });
  });
  const request = (kind = "revoke-credential") => ({ version: 1, operationId: randomUUID(), target: {
    kind, credentialId, expectedCredentialRevision: 1,
    ...(kind === "remove-organization-credential" ? { organizationId: fixture.organizationId } : {}),
  } });

  it("removes an organization association while retaining the owner's key and other organization", async () => {
    const other = await seedCredentialOwner(pool, { ownerUserId: fixture.userId });
    await pool.query("INSERT INTO cloud_agent_credential_organizations(org_id,owner_user_id,credential_id) VALUES($1,$2,$3)",
      [other.organizationId, fixture.userId, credentialId]);
    const result = await service.prepareRemoval(fixture.userId, request("remove-organization-credential"));
    expect(result.state).toBe("removed");
    expect((await service.list(fixture.userId)).credentials).toHaveLength(1);
    expect((await service.organizationConnections(fixture.userId, fixture.organizationId)).credentials).toEqual([]);
    expect((await service.organizationConnections(fixture.userId, other.organizationId)).credentials).toHaveLength(1);
  });
  it("disconnects without deleting the account and erases ciphertext on global revoke", async () => {
    expect((await service.prepareRemoval(fixture.userId, { version: 1, operationId: randomUUID(), target: {
      kind: "disconnect-provider", organizationId: fixture.organizationId, provider: "cursor", expectedConnectionRevision: 1,
    } })).state).toBe("removed");
    expect((await service.organizationConnections(fixture.userId, fixture.organizationId)).connections[0]?.connected).toBe(false);
    expect((await service.list(fixture.userId)).credentials).toHaveLength(1);
    expect((await service.prepareRemoval(fixture.userId, request())).state).toBe("removed");
    expect((await service.list(fixture.userId)).credentials).toEqual([]);
    expect((await pool.query("SELECT 1 FROM cloud_agent_credential_versions WHERE credential_id=$1", [credentialId])).rowCount).toBe(0);
  });
  it("replays the exact committed request after a lost acknowledgement and rejects changed identity", async () => {
    const body = request(), first = await service.prepareRemoval(fixture.userId, body);
    expect(await service.prepareRemoval(fixture.userId, body)).toEqual(first);
    expect(await service.readRemoval(fixture.userId, body.operationId)).toEqual(first);
    await expect(service.prepareRemoval(fixture.userId, { ...body, target: { ...body.target, expectedCredentialRevision: 2 } }))
      .rejects.toMatchObject({ status: 409 });
    const other = await seedCredentialOwner(pool);
    await expect(service.prepareRemoval(other.userId, body)).rejects.toMatchObject({ status: 403 });
    await expect(service.readRemoval(other.userId, body.operationId)).rejects.toMatchObject({ status: 403 });
    expect((await withUserTx(pool, other.userId, tx => tx.query("SELECT * FROM cloud_agent_credential_mutations"))).rowCount).toBe(0);
  });
  async function existingConfirmation(expired = false) {
    const body = request();
    await withSystemTx(pool, tx => tx.query(`INSERT INTO cloud_agent_credential_mutations
      (id,owner_user_id,target,source_snapshot,request_sha256,state,revision,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,'awaiting-confirmation',2,now()-interval '10 minutes',now()+$6::interval)`,
    [body.operationId, fixture.userId, body.target, { organizations: null, selectors: [{ provider: "cursor", credentialId }], devReference: null },
      createHash("sha256").update(JSON.stringify(body)).digest(), expired ? "-1 minute" : "1 minute"]));
    return body.operationId;
  }
  it.each(["confirm", "cancel"] as const)("preserves %s and exact decision replay for a pre-upgrade confirmation", async action => {
    const id = await existingConfirmation(), decision = { version: 1, requestId: randomUUID(), expectedRevision: 2 };
    const result = await service.decideRemoval(fixture.userId, id, action, decision);
    expect(result.state).toBe(action === "confirm" ? "removed" : "cancelled");
    expect(await service.decideRemoval(fixture.userId, id, action, decision)).toEqual(result);
    expect((await service.list(fixture.userId)).credentials).toHaveLength(action === "confirm" ? 0 : 1);
    await expect(service.decideRemoval(fixture.userId, id, action === "confirm" ? "cancel" : "confirm", decision)).rejects.toMatchObject({ status: 409 });
  });
  it("expires a pre-upgrade confirmation without revoking its credential", async () => {
    const id = await existingConfirmation(true);
    expect((await service.readRemoval(fixture.userId, id)).state).toBe("expired");
    expect((await service.list(fixture.userId)).credentials).toHaveLength(1);
  });
});
