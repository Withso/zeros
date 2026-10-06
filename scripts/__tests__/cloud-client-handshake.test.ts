import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { CloudTransport } from "../../apps/desktop/src/engine/transport/cloud";
import { CloudRuntimeBridgeRelay } from "../../apps/control-plane/src/cloud-workspaces/runtime-bridge";
import { RuntimeClient } from "../../apps/desktop/src/renderer/platform/bridge/ws-client";
import { installCloudGithubNative } from "../../apps/desktop/src/renderer/platform/bridge/cloud-github-native";
import { CloudEventReader } from "../../apps/desktop/src/renderer/platform/bridge/cloud-event-reader";

describe("desktop cloud handshake through relay and engine transport", () => {
  it.each([1, 128, 256])("sends CONNECTED before cold attach and reconnect with slow auth and %i queued requests", async queued => {
    const admission = { accountUserId: randomUUID(), authorityEpoch: 1,
      actor: { sessionId: randomUUID(), deviceId: randomUUID(), role: "owner" as const, fingerprint: "a".repeat(64) } };
    const token = `zwa_${"A".repeat(43)}`, streamId = randomUUID();
    const engine = new CloudTransport({ port: 0, token: "test-bootstrap-unused",
      verifyToken: async () => admission, renewToken: async () => admission });
    // Deployed engines announce readiness before CONNECTED authentication.
    engine.onConnect(peer => peer.send({ id: randomUUID(), source: "engine", timestamp: Date.now(),
      type: "ENGINE_READY", version: "test", root: "", framework: "test", port: 0 }));
    const frames: Array<{ type: string; op?: string }> = [], handled: string[] = [];
    let finishAuth = () => {};
    engine.onMessage(async (peer, message) => {
      handled.push(message.type);
      if (message.type === "CONNECTED") await new Promise<void>(resolve => { finishAuth = resolve; });
      if (message.type === "WORKSPACE_REQUEST") peer.send({
        id: randomUUID(), source: "engine", timestamp: Date.now(), type: "WORKSPACE_RESPONSE", requestId: message.id, op: message.op,
        result: message.op === "cloudEvents.request" ? { streamId, head: 1, cursor: 1, firstRetained: 1, events: [] } : {},
      });
    });
    await engine.start();
    const grant = { workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1,
      authorityEpoch: 1, engineInstanceId: randomUUID(), resourceId: "bx_23456789", readOnly: false };
    const relay = new CloudRuntimeBridgeRelay({
      resolve: async () => ({ ...grant, endpoint: { url: "https://provider.example.test" } }),
      revalidate: async () => true, log: () => {},
      openUpstream: (_url, options) => {
        const upstream = new WebSocket(`ws://127.0.0.1:${engine.boundPort}/ws`, options);
        const send = upstream.send.bind(upstream);
        upstream.send = ((data, ...args) => { frames.push(JSON.parse(String(data))); return send(data, ...args); }) as typeof upstream.send;
        return upstream;
      },
    });
    const server = createServer();
    server.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.stubEnv("VITE_CONTROL_PLANE_URL", origin); vi.stubEnv("DEV", true);
    vi.stubGlobal("WebSocket", WebSocket); vi.stubGlobal("window", globalThis);
    const target = { kind: "cloud" as const, channel: "control-plane-websocket" as const,
      ...grant, runtimeId: randomUUID(), connectionSequence: 1, cloudToken: token,
      expiresAt: Date.now() + 120_000, url: origin.replace("http:", "ws:") + "/v1/cloud-workspaces/bridge" };
    const { resourceId: _resource, readOnly: _readOnly, ...descriptor } = target;
    const client = new RuntimeClient(descriptor, { refreshCloudConnectionTarget: async current => ({ ...current, connectionSequence: current.connectionSequence + 1 }) });
    const offCourier = installCloudGithubNative(client, grant);
    const reader = new CloudEventReader(client);
    try {
      for (const reconnect of [false, true]) {
        frames.length = 0; handled.length = 0;
        if (reconnect) await client.forceReconnect(); else await client.connect();
        // The native GitHub courier already queued its initial ready RPC.
        const count = reconnect ? queued : Math.max(1, queued - 1);
        const request = Promise.all(Array.from({ length: count }, () => client.request({ type: "WORKSPACE_REQUEST", op: "workspace.list", params: {} }, 2_000)));
        void request.catch(() => {});
        await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
        expect(frames[0].type).toBe("CONNECTED");
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(handled).toEqual(["CONNECTED"]);
        expect(client.status).toBe("connecting");
        expect(client.extensionConnected).toBe(false);
        finishAuth();
        await expect(request).resolves.toHaveLength(count);
        await vi.waitFor(() => expect(frames.some(frame => frame.op === "github.nativeGrant")).toBe(true));
        engine.broadcast({ id: randomUUID(), source: "engine", timestamp: Date.now(), type: "DB_CHANGED",
          kinds: ["chats"], cloudStream: { streamId, sequence: 1 } });
        if (reconnect) await vi.waitFor(() => expect(frames.some(frame => frame.op === "cloudEvents.request")).toBe(true));
        else await new Promise(resolve => setTimeout(resolve, 25));
      }
    } finally {
      finishAuth(); reader.dispose(); offCourier(); client.dispose(); relay.close();
      await engine.stop(); await new Promise<void>(resolve => server.close(() => resolve()));
      vi.unstubAllGlobals(); vi.unstubAllEnvs();
    }
  });
});
