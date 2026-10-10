import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {withSystemTx} from "../db.js";
import {resetMigratedTestDatabase} from "../test-database.js";
import {DatabaseDevConnectionRestore} from "../dev-connections/restore.js";
import type {ConnectionReference} from "../dev-connections/types.js";
import {seedReadyCloudWorkspace} from "./test-fixtures.js";
import {reserveLocalCloudCommandWriter} from "./commands.js";
import {DatabaseCloudAgentCredentialService} from "./agent-credentials.js";
import {prepareCloudAgentCredentialRemoval,exchangeCloudAgentCredentialControls,readCloudAgentCredentialRemoval,
  recordCloudAgentBootCredentialDelivery,pendingCloudAgentCredentialRemoteRemoval,acknowledgeCloudAgentCredentialRemoteRemoval,
  type CloudAgentCredentialControlRequest} from "./agent-credential-mutations.js";
import type {CloudAgentBootScope} from "./agent-boot-contract.js";
import {DevConnectionClient} from "../dev-connections/client.js";
import {DevConnectionRuntime} from "../dev-connections/runtime.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("durable Dev removal aliases",()=>{
  let pool:pg.Pool,fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>,restore:DatabaseDevConnectionRestore;
  let reference:ConnectionReference,scope:CloudAgentBootScope,operationId:string;
  const mapping=()=>({issuer:"https://identity.example.test",subject:"user_dev",workosOrganizationId:"org_dev",localUserId:fixture.userId,localOrganizationId:fixture.organizationId});
  const tx=<T>(fn:Parameters<typeof withSystemTx<T>>[1])=>withSystemTx(pool,fn);
  beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8});});
  afterAll(async()=>{await pool.end();});
  afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
  beforeEach(async()=>{
    await resetMigratedTestDatabase(pool);fixture=await seedReadyCloudWorkspace(pool);
    await pool.query("UPDATE user_identities SET provider_sub='user_dev' WHERE user_id=$1",[fixture.userId]);
    await pool.query("INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state) VALUES($1::uuid,'org_dev',($1::uuid)::text,'active')",[fixture.organizationId]);
    reference={mode:"dev-reference",bindingId:randomUUID(),connectionId:randomUUID(),generationId:randomUUID(),organization:"org_dev",
      kind:"codex-api-key",accountId:"member",appScope:"api",revision:1,consentRevision:1,consent:{models:["gpt-5.4"],repositories:[],scopes:["agent"]},
      connectionMethod:"api",expiresAt:new Date(Date.now()+86400000).toISOString()};
    restore=new DatabaseDevConnectionRestore(pool);await restore.replace(mapping(),reference.generationId,[reference]);operationId=randomUUID();
    scope=await tx(async client=>{
      const bootId=(await client.query<{runtime_boot_id:string}>("SELECT runtime_boot_id FROM cloud_workspace_engine_instances WHERE id=$1",[fixture.engineInstanceId])).rows[0]!.runtime_boot_id;
      const writerEpoch=await reserveLocalCloudCommandWriter(client,{organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,
        engineInstanceId:fixture.engineInstanceId,heartbeatToken:fixture.heartbeatToken},bootId,fixture.userId,1);
      await client.query(`INSERT INTO cloud_agent_boot_bindings(workspace_id,org_id,generation,engine_instance_id,boot_id,writer_epoch,funding_owner_user_id,funding_owner_epoch)
        VALUES($1,$2,1,$3,$4,$5,$6,1)`,[fixture.workspaceId,fixture.organizationId,fixture.engineInstanceId,bootId,writerEpoch,fixture.userId]);
      return {organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId,bootId,writerEpoch,fundingOwnerUserId:fixture.userId,fundingOwnerEpoch:1};
    });
    await tx(client=>recordCloudAgentBootCredentialDelivery(client,scope,{provider:"codex",credentialId:reference.bindingId}));
  });
  const exchange=(acknowledgements:unknown[]=[])=>tx(client=>exchangeCloudAgentCredentialControls(client,{...scope,heartbeatToken:fixture.heartbeatToken,workosEnabled:false},
    {version:1,mode:"boot-owner-v1",organizationId:scope.organizationId,workspaceId:scope.workspaceId,generation:1,engineInstanceId:scope.engineInstanceId,bootId:scope.bootId,writerEpoch:scope.writerEpoch,acknowledgements}));
  const ack=(request:CloudAgentCredentialControlRequest,phase:"fenced"|"retired")=>({...scope,version:1,mutationId:operationId,controlRequestId:request.controlRequestId,
    fenceEpoch:request.fenceEpoch,controlRevision:phase==="fenced"?1:2,phase,mutationFenced:true,startsFenced:true,desiredCacheRevision:null,readyCacheRevision:1,
    proofId:phase==="retired"?randomUUID():null,activity:{complete:true,foreground:0,reservedLaunches:0,background:0,idleHosts:0,scopes:[]}});
  for(const kind of ["remove-organization-credential","revoke-credential"] as const)it(`keeps generic ${kind} local tombstone through automatic sign-in restore`,async()=>{
    const target={kind,credentialId:reference.bindingId,expectedCredentialRevision:1,...(kind==="remove-organization-credential"?{organizationId:fixture.organizationId}:{})};
    await tx(client=>prepareCloudAgentCredentialRemoval(client,fixture.userId,{version:1,operationId,target}));
    const pause=(await exchange()).controls[0]!,retire=(await exchange([ack(pause,"fenced")])).controls.find(value=>value.operation==="retire")!;
    await exchange([ack(retire,"retired")]);
    expect(await tx(client=>readCloudAgentCredentialRemoval(client,fixture.userId,operationId))).toMatchObject({state:"removed"});
    expect((await pool.query("SELECT removed_at FROM dev_connection_references WHERE binding_id=$1",[reference.bindingId])).rows[0]!.removed_at).not.toBeNull();
    await restore.replace(mapping(),reference.generationId,[reference]);
    const service=new DatabaseCloudAgentCredentialService(pool,{currentKeyVersion:1,keys:{1:randomBytes(32).toString("base64url")}});
    expect((await service.organizationConnections(fixture.userId,fixture.organizationId)).connections[0]!.connected).toBe(false);
    expect((await service.list(fixture.userId)).credentials).toEqual([]);
  });
  it("refuses automatic replacement while an admitted native scope holds the previous source",async()=>{
    await expect(restore.replace(mapping(),reference.generationId,[{...reference,revision:2}])).rejects.toMatchObject({status:409,code:"cloud_runtime_upgrade_required"});
    expect((await pool.query("SELECT reference->>'revision' AS revision FROM dev_connection_references WHERE binding_id=$1",[reference.bindingId])).rows[0]!.revision).toBe("1");
  });
  it("keeps generic Dev disconnect pending until an exact conditional broker receipt and then tombstones the old reference",async()=>{
    await tx(client=>prepareCloudAgentCredentialRemoval(client,fixture.userId,{version:1,operationId,target:{kind:"disconnect-provider",
      organizationId:fixture.organizationId,provider:"codex",expectedConnectionRevision:1}}));
    expect(await tx(client=>pendingCloudAgentCredentialRemoteRemoval(client,fixture.userId,operationId))).toBeNull();
    const pause=(await exchange()).controls[0]!,retire=(await exchange([ack(pause,"fenced")])).controls.find(value=>value.operation==="retire")!;
    await exchange([ack(retire,"retired")]);
    expect(await tx(client=>readCloudAgentCredentialRemoval(client,fixture.userId,operationId))).toMatchObject({state:"pending",phase:"removing"});
    const pending=await tx(client=>pendingCloudAgentCredentialRemoteRemoval(client,fixture.userId,operationId));
    expect(pending).toMatchObject({referenceId:reference.bindingId,scope:"organization",connectionId:reference.connectionId});
    const receipt={version:1,operationId,connectionId:reference.connectionId,scope:"organization",removed:true};
    await expect(tx(client=>acknowledgeCloudAgentCredentialRemoteRemoval(client,fixture.userId,operationId,{...receipt,operationId:randomUUID()}))).rejects.toMatchObject({status:403});
    expect(await tx(client=>acknowledgeCloudAgentCredentialRemoteRemoval(client,fixture.userId,operationId,receipt))).toMatchObject({state:"removed"});
    expect(await tx(client=>acknowledgeCloudAgentCredentialRemoteRemoval(client,fixture.userId,operationId,receipt))).toMatchObject({state:"removed"});
    await restore.replace(mapping(),reference.generationId,[reference]);
    expect((await pool.query("SELECT removed_at FROM dev_connection_references WHERE binding_id=$1",[reference.bindingId])).rows[0]!.removed_at).not.toBeNull();
  });
  it.each(["none","outbox-before-ack","empty-sign-in-lost-ack"])("reconciles conditional runtime removal after its own invalidation: %s",async race=>{
    const keys={currentKeyVersion:1,keys:{1:randomBytes(32).toString("base64url")}},requests:unknown[]=[];
    let runtime:DevConnectionRuntime,brokerRemoved=false,lost=false;
    const fetcher:typeof fetch=async(url,init)=>{
      if(String(url).includes("/revocations"))return Response.json({events:brokerRemoved&&new URL(String(url)).searchParams.get("after")==="0"?
        [{sequence:"1",binding_id:reference.bindingId,reason:"consent"}]:[]});
      if(String(url).endsWith("/restore"))return Response.json({connections:[reference]});
      if(String(url).endsWith("/connections/removals")){
        const request=JSON.parse(String(init?.body));requests.push(request);
        brokerRemoved=true;
        if(race==="outbox-before-ack")await runtime.consumeInvalidations();
        if(race==="empty-sign-in-lost-ack"&&!lost){lost=true;await restore.replace(mapping(),reference.generationId,[]);throw new Error("unknown acknowledgement");}
        return Response.json({version:1,operationId:request.operationId,connectionId:request.connectionId,scope:request.scope,removed:true});
      }
      throw new Error("unexpected broker request");
    };
    const config={deployment:"dev" as const,enabled:true as const,origin:"https://connections.example.test",
      generation:{id:reference.generationId,credential:"a".repeat(43),audience:"zeros-dev-connections-v1"}};
    runtime=new DevConnectionRuntime(pool,new DevConnectionClient(config,fetcher),keys);
    await runtime.signedIn({userId:fixture.userId,issuer:mapping().issuer,subject:"user_dev",token:"synthetic-current-member-token",expiresAt:Math.floor(Date.now()/1000)+3600});
    for(const [key,value] of Object.entries({ZEROS_DEPLOY_ENV:"dev",ZEROS_DEV_CONNECTIONS_ENABLED:"true",ZEROS_DEV_ENVIRONMENT:"hosted",
      DEV_CONNECTIONS_GENERATION:reference.generationId,ZEROS_DEV_GENERATION:reference.generationId,DEV_CONNECTIONS_GENERATION_CREDENTIAL:"a".repeat(43),
      DEV_CONNECTIONS_AUDIENCE:"zeros-dev-connections-v1",DEV_CONNECTIONS_ORIGIN:config.origin}))vi.stubEnv(key,value);
    vi.stubGlobal("fetch",fetcher);
    const servicePool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});
    try {
    const service=new DatabaseCloudAgentCredentialService(servicePool,keys);
    expect(await service.prepareRemoval(fixture.userId,{version:1,operationId,target:{kind:"disconnect-provider",organizationId:fixture.organizationId,
      provider:"codex",expectedConnectionRevision:1}})).toMatchObject({state:"pending"});
    expect(requests).toEqual([]);
    const pause=(await exchange()).controls[0]!,retire=(await exchange([ack(pause,"fenced")])).controls.find(value=>value.operation==="retire")!;
    await exchange([ack(retire,"retired")]);
    if(race==="empty-sign-in-lost-ack")await expect(service.readRemoval(fixture.userId,operationId)).rejects.toMatchObject({status:503});
    expect(await service.readRemoval(fixture.userId,operationId)).toMatchObject({state:"removed"});
    expect(await service.readRemoval(fixture.userId,operationId)).toMatchObject({state:"removed"});
    expect(requests).toHaveLength(race==="empty-sign-in-lost-ack"?2:1);expect(requests[0]).toMatchObject({operationId,bindingId:reference.bindingId,scope:"organization",expectedRevision:1,expectedConsentRevision:1});
    expect((await pool.query("SELECT removed_at FROM dev_connection_references WHERE binding_id=$1",[reference.bindingId])).rows[0]!.removed_at).not.toBeNull();
    } finally {await servicePool.end();}
  });
});
