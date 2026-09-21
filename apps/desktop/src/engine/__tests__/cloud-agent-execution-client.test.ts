import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {requestCloudAgentExecution} from "../cloud-agent-execution-client";
const authority={heartbeatEndpoint:"https://control.example.test/internal/v1/cloud-workspaces/engine/heartbeat",heartbeatToken:`zwh_${"a".repeat(43)}`,
  workspaceId:randomUUID(),organizationId:randomUUID(),generation:1,engineInstanceId:randomUUID()};
const admission={executionId:randomUUID(),delegationId:randomUUID(),provider:"cursor" as const,model:"grok-4.6",source:{kind:"session" as const,actorSessionId:randomUUID()}};
const grant={leaseId:randomUUID(),authorityId:"a".repeat(64),expiresAt:new Date(Date.now()+45_000).toISOString(),credentialVersion:1,credentialKind:"cursor-api-key",
  provider:"cursor",model:"grok-4.6",material:{kind:"cursor-api-key",apiKey:"synthetic-private-cursor-token"}};
describe("private agent execution client",()=>{
  it("binds control authority to the exact execution and acting session without accepting material",async()=>{
    const request={kind:"authorize-action" as const,executionId:randomUUID(),actorSessionId:randomUUID()};
    const result={authorized:true,executionId:request.executionId,actorSessionId:request.actorSessionId};
    const requestFetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({result})));
    await expect(requestCloudAgentExecution(authority,request,AbortSignal.timeout(1000),requestFetch)).resolves.toEqual(result);
    for(const changed of [{...result,actorSessionId:randomUUID()},{...result,executionId:randomUUID()},{...result,authorized:false},{...result,material:grant.material}]){
      requestFetch.mockResolvedValueOnce(new Response(JSON.stringify({result:changed})));
      await expect(requestCloudAgentExecution(authority,request,AbortSignal.timeout(1000),requestFetch)).rejects.toThrow("authority is unavailable");
    }
  });
  it("pins the control-plane origin and exact selection without exposing errors",async()=>{
    const requestFetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({result:grant})));
    expect(await requestCloudAgentExecution(authority,{kind:"admit",admission},new AbortController().signal,requestFetch)).toEqual(grant);
    expect(String(requestFetch.mock.calls[0]![0])).toBe("https://control.example.test/internal/v2/cloud-workspaces/engine/agent-execution");
    expect(requestFetch.mock.calls[0]![1]).toMatchObject({redirect:"error",cache:"no-store"});
    for(const document of [{result:{...grant,model:"wrong-model"}},{result:{...grant,provider:"codex"}},{result:grant,extra:"not allowed"},
      {result:{...grant,material:{...grant.material,refreshToken:"must-not-reach-the-worker"}}}]){
      requestFetch.mockResolvedValueOnce(new Response(JSON.stringify(document)));
      await expect(requestCloudAgentExecution(authority,{kind:"admit",admission},new AbortController().signal,requestFetch)).rejects.toThrow("authority is unavailable");
    }
  });
  it("bounds streamed material and never returns provider or driver failure text",async()=>{
    for(const response of [new Response("private key must not escape",{status:503}),new Response("x".repeat(50_000)),new Response("bad json")]){
      const requestFetch=vi.fn().mockResolvedValue(response);
      await expect(requestCloudAgentExecution(authority,{kind:"admit",admission},new AbortController().signal,requestFetch)).rejects.toThrow(/^Cloud agent execution authority is unavailable$/);
    }
    const requestFetch=vi.fn();await expect(requestCloudAgentExecution({...authority,heartbeatEndpoint:"http://untrusted.example.test"},{kind:"admit",admission},new AbortController().signal,requestFetch)).rejects.toThrow();expect(requestFetch).not.toHaveBeenCalled();
  });
});
