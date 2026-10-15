import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { syntheticCodexCache } from "./codex-auth-test-fixture.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("selected organization account health observations",()=>{
  let pool:pg.Pool,service:DatabaseCloudAgentCredentialService,fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  const keys={currentKeyVersion:1,keys:{1:randomBytes(32).toString("base64url")},
    refreshFingerprints:{currentKeyVersion:1,keys:{1:randomBytes(32).toString("base64url")}}};
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});});
  afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{
    await resetMigratedTestDatabase(pool);fixture=await seedReadyCloudWorkspace(pool);
    service=new DatabaseCloudAgentCredentialService(pool,keys);
  });
  const read=()=>service.organizationConnections(fixture.userId,fixture.organizationId);
  async function account(expiresAt=Math.floor(Date.now()/1000)+3600,id=randomUUID(),expectedRevision=0){
    return (await service.importCodex({ownerUserId:fixture.userId,organizationId:fixture.organizationId,
      credentialId:id,operationId:randomUUID(),expectedRevision,displayName:"Synthetic account",
      nativeCache:syntheticCodexCache({expiresAt,refresh:`synthetic-refresh-${randomUUID()}`})})).credential;
  }
  async function select(id:string){
    return service.setOrganizationConnection(fixture.userId,fixture.organizationId,"codex",{
      expectedRevision:0,credentialId:id,credentialRevision:1,models:["gpt-5.6-sol"],consent:"zeros-managed"});
  }
  it("does not show an expired selected Codex account as connected just because a fresh unselected import exists",async()=>{
    const expiresAt=Math.floor(Date.now()/1000)-3600,old=await account(expiresAt);await select(old.id);
    const fresh=await account();
    const result=await read();
    expect(result.connections).toMatchObject([{credentialId:old.id,connected:false,health:{version:1,status:"expired",
      selectedCredentialRevision:1,credentialRevision:1,materialVersion:1,expiresAt:new Date(expiresAt*1000).toISOString(),refresh:"reconnect_required"}}]);
    expect(result.credentials.map(row=>row.id)).toEqual(expect.arrayContaining([old.id,fresh.id]));
    expect(JSON.stringify(result)).not.toMatch(/refresh_token|access_token|ciphertext|binding_sha256/);
  });
  it("reports the cold-boot material floor as expiring rather than usable",async()=>{
    const expiresAt=Math.floor(Date.now()/1000)+20,credential=await account(expiresAt);await select(credential.id);
    expect((await read()).connections).toMatchObject([{connected:false,health:{status:"expiring",refresh:"reconnect_required"}}]);
  });
  it("keeps non-expiring API accounts connected without suggesting refresh authority",async()=>{
    const credential=(await service.put({ownerUserId:fixture.userId,organizationId:fixture.organizationId,
      credentialId:randomUUID(),operationId:randomUUID(),expectedRevision:0,displayName:"Synthetic API",
      material:{kind:"codex-api-key",apiKey:"synthetic-codex-api-for-health-tests"}})).credential;
    await select(credential.id);
    expect((await read()).connections).toMatchObject([{connected:true,health:{status:"ready",expiresAt:null,refresh:"not_applicable"}}]);
  });
  it.each([
    {state:"ready",age:0,refresh:"idle"},
    {state:"reserved",age:1,refresh:"in_progress"},
    {state:"dispatched",age:1,refresh:"in_progress"},
    {state:"reserved",age:20,refresh:"idle"},
    {state:"dispatched",age:20,refresh:"reconnect_required"},
    {state:"uncertain",age:1,refresh:"reconnect_required"},
  ])("observes $state refresh at age $age without renewing or mutating it",async({state,age,refresh})=>{
    const credential=await account();await select(credential.id);
    if(state!=="ready")await pool.query(`UPDATE cloud_codex_auth_caches SET state=$2,attempt_id=$3,
      attempt_started_at=clock_timestamp()-($4::int*interval '1 second') WHERE credential_id=$1`,[credential.id,state,randomUUID(),age]);
    const metadata=async()=>(await pool.query("SELECT state,attempt_id,attempt_started_at,material_version,updated_at FROM cloud_codex_auth_caches WHERE credential_id=$1",[credential.id])).rows[0];
    const before=await metadata();
    expect((await read()).connections).toMatchObject([{connected:true,health:{status:"ready",refresh}}]);
    expect(await metadata()).toEqual(before);
  });
  it.each(["revision","material","missing"])("does not attribute a mismatched %s refresh record to the selected source",async mismatch=>{
    const credential=await account();await select(credential.id);
    if(mismatch==="revision")await pool.query("UPDATE cloud_codex_auth_caches SET credential_revision=2 WHERE credential_id=$1",[credential.id]);
    if(mismatch==="material")await pool.query("UPDATE cloud_codex_auth_caches SET material_version=2 WHERE credential_id=$1",[credential.id]);
    if(mismatch==="missing")await pool.query("DELETE FROM cloud_codex_auth_caches WHERE credential_id=$1",[credential.id]);
    expect((await read()).connections).toMatchObject([{connected:true,health:{status:"ready",refresh:"unavailable"}}]);
  });
  it.each(["association","revocation"])("does not retain health from a selected source after losing its %s",async missing=>{
    const credential=await account();await select(credential.id);
    if(missing==="association")await pool.query("DELETE FROM cloud_agent_credential_organizations WHERE org_id=$1 AND credential_id=$2",[fixture.organizationId,credential.id]);
    else await pool.query("UPDATE cloud_agent_credentials SET revoked_at=now() WHERE id=$1",[credential.id]);
    expect((await read()).connections).toMatchObject([{connected:false,credentialId:credential.id,health:{status:"credential_unavailable",
      selectedCredentialRevision:1,credentialRevision:null,materialVersion:null,expiresAt:null,refresh:"not_applicable"}}]);
  });
  it("distinguishes the selected revision from a newer vault revision",async()=>{
    const credential=await account();await select(credential.id);
    await account(Math.floor(Date.now()/1000)+3600,credential.id,1);
    expect((await read()).connections).toMatchObject([{connected:false,health:{status:"credential_changed",
      selectedCredentialRevision:1,credentialRevision:2,materialVersion:2,refresh:"unavailable"}}]);
  });
  it("keeps organization consent and membership ahead of any credential health observation",async()=>{
    const credential=await account();await select(credential.id);
    await pool.query("UPDATE organization_members SET authorization_revision=authorization_revision+1 WHERE org_id=$1 AND user_id=$2",[fixture.organizationId,fixture.userId]);
    expect((await read()).connections).toMatchObject([{connected:false,health:{status:"consent_required",refresh:"unavailable"}}]);
    const other=await seedReadyCloudWorkspace(pool);
    await expect(service.organizationConnections(other.userId,fixture.organizationId)).rejects.toMatchObject({status:404});
    await expect(service.organizationConnections(fixture.userId,other.organizationId)).rejects.toMatchObject({status:404});
  });
  it("reports disconnection without retaining selected credential or refresh metadata",async()=>{
    const credential=await account();await select(credential.id);
    await service.setOrganizationConnection(fixture.userId,fixture.organizationId,"codex",{expectedRevision:1,credentialId:null});
    expect((await read()).connections).toMatchObject([{connected:false,credentialId:null,health:{status:"not_selected",
      selectedCredentialRevision:null,credentialRevision:null,materialVersion:null,expiresAt:null,refresh:"not_applicable"}}]);
  });
});
