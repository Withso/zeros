import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudV2Relay, type CloudV2RelayDeps } from "../../../../../../control-plane/src/cloud/relay";
import { createCloudV2Routes, type CloudV2RouteDeps } from "../../../../../../control-plane/src/cloud/routes";
import type { CloudV2Workspace } from "../../../../../../control-plane/src/cloud/store";
import { newCloudV2Token } from "../../../../../../control-plane/src/cloud/tokens";
import { RuntimeClient } from "../runtime-client";

// Hono belongs to the standalone control-plane dependency graph.
const { Hono } = createRequire(new URL("../../../../../../control-plane/package.json", import.meta.url))("hono") as {
  Hono: new () => ReturnType<typeof createCloudV2Routes>;
};
const workspaceId = "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";
const ticket = newCloudV2Token("connect").token;
const explicitWakeProtocol = "zeros.cloud.v2.explicit-wake";
let state: CloudV2Workspace["state"];
let server: Server, workerServer: WebSocketServer, relay: CloudV2Relay;
let deps: CloudV2RelayDeps;
let url: string;
const sockets: WebSocket[] = [], connectedWorkers: WebSocket[] = [];

function workspace(state: CloudV2Workspace["state"]): CloudV2Workspace {
  return {
    id: workspaceId, organizationId: workspaceId, creatorUserId: workspaceId, name: "w", repository: "o/r", branch: "main", baseBranch: "main",
    state, boatSandboxId: "bx_1", computerBuildId: null, errorCode: null, activeAt: null, archivedAt: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
}

beforeEach(async () => {
  state = "stopped";
  workerServer = new WebSocketServer({ port: 0, host: "127.0.0.1", handleProtocols: () => "zeros.cloud.v2.worker" });
  await new Promise<void>(resolve => workerServer.once("listening", resolve));
  const workerUrl = `http://127.0.0.1:${(workerServer.address() as AddressInfo).port}`;
  connectedWorkers.length = 0;
  workerServer.on("connection", (ws, request) => {
    expect(request.url).toBe("/v2/worker/bridge");
    expect(request.headers.cookie).toBe("_port_auth=synthetic-port-token");
    expect(request.headers["x-zeros-worker-auth"]).toBe("synthetic-grant");
    connectedWorkers.push(ws);
  });
  deps = {
    store: {
      consumeConnectTicket: vi.fn(async (value, id) => value === ticket && id === workspaceId
        ? { userId: workspaceId, accessEpoch: "0", wake: true, sessionId: "session-a" } : null),
      get: vi.fn(async () => workspace(state)),
      accessEpoch: vi.fn(async () => "0"),
      appAccessSnapshot: vi.fn(async (_id, sessions) => ({ accessEpoch: "0", activeSessionIds: sessions })),
      loginRevision: vi.fn(async () => "0"),
    },
    config: vi.fn(async ws => ({
      t: "config" as const, loginRevision: "0",
      workspace: { id: ws.id, organizationId: ws.organizationId, checkoutPath: "/home/user/o/r", repository: ws.repository, branch: ws.branch, baseBranch: "main" },
      agents: {},
    })),
    workerRoute: vi.fn(async () => ({ workspace: workspace(state), accessEpoch: "0", url: workerUrl, token: "synthetic-port-token", bootId: workspaceId })),
    mintWorkerToken: () => "synthetic-grant",
    retryBaseMs: 10, retryMaxMs: 20, idleMs: 40,
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
  for (const socket of workerServer.clients) socket.terminate();
  await new Promise<void>(resolve => workerServer.close(() => resolve()));
  await new Promise(resolve => server.close(resolve));
});

it("joins a real explicit connect transition through the relay and settles a save on worker loss", async () => {
  const transition = vi.fn(async () => { state = "starting"; return workspace(state); });
  const api = new Hono();
  api.use("*", async (c, next) => { c.set("user", { id: workspaceId } as never); await next(); });
  api.route("/", createCloudV2Routes({ store: { ...deps.store, transition,
    issueToken: async () => ({ token: ticket, expiresAt: new Date(Date.now() + 60_000) }),
  }, bridgeBaseUrl: url } as unknown as CloudV2RouteDeps));
  const response = await api.request(`/v1/cloud-v2/workspaces/${workspaceId}/connect?wakePolicy=explicit`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wake: true }),
  });
  expect(response.status).toBe(200);
  expect(transition).toHaveBeenCalledOnce();
  const descriptor = await response.json() as { url: string; protocols: ["zeros.cloud.v2", string]; expiresAt: string };
  const client = new RuntimeClient({ kind: "cloud", channel: "v2-websocket", runtimeId: workspaceId, organizationId: workspaceId,
    workspaceId, engineInstanceId: workspaceId, generation: 1, authorityEpoch: 1, connectionSequence: 1,
    ...descriptor, expiresAt: Date.parse(descriptor.expiresAt),
  }, { environment: {
    controlPlaneOrigin: url.replace("ws:", "http:"), allowHttpLoopback: true,
    createWebSocket: (address, protocols) => { const ws = new WebSocket(address, protocols); sockets.push(ws); return ws as unknown as globalThis.WebSocket; },
    resolveEnginePort: async () => 0, resolveEngineToken: async () => "", invalidateEnginePort() {}, invalidateEngineToken() {},
    getAuthAccessToken: () => null, logger: { warn() {}, error() {} },
  } });
  const frames: any[] = [];
  workerServer.once("connection", ws => ws.on("message", raw => {
    const frame = JSON.parse(String(raw)); frames.push(frame);
    if (frame.t === "frame" && frame.frame.op === "workspace.list") ws.send(JSON.stringify({ t: "frame", clientId: frame.clientId, frame: {
      type: "WORKSPACE_RESPONSE", id: "ready", timestamp: Date.now(), source: "engine", requestId: frame.frame.id,
      op: "workspace.list", result: { workspaces: [] },
    } }));
  }));
  try {
    await client.connect();
    await vi.waitFor(() => expect(deps.answerOffline).toHaveBeenCalled());
    expect(connectedWorkers).toHaveLength(0);
    expect(deps.wake).not.toHaveBeenCalled();
    expect(sockets[0]!.protocol).toBe(explicitWakeProtocol);
    state = "running";
    await client.waitUntilReady();
    let failure: unknown;
    const save = client.request({ type: "WORKSPACE_REQUEST", op: "file.write", params: { path: "draft.txt", content: "draft" } })
      .catch(error => { failure = error; });
    await vi.waitFor(() => expect(frames.some(frame => frame.t === "frame" && frame.frame.op === "file.write")).toBe(true));
    state = "stopped"; connectedWorkers[0]!.terminate();
    await vi.waitFor(() => expect(failure).toBeInstanceOf(Error));
    await save;
    expect(client.lastRejection).toMatchObject({ reason: "cloud-transient", code: "cloud_workspace_not_running" });
    expect(deps.wake).not.toHaveBeenCalled();
  } finally { client.dispose(); }
});
