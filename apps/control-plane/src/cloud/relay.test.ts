import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_V2_BRIDGE_PROTOCOL, CloudV2Relay, type CloudV2RelayDeps } from "./relay.js";
import type { CloudV2Workspace } from "./store.js";
import { newCloudV2Token } from "./tokens.js";

const workspaceId = "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";
const workerToken = newCloudV2Token("worker").token;
const ticket = newCloudV2Token("connect").token;
const capabilities = { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] };

function workspace(state: CloudV2Workspace["state"]): CloudV2Workspace {
  return {
    id: workspaceId, organizationId: workspaceId, creatorUserId: workspaceId, name: "w", repository: "o/r", branch: "main", baseBranch: "main",
    state, boatSandboxId: "bx_1", computerBuildId: null, errorCode: null, activeAt: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    ws.once("message", data => resolve(JSON.parse(String(data))));
    ws.once("close", (code, reason) => reject(new Error(`closed ${code} ${reason}`)));
  });
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); ws.once("unexpected-response", (_req, res) => reject(new Error(`http ${res.statusCode}`))); });
}

describe("cloud v2 relay", () => {
  let server: Server;
  let relay: CloudV2Relay;
  let url: string;
  let state: CloudV2Workspace["state"];
  let deps: CloudV2RelayDeps;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    state = "running";
    deps = {
      store: {
        byWorkerToken: vi.fn(async token => token === workerToken ? workspace(state) : null),
        consumeConnectTicket: vi.fn(async (value, id) => value === ticket && id === workspaceId ? { userId: workspaceId } : null),
        get: vi.fn(async () => workspace(state)),
        transition: vi.fn(async (_id, from: readonly string[], to) => from.includes(state) ? workspace(state = to) : null),
        markActive: vi.fn(async () => {}),
        writeHistory: vi.fn(async () => {}),
      },
      config: vi.fn(async ws => ({
        t: "config" as const,
        workspace: { id: ws.id, organizationId: ws.organizationId, checkoutPath: "/home/user/o/r", repository: ws.repository, branch: ws.branch, baseBranch: "main" },
        agents: {},
      })),
      githubToken: vi.fn(async () => ({ token: "ghs_test", expiresAt: 1 })),
      wake: vi.fn(async () => {}),
      answerOffline: vi.fn(async () => null),
    };
    relay = new CloudV2Relay(deps);
    server = createServer();
    server.on("upgrade", (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    relay.close();
    await new Promise(resolve => server.close(resolve));
  });

  const worker = async () => {
    const ws = new WebSocket(`${url}/v2/cloud/worker`, { headers: { authorization: `Bearer ${workerToken}` } });
    sockets.push(ws);
    await opened(ws);
    const config = nextMessage(ws);
    ws.send(JSON.stringify({ t: "hello", protocol: 1, workerVersion: "0.1.0", capabilities }));
    expect((await config).t).toBe("config");
    return ws;
  };
  const app = async () => {
    const ws = new WebSocket(`${url}/v2/cloud/workspaces/${workspaceId}/bridge`, [CLOUD_V2_BRIDGE_PROTOCOL, `ticket.${ticket}`]);
    sockets.push(ws);
    await opened(ws);
    return ws;
  };

  it("relays app frames to the worker verbatim and worker frames back", async () => {
    const w = await worker();
    const openFrame = nextMessage(w);
    const a = await app();
    const open = await openFrame;
    expect(open).toMatchObject({ t: "open" });
    const request = { type: "WORKSPACE_REQUEST", id: "r1", op: "chats.list", params: {} };
    const forwarded = nextMessage(w);
    a.send(JSON.stringify(request));
    expect(await forwarded).toEqual({ t: "frame", clientId: open.clientId, frame: request });
    const reply = nextMessage(a);
    w.send(JSON.stringify({ t: "frame", clientId: open.clientId, frame: { type: "WORKSPACE_RESPONSE", requestId: "r1" } }));
    expect(await reply).toEqual({ type: "WORKSPACE_RESPONSE", requestId: "r1" });
  });

  it("refuses a worker without a valid token and an app without a ticket", async () => {
    const bad = new WebSocket(`${url}/v2/cloud/worker`, { headers: { authorization: "Bearer zw2w_wrong" } });
    await expect(opened(bad)).rejects.toThrow("http 401");
    const noTicket = new WebSocket(`${url}/v2/cloud/workspaces/${workspaceId}/bridge`, [CLOUD_V2_BRIDGE_PROTOCOL]);
    await expect(opened(noTicket)).rejects.toThrow("http 401");
  });

  it("wakes a stopped workspace and delivers queued frames once the worker says hello", async () => {
    state = "stopped";
    const a = await app();
    await vi.waitFor(() => expect(deps.wake).toHaveBeenCalledTimes(1));
    const prompt = { type: "AGENT_PROMPT", id: "p1" };
    a.send(JSON.stringify(prompt));
    await vi.waitFor(() => expect(deps.answerOffline).toHaveBeenCalled());
    state = "starting";
    const ws = new WebSocket(`${url}/v2/cloud/worker`, { headers: { authorization: `Bearer ${workerToken}` } });
    sockets.push(ws);
    await opened(ws);
    const frames: any[] = [];
    ws.on("message", data => frames.push(JSON.parse(String(data))));
    ws.send(JSON.stringify({ t: "hello", protocol: 1, workerVersion: "0.1.0", capabilities }));
    await vi.waitFor(() => expect(frames.map(frame => frame.t)).toEqual(["config", "open", "frame"]));
    expect(frames[2].frame).toEqual(prompt);
    expect(state).toBe("running");
  });

  it("refuses a worker whose workspace is stopped", async () => {
    state = "stopped";
    const ws = new WebSocket(`${url}/v2/cloud/worker`, { headers: { authorization: `Bearer ${workerToken}` } });
    sockets.push(ws);
    await opened(ws);
    const closed = new Promise<number>(resolve => ws.once("close", code => resolve(code)));
    ws.send(JSON.stringify({ t: "hello", protocol: 1, workerVersion: "0.1.0", capabilities }));
    expect(await closed).toBe(4001);
    expect(state).toBe("stopped");
  });

  it("answers history reads from the mirror while the worker is away", async () => {
    vi.mocked(deps.answerOffline).mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", requestId: "r2", result: { chats: [] } });
    const a = await app();
    const reply = nextMessage(a);
    a.send(JSON.stringify({ type: "WORKSPACE_REQUEST", id: "r2", op: "chats.list" }));
    expect(await reply).toMatchObject({ requestId: "r2", result: { chats: [] } });
  });

  it("mirrors history in order and answers GitHub token requests", async () => {
    const w = await worker();
    w.send(JSON.stringify({ t: "history", chats: [{ id: "c1" }] }));
    w.send(JSON.stringify({ t: "history", chatDeletions: ["c0"] }));
    await vi.waitFor(() => expect(deps.store.writeHistory).toHaveBeenCalledTimes(2));
    expect(vi.mocked(deps.store.writeHistory).mock.calls.map(call => call[1])).toEqual([{ chats: [{ id: "c1" }] }, { chatDeletions: ["c0"] }]);
    const reply = nextMessage(w);
    w.send(JSON.stringify({ t: "request", id: workspaceId, kind: "github-token" }));
    expect(await reply).toEqual({ t: "reply", id: workspaceId, token: "ghs_test", expiresAt: 1 });
  });

  it("closes a worker that sends anything before hello or an unknown frame", async () => {
    const ws = new WebSocket(`${url}/v2/cloud/worker`, { headers: { authorization: `Bearer ${workerToken}` } });
    sockets.push(ws);
    await opened(ws);
    const closed = new Promise<number>(resolve => ws.once("close", code => resolve(code)));
    ws.send(JSON.stringify({ t: "idle", idle: true }));
    expect(await closed).toBe(4003);
  });
});
