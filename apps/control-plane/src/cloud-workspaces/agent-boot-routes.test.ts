import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {HttpError} from "../authz.js";
import {createCloudAgentExecutionRoutes} from "./agent-credential-routes.js";
import type {DatabaseCloudAgentExecutionService} from "./agent-executions.js";
const scope={organizationId:randomUUID(),workspaceId:randomUUID(),generation:1,engineInstanceId:randomUUID()};
const identity={...scope,version:1,mode:"boot-owner-v1",bootId:randomUUID(),writerEpoch:randomUUID(),fundingOwnerUserId:randomUUID(),fundingOwnerEpoch:1,
  fundingScope:"workspace-roles-v1",authorityEpoch:1};
const response={...identity,cacheRevision:1,desiredCacheRevision:1,initialAdoptions:["claude","codex","cursor"].map(provider=>({provider,status:"missing"})),
  providers:["claude","codex","cursor"].map(provider=>({provider,status:"unavailable",code:"cloud_agent_credential_required"}))};
const body={...scope,version:1,mode:"boot-owner-v1"};
const headers={"content-type":"application/json",authorization:`Bearer zwh_${"x".repeat(43)}`};
const app=(boot:unknown)=>createCloudAgentExecutionRoutes({boot} as DatabaseCloudAgentExecutionService);
describe("private boot credential routes",()=>{
  it("uses the real heartbeat-only bootstrap facade and strict result wrapper",async()=>{
    const boot=vi.fn().mockResolvedValue(response),result=await app(boot).request("/internal/v2/cloud-workspaces/engine/agent-boot/bootstrap",{method:"POST",headers,body:JSON.stringify(body)});
    expect(result.status).toBe(200);expect(await result.json()).toEqual({result:response});
    expect(boot).toHaveBeenCalledWith({...scope,heartbeatToken:`zwh_${"x".repeat(43)}`} ,"bootstrap",body);
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
  it("keeps funding choice out of the request and denies a renderer bearer",async()=>{
    const boot=vi.fn(),api=app(boot),path="/internal/v2/cloud-workspaces/engine/agent-boot/bootstrap";
    expect((await api.request(path,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer renderer-session"},body:JSON.stringify(body)})).status).toBe(401);
    expect((await api.request(path,{method:"POST",headers,body:JSON.stringify({...body,fundingOwnerUserId:randomUUID()})})).status).toBe(422);
    expect(boot).not.toHaveBeenCalled();
  });
  it("redacts typed foreign authority without revealing existence",async()=>{
    const boot=vi.fn().mockRejectedValue(new HttpError(404,"not_found","synthetic-private-diagnostic"));
    const result=await app(boot).request("/internal/v2/cloud-workspaces/engine/agent-boot/bootstrap",{method:"POST",headers,body:JSON.stringify(body)});
    expect(result.status).toBe(403);expect(await result.json()).toEqual({error:"cloud_admission_access_denied"});
  });
  it("refuses a secret-bearing or foreign result before HTTP publication",async()=>{
    for(const value of [{...response,refreshToken:"synthetic-private"},{...response,workspaceId:randomUUID()}]){
      const result=await app(vi.fn().mockResolvedValue(value)).request("/internal/v2/cloud-workspaces/engine/agent-boot/bootstrap",{method:"POST",headers,body:JSON.stringify(body)});
      expect(result.status).toBe(503);
    }
  });
  it("exposes activation only as a separate exact ready-epoch request",async()=>{
    const request={...body,bootId:identity.bootId,writerEpoch:identity.writerEpoch,expectedCacheRevision:1},boot=vi.fn().mockResolvedValue({...identity,cacheRevision:1,activated:true});
    const result=await app(boot).request("/internal/v2/cloud-workspaces/engine/agent-boot/activate",{method:"POST",headers,body:JSON.stringify(request)});
    expect(result.status).toBe(200);expect(boot).toHaveBeenCalledWith({...scope,heartbeatToken:`zwh_${"x".repeat(43)}`} ,"activate",request);
  });
});
