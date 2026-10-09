import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from "node:crypto";
import pg from "pg";
import {withSystemTx} from "../db.js";
import {readCloudAgentComputeTrust} from "./agent-compute-trust.js";
import {ensureUser} from "../auth.js";
import {DatabaseCloudWorkspaceActorSessionService} from "./actor-sessions.js";
import {cloudWorkspaceDeviceProofMessage} from "./replicas.js";
import {DatabaseCloudWorkspaceCollaborationService} from "./actors.js";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {resetMigratedTestDatabase} from "../test-database.js";
import {seedReadyCloudWorkspace,withCloudFixtureOwnerTx,ensureCloudPilotUser} from "./test-fixtures.js";
import {DatabaseCloudAgentCredentialService} from "./agent-credentials.js";
import {DatabaseCloudAgentExecutionService} from "./agent-executions.js";
import {CloudAgentBootCredentialResponseSchema,CloudAgentActorConfirmResponseSchema,CloudAgentWarmActorResponseSchema,type CloudAgentBootCredentialResponse} from "./agent-boot-contract.js";
import {interceptQueries,withAuthorityDeadlineBarrier} from "./authority-deadline-test-utils.js";
import {assertNativeGithubActor} from "./github-native-grants.js";
import {cloudGithubNativeSourceSchema} from "./github-native-schema.js";
const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("genuine private boot credential execution",()=>{
  let pool:pg.Pool,fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>,credentials:DatabaseCloudAgentCredentialService,service:DatabaseCloudAgentExecutionService;
  let credentialId:string;
  const key=randomBytes(32).toString("base64url"),secret="synthetic-boot-cursor-api-key",keys={currentKeyVersion:1,keys:{1:key}};
  const engine=()=>({organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId,heartbeatToken:fixture.heartbeatToken});
  const request=()=>({version:1,mode:"boot-owner-v1",organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId});
  const boot=async()=>CloudAgentBootCredentialResponseSchema.parse(await service.boot(engine(),"bootstrap",request()));
  const syncRequest=(bound:CloudAgentBootCredentialResponse)=>({...request(),bootId:bound.bootId,writerEpoch:bound.writerEpoch,expectedCacheRevision:bound.cacheRevision});
  const actor=async(userId=fixture.userId,providerSubject=`workos|${userId}`)=>{
    const user=await ensureUser(pool,{provider:"workos",providerSubject,email:`boot-${userId}@example.test`,displayName:"Actor",
      session:{id:`session_${randomUUID()}`,clientKind:"desktop",authTime:Math.floor(Date.now()/1000),tokenExpiresAt:Math.floor(Date.now()/1000)+3600}});
    await pool.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '1 hour')",[user.authentication.sessionId,user.identity.subject,user.id]);
    const pair=generateKeyPairSync("ed25519"),publicKey=Buffer.from(pair.publicKey.export({format:"jwk"}).x!,"base64url");
    const device=(await pool.query("INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Boot actor','macos',$2,$3) RETURNING id",[user.id,publicKey,createHash("sha256").update(publicKey).digest()])).rows[0]!;
    const fields={deviceId:device.id,keyVersion:1,timestampMs:Date.now(),nonce:randomBytes(24).toString("base64url")};
    const proof={...fields,signature:sign(null,cloudWorkspaceDeviceProofMessage({...fields,accountUserId:user.id,action:"engine.connect",payload:{organizationId:fixture.organizationId,workspaceId:fixture.workspaceId}}),pair.privateKey).toString("base64url")};
    const sessions=new DatabaseCloudWorkspaceActorSessionService({pool,enginePort:39393,bridgeUrl:"wss://api.example.test/bridge",workosEnabled:false});
    const grant=await sessions.issue({...engine(),actorUserId:user.id,authenticatedUser:user,proof});
    return {user,deviceId:device.id,actorSessionId:(await sessions.consume({...engine(),token:grant.grantToken})).actorSessionId};
  };
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8});});afterAll(async()=>{await pool.end();});
  beforeEach(async()=>{
    await resetMigratedTestDatabase(pool);fixture=await seedReadyCloudWorkspace(pool);
    await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1",[fixture.engineInstanceId]);
    await withCloudFixtureOwnerTx(pool,async tx=>{
      // Only the disposable database owner installs positive fixture evidence.
      await tx.query("SET LOCAL session_replication_role=replica");
      await tx.query("UPDATE cloud_runtime_qualifications SET native_capabilities=$1::jsonb WHERE credential_kind='cursor-api-key'",[JSON.stringify({version:1,goals:false,nativeFork:false,transcriptFork:false,nativeReview:false,connectedApps:false,multiAgent:false})]);
    });
    credentials=new DatabaseCloudAgentCredentialService(pool,keys);service=new DatabaseCloudAgentExecutionService(pool,keys,false);
    credentialId=randomUUID();await credentials.put({credentialId,ownerUserId:fixture.userId,organizationId:fixture.organizationId,operationId:randomUUID(),
      expectedRevision:0,displayName:"Boot Cursor",material:{kind:"cursor-api-key",apiKey:secret}});
    await credentials.setOrganizationConnection(fixture.userId,fixture.organizationId,"cursor",{expectedRevision:0,credentialId,credentialRevision:1,
      models:["grok-4.6"],consent:"zeros-managed"});
  });
  it("reserves a real writer/funding owner and delivers only the sending boot's current positive slots",async()=>{
    const bound=await boot(),ready=bound.providers.find(slot=>slot.provider==="cursor")!;
    expect(bound.fundingOwnerUserId).toBe(fixture.userId);expect(ready).toMatchObject({status:"ready",credentialId,material:{kind:"cursor-api-key",apiKey:secret}});
    expect(bound.initialAdoptions.find(slot=>slot.provider==="cursor")).toMatchObject({status:"known"});
    expect((await pool.query("SELECT agent_command_mode,agent_boot_id FROM cloud_workspaces WHERE id=$1",[fixture.workspaceId])).rows[0]).toEqual({agent_command_mode:"legacy",agent_boot_id:null});
    const stored=(await pool.query("SELECT * FROM cloud_agent_boot_credentials")).rows;
    expect(stored).toHaveLength(3);expect(JSON.stringify(stored)).not.toContain(secret);
    expect((await pool.query("SELECT * FROM cloud_agent_execution_leases")).rowCount).toBe(0);
  });
  it("reconciles concurrent bootstrap retries against the same writer and current-only vault",async()=>{
    const [first,second]=await Promise.all([boot(),boot()]);expect(second).toEqual(first);
    expect((await pool.query("SELECT * FROM cloud_agent_boot_bindings")).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM cloud_workspace_local_command_writers")).rowCount).toBe(1);
  });
  it("activates only the exact ready binding, and an unknown activation ACK retries without a new epoch",async()=>{
    const bound=await boot(),input=syncRequest(bound);
    const first=await service.boot(engine(),"activate",input);expect(first).toMatchObject({bootId:bound.bootId,writerEpoch:bound.writerEpoch,cacheRevision:1,activated:true});
    expect(await service.boot(engine(),"activate",input)).toEqual(first);
    expect((await pool.query("SELECT agent_command_mode,agent_boot_id FROM cloud_workspaces WHERE id=$1",[fixture.workspaceId])).rows[0]).toMatchObject({agent_command_mode:"boot-owner-v1"});
  });
  it.each([100,300])("keeps genuine bootstrap/sync/activation live across sequential %sms request latency",async delayMs=>{
    const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,delayMs));
    const delayed=async<T>(operation:()=>Promise<T>):Promise<T>=>{await pause();const result=await operation();await pause();return result;};
    // Model ingress/response latency at HTTP boundaries, not per SQL query.
    // Every request still reaches the genuine authenticated PostgreSQL service.
    const bound=await delayed(boot),input=syncRequest(bound);
    const synchronized=CloudAgentBootCredentialResponseSchema.parse(await delayed(()=>service.boot(engine(),"sync",input)));
    expect(synchronized).toEqual(bound);
    const sender=await delayed(actor);
    const actorRequest={...request(),bootId:bound.bootId,writerEpoch:bound.writerEpoch,actorSessionId:sender.actorSessionId};
    const proof=CloudAgentActorConfirmResponseSchema.parse(await delayed(()=>service.boot(engine(),"actor-confirm",actorRequest)));
    expect(proof.provenance.confirmedUntilMs).toBeGreaterThan(Date.now());
    const activated=await delayed(()=>service.boot(engine(),"activate",input));
    expect(activated).toMatchObject({bootId:bound.bootId,writerEpoch:bound.writerEpoch,cacheRevision:1,activated:true});
    expect(await delayed(()=>service.boot(engine(),"activate",input))).toEqual(activated);
    expect((await pool.query("SELECT agent_command_mode FROM cloud_workspaces WHERE id=$1",[fixture.workspaceId])).rows[0])
      .toEqual({agent_command_mode:"boot-owner-v1"});
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_agent_execution_leases")).rows[0]).toEqual({count:0});
  });
  it("never activates a stale ready cache after a newer epoch was published",async()=>{
    const bound=await boot();
    await pool.query("UPDATE cloud_agent_boot_bindings SET desired_cache_revision=2 WHERE engine_instance_id=$1",[fixture.engineInstanceId]);
    await expect(service.boot(engine(),"activate",syncRequest(bound))).rejects.toMatchObject({status:503,code:"cloud_agent_credential_busy"});
    expect((await pool.query("SELECT agent_command_mode,agent_boot_id FROM cloud_workspaces WHERE id=$1",[fixture.workspaceId])).rows[0]).toEqual({agent_command_mode:"legacy",agent_boot_id:null});
  });
  it("does not replay positive material after source revocation or a foreign boot/writer",async()=>{
    const bound=await boot();await pool.query("UPDATE cloud_agent_credentials SET revoked_at=now() WHERE id=$1",[credentialId]);
    const replay=await boot();expect(replay.providers.find(slot=>slot.provider==="cursor")).toMatchObject({status:"unavailable",code:"cloud_agent_credential_revoked"});
    expect(replay.initialAdoptions).toEqual(bound.initialAdoptions);
    await expect(service.boot(engine(),"sync",{...syncRequest(bound),writerEpoch:randomUUID()})).rejects.toMatchObject({status:403});
    expect((await pool.query("SELECT ciphertext FROM cloud_agent_boot_credentials WHERE provider='cursor'")).rows[0]!.ciphertext).toBeNull();
  });
  it("keeps an acknowledged key publication fenced until a full current snapshot is installed",async()=>{
    const bound=await boot(),replacement={credentialId,ownerUserId:fixture.userId,operationId:randomUUID(),expectedRevision:1,
      displayName:"New Cursor",material:{kind:"cursor-api-key",apiKey:"synthetic-boot-replacement-key"}};
    await expect(credentials.put(replacement)).rejects.toMatchObject({status:503});
    const exchange=async(acknowledgements:unknown[]=[])=>service.credentialControls(engine(),{...request(),bootId:bound.bootId,writerEpoch:bound.writerEpoch,acknowledgements});
    const pause=(await exchange()).controls[0]!;
    await exchange([{...pause,operation:undefined,selectors:undefined,controlRevision:1,phase:"fenced",mutationFenced:true,startsFenced:true,
      readyCacheRevision:1,proofId:null,activity:{complete:true,foreground:0,reservedLaunches:0,background:0,idleHosts:0,scopes:[]}}].map(({operation,selectors,...ack})=>ack));
    await credentials.put(replacement);
    const synced=CloudAgentBootCredentialResponseSchema.parse(await service.boot(engine(),"sync",syncRequest(bound)));
    expect(synced.cacheRevision).toBe(2);expect(synced.providers.find(value=>value.provider==="cursor")).toMatchObject({status:"ready",credentialRevision:2,connectionRevision:2,material:{apiKey:replacement.material.apiKey}});
  });
  it("confirms a real recorded actor after transport expiry but refuses device revocation",async()=>{
    const bound=await boot(),sender=await actor();
    await pool.query("UPDATE cloud_workspace_actor_sessions SET last_renewed_at=now()-interval '1 hour' WHERE id=$1",[sender.actorSessionId]);
    const input={...request(),bootId:bound.bootId,writerEpoch:bound.writerEpoch,actorSessionId:sender.actorSessionId};
    const result=await service.boot(engine(),"actor-confirm",input);
    expect(result).toMatchObject({provenance:{actorSessionId:sender.actorSessionId,actor:{userId:fixture.userId,deviceKeyVersion:1},fundingGrant:{kind:"owner"},fundingConsentVersion:1}});
    await pool.query("UPDATE devices SET revoked_at=now(),trust_state='revoked' WHERE id=$1",[sender.deviceId]);
    await expect(service.boot(engine(),"actor-confirm",input)).rejects.toThrow();
  });
  it("warms the sender's bounded native context with real context storage and no lease",async()=>{
    const bound=await boot(),sender=await actor(),input={...request(),bootId:bound.bootId,writerEpoch:bound.writerEpoch,actorSessionId:sender.actorSessionId,
      provider:"cursor",model:"grok-4.6",conversationId:randomUUID(),cwd:"/srv/zeros/workspace",repositoryServers:[]};
    const first=await service.boot(engine(),"warm-context",input),second=await service.boot(engine(),"warm-context",input);
    expect(first).toMatchObject({contextId:expect.any(String),actor:{actorSessionId:sender.actorSessionId},environment:{version:1},customization:{version:1}});
    expect(second).toMatchObject({contextId:(first as {contextId:string}).contextId});
    expect((await pool.query("SELECT * FROM cloud_agent_boot_contexts")).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM cloud_agent_execution_leases")).rowCount).toBe(0);
    await expect(service.boot(engine(),"warm-context",{...input,model:"hostile-other-model"})).rejects.toThrow();
  });
  it("never revives a previous context that expires during customization capture",async()=>{
    const bound=await boot(),sender=await actor(),input={...request(),bootId:bound.bootId,writerEpoch:bound.writerEpoch,actorSessionId:sender.actorSessionId,
      provider:"cursor",model:"grok-4.6",conversationId:randomUUID(),cwd:"/srv/zeros/workspace",repositoryServers:[]};
    const first=await service.boot(engine(),"warm-context",input) as {contextId:string};
    let expired=false;
    const controlled=withAuthorityDeadlineBarrier(pool,/SELECT pg_advisory_xact_lock\(hashtextextended\(\$1,71511\)\)/,async client=>{
      expired=true;return client.query("UPDATE cloud_agent_boot_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE context_id=$1",[first.contextId]);
    });
    const second=await new DatabaseCloudAgentExecutionService(controlled,keys,false).boot(engine(),"warm-context",input) as {contextId:string};
    expect(expired).toBe(true);expect(second.contextId).not.toBe(first.contextId);
    expect((await pool.query("SELECT retired_at IS NOT NULL AS retired FROM cloud_agent_boot_contexts WHERE context_id=$1",[first.contextId])).rows[0]).toEqual({retired:true});
  });
  it("does not deliver a context after actor authority expires while reading Git attribution",async()=>{
    const bound=await boot(),sender=await actor(),input={...request(),bootId:bound.bootId,writerEpoch:bound.writerEpoch,actorSessionId:sender.actorSessionId,
      provider:"cursor",model:"grok-4.6",conversationId:randomUUID(),cwd:"/srv/zeros/workspace",repositoryServers:[]};
    let expired=false;
    const controlled=withAuthorityDeadlineBarrier(pool,/SELECT github_user_id,github_login,git_author_name FROM github_authorizations/,async client=>{
      expired=true;return client.query("UPDATE auth_sessions SET last_token_expires_at=clock_timestamp()-interval '1 second' WHERE provider_session_id=$1",[sender.user.authentication.sessionId]);
    });
    await expect(new DatabaseCloudAgentExecutionService(controlled,keys,false).boot(engine(),"warm-context",input)).rejects.toMatchObject({status:401,code:"cloud_actor_admission_rejected"});
    expect(expired).toBe(true);expect((await pool.query("SELECT count(*)::int AS count FROM cloud_agent_boot_contexts")).rows[0]).toEqual({count:0});
  });
  it("bounds stored context identities without evicting a previously admitted live context",async()=>{
    const bound=await boot(),sender=await actor(),input={...request(),bootId:bound.bootId,writerEpoch:bound.writerEpoch,actorSessionId:sender.actorSessionId,
      provider:"cursor",model:"grok-4.6",conversationId:randomUUID(),cwd:"/srv/zeros/workspace",repositoryServers:[]};
    const first=await service.boot(engine(),"warm-context",input) as {contextId:string};
    // Capacity fixtures represent stored records only; their copied envelope
    // is never reopened or used as authorization.
    await pool.query(`INSERT INTO cloud_agent_boot_contexts SELECT (jsonb_populate_record(NULL::cloud_agent_boot_contexts,
      to_jsonb(saved)||jsonb_build_object('context_id',gen_random_uuid(),'retired_at',clock_timestamp()))).*
      FROM cloud_agent_boot_contexts saved CROSS JOIN generate_series(1,4095) WHERE saved.context_id=$1`,[first.contextId]);
    await expect(service.boot(engine(),"warm-context",{...input,conversationId:randomUUID()})).rejects.toMatchObject({status:429,code:"cloud_validation_execution_limit"});
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_agent_boot_contexts")).rows[0]).toEqual({count:4096});
    expect(await service.boot(engine(),"warm-context",input)).toMatchObject({contextId:first.contextId});
  });
  it("does not export an offline plaintext verifier for repository secret values",async()=>{
    const bound=await boot(),sender=await actor(),repositoryServers=[{name:"sentinel",transport:"stdio",command:"node",env:{SENTINEL_SECRET:"short-private-value"}}];
    const context=CloudAgentWarmActorResponseSchema.parse(await service.boot(engine(),"warm-context",{...request(),bootId:bound.bootId,writerEpoch:bound.writerEpoch,
      actorSessionId:sender.actorSessionId,provider:"cursor",model:"grok-4.6",conversationId:randomUUID(),cwd:"/srv/zeros/workspace",repositoryServers}));
    const provider=bound.providers.find(value=>value.provider==="cursor");if(!provider||provider.status!=="ready")throw new Error("Missing ready fixture");
    const stored=(await pool.query("SELECT organization_revision,member_revision FROM cloud_agent_boot_contexts WHERE context_id=$1",[context.contextId])).rows[0]!;
    const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?
      Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([name,item])=>[name,canonical(item)])):value;
    const plaintextVerifier=createHash("sha256").update(JSON.stringify(canonical([context.actor.actor,context.actor.fundingGrant,
      Number(stored.organization_revision),Number(stored.member_revision),repositoryServers,context.environment.revision,
      provider.credentialId,provider.credentialRevision,provider.connectionRevision,provider.models,provider.nativeCapabilities]))).digest("hex");
    expect(context.contextRevision).not.toBe(plaintextVerifier);
  });
  const gitContext=async(member?:{id:string;subject:string})=>{
    const bound=await boot();await service.boot(engine(),"activate",syncRequest(bound));
    const sender=await actor(member?.id,member?.subject);
    const context=CloudAgentWarmActorResponseSchema.parse(await service.boot(engine(),"warm-context",{...request(),bootId:bound.bootId,writerEpoch:bound.writerEpoch,
      actorSessionId:sender.actorSessionId,provider:"cursor",model:"grok-4.6",conversationId:randomUUID(),cwd:"/srv/zeros/workspace",repositoryServers:[]}));
    return {sender,context,source:cloudGithubNativeSourceSchema.parse({kind:"boot-agent",contextId:context.contextId})};
  };
  it("authorizes real boot Git context without inventing a legacy lease",async()=>{
    const {sender,source}=await gitContext();
    expect(await withSystemTx(pool,tx=>assertNativeGithubActor(tx,engine(),source,false))).toMatchObject({actorUserId:sender.user.id});
    expect((await pool.query("SELECT count(*)::int AS count FROM cloud_agent_execution_leases")).rows[0]).toEqual({count:0});
  });
  it("refuses a Git context that expires during final sender confirmation",async()=>{
    const {context,source}=await gitContext();let confirmations=0;
    const controlled=interceptQueries(pool,async(sql,client)=>{
      if(/SELECT session\.\*,least\(clock_timestamp\(\)/.test(sql) && ++confirmations===2)
        await client.query("UPDATE cloud_agent_boot_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context.contextId]);
    });
    await expect(withSystemTx(controlled,tx=>assertNativeGithubActor(tx,engine(),source,false))).rejects.toMatchObject({status:403});
    expect(confirmations).toBe(2);
  });
  it("keeps Git attribution and write authority with the sending member rather than the funding owner",async()=>{
    const member=await ensureCloudPilotUser(pool,{provider:"workos",providerSubject:`member_${randomUUID()}`,email:`git-${randomUUID()}@example.test`,displayName:"Sending member"});
    await withCloudFixtureOwnerTx(pool,async tx=>{
      await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",[fixture.organizationId,member.id]);
      await tx.query("INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES($1,$2,'active')",[fixture.organizationId,member.id]);
      await tx.query("INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')",[member.id]);
    });
    await new DatabaseCloudWorkspaceCollaborationService(pool).setSharing({workspaceId:fixture.workspaceId,organizationId:fixture.organizationId,
      actorUserId:fixture.userId,sharingMode:"organization",expectedRevision:1});
    await pool.query("INSERT INTO github_authorizations(owner_user_id,app_variant,github_login,github_user_id,git_author_name) VALUES($1,'github.com','sending-member',73,'Sending Member')",[member.id]);
    const {context,sender,source}=await gitContext({id:member.id,subject:member.identity.subject});
    expect(context.gitAuthor).toEqual({name:"Sending Member",email:"73+sending-member@users.noreply.github.com"});
    expect(await withSystemTx(pool,tx=>assertNativeGithubActor(tx,engine(),source,false))).toMatchObject({actorUserId:sender.user.id});
    expect(sender.user.id).not.toBe(fixture.userId);
  });
  it.each(["context-expiry","context-retirement","device-revoke","customization-change","foreign-engine"] as const)("refuses boot Git after %s",async cause=>{
    const {sender,context,source}=await gitContext();
    if(cause==="context-expiry")await pool.query("UPDATE cloud_agent_boot_contexts SET expires_at=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context.contextId]);
    if(cause==="context-retirement")await pool.query("UPDATE cloud_agent_boot_contexts SET retired_at=clock_timestamp() WHERE context_id=$1",[context.contextId]);
    if(cause==="device-revoke")await pool.query("UPDATE devices SET trust_state='revoked',revoked_at=clock_timestamp() WHERE id=$1",[sender.deviceId]);
    if(cause==="customization-change")await pool.query("UPDATE cloud_agent_boot_contexts SET organization_revision=organization_revision+1 WHERE context_id=$1",[context.contextId]);
    await expect(withSystemTx(pool,tx=>assertNativeGithubActor(tx,{...engine(),...(cause==="foreign-engine"?{engineInstanceId:randomUUID()}:{})},source,false))).rejects.toMatchObject({status:403});
  });
  it("never uses an unrelated self-consent to deliver a selected key on administrator-controlled compute",async()=>{
    const connection=(await pool.query("SELECT provider_connection_id FROM cloud_workspace_generations WHERE workspace_id=$1",[fixture.workspaceId])).rows[0]!.provider_connection_id;
    await pool.query("UPDATE provider_connection_versions SET credential_source='delegated',endpoint='https://api.fixture.test',key_version=1,nonce=$2,ciphertext=$3,auth_tag=$4,credential_sha256=$5 WHERE connection_id=$1",[connection,randomBytes(12),randomBytes(32),randomBytes(16),randomBytes(32)]);
    await pool.query("UPDATE provider_connections SET credential_source='delegated' WHERE id=$1",[connection]);
    const other=randomUUID();await credentials.put({credentialId:other,ownerUserId:fixture.userId,operationId:randomUUID(),expectedRevision:0,
      displayName:"Consent A",material:{kind:"cursor-api-key",apiKey:"synthetic-unrelated-source-key"}});
    const computeConsent=await withSystemTx(pool,tx=>readCloudAgentComputeTrust(tx,fixture.workspaceId));
    await credentials.delegate(fixture.userId,{id:randomUUID(),credentialId:other,expectedRevision:1,workspaceId:fixture.workspaceId,
      granteeUserId:fixture.userId,models:["grok-4.6"],expiresAt:new Date(Date.now()+3600000).toISOString(),computeConsent});
    await expect(boot()).rejects.toThrow();
    expect((await pool.query("SELECT * FROM cloud_agent_boot_credentials")).rowCount).toBe(0);
  });
  it("refuses old engines without negotiated registration and never activates a caller-chosen engine",async()=>{
    await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=NULL WHERE id=$1",[fixture.engineInstanceId]);
    await expect(boot()).rejects.toMatchObject({status:409});
    await expect(service.boot({...engine(),heartbeatToken:`zwh_${"z".repeat(43)}`} ,"bootstrap",request())).rejects.toThrow();
    expect((await pool.query("SELECT * FROM cloud_agent_boot_bindings")).rowCount).toBe(0);
  });
  it("rejects caller funding selectors before any credential or writer is reserved",async()=>{
    await expect(service.boot(engine(),"bootstrap",{...request(),fundingOwnerUserId:randomUUID()})).rejects.toMatchObject({status:422});
    expect((await pool.query("SELECT * FROM cloud_agent_boot_bindings")).rowCount).toBe(0);
  });
});
