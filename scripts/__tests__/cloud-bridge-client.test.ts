import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { BridgeClient } from "../cloud-workspace-validation/lib/bridge-client";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function rejectingServer(): Promise<string> {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.once("connection", (socket) => socket.close(1008, "not ready"));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test WebSocket server did not bind a TCP port");
  }
  return `ws://127.0.0.1:${address.port}/ws`;
}

describe("cloud qualification BridgeClient", () => {
  it("rejects promptly when a peer closes after open but before ENGINE_READY", async () => {
    const client = new BridgeClient({ url: await rejectingServer() });
    const verdict = await Promise.race([
      client.connect().then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), 500),
      ),
    ]);
    expect(verdict).toBe("rejected");
  });

  it("fails immediately instead of silently dropping a frame before connect", () => {
    const client = new BridgeClient({ url: "ws://127.0.0.1:1/ws" });
    expect(() =>
      client.sendMessage({ type: "HEARTBEAT", source: "browser" }),
    ).toThrow(/not open/i);
  });

  it("uses the renderer-compatible safe subprotocol for the cloud bearer", async () => {
    let offered = "";
    const inbound: Array<Record<string, unknown>> = [];
    const server = new WebSocketServer({
      port: 0,
      handleProtocols: (protocols) =>
        protocols.has("zeros-v1") ? "zeros-v1" : false,
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    server.once("connection", (socket, request) => {
      offered = request.headers["sec-websocket-protocol"] ?? "";
      socket.on("message", (data) => {
        inbound.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });
      socket.send(
        JSON.stringify({
          type: "ENGINE_READY",
          source: "engine",
          root: "",
          version: "test",
        }),
      );
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test WebSocket server did not bind a TCP port");
    }
    const token = "qualified-cloud-bearer-token";
    const client = new BridgeClient({
      url: `ws://127.0.0.1:${address.port}/ws`,
      cloudToken: token,
    });

    await client.connect();
    await vi.waitFor(() => expect(inbound).toHaveLength(1));

    expect(offered.split(/,\s*/)).toEqual([
      "zeros-v1",
      `zeros-cloud-token.${Buffer.from(token, "utf8").toString("base64url")}`,
    ]);
    expect(inbound[0]).toMatchObject({
      type: "CONNECTED",
      source: "browser",
    });
    client.close();
  });
});
