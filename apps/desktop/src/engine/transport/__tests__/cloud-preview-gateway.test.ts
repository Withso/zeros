import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { CloudRuntimePreviewGateway } from "../cloud-preview-gateway";
import { WebSocket, WebSocketServer } from "ws";
import type { CloudRuntimeServiceAccess } from "../../cloud-runtime-registration";

const servers: Server[] = [];
const gateways: CloudRuntimePreviewGateway[] = [];
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing listener");
  return address.port;
}
function admission(port: number): CloudRuntimeServiceAccess {
  return {
    version: 1,
    audience: "zeros-cloud-runtime-access-admission-v1",
    admitted: true,
    grantId: "11111111-1111-4111-8111-111111111111",
    accountUserId: "22222222-2222-4222-8222-222222222222",
    authorityEpoch: 1,
    kind: "preview",
    remotePort: port,
    expiresAtMs: Date.now() + 10_000,
  };
}
const credential = `zwp_${"A".repeat(43)}`;
const headers = { "x-zeros-runtime-access": credential };
async function gateway(
  verify: (token: string) => Promise<CloudRuntimeServiceAccess | null>,
  forbidden: number[] = [],
) {
  const handler = new CloudRuntimePreviewGateway({
    verify,
    forbiddenPorts: () => forbidden,
  });
  gateways.push(handler);
  const port = await serve((req, res) => {
    if (!handler.handle(req, res)) {
      res.statusCode = 404;
      res.end();
    }
  });
  servers.at(-1)!.on("upgrade", (request, socket, head) => {
    if (!handler.handleUpgrade?.(request, socket, head)) socket.destroy();
  });
  return port;
}
afterEach(async () => {
  for (const item of gateways.splice(0)) item.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("Zeros runtime preview gateway", () => {
  it("relays HMR WebSockets with protocols and strips the runtime credential", async () => {
    const application = await serve((_request, response) => response.end());
    const wss = new WebSocketServer({ server: servers.at(-1), perMessageDeflate: false });
    const seen = vi.fn();
    wss.on("connection", (socket, request) => {
      seen(request.headers); socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    const port = await gateway(async () => admission(application));
    const socket = new WebSocket(`ws://127.0.0.1:${port}/hmr`, ["vite-hmr"], { headers });
    try {
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      expect(socket.protocol).toBe("vite-hmr");
      const result = new Promise<string>((resolve, reject) => { socket.once("message", data => resolve(data.toString())); socket.once("error", reject); });
      socket.send("hot-update"); expect(await result).toBe("hot-update");
      expect(seen.mock.calls[0]?.[0]["x-zeros-runtime-access"]).toBeUndefined();
    } finally { socket.terminate(); for (const client of wss.clients) client.terminate(); wss.close(); }
  });

  it("retires a WebSocket when its lease is revoked and rejects credential-free upgrades", async () => {
    const application = await serve((_request, response) => response.end());
    const wss = new WebSocketServer({ server: servers.at(-1) }); const connected = vi.fn(); wss.on("connection", connected);
    const verify = vi.fn().mockImplementationOnce(async () => ({ ...admission(application), expiresAtMs: Date.now() + 250 })).mockResolvedValue(null);
    const port = await gateway(verify);
    const denied = new WebSocket(`ws://127.0.0.1:${port}/hmr`);
    await new Promise<void>(resolve => denied.once("error", () => resolve()));
    expect(verify).not.toHaveBeenCalled(); expect(connected).not.toHaveBeenCalled();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/hmr`, { headers });
    try {
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      await new Promise<void>(resolve => socket.once("close", () => resolve()));
      expect(verify).toHaveBeenCalledTimes(2); expect(connected).toHaveBeenCalledOnce();
    } finally { socket.terminate(); denied.terminate(); for (const client of wss.clients) client.terminate(); wss.close(); }
  });
  it("requires fresh access before touching an application and strips service credentials", async () => {
    const app = vi.fn((req: IncomingMessage, res: ServerResponse) => {
      expect(req.headers["x-zeros-runtime-access"]).toBeUndefined();
      expect(req.headers["x-zeros-cloud-token"]).toBeUndefined();
      expect(req.headers.authorization).toBe("Bearer application-login");
      expect(req.url).toBe("/path?q=value");
      res.statusCode = 201;
      res.setHeader("content-type", "text/plain");
      res.end("app response");
    });
    const application = await serve(app);
    const verify = vi.fn(async () => admission(application));
    const port = await gateway(verify);
    expect((await fetch(`http://127.0.0.1:${port}/path`)).status).toBe(404);
    expect(app).not.toHaveBeenCalled();
    const response = await fetch(`http://127.0.0.1:${port}/path?q=value`, {
      headers: {
        ...headers,
        "x-zeros-cloud-token": "private",
        authorization: "Bearer application-login",
      },
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("app response");
    expect(verify).toHaveBeenCalledWith(credential);
    expect(app).toHaveBeenCalledTimes(1);
    verify.mockResolvedValueOnce(null as never);
    expect((await fetch(`http://127.0.0.1:${port}/`, { headers })).status).toBe(
      401,
    );
    expect(app).toHaveBeenCalledTimes(1);
  });

  it("denies internal ports and cross-purpose or expired grants", async () => {
    const app = vi.fn((_req: IncomingMessage, res: ServerResponse) =>
      res.end("unsafe"),
    );
    const application = await serve(app);
    const verify = vi.fn(async () => admission(application));
    const forbidden: number[] = [application];
    const port = await gateway(verify, forbidden);
    expect((await fetch(`http://127.0.0.1:${port}/`, { headers })).status).toBe(
      401,
    );
    forbidden.length = 0;
    for (const override of [
      { kind: "tunnel" as const },
      { expiresAtMs: Date.now() - 1 },
      { remotePort: 22 },
      { remotePort: 22222 },
    ]) {
      verify.mockResolvedValueOnce({ ...admission(application), ...override });
      expect(
        (await fetch(`http://127.0.0.1:${port}/`, { headers })).status,
      ).toBe(401);
    }
    expect(app).not.toHaveBeenCalled();
  });

  it("stops an open response when its access lease cannot be renewed", async () => {
    const application = await serve((_req, res) => {
      res.writeHead(200);
      res.write("first");
    });
    const verify = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ...admission(application),
        expiresAtMs: Date.now() + 80,
      }))
      .mockResolvedValue(null);
    const port = await gateway(verify);
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers });
    await expect(response.text()).rejects.toThrow();
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("bounds unauthenticated admission concurrency and retires pending work on shutdown", async () => {
    let complete!: (value: CloudRuntimeServiceAccess | null) => void;
    const pending = new Promise<CloudRuntimeServiceAccess | null>((resolve) => {
      complete = resolve;
    });
    const verify = vi.fn(() => pending);
    const port = await gateway(verify);
    const requests = Array.from({ length: 32 }, () =>
      fetch(`http://127.0.0.1:${port}/`, { headers }),
    );
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(32));
    expect((await fetch(`http://127.0.0.1:${port}/`, { headers })).status).toBe(
      429,
    );
    complete(null);
    expect(
      (await Promise.all(requests)).every(
        (response) => response.status === 401,
      ),
    ).toBe(true);
    gateways[0].close();
    expect((await fetch(`http://127.0.0.1:${port}/`, { headers })).status).toBe(
      503,
    );
  });
  it("keeps abandoned authorization requests inside the admission bound", async () => {
    let complete!: (value: CloudRuntimeServiceAccess | null) => void;
    const pending = new Promise<CloudRuntimeServiceAccess | null>((resolve) => {
      complete = resolve;
    });
    const verify = vi.fn(() => pending);
    const port = await gateway(verify);
    const controller = new AbortController();
    const requests = Array.from({ length: 32 }, () =>
      fetch(`http://127.0.0.1:${port}/`, {
        headers,
        signal: controller.signal,
      }).catch(() => null),
    );
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(32));
    controller.abort();
    await Promise.all(requests);
    expect((await fetch(`http://127.0.0.1:${port}/`, { headers })).status).toBe(
      429,
    );
    expect(verify).toHaveBeenCalledTimes(32);
    complete(null);
  });
});
