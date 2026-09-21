import {randomUUID} from "node:crypto";
import {Hono} from "hono";
import {HTTPException} from "hono/http-exception";
import {describe,expect,it,vi} from "vitest";
import type {AuthedUser} from "../auth.js";
import {HttpError} from "../authz.js";
import {createCloudAgentCredentialRoutes,createCloudAgentExecutionRoutes,CLOUD_AGENT_EXECUTION_PATH} from "./agent-credential-routes.js";
import type {DatabaseCloudAgentCredentialService} from "./agent-credentials.js";
import type {DatabaseCloudAgentExecutionService} from "./agent-executions.js";
import {CloudWorkspaceEngineAuthorityError} from "./engine-authority.js";

describe("personal cloud credential HTTP boundaries",()=>{
  it("derives ownership from the authenticated account and rejects supplied owner selectors",async()=>{
    const user={id:randomUUID()} as AuthedUser,service={put:vi.fn().mockResolvedValue({credential:{id:randomUUID()}}),list:vi.fn().mockResolvedValue({credentials:[]})};
    const app=new Hono();app.use("*",async(c,next)=>{c.set("user",user);await next();});
    app.onError((error,c)=>error instanceof HTTPException?error.getResponse():error instanceof HttpError?c.json({error:error.code},error.status as 422):c.json({error:"unavailable"},503));
    app.route("/",createCloudAgentCredentialRoutes(service as unknown as DatabaseCloudAgentCredentialService));
    const credentialId=randomUUID(),body={operationId:randomUUID(),expectedRevision:0,displayName:"Private provider",material:{kind:"cursor-api-key",apiKey:"synthetic-owner-secret"}};
    const call=(value:unknown)=>app.request(`/v1/cloud-agent-credentials/${credentialId}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
    expect((await call({...body,ownerUserId:randomUUID()})).status).toBe(422);expect(service.put).not.toHaveBeenCalled();
    const response=await call(body);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("synthetic-owner-secret");
    expect(service.put).toHaveBeenCalledWith({...body,credentialId,ownerUserId:user.id});
    expect((await call({...body,displayName:"x".repeat(50_000)})).status).toBe(413);
  });
  it("imports native Codex cache only under the authenticated owner and responds with metadata",async()=>{
    const owner=randomUUID(),id=randomUUID(),service={importCodex:vi.fn(async()=>({credential:{id,kind:"codex-chatgpt",revision:1}}))};
    const app=new Hono();app.use("*",async(c,next)=>{c.set("user",{id:owner} as AuthedUser);await next();});
    app.onError((error,c)=>error instanceof HTTPException?error.getResponse():error instanceof HttpError?c.json({error:error.code},error.status as 422):c.json({error:"unavailable"},503));
    app.route("/",createCloudAgentCredentialRoutes(service as unknown as DatabaseCloudAgentCredentialService));
    const input={operationId:randomUUID(),expectedRevision:0,displayName:"Codex",nativeCache:{tokens:{refresh_token:"private-cache-sentinel"}}};
    const call=(body:unknown)=>app.request(`/v1/cloud-agent-credentials/${id}/native-codex`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    expect((await call({...input,ownerUserId:randomUUID()})).status).toBe(422);
    const response=await call(input);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");expect(await response.text()).not.toContain("private-cache-sentinel");
    expect(service.importCodex).toHaveBeenCalledWith({...input,ownerUserId:owner,credentialId:id});
    expect((await call({...input,nativeCache:"x".repeat(100000)})).status).toBe(413);
  });
  it("accepts only bounded engine requests and hides private service failures",async()=>{
    const service={admit:vi.fn().mockResolvedValue({leaseId:randomUUID()}),validate:vi.fn(),release:vi.fn()},app=createCloudAgentExecutionRoutes(service as unknown as DatabaseCloudAgentExecutionService);
    const scope={workspaceId:randomUUID(),organizationId:randomUUID(),generation:1,engineInstanceId:randomUUID()},token=`zwh_${"x".repeat(43)}`;
    const call=(request:unknown,authorization=`Bearer ${token}`,contentType="application/json")=>app.request(CLOUD_AGENT_EXECUTION_PATH,{method:"POST",headers:{authorization,"content-type":contentType},body:JSON.stringify({...scope,request})});
    const admission={executionId:randomUUID(),delegationId:randomUUID(),model:"grok-4.6",source:{kind:"session",actorSessionId:randomUUID()}},request={kind:"admit",admission};
    expect((await call(request,"Bearer browser-user-token")).status).toBe(401);
    expect((await call(request,undefined,"text/plain")).status).toBe(415);
    expect((await call({...request,credentialId:randomUUID()})).status).toBe(422);
    expect((await call({...request,admission:"x".repeat(5000)})).status).toBe(413);expect(service.admit).not.toHaveBeenCalled();
    const response=await call(request);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
    expect(service.admit).toHaveBeenCalledWith({...scope,heartbeatToken:token},admission);
    for(const [error,status] of [[new CloudWorkspaceEngineAuthorityError(),401],[new HttpError(403,"private","private"),403],[new HttpError(503,"busy","private"),503],[new Error("secret SQL material"),503]] as const){
      service.admit.mockRejectedValueOnce(error);const failed=await call(request);expect(failed.status).toBe(status);expect(await failed.text()).not.toMatch(/secret|SQL|material/);
    }
  });
});
