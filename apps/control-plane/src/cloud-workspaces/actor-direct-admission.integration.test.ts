import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from "node:crypto";
import pg from "pg";
import {Hono} from "hono";
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {ensureUser} from "../auth.js";
import {resetMigratedTestDatabase} from "../test-database.js";
import {seedReadyCloudWorkspace} from "./test-fixtures.js";
import {DatabaseCloudAgentExecutionService} from "./agent-executions.js";
import {DatabaseCloudWorkspaceActorSessionService} from "./actor-sessions.js";
import {cloudWorkspaceDeviceProofMessage} from "./replicas.js";
import {CloudAgentBootCredentialResponseSchema} from "./agent-boot-contract.js";
import {createCloudWorkspaceRoutes} from "./routes.js";
import {DatabaseCloudWorkspaceEngineClientAdmissionService} from "./engine-client-admission.js";
import {HttpError} from "../authz.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
type EndpointScope={organizationId:string;workspaceId:string;generation:number;engineInstanceId:string;resourceId:string;remotePort:number};
suite("negotiated verified Boat actor admission",()=>{
 let pool:pg.Pool,fixture:Awaited<ReturnType<typeof seedReadyCloudWorkspace>>,user:Awaited<ReturnType<typeof ensureUser>>,deviceId:string,pair:ReturnType<typeof generateKeyPairSync>,boot:ReturnType<typeof CloudAgentBootCredentialResponseSchema.parse>;
 const engine=()=>({organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId,heartbeatToken:fixture.heartbeatToken});
 const input=()=>{const fields={deviceId,keyVersion:1,timestampMs:Date.now(),nonce:randomBytes(24).toString("base64url")};return {organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,actorUserId:user.id,authenticatedUser:user,
  proof:{...fields,signature:sign(null,cloudWorkspaceDeviceProofMessage({...fields,accountUserId:user.id,action:"engine.connect",payload:{organizationId:fixture.organizationId,workspaceId:fixture.workspaceId}}),pair.privateKey).toString("base64url")}};};
 const issuer=(resolve:(scope:EndpointScope)=>Promise<{url:string}>)=>{const options={pool,enginePort:39393,bridgeUrl:"wss://api.example.test/v1/cloud-workspaces/bridge",workosEnabled:false,directProviderEndpoint:resolve};return new DatabaseCloudWorkspaceActorSessionService(options);};
 beforeAll(()=>{pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:8});});afterAll(async()=>{await pool.end();});
 beforeEach(async()=>{
  await resetMigratedTestDatabase(pool);fixture=await seedReadyCloudWorkspace(pool);
  await pool.query("UPDATE cloud_workspace_engine_instances SET cloud_local_commands_version=1 WHERE id=$1",[fixture.engineInstanceId]);
  const execution=new DatabaseCloudAgentExecutionService(pool,{currentKeyVersion:1,keys:{1:randomBytes(32).toString("base64url")}},false);
  boot=CloudAgentBootCredentialResponseSchema.parse(await execution.boot(engine(),"bootstrap",{version:1,mode:"boot-owner-v1",organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId}));
  await execution.boot(engine(),"activate",{version:1,mode:"boot-owner-v1",organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId,bootId:boot.bootId,writerEpoch:boot.writerEpoch,expectedCacheRevision:boot.cacheRevision});
  user=await ensureUser(pool,{provider:"workos",providerSubject:`workos|${fixture.userId}`,email:`direct-${fixture.userId}@example.test`,displayName:"Owner",session:{id:`session_${randomUUID()}`,clientKind:"desktop",authTime:Math.floor(Date.now()/1000),tokenExpiresAt:Math.floor(Date.now()/1000)+3600}});
  await pool.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '1 hour')",[user.authentication.sessionId,user.identity.subject,user.id]);
  pair=generateKeyPairSync("ed25519");const publicKey=Buffer.from(pair.publicKey.export({format:"jwk"}).x!,"base64url");
  deviceId=(await pool.query("INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Direct actor','macos',$2,$3) RETURNING id",[user.id,publicKey,createHash("sha256").update(publicKey).digest()])).rows[0]!.id;
 });
 it("publishes only the real resolver's engine-port endpoint with the existing actor grant and exact boot",async()=>{
  const resolve=vi.fn(async(_scope:EndpointScope)=>({url:"https://verified-sandbox-39393.on.boat.dev/"})),service=issuer(resolve),request={...input(),directProviderVersion:1 as const};
  const grant=await service.issue(request);
  expect(grant).toMatchObject({version:2,engineInstanceId:fixture.engineInstanceId,remotePort:39393,bootScope:{bootId:boot.bootId,writerEpoch:boot.writerEpoch,fundingOwnerUserId:fixture.userId},directProvider:{version:1,provider:"boat",url:"wss://verified-sandbox-39393.on.boat.dev/ws"}});
  expect(resolve).toHaveBeenCalledWith(expect.objectContaining({organizationId:fixture.organizationId,workspaceId:fixture.workspaceId,generation:1,engineInstanceId:fixture.engineInstanceId,resourceId:expect.any(String),remotePort:39393}));
  expect(resolve.mock.calls[0]![0]).not.toHaveProperty("heartbeatToken");
  const admitted=await service.consume({...engine(),token:grant.grantToken});expect(admitted).toMatchObject({admitted:true,accountUserId:fixture.userId});
 });
 it("keeps old strict grants unchanged and makes CP fallback a fresh exact-boot admission without provider lookup",async()=>{
  const resolve=vi.fn(async()=>({url:"https://verified-sandbox-39393.on.boat.dev/"})),service=issuer(resolve);
  const legacy=await service.issue(input());expect(legacy).not.toHaveProperty("bootScope");expect(legacy).not.toHaveProperty("directProvider");
  const request={...input(),directProviderVersion:1 as const,connectionChannel:"control-plane-websocket" as const},fallback=await service.issue(request);
  expect(fallback).toMatchObject({bootScope:{bootId:boot.bootId,writerEpoch:boot.writerEpoch}});expect(fallback).not.toHaveProperty("directProvider");
  expect(fallback.grantToken).not.toBe(legacy.grantToken);expect(resolve).not.toHaveBeenCalled();
 });
 it("forwards only the closed public direct opt-in and fresh CP preference through the real route",async()=>{
  const resolve=vi.fn(async()=>({url:"https://verified-sandbox-39393.on.boat.dev/"}));
  const admission=new DatabaseCloudWorkspaceEngineClientAdmissionService({pool,enginePort:39393,relayEnabled:true,
   endpoint:"https://api.example.test/internal/v1/cloud-workspaces/engine/client-admission",directProviderEndpoint:resolve});
  const app=new Hono();app.use("*",async(c,next)=>{c.set("user",user);await next();});
  app.route("/",createCloudWorkspaceRoutes(pool,null,{engineClientAdmissionService:admission}));
  app.onError((error,c)=>{if(error instanceof HttpError)return c.json({error:error.code},error.status);throw error;});
  const path=`/v1/organizations/${fixture.organizationId}/cloud-workspaces/${fixture.workspaceId}/runtime/admission`;
  for(const value of [{directProviderVersion:1},{actorProtocolVersion:2,connectionChannel:"control-plane-websocket"},
   {actorProtocolVersion:2,directProviderVersion:1,url:"wss://attacker.example/ws"}]){
   const result=await app.request(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
   expect(result.status).toBe(422);
  }
  for(const fallback of [false,true]){
   const {proof}=input(),headers={"content-type":"application/json","x-zeros-device-id":proof.deviceId,
    "x-zeros-device-key-version":String(proof.keyVersion),"x-zeros-device-timestamp":String(proof.timestampMs),
    "x-zeros-device-nonce":proof.nonce,"x-zeros-device-signature":proof.signature};
   const result=await app.request(path,{method:"POST",headers,body:JSON.stringify({actorProtocolVersion:2,directProviderVersion:1,
    ...(fallback?{connectionChannel:"control-plane-websocket"}:{})})});
   expect(result.status).toBe(201);expect(result.headers.get("cache-control")).toBe("no-store");
   const value=await result.json();expect(value.bootScope).toMatchObject({bootId:boot.bootId,writerEpoch:boot.writerEpoch});
   if(fallback)expect(value).not.toHaveProperty("directProvider");else expect(value.directProvider.provider).toBe("boat");
  }
  expect(resolve).toHaveBeenCalledTimes(1);
 });
 it.each(["device","auth","engine","writer","admission"] as const)("refuses %s invalidation observed after provider lookup and never publishes the new grant",async kind=>{
  const resolve=vi.fn(async()=>{
   if(kind==="device")await pool.query("UPDATE devices SET trust_state='revoked',revoked_at=now() WHERE id=$1",[deviceId]);
   if(kind==="auth")await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1",[user.authentication.sessionId]);
   if(kind==="engine")await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=now() WHERE id=$1",[fixture.engineInstanceId]);
   if(kind==="writer")await pool.query("UPDATE cloud_workspace_local_command_writers SET state='retired',retired_at=now() WHERE writer_epoch=$1",[boot.writerEpoch]);
   if(kind==="admission")await pool.query("UPDATE cloud_workspace_actor_sessions SET admission_expires_at=clock_timestamp() WHERE workspace_id=$1",[fixture.workspaceId]);
   return {url:"https://verified-sandbox-39393.on.boat.dev/"};
  }),service=issuer(resolve),request={...input(),directProviderVersion:1 as const};
  await expect(service.issue(request)).rejects.toThrow();expect(resolve).toHaveBeenCalledTimes(1);
  expect((await pool.query("SELECT count(*)::int AS count FROM cloud_workspace_actor_sessions WHERE revoked_at IS NULL")).rows[0]!.count).toBe(0);
 });
 it.each(["https://attacker.example/","https://verified-sandbox-3000.on.boat.dev/","https://verified-sandbox-39393.on.boat.dev/?token=secret","http://verified-sandbox-39393.on.boat.dev/"])("refuses an unqualified endpoint %s",async url=>{
  const service=issuer(async()=>({url})),request={...input(),directProviderVersion:1 as const};
  await expect(service.issue(request)).rejects.toThrow();
 });
});
