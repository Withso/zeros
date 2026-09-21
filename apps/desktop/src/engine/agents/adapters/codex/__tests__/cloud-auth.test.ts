import {describe,it,expect,vi,afterEach} from "vitest";
import {randomUUID} from "node:crypto";
import {CloudAgentLease} from "../../../cloud-agent-lease";
import {CloudCodexAuth} from "../cloud-auth";
function fixture(){
  const material={kind:"codex-chatgpt" as const,accessToken:"synthetic-native-access-token",accountId:"synthetic-account",expiresAt:Date.now()/1000+3600};
  const lease={codexAuth:vi.fn(()=>({material,credentialVersion:1})),refreshCodex:vi.fn(async()=>({material:{...material,accessToken:"synthetic-rotated-access-token"},credentialVersion:2})),close:vi.fn(async()=>{}),assertLive:vi.fn()};
  return {lease,auth:new CloudCodexAuth(lease)};
}
describe("private native Codex refresh callback",()=>{
  it("tracks the native access epoch and returns an explicit nullable plan without replaying any model operation",async()=>{
    const {auth,lease}=fixture();expect(auth.login()).toMatchObject({type:"chatgptAuthTokens",chatgptAccountId:"synthetic-account"});
    expect(await auth.refresh({reason:"unauthorized",previousAccountId:"synthetic-account"})).toEqual({accessToken:"synthetic-rotated-access-token",chatgptAccountId:"synthetic-account",chatgptPlanType:null});
    expect(lease.refreshCodex).toHaveBeenCalledWith(1,"synthetic-account");
    lease.refreshCodex.mockResolvedValueOnce({material:{...lease.codexAuth()!.material,accessToken:"synthetic-next-access-token"},credentialVersion:3});
    await auth.refresh({reason:"unauthorized",previousAccountId:null});expect(lease.refreshCodex).toHaveBeenLastCalledWith(2,null);expect(lease.close).not.toHaveBeenCalled();
  });
  it("preserves a partial native rotation in the lease but never returns the access token native just rejected",async()=>{
    const {auth,lease}=fixture();const login=auth.login()!;
    lease.refreshCodex.mockResolvedValueOnce({material:{...lease.codexAuth()!.material,accessToken:login.accessToken},credentialVersion:2});
    await expect(auth.refresh({reason:"unauthorized",previousAccountId:login.chatgptAccountId})).rejects.toThrow("Cloud provider credentials require renewal");
    expect(lease.close).toHaveBeenCalledOnce();
  });
  it("retires on a refresh failure and never reflects token-bearing errors",async()=>{
    const {auth,lease}=fixture();auth.login();lease.refreshCodex.mockRejectedValueOnce(new Error("private-refresh-token-sentinel"));
    await expect(auth.refresh({reason:"unauthorized"})).rejects.toThrow("Cloud provider credentials require renewal");expect(lease.close).toHaveBeenCalledOnce();
  });
  it("rejects refresh before a native login",async()=>{
    const {auth,lease}=fixture();await expect(auth.refresh({reason:"unauthorized"})).rejects.toThrow();expect(lease.refreshCodex).not.toHaveBeenCalled();
  });
});

afterEach(()=>vi.useRealTimers());
async function actualLease(){
  const origin=Date.now(),admission={executionId:randomUUID(),delegationId:randomUUID(),provider:"codex" as const,model:"gpt-5.6-sol",source:{kind:"session" as const,actorSessionId:randomUUID()}};
  const material={kind:"codex-chatgpt" as const,accessToken:"synthetic-native-access-token",accountId:"synthetic-account",expiresAt:Math.floor(origin/1000)+3600};
  const grant={leaseId:randomUUID(),authorityId:"a".repeat(64),expiresAt:new Date(origin+45000).toISOString(),credentialVersion:1,credentialKind:material.kind,provider:admission.provider,model:admission.model,material};
  const request=vi.fn(async(input:{kind:string}):Promise<unknown>=>input.kind==="admit"?grant:{released:true});
  const lease=await CloudAgentLease.admit(admission,request,new AbortController().signal,{onRetirementFailure:vi.fn()},{wall:()=>Date.now(),monotonic:()=>Date.now()-origin});
  const auth=new CloudCodexAuth(lease);auth.login();
  const rotation=(token="synthetic-refreshed-access-token")=>({leaseId:grant.leaseId,expiresAt:grant.expiresAt,credentialVersion:2,rotation:{authorityId:grant.authorityId,material:{...material,accessToken:token}}});
  return {lease,auth,request,rotation,material};
}
describe("native callback with real execution lease",()=>{
  it("refuses partial access even when proactive validation already adopted its cache epoch",async()=>{
    vi.useFakeTimers();const f=await actualLease();f.request.mockResolvedValueOnce(f.rotation(f.material.accessToken));await f.lease.validate(true);
    f.request.mockResolvedValueOnce(f.rotation(f.material.accessToken));await expect(f.auth.refresh({reason:"unauthorized"})).rejects.toThrow();expect(f.lease.signal.aborted).toBe(true);
  });
  it("rejects late callback material after Stop",async()=>{
    vi.useFakeTimers();const f=await actualLease();let resolve!:(value:unknown)=>void;
    f.request.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
    const refresh=expect(f.auth.refresh({reason:"unauthorized"})).rejects.toThrow();await vi.advanceTimersByTimeAsync(0);await f.lease.close();resolve(f.rotation());await refresh;
    expect(f.lease.signal.aborted).toBe(true);
  });
  it("returns a bounded failure within the native callback budget including queue time",async()=>{
    vi.useFakeTimers();const f=await actualLease();let finish!:(value:unknown)=>void;
    f.request.mockImplementationOnce(()=>new Promise(done=>{finish=done;}));const validation=f.lease.validate().catch(()=>{});await vi.advanceTimersByTimeAsync(0);
    let settled=false;const refresh=f.auth.refresh({reason:"unauthorized"}).catch(()=>{settled=true;});
    await vi.advanceTimersByTimeAsync(8500);const timedOut=settled;
    // Settle the fixture's deliberately non-abortable network so no synthetic
    // request survives the test, even when the RED has no callback timer yet.
    await f.lease.close();finish(f.rotation());await validation;await refresh;
    expect(timedOut).toBe(true);expect(f.lease.signal.aborted).toBe(true);
  });
  it("coalesces concurrent native callbacks onto the already advanced access version",async()=>{
    vi.useFakeTimers();const f=await actualLease();f.request.mockResolvedValue(f.rotation());
    const values=await Promise.all([f.auth.refresh({reason:"unauthorized"}),f.auth.refresh({reason:"unauthorized"})]);
    expect(values[0]).toEqual(values[1]);expect(f.lease.signal.aborted).toBe(false);await f.lease.close();
  });
});
