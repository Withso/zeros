import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, connect, type Server } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

const { unsupportedFinalRealpaths } = vi.hoisted(() => ({
  unsupportedFinalRealpaths: new Set<string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: (
      candidate: Parameters<typeof actual.realpathSync>[0],
      options?: Parameters<typeof actual.realpathSync>[1],
    ) => {
      if (unsupportedFinalRealpaths.has(String(candidate))) {
        const error = new Error(
          `EOPNOTSUPP: unknown error, lstat '${String(candidate)}'`,
        ) as NodeJS.ErrnoException;
        error.code = "EOPNOTSUPP";
        error.syscall = "lstat";
        throw error;
      }
      return actual.realpathSync(candidate, options as never);
    },
  };
});

import { ZsrLocalServiceBroker } from "../zsr-service-broker";
import { newTerritoryGeneration } from "../status";

const gpgPath = [
  "/usr/bin/gpg",
  "/opt/homebrew/bin/gpg",
  "/usr/local/bin/gpg",
].find(existsSync);
const gpgconfPath = [
  "/usr/bin/gpgconf",
  "/opt/homebrew/bin/gpgconf",
  "/usr/local/bin/gpgconf",
].find(existsSync);
const socketTmpdir = process.platform === "darwin" ? "/private/tmp" : tmpdir();

