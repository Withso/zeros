import { describe,expect,it,vi } from "vitest";
import { CloudRuntimeQuietState } from "../cloud-runtime-quiet-state";

const scope={workspaceId:"11111111-1111-4111-8111-111111111111",organizationId:"22222222-2222-4222-8222-222222222222",
  generation:1,engineInstanceId:"33333333-3333-4333-8333-333333333333"};
const challenge="44444444-4444-4444-8444-444444444444";
function fixture(){
  const activity={revision:3,quietForMs:60_000,recordSync:"ready" as const};
  const options={cloud:()=>true,scope:()=>scope,activity:()=>activity,busy:()=>false,livePty:()=>false,
    presence:()=>"absent" as const,inspectUserProcesses:vi.fn(async()=>false)};
  return {activity,options,reader:new CloudRuntimeQuietState(options)};
}
describe("read-only cloud runtime quiet state",()=>{
  it("returns scoped guards and activity evidence without changing work",async()=>{
    const f=fixture();
    expect(await f.reader.snapshot(challenge)).toEqual({version:1,challenge,...scope,
      activityRevision:3,quietForMs:60_000,stable:true,recordSync:"ready",workloadBusy:false,livePty:false,userProcesses:"idle",presence:"absent"});
    expect(f.activity.revision).toBe(3);
    expect(f.options.inspectUserProcesses).toHaveBeenCalledOnce();
  });
  it("does not inspect Local or organization-owned local engines",async()=>{
    const f=fixture();f.options.cloud=()=>false;
    expect(await f.reader.snapshot(challenge)).toBeNull();
    expect(f.options.inspectUserProcesses).not.toHaveBeenCalled();
  });
  it("reports a race during process inspection instead of admitting a stale revision",async()=>{
    const f=fixture();f.options.inspectUserProcesses.mockImplementation(async()=>{f.activity.revision++;return false;});
    expect(await f.reader.snapshot(challenge)).toMatchObject({stable:false,activityRevision:4});
  });
  it("closes unknown process inspection and changed engine identity",async()=>{
    const f=fixture();f.options.inspectUserProcesses.mockRejectedValueOnce(new Error("private diagnostics"));
    expect(await f.reader.snapshot(challenge)).toMatchObject({userProcesses:"unknown"});
    f.options.inspectUserProcesses.mockImplementation(async()=>{f.options.scope=()=>({...scope,generation:2});return false;});
    expect(await f.reader.snapshot(challenge)).toBeNull();
  });
  it("preserves busy and live terminal guards and rejects malformed challenges",async()=>{
    const f=fixture();f.options.busy=()=>true;f.options.livePty=()=>true;
    expect(await f.reader.snapshot(challenge)).toMatchObject({workloadBusy:true,livePty:true});
    expect(await f.reader.snapshot("invalid")).toBeNull();
  });
});

