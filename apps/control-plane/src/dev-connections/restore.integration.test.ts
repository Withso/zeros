import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { seedCredentialOwner } from "../agent-credentials/test-fixtures.js";
import { DatabaseCloudAgentCredentialService } from "../agent-credentials/agent-credentials.js";
import { DevConnectionClient } from "./client.js";
import { DevConnectionRuntime } from "./runtime.js";
import { withSystemTx } from "../db.js";
import { DatabaseDevConnectionRestore } from "./restore.js";
import type { ConnectionReference } from "./types.js";
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Dev reference persistence",()=>{
  let pool:pg.Pool, fixture:Awaited<ReturnType<typeof seedCredentialOwner>>, restore:DatabaseDevConnectionRestore;
  const generation=randomUUID(), keys={keys:{1:randomBytes(32).toString("base64url")},currentKeyVersion:1};
  const reference=():ConnectionReference=>({mode:"dev-reference",bindingId:randomUUID(),connectionId:randomUUID(),generationId:generation,
    organization:"org_dev",kind:"claude-api-key",accountId:"member",appScope:"api",revision:1,consentRevision:1,
    consent:{models:["model-test"],repositories:[],scopes:["agent"]},connectionMethod:"api",expiresAt:new Date(Date.now()+86400000).toISOString()});
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});});
  afterAll(async()=>{await pool?.end();});
  afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
  beforeEach(async()=>{
    await resetMigratedTestDatabase(pool);
    fixture=await seedCredentialOwner(pool);
    await pool.query("UPDATE user_identities SET provider_sub='user_dev' WHERE user_id=$1",[fixture.userId]);
    await pool.query("INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state) VALUES($1::uuid,'org_dev',($1::uuid)::text,'active')",[fixture.organizationId]);
    restore=new DatabaseDevConnectionRestore(pool);
  });
  const mapping=()=>({issuer:"https://identity.example.test",subject:"user_dev",workosOrganizationId:"org_dev",localUserId:fixture.userId,localOrganizationId:fixture.organizationId});
  it("restores metadata and a selected login without material or image qualification, then prunes an empty exact-owner result",async()=>{
    const ref=reference(); await restore.replace(mapping(),generation,[ref]);
    const service=new DatabaseCloudAgentCredentialService(pool,keys);
    expect(await service.organizationConnections(fixture.userId,fixture.organizationId)).toMatchObject({connections:[{connected:true,credentialId:ref.bindingId}]});
    expect((await pool.query("SELECT consent_fingerprint FROM cloud_agent_organization_connections")).rows).toEqual([{consent_fingerprint:"0".repeat(64)}]);
    const versions=(await pool.query("SELECT * FROM cloud_agent_credential_versions")).rows;
    expect(versions).toHaveLength(1); expect(versions[0]).toMatchObject({material_mode:"dev-reference",ciphertext:null,nonce:null,key_version:null});
    await restore.replace(mapping(),generation,[]);
    expect(await service.organizationConnections(fixture.userId,fixture.organizationId)).toMatchObject({credentials:[]});
  });
  it("restores an all-model selection without widening an older explicit list", async () => {
    const ref = reference();
    await restore.replace(mapping(), generation, [ref]);
    const service = new DatabaseCloudAgentCredentialService(pool, keys);
    expect((await service.organizationConnections(fixture.userId, fixture.organizationId)).connections[0]).toMatchObject({ allModels: false });
    await restore.replace(mapping(), generation, [{ ...ref, consentRevision: 2, consent: { ...ref.consent, allModels: true } }]);
    expect((await service.organizationConnections(fixture.userId, fixture.organizationId)).connections[0]).toMatchObject({ allModels: true });
  });
  it("keeps a restored login ready across membership drift without changing the selection on a fresh restore",async()=>{
    const ref=reference();await restore.replace(mapping(),generation,[ref]);
    const service=new DatabaseCloudAgentCredentialService(pool,keys);
    await pool.query("UPDATE organizations SET authorization_revision=authorization_revision+1 WHERE id=$1",[fixture.organizationId]);
    expect((await service.organizationConnections(fixture.userId,fixture.organizationId)).connections[0])
      .toMatchObject({credentialId:ref.bindingId,revision:1,connected:true,health:{status:"ready"}});
    await restore.replace(mapping(),generation,[ref]);
    expect((await service.organizationConnections(fixture.userId,fixture.organizationId)).connections[0])
      .toMatchObject({credentialId:ref.bindingId,revision:1,connected:true,health:{status:"ready"}});
  });
  it("does not revise an unchanged restored selection just to replace a released consent hash",async()=>{
    const ref=reference();await restore.replace(mapping(),generation,[ref]);
    const fingerprint="a".repeat(64),hash=createHash("sha256").update(JSON.stringify([ref.bindingId,1,ref.consent.models,fingerprint])).digest();
    await pool.query("UPDATE cloud_agent_organization_connections SET consent_fingerprint=$1,request_sha256=$2",[fingerprint,hash]);
    const before=(await pool.query("SELECT * FROM cloud_agent_organization_connections")).rows;
    await restore.replace(mapping(),generation,[ref]);
    expect((await pool.query("SELECT * FROM cloud_agent_organization_connections")).rows).toEqual(before);
  });
  it.each<[string,string[]]>([
    ["reordered", ["model-b", "model-a"]],
    ["duplicated", ["model-a", "model-b", "model-a"]],
  ])("keeps the selection revision when a restored model set is %s",async(_kind,models)=>{
    const ref=reference();ref.consent.models=["model-a","model-b"];
    await restore.replace(mapping(),generation,[ref]);
    const before=(await pool.query("SELECT * FROM cloud_agent_organization_connections")).rows;
    await restore.replace(mapping(),generation,[{...ref,consent:{...ref.consent,models}}]);
    expect((await pool.query("SELECT * FROM cloud_agent_organization_connections")).rows).toEqual(before);
  });
  it("replays an exact normalized selection after restoring an unordered duplicate model set",async()=>{
    vi.stubEnv("ZEROS_DEV_CONNECTIONS_ENABLED","false");
    const ref=reference();ref.consent.models=["model-b","model-a","model-b"];
    await restore.replace(mapping(),generation,[ref]);
    const service=new DatabaseCloudAgentCredentialService(pool,keys);
    const selection={credentialId:ref.bindingId,credentialRevision:1,expectedRevision:0,models:["model-a","model-b"]};
    await expect(service.setOrganizationConnection(fixture.userId,fixture.organizationId,"claude",selection))
      .resolves.toEqual({revision:1,replayed:true});
    const expectedHash=createHash("sha256").update(JSON.stringify([ref.bindingId,1,selection.models])).digest();
    expect((await pool.query("SELECT models,request_sha256 FROM cloud_agent_organization_connections")).rows)
      .toEqual([{models:selection.models,request_sha256:expectedHash}]);
    await expect(service.setOrganizationConnection(fixture.userId,fixture.organizationId,"claude",{...selection,models:["model-a"]}))
      .rejects.toMatchObject({status:409,code:"agent_connection_conflict"});
  });
  it("rejects a changed member revision between discovery and replacement",async()=>{
    const snapshot=await restore.mapping(fixture.userId,"https://identity.example.test","user_dev","org_dev");
    await pool.query("UPDATE organization_members SET authorization_revision=authorization_revision+1 WHERE user_id=$1",[fixture.userId]);
    await expect(restore.replace(snapshot!,generation,[reference()])).rejects.toThrow();
  });
  it("consumes an exact generation cursor, invalidates on denial, and seals the original signed-in bearer",async()=>{
    const ref=reference();let events:any[]=[],deny=false;
    const client=new DevConnectionClient({deployment:'dev',enabled:true,origin:'https://connections.example.test',generation:{id:generation,credential:'a'.repeat(43),audience:'zeros-dev-connections-v1'}},async url=>{
      if(String(url).includes('/revocations'))return deny?Response.json({error:'dev_connection_denied'},{status:403}):Response.json({events});
      if(String(url).endsWith('/restore'))return Response.json({connections:[ref]});
      throw new Error('unexpected broker request');
    });
    const runtime=new DevConnectionRuntime(pool,client,keys);
    await runtime.signedIn({userId:fixture.userId,issuer:mapping().issuer,subject:'user_dev',token:'synthetic-verified-workos-bearer',expiresAt:Math.floor(Date.now()/1000)+3600});
    expect(JSON.stringify((await pool.query('SELECT * FROM dev_connection_sessions')).rows)).not.toContain('synthetic-verified-workos-bearer');
    const stored=await withSystemTx(pool,tx=>runtime.reference(tx,ref.bindingId,fixture.userId,fixture.organizationId));
    expect(await withSystemTx(pool,tx=>runtime.token(tx,stored))).toBe('synthetic-verified-workos-bearer');
    events=[{sequence:'1',binding_id:ref.bindingId,reason:'disconnect'}];await runtime.consumeInvalidations();
    await expect(withSystemTx(pool,tx=>runtime.reference(tx,ref.bindingId,fixture.userId))).rejects.toThrow();
    expect((await pool.query('SELECT sequence::text FROM dev_connection_cursors')).rows).toEqual([{sequence:'1'}]);
    await restore.replace(mapping(),generation,[ref]);deny=true;
    await expect(runtime.consumeInvalidations()).rejects.toMatchObject({code:'dev_connection_denied'});
    await expect(withSystemTx(pool,tx=>runtime.reference(tx,ref.bindingId,fixture.userId))).rejects.toThrow();
  });
  it("keeps local removal suppressed during automatic restore and preserves another owner",async()=>{
    const ref=reference();await restore.replace(mapping(),generation,[ref]);
    await pool.query('UPDATE dev_connection_references SET removed_at=now() WHERE binding_id=$1',[ref.bindingId]);
    await pool.query('UPDATE cloud_agent_credentials SET revoked_at=now() WHERE id=$1',[ref.bindingId]);
    await restore.replace(mapping(),generation,[ref]);
    expect((await new DatabaseCloudAgentCredentialService(pool,keys).list(fixture.userId)).credentials).toEqual([]);
    await expect(restore.replace({...mapping(),subject:'user_other'},generation,[])).rejects.toThrow();
  });
  it("reattaches only an explicitly selected, currently restored binding without clearing other removals",async()=>{
    const refs=[reference(),reference()]; await restore.replace(mapping(),generation,refs);
    await pool.query("UPDATE dev_connection_references SET removed_at=now()");
    await pool.query("UPDATE cloud_agent_credentials SET revoked_at=now()");
    await expect((restore as any).reattach({...mapping(),subject:'user_other'},generation,refs[0]!.bindingId,refs)).rejects.toThrow();
    await expect((restore as any).reattach(mapping(),generation,refs[0]!.bindingId,[])).rejects.toThrow();
    await (restore as any).reattach(mapping(),generation,refs[0]!.bindingId,refs);
    const service=new DatabaseCloudAgentCredentialService(pool,keys);
    expect((await service.list(fixture.userId)).credentials.map(row=>row.id)).toEqual([refs[0]!.bindingId]);
    await restore.replace(mapping(),generation,refs);
    expect((await service.list(fixture.userId)).credentials.map(row=>row.id)).toEqual([refs[0]!.bindingId]);
  });
  it("wires fresh agent and GitHub authorization to explicit broker replacement",async()=>{
    vi.stubEnv('AUTH_ISSUER',mapping().issuer);
    const original=reference(); let refs=[original]; const connected:any[]=[];
    const client=new DevConnectionClient({deployment:'dev',enabled:true,origin:'https://connections.example.test',generation:{id:generation,credential:'a'.repeat(43),audience:'zeros-dev-connections-v1'}},async(url,options)=>{
      if(String(url).includes('/revocations'))return Response.json({events:[]});
      if(String(url).endsWith('/member'))return Response.json({issuer:mapping().issuer,subject:'user_dev',organization:'org_dev'});
      if(String(url).endsWith('/restore'))return Response.json({connections:refs});
      if(String(url).endsWith('/connections')){
        const body=JSON.parse(String(options?.body));connected.push(body);
        refs=[{...reference(),connectionId:body.id,kind:body.material.kind,accountId:body.accountId,appScope:body.appScope,consent:body.consent,
          connectionMethod:body.material.kind==='github-app'?'account':'api'}];
        return Response.json({connectionId:body.id});
      }
      throw new Error('unexpected request');
    });
    const runtime=new DevConnectionRuntime(pool,client,keys);
    await runtime.signedIn({userId:fixture.userId,issuer:mapping().issuer,subject:'user_dev',token:'synthetic-workos-bearer',expiresAt:Math.floor(Date.now()/1000)+3600});
    const operationId=randomUUID();
    const result=await runtime.connectAgent({ownerUserId:fixture.userId,organizationId:fixture.organizationId,credentialId:original.bindingId,
      operationId,expectedRevision:1,material:{kind:'claude-api-key',apiKey:'synthetic-fresh-key'}} as any);
    expect(connected[0]).toMatchObject({id:operationId,accountId:original.accountId,replaceExisting:true});
    expect(result.credential.id).not.toBe(original.bindingId);
    await runtime.connectGithub(fixture.userId,{kind:'github-app',accountId:'1234',appId:'42',clientId:'test-client',accessToken:'synthetic-fresh-access',
      refreshToken:'synthetic-fresh-refresh',expiresAt:Math.floor(Date.now()/1000)+3600,refreshExpiresAt:Math.floor(Date.now()/1000)+86400});
    expect(connected[1]).toMatchObject({replaceExisting:true,accountId:'1234'});
  });
  it("preserves released local rows and rejects mixed or empty material",async()=>{
    const service=new DatabaseCloudAgentCredentialService(pool,keys);
    const local=(await service.put({ownerUserId:fixture.userId,organizationId:fixture.organizationId,credentialId:randomUUID(),operationId:randomUUID(),expectedRevision:0,displayName:"Local",material:{kind:"claude-api-key",apiKey:"synthetic-private-test-key"}})).credential;
    await restore.replace(mapping(),generation,[]);
    expect((await service.list(fixture.userId)).credentials).toContainEqual(local);
    await expect(pool.query("UPDATE cloud_agent_credential_versions SET dev_reference=$1 WHERE credential_id=$2",[reference(),local.id])).rejects.toThrow();
    await expect(pool.query("UPDATE cloud_agent_credential_versions SET nonce=NULL WHERE credential_id=$1",[local.id])).rejects.toThrow();
  });
  it("refuses a broker binding that collides with an existing local credential",async()=>{
    const ref=reference(),service=new DatabaseCloudAgentCredentialService(pool,keys);
    await service.put({ownerUserId:fixture.userId,credentialId:ref.bindingId,operationId:randomUUID(),expectedRevision:0,displayName:"Local",material:{kind:"claude-api-key",apiKey:"synthetic-local-key"}});
    await expect(restore.replace(mapping(),generation,[ref])).rejects.toThrow();
    expect((await pool.query("SELECT material_mode FROM cloud_agent_credential_versions")).rows).toEqual([{material_mode:"local"}]);
  });
  it("removes the broker's organization selection through the existing disconnect operation",async()=>{
    const ref=reference(),service=new DatabaseCloudAgentCredentialService(pool,keys);
    await restore.replace(mapping(),generation,[ref]);
    for(const [name,value] of Object.entries({ZEROS_DEPLOY_ENV:'dev',ZEROS_DEV_ENVIRONMENT:'hosted',ZEROS_DEV_CONNECTIONS_ENABLED:'true',ZEROS_DEV_GENERATION:generation,
      DEV_CONNECTIONS_GENERATION:generation,DEV_CONNECTIONS_ORIGIN:'https://connections.example.test',DEV_CONNECTIONS_AUDIENCE:'zeros-dev-connections-v1',DEV_CONNECTIONS_GENERATION_CREDENTIAL:'a'.repeat(43)}))vi.stubEnv(name,value);
    const remove=vi.spyOn(DevConnectionRuntime.prototype,'remove').mockResolvedValue({removed:true});
    await service.setOrganizationConnection(fixture.userId,fixture.organizationId,'claude',{credentialId:null,expectedRevision:1});
    expect(remove).toHaveBeenCalledWith(fixture.userId,fixture.organizationId,ref.bindingId,'organization');
  });
  it("keeps the existing credential remove operation from resurrecting a remote binding on sign-in",async()=>{
    const ref=reference(),service=new DatabaseCloudAgentCredentialService(pool,keys);
    await restore.replace(mapping(),generation,[ref]);
    for(const [name,value] of Object.entries({ZEROS_DEPLOY_ENV:'dev',ZEROS_DEV_ENVIRONMENT:'hosted',ZEROS_DEV_CONNECTIONS_ENABLED:'true',ZEROS_DEV_GENERATION:generation,
      DEV_CONNECTIONS_GENERATION:generation,DEV_CONNECTIONS_ORIGIN:'https://connections.example.test',DEV_CONNECTIONS_AUDIENCE:'zeros-dev-connections-v1',DEV_CONNECTIONS_GENERATION_CREDENTIAL:'a'.repeat(43)}))vi.stubEnv(name,value);
    await service.revoke(fixture.userId,ref.bindingId);
    await restore.replace(mapping(),generation,[ref]);
    expect((await service.list(fixture.userId)).credentials).toEqual([]);
  });
});
