import {randomUUID} from "node:crypto";
import {z} from "zod";
import {describe,expect,it,vi} from "vitest";
import type {CloudAgentExecutionRequest} from "@zeros/protocol/cloud-agent-execution";
import {CloudAgentLease} from "../agents/cloud-agent-lease";
import {requestCloudAgentExecution} from "../cloud-agent-execution-client";

// Previous committed route contract (c4895c03). Keep the exact accepted field
// sets so tests exercise the production lease, not an abbreviated admit call.
const legacyRequest=z.object({workspaceId:z.uuid(),organizationId:z.uuid(),generation:z.number().int().positive().safe(),engineInstanceId:z.uuid(),
  request:z.discriminatedUnion("kind",[
    z.object({kind:z.literal("admit"),admission:z.unknown()}).strict(),
    z.object({kind:z.literal("validate"),leaseId:z.uuid(),renew:z.boolean().optional(),credentialVersion:z.number().int().positive().safe().optional()}).strict(),
    z.object({kind:z.literal("refresh-codex"),leaseId:z.uuid(),credentialVersion:z.number().int().positive().safe()}).strict(),
    z.object({kind:z.literal("release"),leaseId:z.uuid()}).strict(),
    z.object({kind:z.literal("authorize-action"),executionId:z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),actorSessionId:z.uuid()}).strict(),
  ])}).strict();
function fixture(provider:"cursor"|"codex"="cursor"){
  const authority={heartbeatEndpoint:"https://control.example.test/internal/v1/cloud-workspaces/engine/heartbeat",heartbeatToken:`zwh_${"a".repeat(43)}`,
    workspaceId:randomUUID(),organizationId:randomUUID(),generation:1,engineInstanceId:randomUUID()};
  const admission={executionId:randomUUID(),delegationId:randomUUID(),provider,model:"qualified-model",source:{kind:"session" as const,actorSessionId:randomUUID()}};
  const leaseId=randomUUID(),authorityId="a".repeat(64);let version=1;
  const codex={kind:"codex-chatgpt" as const,accessToken:"synthetic-private-codex-access",accountId:"test-account",expiresAt:Math.floor(Date.now()/1000)+3600};
  const fetcher=vi.fn(async(_endpoint:unknown,options?:RequestInit)=>{
    const parsed=legacyRequest.safeParse(JSON.parse(String(options?.body)));
    if(!parsed.success)return new Response(JSON.stringify({error:"invalid_agent_execution"}),{status:422});
    const request=parsed.data.request,lease={leaseId,expiresAt:new Date(Date.now()+45_000).toISOString(),credentialVersion:version};
    const material=provider==="codex"?codex:{kind:"cursor-api-key",apiKey:"synthetic-private-cursor-key"};
    const result=request.kind==="admit"?{...lease,authorityId,provider,model:admission.model,credentialKind:material.kind,material}:
      request.kind==="release"?{released:true}:request.kind==="refresh-codex"?{...lease,credentialVersion:++version,rotation:{authorityId,material:codex}}:lease;
    return new Response(JSON.stringify({result}));
  });
  const request=(input:CloudAgentExecutionRequest,signal:AbortSignal)=>requestCloudAgentExecution(authority,input,signal,fetcher);
  return {admission,fetcher,request};
}
describe("previous control-plane execution profile",()=>{
  it.each(["cursor","codex"] as const)("admits, renews and releases %s without inventing unsupported capabilities",async provider=>{
    const f=fixture(provider),lease=await CloudAgentLease.admit(f.admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()});
    try{
      expect(lease.backgroundTasksVersion).toBeNull();expect(lease.nativeCapabilities).toBeNull();expect(lease.gitAuthor).toBeNull();
      await lease.validate(true);if(provider==="codex")await lease.refreshCodex(1);
      await expect(lease.background({kind:"read",conversationId:"chat"})).rejects.toThrow(/updated control plane/);
    }finally{await lease.close();}
    const requests=f.fetcher.mock.calls.map(([,options])=>JSON.parse(String(options?.body)));
    expect(requests[0].request).toMatchObject({includeGitAuthor:true,nativeCapabilitiesVersion:1,backgroundTasksVersion:1});
    for(const request of requests.slice(1))expect(legacyRequest.safeParse(request).success).toBe(true);
  });
  it("does not drop required customization when the old route rejects the request",async()=>{
    const f=fixture();await expect(CloudAgentLease.admit({...f.admission,customization:{version:2,repositoryServers:[]}},f.request,
      new AbortController().signal,{onRetirementFailure:vi.fn()})).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
});
