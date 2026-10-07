import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { testCloudWorker } from "../../agents/__tests__/helpers/test-cloud-runtime";
import type { CloudDurabilityAuthority } from "../../cloud-durability-runtime";
import { CloudIdleStopScheduler } from "../../cloud-idle-stop";
import { CloudRuntimeHumanServices } from "../cloud-human-services";
import type { CloudRuntimeServiceStream } from "../cloud-service-gateway";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP fixture address");
  return address.port;
}

function grant(remotePort: number) {
  return {
    version: 1 as const,
    audience: "zeros-cloud-runtime-access-admission-v1" as const,
    admitted: true as const,
    grantId: "loopback-fixture",
    accountUserId: "fixture-owner",
    authorityEpoch: 1,
    expiresAtMs: Date.now() + 30_000,
    kind: "tunnel" as const,
    remotePort,
  };
}

describe("cloud forwarding traffic and idle stop", () => {
  it("retains a complete short request between observations, then expires its quiet window", async () => {
    let now = 0;
    const peers = new Set<Socket>();
    const server = createServer(peer => {
      peers.add(peer);
      peer.on("error", () => {});
      peer.once("data", () => peer.end("HTTP/1.0 200 OK\r\n\r\nresponse"));
      peer.once("close", () => peers.delete(peer));
    });
    const services = new CloudRuntimeHumanServices(testCloudWorker(), () => [], () => now);
    const stop = vi.fn(async () => true);
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => services.hasActiveWork(), stop });
    let connection: CloudRuntimeServiceStream | undefined;
    try {
      const port = await listen(server);
      now = 600_001;
      connection = await services.open(grant(port));
      const stream = connection.stream as Socket;
      const received: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => received.push(chunk));
      const closed = once(stream, "close");
      stream.resume();
      stream.end("GET / HTTP/1.0\r\n\r\n");
      await closed;
      expect(Buffer.concat(received).toString()).toContain("response");
      expect(stream.bytesRead + stream.bytesWritten).toBeGreaterThan(0);

      // No activity observation occurred while the real connection was alive.
      now += 5;
      scheduler.consider({} as CloudDurabilityAuthority);
      await scheduler.settled();
      expect(stop).not.toHaveBeenCalled();
      expect(services.hasActiveWork()).toBe(true);

      now += 600_000;
      expect(services.hasActiveWork()).toBe(false);
      scheduler.consider({} as CloudDurabilityAuthority);
      await scheduler.settled();
      expect(stop).not.toHaveBeenCalled();
      // Preserve the scheduler's own quiet interval after the busy guard ends.
      now += 600_000;
      scheduler.consider({} as CloudDurabilityAuthority);
      await scheduler.settled();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      connection?.close();
      for (const peer of peers) peer.destroy();
      await scheduler.close();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("allows idle stop with an unused connected tunnel and no transferred bytes", async () => {
    let now = 0;
    const peers = new Set<Socket>();
    const server = createServer(peer => {
      peers.add(peer);
      peer.on("error", () => {});
      peer.once("close", () => peers.delete(peer));
    });
    const services = new CloudRuntimeHumanServices(testCloudWorker(), () => [], () => now);
    const stop = vi.fn(async () => true);
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => services.hasActiveWork(), stop });
    let connection: CloudRuntimeServiceStream | undefined;
    try {
      connection = await services.open(grant(await listen(server)));
      expect(services.hasActiveWork()).toBe(false);
      now = 600_000;
      scheduler.consider({} as CloudDurabilityAuthority);
      await scheduler.settled();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      connection?.close();
      for (const peer of peers) peer.destroy();
      await scheduler.close();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
