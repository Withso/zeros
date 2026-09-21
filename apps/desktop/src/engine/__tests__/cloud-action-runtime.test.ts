import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudActionRuntime } from "../cloud-action-runtime";
import { CloudCommandRuntimeError } from "../cloud-command-client";
import type { CloudAction, CloudActionEngineRequest, CloudActionReceipt } from "@zeros/protocol/cloud-actions";

const runtimes: CloudActionRuntime[] = [];
afterEach(() => { runtimes.splice(0).forEach(runtime => runtime.close()); vi.useRealTimers(); });
function fixture() {
  const action: CloudAction = { operationId: randomUUID(), conversationId: "chat", executionId: "execution", kind: "permission",
    requestId: randomUUID(), payload: { response: { outcome: { outcome: "cancelled" } } } };
  const claimId = randomUUID(); let saved: CloudActionReceipt | null = null;
  const request = vi.fn(async (input: CloudActionEngineRequest): Promise<unknown> => {
    if (input.kind === "begin") {
      if (saved) return { ...saved, replayed: true };
      saved = { ...action, claimId, state: "dispatching", outcome: null, turnId: null, replayed: false } as CloudActionReceipt;
      delete (saved as unknown as { payload?: unknown }).payload;
      return saved;
    }
    if (input.kind === "settle") { saved = { ...saved!, state: "settled", outcome: input.outcome, turnId: input.turnId }; return saved; }
    return saved;
  });
  const validate = vi.fn(() => true);
  const dispatch = vi.fn(async () => ({ outcome: "delivered" as const, turnId: "turn" }));
  const authorize=vi.fn(async(_action:CloudAction,_actorSessionId?:string)=>{});
  const changed = vi.fn(); const runtime = new CloudActionRuntime({ request, validate, dispatch, changed,authorize }); runtimes.push(runtime);
  return { action, runtime, request, dispatch, validate, changed,authorize };
}
describe("durable native cloud actions", () => {
  it("rejects paid actions when the acting member has lost credential delegation",async()=>{
    const f=fixture(),actorSessionId=randomUUID();f.authorize.mockRejectedValueOnce(new Error("credential grant revoked"));
    const result=await f.runtime.handle({kind:"submit",action:f.action},actorSessionId);
    expect(result).toMatchObject({outcome:"interrupted"});expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.authorize).toHaveBeenCalledWith(f.action,actorSessionId);
    await f.runtime.handle({kind:"submit",action:f.action},actorSessionId);expect(f.authorize).toHaveBeenCalledOnce();
  });
  it("does not deliver after Stop while the credential authorization is in flight",async()=>{
    const f=fixture();f.authorize.mockImplementation(async()=>{f.validate.mockReturnValue(false);});
    expect(await f.runtime.handle({kind:"submit",action:f.action},randomUUID())).toMatchObject({outcome:"interrupted"});
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("does not join another actor's in-flight decision and forwards trusted session authority",async()=>{
    const f=fixture(),actorSessionId=randomUUID();
    const one=f.runtime.handle({kind:"submit",action:f.action},actorSessionId);
    await expect(f.runtime.handle({kind:"submit",action:f.action},randomUUID())).rejects.toMatchObject({code:"command_conflict"});
    await one;
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({kind:"begin"}),actorSessionId);
    expect(f.request.mock.calls.filter(([r])=>r.kind==="settle")[0]).toHaveLength(1);
  });
  it("binds steering deduplication to the durable user message identity", async () => {
    const f = fixture();
    await expect(f.runtime.handle({ kind: "submit", action: { ...f.action, kind: "steer", requestId: "different",
      payload: { agentId: "claude", turnId: "turn", userMessageId: "message", prompt: [{ type: "text", text: "fixture" }] } } }))
      .rejects.toMatchObject({ code: "invalid_command" });
    expect(f.request).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("joins identical concurrent device retries and retains the terminal receipt", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.runtime.handle({ kind: "submit", action: f.action }), f.runtime.handle({ kind: "submit", action: f.action })]);
    expect(a).toMatchObject({ state: "settled", outcome: "delivered" }); expect(b).toEqual(a);
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.map(([r]) => r.kind)).toEqual(["begin", "settle"]);
    expect(await f.runtime.handle({ kind: "submit", action: f.action })).toMatchObject({ replayed: true, outcome: "delivered" });
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("does not join a changed answer using the same identity", async () => {
    const f = fixture(); const one = f.runtime.handle({ kind: "submit", action: f.action });
    await expect(f.runtime.handle({ kind: "submit", action: { ...f.action, payload: { response: { outcome: { outcome: "selected", optionId: "allow" } } } } })).rejects.toMatchObject({ code: "command_conflict" });
    await one; expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("never dispatches after a lost begin acknowledgement", async () => {
    const f = fixture(), original = f.request.getMockImplementation()!;
    f.request.mockImplementationOnce(async input => { await original(input); throw new CloudCommandRuntimeError("command_service_unavailable"); });
    await expect(f.runtime.handle({ kind: "submit", action: f.action })).rejects.toThrow("command_service_unavailable");
    expect(await f.runtime.handle({ kind: "submit", action: f.action })).toMatchObject({ state: "settled", outcome: "interrupted" });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("rechecks a resolver that expires while admission is in flight", async () => {
    const f = fixture(); f.validate.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await f.runtime.handle({ kind: "submit", action: f.action })).toMatchObject({ outcome: "interrupted" });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("retries terminal persistence autonomously without invoking the native callback twice", async () => {
    vi.useFakeTimers(); const f = fixture(), original = f.request.getMockImplementation()!;
    let failed = false;
    f.request.mockImplementation(async input => {
      if (input.kind === "settle" && !failed) { failed = true; throw new CloudCommandRuntimeError("command_service_unavailable"); }
      return original(input);
    });
    await expect(f.runtime.handle({ kind: "submit", action: f.action })).rejects.toThrow("command_service_unavailable");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await f.runtime.handle({ kind: "read", operationId: f.action.operationId })).toMatchObject({ state: "settled", outcome: "delivered" });
    expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.request.mock.calls.filter(([r]) => r.kind === "settle")).toHaveLength(2);
  });
  it("does not dispatch after authority has been closed", async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementationOnce(async input => { const result = await original(input); f.runtime.close(); return result; });
    await expect(f.runtime.handle({ kind: "submit", action: f.action })).rejects.toThrow("engine_authority_rejected");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("rejects client-provided claims and malformed permission choices", async () => {
    const f = fixture();
    await expect(f.runtime.handle({ kind: "settle", operationId: f.action.operationId, outcome: "delivered" })).rejects.toMatchObject({ code: "invalid_command" });
    await expect(f.runtime.handle({ kind: "submit", action: { ...f.action, payload: { response: { outcome: { outcome: "selected" } } } } })).rejects.toMatchObject({ code: "invalid_command" });
    expect(f.request).not.toHaveBeenCalled();
  });
});
