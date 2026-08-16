import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { newTerritoryGeneration } from "../status";
import { ZsrPortPolicyClient } from "../zsr-port-broker";
import { startZsrPortPolicyControl } from "../zsr-port-policy-control.mjs";

describe("ZSR dynamic port-policy control", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
  });

  it("authenticates sorted live proxy policy and keeps static ports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-policy-test-"));
    await chmod(root, 0o700);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const generation = newTerritoryGeneration();
    const token = randomBytes(32);
    const onPorts = vi.fn();
    const control = await startZsrPortPolicyControl({
      socketPath: path.join(root, "policy.sock"),
      generation,
      token,
      staticPorts: [4310],
      deniedPorts: [24293],
      onPorts,
    });
    cleanups.push(() => control.close());
    const client = new ZsrPortPolicyClient({
      socketPath: path.join(root, "policy.sock"),
      generation,
      token,
    });
    await client.setLocalPorts([5432, 4321, 5432]);
    expect(onPorts).toHaveBeenCalledWith([4310, 4321, 5432]);

    const forged = new ZsrPortPolicyClient({
      socketPath: path.join(root, "policy.sock"),
      generation,
      token: randomBytes(32),
    });
    await expect(forged.setLocalPorts([6000])).rejects.toThrow();
    expect(onPorts).toHaveBeenCalledTimes(1);
    client.close();
    forged.close();
  });

  it("rejects a dynamic attempt to expose an engine control port", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-policy-test-"));
    await chmod(root, 0o700);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const generation = newTerritoryGeneration();
    const token = randomBytes(32);
    const onPorts = vi.fn();
    const control = await startZsrPortPolicyControl({
      socketPath: path.join(root, "policy.sock"),
      generation,
      token,
      staticPorts: [],
      deniedPorts: [24293],
      onPorts,
    });
    cleanups.push(() => control.close());
    const client = new ZsrPortPolicyClient({
      socketPath: path.join(root, "policy.sock"),
      generation,
      token,
    });
    await expect(client.setLocalPorts([24293])).rejects.toThrow();
    expect(onPorts).not.toHaveBeenCalled();
    client.close();
  });

  it("rejects frames with undeclared fields instead of widening the protocol", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-policy-test-"));
    await chmod(root, 0o700);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const generation = newTerritoryGeneration();
    const token = randomBytes(32);
    const onPorts = vi.fn();
    const socketPath = path.join(root, "policy.sock");
    const control = await startZsrPortPolicyControl({
      socketPath,
      generation,
      token,
      staticPorts: [],
      deniedPorts: [],
      onPorts,
    });
    cleanups.push(() => control.close());

    const response = await new Promise<string>((resolve) => {
      const socket = createConnection(socketPath);
      let bytes = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        bytes += chunk;
      });
      socket.once("close", () => resolve(bytes));
      socket.once("connect", () => {
        socket.end(
          `${JSON.stringify({
            version: 1,
            operation: "set-local-ports",
            generation,
            token: token.toString("base64url"),
            ports: [4310],
            futureAuthority: true,
          })}\n`,
        );
      });
    });

    expect(response).toBe("");
    expect(onPorts).not.toHaveBeenCalled();
  });

  it("does not reveal its private socket path when the control is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-policy-test-"));
    await chmod(root, 0o700);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = path.join(root, "sensitive-generation.sock");
    const client = new ZsrPortPolicyClient({
      socketPath,
      generation: newTerritoryGeneration(),
      token: randomBytes(32),
    });

    await expect(client.setLocalPorts([4310])).rejects.not.toThrow(socketPath);
    client.close();
  });

  it("rejects an overlong Unix socket path before starting the supervisor service", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-policy-test-"));
    await chmod(root, 0o700);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await expect(
      startZsrPortPolicyControl({
        socketPath: path.join(root, "s".repeat(110)),
        generation: newTerritoryGeneration(),
        token: randomBytes(32),
        staticPorts: [],
        deniedPorts: [],
        onPorts: () => undefined,
      }),
    ).rejects.toThrow(/platform limit/);
  });
});
