import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {resetMigratedTestDatabase} from "../test-database.js";
import {seedCredentialOwner} from "./test-fixtures.js";
import {DatabaseCloudAgentCredentialService} from "./agent-credentials.js";
import {openCloudAgentCredential} from "./agent-credential-envelope.js";

const d=process.env.TEST_DATABASE_URL?describe:describe.skip;
d("explicit personal agent credential authority",()=>{
  let pool:pg.Pool,fixture:Awaited<ReturnType<typeof seedCredentialOwner>>,service:DatabaseCloudAgentCredentialService;
  const key=randomBytes(32).toString("base64url"),secret="synthetic-cursor-key-never-public";
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});});
  afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{await resetMigratedTestDatabase(pool);
    fixture=await seedCredentialOwner(pool);service=new DatabaseCloudAgentCredentialService(pool,{keys:{1:key},currentKeyVersion:1});});
  const input=()=>({ownerUserId:fixture.userId,credentialId:randomUUID(),operationId:randomUUID(),expectedRevision:0,displayName:"My Cursor",
    material:{kind:"cursor-api-key" as const,apiKey:secret}});
  it("stores only encrypted material and returns metadata on retries and listing",async()=>{
    const request=input(),first=await service.put(request);
    expect(first.replayed).toBe(false);expect(await service.put(request)).toEqual({...first,replayed:true});
    expect(JSON.stringify(await service.list(fixture.userId))).not.toContain(secret);
    const row=(await pool.query("SELECT * FROM cloud_agent_credential_versions WHERE credential_id=$1",[request.credentialId])).rows[0];
    expect(row.ciphertext.toString("utf8")).not.toContain(secret);
    expect(openCloudAgentCredential({nonce:row.nonce,ciphertext:row.ciphertext,authTag:row.auth_tag},
      {credentialId:request.credentialId,ownerUserId:fixture.userId,kind:"cursor-api-key",version:1,keyVersion:1},{1:key})).toEqual(request.material);
    await expect(service.put({...request,displayName:"Different"})).rejects.toMatchObject({status:409});
  });
  it("retires old material and consent on rotation, and erases material on revocation",async()=>{
    const request=input();await service.put(request);
    const next=await service.put({...request,expectedRevision:1,operationId:randomUUID(),material:{kind:"cursor-api-key",apiKey:"another-synthetic-cursor-credential"}});
    expect(next.credential.revision).toBe(2);
    expect((await pool.query("SELECT version FROM cloud_agent_credential_versions")).rows).toEqual([{version:2}]);
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1",[fixture.userId]);
    expect(await service.revoke(fixture.userId,request.credentialId)).toEqual({revoked:true});
    expect((await pool.query("SELECT 1 FROM cloud_agent_credential_versions")).rowCount).toBe(0);
  });
  it("allows a replacement after many revoked profiles and canonicalizes UUID retries",async()=>{
    await pool.query(`INSERT INTO cloud_agent_credentials(id,owner_user_id,kind,display_name,last_operation_id,last_request_sha256,revoked_at)
      SELECT gen_random_uuid(),$1,'cursor-api-key','Retired',gen_random_uuid(),digest('fixture','sha256'),now() FROM generate_series(1,100)`,[fixture.userId]);
    const request=input();request.credentialId=request.credentialId.toUpperCase();request.operationId=request.operationId.toUpperCase();
    const result=await service.put(request);expect(result.credential.id).toBe(request.credentialId.toLowerCase());
    expect((await service.put({...request,credentialId:request.credentialId.toLowerCase(),operationId:request.operationId.toLowerCase()})).replayed).toBe(true);
  });
  it("never grants an organization administrator access to another member's private key",async()=>{
    const request=input();await service.put(request);
    const other=await seedCredentialOwner(pool);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'admin')",[fixture.organizationId,other.userId]);
    expect((await service.list(other.userId)).credentials).toEqual([]);
    await expect(service.put({...request,ownerUserId:other.userId,expectedRevision:1,operationId:randomUUID()})).rejects.toMatchObject({status:404});
    await expect(service.revoke(other.userId,request.credentialId)).rejects.toMatchObject({status:404});
  });
});
