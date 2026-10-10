import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCloudCommandRoutes, CLOUD_COMMAND_PATH } from "./command-routes.js";
import { CloudCommandError, type DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";

function fixture() {
  const service = { snapshot: vi.fn().mockResolvedValue({ revision: 0 }), mutate: vi.fn(),
    claim: vi.fn(), settle: vi.fn(), stop: vi.fn(), read: vi.fn(),confirmGoal:vi.fn() };
  const app = createCloudCommandRoutes(service as unknown as DatabaseCloudWorkspaceCommandService);
  const scope = { workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
  const token = "zwh_" + "x".repeat(43);
  const call = (request: unknown, authorization = `Bearer ${token}`,native=true,claudePreferences=true) => app.request(CLOUD_COMMAND_PATH, {
    method: "POST", headers: { "content-type": "application/json", authorization,...(native?{"x-zeros-native-commands":"1"}:{}),
      ...(claudePreferences?{"x-zeros-claude-preferences":"1"}:{}) }, body: JSON.stringify({ ...scope, request }),
  });
  return { service, scope, token, call };
}
describe("cloud command routes", () => {
  it("preserves validated Claude preferences across HTTP and strips them for older workers", async () => {
    const f = fixture(), payload = { agentId: "claude", userMessageId: randomUUID(), prompt: [{ type: "text", text: "test" }], modeRevision: 0,
      model: "claude-haiku-4-5", agentCredentialGrantId: randomUUID(), claudePreferences: { autoMemoryEnabled: false, idleCompactionEnabled: true } };
    const mutation = { conversationId: "chat", operationId: randomUUID(), expectedRevision: 0, action: { kind: "enqueue", commandId: randomUUID(), payload } };
    expect((await f.call({ kind: "mutate", mutation })).status).toBe(200);
    expect(f.service.mutate).toHaveBeenCalledWith(expect.anything(), mutation, null);
    f.service.snapshot.mockResolvedValue({ revision: 1, pending: [{ payload }], receipts: [] });
    const request = { kind: "snapshot", conversationId: "chat" };
    expect(await (await f.call(request)).json()).toEqual({ result: { revision: 1, pending: [{ payload }], receipts: [] } });
    const { claudePreferences: _preferences, ...legacyPayload } = payload;
    expect(await (await f.call(request, undefined, true, false)).json()).toEqual({ result: { revision: 1, pending: [{ payload: legacyPayload }], receipts: [] } });
    f.service.claim.mockResolvedValue({ payload });
    expect(await (await f.call({ kind: "claim", conversationId: "chat", executionId: "worker" }, undefined, true, false)).json())
      .toEqual({ result: { payload: legacyPayload } });
  });
  it("keeps native receipts opaque and native claims disabled for older engines",async()=>{
    const f=fixture();f.service.snapshot.mockResolvedValue({revision:1,nativeGoal:{version:1,conversationId:"chat",revision:1,goal:null},pending:[{payload:{operation:{kind:"goal"}}}],receipts:[{result:{version:1,goal:null},payload:null}]} as never);
    const response=await f.call({kind:"snapshot",conversationId:"chat"},undefined,false);
    expect(await response.json()).toEqual({result:{revision:1,pending:[{payload:null}],receipts:[{payload:null}]}});
    await f.call({kind:"claim",conversationId:"chat",executionId:"worker"},undefined,false);
    expect(f.service.claim).toHaveBeenCalledWith(expect.anything(),"chat","worker",undefined,false);
  });
  it("admits goal confirmations only through the engine native-command capability",async()=>{
    const f=fixture(),request={kind:"confirm-goal",commandId:randomUUID(),claimId:randomUUID(),sequence:1,goal:null};
    expect((await f.call(request,undefined,false)).status).toBe(422);
    expect(f.service.confirmGoal).not.toHaveBeenCalled();
    expect((await f.call(request)).status).toBe(200);
    expect(f.service.confirmGoal).toHaveBeenCalledWith(expect.objectContaining(f.scope),request);
    expect((await f.call({...request,sequence:0})).status).toBe(422);
  });
  it("carries an actor-fenced durable native fork and rejects a self-fork", async () => {
    const f=fixture(),payload={agentId:"codex",userMessageId:randomUUID(),prompt:[{type:"text",text:""}],modeRevision:0,
      model:"qualified-model",agentCredentialGrantId:randomUUID(),
      operation:{version:1,kind:"fork",sourceConversationId:"source",strategy:"native"}};
    const mutation={conversationId:"destination",operationId:randomUUID(),expectedRevision:0,action:{kind:"fork",commandId:randomUUID(),payload}};
    expect((await f.call({kind:"mutate",mutation})).status).toBe(200);
    expect(f.service.mutate).toHaveBeenCalledWith(expect.objectContaining(f.scope),mutation,null);
    expect((await f.call({kind:"mutate",mutation:{...mutation,conversationId:"source"}})).status).toBe(422);
  });
  it("retains typed goal receipts for a reconnecting client", async () => {
    const f=fixture(),result={commandId:randomUUID(),claimId:randomUUID(),state:"succeeded",resultCode:null,result:{version:1,goal:null}};
    expect((await f.call({kind:"settle",result})).status).toBe(200);
    expect(f.service.settle).toHaveBeenCalledWith(expect.objectContaining(f.scope),result);
  });
  it("preserves the admitted effort and fast settings across the HTTP boundary",async()=>{
    const f=fixture(),payload={agentId:"codex",userMessageId:randomUUID(),prompt:[{type:"text",text:"test"}],modeRevision:0,
      model:"gpt-5.6-sol",agentCredentialGrantId:randomUUID(),effort:"high",fast:false};
    const mutation={conversationId:"chat",operationId:randomUUID(),expectedRevision:0,action:{kind:"enqueue",commandId:randomUUID(),payload}};
    const response=await f.call({kind:"mutate",mutation});expect(response.status).toBe(200);
    expect(f.service.mutate).toHaveBeenCalledWith(expect.anything(),mutation,null);
  });
  it("binds a bounded request to the heartbeat authority and never caches its prompts", async () => {
    const f = fixture();
    const r = await f.call({ kind: "snapshot", conversationId: "chat" });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ result: { revision: 0 } });
    expect(f.service.snapshot).toHaveBeenCalledWith({ ...f.scope, heartbeatToken: f.token }, "chat");
  });
  it("rejects browser authority and extra selectors before accessing the queue", async () => {
    const f = fixture();
    expect((await f.call({ kind: "snapshot", conversationId: "chat" }, "Bearer browser")).status).toBe(401);
    expect((await f.call({ kind: "snapshot", conversationId: "chat", organizationId: randomUUID() })).status).toBe(422);
    expect(f.service.snapshot).not.toHaveBeenCalled();
  });
  it("returns only stable error codes for stale authority, races and database failures", async () => {
    const f = fixture();
    for (const [error, status, code] of [
      [new CloudWorkspaceEngineAuthorityError(), 401, "engine_authority_rejected"],
      [new CloudCommandError("command_conflict", "private prompt"), 409, "command_conflict"],
      [new Error("private driver query"), 503, "command_service_unavailable"],
    ] as const) {
      f.service.snapshot.mockRejectedValueOnce(error);
      const r = await f.call({ kind: "snapshot", conversationId: "chat" });
      expect(r.status).toBe(status); expect(await r.json()).toEqual({ error: code });
    }
  });
  it("bounds oversized requests before service dispatch", async () => {
    const f = fixture();
    expect((await f.call({ kind: "snapshot", conversationId: "x".repeat(300000) })).status).toBe(413);
    expect(f.service.snapshot).not.toHaveBeenCalled();
  });
});
