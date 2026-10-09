import {randomUUID} from "node:crypto";
import {afterEach,describe,expect,it,vi} from "vitest";
import {CloudAgentLease} from "../cloud-agent-lease";
import { cloudMcpDigest } from "../cloud-mcp";
const admission={executionId:randomUUID(),delegationId:randomUUID(),provider:"cursor" as const,model:"grok-4.6",source:{kind:"session" as const,actorSessionId:randomUUID()}};
function fixture(){
  const origin=Date.parse("2026-01-01T00:00:00Z");let elapsed=0;
  const grant={leaseId:randomUUID(),authorityId:"a".repeat(64),expiresAt:new Date(origin+45_000).toISOString(),credentialVersion:1,
    credentialKind:"cursor-api-key",provider:"cursor",model:"grok-4.6",material:{kind:"cursor-api-key",apiKey:"synthetic-private-provider-key"}};
  const request=vi.fn().mockImplementation(async input=>input.kind==="admit"?grant:input.kind==="release"?{released:true}:
    {leaseId:grant.leaseId,expiresAt:new Date(origin+elapsed+45_000).toISOString(),credentialVersion:1});
  return {grant,request,time:{wall:()=>origin+elapsed,monotonic:()=>elapsed},advance:(ms:number)=>{elapsed+=ms;}};
}
afterEach(()=>vi.useRealTimers());
describe("private agent execution lifetime",()=>{
  it.each([null,{model:"foreign-model"}])("keeps malformed admission authority typed (%j)",async change=>{
    const f=fixture();f.request.mockResolvedValueOnce(change?{...f.grant,...change}:null);
    await expect(CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time)).rejects.toMatchObject({code:"cloud_admission_authority_response_invalid"});
  });
  it("gives an unavailable admission authority a safe typed cause",async()=>{
    const f=fixture();f.request.mockRejectedValueOnce(new Error("private transport details"));
    await expect(CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time)).rejects.toMatchObject({code:"cloud_admission_authority_unavailable",message:"Cloud agent admission failed"});
  });
  it("keeps required customization and changed repository echo typed",async()=>{
    const f=fixture(),requested={...admission,customization:{version:1 as const,repositoryServers:[]}};
    await expect(CloudAgentLease.admit(requested,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time)).rejects.toMatchObject({code:"cloud_admission_customization_changed"});
    const content={version:1 as const,repositoryDigest:"b".repeat(64),servers:[{scope:"repository" as const,secretRef:null,revision:0,server:{name:"foreign",transport:"stdio" as const,command:"node"}}],skills:[],cursorTeamSettings:"disabled" as const};
    f.request.mockResolvedValueOnce({...f.grant,customization:{...content,digest:cloudMcpDigest(content)}});
    await expect(CloudAgentLease.admit(requested,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time)).rejects.toMatchObject({code:"cloud_admission_customization_changed"});
    const empty={...content,servers:[]};f.request.mockResolvedValueOnce({...f.grant,customization:{...empty,digest:"0".repeat(64)}});
    await expect(CloudAgentLease.admit(requested,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time)).rejects.toMatchObject({code:"cloud_admission_authority_response_invalid"});
  });
  it.each(["true",1,false])("rejects a non-boolean release proof (%j) and retries",async released=>{
    vi.useFakeTimers();const f=fixture(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    f.request.mockResolvedValueOnce({released});
    await expect(lease.close()).rejects.toMatchObject({code:"cloud_validation_authority_response_invalid"});
    await lease.close();expect(f.request.mock.calls.filter(([input])=>input.kind==="release")).toHaveLength(2);
  });
  it("keeps the safe typed retirement cause when repeated failures escalate",async()=>{
    vi.useFakeTimers();const f=fixture(),fatal=vi.fn(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:fatal},f.time);
    lease.attach({stopAndProve:async()=>{throw Object.assign(new Error("private proof details"),{code:"cloud_containment_canary_failed"});}});
    await expect(lease.close()).rejects.toMatchObject({code:"cloud_containment_canary_failed"});
    await vi.advanceTimersByTimeAsync(2000);
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({code:"cloud_containment_canary_failed"}));
    expect(fatal.mock.calls[0]![0].message).not.toContain("private");
  });
  it("keeps a typed release failure and does not claim capacity was released before retry succeeds",async()=>{
    vi.useFakeTimers();const f=fixture(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    f.request.mockRejectedValueOnce(Object.assign(new Error("private release error"),{code:"cloud_validation_authority_http_5xx"}));
    await expect(lease.close()).rejects.toMatchObject({code:"cloud_validation_authority_http_5xx"});
    expect(lease.signal.aborted).toBe(true);
    await lease.close();expect(f.request.mock.calls.filter(([input])=>input.kind==="release")).toHaveLength(2);
  });
  it.each([false,true])("preserves typed validation causes during cleanup (renew=%s)",async renew=>{
    vi.useFakeTimers();
    for(const code of ["cloud_validation_authority_unavailable","cloud_validation_authority_timeout","cloud_validation_authority_http_4xx","cloud_validation_authority_http_5xx","cloud_validation_rate_limited","cloud_provider_start_credential_refresh_rejected","cloud_agent_credential_revoked","cloud_agent_credential_expired"]){
      const f=fixture(),fatal=vi.fn(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:fatal},f.time);
      const domain={stopAndProve:vi.fn().mockRejectedValue(new Error("private retirement diagnostic"))};lease.attach(domain);
      f.request.mockRejectedValueOnce(Object.assign(new Error("private authority diagnostic"),{code}));
      await expect(lease.validate(renew)).rejects.toMatchObject({code});
      expect(lease.signal.aborted).toBe(true);expect(domain.stopAndProve).toHaveBeenCalledOnce();
      expect(()=>lease.assertLive()).toThrow(expect.objectContaining({code}));
      await vi.advanceTimersByTimeAsync(2000);expect(fatal).toHaveBeenCalledOnce();
    }
  });
  it("reports an expired monotonic lease explicitly and never renews it",async()=>{
    vi.useFakeTimers();const f=fixture(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    f.advance(44_000);
    expect(()=>lease.assertLive()).toThrow(expect.objectContaining({code:"cloud_validation_lease_expired"}));
    await expect(lease.validate(true)).rejects.toMatchObject({code:"cloud_validation_lease_expired"});
    expect(f.request.mock.calls.some(([input])=>input.kind==="validate")).toBe(false);
    await lease.close();
  });
  it("keeps a renewal expiry failure typed after retiring its domain",async()=>{
    vi.useFakeTimers();const f=fixture(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    const domain={stopAndProve:vi.fn().mockResolvedValue(undefined)};lease.attach(domain);
    f.request.mockResolvedValueOnce({leaseId:f.grant.leaseId,expiresAt:new Date(f.time.wall()-1).toISOString(),credentialVersion:1});
    await expect(lease.validate(true)).rejects.toMatchObject({code:"cloud_validation_lease_expired"});
    expect(domain.stopAndProve).toHaveBeenCalledOnce();
  });
  it("accepts a basic turn only when customization was explicitly optional", async () => {
    vi.useFakeTimers(); const f = fixture();
    const lease = await CloudAgentLease.admit({ ...admission, customization: { version: 3, repositoryServers: [] } },
      f.request, new AbortController().signal, { onRetirementFailure: vi.fn() }, f.time);
    expect(lease.customization).toBeNull();
    expect(lease.nativeCapabilities).toBeNull();
    await lease.close();
    for (const version of [1, 2] as const) {
      await expect(CloudAgentLease.admit({ ...admission, customization: { version, repositoryServers: [] } },
        f.request, new AbortController().signal, { onRetirementFailure: vi.fn() }, f.time)).rejects.toThrow("customization admission is unavailable");
    }
  });
  it("freezes actor environment and retires the process when consent changes", async () => {
    vi.useFakeTimers(); const f=fixture();
    const environment={version:1,revision:"b".repeat(64),values:{ORG_SECRET:"synthetic-org-value"},
      history:{owner:"c".repeat(64),currentKeyVersion:1,keys:{1:"a".repeat(43)}}};
    f.request.mockResolvedValueOnce({...f.grant,environment});
    const lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    const domain={stopAndProve:vi.fn().mockResolvedValue(undefined)}; lease.attach(domain);
    try {
      expect(lease.environment).toEqual(environment); expect(Object.isFrozen(lease.environment?.values)).toBe(true);
      environment.values.ORG_SECRET="changed-external-object";
      expect(lease.environment?.values.ORG_SECRET).toBe("synthetic-org-value");
      f.request.mockResolvedValueOnce({leaseId:f.grant.leaseId,expiresAt:f.grant.expiresAt,credentialVersion:1,environmentRevision:"b".repeat(64)});
      await lease.validate();
      f.request.mockResolvedValueOnce({leaseId:f.grant.leaseId,expiresAt:f.grant.expiresAt,credentialVersion:1,environmentRevision:"d".repeat(64)});
      await expect(lease.validate(true)).rejects.toThrow("authority changed");
      expect(domain.stopAndProve).toHaveBeenCalledOnce();
    } finally {await lease.close();}
  });
  it("pins a private customization snapshot and rejects absent or inconsistent admission", async () => {
    vi.useFakeTimers(); const f=fixture(), request={...admission,customization:{version:1 as const,repositoryServers:[]}};
    const content={version:1 as const,repositoryDigest:cloudMcpDigest([]),servers:[],skills:[{name:"test",content:"# Example"}],cursorTeamSettings:"disabled" as const};
    const customization={...content,digest:cloudMcpDigest(content)};
    f.request.mockResolvedValueOnce({...f.grant,customization});
    const lease=await CloudAgentLease.admit(request,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    try {
      expect(lease.customization).toEqual(customization);
      expect(Object.isFrozen(lease.customization)).toBe(true);
      expect(Object.isFrozen(lease.customization?.skills[0])).toBe(true);
    } finally {await lease.close();}
    for(const value of [undefined,{...customization,digest:"0".repeat(64)},{...customization,repositoryDigest:"0".repeat(64)}]) {
      f.request.mockResolvedValueOnce({...f.grant,...(value?{customization:value}:{})});
      await expect(CloudAgentLease.admit(request,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time)).rejects.toThrow(/customization/);
    }
  });
  it("takes a private immutable author snapshot from the backend for each execution", async () => {
    vi.useFakeTimers(); const f = fixture();
    const author = { name: "Member", email: "1234+member@users.noreply.github.com" };
    f.request.mockResolvedValueOnce({ ...f.grant, gitAuthor: author });
    const lease = await CloudAgentLease.admit(admission, f.request, new AbortController().signal, { onRetirementFailure: vi.fn() }, f.time);
    try {
      expect(f.request).toHaveBeenCalledWith({ kind: "admit", admission, includeGitAuthor: true,nativeCapabilitiesVersion:1,backgroundTasksVersion:1,computerToolsVersion:1,environmentVersion:1 }, expect.any(AbortSignal));
      expect(lease.gitAuthor).toEqual(author);
      author.name = "Changed outside the lease";
      expect(lease.gitAuthor?.name).toBe("Member"); expect(Object.isFrozen(lease.gitAuthor)).toBe(true);
    } finally { await lease.close(); }
  });
  it("consumes material once and retires both domains on consent loss",async()=>{
    vi.useFakeTimers();const f=fixture(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    const coordinator={stopAndProve:vi.fn().mockResolvedValue(undefined)},workload={stopAndProve:vi.fn().mockResolvedValue(undefined)};
    lease.attach(coordinator);lease.attach(workload);expect(lease.takeMaterial()).toEqual(f.grant.material);expect(()=>lease.takeMaterial()).toThrow(/already consumed/);
    f.request.mockRejectedValueOnce(new Error("raw credential failure"));await expect(lease.validate()).rejects.toThrow("authority changed");
    expect(lease.signal.aborted).toBe(true);expect(coordinator.stopAndProve).toHaveBeenCalledOnce();expect(workload.stopAndProve).toHaveBeenCalledOnce();expect(()=>lease.assertLive()).toThrow(expect.objectContaining({code:"cloud_validation_authority_unavailable"}));
  });
  it("cancels a hung renewal at the monotonic deadline and never revives it",async()=>{
    vi.useFakeTimers();const f=fixture(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time),domain={stopAndProve:vi.fn().mockResolvedValue(undefined)};
    lease.attach(domain);let resolve!:(value:unknown)=>void;
    f.request.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    f.advance(20_000);await vi.advanceTimersByTimeAsync(20_000);expect(lease.signal.aborted).toBe(false);
    f.advance(24_000);await vi.advanceTimersByTimeAsync(24_000);expect(lease.signal.aborted).toBe(true);expect(domain.stopAndProve).toHaveBeenCalledOnce();
    resolve({leaseId:f.grant.leaseId,expiresAt:new Date(f.time.wall()+45_000).toISOString(),credentialVersion:1});await vi.advanceTimersByTimeAsync(0);
    expect(()=>lease.assertLive()).toThrow(/retired/);
  });
  it("rejects a changed credential version and permits retrying failed complete-tree cleanup",async()=>{
    vi.useFakeTimers();const f=fixture(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time),domain={stopAndProve:vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined)};
    lease.attach(domain);f.request.mockResolvedValueOnce({leaseId:f.grant.leaseId,expiresAt:f.grant.expiresAt,credentialVersion:2});
    await expect(lease.validate(true)).rejects.toThrow(/authority changed/);expect(lease.signal.aborted).toBe(true);
    await lease.close();expect(domain.stopAndProve).toHaveBeenCalledTimes(2);
  });
  it("retires a late process attached while the control-plane release is in flight",async()=>{
    vi.useFakeTimers();const f=fixture(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    let released!:(value:unknown)=>void;f.request.mockImplementationOnce(()=>new Promise(resolve=>{released=resolve;}));
    const closing=lease.close(),domain={stopAndProve:vi.fn().mockResolvedValue(undefined)};
    await vi.advanceTimersByTimeAsync(0);expect(()=>lease.attach(domain)).toThrow(/retired/);released({released:true});await closing;
    expect(domain.stopAndProve).toHaveBeenCalled();
  });
  it("retries automatic retirement without releasing capacity while a process is alive",async()=>{
    vi.useFakeTimers();const f=fixture(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    const domain={stopAndProve:vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined)};lease.attach(domain);
    f.request.mockImplementationOnce(()=>new Promise(()=>{}));
    f.advance(20_000);await vi.advanceTimersByTimeAsync(20_000);f.advance(24_000);await vi.advanceTimersByTimeAsync(24_000);
    expect(domain.stopAndProve).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.filter(([input])=>input.kind==="release")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(domain.stopAndProve).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls.filter(([input])=>input.kind==="release")).toHaveLength(1);
  });

  it("escalates a hung process retirement to the worker supervisor",async()=>{
    vi.useFakeTimers();const f=fixture(),fatal=vi.fn(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:fatal},f.time);
    lease.attach({stopAndProve:()=>new Promise(()=>{})});
    const closing=lease.close().catch(()=>{});
    await vi.advanceTimersByTimeAsync(17_000);await closing;
    expect(fatal).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.filter(([input])=>input.kind==="release")).toHaveLength(0);
  });
  it("reserves cleanup before asynchronous launch and keeps disconnect separate from Stop",async()=>{
    vi.useFakeTimers();const f=fixture(),admissionSignal=new AbortController(),lease=await CloudAgentLease.admit(admission,f.request,admissionSignal.signal,{onRetirementFailure:vi.fn()},f.time);
    admissionSignal.abort();expect(lease.signal.aborted).toBe(false);
    let finish!:(domain:{stopAndProve():Promise<void>})=>void;
    const launch=lease.launch(()=>new Promise<{stopAndProve():Promise<void>}>(resolve=>{finish=resolve;}));
    const rejected=expect(launch).rejects.toThrow(/retired/);await vi.advanceTimersByTimeAsync(0);
    const closing=lease.close();expect(f.request.mock.calls.filter(([input])=>input.kind==="release")).toHaveLength(0);
    const domain={stopAndProve:vi.fn().mockResolvedValue(undefined)};finish(domain);await rejected;await closing;
    expect(domain.stopAndProve).toHaveBeenCalledOnce();expect(lease.signal.aborted).toBe(true);
  });

  it("does not start a deferred launch cancelled in the same turn",async()=>{
    vi.useFakeTimers();const f=fixture(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    const spawn=vi.fn(async()=>({stopAndProve:vi.fn().mockResolvedValue(undefined)}));
    const launched=expect(lease.launch(spawn)).rejects.toThrow(/retired/),closing=lease.close();
    await launched;await closing;expect(spawn).not.toHaveBeenCalled();
  });

  it("adopts only monotonic same-authority Codex rotations and serves native refresh without another prompt",async()=>{
    vi.useFakeTimers();const f=fixture(),auth={...f.grant,credentialKind:"codex-chatgpt",provider:"codex",model:"gpt-5.6-sol",
      material:{kind:"codex-chatgpt",accessToken:"synthetic-initial-access-token",accountId:"synthetic-account",expiresAt:Math.floor(f.time.wall()/1000)+3600}};
    f.request.mockImplementation(async input=>input.kind==="admit"?auth:{released:true});
    const lease=await CloudAgentLease.admit({...admission,provider:"codex",model:"gpt-5.6-sol"},f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    lease.takeMaterial();const material={...auth.material,accessToken:"synthetic-rotated-access-token"};
    f.request.mockResolvedValueOnce({leaseId:auth.leaseId,expiresAt:auth.expiresAt,credentialVersion:2,rotation:{authorityId:auth.authorityId,material}});
    await lease.validate(true);expect(lease.credentialVersion).toBe(2);
    f.request.mockResolvedValueOnce({leaseId:auth.leaseId,expiresAt:auth.expiresAt,credentialVersion:2,rotation:{authorityId:auth.authorityId,material}});
    expect(await lease.refreshCodex(1,"synthetic-account")).toEqual({material,credentialVersion:2});
    expect(f.request).toHaveBeenLastCalledWith({kind:"refresh-codex",leaseId:auth.leaseId,credentialVersion:1},lease.signal);
    expect(f.request.mock.calls.some(([input])=>input.kind==="admit"&&input.admission.executionId!==admission.executionId)).toBe(false);
    await lease.close();
  });
  it.each(["account","authority","epoch","secret"])("retires on an invalid Codex rotation: %s",async problem=>{
    vi.useFakeTimers();const f=fixture(),auth={...f.grant,credentialKind:"codex-chatgpt",provider:"codex",model:"gpt-5.6-sol",
      material:{kind:"codex-chatgpt",accessToken:"synthetic-initial-access-token",accountId:"synthetic-account",expiresAt:Math.floor(f.time.wall()/1000)+3600}};
    f.request.mockResolvedValueOnce(auth);
    const lease=await CloudAgentLease.admit({...admission,provider:"codex",model:"gpt-5.6-sol"},f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    const material={...auth.material,accessToken:"synthetic-rotated-access-token",...(problem==="account"?{accountId:"other"}:{}),...(problem==="secret"?{refreshToken:"private-refresh-sentinel"}:{})};
    f.request.mockResolvedValueOnce({leaseId:auth.leaseId,expiresAt:auth.expiresAt,credentialVersion:problem==="epoch"?1:2,
      rotation:{authorityId:problem==="authority"?"b".repeat(64):auth.authorityId,material}});
    await expect(lease.validate()).rejects.toThrow(/authority changed/);expect(lease.signal.aborted).toBe(true);
  });

});
