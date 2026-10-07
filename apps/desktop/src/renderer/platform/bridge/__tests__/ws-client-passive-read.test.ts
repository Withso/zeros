import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "../ws-client";
import type { BridgeMessage } from "../messages";

type Internals = { ws: { readyState: number; send: (value: string) => void };
  handshakeReady: boolean; _status: string; queuedRequests: unknown[];
  handleIncoming: (message: BridgeMessage) => void; setStatus: (status: string) => void };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("passive transport requests", () => {
  it("fails disconnected reads immediately without queueing or connecting", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const client = new RuntimeClient();
    const connect = vi.spyOn(client, "connect").mockResolvedValue();
    await expect(client.requestConnected({ type: "WORKSPACE_REQUEST", op: "workspace.resourceUsage" })).rejects.toThrow(/disconnected/);
    expect(connect).not.toHaveBeenCalled(); expect((client as unknown as Internals).queuedRequests).toEqual([]);
    client.dispose();
  });
  it("sends to the connected socket, captures bounded capabilities and drops them on disconnect", async () => {
    vi.stubGlobal("window", globalThis); vi.stubGlobal("WebSocket", { OPEN: 1 });
    const client = new RuntimeClient();
    const state = client as unknown as Internals;
    const send = vi.fn((value: string) => {
      const request = JSON.parse(value);
      state.handleIncoming({ type: "WORKSPACE_RESPONSE", requestId: request.id, op: request.op,
        result: { confirmed: true } } as unknown as BridgeMessage);
    });
    Object.assign(state, { ws: { readyState: 1, send, close: () => {} }, handshakeReady: true, _status: "connected" });
    state.handleIncoming({ type: "ENGINE_READY", capabilities: ["workspace.resourceUsage.v1"] } as unknown as BridgeMessage);
    expect(client.supportsEngineCapability("workspace.resourceUsage.v1")).toBe(true);
    expect(await client.requestConnected({ type: "WORKSPACE_REQUEST", op: "workspace.resourceUsage" })).toMatchObject({ result: { confirmed: true } });
    expect(send).toHaveBeenCalledOnce();
    state.ws.readyState = 3;
    await expect(client.requestConnected({ type: "WORKSPACE_REQUEST" })).rejects.toThrow(/disconnected/);
    state.setStatus("disconnected");
    expect(client.supportsEngineCapability("workspace.resourceUsage.v1")).toBe(false);
    expect(state.queuedRequests).toEqual([]); client.dispose();
  });
});
