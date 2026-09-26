import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {runMigrations} from "../migrate.js";
import {ensureUser} from "../auth.js";
import {ensureCloudPilotUser,seedReadyCloudWorkspace} from "./test-fixtures.js";
import {DatabaseCloudAgentCredentialService} from "./agent-credentials.js";
import {DatabaseCloudAgentExecutionService} from "./agent-executions.js";
import {DatabaseCloudWorkspaceActorSessionService} from "./actor-sessions.js";
import {cloudWorkspaceDeviceProofMessage} from "./replicas.js";
import {DatabaseCloudWorkspaceCommandService} from "./commands.js";
import {withSystemTx} from "../db.js";
import {DatabaseCloudWorkspaceCollaborationService,eraseCloudWorkspaceCollaborationIdentity} from "./actors.js";
import {DatabaseCodexAuthRenewal} from "./codex-auth-renewal.js";
import {syntheticCodexCache} from "./codex-auth-test-fixture.js";
import {DatabaseCloudWorkspaceActionService} from "./action-receipts.js";
import {interceptQueries,withAuthorityDeadlineBarrier,pauseBeforeQuery,withHeldEngineRows} from "./authority-deadline-test-utils.js";

const d=process.env.TEST_DATABASE_URL?describe:describe.skip;
// Measured budgets for the approval path (see the statement-budget test).
const APPROVAL_BEGIN_STATEMENTS=59,APPROVAL_RECHECK_STATEMENTS=28,LEASE_VALIDATION_STATEMENTS=15;
d("private provider execution leases",()=>{
  let pool:pg.Pool,fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>,owner:Awaited<ReturnType<typeof ensureUser>>;
  let credentials:DatabaseCloudAgentCredentialService,service:DatabaseCloudAgentExecutionService,actorSessionId:string,credentialId:string,delegationId:string;
  const encryption={keys:{1:randomBytes(32).toString("base64url")},currentKeyVersion:1,refreshFingerprints:{keys:{1:randomBytes(32).toString("base64url")},currentKeyVersion:1}},secret="synthetic-cursor-credential-key";
  const engine=()=>({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,generation:1,engineInstanceId:fixture.engineInstanceId,heartbeatToken:fixture.heartbeatToken});
  const admission=()=>({executionId:randomUUID(),delegationId,provider:"cursor" as const,model:"grok-4.6",source:{kind:"session" as const,actorSessionId}});
  async function connectActor(user:typeof owner){
    const pair=generateKeyPairSync("ed25519"),publicKey=Buffer.from(pair.publicKey.export({format:"jwk"}).x!,"base64url");
    const device=(await pool.query<{id:string}>("INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Actor device','macos',$2,$3) RETURNING id",
      [user.id,publicKey,createHash("sha256").update(publicKey).digest()])).rows[0]!;
    const fields={deviceId:device.id,keyVersion:1,timestampMs:Date.now(),nonce:randomBytes(24).toString("base64url")};
    const proof={...fields,signature:sign(null,cloudWorkspaceDeviceProofMessage({...fields,accountUserId:user.id,action:"engine.connect",payload:{organizationId:fixture.organizationId,workspaceId:fixture.workspaceId}}),pair.privateKey).toString("base64url")};
    const sessions=new DatabaseCloudWorkspaceActorSessionService({pool,enginePort:39393,bridgeUrl:"wss://api.example.test/v1/cloud-workspaces/bridge",workosEnabled:false});
    const actor=await sessions.issue({...engine(),actorUserId:user.id,authenticatedUser:user,proof});return (await sessions.consume({...engine(),token:actor.grantToken})).actorSessionId;
  }
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:6});});
  afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");await runMigrations(pool);fixture=await seedReadyCloudWorkspace(pool);
    await new DatabaseCloudWorkspaceCollaborationService(pool).setSharing({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,
      actorUserId:fixture.userId,sharingMode:"organization",expectedRevision:1});
    owner=await ensureUser(pool,{provider:"workos",providerSubject:`workos|${fixture.userId}`,email:`durable-${fixture.userId}@example.test`,displayName:"Owner",
      session:{id:`session_${randomUUID()}`,clientKind:"desktop",authTime:Math.floor(Date.now()/1000),tokenExpiresAt:Math.floor(Date.now()/1000)+3600}});
    await pool.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '1 hour')",
      [owner.authentication.sessionId,owner.identity.subject,owner.id]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=2,agent_runtime_profile='zeros-cloud-worker-v3',agent_runtime_contract_sha256=$2 WHERE id=$1",[fixture.engineInstanceId,"a".repeat(64)]);
    await pool.query(`INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled)
      VALUES('daytona','snapshot-pinned',$1,'cursor-api-key','zeros-cloud-worker-v3',true)`,["a".repeat(64)]);
    actorSessionId=await connectActor(owner);
    credentials=new DatabaseCloudAgentCredentialService(pool,encryption);service=new DatabaseCloudAgentExecutionService(pool,encryption,false);
    credentialId=randomUUID();await credentials.put({ownerUserId:owner.id,credentialId,operationId:randomUUID(),expectedRevision:0,displayName:"Cursor",material:{kind:"cursor-api-key",apiKey:secret}});
    delegationId=randomUUID();await credentials.delegate(owner.id,{id:delegationId,credentialId,expectedRevision:1,workspaceId:fixture.workspaceId,granteeUserId:owner.id,
      models:["grok-4.6"],expiresAt:new Date(Date.now()+3600_000).toISOString()});
  });
  async function codexCredential(expiresAt=Math.floor(Date.now()/1000)+3600){
    const nativeCache=syntheticCodexCache({expiresAt,refresh:`synthetic-refresh-${randomUUID()}`});
    const input={ownerUserId:owner.id,credentialId:randomUUID(),operationId:randomUUID(),expectedRevision:0,displayName:"Codex",nativeCache};
    await credentials.importCodex(input);
    const grant=randomUUID();await credentials.delegate(owner.id,{id:grant,credentialId:input.credentialId,expectedRevision:1,workspaceId:fixture.workspaceId,
      granteeUserId:owner.id,models:["gpt-5.6-sol"],expiresAt:new Date(Date.now()+3600_000).toISOString()});
    await pool.query(`INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled)
      VALUES('daytona','snapshot-pinned',$1,'codex-chatgpt','zeros-cloud-worker-v3',true) ON CONFLICT DO NOTHING`,["a".repeat(64)]);
    return {input,grant,request:{executionId:randomUUID(),delegationId:grant,provider:"codex" as const,model:"gpt-5.6-sol",source:{kind:"session" as const,actorSessionId}}};
  }
  it.each(["renew", "replay", "action"] as const)("rejects lease expiry after the %s transaction starts",async operation=>{
    const request=admission(),lease=await service.admit(engine(),request);
    let expired:Date|undefined;
    const controlled=withAuthorityDeadlineBarrier(pool,/cloud_workspace_engine_authority_current/,async()=>{
      expired=(await pool.query("UPDATE cloud_agent_execution_leases SET expires_at=clock_timestamp() WHERE id=$1 RETURNING expires_at",[lease.leaseId])).rows[0].expires_at;
    });
    const waiting=new DatabaseCloudAgentExecutionService(controlled,encryption,false);
    const result=operation==="renew"?waiting.validate(engine(),lease.leaseId,true):operation==="replay"?waiting.admit(engine(),request):waiting.authorizeAction(engine(),request.executionId,actorSessionId);
    await expect(result).rejects.toMatchObject({code:"cloud_agent_authority_rejected"});
    expect((await pool.query("SELECT expires_at FROM cloud_agent_execution_leases WHERE id=$1",[lease.leaseId])).rows[0].expires_at).toEqual(expired);
  });
  it.each((["admit","rotation","action"] as const).flatMap(operation=>(["engine","source","pro","guest"] as const).map(deadline=>({operation,deadline}))))(
    "rejects $deadline expiry during the final credential wait for $operation",async({operation,deadline})=>{
    const guest=await ensureCloudPilotUser(pool,{provider:"workos",providerSubject:`user_${randomUUID()}`,email:`guest-${randomUUID()}@example.test`,displayName:"Guest",
      session:{id:`session_${randomUUID()}`,clientKind:"desktop",authTime:Math.floor(Date.now()/1000),tokenExpiresAt:Math.floor(Date.now()/1000)+3600}});
    guest.accountRevision=Number((await pool.query("SELECT auth_revision FROM users WHERE id=$1",[guest.id])).rows[0].auth_revision);
    await pool.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '1 hour')",
      [guest.authentication.sessionId,guest.identity.subject,guest.id]);
    await pool.query("INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')",[guest.id]);
    // Test the paid deadline independently of the fixture's free staff Pro.
    if(deadline==="pro")await pool.query("UPDATE staff_pro_benefits SET revoked_at=clock_timestamp() WHERE user_id=$1",[guest.id]);
    const collaboration=new DatabaseCloudWorkspaceCollaborationService(pool),invite=await collaboration.invite({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,
      actorUserId:owner.id,email:guest.email,role:"developer"});
    await collaboration.accept({actorUserId:guest.id,identity:guest.identity,token:invite.token});
    const guestSession=await connectActor(guest),grant=randomUUID(),codex=operation==="rotation"?await codexCredential():null;
    await credentials.delegate(owner.id,{id:grant,credentialId:codex?.input.credentialId??credentialId,expectedRevision:1,workspaceId:fixture.workspaceId,granteeUserId:guest.id,
      models:[codex?"gpt-5.6-sol":"grok-4.6"],expiresAt:new Date(Date.now()+3600_000).toISOString()});
    const request={...(codex?.request??admission()),delegationId:grant,source:{kind:"session" as const,actorSessionId:guestSession}};
    const lease=operation==="admit"?null:await service.admit(engine(),request);
    if(codex){
      const renewing=new DatabaseCloudAgentExecutionService(pool,encryption,false,new DatabaseCodexAuthRenewal(pool,encryption,async(_cache,dispatch)=>{
        await dispatch();return syntheticCodexCache({refresh:`rotated-refresh-${randomUUID()}`,expiresAt:Math.floor(Date.now()/1000)+7200});
      }));
      expect(await renewing.validate(engine(),lease!.leaseId,true,1,true)).toMatchObject({credentialVersion:2,rotation:{material:{kind:"codex-chatgpt"}}});
    }
    let intercepted=false;
    const controlled=withAuthorityDeadlineBarrier(pool,/FOR SHARE OF delegation,material/,async client=>{
      intercepted=true;
      // The engine is already locked by this transaction. Move its deadline on
      // that connection to model elapsed time without an impossible competing
      // writer or a timing-sensitive sleep. All changes roll back on rejection.
      if(deadline==="engine")await client.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp() WHERE id=$1",[fixture.engineInstanceId]);
      if(deadline==="source")await pool.query("UPDATE auth_sessions SET provider_session_expires_at=clock_timestamp() WHERE provider_session_id=$1",[guest.authentication.sessionId]);
      if(deadline==="pro")await pool.query("UPDATE account_entitlements SET valid_until=clock_timestamp() WHERE user_id=$1",[guest.id]);
      if(deadline==="guest")await pool.query("UPDATE cloud_workspace_guest_grants SET expires_at=clock_timestamp() WHERE user_id=$1",[guest.id]);
    });
    const waiting=new DatabaseCloudAgentExecutionService(controlled,encryption,false);
    const result=operation==="admit"?waiting.admit(engine(),request):operation==="rotation"?waiting.validate(engine(),lease!.leaseId,true,1):waiting.authorizeAction(engine(),request.executionId,guestSession);
    await expect(result).rejects.toBeDefined();expect(intercepted).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_agent_execution_leases")).rows[0].n).toBe(lease?1:0);
  });
  it("imports an expired native access token only to renew before admitting a worker",async()=>{
    const c=await codexCredential(Math.floor(Date.now()/1000)-60),renew=vi.fn(async(_cache,dispatch)=>{await dispatch();return syntheticCodexCache({refresh:`rotated-refresh-${randomUUID()}`});});
    service=new DatabaseCloudAgentExecutionService(pool,encryption,false,new DatabaseCodexAuthRenewal(pool,encryption,renew));
    expect((await service.admit(engine(),c.request)).credentialVersion).toBe(2);expect(renew).toHaveBeenCalledTimes(1);
  });
  it.each(["engine","session","execution","delegation"] as const)("rolls back an action receipt when %s expires during its insert",async deadline=>{
    const request=admission(),lease=await service.admit(engine(),request);
    const controlled=withAuthorityDeadlineBarrier(pool,/INSERT INTO cloud_workspace_action_receipts/,async client=>{
      if(deadline==="engine")await client.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp() WHERE id=$1",[fixture.engineInstanceId]);
      if(deadline==="session")await client.query("UPDATE cloud_workspace_actor_sessions SET last_renewed_at=clock_timestamp()-interval '30 seconds' WHERE id=$1",[actorSessionId]);
      if(deadline==="execution")await client.query("UPDATE cloud_agent_execution_leases SET expires_at=clock_timestamp() WHERE id=$1",[lease.leaseId]);
      if(deadline==="delegation")await client.query("UPDATE cloud_agent_credential_delegations SET expires_at=clock_timestamp() WHERE id=$1",[delegationId]);
    });
    const actions=new DatabaseCloudWorkspaceActionService({pool:controlled});
    await expect(actions.request({...engine(),actorSessionId},{kind:"begin",admissible:true,action:{operationId:randomUUID(),conversationId:"chat",
      executionId:request.executionId,kind:"permission",requestId:randomUUID(),payload:{response:{outcome:"cancelled"}}}})).rejects.toBeDefined();
    expect((await pool.query("SELECT 1 FROM cloud_workspace_action_receipts")).rowCount).toBe(0);
  });
  it("renews native Codex material without changing consent, delegations or import receipts",async()=>{
    const expiresAt=Math.floor(Date.now()/1000)+3600;
    const c=await codexCredential(Math.floor(Date.now()/1000)+120),updated=syntheticCodexCache({refresh:`rotated-refresh-${randomUUID()}`,expiresAt});
    const renew=vi.fn(async(_cache,dispatch)=>{await dispatch();return updated;});
    service=new DatabaseCloudAgentExecutionService(pool,encryption,false,new DatabaseCodexAuthRenewal(pool,encryption,renew));
    const authority=await service.admit(engine(),c.request);
    expect(renew).toHaveBeenCalledTimes(1);expect(authority.credentialVersion).toBe(2);
    expect(authority.material).toEqual({kind:"codex-chatgpt",accessToken:updated.tokens.access_token,accountId:updated.tokens.account_id,expiresAt});
    expect(JSON.stringify(authority)).not.toMatch(/refresh_token|id_token|last_refresh/);
    expect((await pool.query("SELECT revision,current_version FROM cloud_agent_credentials WHERE id=$1",[c.input.credentialId])).rows[0]).toEqual({revision:"1",current_version:2});
    expect((await pool.query("SELECT revoked_at FROM cloud_agent_credential_delegations WHERE id=$1",[c.grant])).rows[0]!.revoked_at).toBeNull();
    expect(await credentials.importCodex(c.input)).toMatchObject({replayed:true,credential:{revision:1}});
    expect((await service.admit(engine(),c.request)).credentialVersion).toBe(2);expect(renew).toHaveBeenCalledTimes(1);
  });
  it("returns only access material on a current lease after a forced Codex renewal",async()=>{
    const c=await codexCredential(),updated=syntheticCodexCache({refresh:`rotated-refresh-${randomUUID()}`,expiresAt:Math.floor(Date.now()/1000)+7200});
    const renew=vi.fn(async(_cache,dispatch)=>{await dispatch();return updated;});
    service=new DatabaseCloudAgentExecutionService(pool,encryption,false,new DatabaseCodexAuthRenewal(pool,encryption,renew));
    const authority=await service.admit(engine(),c.request);
    const response=await service.validate(engine(),authority.leaseId,true,authority.credentialVersion,true);
    expect(response).toMatchObject({credentialVersion:2,rotation:{authorityId:authority.authorityId,material:{kind:"codex-chatgpt",accessToken:updated.tokens.access_token}}});
    expect(JSON.stringify(response)).not.toMatch(/refresh_token|id_token|last_refresh/);
    expect(await service.validate(engine(),authority.leaseId,true,1,true)).toMatchObject({credentialVersion:2,rotation:response.rotation});expect(renew).toHaveBeenCalledTimes(1);
    await expect(service.validate(engine(),authority.leaseId,true,2,true)).rejects.toMatchObject({status:409});
  });
  it("waits outside authorization locks for a credential publication without retiring live executions",async()=>{
    const c=await codexCredential(),one=await service.admit(engine(),c.request),two=await service.admit(engine(),{...c.request,executionId:randomUUID()});
    const publisher=await pool.connect();await publisher.query("BEGIN");await publisher.query("SELECT id FROM cloud_agent_credentials WHERE id=$1 FOR UPDATE",[c.input.credentialId]);
    const first=service.validate(engine(),one.leaseId,true,one.credentialVersion),second=service.validate(engine(),two.leaseId,true,two.credentialVersion);
    const outcomes=Promise.allSettled([first,second]);
    try{await new Promise(resolve=>setTimeout(resolve,100));}finally{await publisher.query("ROLLBACK");publisher.release();}
    expect((await outcomes).map(result=>result.status)).toEqual(["fulfilled","fulfilled"]);
  });
  it.each(["release","expiry"])("never revives a lease after %s while native refresh is pending",async stop=>{
    const c=await codexCredential();let leaseId:string;
    const renew=vi.fn(async(_cache,dispatch)=>{
      await dispatch();
      if(stop==="release")await service.release(engine(),leaseId);
      else await pool.query("UPDATE cloud_agent_execution_leases SET created_at=now()-interval '1 minute',expires_at=now()-interval '1 second' WHERE id=$1",[leaseId]);
      return syntheticCodexCache({refresh:`rotated-refresh-${randomUUID()}`,expiresAt:Math.floor(Date.now()/1000)+7200});
    });
    service=new DatabaseCloudAgentExecutionService(pool,encryption,false,new DatabaseCodexAuthRenewal(pool,encryption,renew));
    const authority=await service.admit(engine(),c.request);leaseId=authority.leaseId;
    await expect(service.validate(engine(),leaseId,true,authority.credentialVersion,true)).rejects.toMatchObject({status:403});
    expect((await pool.query("SELECT material_version FROM cloud_codex_auth_caches WHERE credential_id=$1",[c.input.credentialId])).rows[0]!.material_version).toBe(2);
  });
  it("preserves rotated cache but withholds delivery when delegation is revoked during refresh",async()=>{
    const c=await codexCredential(Math.floor(Date.now()/1000)+120);
    const renew=vi.fn(async(_cache,dispatch)=>{await dispatch();await credentials.revokeDelegation(owner.id,c.grant);return syntheticCodexCache({refresh:`rotated-refresh-${randomUUID()}`});});
    service=new DatabaseCloudAgentExecutionService(pool,encryption,false,new DatabaseCodexAuthRenewal(pool,encryption,renew));
    await expect(service.admit(engine(),c.request)).rejects.toMatchObject({status:403});
    expect((await pool.query("SELECT state,material_version FROM cloud_codex_auth_caches WHERE credential_id=$1",[c.input.credentialId])).rows[0]).toEqual({state:"ready",material_version:2});
    expect((await pool.query("SELECT 1 FROM cloud_agent_execution_leases")).rowCount).toBe(0);
  });
  it("replays an admission without duplicate execution and keeps validation free of credential material",async()=>{
    const request=admission(),[one,two]=await Promise.all([service.admit(engine(),request),service.admit(engine(),request)]);
    expect(one).toEqual(two);expect(one.material).toEqual({kind:"cursor-api-key",apiKey:secret});
    expect((await pool.query("SELECT 1 FROM cloud_agent_execution_leases")).rowCount).toBe(1);
    const valid=await service.validate(engine(),one.leaseId,true);expect(valid.leaseId).toBe(one.leaseId);expect(JSON.stringify(valid)).not.toContain(secret);
    await service.release(engine(),one.leaseId);await expect(service.admit(engine(),request)).rejects.toMatchObject({status:403});
  });
  it("denies unqualified images, authentication modes, models, and a forged engine",async()=>{
    await expect(service.admit({...engine(),heartbeatToken:`zwh_${randomBytes(32).toString("base64url")}`},admission())).rejects.toThrow();
    await expect(service.admit(engine(),{...admission(),model:"another-model"})).rejects.toMatchObject({status:403});
    await expect(service.admit(engine(),{...admission(),provider:"codex"})).rejects.toMatchObject({status:403});
    await pool.query("UPDATE cloud_agent_runtime_qualifications SET enabled=false");
    await expect(service.admit(engine(),admission())).rejects.toMatchObject({status:403});
    await pool.query("UPDATE cloud_agent_runtime_qualifications SET enabled=true,runtime_contract_sha256=$1",["b".repeat(64)]);
    await expect(service.admit(engine(),admission())).rejects.toMatchObject({status:403});
    expect((await pool.query("SELECT 1 FROM cloud_agent_execution_leases")).rowCount).toBe(0);
  });
  it("authorizes an approval beside other engine work but waits behind a revocation",async()=>{
    const request=admission();await service.admit(engine(),request);
    const rows={workspaceId:fixture.workspaceId,engineInstanceId:fixture.engineInstanceId};
    const authorize=(lockPool:pg.Pool)=>new DatabaseCloudAgentExecutionService(lockPool,encryption,false).authorizeAction(engine(),request.executionId,actorSessionId);
    await expect(withHeldEngineRows(pool,rows,"SHARE",authorize)).resolves.toEqual({authorized:true,executionId:request.executionId,actorSessionId});
    await expect(withHeldEngineRows(pool,rows,"UPDATE",authorize)).rejects.toMatchObject({code:"55P03"});
  });
  it("begins an approval and rechecks its actor within a fixed statement budget",async()=>{
    // Every statement is a database round trip while the approval holds the
    // workspace and engine rows, so the approval path keeps an exact budget.
    const request=admission(),lease=await service.admit(engine(),request);
    const statements:string[]=[],counted=interceptQueries(pool,sql=>{statements.push(sql);});
    const begun=await new DatabaseCloudWorkspaceActionService({pool:counted}).request({...engine(),actorSessionId},{kind:"begin",admissible:true,
      action:{operationId:randomUUID(),conversationId:"chat",executionId:request.executionId,kind:"permission",requestId:randomUUID(),payload:{response:{outcome:"cancelled"}}}});
    expect(begun).toMatchObject({state:"dispatching",replayed:false});
    const beginStatements=statements.length;statements.length=0;
    const executions=new DatabaseCloudAgentExecutionService(counted,encryption,false);
    await expect(executions.authorizeAction(engine(),request.executionId,actorSessionId)).resolves.toMatchObject({authorized:true});
    const authorizeStatements=statements.length;statements.length=0;
    await expect(executions.validate(engine(),lease.leaseId)).resolves.toMatchObject({leaseId:lease.leaseId});
    expect({begin:beginStatements,authorize:authorizeStatements,validate:statements.length})
      .toEqual({begin:APPROVAL_BEGIN_STATEMENTS,authorize:APPROVAL_RECHECK_STATEMENTS,validate:LEASE_VALIDATION_STATEMENTS});
  });
  it("authorizes an approval while that device's admission renewal holds its session",async()=>{
    const pair=generateKeyPairSync("ed25519"),publicKey=Buffer.from(pair.publicKey.export({format:"jwk"}).x!,"base64url");
    const device=(await pool.query<{id:string}>("INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Renewing device','macos',$2,$3) RETURNING id",
      [owner.id,publicKey,createHash("sha256").update(publicKey).digest()])).rows[0]!;
    const fields={deviceId:device.id,keyVersion:1,timestampMs:Date.now(),nonce:randomBytes(24).toString("base64url")};
    const proof={...fields,signature:sign(null,cloudWorkspaceDeviceProofMessage({...fields,accountUserId:owner.id,action:"engine.connect",payload:{organizationId:fixture.organizationId,workspaceId:fixture.workspaceId}}),pair.privateKey).toString("base64url")};
    const sessions=new DatabaseCloudWorkspaceActorSessionService({pool,enginePort:39393,bridgeUrl:"wss://api.example.test/v1/cloud-workspaces/bridge",workosEnabled:false});
    const grant=await sessions.issue({...engine(),actorUserId:owner.id,authenticatedUser:owner,proof});
    const renewing=(await sessions.consume({...engine(),token:grant.grantToken})).actorSessionId;
    const request={...admission(),source:{kind:"session" as const,actorSessionId:renewing}};await service.admit(engine(),request);
    // Hold the renewal after it has locked the session row.
    const barrier=pauseBeforeQuery(pool,/UPDATE cloud_workspace_actor_sessions\s+SET consumed_at/);
    const renewal=new DatabaseCloudWorkspaceActorSessionService({pool:barrier.pool,enginePort:39393,bridgeUrl:"wss://api.example.test/v1/cloud-workspaces/bridge",workosEnabled:false})
      .consume({...engine(),token:grant.grantToken,renew:true});
    await barrier.atBarrier;
    try {
      await expect(service.authorizeAction(engine(),request.executionId,renewing)).resolves.toEqual({authorized:true,executionId:request.executionId,actorSessionId:renewing});
    } finally { barrier.release(); }
    await expect(renewal).resolves.toMatchObject({admitted:true});
  });
  it("requires current actor and credential-owner consent at every tool authorization",async()=>{
    const lease=await service.admit(engine(),admission());await credentials.revokeDelegation(owner.id,delegationId);
    await expect(service.validate(engine(),lease.leaseId)).rejects.toMatchObject({status:403});
    await expect(service.validate(engine(),lease.leaseId,true)).rejects.toMatchObject({status:403});
  });
  it("requires live credential consent before retaining a new paid action",async()=>{
    const request=admission();await service.admit(engine(),request);await credentials.revokeDelegation(owner.id,delegationId);
    const actions=new DatabaseCloudWorkspaceActionService({pool});
    await expect(actions.request({...engine(),actorSessionId},{kind:"begin",admissible:true,action:{operationId:randomUUID(),conversationId:"chat",
      executionId:request.executionId,kind:"permission",requestId:randomUUID(),payload:{response:{outcome:{outcome:"selected",optionId:"allow"}}}}})).rejects.toMatchObject({status:403});
    expect((await pool.query("SELECT 1 FROM cloud_workspace_action_receipts")).rowCount).toBe(0);
  });
  it("requires each collaborator's exact consent, supports a second device, and never replays a native delivery",async()=>{
    const other=await seedReadyCloudWorkspace(pool);
    const member=await ensureUser(pool,{provider:"workos",providerSubject:`workos|${other.userId}`,email:`durable-${other.userId}@example.test`,displayName:"Member",
      session:{id:`session_${randomUUID()}`,clientKind:"desktop",authTime:Math.floor(Date.now()/1000),tokenExpiresAt:Math.floor(Date.now()/1000)+3600}});
    await pool.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '1 hour')",
      [member.authentication.sessionId,member.identity.subject,member.id]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'admin')",[fixture.organizationId,member.id]);
    await pool.query("INSERT INTO organization_seat_assignments(org_id,user_id,assigned_by) VALUES($1,$2,$3)",[fixture.organizationId,member.id,owner.id]);
    const memberSession=await connectActor(member),secondDevice=await connectActor(owner),request=admission();await service.admit(engine(),request);
    await expect(service.authorizeAction(engine(),request.executionId,secondDevice)).resolves.toEqual({authorized:true,executionId:request.executionId,actorSessionId:secondDevice});
    await expect(service.authorizeAction(engine(),request.executionId,memberSession)).rejects.toMatchObject({status:403});
    const actions=new DatabaseCloudWorkspaceActionService({pool}),action={kind:"begin",admissible:true,action:{operationId:randomUUID(),conversationId:"chat",
      executionId:request.executionId,kind:"steer",requestId:"message",payload:{userMessageId:"message"}}};
    await expect(actions.request({...engine(),actorSessionId:memberSession},action)).rejects.toMatchObject({status:403});
    const grant={id:randomUUID(),credentialId,expectedRevision:1,workspaceId:fixture.workspaceId,granteeUserId:member.id,models:["grok-4.6"],expiresAt:new Date(Date.now()+3600_000).toISOString()};
    await credentials.delegate(owner.id,grant);
    const allowed=await service.authorizeAction(engine(),request.executionId,memberSession);expect(allowed).toEqual({authorized:true,executionId:request.executionId,actorSessionId:memberSession});
    expect(JSON.stringify(allowed)).not.toContain(secret);
    const receipt=await actions.request({...engine(),actorSessionId:memberSession},action);expect(receipt.replayed).toBe(false);
    await credentials.revokeDelegation(owner.id,grant.id);
    await expect(service.authorizeAction(engine(),request.executionId,memberSession)).rejects.toMatchObject({status:403});
    // Historical receipts remain observable but cannot grant another dispatch.
    expect(await actions.request({...engine(),actorSessionId:memberSession},action)).toMatchObject({replayed:true,claimId:receipt.claimId});
    await expect(actions.request({...engine(),actorSessionId:memberSession},{...action,action:{...action.action,operationId:randomUUID()}})).rejects.toMatchObject({status:403});
    await service.authorizeAction(engine(),request.executionId,secondDevice);
    await credentials.revokeDelegation(owner.id,delegationId);
    await credentials.delegate(owner.id,{...grant,id:randomUUID()});
    await expect(service.authorizeAction(engine(),request.executionId,memberSession)).rejects.toMatchObject({status:403});
  });
  it("preserves admitted work after disconnect but rejects explicit WorkOS session revocation",async()=>{
    const lease=await service.admit(engine(),admission());
    await pool.query("UPDATE cloud_workspace_actor_sessions SET last_renewed_at=now()-interval '1 minute' WHERE id=$1",[actorSessionId]);
    await expect(service.validate(engine(),lease.leaseId,true)).resolves.toHaveProperty("leaseId",lease.leaseId);
    await expect(service.admit(engine(),admission())).rejects.toMatchObject({status:401});
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1",[owner.authentication.sessionId]);
    await expect(service.validate(engine(),lease.leaseId)).rejects.toMatchObject({status:401});
  });
  it("does not resurrect expired leases or accept a different workspace",async()=>{
    const request=admission(),lease=await service.admit(engine(),request);
    await expect(service.validate({...engine(),workspaceId:randomUUID()},lease.leaseId)).rejects.toThrow();
    await pool.query("UPDATE cloud_agent_execution_leases SET created_at=now()-interval '1 hour',expires_at=now()-interval '1 second' WHERE id=$1",[lease.leaseId]);
    await expect(service.validate(engine(),lease.leaseId,true)).rejects.toMatchObject({status:403});
    await expect(service.admit(engine(),request)).rejects.toMatchObject({status:403});
  });
  it("binds queued spending to its exact command claim and selected delegation",async()=>{
    const commands=new DatabaseCloudWorkspaceCommandService({pool}),commandId=randomUUID(),executionId=randomUUID();
    await commands.mutate({...engine(),actorSessionId},{conversationId:"chat",operationId:randomUUID(),expectedRevision:0,action:{kind:"enqueue",commandId,
      payload:{agentId:"cursor",model:"grok-4.6",effort:"xhigh",fast:true,userMessageId:randomUUID(),prompt:[{type:"text",text:"Synthetic task"}],modeRevision:0,agentCredentialGrantId:delegationId}}});
    const claim=await commands.claim(engine(),"chat",executionId);
    expect(claim?.payload).toMatchObject({model:"grok-4.6",effort:"xhigh",fast:true,agentCredentialGrantId:delegationId});
    const request={executionId,delegationId,provider:"cursor" as const,model:"grok-4.6",source:{kind:"command" as const,commandId,claimId:claim!.claimId}};
    await expect(service.admit(engine(),{...request,source:{...request.source,claimId:randomUUID()}})).rejects.toMatchObject({status:403});
    const lease=await service.admit(engine(),request);
    await commands.settle(engine(),{commandId,claimId:claim!.claimId,state:"succeeded",resultCode:null});
    await expect(service.validate(engine(),lease.leaseId)).rejects.toMatchObject({status:403});
  });
  it("erases reciprocal credential delegations concurrently without a cascade deadlock",async()=>{
    const other=await seedReadyCloudWorkspace(pool),otherCredential=randomUUID(),otherSession=randomUUID();
    await credentials.put({ownerUserId:other.userId,credentialId:otherCredential,operationId:randomUUID(),expectedRevision:0,displayName:"Other",
      material:{kind:"cursor-api-key",apiKey:"synthetic-second-owner-credential"}});
    const device=(await pool.query<{id:string}>(`INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint)
      VALUES($1,'Other device','macos',$2,$3) RETURNING id`,[other.userId,randomBytes(32),randomBytes(32)])).rows[0]!.id;
    await pool.query(`INSERT INTO cloud_workspace_actor_sessions(id,workspace_id,org_id,generation,engine_instance_id,actor_user_id,
      device_id,device_key_version,authority_epoch,actor_fingerprint,actor_role,token_hash,admission_expires_at,session_expires_at,revoked_at)
      VALUES($1,$2,$3,1,$4,$5,$6,1,1,$7,'owner',$8,now()+interval '1 minute',now()+interval '1 hour',now())`,
    [otherSession,other.workspaceId,other.organizationId,other.engineInstanceId,other.userId,device,"a".repeat(64),randomBytes(32)]);
    for(const [source,targetCredential,targetOwner,session] of [[fixture,otherCredential,other.userId,actorSessionId],[other,credentialId,owner.id,otherSession]] as const){
      const grant=randomUUID();
      await pool.query(`INSERT INTO cloud_agent_credential_delegations(id,credential_id,owner_user_id,credential_revision,workspace_id,org_id,
        grantee_user_id,owner_fingerprint,grantee_fingerprint,compute_fingerprint,compute_trust,models,expires_at)
        VALUES($1,$2,$3,1,$4,$5,$6,$7,$7,$7,'zeros-managed',ARRAY['grok-4.6'],now()+interval '1 hour')`,
      [grant,targetCredential,targetOwner,source.workspaceId,source.organizationId,source.userId,"a".repeat(64)]);
      await pool.query(`INSERT INTO cloud_agent_execution_leases(id,delegation_id,credential_id,credential_revision,workspace_id,org_id,generation,
        engine_instance_id,actor_source_session_id,execution_id,model,expires_at,provider) VALUES($1,$2,$3,1,$4,$5,1,$6,$7,$8,'grok-4.6',now()+interval '45 seconds','cursor')`,
      [randomUUID(),grant,targetCredential,source.workspaceId,source.organizationId,source.engineInstanceId,session,randomUUID()]);
    }
    // The barrier preserves locks taken by the actor-session FK cascades. In
    // the broken order each purge owns the other's lease before deleting its
    // credential. Correct parent ordering makes the second purge wait first.
    const barrier=await pool.connect(),pids:number[]=[];
    await barrier.query("SELECT pg_advisory_lock(87123321)");
    await pool.query(`CREATE FUNCTION test_pause_actor_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(87123321); RETURN OLD; END $$;
      CREATE TRIGGER zz_test_pause_actor_erasure AFTER DELETE ON cloud_workspace_actor_sessions
      FOR EACH ROW EXECUTE FUNCTION test_pause_actor_erasure()`);
    const purges=[owner.id,other.userId].map(userId=>withSystemTx(pool,async tx=>{
      pids.push((await tx.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
      await eraseCloudWorkspaceCollaborationIdentity(tx,userId);
    }));
    const settled=Promise.allSettled(purges);
    try{
      let waiting=false;
      for(let attempt=0;attempt<100;attempt++){
        const row=(await pool.query<{n:number}>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'",[pids])).rows[0]!;
        if(pids.length===2&&row.n===2){waiting=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
    }finally{await barrier.query("SELECT pg_advisory_unlock(87123321)");barrier.release();}
    const outcomes=await settled;
    expect(outcomes.map(result=>result.status==="fulfilled"?"ok":(result.reason as {code?:string}).code)).toEqual(["ok","ok"]);
    for(const table of ["cloud_agent_credentials","cloud_agent_credential_versions","cloud_agent_credential_delegations","cloud_agent_execution_leases","cloud_workspace_actor_sessions"])
      expect((await pool.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
  });
});
