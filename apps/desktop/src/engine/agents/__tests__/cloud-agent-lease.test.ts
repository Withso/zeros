import {randomUUID} from "node:crypto";
import {afterEach,describe,expect,it,vi} from "vitest";
import {CloudAgentLease} from "../cloud-agent-lease";
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
  it("consumes material once and retires both domains on consent loss",async()=>{
    vi.useFakeTimers();const f=fixture(),lease=await CloudAgentLease.admit(admission,f.request,new AbortController().signal,{onRetirementFailure:vi.fn()},f.time);
    const coordinator={stopAndProve:vi.fn().mockResolvedValue(undefined)},workload={stopAndProve:vi.fn().mockResolvedValue(undefined)};
    lease.attach(coordinator);lease.attach(workload);expect(lease.takeMaterial()).toEqual(f.grant.material);expect(()=>lease.takeMaterial()).toThrow(/already consumed/);
    f.request.mockRejectedValueOnce(new Error("raw credential failure"));await expect(lease.validate()).rejects.toThrow("authority changed");
    expect(lease.signal.aborted).toBe(true);expect(coordinator.stopAndProve).toHaveBeenCalledOnce();expect(workload.stopAndProve).toHaveBeenCalledOnce();expect(()=>lease.assertLive()).toThrow(/retired/);
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
