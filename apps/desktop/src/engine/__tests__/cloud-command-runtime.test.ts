import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudCommandRuntime } from "../cloud-command-runtime";
import { CloudCommandRuntimeError } from "../cloud-command-client";
import type { CloudCommandEngineRequest, CloudCommandClaim, CloudCommandSnapshot, CloudCommandResult } from "@zeros/protocol/cloud-commands";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(headless?:{prepare(claim:CloudCommandClaim):Promise<void>;retire(claim:CloudCommandClaim):Promise<void>}) {
  const claim: CloudCommandClaim = { commandId: randomUUID(), claimId: randomUUID(), conversationId: "chat", executionId: "execution",
    payload: { agentId: "claude", userMessageId: randomUUID(), modeRevision: 0, prompt: [{ type: "text", text: "fixture" }] } };
  const snapshot = (revision = 1, paused = false, active = false, replayed = false): CloudCommandSnapshot => ({
    version: 1, conversationId: "chat", revision, paused, receipts: [], replayed,
    pending: active ? [{ commandId: claim.commandId, position: 1, state: "dispatching", payload: claim.payload,
      executionId: claim.executionId, generation: 1, resultCode: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }] : [],
  });
  const completion = deferred<Pick<CloudCommandResult, "state" | "resultCode">>();
  let claimed = false;
  const request = vi.fn(async (input: CloudCommandEngineRequest): Promise<unknown> => {
    if (input.kind === "claim") { if (claimed) return null; claimed = true; claim.claimId = input.claimId!; if(headless)claim.executionId=input.executionId; return claim; }
    if (input.kind === "stop") return snapshot(3, true, true);
    return snapshot();
  });
  const dependencies = { request, validate: vi.fn(), execution: vi.fn(() => "execution"),
    dispatch: vi.fn(() => completion.promise), cancel: vi.fn(async () => {}), changed: vi.fn(),...headless };
  const runtime = new CloudCommandRuntime(dependencies);
  const send = () => runtime.handle({ kind: "mutate", mutation: { conversationId: "chat", operationId: randomUUID(), expectedRevision: 0,
    action: { kind: "enqueue", commandId: claim.commandId, payload: claim.payload } } });
  const stop = () => runtime.handle({ kind: "stop", conversationId: "chat", operationId: randomUUID() });
  const read = () => runtime.handle({ kind: "snapshot", conversationId: "chat" });
  return { claim, snapshot, completion, dependencies, runtime, send, stop, read };
}
describe("engine-owned cloud command dispatch", () => {
  it("admits queued work without a live desktop session and retires before settlement",async()=>{
    const proof=deferred<void>();
    const prepare=vi.fn(async(claim:CloudCommandClaim)=>{f.dependencies.execution.mockReturnValue(claim.executionId);});
    const retire=vi.fn(()=>proof.promise);
    const f=fixture({prepare,retire});f.dependencies.execution.mockReturnValue(null as unknown as string);
    try {
      await f.send();await vi.waitFor(()=>expect(f.dependencies.dispatch).toHaveBeenCalledOnce());
      expect(prepare).toHaveBeenCalledWith(f.claim);expect(f.claim.executionId).toMatch(/^[0-9a-f-]{36}$/);
      f.completion.resolve({state:"succeeded",resultCode:null});await vi.waitFor(()=>expect(retire).toHaveBeenCalledOnce());
      expect(f.dependencies.request.mock.calls.some(([r])=>r.kind==="settle")).toBe(false);
      proof.resolve();await vi.waitFor(()=>expect(f.dependencies.request).toHaveBeenCalledWith({kind:"settle",result:expect.objectContaining({state:"succeeded"})}));
    } finally {proof.resolve();f.runtime.close();}
  });
  it("honors Stop during headless admission without starting the prompt",async()=>{
    const ready=deferred<void>();
    const prepare=vi.fn(async(claim:CloudCommandClaim)=>{await ready.promise;f.dependencies.execution.mockReturnValue(claim.executionId);});
    const retire=vi.fn(async()=>{}),f=fixture({prepare,retire});
    try {
      await f.send();await vi.waitFor(()=>expect(prepare).toHaveBeenCalledOnce());await f.stop();
      expect(f.dependencies.cancel).toHaveBeenCalledOnce();ready.resolve();
      await vi.waitFor(()=>expect(f.dependencies.request).toHaveBeenCalledWith({kind:"settle",result:expect.objectContaining({state:"cancelled"})}));
      expect(f.dependencies.dispatch).not.toHaveBeenCalled();expect(retire).toHaveBeenCalledOnce();
    } finally {ready.resolve();f.runtime.close();}
  });
  it("does not acknowledge completion or admit more work after unproven retirement",async()=>{
    const prepare=vi.fn(async(claim:CloudCommandClaim)=>{f.dependencies.execution.mockReturnValue(claim.executionId);});
    const retire=vi.fn(async()=>{throw new Error("unproven child retirement");}),f=fixture({prepare,retire});
    try {
      await f.send();await vi.waitFor(()=>expect(f.dependencies.dispatch).toHaveBeenCalledOnce());
      f.completion.resolve({state:"succeeded",resultCode:null});await vi.waitFor(()=>expect(retire).toHaveBeenCalledOnce());
      expect(f.dependencies.request.mock.calls.some(([r])=>r.kind==="settle")).toBe(false);
      await expect(f.send()).rejects.toThrow("engine_authority_rejected");
    } finally {f.runtime.close();}
  });
  it("carries trusted actor sessions only on client operations and settles rejected authority without dispatch",async()=>{
    const f=fixture(),actorSessionId=randomUUID();
    Object.assign(f.claim,{dispatchAllowed:false});
    await f.runtime.handle({kind:"snapshot",conversationId:"chat"},actorSessionId);
    expect(f.dependencies.request).toHaveBeenCalledWith({kind:"snapshot",conversationId:"chat"},actorSessionId);
    await vi.waitFor(()=>expect(f.dependencies.request).toHaveBeenCalledWith({kind:"settle",result:expect.objectContaining({state:"cancelled",resultCode:"actor_authority_revoked"})}));
    expect(f.dependencies.dispatch).not.toHaveBeenCalled();f.runtime.close();
  });
  it("does not let an explicitly unauthorized Stop cancel another collaborator's work",async()=>{
    const f=fixture(),original=f.dependencies.request.getMockImplementation()!;
    f.dependencies.request.mockImplementation(async input=>{
      if(input.kind==="stop") throw new CloudCommandRuntimeError("cloud_actor_authority_rejected");
      return original(input);
    });
    try {
      await f.send();await vi.waitFor(()=>expect(f.dependencies.dispatch).toHaveBeenCalledOnce());
      await expect(f.stop()).rejects.toThrow("cloud_actor_authority_rejected");
      expect(f.dependencies.cancel).not.toHaveBeenCalled();
      f.completion.resolve({state:"succeeded",resultCode:null});
    } finally {f.runtime.close();}
  });
  it("bounds retained claim uncertainty across repeated empty-conversation reads", async () => {
    const f = fixture();
    f.dependencies.request.mockImplementation(async input => {
      if (input.kind === "claim") throw new Error("reply lost");
      return f.snapshot();
    });
    try {
      for (let batch = 0; batch < 3; batch++) {
        for (let i = 0; i < 32; i++) f.runtime.kick(`empty-${batch}-${i}`);
        await new Promise(resolve => setImmediate(resolve));
      }
      expect(f.dependencies.request.mock.calls.filter(([r]) => r.kind === "claim")).toHaveLength(32);
      f.dependencies.request.mockImplementation(async () => null);
      f.runtime.kick("empty-0-0");
      await new Promise(resolve => setImmediate(resolve));
      f.runtime.kick("new-after-recovery");
      await new Promise(resolve => setImmediate(resolve));
      expect(f.dependencies.request).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "new-after-recovery" }));
    } finally { f.runtime.close(); }
  });
  it("recovers a lost claim reply autonomously with the same identity before dispatch", async () => {
    const f = fixture(); let attempts = 0;
    f.dependencies.request.mockImplementation(async input => {
      if (input.kind !== "claim") return f.snapshot();
      if (++attempts === 1) throw new Error("committed but reply lost");
      return attempts === 2 ? { ...f.claim, claimId: input.claimId } : null;
    });
    try {
      await f.send();
      await vi.waitFor(() => expect(f.dependencies.dispatch).toHaveBeenCalledOnce(), { timeout: 2500 });
      const claims = f.dependencies.request.mock.calls.flatMap(([r]) => r.kind === "claim" ? [r] : []);
      expect(claims).toHaveLength(2); expect(claims[0]?.claimId).toMatch(/^[0-9a-f-]{36}$/);
      expect(claims[1]).toEqual(claims[0]);
      f.completion.resolve({ state: "succeeded", resultCode: null });
      await vi.waitFor(() => expect(f.dependencies.request.mock.calls.some(([r]) => r.kind === "settle")).toBe(true));
    } finally { f.runtime.close(); }
  });
  it("reconciles a lost claim after Stop without dispatching or leaving it stuck", async () => {
    const f = fixture(); let attempts = 0;
    f.dependencies.request.mockImplementation(async input => {
      if (input.kind === "claim") { if (++attempts === 1) throw new Error("lost reply"); return { ...f.claim, claimId: input.claimId }; }
      return input.kind === "mutate" ? f.snapshot() : f.snapshot(4, true);
    });
    try {
      await f.send(); await vi.waitFor(() => expect(attempts).toBe(1));
      await f.stop();
      await vi.waitFor(() => expect(f.dependencies.request).toHaveBeenCalledWith({ kind: "settle", result: expect.objectContaining({ state: "cancelled" }) }), { timeout: 2500 });
      expect(f.dependencies.dispatch).not.toHaveBeenCalled(); expect(attempts).toBe(2);
    } finally { f.runtime.close(); }
  });
  it("resolves historical enqueue retries before consulting the current authoring mode", async () => {
    const f = fixture();
    f.dependencies.validate.mockImplementation((_conversationId: string, payload?: unknown) => { if (payload) throw new Error("mode changed since original admission"); });
    f.dependencies.request.mockImplementation(async input => input.kind === "claim" ? null : { ...f.snapshot(9), replayed: true });
    expect(await f.send()).toMatchObject({ revision: 9, replayed: true });
    expect(f.dependencies.dispatch).not.toHaveBeenCalled(); f.runtime.close();
  });
  it("acknowledges durable enqueue independently of prompt completion and settles once", async () => {
    const f = fixture();
    expect(await f.send()).toMatchObject({ revision: 1 });
    await vi.waitFor(() => expect(f.dependencies.dispatch).toHaveBeenCalledOnce());
    expect(f.dependencies.request.mock.calls.map(([x]) => x.kind)).toEqual(["mutate", "claim"]);
    f.completion.resolve({ state: "succeeded", resultCode: null });
    await vi.waitFor(() => expect(f.dependencies.request.mock.calls.some(([x]) => x.kind === "settle")).toBe(true));
    expect(f.dependencies.request).toHaveBeenCalledWith({ kind: "settle", result: { commandId: f.claim.commandId, claimId: f.claim.claimId, state: "succeeded", resultCode: null } });
    f.runtime.close();
  });
  it("does not dispatch a claim that arrives after Stop", async () => {
    const f = fixture(), claimReply = deferred<unknown>();
    f.dependencies.request.mockImplementation(async input => input.kind === "claim" ? claimReply.promise :
      input.kind === "stop" ? f.snapshot(3, true, true) : input.kind === "settle" ? f.snapshot(4, true) : f.snapshot(1));
    await f.send(); await vi.waitFor(() => expect(f.dependencies.request).toHaveBeenCalledWith(expect.objectContaining({ kind: "claim" })));
    await f.stop();
    const intent = f.dependencies.request.mock.calls.map(([r]) => r).find(r => r.kind === "claim");
    claimReply.resolve({ ...f.claim, claimId: intent?.kind === "claim" ? intent.claimId : undefined });
    await vi.waitFor(() => expect(f.dependencies.request).toHaveBeenCalledWith({ kind: "settle", result: expect.objectContaining({ state: "cancelled" }) }));
    expect(f.dependencies.dispatch).not.toHaveBeenCalled(); f.runtime.close();
  });
  it("does not replay a prompt when a settlement acknowledgement is lost", async () => {
    const f = fixture(), original = f.dependencies.request.getMockImplementation()!;
    let failures = 1;
    f.dependencies.request.mockImplementation(async input => { if (input.kind === "settle" && failures-- > 0) throw new Error("lost response"); return original(input); });
    await f.send(); await vi.waitFor(() => expect(f.dependencies.dispatch).toHaveBeenCalledOnce());
    f.completion.resolve({ state: "succeeded", resultCode: null });
    await vi.waitFor(() => expect(f.dependencies.request.mock.calls.filter(([x]) => x.kind === "settle")).toHaveLength(1));
    await new Promise(resolve => setImmediate(resolve));
    await f.read();
    await vi.waitFor(() => expect(f.dependencies.request.mock.calls.filter(([x]) => x.kind === "settle")).toHaveLength(2));
    expect(f.dependencies.dispatch).toHaveBeenCalledOnce(); f.runtime.close();
  });
  it("retries terminal receipts without requiring a connected device to kick it", async () => {
    const f = fixture(), original = f.dependencies.request.getMockImplementation()!;
    let failed = false;
    f.dependencies.request.mockImplementation(async input => {
      if (input.kind === "settle" && !failed) { failed = true; throw new Error("temporary storage outage"); }
      return original(input);
    });
    await f.send(); await vi.waitFor(() => expect(f.dependencies.dispatch).toHaveBeenCalledOnce());
    f.completion.resolve({ state: "succeeded", resultCode: null });
    try {
      await vi.waitFor(() => expect(f.dependencies.request.mock.calls.filter(([input]) => input.kind === "settle")).toHaveLength(2), { timeout: 2500 });
      expect(f.dependencies.dispatch).toHaveBeenCalledOnce();
    } finally { f.runtime.close(); }
  });
  it("checks the current mode again after the claim roundtrip", async () => {
    const f = fixture();
    f.dependencies.validate.mockImplementation((_conversationId: string, payload?: unknown) => {
      if (payload && f.dependencies.request.mock.calls.some(([x]) => x.kind === "claim")) throw new Error("mode changed");
    });
    await f.send();
    await vi.waitFor(() => expect(f.dependencies.request).toHaveBeenCalledWith({ kind: "settle", result: expect.objectContaining({ state: "failed" }) }));
    expect(f.dependencies.dispatch).not.toHaveBeenCalled(); f.runtime.close();
  });
  it("does not let replaying an old Stop cancel resumed work", async () => {
    const f = fixture(), original = f.dependencies.request.getMockImplementation()!;
    f.dependencies.request.mockImplementation(async input => input.kind === "stop" ? f.snapshot(9, false, true, true) : original(input));
    await f.send(); await vi.waitFor(() => expect(f.dependencies.dispatch).toHaveBeenCalledOnce());
    await f.stop(); expect(f.dependencies.cancel).not.toHaveBeenCalled();
    f.completion.resolve({ state: "succeeded", resultCode: null }); f.runtime.close();
  });
  it("does not accept engine dispatch operations or provider overrides from a device", async () => {
    const f = fixture();
    await expect(f.runtime.handle({ kind: "claim", conversationId: "chat", executionId: "forged" })).rejects.toMatchObject({ code: "invalid_command" });
    await expect(f.runtime.handle({ kind: "snapshot", conversationId: "chat", heartbeatToken: "forged" })).rejects.toMatchObject({ code: "invalid_command" });
    expect(f.dependencies.request).not.toHaveBeenCalled(); f.runtime.close();
  });
  it("cancels local activity when Stop cannot be acknowledged and keeps the queue blocked", async () => {
    const f = fixture(), original = f.dependencies.request.getMockImplementation()!;
    f.dependencies.request.mockImplementation(async input => { if (input.kind === "stop") throw new Error("network"); return original(input); });
    await f.send(); await vi.waitFor(() => expect(f.dependencies.dispatch).toHaveBeenCalledOnce());
    await expect(f.stop()).rejects.toThrow("network"); expect(f.dependencies.cancel).toHaveBeenCalledOnce();
    f.completion.resolve({ state: "cancelled", resultCode: "stopped_by_user" });
    await f.read(); await new Promise(resolve => setImmediate(resolve));
    expect(f.dependencies.request.mock.calls.filter(([x]) => x.kind === "claim")).toHaveLength(1); f.runtime.close();
  });
});
