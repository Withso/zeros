import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { CloudLiveRecovery, LIVE_RECOVERY_WINDOW_MS } from "./live-recovery.js";
import { dialWorker, WorkerConnectionFailure, type WorkerRoute } from "./worker-connection.js";

it.each([502, 504])("rebuilds after two witnessed HTTP %s windows without hiding or rehosting", async status => {
  const server = createServer(), sockets = new Set<Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (_request, socket) => socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const route: WorkerRoute = {
    workspace: { id: "00000000-0000-4000-8000-000000000001", boatSandboxId: "bx_fixture1234",
      state: "running", archivedAt: null, errorCode: null } as WorkerRoute["workspace"],
    accessEpoch: "1", bootId: "00000000-0000-4000-8000-000000000002", workerTokenHash: "a".repeat(64),
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "synthetic-port-token",
  };
  let now = 1_800_000_000_000;
  const started = now, witnesses: Array<{ from: number; until: number }> = [];
  let complete!: () => void;
  const rebuilt = new Promise<void>(resolve => { complete = resolve; });
  const compute = {
    exec: vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: "hidden" })),
    hostPort: vi.fn(async () => ({ url: route.url!, token: route.token! })),
  };
  const condition = vi.fn(async () => true), publish = vi.fn(async () => true);
  const rebuild = vi.fn(async () => { complete(); return true; });
  const deps = { route: async () => route, compute, publish, condition, rebuild,
    now: () => now, wait: async (ms: number) => { now += ms; }, mint: () => "synthetic-grant", ready: vi.fn(),
    witness: async (_binding: unknown, until: number) => { witnesses.push({ from: now, until }); return { seen: () => true, dispose() {} }; },
  };
  const recovery = new CloudLiveRecovery(deps);
  try {
    const failure = await dialWorker(route, "synthetic-grant").catch(error => error);
    expect(failure).toBeInstanceOf(WorkerConnectionFailure);
    expect(failure).toMatchObject({ reason: "gateway", statusClass: "5xx" });
    recovery.failed(route, failure);
    await rebuilt;
    await recovery.close();
    expect(rebuild).toHaveBeenCalledExactlyOnceWith(route);
    expect(witnesses).toEqual([
      { from: started, until: started + LIVE_RECOVERY_WINDOW_MS },
      { from: started + LIVE_RECOVERY_WINDOW_MS, until: started + 2 * LIVE_RECOVERY_WINDOW_MS },
    ]);
    expect(now - started).toBe(2 * LIVE_RECOVERY_WINDOW_MS);
    expect(compute.exec).not.toHaveBeenCalled();
    expect(compute.hostPort).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(condition).not.toHaveBeenCalled();
  } finally {
    await recovery.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
