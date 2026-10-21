import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedCredentialOwner } from "./test-fixtures.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { cloudAgentModels } from "./agent-models.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("organization agent accounts", () => {
  let pool: pg.Pool, service: DatabaseCloudAgentCredentialService;
  let fixture: Awaited<ReturnType<typeof seedCredentialOwner>>;
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
    await resetMigratedTestDatabase(pool);
    fixture = await seedCredentialOwner(pool);
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
  it.each([undefined,false])("lists all supported models with a legacy allModels=%s request and preserves exact retries",async allModels=>{
    const credential=await account(),selection={expectedRevision:0,credentialId:credential.id,credentialRevision:1,
      models:["claude-haiku-4-5"],consent:"zeros-managed",...(allModels===undefined?{}:{allModels})};
    expect(await service.setOrganizationConnection(fixture.userId,fixture.organizationId,"claude",selection)).toEqual({revision:1,replayed:false});
    const saved=(await pool.query("SELECT models,all_models,revision,request_sha256 FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2 AND provider='claude'",[fixture.organizationId,fixture.userId])).rows[0];
    expect(saved).toMatchObject({models:["claude-haiku-4-5"],all_models:false,revision:"1"});
    expect((await service.organizationConnections(fixture.userId,fixture.organizationId)).connections)
      .toMatchObject([{connected:true,credentialId:credential.id,models:cloudAgentModels("claude"),allModels:false}]);
    expect(await service.setOrganizationConnection(fixture.userId,fixture.organizationId,"claude",selection)).toEqual({revision:1,replayed:true});
    expect((await pool.query("SELECT models,all_models,revision,request_sha256 FROM cloud_agent_organization_connections WHERE org_id=$1 AND owner_user_id=$2 AND provider='claude'",[fixture.organizationId,fixture.userId])).rows[0]).toEqual(saved);
  });
  it("connects multiple private accounts before a workspace exists and isolates organizations", async () => {
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
    const another = await seedCredentialOwner(pool, {
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
  });
  it("uses compare-and-set when switching and disconnecting without deleting private credentials", async () => {
    const first=await account("First"), second=await account("Second");
    await select(first.id);
    await expect(select(second.id)).rejects.toMatchObject({status:409});
    await select(second.id,1);
    await service.setOrganizationConnection(fixture.userId,fixture.organizationId,"claude",{expectedRevision:2,credentialId:null});
    const result=await service.organizationConnections(fixture.userId,fixture.organizationId);
    expect(result.connections).toMatchObject([{connected:false,credentialId:null,revision:3}]);
    expect(result.credentials).toHaveLength(2);
  });
  it("requires renewed consent after membership authority changes",async()=>{
    const credential=await account();await select(credential.id);
    await pool.query("UPDATE organization_members SET authorization_revision=authorization_revision+1 WHERE org_id=$1 AND user_id=$2",[fixture.organizationId,fixture.userId]);
    expect((await service.organizationConnections(fixture.userId,fixture.organizationId)).connections[0]?.connected).toBe(false);
  });
  it("rejects another member's organization scope and another owner's credential selection",async()=>{
    const credential=await account(),other=await seedCredentialOwner(pool);
    await expect(service.organizationConnections(other.userId,fixture.organizationId)).rejects.toMatchObject({status:404});
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'admin')",[fixture.organizationId,other.userId]);
    await expect(service.setOrganizationConnection(other.userId,fixture.organizationId,"claude",{expectedRevision:0,credentialId:credential.id,credentialRevision:1,models:["claude-haiku-4-5"],consent:"zeros-managed"})).rejects.toMatchObject({status:404});
  });
});
