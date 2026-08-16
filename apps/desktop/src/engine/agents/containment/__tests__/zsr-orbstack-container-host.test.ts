import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOST = path.join(
  process.cwd(),
  "apps/desktop/src/engine/agents/containment/zsr-orbstack-container-host.mjs",
);

describe("ZSR OrbStack container host bridge", () => {
  let root: string;
  let upstream: Server | null;
  let bridge: ChildProcess | null;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "zeros-orbstack-host-test-"));
    upstream = null;
    bridge = null;
  });

  afterEach(async () => {
    bridge?.kill("SIGKILL");
    if (upstream) {
      await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  });

  it("exposes only the generation-private Unix API over its selected TCP port", async () => {
    const sessionKey = "a".repeat(32);
    const socket = path.join(root, "podman.sock");
    upstream = createServer((peer) => {
      let request = "";
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => {
        request += chunk;
        if (!request.includes("\r\n\r\n")) return;
        peer.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK",
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.once("error", reject);
      upstream!.listen(socket, resolve);
    });

    bridge = spawn(process.execPath, [HOST, "--bridge", socket, sessionKey], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = await new Promise<{ port: number }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(
        () => reject(new Error(`bridge timed out: ${stderr}`)),
        5_000,
      );
      bridge!.stdout!.setEncoding("utf8");
      bridge!.stderr!.setEncoding("utf8");
      bridge!.stderr!.on("data", (chunk) => {
        stderr += chunk;
      });
      bridge!.stdout!.on("data", (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        resolve(JSON.parse(stdout.slice(0, newline)) as { port: number });
      });
      bridge!.once("error", reject);
      bridge!.once("exit", (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timer);
          reject(new Error(`bridge exited ${code}: ${stderr}`));
        }
      });
    });
    expect(ready.port).toBeGreaterThan(0);

    const response = await new Promise<string>((resolve, reject) => {
      const peer = connect({ host: "127.0.0.1", port: ready.port });
      let body = "";
      peer.setEncoding("utf8");
      peer.once("connect", () =>
        peer.end("GET /_ping HTTP/1.1\r\nHost: localhost\r\n\r\n"),
      );
      peer.on("data", (chunk) => {
        body += chunk;
      });
      peer.once("end", () => resolve(body));
      peer.once("error", reject);
    });
    expect(response).toMatch(/\r\n\r\nOK$/);

    const challenge = "b".repeat(64);
    const attestation = await new Promise<string>((resolve, reject) => {
      const peer = connect({ host: "127.0.0.1", port: ready.port });
      let body = "";
      peer.setEncoding("utf8");
      peer.once("connect", () =>
        peer.end(
          `GET /_zeros_zsr/attest/${challenge} HTTP/1.1\r\nHost: localhost\r\n\r\n`,
        ),
      );
      peer.on("data", (chunk) => {
        body += chunk;
      });
      peer.once("end", () => resolve(body));
      peer.once("error", reject);
    });
    expect(attestation).toMatch(
      new RegExp(
        `${createHmac("sha256", sessionKey).update(challenge).digest("hex")}$`,
      ),
    );

    const exit = new Promise<number | null>((resolve) =>
      bridge!.once("exit", resolve),
    );
    bridge.kill("SIGTERM");
    expect(await exit).toBe(0);
    bridge = null;
  });

  it("rejects non-exact bridge paths before listening", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>(
      (resolve) => {
        const child = spawn(
          process.execPath,
          [HOST, "--bridge", "relative", "a".repeat(32)],
          {
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("exit", (code) => resolve({ code, stderr }));
      },
    );
    expect(result.code).toBe(125);
    expect(result.stderr).toContain("absolute path");
  });

  it("relays one exact control-channel stream to the guest bridge", async () => {
    upstream = createServer({ allowHalfOpen: true }, (peer) => {
      let request = "";
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => {
        request += chunk;
      });
      peer.once("end", () => {
        peer.end(
          `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.once("error", reject);
      upstream!.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");

    const relay = spawn(
      process.execPath,
      [HOST, "--relay", String(address.port)],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const request = "GET /_ping HTTP/1.1\r\nHost: localhost\r\n\r\n";
    let stdout = "";
    let stderr = "";
    relay.stdout.setEncoding("utf8");
    relay.stderr.setEncoding("utf8");
    relay.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    relay.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    relay.stdin.end(request);
    const code = await new Promise<number | null>((resolve) =>
      relay.once("exit", resolve),
    );

    expect(code, stderr).toBe(0);
    expect(stdout).toBe(
      `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`,
    );
  });

  it("propagates an upstream half-close without waiting for client input to close", async () => {
    upstream = createServer((peer) => {
      peer.once("data", () => {
        peer.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream!.once("error", reject);
      upstream!.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");

    const relay = spawn(
      process.execPath,
      [HOST, "--relay", String(address.port)],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    relay.stdout.setEncoding("utf8");
    relay.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    relay.stdin.write("GET /_ping HTTP/1.1\r\nHost: localhost\r\n\r\n");

    try {
      const outcome = await Promise.race([
        new Promise<"exited">((resolve) =>
          relay.once("exit", () => resolve("exited")),
        ),
        new Promise<"timed-out">((resolve) =>
          setTimeout(() => resolve("timed-out"), 300),
        ),
      ]);
      expect(outcome).toBe("exited");
      expect(stdout).toBe("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
    } finally {
      relay.stdin.end();
      if (relay.exitCode === null && relay.signalCode === null) {
        relay.kill("SIGKILL");
      }
    }
  });
});