function runProgram(
  command: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        reject(
          new Error(
            `${path.basename(command)} failed (${code ?? signal}): ${stderr}`,
          ),
        );
      }
    });
  });
}

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function request(port: number, value: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(1_000, () => socket.destroy(new Error("timeout")));
    socket.once("connect", () => socket.write(value));
    socket.on("data", (chunk) => (response += chunk));
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

describe("ZSR local service broker", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(
      cleanups
        .splice(0)
        .reverse()
        .map((cleanup) => cleanup()),
    );
  });

  it("denies before lease, forwards the exact endpoint, and cuts access on revoke", async () => {
    const target = createServer((peer) => {
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => peer.end(`db:${chunk}`));
    });
    const targetPort = await listen(target);
    cleanups.push(() => close(target));

    const broker = await ZsrLocalServiceBroker.reserve([
      {
        serviceId: "primary-db",
        kind: "database",
        transport: "tcp",
        targetHost: "127.0.0.1",
        targetPort,
        adapter: "postgres",
      },
    ]);
    cleanups.push(() => broker.close());
    const facadePort = broker.facadePorts()[0]!;

    await expect(request(facadePort, "before").catch(() => "")).resolves.toBe(
      "",
    );
    const lease = broker.lease(
      "primary-db",
      "database",
      newTerritoryGeneration(),
    );
    expect(lease.env).toEqual({
      PGHOST: "127.0.0.1",
      PGPORT: String(facadePort),
    });
    await expect(request(facadePort, "live")).resolves.toBe("db:live");

    await lease.revoke();
    await expect(request(facadePort, "after").catch(() => "")).resolves.toBe(
      "",
    );
  });

  it("rejects duplicate ids, wildcard targets, and kind-confused requests", async () => {
    await expect(
      ZsrLocalServiceBroker.reserve([
        {
          serviceId: "unsafe",
          kind: "database",
          transport: "tcp",
          targetHost: "0.0.0.0" as "127.0.0.1",
          targetPort: 5432,
          adapter: "postgres",
        },
      ]),
    ).rejects.toThrow(/loopback/i);

    const broker = await ZsrLocalServiceBroker.reserve([
      {
        serviceId: "one",
        kind: "database",
        transport: "tcp",
        targetHost: "127.0.0.1",
        targetPort: 5432,
        adapter: "generic",
      },
    ]);
    cleanups.push(() => broker.close());
    expect(() =>
      broker.lease("one", "docker", newTerritoryGeneration()),
    ).toThrow(/kind/i);
  });

  it("never forwards a host Docker or Podman control endpoint", async () => {
    await expect(
      ZsrLocalServiceBroker.reserve([
        {
          serviceId: "host-docker",
          kind: "docker",
          transport: "tcp",
          targetHost: "127.0.0.1",
          targetPort: 2375,
          adapter: "docker-tcp",
        },
      ]),
    ).rejects.toThrow(/isolated ZSR container worker/i);
  });

  it("projects an exact Unix service through a private socket and revokes live peers", async () => {
    const root = await mkdtemp(path.join(socketTmpdir, "zsr-svc-unix-"));
    await chmod(root, 0o700);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const targetPath = path.join(root, "agent.sock");
    const target = createServer((peer) => {
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => peer.write(`agent:${chunk}`));
    });
    await new Promise<void>((resolve, reject) => {
      target.once("error", reject);
      target.listen(targetPath, resolve);
    });
    cleanups.push(() => close(target));

    const facadeRoot = path.join(root, "facades");
    await mkdir(facadeRoot, { mode: 0o700 });
    const broker = await ZsrLocalServiceBroker.reserve(
      [
        {
          serviceId: "ssh-agent",
          kind: "ssh-agent",
          transport: "unix",
          targetPath,
          adapter: "ssh-agent",
        },
      ],
      { socketRoot: facadeRoot },
    );
    cleanups.push(() => broker.close());
    expect(broker.facadeUnixSocketPaths()).toHaveLength(1);
    const facade = broker.facadeUnixSocketPaths()[0]!;

    await expect(requestUnix(facade, "before").catch(() => "")).resolves.toBe(
      "",
    );
    const lease = broker.lease(
      "ssh-agent",
      "ssh-agent",
      newTerritoryGeneration(),
    );
    expect(lease.env).toEqual({ SSH_AUTH_SOCK: facade });
    await expect(requestUnix(facade, "live", true)).resolves.toBe("agent:live");

    await lease.revoke();
    await expect(requestUnix(facade, "after").catch(() => "")).resolves.toBe(
      "",
    );
  });

  it("canonicalizes a Unix socket whose runtime cannot realpath the socket vnode", async () => {
    const root = await mkdtemp(path.join(socketTmpdir, "zsr-svc-socket-"));
    await chmod(root, 0o700);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const targetPath = path.join(root, "agent.sock");
    const target = createServer((peer) => peer.end("agent:ready"));
    await new Promise<void>((resolve, reject) => {
      target.once("error", reject);
      target.listen(targetPath, resolve);
    });
    cleanups.push(() => close(target));
    unsupportedFinalRealpaths.add(targetPath);
    cleanups.push(async () => {
      unsupportedFinalRealpaths.delete(targetPath);
    });

    const facadeRoot = path.join(root, "facades");
    await mkdir(facadeRoot, { mode: 0o700 });
    const broker = await ZsrLocalServiceBroker.reserve(
      [
        {
          serviceId: "ssh-agent",
          kind: "ssh-agent",
          transport: "unix",
          targetPath,
          adapter: "ssh-agent",
        },
      ],
      { socketRoot: facadeRoot },
    );
    cleanups.push(() => broker.close());
    expect(broker.facadeUnixSocketPaths()).toHaveLength(1);
  });

  it("projects GPG through a private writable home without copying private key material", async () => {
    const root = await mkdtemp(path.join(socketTmpdir, "zsr-svc-gpg-"));
    await chmod(root, 0o700);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const sourceHome = path.join(root, "source-gnupg");
    await mkdir(path.join(sourceHome, "private-keys-v1.d"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(path.join(sourceHome, "pubring.kbx"), "public-keys\n", {
      mode: 0o600,
    });
    await writeFile(path.join(sourceHome, "trustdb.gpg"), "trust\n", {
      mode: 0o600,
    });
    await writeFile(
      path.join(sourceHome, "private-keys-v1.d", "secret.key"),
      "never-copy\n",
      { mode: 0o600 },
    );
    await writeFile(path.join(root, "outside.conf"), "never-follow\n");
    await symlink(
      path.join(root, "outside.conf"),
      path.join(sourceHome, "gpg.conf"),
    );

    const targetPath = path.join(sourceHome, "S.gpg-agent");
    const target = createServer((peer) => {
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => peer.write(`gpg:${chunk}`));
    });
    await new Promise<void>((resolve, reject) => {
      target.once("error", reject);
      target.listen(targetPath, resolve);
    });
    cleanups.push(() => close(target));

    const facadeRoot = path.join(root, "facades");
    const clientStateRoot = path.join(root, "client-state");
    await Promise.all([
      mkdir(facadeRoot, { mode: 0o700 }),
      mkdir(clientStateRoot, { mode: 0o700 }),
    ]);
    const broker = await ZsrLocalServiceBroker.reserve(
      [
        {
          serviceId: "gpg-agent",
          kind: "gpg-agent",
          transport: "unix",
          targetPath,
          adapter: "gpg-agent",
          sourceHome,
        },
      ],
      { socketRoot: facadeRoot, clientStateRoot },
    );
    cleanups.push(() => broker.close());

    const lease = broker.lease(
      "gpg-agent",
      "gpg-agent",
      newTerritoryGeneration(),
    );
    const projectedHome = lease.env.GNUPGHOME!;
    const projectedSocket = path.join(projectedHome, "S.gpg-agent");
    expect(lease.env).toEqual({
      GNUPGHOME: projectedHome,
      GPG_AGENT_INFO: `${projectedSocket}:0:1`,
    });
    expect(broker.clientWritableRoots()).toEqual([projectedHome]);
    expect(
      await readFile(path.join(projectedHome, "pubring.kbx"), "utf8"),
    ).toBe("public-keys\n");
    expect(
      await readFile(path.join(projectedHome, "trustdb.gpg"), "utf8"),
    ).toBe("trust\n");
    await expect(
      access(path.join(projectedHome, "private-keys-v1.d", "secret.key")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(path.join(projectedHome, "gpg.conf")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(projectedSocket)).isSymbolicLink()).toBe(true);
    expect(await realpath(projectedSocket)).toBe(
      broker.facadeUnixSocketPaths()[0],
    );
    await expect(requestUnix(projectedSocket, "sign", true)).resolves.toBe(
      "gpg:sign",
    );

    await lease.revoke();
    await expect(
      requestUnix(projectedSocket, "after").catch(() => ""),
    ).resolves.toBe("");
  });

  it.runIf(gpgPath && gpgconfPath)(
    "signs with a real host GPG agent through the sanitized façade",
    async () => {
      const root = await mkdtemp(path.join(socketTmpdir, "zsr-svc-real-gpg-"));
      await chmod(root, 0o700);
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const sourceHome = path.join(root, "source-gnupg");
      const facadeRoot = path.join(root, "facades");
      const clientStateRoot = path.join(root, "client-state");
      await Promise.all(
        [sourceHome, facadeRoot, clientStateRoot].map((directory) =>
          mkdir(directory, { mode: 0o700 }),
        ),
      );
      cleanups.push(async () => {
        await runProgram(gpgconfPath!, [
          "--homedir",
          sourceHome,
          "--kill",
          "gpg-agent",
        ]).catch(() => undefined);
      });

      await runProgram(gpgPath!, [
        "--homedir",
        sourceHome,
        "--batch",
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        "",
        "--quick-generate-key",
        "Zeros Boundary Test <zsr-gpg@example.invalid>",
        "ed25519",
        "sign",
        "1d",
      ]);
      const { stdout: agentSocketOutput } = await runProgram(gpgconfPath!, [
        "--homedir",
        sourceHome,
        "--list-dirs",
        "agent-socket",
      ]);
      const targetPath = agentSocketOutput.trim();
      expect((await lstat(targetPath)).isSocket()).toBe(true);

      const broker = await ZsrLocalServiceBroker.reserve(
        [
          {
            serviceId: "real-gpg-agent",
            kind: "gpg-agent",
            transport: "unix",
            targetPath,
            adapter: "gpg-agent",
            sourceHome,
          },
        ],
        { socketRoot: facadeRoot, clientStateRoot },
      );
      cleanups.push(() => broker.close());
      const lease = broker.lease(
        "real-gpg-agent",
        "gpg-agent",
        newTerritoryGeneration(),
      );
      const payload = path.join(root, "payload.txt");
      const signature = path.join(root, "payload.sig");
      await writeFile(payload, "signed through a ZSR façade\n");
      await runProgram(gpgPath!, [
        "--homedir",
        lease.env.GNUPGHOME!,
        "--batch",
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        "",
        "--local-user",
        "zsr-gpg@example.invalid",
        "--output",
        signature,
        "--detach-sign",
        payload,
      ]);
      await expect(
        runProgram(gpgPath!, [
          "--homedir",
          lease.env.GNUPGHOME!,
          "--batch",
          "--verify",
          signature,
          payload,
        ]),
      ).resolves.toMatchObject({
        stderr: expect.stringContaining("Good signature"),
      });
      await expect(
        access(path.join(lease.env.GNUPGHOME!, "private-keys-v1.d")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await lease.revoke();
    },
    30_000,
  );

  it("rejects non-socket Unix targets and socket roots with broad permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-service-invalid-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const facadeRoot = path.join(root, "facades");
    await mkdir(facadeRoot, { mode: 0o755 });
    await expect(
      ZsrLocalServiceBroker.reserve(
        [
          {
            serviceId: "bad",
            kind: "ssh-agent",
            transport: "unix",
            targetPath: root,
            adapter: "ssh-agent",
          },
        ],
        { socketRoot: facadeRoot },
      ),
    ).rejects.toThrow(/private|socket/i);
  });

  it("rejects templates that replace a typed adapter's scoped endpoint", async () => {
    await expect(
      ZsrLocalServiceBroker.reserve([
        {
          serviceId: "override",
          kind: "database",
          transport: "tcp",
          targetHost: "127.0.0.1",
          targetPort: 5432,
          adapter: "postgres",
          environment: { PGHOST: "raw-host.example" },
        },
      ]),
    ).rejects.toThrow(/reserved.*PGHOST/i);
  });
});

function requestUnix(
  socketPath: string,
  value: string,
  waitForReply = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(1_000, () => socket.destroy(new Error("timeout")));
    socket.once("connect", () => socket.write(value));
    socket.on("data", (chunk) => {
      response += chunk;
      if (waitForReply) socket.end();
    });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}
