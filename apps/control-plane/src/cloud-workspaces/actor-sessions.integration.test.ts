import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { ensureCloudPilotUser,seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudWorkspaceCollaborationService } from "./actors.js";
import { assertCloudActorSession,assertRecordedCloudActor,DatabaseCloudWorkspaceActorSessionService } from "./actor-sessions.js";
import { cloudWorkspaceDeviceProofMessage } from "./replicas.js";
import { DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { DatabaseCloudWorkspaceActionService } from "./action-receipts.js";
import {DatabaseCloudAgentCredentialService} from "./agent-credentials.js";
import {DatabaseCloudAgentExecutionService} from "./agent-executions.js";

const d=process.env.TEST_DATABASE_URL?describe:describe.skip;
d("actor-aware cloud runtime admission",()=>{
  let pool:pg.Pool;
  let fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  let guest:Awaited<ReturnType<typeof ensureCloudPilotUser>>;
  let collaboration:DatabaseCloudWorkspaceCollaborationService;
  let service:DatabaseCloudWorkspaceActorSessionService;
  const engine=()=>({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,generation:1,engineInstanceId:fixture.engineInstanceId,heartbeatToken:fixture.heartbeatToken});
  const subject=()=>({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,actorUserId:guest.id,authenticatedUser:guest});
  const owner=()=>({...subject(),actorUserId:fixture.userId});
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5});});
  afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");await runMigrations(pool);
    fixture=await seedReadyCloudWorkspace(pool);
    guest=await ensureCloudPilotUser(pool,{provider:"workos",providerSubject:`user_${randomUUID()}`,email:`guest-${randomUUID()}@example.test`,displayName:"Guest",
      session:{id:`session_${randomUUID()}`,clientKind:"desktop",authTime:Math.floor(Date.now()/1000),tokenExpiresAt:Math.floor(Date.now()/1000)+3600}});
    guest.accountRevision=Number((await pool.query("SELECT auth_revision FROM users WHERE id=$1",[guest.id])).rows[0].auth_revision);
    await pool.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES ($1,$2,$3,'desktop',now()+interval '1 hour')",
      [guest.authentication.sessionId,guest.identity.subject,guest.id]);
    await pool.query("INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES ($1,'pro','active',true,'operator')",[guest.id]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=2 WHERE id=$1",[fixture.engineInstanceId]);
    collaboration=new DatabaseCloudWorkspaceCollaborationService(pool);
    await collaboration.setSharing({...owner(),sharingMode:"organization",expectedRevision:1});
    const invite=await collaboration.invite({...owner(),email:guest.email,role:"developer"});
    await collaboration.accept({actorUserId:guest.id,identity:guest.identity,token:invite.token});
    service=new DatabaseCloudWorkspaceActorSessionService({pool,enginePort:39393,bridgeUrl:"wss://api.example.test/v1/cloud-workspaces/bridge",workosEnabled:false});
  });
  async function device() {
    const pair=generateKeyPairSync("ed25519");const publicKey=Buffer.from(pair.publicKey.export({format:"jwk"}).x!,"base64url");
    const row=(await pool.query<{id:string}>("INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES ($1,'Actor device','macos',$2,$3) RETURNING id",[guest.id,publicKey,createHash("sha256").update(publicKey).digest()])).rows[0]!;
    return {id:row.id,proof:()=>{const fields={deviceId:row.id,keyVersion:1,timestampMs:Date.now(),nonce:randomBytes(24).toString("base64url")};
      return {...fields,signature:sign(null,cloudWorkspaceDeviceProofMessage({...fields,accountUserId:guest.id,action:"engine.connect",payload:{organizationId:fixture.organizationId,workspaceId:fixture.workspaceId}}),pair.privateKey).toString("base64url")};}};
  }
  async function actorConnection() {
    const signer=await device();const grant=await service.issue({...subject(),proof:signer.proof()});
    const admitted=await service.consume({...engine(),token:grant.grantToken});
    return {...engine(),actorSessionId:admitted.actorSessionId,deviceId:signer.id};
  }
  const queued = (expectedRevision=0) => ({conversationId:"shared-chat",operationId:randomUUID(),expectedRevision,
    action:{kind:"enqueue" as const,commandId:randomUUID(),payload:{agentId:"claude",userMessageId:randomUUID(),
      prompt:[{type:"text",text:"A shared command"}],modeRevision:0}}});
  const decision = () => ({kind:"begin",admissible:true,action:{operationId:randomUUID(),conversationId:"shared-chat",
    executionId:"shared-execution",kind:"permission",requestId:randomUUID(),payload:{response:{outcome:"cancelled"}}}});

  it("revokes only the caller's exact actor grant without revoking a sibling device",async()=>{
    const signer=await device(),first=await service.issue({...subject(),proof:signer.proof()}),second=await service.issue({...subject(),proof:signer.proof()});
    await service.consume({...engine(),token:first.grantToken});
    await service.revoke({...owner(),token:first.grantToken});
    expect(await service.authorizeRelay(first.grantToken,{connected:true})).not.toBeNull();
    await service.revoke({...subject(),token:first.grantToken});
    await service.revoke({...subject(),token:first.grantToken});
    expect(await service.authorizeRelay(first.grantToken,{connected:true})).toBeNull();
    expect(await service.authorizeRelay(second.grantToken)).not.toBeNull();
  });
  it.each([false,true])("rejects a revoked issuing WorkOS session, before and after admission (connected=%s)",async connected=>{
    const signer=await device(),grant=await service.issue({...subject(),proof:signer.proof()});
    const admitted=connected?await service.consume({...engine(),token:grant.grantToken}):null;
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1",[guest.authentication.sessionId]);
    await expect(service.consume({...engine(),token:grant.grantToken,renew:connected})).rejects.toMatchObject({status:401});
    expect(await service.authorizeRelay(grant.grantToken,{connected})).toBeNull();
    if(admitted)await expect(withSystemTx(pool,tx=>assertCloudActorSession(tx,engine(),admitted.actorSessionId,"read"))).rejects.toMatchObject({status:401});
  });

  it("does not transfer a connection to a replacement identity of the same account",async()=>{
    const signer=await device(),grant=await service.issue({...subject(),proof:signer.proof()});
    await service.consume({...engine(),token:grant.grantToken});
    await pool.query("UPDATE user_identities SET status='superseded' WHERE provider_sub=$1",[guest.identity.subject]);
    await pool.query("INSERT INTO user_identities(user_id,provider,provider_sub,email_at_link,email_verified_at) VALUES ($1,'workos',$2,$3,now())",
      [guest.id,`replacement_${randomUUID()}`,guest.email]);
    await expect(service.consume({...engine(),token:grant.grantToken,renew:true})).rejects.toMatchObject({status:401});
  });

  it("cancels queued intent after explicit source-session revocation while ordinary disconnect remains independent",async()=>{
    const commands=new DatabaseCloudWorkspaceCommandService({pool}),actor=await actorConnection();
    await commands.mutate(actor,queued());
    await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1",[guest.authentication.sessionId]);
    await expect(commands.claim(engine(),"shared-chat","revoked-execution")).resolves.toMatchObject({dispatchAllowed:false});
  });

  it("requires a live actor for shared commands and decisions, including read-only guests",async()=>{
    const commands=new DatabaseCloudWorkspaceCommandService({pool}),actions=new DatabaseCloudWorkspaceActionService({pool});
    await expect(commands.mutate(engine(),queued())).rejects.toMatchObject({status:401});
    await expect(actions.request(engine(),decision())).rejects.toMatchObject({status:401});
    await pool.query("UPDATE cloud_workspace_guest_grants SET role='viewer',revision=revision+1 WHERE user_id=$1",[guest.id]);
    const viewer=await actorConnection();
    await expect(commands.snapshot(viewer,"shared-chat")).resolves.toMatchObject({pending:[]});
    await expect(commands.mutate(viewer,queued())).rejects.toMatchObject({status:403});
    await expect(commands.stop(viewer,"shared-chat",randomUUID())).rejects.toMatchObject({status:403});
    await expect(actions.request(viewer,decision())).rejects.toMatchObject({status:403});
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_commands")).rows[0].n).toBe(0);
  });
  it("retains queued actor attribution after disconnect and denies dispatch after revocation",async()=>{
    const commands=new DatabaseCloudWorkspaceCommandService({pool}),actor=await actorConnection();
    const first=queued();await commands.mutate(actor,first);
    await pool.query("UPDATE cloud_workspace_actor_sessions SET last_renewed_at=now()-interval '1 minute' WHERE id=$1",[actor.actorSessionId]);
    const claim=await commands.claim(engine(),"shared-chat","shared-execution");
    expect(claim).toMatchObject({dispatchAllowed:true,actor:{userId:guest.id,deviceId:actor.deviceId,role:"developer"}});
    expect((await pool.query("SELECT actor_user_id,actor_device_id FROM cloud_workspace_commands WHERE id=$1",[first.action.commandId])).rows[0])
      .toEqual({actor_user_id:guest.id,actor_device_id:actor.deviceId});
    await commands.settle(engine(),{commandId:claim!.commandId,claimId:claim!.claimId,state:"succeeded",resultCode:null});
    const next=await actorConnection();await commands.mutate(next,queued(3));
    await collaboration.revokeGuest({...owner(),guestUserId:guest.id});
    const refused=await commands.claim(engine(),"shared-chat","shared-execution");
    expect(refused).toMatchObject({dispatchAllowed:false});
    expect(refused).not.toHaveProperty("actor");
    await commands.settle(engine(),{commandId:refused!.commandId,claimId:refused!.claimId,state:"cancelled",resultCode:"actor_authority_revoked"});
  });
  it("binds mutation and decision retries to the original actor device",async()=>{
    const commands=new DatabaseCloudWorkspaceCommandService({pool}),actions=new DatabaseCloudWorkspaceActionService({pool});
    const a=await actorConnection(),b=await actorConnection(),input=queued(),action=decision();
    const encryption={keys:{1:randomBytes(32).toString("base64url")},currentKeyVersion:1};
    const credentials=new DatabaseCloudAgentCredentialService(pool,encryption),executions=new DatabaseCloudAgentExecutionService(pool,encryption,false);
    const credentialId=randomUUID(),delegationId=randomUUID();
    await pool.query("UPDATE cloud_workspace_engine_instances SET agent_runtime_profile='zeros-cloud-worker-v3',agent_runtime_contract_sha256=$2 WHERE id=$1",[fixture.engineInstanceId,"a".repeat(64)]);
    await pool.query(`INSERT INTO cloud_agent_runtime_qualifications(provider,image_ref,runtime_contract_sha256,credential_kind,profile,enabled)
      VALUES('daytona','snapshot-pinned',$1,'claude-api-key','zeros-cloud-worker-v3',true)`,["a".repeat(64)]);
    await credentials.put({ownerUserId:guest.id,credentialId,operationId:randomUUID(),expectedRevision:0,displayName:"Guest-owned credential",material:{kind:"claude-api-key",apiKey:"synthetic-guest-claude-key"}});
    await credentials.delegate(guest.id,{id:delegationId,credentialId,expectedRevision:1,workspaceId:fixture.workspaceId,granteeUserId:guest.id,models:["haiku"],expiresAt:new Date(Date.now()+3600_000).toISOString()});
    await executions.admit(engine(),{executionId:action.action.executionId,delegationId,provider:"claude",model:"haiku",source:{kind:"session",actorSessionId:a.actorSessionId}});
    await commands.mutate(a,input);await actions.request(a,action);
    await expect(commands.mutate(a,input)).resolves.toMatchObject({replayed:true});
    await expect(actions.request(a,action)).resolves.toMatchObject({replayed:true});
    await expect(commands.mutate(b,input)).rejects.toMatchObject({code:"command_conflict"});
    await expect(actions.request(b,action)).rejects.toMatchObject({code:"command_conflict"});
    await expect(actions.request(b,{kind:"read",operationId:action.action.operationId})).resolves.toMatchObject({replayed:true});
    expect((await pool.query("SELECT actor_user_id,actor_device_id FROM cloud_workspace_action_receipts WHERE operation_id=$1",[action.action.operationId])).rows[0])
      .toEqual({actor_user_id:guest.id,actor_device_id:a.deviceId});
  });
  it("rebinds edited queued content to the editor's device and never falls back after device erasure",async()=>{
    const commands=new DatabaseCloudWorkspaceCommandService({pool}),a=await actorConnection(),b=await actorConnection(),input=queued();
    await commands.mutate(a,input);
    await commands.mutate(b,{...input,operationId:randomUUID(),expectedRevision:1,action:{...input.action,kind:"edit"}});
    const row=(await pool.query("SELECT actor_device_id,actor_fingerprint FROM cloud_workspace_commands WHERE id=$1",[input.action.commandId])).rows[0];
    expect(row.actor_device_id).toBe(b.deviceId);expect(row.actor_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await pool.query("DELETE FROM devices WHERE id=$1",[b.deviceId]);
    await expect(commands.claim(engine(),"shared-chat","shared-execution")).resolves.toMatchObject({dispatchAllowed:false});
  });
  it("attributes two simultaneous devices to the guest while retaining the engine sponsor",async()=>{
    const a=await device(),b=await device();
    const [ga,gb]=await Promise.all([service.issue({...subject(),proof:a.proof()}),service.issue({...subject(),proof:b.proof()})]);
    const [ca,cb]=await Promise.all([service.consume({...engine(),token:ga.grantToken}),service.consume({...engine(),token:gb.grantToken})]);
    expect(ca).toMatchObject({version:2,accountUserId:guest.id,deviceId:a.id,role:"developer"});
    expect(cb.actorSessionId).not.toBe(ca.actorSessionId);
    expect((await pool.query("SELECT account_user_id FROM cloud_workspace_engine_instances WHERE id=$1",[fixture.engineInstanceId])).rows[0].account_user_id).toBe(fixture.userId);
    await expect(service.consume({...engine(),token:ga.grantToken})).rejects.toMatchObject({status:401});
    await pool.query("UPDATE devices SET revoked_at=now(),trust_state='revoked' WHERE id=$1",[a.id]);
    await expect(service.consume({...engine(),token:ga.grantToken,renew:true})).rejects.toMatchObject({status:401});
    await expect(service.consume({...engine(),token:gb.grantToken,renew:true})).resolves.toMatchObject({accountUserId:guest.id});
  });
  it("rejects forged devices and legacy workers before issuing actor admission",async()=>{
    const signer=await device();const proof=signer.proof();proof.signature=Buffer.alloc(64).toString("base64url");
    await expect(service.issue({...subject(),proof})).rejects.toBeDefined();
    await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=1 WHERE id=$1",[fixture.engineInstanceId]);
    await expect(service.issue({...subject(),proof:signer.proof()})).rejects.toMatchObject({code:"cloud_actor_runtime_unavailable"});
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_actor_sessions")).rows[0].n).toBe(0);
  });
  it("keeps durable actor intent valid after socket expiry, but denies it after guest revocation",async()=>{
    const signer=await device();const grant=await service.issue({...subject(),proof:signer.proof()});
    const admitted=await service.consume({...engine(),token:grant.grantToken});
    const actor=await withSystemTx(pool,tx=>assertCloudActorSession(tx,engine(),admitted.actorSessionId,"run"));
    await pool.query("UPDATE cloud_workspace_actor_sessions SET last_renewed_at=now()-interval '1 minute' WHERE id=$1",[admitted.actorSessionId]);
    await expect(service.consume({...engine(),token:grant.grantToken,renew:true})).rejects.toMatchObject({status:401});
    await expect(withSystemTx(pool,tx=>assertRecordedCloudActor(tx,{...subject(),actor,capability:"run"}))).resolves.toMatchObject({role:"developer"});
    await collaboration.revokeGuest({...owner(),guestUserId:guest.id});
    await expect(withSystemTx(pool,tx=>assertRecordedCloudActor(tx,{...subject(),actor,capability:"run"}))).rejects.toMatchObject({status:404});
    expect(await service.authorizeRelay(grant.grantToken,{connected:true})).toBeNull();
  });
});
