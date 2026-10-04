import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { WebSocketServer, createWebSocketStream } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSshSession } from "../../src/engine/transport/cloud-ssh-session.mjs";
import { CloudWorkspaceNativeSshRuntime } from "../cloud-workspace-ssh-runtime";
import { CloudRuntimeServiceTransport } from "../cloud-runtime-service-transport";
import type { CloudRuntimeServiceAccess } from "../cloud-runtime-service-client";

const cleanups: Array<() => Promise<unknown>> = [];
const sftpServer = [
  "/usr/lib/openssh/sftp-server",
  "/usr/libexec/openssh/sftp-server",
  "/usr/libexec/sftp-server",
].find(existsSync);
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(mismatch = false, runtimeDirectory = "native") {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-native-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    handleProtocols: () => "zeros.service.v1",
  });
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.on("connection", (socket) => {
    const stream = createWebSocketStream(socket);
    const session = createCloudSshSession(stream, {
      cwd: root,
      env: { PATH: "/usr/bin:/bin", HOME: root, LANG: "C.UTF-8" },
      sftpServer,
    });
    // Introduce a different valid key to exercise OpenSSH's actual host verifier.
    const other = mismatch
      ? createCloudSshSession(
          new Duplex({
            read() {},
            write(_chunk, _encoding, done) {
              done();
            },
          }),
          { cwd: root, env: {} },
        )
      : session;
    socket.send(
      JSON.stringify({
        version: 1,
        kind: "ssh",
        publicKey: other.publicKey.trim(),
        hostKeySha256: other.hostKeySha256,
      }),
    );
    if (mismatch) other.close();
    session.start();
    socket.on("close", () => session.close());
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const transport = new CloudRuntimeServiceTransport({
    baseUrl: origin,
    allowInsecureLoopback: true,
  });
  cleanups.push(() => transport.dispose());
  const runtime = new CloudWorkspaceNativeSshRuntime({
    runtimeRoot: path.join(root, runtimeDirectory),
    transport,
  });
  cleanups.push(() => runtime.dispose());
  const access: CloudRuntimeServiceAccess = {
    grant: {
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      generation: 7,
      kind: "ssh",
      deviceId: "44444444-4444-4444-8444-444444444444",
      remotePort: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    deviceKeyVersion: 1,
    transport: {
      version: 1,
      url: `${origin.replace("http:", "ws:")}/v1/cloud-workspaces/services/ssh/33333333-3333-4333-8333-333333333333`,
      capability: `zsh_${"a".repeat(43)}`,
      headerName: "x-zeros-runtime-service",
      protocol: "zeros.service.v1",
    },
    ssh: { username: "zeros", hostKey: "stream-introduction" },
  };
  return { root, runtime, access, server };
}

function run(command: string, args: string[], input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    },
  );
}

describe("native OpenSSH adapter", () => {
  it("lazily introduces a per-stream key, preserves exec stderr/exit, and erases one-use files on close", async () => {
    const { root, runtime, access, server } = await fixture();
    const handle = await runtime.prepare(access);
    expect(server.clients.size).toBe(0);
    expect(handle.command.includes(access.transport.capability)).toBe(false);
    const config = await readFile(handle.configPath, "utf8");
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(config).toContain("IdentityAgent none");
    expect(config).toContain("ClearAllForwardings yes");
    expect(config.includes(access.transport.capability)).toBe(false);
    expect((await stat(path.dirname(handle.configPath))).mode & 0o777).toBe(
      0o700,
    );
    const result = await run("/usr/bin/ssh", [
      "-F",
      handle.configPath,
      "zeros-cloud",
      "printf stdout; printf stderr >&2; exit 17",
    ]);
    expect(result).toEqual({ code: 17, stdout: "stdout", stderr: "stderr" });
    await handle.closed;
    expect(await readdir(path.join(root, "native"))).toEqual([]);
    expect(
      (
        await run("/usr/bin/ssh", [
          "-F",
          handle.configPath,
          "zeros-cloud",
          "true",
        ])
      ).code,
    ).not.toBe(0);
  });

  it("refuses a valid introduction whose key disagrees with the SSH handshake", async () => {
    const { root, runtime, access } = await fixture(true);
    const handle = await runtime.prepare(access);
    const result = await run("/usr/bin/ssh", [
      "-F",
      handle.configPath,
      "zeros-cloud",
      "touch must-not-exist",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Host key verification failed/);
    await expect(stat(path.join(root, "must-not-exist"))).rejects.toThrow();
    await handle.closed;
  });

  it.skipIf(!sftpServer)(
    "supports an SFTP file roundtrip through the same pinned private adapter",
    async () => {
      const { root, runtime, access } = await fixture();
      await writeFile(path.join(root, "source"), "SFTP roundtrip\n");
      const handle = await runtime.prepare(access);
      const result = await run(
        "/usr/bin/sftp",
        ["-b", "-", "-F", handle.configPath, "zeros-cloud"],
        `put ${path.join(root, "source")} uploaded\nget uploaded ${path.join(root, "download")}\nbye\n`,
      );
      expect(result.code).toBe(0);
      expect(await readFile(path.join(root, "download"), "utf8")).toBe(
        "SFTP roundtrip\n",
      );
      await handle.closed;
    },
  );

  it("retires an unused command at expiry without ever starting a remote worker", async () => {
    const { runtime, access, server } = await fixture();
    access.grant.expiresAt = new Date(Date.now() + 100).toISOString();
    const handle = await runtime.prepare(access);
    await handle.closed;
    expect(server.clients.size).toBe(0);
    await expect(stat(handle.configPath)).rejects.toThrow();
  });

  it("cancels an in-flight introduction and never publishes after disposal", async () => {
    const { runtime, access, server } = await fixture();
    server.removeAllListeners("connection");
    const handle = await runtime.prepare(access);
    const connecting = once(server, "connection");
    const result = run("/usr/bin/ssh", ["-F", handle.configPath, "zeros-cloud", "true"]);
    await connecting;
    await runtime.dispose();
    await handle.closed;
    expect((await result).code).not.toBe(0);
    await expect(runtime.prepare(access)).rejects.toThrow(/ended|closed/);
  });

  it("handles spaces and long Mac application paths with a private short socket", async () => {
    const { runtime, access } = await fixture(false, `Application Support/Zeros Alpha/${"nested/".repeat(15)}`);
    const handle = await runtime.prepare(access);
    expect(Buffer.byteLength(handle.configPath)).toBeGreaterThan(104);
    const result = await run("/usr/bin/ssh", ["-F", handle.configPath, "zeros-cloud", "printf connected"]);
    expect(result).toEqual({ code: 0, stdout: "connected", stderr: "" });
    await handle.closed;
    await expect(stat(handle.configPath)).rejects.toThrow();
  });
});
