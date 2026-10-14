import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { RuntimeClient, type RuntimeClientEnvironment } from "../../apps/desktop/src/renderer/platform/bridge/runtime-client";

describe("Linux uses the desktop RuntimeClient protocol", () => {
  it("connects without renderer globals, keeps account tokens off cloud, and waits for the real handshake", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("loopback fixture did not listen");
    const seen: Record<string, unknown>[] = [];
    server.on("connection", (socket, request) => {
      expect(request.headers["sec-websocket-protocol"]).toContain("zeros-cloud-token.");
      socket.on("message", bytes => {
        const msg = JSON.parse(bytes.toString()); seen.push(msg);
        if (msg.type === "WORKSPACE_REQUEST") socket.send(JSON.stringify({
          id: randomUUID(), timestamp: Date.now(), source: "engine", type: "WORKSPACE_RESPONSE",
          op: msg.op, requestId: msg.id, result: { workspaces: [] },
        }));
      });
    });
    const environment: RuntimeClientEnvironment = {
      controlPlaneOrigin: `http://127.0.0.1:${address.port}`, allowHttpLoopback: true,
      createWebSocket: (url, protocols) => new WebSocket(url, protocols) as never,
      resolveEnginePort: async () => { throw new Error("local port must not be read"); },
      resolveEngineToken: async () => { throw new Error("local token must not be read"); },
      invalidateEnginePort() {}, invalidateEngineToken() {},
      getAuthAccessToken: () => { throw new Error("account bearer must not enter the VM"); },
      logger: { warn() {}, error() {} },
    };
    const target = { kind: "cloud" as const, channel: "control-plane-websocket" as const,
      runtimeId: randomUUID(), organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1,
      authorityEpoch: 1, engineInstanceId: randomUUID(), connectionSequence: 1, cloudToken: `zwa_${"a".repeat(43)}`,
      url: `ws://127.0.0.1:${address.port}/v1/cloud-workspaces/bridge`, expiresAt: Date.now() + 120_000 };
    const client = new RuntimeClient(target, { environment });
    try {
      expect(typeof window).toBe("undefined");
      await client.connect();
      await client.waitUntilReady();
      await client.request({ type: "WORKSPACE_REQUEST", op: "workspace.list", params: {} });
      expect(seen[0]).toMatchObject({ type: "CONNECTED", source: "browser" });
      expect(seen[0]).not.toHaveProperty("authToken");
      expect(seen.filter(row => row.type === "WORKSPACE_REQUEST")).toHaveLength(2);
      expect(client.executionIdentity).toMatchObject({ kind: "cloud", organizationId: target.organizationId, workspaceId: target.workspaceId });
      expect(() => new RuntimeClient({ ...target, url: "wss://foreign.example/v1/cloud-workspaces/bridge" }, { environment })).toThrow(/URL/);
    } finally {
      client.dispose(); for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
