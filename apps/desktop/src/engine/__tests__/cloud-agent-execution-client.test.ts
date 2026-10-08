import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {requestCloudAgentExecution} from "../cloud-agent-execution-client";
const authority={heartbeatEndpoint:"https://control.example.test/internal/v1/cloud-workspaces/engine/heartbeat",heartbeatToken:`zwh_${"a".repeat(43)}`,
  workspaceId:randomUUID(),organizationId:randomUUID(),generation:1,engineInstanceId:randomUUID()};
const admission={executionId:randomUUID(),delegationId:randomUUID(),provider:"cursor" as const,model:"grok-4.6",source:{kind:"session" as const,actorSessionId:randomUUID()}};
const grant={leaseId:randomUUID(),authorityId:"a".repeat(64),expiresAt:new Date(Date.now()+45_000).toISOString(),credentialVersion:1,credentialKind:"cursor-api-key",
  provider:"cursor",model:"grok-4.6",material:{kind:"cursor-api-key",apiKey:"synthetic-private-cursor-token"}};
describe("private agent execution client",()=>{
  it.each([401,403,404,409,429,503])("preserves a closed typed HTTP %s body including its original stage",async status=>{
    const code="cloud_provider_start_credential_refresh_rejected";
    const fetcher=vi.fn().mockResolvedValue(Response.json({error:code},{status}));
    await expect(requestCloudAgentExecution(authority,{kind:"validate",leaseId:grant.leaseId,renew:true},new AbortController().signal,fetcher))
      .rejects.toMatchObject({code,message:"Cloud agent execution authority is unavailable"});
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["cloud_agent_credential_expired","cloud_agent_credential_revoked","cloud_agent_credential_refresh_required"])("retains the legacy %s authority code during validation",async code=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({error:code},{status:409}));
    await expect(requestCloudAgentExecution(authority,{kind:"validate",leaseId:grant.leaseId,renew:true},new AbortController().signal,fetcher)).rejects.toMatchObject({code});
  });
  it("classifies untyped HTTP 429 as rate_limited and excludes unsafe typed-body lookalikes",async()=>{
    for(const body of ["private limit diagnostic",JSON.stringify({error:"cloud_validation_access_denied",details:"private"}),JSON.stringify({error:"cloud_validation_private_diagnostic"}),"x".repeat(1025)]){
      const fetcher=vi.fn().mockResolvedValue(new Response(body,{status:429}));
      await expect(requestCloudAgentExecution(authority,{kind:"validate",leaseId:grant.leaseId,renew:true},new AbortController().signal,fetcher))
        .rejects.toMatchObject({code:"cloud_validation_rate_limited",message:"Cloud agent execution authority is unavailable"});
    }
  });
  it("does not negotiate capabilities on a typed 422 rejection",async()=>{
    const code="cloud_admission_access_denied",fetcher=vi.fn().mockResolvedValue(Response.json({error:code},{status:422}));
    await expect(requestCloudAgentExecution(authority,{kind:"admit",admission,computerToolsVersion:1,backgroundTasksVersion:1},new AbortController().signal,fetcher)).rejects.toMatchObject({code});
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["private provider diagnostic", JSON.stringify({ error: "unknown_private_refusal" }),
    JSON.stringify({ error: "cloud_agent_credential_expired", details: "private" })])("classifies an untyped HTTP409 without borrowing its diagnostic body", async body => {
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status: 409 }));
    await expect(requestCloudAgentExecution(authority, { kind: "admit", admission }, new AbortController().signal, fetcher))
      .rejects.toMatchObject({ code: "cloud_admission_authority_http_4xx", message: "Cloud agent execution authority is unavailable" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    [401, "authority_http_4xx"], [404, "authority_http_4xx"], [503, "authority_http_5xx"], [200, "authority_response_invalid"],
  ])("retains a safe admission category for HTTP %s without exposing the body", async (status, category) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("private provider diagnostic", { status: status as number }));
    await expect(requestCloudAgentExecution(authority, { kind: "admit", admission }, new AbortController().signal, fetcher))
      .rejects.toMatchObject({ code: `cloud_admission_${category}`, message: "Cloud agent execution authority is unavailable" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["TimeoutError", "TypeError"])("retains a safe %s transport cause without retrying admission", async name => {
    const error = new Error("private transport diagnostic"); error.name = name;
    const fetcher = vi.fn().mockRejectedValue(error);
    await expect(requestCloudAgentExecution(authority, { kind: "admit", admission }, new AbortController().signal, fetcher))
      .rejects.toMatchObject({ code: `cloud_admission_${name === "TimeoutError" ? "authority_timeout" : "authority_transport"}` });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["cloud_agent_model_not_authorized", "cloud_agent_credential_required", "cloud_agent_credential_expired", "cloud_agent_credential_revoked", "cloud_agent_credential_refresh_required"])("preserves the closed %s admission cause without retrying", async code => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: code }, { status: 409 }));
    await expect(requestCloudAgentExecution(authority, { kind: "admit", admission }, new AbortController().signal, fetcher)).rejects.toThrow(code);
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce(Response.json({ error: code, details: "private" }, { status: 409 }));
    await expect(requestCloudAgentExecution(authority, { kind: "admit", admission }, new AbortController().signal, fetcher)).rejects.toThrow(/^Cloud agent execution authority is unavailable$/);
  });
  it("preserves only the closed runtime-upgrade admission error without retrying",async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:"cloud_runtime_upgrade_required"}),{status:409}));
    await expect(requestCloudAgentExecution(authority,{kind:"admit",admission},new AbortController().signal,fetcher))
      .rejects.toThrow(/^cloud_runtime_upgrade_required$/);
    expect(fetcher).toHaveBeenCalledOnce();
    for(const [status,body] of [[403,{error:"cloud_runtime_upgrade_required"}],[409,{error:"cloud_runtime_upgrade_required",details:"private"}]] as const){
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify(body),{status}));
      await expect(requestCloudAgentExecution(authority,{kind:"admit",admission},new AbortController().signal,fetcher))
        .rejects.toThrow(/^Cloud agent execution authority is unavailable$/);
    }
  });
  it("preserves only typed computer conflicts and never retries the mutation",async()=>{
    const input={kind:"computer-tool" as const,leaseId:randomUUID(),toolCallId:"native-call",
      tool:{name:"CreateComputerConfiguration" as const,arguments:{installScript:"echo ready",expectedRevision:1,previousBuildId:null}}};
    const conflict={conflict:true,revision:3,latestBuildId:randomUUID()};
    const requestFetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({result:conflict}),{status:409}));
    expect(await requestCloudAgentExecution(authority,input,new AbortController().signal,requestFetch)).toEqual(conflict);
    expect(requestFetch).toHaveBeenCalledOnce();
    for(const value of [{...conflict,secret:"forbidden"},{revision:3},{...conflict,conflict:false}]){
      requestFetch.mockResolvedValueOnce(new Response(JSON.stringify({result:value}),{status:409}));
      await expect(requestCloudAgentExecution(authority,input,new AbortController().signal,requestFetch)).rejects.toThrow("authority is unavailable");
    }
  });
  it("preserves the current settings version on setup CAS conflicts without retrying",async()=>{
    const input={kind:"computer-tool" as const,leaseId:randomUUID(),toolCallId:"native-setup",
      tool:{name:"UpdateRepositorySetupScript" as const,arguments:{repositoryId:randomUUID(),expectedSettingsVersion:0,script:"echo ready",timeoutSeconds:30}}};
    const conflict={conflict:true,version:1};
    const requestFetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({result:conflict}),{status:409}));
    expect(await requestCloudAgentExecution(authority,input,new AbortController().signal,requestFetch)).toEqual(conflict);
    expect(requestFetch).toHaveBeenCalledOnce();
  });
  it("surfaces a closed update-required response for marked older executions",async()=>{
    const requestFetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:"cloud_computer_tools_update_required"}),{status:409}));
    await expect(requestCloudAgentExecution(authority,{kind:"admit",admission},new AbortController().signal,requestFetch))
      .rejects.toThrow("Update the cloud runtime and control plane");
    expect(requestFetch).toHaveBeenCalledOnce();
  });
  it("accepts bounded terminal env only over the private engine request and rejects malformed maps",async()=>{
    const request={kind:"terminal-environment" as const,actorSessionId:randomUUID()};
    const values={ORG_VALUE:"synthetic-org-value",EMPTY_OVERRIDE:"",LARGE_VALUE:"v".repeat(65_536)};
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({result:{version:1,environment:values}})));
    await expect(requestCloudAgentExecution(authority,request,AbortSignal.timeout(1000),fetcher)).resolves.toEqual({version:1,environment:values});
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).request).toEqual(request);
    expect(fetcher.mock.calls[0]![1].body).not.toContain(values.ORG_VALUE);
    for(const environment of [{NODE_OPTIONS:"private"},{ORG_VALUE:"v".repeat(65_537)},{ORG_VALUE:"bad\0value"}]){
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({result:{version:1,environment}})));
      await expect(requestCloudAgentExecution(authority,request,AbortSignal.timeout(1000),fetcher)).rejects.toThrow(/^Cloud agent execution authority is unavailable$/);
    }
    fetcher.mockResolvedValueOnce(new Response("private-diagnostic",{status:409}));
    await expect(requestCloudAgentExecution(authority,request,AbortSignal.timeout(1000),fetcher)).rejects.toThrow(/^Cloud agent execution authority is unavailable$/);
    fetcher.mockResolvedValueOnce(new Response("x".repeat(2*1024*1024+1)));
    await expect(requestCloudAgentExecution(authority,request,AbortSignal.timeout(1000),fetcher)).rejects.toThrow(/^Cloud agent execution authority is unavailable$/);
  });
  it("negotiates background retention with a legacy backend only after a definite schema rejection",async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response("legacy schema",{status:422})).mockResolvedValueOnce(new Response(JSON.stringify({result:grant})));
    await expect(requestCloudAgentExecution(authority,{kind:"admit",admission,backgroundTasksVersion:1},new AbortController().signal,fetcher)).resolves.toEqual(grant);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).request.backgroundTasksVersion).toBe(1);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).request).not.toHaveProperty("backgroundTasksVersion");
    const ambiguous=vi.fn().mockResolvedValue(new Response("unavailable",{status:503}));
    await expect(requestCloudAgentExecution(authority,{kind:"admit",admission,backgroundTasksVersion:1},new AbortController().signal,ambiguous)).rejects.toThrow();
    expect(ambiguous).toHaveBeenCalledOnce();
  });
  it("never restores tasks from another lease or conversation",async()=>{
    const request={kind:"background" as const,leaseId:randomUUID(),operation:{kind:"read" as const,conversationId:"chat"}};
    const state={version:1,leaseId:request.leaseId,conversationId:"chat",phase:"background",deadline:new Date(Date.now()+60_000).toISOString(),revision:1,
      snapshot:{tasks:[],waiting:false,processWork:true}};
    for(const changed of [{...state,leaseId:randomUUID()},{...state,conversationId:"another"},{...state,snapshot:{...state.snapshot,material:grant.material}}]){
      const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({result:changed})));
      await expect(requestCloudAgentExecution(authority,request,new AbortController().signal,fetcher)).rejects.toThrow();
    }
  });
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
    expect(requestFetch.mock.calls[0]![1]).toMatchObject({redirect:"error"});
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
