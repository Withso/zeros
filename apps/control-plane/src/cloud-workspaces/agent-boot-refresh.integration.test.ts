import {randomBytes,randomUUID} from "node:crypto";
import pg from "pg";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {resetMigratedTestDatabase} from "../test-database.js";
import {seedReadyCloudWorkspace,withCloudFixtureOwnerTx} from "./test-fixtures.js";
import {DatabaseCloudAgentCredentialService} from "./agent-credentials.js";
import {DatabaseCloudAgentExecutionService} from "./agent-executions.js";
import {DatabaseCodexAuthRenewal} from "./codex-auth-renewal.js";
import {syntheticCodexCache} from "./codex-auth-test-fixture.js";
import {CloudAgentBootCredentialResponseSchema,CloudAgentBootRefreshResponseSchema,type CloudAgentBootCredentialResponse} from "./agent-boot-contract.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("CP-owned boot Codex refresh publication",()=>{
 let pool:pg.Pool,fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>,credentialId:string,boot:CloudAgentBootCredentialResponse;
 const keys={currentKeyVersion:1,keys:{1:randomBytes(32).toString("base64url")},refreshFingerprints:{currentKeyVersion:1,keys:{1:randomBytes(32).toString("base64url")}}};
 const engine=()=>({organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId,heartbeatToken:fixture.heartbeatToken});
 const request=()=>({version:1,mode:"boot-owner-v1",organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId,
  bootId:boot.bootId,writerEpoch:boot.writerEpoch,provider:"codex",credentialId,credentialRevision:1,expectedCacheRevision:boot.cacheRevision,expectedMaterialVersion:1});
 const rotated=()=>syntheticCodexCache({expiresAt:Math.floor(Date.now()/1000)+3600,refresh:`synthetic-rotated-${randomUUID()}`});
 const renewal=(afterDispatch:()=>Promise<void>=async()=>{})=>vi.fn(async(_cache:Parameters<NonNullable<ConstructorParameters<typeof DatabaseCodexAuthRenewal>[2]>>[0],dispatch:()=>Promise<void>)=>{await dispatch();await afterDispatch();return rotated();});
 const service=(renew:NonNullable<ConstructorParameters<typeof DatabaseCodexAuthRenewal>[2]>,target=pool)=>new DatabaseCloudAgentExecutionService(target,keys,false,new DatabaseCodexAuthRenewal(pool,keys,renew));
 beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8});});afterAll(async()=>{await pool.end();});
 beforeEach(async()=>{
  await resetMigratedTestDatabase(pool);fixture=await seedReadyCloudWorkspace(pool);credentialId=randomUUID();
  await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1",[fixture.engineInstanceId]);
  await withCloudFixtureOwnerTx(pool,async tx=>{await tx.query("SET LOCAL session_replication_role=replica");await tx.query("UPDATE cloud_runtime_qualifications SET native_capabilities=$1::jsonb WHERE credential_kind='codex-chatgpt'",[JSON.stringify({version:1,goals:true,nativeFork:true,transcriptFork:true,nativeReview:true,connectedApps:false,multiAgent:false})]);});
  const credentials=new DatabaseCloudAgentCredentialService(pool,keys);
  await credentials.importCodex({ownerUserId:fixture.userId,organizationId:fixture.organizationId,credentialId,operationId:randomUUID(),expectedRevision:0,displayName:"Boot Codex",nativeCache:syntheticCodexCache({expiresAt:Math.floor(Date.now()/1000)+500})});
  await credentials.setOrganizationConnection(fixture.userId,fixture.organizationId,"codex",{expectedRevision:0,credentialId,credentialRevision:1,models:["gpt-5.6-sol"],consent:"zeros-managed"});
  boot=CloudAgentBootCredentialResponseSchema.parse(await service(renewal()).boot(engine(),"bootstrap",{version:1,mode:"boot-owner-v1",organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId}));
  expect(boot.providers.find(provider=>provider.provider==="codex")).toMatchObject({status:"ready",kind:"codex-chatgpt",materialVersion:1});
 });
 it("publishes globally once, then stores a newer positive current vault and preserves the account alias",async()=>{
  const renew=renewal(),execution=service(renew),reply=CloudAgentBootRefreshResponseSchema.parse(await execution.boot(engine(),"refresh",request()));
  expect(reply).toMatchObject({cacheRevision:2,desiredCacheRevision:2,provider:{credentialId,credentialRevision:1,connectionRevision:1,materialVersion:2}});
  expect(reply.provider.adoptionId).toBe(boot.providers.find(provider=>provider.status==="ready")!.adoptionId);
  expect(renew).toHaveBeenCalledTimes(1);expect(JSON.stringify(reply)).not.toMatch(/refresh_token|id_token|nativeCache/);
  const current=CloudAgentBootCredentialResponseSchema.parse(await execution.boot(engine(),"sync",{version:1,mode:"boot-owner-v1",organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId,bootId:boot.bootId,writerEpoch:boot.writerEpoch,expectedCacheRevision:2}));
  expect(current.providers.find(provider=>provider.provider==="codex")).toEqual(reply.provider);
  expect((await pool.query("SELECT count(*)::int AS count FROM cloud_agent_boot_credentials")).rows[0]!.count).toBe(3);
  expect((await pool.query("SELECT * FROM cloud_agent_execution_leases")).rowCount).toBe(0);
 });
 it("coalesces concurrent boots onto the existing global renewal and replays only current positive access",async()=>{
  const renew=renewal(),execution=service(renew);
  const [first,second]=await Promise.all([execution.boot(engine(),"refresh",request()),execution.boot(engine(),"refresh",request())]);
  expect(second).toEqual(first);expect(await execution.boot(engine(),"refresh",request())).toEqual(first);expect(renew).toHaveBeenCalledTimes(1);
 });
 it("does not discard a known global rotation when boot publication rolls back",async()=>{
  let failed=false;
  const wrapped={connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,key){
   if(key==="query")return async(...args:unknown[])=>{
    const text=typeof args[0]==="string"?args[0]:"";
    if(text.startsWith("INSERT INTO cloud_agent_boot_credentials")&&!failed){failed=true;throw Object.assign(new Error("synthetic-boot-publication-rollback"),{code:"40001"});}
    return (target.query as (...args:unknown[])=>Promise<unknown>).apply(target,args);
   };
   const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
  }});}} as unknown as pg.Pool;
  const renew=renewal();await expect(service(renew,wrapped).boot(engine(),"refresh",request())).rejects.toThrow();
  expect(failed).toBe(true);expect((await pool.query("SELECT current_version FROM cloud_agent_credentials WHERE id=$1",[credentialId])).rows[0]!.current_version).toBe(2);
  const reply=CloudAgentBootRefreshResponseSchema.parse(await service(renew).boot(engine(),"refresh",request()));
  expect(reply.provider.materialVersion).toBe(2);expect(renew).toHaveBeenCalledTimes(1);
 });
 it("preserves global renewal but refuses positive delivery after exact boot retirement",async()=>{
  const renew=renewal(async()=>{await pool.query("UPDATE cloud_agent_boot_bindings SET retired_at=now() WHERE engine_instance_id=$1",[fixture.engineInstanceId]);});
  await expect(service(renew).boot(engine(),"refresh",request())).rejects.toThrow();
  expect(renew).toHaveBeenCalledTimes(1);expect((await pool.query("SELECT current_version FROM cloud_agent_credentials WHERE id=$1",[credentialId])).rows[0]!.current_version).toBe(2);
 });
 it("does not rotate or deliver across a pending desired epoch or a foreign captured source",async()=>{
  const renew=renewal(),execution=service(renew);
  await expect(execution.boot(engine(),"refresh",{...request(),credentialId:randomUUID()})).rejects.toThrow();
  await pool.query("UPDATE cloud_agent_boot_bindings SET desired_cache_revision=2 WHERE engine_instance_id=$1",[fixture.engineInstanceId]);
  await expect(execution.boot(engine(),"refresh",request())).rejects.toThrow();expect(renew).not.toHaveBeenCalled();
 });
 it("never adopts a changed connection after a dispatched global rotation",async()=>{
  const renew=renewal(async()=>{await pool.query("UPDATE cloud_agent_organization_connections SET revision=revision+1 WHERE org_id=$1 AND owner_user_id=$2 AND provider='codex'",[fixture.organizationId,fixture.userId]);});
  await expect(service(renew).boot(engine(),"refresh",request())).rejects.toThrow();
  expect(renew).toHaveBeenCalledTimes(1);expect((await pool.query("SELECT cache_revision FROM cloud_agent_boot_bindings")).rows[0]!.cache_revision).toBe("1");
 });
});