describe("resident engine safe point", () => {
  const hostId = "55555555-5555-4555-8555-555555555555";
  function handoffFixture() {
    const f = fixture();
    const controls = { resident: () => ({ hostId, fence: 7 }),
      pauseClaims: vi.fn(), resumeClaims: vi.fn(), drained: () => true, busy: () => false,
      fence: vi.fn(), inspectUserProcesses: vi.fn(async () => false), seal: vi.fn(async () => {}), unseal: vi.fn() };
    const options = { ...f.options, handoff: controls };
    const reader = new CloudRuntimeQuietState(options);
    const request = { challenge, ...scope, hostId, fence: 7, expiresAtMs: Date.now() + 30_000 };
    return { ...f, options, controls, reader, request };
  }
  it("awaits the exact resident release ACK before reopening claims on cancellation", async () => {
    const f = handoffFixture();
    await f.reader.prepareHandoff(f.request);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.controls.fence.mockImplementation(enabled => enabled ? undefined : gate);
    let finished = false;
    const cancelling = f.reader.cancelHandoff(challenge).then(result => { finished = true; return result; });
    await expect.poll(() => f.controls.fence.mock.calls.some(([enabled]) => enabled === false)).toBe(true);
    expect(finished).toBe(false); expect(f.controls.resumeClaims).not.toHaveBeenCalled();
    release(); expect(await cancelling).toBe(true); expect(f.controls.resumeClaims).toHaveBeenCalledOnce();
  });
  it("retains admission and the same handoff when resident release ACK is unknown", async () => {
    const f = handoffFixture(); await f.reader.prepareHandoff(f.request);
    const failed = Promise.reject(new Error("resident release ACK unknown"));
    void failed.catch(() => undefined);
    f.controls.fence.mockImplementationOnce(() => failed);
    expect(await f.reader.cancelHandoff(challenge)).toBe(false);
    expect(f.controls.resumeClaims).not.toHaveBeenCalled();
    expect(await f.reader.cancelHandoff(challenge)).toBe(true);
    expect(f.controls.resumeClaims).toHaveBeenCalledOnce();
  });
  it("pauses new claims while an admitted turn drains, then seals only at a stable safe point", async () => {
    const f = handoffFixture(); f.controls.drained = () => false;
    expect(await f.reader.prepareHandoff(f.request)).toMatchObject({ phase: "draining" });
    expect(f.controls.pauseClaims).toHaveBeenCalledOnce();
    expect(f.controls.seal).not.toHaveBeenCalled();
    f.controls.drained = () => true;
    expect(await f.reader.prepareHandoff(f.request)).toMatchObject({ phase: "fenced", ...scope, hostId, fence: 7 });
    expect(f.controls.fence).toHaveBeenCalledWith(true);
    expect(f.controls.seal).toHaveBeenCalledOnce();
    expect(f.reader.consumeHandoff(f.request)).toBe(true);
    expect(f.reader.consumeHandoff(f.request)).toBe(true);
    expect(f.reader.consumeHandoff({ ...f.request, challenge: hostId })).toBe(false);
    expect(await f.reader.cancelHandoff(f.request.challenge)).toBe(false);
  });
  it("uses the resident workload guards while preserving the conservative quiet reader", async () => {
    const f = handoffFixture();
    const reader = new CloudRuntimeQuietState({ ...f.options, busy: () => true, livePty: () => true,
      presence: () => "present", inspectUserProcesses: async () => true, handoff: f.controls });
    expect(await reader.snapshot(challenge)).toMatchObject({ workloadBusy: true, livePty: true, presence: "present" });
    expect(await reader.prepareHandoff(f.request)).toMatchObject({ phase: "fenced" });
    expect(await reader.cancelHandoff(challenge)).toBe(true);
    expect(f.controls.unseal).toHaveBeenCalledOnce();
    expect(f.controls.resumeClaims).toHaveBeenCalledOnce();
  });
  it("drops an admission fence if activity changes during the final process inspection", async () => {
    const f = handoffFixture();
    f.controls.inspectUserProcesses.mockImplementation(async () => { f.activity.revision++; return false; });
    expect(await f.reader.prepareHandoff(f.request)).toMatchObject({ phase: "draining" });
    expect(f.controls.fence.mock.calls.map(call => call[0])).toEqual([true, false]);
    expect(f.controls.seal).not.toHaveBeenCalled();
    await f.reader.cancelHandoff(challenge);
  });
  it("denies mismatched source, host, nonce and expired requests without changing admission", async () => {
    const f = handoffFixture();
    for (const invalid of [{ generation: 2 }, { organizationId: hostId }, { hostId: challenge },
      { fence: 8 }, { challenge: "invalid" }, { expiresAtMs: Date.now() - 1 }])
      expect(await f.reader.prepareHandoff({ ...f.request, ...invalid })).toBeNull();
    expect(f.controls.pauseClaims).not.toHaveBeenCalled();
    expect(f.controls.fence).not.toHaveBeenCalled();
  });
  it("never seals unknown processes, failed record sync, or an unreachable resident", async () => {
    const f = handoffFixture();
    f.controls.inspectUserProcesses.mockRejectedValueOnce(new Error("private inspection"));
    expect(await f.reader.prepareHandoff(f.request)).toMatchObject({ phase: "draining" });
    expect(f.controls.seal).not.toHaveBeenCalled();
    await f.reader.cancelHandoff(challenge);
    const local = new CloudRuntimeQuietState({ ...f.options, cloud: () => false, handoff: f.controls });
    expect(await local.prepareHandoff(f.request)).toBeNull();
  });
  it("joins duplicate preparation and delays cancellation until sealing settles", async () => {
    const f = handoffFixture(); let finish!: () => void;
    f.controls.seal.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.reader.prepareHandoff(f.request), second = f.reader.prepareHandoff(f.request);
    await vi.waitFor(() => expect(f.controls.seal).toHaveBeenCalledOnce());
    const cancelling = f.reader.cancelHandoff(challenge);
    expect(f.controls.resumeClaims).not.toHaveBeenCalled();
    finish(); await Promise.all([first, second, cancelling]);
    expect(f.controls.unseal).toHaveBeenCalledOnce();
    expect(f.controls.resumeClaims).toHaveBeenCalledOnce();
    expect(f.reader.consumeHandoff(f.request)).toBe(false);
  });
  it("does not restore old admission when source authority changes during preparation", async () => {
    const f = handoffFixture();
    f.controls.inspectUserProcesses.mockImplementation(async () => {
      f.options.scope = () => ({ ...scope, generation: 2 }); return false;
    });
    expect(await f.reader.prepareHandoff(f.request)).toBeNull();
    expect(f.controls.resumeClaims).not.toHaveBeenCalled();
    expect(f.controls.fence.mock.calls.map(call => call[0])).toEqual([true]);
    expect(f.controls.seal).not.toHaveBeenCalled();
  });
  it("restores a partially applied admission fence if its synchronous setup fails", async () => {
    const f = handoffFixture();
    f.controls.fence.mockImplementationOnce(() => { throw new Error("busy Git broker"); });
    expect(await f.reader.prepareHandoff(f.request)).toBeNull();
    expect(f.controls.fence.mock.calls.map(call => call[0])).toEqual([true, false]);
    expect(f.controls.resumeClaims).toHaveBeenCalledOnce();
    expect(f.controls.seal).not.toHaveBeenCalled();
  });
  it("expires an unconsumed fence and resumes only after restoring the writer", async () => {
    vi.useFakeTimers();
    try {
      const f = handoffFixture(); const order: string[] = [];
      f.controls.unseal.mockImplementation(() => { order.push("writer"); });
      f.controls.resumeClaims.mockImplementation(() => { order.push("claims"); });
      await f.reader.prepareHandoff(f.request);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(order).toEqual(["writer", "claims"]);
      expect(f.reader.consumeHandoff(f.request)).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("does not fence a failed record projection or an unreachable resident", async () => {
    const f = handoffFixture();
    const lagging = new CloudRuntimeQuietState({ ...f.options, activity: () => ({ ...f.activity, recordSync: "failed" }) });
    expect(await lagging.prepareHandoff(f.request)).toMatchObject({ phase: "draining" });
    await lagging.cancelHandoff(challenge);
    const unreachable = new CloudRuntimeQuietState({ ...f.options, handoff: { ...f.controls, resident: () => null } });
    expect(await unreachable.prepareHandoff(f.request)).toBeNull();
    expect(f.controls.fence).not.toHaveBeenCalled();
    expect(f.controls.seal).not.toHaveBeenCalled();
  });
});
