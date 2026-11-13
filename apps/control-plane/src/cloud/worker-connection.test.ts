import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { dialWorker, workerSupportsActingUser, type WorkerRoute } from "./worker-connection.js";

describe("worker carrier dial", () => {
  let server: Server, route: WorkerRoute;
  const sockets = new Set<Socket>();
  beforeEach(async () => {
    server = createServer();
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    route = { workspace: { id: "00000000-0000-4000-8000-000000000001" } as WorkerRoute["workspace"],
      accessEpoch: "1", bootId: "00000000-0000-4000-8000-000000000002",
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "synthetic-port-token" };
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("keeps a ten-second gateway refusal instead of replacing it with a three-second timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const upgrade = once(server, "upgrade");
    const result = dialWorker(route, "synthetic-grant").catch(error => error);
    const [, socket] = await upgrade;
    await vi.advanceTimersByTimeAsync(10_000);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nX-Private: synthetic-header-canary\r\nContent-Length: 21\r\n\r\nsynthetic-body-canary");
    const error = await result;
    expect(error).toMatchObject({ reason: "gateway", statusClass: "5xx" });
    expect(String(error)).not.toMatch(/synthetic|502|header|body/);
    expect(JSON.stringify(error)).not.toMatch(/synthetic|502|header|body/);
  });

  it.each([
    [504, "gateway", "5xx"], [503, "server_unavailable", "5xx"],
    [401, "refused", "4xx"], [403, "refused", "4xx"], [302, "refused", "3xx"], [500, "refused", "5xx"],
  ])("classifies HTTP %s without retaining response metadata", async (status, reason, statusClass) => {
    server.on("upgrade", (_request, socket) => socket.end(`HTTP/1.1 ${status} Refused\r\nLocation: https://example.test/?token=synthetic-canary\r\nContent-Length: 0\r\n\r\n`));
    await expect(dialWorker(route, "synthetic-grant")).rejects.toMatchObject({ reason, statusClass });
  });

  it("anchors a shortened dial to the remaining connection window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const upgrade = once(server, "upgrade");
    const result = dialWorker(route, "synthetic-grant", { timeoutMs: 1_200 }).catch(error => error);
    await upgrade;
    await vi.advanceTimersByTimeAsync(1_199);
    let settled = false; void result.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ reason: "timeout", statusClass: "none" });
  });

  it("cancels an in-flight handshake when its room ends", async () => {
    const upgrade = once(server, "upgrade"), controller = new AbortController();
    const result = dialWorker(route, "synthetic-grant", { signal: controller.signal }).catch(error => error);
    await upgrade; controller.abort();
    expect(await result).toMatchObject({ reason: "cancelled", statusClass: "none" });
  });

  it("preserves features and the existing grant on a real upgraded socket", async () => {
    const worker = new WebSocketServer({ noServer: true, handleProtocols: () => "zeros.cloud.v2.worker" });
    worker.on("headers", headers => headers.push("X-Zeros-Worker-Features: acting-user-v1"));
    server.on("upgrade", (request, socket, head) => {
      expect(request.headers.cookie).toBe("_port_auth=synthetic-port-token");
      expect(request.headers["x-zeros-worker-auth"]).toBe("synthetic-grant");
      worker.handleUpgrade(request, socket, head, ws => worker.emit("connection", ws, request));
    });
    const socket = await dialWorker(route, "synthetic-grant");
    expect(workerSupportsActingUser(socket)).toBe(true);
    socket.terminate(); for (const client of worker.clients) client.terminate(); worker.close();
  });

  it.each([null, "https://example.test/?token=synthetic-canary", "http://example.test/"])("closes an invalid route without exposing it", async url => {
    let error: unknown;
    try { await dialWorker({ ...route, url }, "synthetic-grant"); } catch (value) { error = value; }
    expect(error).toMatchObject({ reason: url === null ? "route_unavailable" : "route_invalid", statusClass: "none" });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("synthetic");
  });
});
