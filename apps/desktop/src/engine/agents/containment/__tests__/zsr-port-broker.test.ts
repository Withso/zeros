import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { newTerritoryGeneration } from "../status";
import {
  ZsrLocalTcpBroker,
  ZsrReversePortBroker,
} from "../zsr-port-broker";

const BRIDGE_SCRIPT = path.join(
  process.cwd(),
  "apps/desktop/src/engine/agents/containment/zsr-network-bridge.mjs",
);

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitForSocket(socketPath: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      if ((await lstat(socketPath)).isSocket()) return;
    } catch {
      // The bridge publishes the socket asynchronously.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("network bridge did not publish its socket");
}

function request(port: number, value: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy(new Error("timeout")));
    socket.once("connect", () => socket.write(value));
    socket.on("data", (chunk) => {
      response += chunk;
      socket.end();
    });
    socket.once("close", () => resolve(response));
    socket.once("error", reject);
  });
}

describe("ZSR reverse port broker", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  it("authenticates a lease and transparently pipes a persistent TCP stream", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-port-test-"));
    await chmod(root, 0o700);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const generation = newTerritoryGeneration();
    const token = randomBytes(32);
    const socketPath = path.join(root, "r");
    const descriptor = path.join(root, "bridge.json");
    await writeFile(
      descriptor,
      `${JSON.stringify({
        version: 1,
        generation,
        token: token.toString("base64url"),
        reverseSocketPath: socketPath,
        localTcpPorts: [],
      })}\n`,
      { mode: 0o600, flag: "wx" },
    );

    const bridge = spawn(process.execPath, [BRIDGE_SCRIPT, "--config", descriptor], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(async () => {
      if (bridge.exitCode === null && bridge.signalCode === null) {
        bridge.kill("SIGTERM");
        await new Promise((resolve) => bridge.once("exit", resolve));
      }
    });
    await waitForSocket(socketPath, bridge);

    const target = createServer((peer) => {
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => peer.end(`target:${chunk}`));
    });
    const targetPort = await listen(target);
    cleanups.push(() => close(target));

    const broker = new ZsrReversePortBroker({
      generation,
      socketPath,
      token,
    });
    cleanups.push(() => broker.close());
    const lease = await broker.lease({
      protocol: "tcp",
      targetPort,
      purpose: "preview",
    });
    expect(lease.targetPort).toBe(targetPort);
    await expect(request(lease.port, "browser")).resolves.toBe(
      "target:browser",
    );

    await lease.revoke();
    await expect(request(lease.port, "after-revoke")).rejects.toBeDefined();
  });

  it("discovers namespace TCP listeners without publishing infrastructure ports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-port-test-"));
    await chmod(root, 0o700);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const generation = newTerritoryGeneration();
    const token = randomBytes(32);
    const socketPath = path.join(root, "r");
    const descriptor = path.join(root, "bridge.json");
    const target = createServer();
    const ignored = createServer();
    const targetPort = await listen(target);
    const ignoredPort = await listen(ignored);
    cleanups.push(() => close(target));
    cleanups.push(() => close(ignored));
    await writeFile(
      descriptor,
      `${JSON.stringify({
        version: 1,
        generation,
        token: token.toString("base64url"),
        reverseSocketPath: socketPath,
        localTcpPorts: [],
        ignoredTcpPorts: [ignoredPort],
      })}\n`,
      { mode: 0o600, flag: "wx" },
    );

    const bridge = spawn(process.execPath, [BRIDGE_SCRIPT, "--config", descriptor], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(async () => {
      if (bridge.exitCode === null && bridge.signalCode === null) {
        bridge.kill("SIGTERM");
        await new Promise((resolve) => bridge.once("exit", resolve));
      }
    });
    await waitForSocket(socketPath, bridge);

    const broker = new ZsrReversePortBroker({ generation, socketPath, token });
    cleanups.push(() => broker.close());
    const listeners = await broker.listTcpListeners();
    expect(listeners).toContain(targetPort);
    expect(listeners).not.toContain(ignoredPort);
    expect(listeners).toEqual([...listeners].sort((a, b) => a - b));
  });

  it("rejects a forged generation/token without reaching the target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-port-test-"));
    await chmod(root, 0o700);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const generation = newTerritoryGeneration();
    const token = randomBytes(32);
    const socketPath = path.join(root, "r");
    const descriptor = path.join(root, "bridge.json");
    await writeFile(
      descriptor,
      `${JSON.stringify({
        version: 1,
        generation,
        token: token.toString("base64url"),
        reverseSocketPath: socketPath,
        localTcpPorts: [],
      })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    const bridge = spawn(process.execPath, [BRIDGE_SCRIPT, "--config", descriptor], {
      stdio: "ignore",
    });
    cleanups.push(async () => {
      if (bridge.exitCode === null && bridge.signalCode === null) {
        bridge.kill("SIGTERM");
        await new Promise((resolve) => bridge.once("exit", resolve));
      }
    });
    await waitForSocket(socketPath, bridge);

    const response = await new Promise<string>((resolve, reject) => {
      const peer = connect(socketPath);
      let received = "";
      peer.setEncoding("utf8");
      peer.once("connect", () => {
        peer.write(
          `${JSON.stringify({
            version: 1,
            operation: "connect-tcp",
            generation: `${generation}-stale`,
            token: randomBytes(32).toString("base64url"),
            port: 9,
          })}\n`,
        );
      });
      peer.on("data", (chunk) => (received += chunk));
      peer.once("close", () => resolve(received));
      peer.once("error", reject);
    });
    expect(response).toBe("");
  });

  it("forwards only an authenticated, admitted local TCP destination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-port-test-"));
    await chmod(root, 0o700);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const generation = newTerritoryGeneration();
    const token = randomBytes(32);
    const target = createServer((peer) => {
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => peer.end(`local:${chunk}`));
    });
    const targetPort = await listen(target);
    cleanups.push(() => close(target));
    const serviceSocket = path.join(root, "h");
    const broker = await ZsrLocalTcpBroker.start({
      generation,
      socketPath: serviceSocket,
      token,
      allowedPorts: [targetPort],
    });
    cleanups.push(() => broker.close());

    const response = await new Promise<string>((resolve, reject) => {
      const peer = connect(serviceSocket);
      let state: "auth" | "body" = "auth";
      let received = "";
      peer.setEncoding("utf8");
      peer.once("connect", () =>
        peer.write(
          `${JSON.stringify({
            version: 1,
            operation: "connect-local-tcp",
            generation,
            token: token.toString("base64url"),
            port: targetPort,
          })}\n`,
        ),
      );
      peer.on("data", (chunk) => {
        if (state === "auth") {
          expect(chunk).toBe("OK\n");
          state = "body";
          peer.write("mcp");
          return;
        }
        received += chunk;
        peer.end();
      });
      peer.once("close", () => resolve(received));
      peer.once("error", reject);
    });
    expect(response).toBe("local:mcp");

    const forged = await new Promise<string>((resolve, reject) => {
      const peer = connect(serviceSocket);
      let received = "";
      peer.setEncoding("utf8");
      peer.once("connect", () =>
        peer.write(
          `${JSON.stringify({
            version: 1,
            operation: "connect-local-tcp",
            generation,
            token: randomBytes(32).toString("base64url"),
            port: targetPort,
          })}\n`,
        ),
      );
      peer.on("data", (chunk) => (received += chunk));
      peer.once("close", () => resolve(received));
      peer.once("error", reject);
    });
    expect(forged).toBe("");
  });
});
