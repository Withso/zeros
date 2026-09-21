import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {withSystemTx} from "../db.js";
import {runMigrations} from "../migrate.js";
import {seedReadyCloudWorkspace} from "./test-fixtures.js";
import {DatabaseCloudAgentCredentialService} from "./agent-credentials.js";
import {openCloudAgentCredential} from "./agent-credential-envelope.js";
import {DatabaseCloudWorkspaceCollaborationService,eraseCloudWorkspaceCollaborationIdentity} from "./actors.js";
import {ensureUser} from "../auth.js";

const d=process.env.TEST_DATABASE_URL?describe:describe.skip;
d("explicit personal agent credential authority",()=>{
  let pool:pg.Pool,fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>,service:DatabaseCloudAgentCredentialService;
  const key=randomBytes(32).toString("base64url"),secret="synthetic-cursor-key-never-public";
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});});
  afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");await runMigrations(pool);
    fixture=await seedReadyCloudWorkspace(pool);service=new DatabaseCloudAgentCredentialService(pool,{keys:{1:key},currentKeyVersion:1});});
  const input=()=>({ownerUserId:fixture.userId,credentialId:randomUUID(),operationId:randomUUID(),expectedRevision:0,displayName:"My Cursor",
    material:{kind:"cursor-api-key" as const,apiKey:secret}});
  const delegation=(credentialId:string,granteeUserId=fixture.userId)=>({id:randomUUID(),credentialId,expectedRevision:1,workspaceId:fixture.workspaceId,granteeUserId,
    models:["grok-4.6"],expiresAt:new Date(Date.now()+3600_000).toISOString()});
  it("stores only encrypted material and returns metadata on retries and listing",async()=>{
    const request=input(),first=await service.put(request);
    expect(first.replayed).toBe(false);expect(await service.put(request)).toEqual({...first,replayed:true});
    expect(JSON.stringify(await service.list(fixture.userId))).not.toContain(secret);
    const row=(await pool.query("SELECT * FROM cloud_agent_credential_versions WHERE credential_id=$1",[request.credentialId])).rows[0];
    expect(row.ciphertext.toString("utf8")).not.toContain(secret);
    expect(openCloudAgentCredential({nonce:row.nonce,ciphertext:row.ciphertext,authTag:row.auth_tag},
      {credentialId:request.credentialId,ownerUserId:fixture.userId,kind:"cursor-api-key",version:1,keyVersion:1},{1:key})).toEqual(request.material);
    await expect(service.put({...request,displayName:"Different"})).rejects.toMatchObject({status:409});
    await expect(withSystemTx(pool,tx=>tx.query(`INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile)
      VALUES('boat','image',$1,'cursor-api-key','zeros-cloud-worker-v3')`,["a".repeat(64)]))).rejects.toMatchObject({code:"42501"});
  });
  it("requires the credential owner's explicit consent even for a workspace administrator",async()=>{
    const request=input();await service.put(request);
    expect((await pool.query("SELECT 1 FROM cloud_agent_credential_delegations")).rowCount).toBe(0);
    const other=await seedReadyCloudWorkspace(pool),grant=delegation(request.credentialId,other.userId);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'admin')",[fixture.organizationId,other.userId]);
    await pool.query("INSERT INTO organization_seat_assignments(org_id,user_id,assigned_by) VALUES($1,$2,$3)",[fixture.organizationId,other.userId,fixture.userId]);
    await new DatabaseCloudWorkspaceCollaborationService(pool).setSharing({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,
      actorUserId:fixture.userId,sharingMode:"organization",expectedRevision:1});
    await expect(service.delegate(other.userId,grant)).rejects.toMatchObject({status:404});
    const consent=await service.delegate(fixture.userId,grant);expect(consent.delegation.granteeUserId).toBe(other.userId);
    expect((await service.delegate(fixture.userId,grant)).replayed).toBe(true);
    await expect(service.revoke(other.userId,request.credentialId)).rejects.toMatchObject({status:404});
    await expect(service.revokeDelegation(other.userId,grant.id)).rejects.toMatchObject({status:404});
  });
  it("retires old material and consent on rotation, and erases material on revocation",async()=>{
    const request=input();await service.put(request);const grant=delegation(request.credentialId);await service.delegate(fixture.userId,grant);
    const next=await service.put({...request,expectedRevision:1,operationId:randomUUID(),material:{kind:"cursor-api-key",apiKey:"another-synthetic-cursor-credential"}});
    expect(next.credential.revision).toBe(2);
    expect((await pool.query("SELECT version FROM cloud_agent_credential_versions")).rows).toEqual([{version:2}]);
    expect((await pool.query("SELECT revoked_at IS NOT NULL AS revoked FROM cloud_agent_credential_delegations")).rows).toEqual([{revoked:true}]);
    await expect(service.delegate(fixture.userId,grant)).rejects.toMatchObject({status:409});
    await pool.query("UPDATE users SET staff_role=NULL WHERE id=$1",[fixture.userId]);
    expect(await service.revoke(fixture.userId,request.credentialId)).toEqual({revoked:true});
    expect((await pool.query("SELECT 1 FROM cloud_agent_credential_versions")).rowCount).toBe(0);
  });
  it("scopes external delegation to exact live workspace access and bounds models and expiration",async()=>{
    const request=input(),other=await seedReadyCloudWorkspace(pool);await service.put(request);
    const guest=await ensureUser(pool,{provider:"workos",providerSubject:`workos|${other.userId}`,email:`durable-${other.userId}@example.test`,displayName:"Guest"});
    const collaboration=new DatabaseCloudWorkspaceCollaborationService(pool),scope={workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:fixture.userId};
    const grant=delegation(request.credentialId,guest.id);
    await expect(service.delegate(fixture.userId,grant)).rejects.toMatchObject({status:404});
    await collaboration.setSharing({...scope,sharingMode:"organization",expectedRevision:1});
    const invitation=await collaboration.invite({...scope,email:guest.email,role:"developer"});
    await collaboration.accept({actorUserId:guest.id,identity:guest.identity,token:invitation.token!});
    await service.delegate(fixture.userId,grant);
    expect((await pool.query("SELECT 1 FROM organization_members WHERE org_id=$1 AND user_id=$2",[fixture.organizationId,guest.id])).rowCount).toBe(0);
    await expect(service.delegate(fixture.userId,{...grant,id:randomUUID(),models:["*"]})).rejects.toMatchObject({status:422});
    await expect(service.delegate(fixture.userId,{...grant,id:randomUUID(),expiresAt:new Date(Date.now()+31*86400000).toISOString()})).rejects.toMatchObject({status:422});
    await collaboration.revokeGuest({...scope,guestUserId:guest.id});
    await expect(service.delegate(fixture.userId,grant)).rejects.toMatchObject({status:404});
  });
  it("erases personal ciphertext and delegated authority during account purge",async()=>{
    const request=input();await service.put(request);await service.delegate(fixture.userId,delegation(request.credentialId));
    await withSystemTx(pool,tx=>eraseCloudWorkspaceCollaborationIdentity(tx,fixture.userId));
    for(const table of ["cloud_agent_credentials","cloud_agent_credential_versions","cloud_agent_credential_delegations"])
      expect((await pool.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
  });
  it("allows a replacement after many revoked profiles and canonicalizes UUID retries",async()=>{
    await pool.query(`INSERT INTO cloud_agent_credentials(id,owner_user_id,kind,display_name,last_operation_id,last_request_sha256,revoked_at)
      SELECT gen_random_uuid(),$1,'cursor-api-key','Retired',gen_random_uuid(),digest('fixture','sha256'),now() FROM generate_series(1,100)`,[fixture.userId]);
    const request=input();request.credentialId=request.credentialId.toUpperCase();request.operationId=request.operationId.toUpperCase();
    const result=await service.put(request);expect(result.credential.id).toBe(request.credentialId.toLowerCase());
    expect((await service.put({...request,credentialId:request.credentialId.toLowerCase(),operationId:request.operationId.toLowerCase()})).replayed).toBe(true);
  });
  it("requires explicit trust in BYO compute and invalidates consent when that authority changes",async()=>{
    const request=input();await service.put(request);
    const connection=(await pool.query(`SELECT provider_connection_id AS id FROM cloud_workspace_generations WHERE workspace_id=$1 AND generation=1`,[fixture.workspaceId])).rows[0].id;
    await pool.query(`UPDATE provider_connection_versions SET credential_source='delegated',endpoint='https://app.daytona.io/api',
      key_version=1,nonce=$2,ciphertext=$3,auth_tag=$4,credential_sha256=$5 WHERE connection_id=$1`,[connection,randomBytes(12),randomBytes(32),randomBytes(16),randomBytes(32)]);
    await pool.query("UPDATE provider_connections SET credential_source='delegated' WHERE id=$1",[connection]);
    const grant=delegation(request.credentialId);
    await expect(service.delegate(fixture.userId,grant)).rejects.toMatchObject({status:422});
    const computeConsent=(await service.forWorkspace(fixture.userId,fixture.workspaceId)).compute;
    expect(computeConsent.trust).toBe("compute-administrator");
    await expect(service.delegate(fixture.userId,{...grant,computeConsent:{...computeConsent,fingerprint:"a".repeat(64)}})).rejects.toMatchObject({status:422});
    await service.delegate(fixture.userId,{...grant,computeConsent});
    expect((await service.forWorkspace(fixture.userId,fixture.workspaceId)).delegations).toHaveLength(1);
    await pool.query("UPDATE provider_connection_versions SET credential_sha256=$2 WHERE connection_id=$1",[connection,randomBytes(32)]);
    expect((await service.forWorkspace(fixture.userId,fixture.workspaceId)).delegations).toHaveLength(0);
    await expect(service.delegate(fixture.userId,{...grant,computeConsent})).rejects.toMatchObject({status:422});
  });
});
