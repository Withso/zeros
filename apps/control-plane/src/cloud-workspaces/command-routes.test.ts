import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCloudCommandRoutes, CLOUD_COMMAND_PATH } from "./command-routes.js";
import { CloudCommandError, type DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { CloudWorkspaceEngineAuthorityError } from "./engine-authority.js";

function fixture() {
  const service = { snapshot: vi.fn().mockResolvedValue({ revision: 0 }), mutate: vi.fn(),
    claim: vi.fn(), settle: vi.fn(), stop: vi.fn(), read: vi.fn() };
  const app = createCloudCommandRoutes(service as unknown as DatabaseCloudWorkspaceCommandService);
  const scope = { workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
  const token = "zwh_" + "x".repeat(43);
  const call = (request: unknown, authorization = `Bearer ${token}`) => app.request(CLOUD_COMMAND_PATH, {
    method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ ...scope, request }),
  });
  return { service, scope, token, call };
}
describe("cloud command routes", () => {
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
