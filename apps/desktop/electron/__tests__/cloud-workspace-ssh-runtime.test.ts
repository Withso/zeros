import { EventEmitter, once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CloudWorkspaceSshRuntime,
  type SpawnCloudProcess,
} from "../cloud-workspace-ssh-runtime";

const SSH_CREDENTIAL = `ssh_${"a".repeat(40)}`;
const EXPIRES_AT = new Date(Date.now() + 30 * 60_000).toISOString();
const DAYTONA_HOST_KEY =
  "ssh.app.daytona.io ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE3m8wAQ4nU6ax0dPX7dIYJ8Z6JXjT6Jf2sA3x0Xc4Uk";
const roots: string[] = [];

type FakeChild = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  stderr: EventEmitter;
  stdin: PassThrough;
  stdout: PassThrough;
};

function child(): FakeChild {
  const value = new EventEmitter() as FakeChild;
  value.exitCode = null;
  value.signalCode = null;
  value.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      queueMicrotask(() => {
        value.exitCode = 0;
        value.signalCode = typeof signal === "string" ? signal : null;
        value.emit("close", 0, value.signalCode);
      });
    }
    return true;
  });
  value.unref = vi.fn();
  value.stderr = new EventEmitter();
  value.stdin = new PassThrough();
  value.stdout = new PassThrough();
  return value;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-cloud-ssh-test-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  const knownHostsPath = path.join(root, "known_hosts");
  return { root, runtimeRoot, knownHostsPath };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CloudWorkspaceSshRuntime", () => {
  it("fails closed when neither verified pins nor an explicit development TOFU policy exists", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    expect(
      () =>
        new CloudWorkspaceSshRuntime({
          runtimeRoot,
          knownHostsPath,
        }),
    ).toThrow(/host-key policy/i);
  });

  it("rejects a pin that does not cover every allowed gateway", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    expect(
      () =>
        new CloudWorkspaceSshRuntime({
          runtimeRoot,
          knownHostsPath,
          allowedSshHosts: ["ssh.app.daytona.io", "ssh.backup.example"],
          knownHostEntries: [DAYTONA_HOST_KEY],
        }),
    ).toThrow(/host-key policy/i);
  });

  it("pins the deployment-approved gateway key and disables trust on first use", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    const terminalChild = child();
    const spawnProcess = vi.fn((..._args: Parameters<SpawnCloudProcess>) => {
      queueMicrotask(() => {
        terminalChild.emit("spawn");
        terminalChild.exitCode = 0;
        terminalChild.emit("close", 0, null);
      });
      return terminalChild;
    }) as unknown as SpawnCloudProcess;
    const runtime = new CloudWorkspaceSshRuntime({
      runtimeRoot,
      knownHostsPath,
      knownHostEntries: [DAYTONA_HOST_KEY],
      spawn: spawnProcess,
      openBinary: "/usr/bin/open",
    });

    await runtime.launchTerminal({
      sshUsername: SSH_CREDENTIAL,
      sshHost: "ssh.app.daytona.io",
      expiresAt: EXPIRES_AT,
    });

    const args = vi.mocked(spawnProcess).mock.calls[0]![1];
    const wrapper = await readFile(args[2]!, "utf8");
    const configPath = /-F '([^']+)'/.exec(wrapper)?.[1];
    expect(configPath).toBeTruthy();
    const config = await readFile(configPath!, "utf8");
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(config).not.toContain("accept-new");
    expect(await readFile(knownHostsPath, "utf8")).toBe(
      `${DAYTONA_HOST_KEY}\n`,
    );
  });

  it("removes a crash-leftover one-shot credential directory before reuse", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    const stale = path.join(runtimeRoot, "access-ABC123");
    await mkdir(stale, { recursive: true, mode: 0o700 });
    await writeFile(path.join(stale, "config"), SSH_CREDENTIAL, {
      mode: 0o600,
    });
    const terminalChild = child();
    const spawnProcess = vi.fn((..._args: Parameters<SpawnCloudProcess>) => {
      queueMicrotask(() => {
        terminalChild.emit("spawn");
        terminalChild.exitCode = 0;
        terminalChild.emit("close", 0, null);
      });
      return terminalChild;
    }) as unknown as SpawnCloudProcess;
    const runtime = new CloudWorkspaceSshRuntime({
      runtimeRoot,
      knownHostsPath,
      spawn: spawnProcess,
      openBinary: "/usr/bin/open",
      allowTrustOnFirstUse: true,
    });

    await runtime.launchTerminal({
      sshUsername: SSH_CREDENTIAL,
      sshHost: "ssh.app.daytona.io",
      expiresAt: EXPIRES_AT,
    });

    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("opens Terminal through a private one-shot wrapper, not a bearer command line", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    const terminalChild = child();
    const spawnProcess = vi.fn((..._args: Parameters<SpawnCloudProcess>) => {
      queueMicrotask(() => {
        terminalChild.emit("spawn");
        terminalChild.exitCode = 0;
        terminalChild.emit("close", 0, null);
      });
      return terminalChild;
    }) as unknown as SpawnCloudProcess;
    const runtime = new CloudWorkspaceSshRuntime({
      runtimeRoot,
      knownHostsPath,
      spawn: spawnProcess,
      openBinary: "/usr/bin/open",
      allowTrustOnFirstUse: true,
    });

    await runtime.launchTerminal({
      sshUsername: SSH_CREDENTIAL,
      sshHost: "ssh.app.daytona.io",
      expiresAt: EXPIRES_AT,
    });

    const [command, args] = vi.mocked(spawnProcess).mock.calls[0]!;
    expect(command).toBe("/usr/bin/open");
    expect(args.slice(0, 2)).toEqual(["-a", "Terminal"]);
    expect(JSON.stringify(args)).not.toContain(SSH_CREDENTIAL);
    const wrapperPath = args[2]!;
    const wrapper = await readFile(wrapperPath, "utf8");
    expect(wrapper).toContain("/usr/bin/ssh");
    expect(wrapper).not.toContain(`ssh ${SSH_CREDENTIAL}@`);
    expect((await stat(wrapperPath)).mode & 0o777).toBe(0o700);
    const configPath = /-F '([^']+)'/.exec(wrapper)?.[1];
    expect(configPath).toBeTruthy();
    const config = await readFile(configPath!, "utf8");
    expect(config).toContain(`User ${SSH_CREDENTIAL}`);
    expect(config).toContain("HostName ssh.app.daytona.io");
    expect((await stat(configPath!)).mode & 0o777).toBe(0o600);
  });

  it("starts a managed tunnel with exact loopback forwarding and no bearer argv", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    const tunnelChild = child();
    const spawnProcess = vi.fn((..._args: Parameters<SpawnCloudProcess>) => {
      queueMicrotask(() => tunnelChild.emit("spawn"));
      return tunnelChild;
    }) as unknown as SpawnCloudProcess;
    const checkTunnel = vi.fn(async () => true);
    const runtime = new CloudWorkspaceSshRuntime({
      runtimeRoot,
      knownHostsPath,
      spawn: spawnProcess,
      checkTunnel,
      allowTrustOnFirstUse: true,
    });

    const handle = await runtime.startTunnel({
      localHost: "127.0.0.1",
      localPort: 54173,
      remoteHost: "127.0.0.1",
      remotePort: 4173,
      sshUsername: SSH_CREDENTIAL,
      sshHost: "ssh.app.daytona.io",
      expiresAt: EXPIRES_AT,
    });

    const [command, args] = vi.mocked(spawnProcess).mock.calls[0]!;
    expect(command).toBe("/usr/bin/ssh");
    expect(args).toContain("127.0.0.1:54173:127.0.0.1:4173");
    expect(JSON.stringify(args)).not.toContain(SSH_CREDENTIAL);
    expect(checkTunnel).toHaveBeenCalled();
    await handle.stop();
    expect(tunnelChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("atomically selects a loopback port and proxies it through fixed ssh stdio forwarding", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    const proxyChild = child();
    const spawnProcess = vi.fn((..._args: Parameters<SpawnCloudProcess>) => {
      queueMicrotask(() => proxyChild.emit("spawn"));
      return proxyChild;
    }) as unknown as SpawnCloudProcess;
    const runtime = new CloudWorkspaceSshRuntime({
      runtimeRoot,
      knownHostsPath,
      spawn: spawnProcess,
      allowTrustOnFirstUse: true,
    });

    const handle = await runtime.startDynamicTunnel({
      localHost: "127.0.0.1",
      remoteHost: "127.0.0.1",
      remotePort: 47891,
      sshUsername: SSH_CREDENTIAL,
      sshHost: "ssh.app.daytona.io",
      expiresAt: EXPIRES_AT,
    });
    expect(handle.localPort).toBeGreaterThanOrEqual(1_024);
    expect(spawnProcess).not.toHaveBeenCalled();

    const socket = connect({ host: "127.0.0.1", port: handle.localPort });
    await once(socket, "connect");
    await new Promise((resolve) => setImmediate(resolve));
    const [command, args, options] = vi.mocked(spawnProcess).mock.calls[0]!;
    expect(command).toBe("/usr/bin/ssh");
    expect(args).toContain("-W");
    expect(args).toContain("127.0.0.1:47891");
    expect(JSON.stringify(args)).not.toContain(SSH_CREDENTIAL);
    expect(options).toEqual(
      expect.objectContaining({ shell: false, detached: false }),
    );

    socket.destroy();
    await handle.stop();
    expect(proxyChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("launches a supported IDE through a private SSH alias without a bearer argv", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    const ideChild = child();
    const spawnProcess = vi.fn((..._args: Parameters<SpawnCloudProcess>) => {
      queueMicrotask(() => {
        ideChild.emit("spawn");
        ideChild.exitCode = 0;
        ideChild.emit("close", 0, null);
      });
      return ideChild;
    }) as unknown as SpawnCloudProcess;
    const runtime = new CloudWorkspaceSshRuntime({
      runtimeRoot,
      knownHostsPath,
      spawn: spawnProcess,
      allowTrustOnFirstUse: true,
      resolveIdeBinary: vi.fn(async (appId) =>
        appId === "cursor" ? "/Applications/Cursor.app/bin/cursor" : null,
      ),
    });

    await runtime.launchIde({
      appId: "cursor",
      sshUsername: SSH_CREDENTIAL,
      sshHost: "ssh.app.daytona.io",
      expiresAt: EXPIRES_AT,
    });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [binary, args, options] = vi.mocked(spawnProcess).mock.calls[0]!;
    expect(binary).toBe("/Applications/Cursor.app/bin/cursor");
    expect(args).toContain("ssh-remote+zeros-cloud");
    expect(args).toContain("--user-data-dir");
    expect(JSON.stringify(args)).not.toContain(SSH_CREDENTIAL);
    expect(options).toEqual(
      expect.objectContaining({ shell: false, detached: true }),
    );
    const userDataDirectory = args[args.indexOf("--user-data-dir") + 1]!;
    const settings = JSON.parse(
      await readFile(
        path.join(userDataDirectory, "User", "settings.json"),
        "utf8",
      ),
    );
    expect(settings["remote.SSH.configFile"]).toEqual(expect.any(String));
    const config = await readFile(settings["remote.SSH.configFile"], "utf8");
    expect(config).toContain(`User ${SSH_CREDENTIAL}`);
    expect((await stat(settings["remote.SSH.configFile"])).mode & 0o777).toBe(
      0o600,
    );
  });

  it("removes projected IDE credentials immediately when local authority ends", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    const ideChild = child();
    const spawnProcess = vi.fn((..._args: Parameters<SpawnCloudProcess>) => {
      queueMicrotask(() => {
        ideChild.emit("spawn");
        ideChild.exitCode = 0;
        ideChild.emit("close", 0, null);
      });
      return ideChild;
    }) as unknown as SpawnCloudProcess;
    const runtime = new CloudWorkspaceSshRuntime({
      runtimeRoot,
      knownHostsPath,
      spawn: spawnProcess,
      allowTrustOnFirstUse: true,
      resolveIdeBinary: vi.fn(
        async () => "/Applications/Cursor.app/bin/cursor",
      ),
    });

    await runtime.launchIde({
      appId: "cursor",
      sshUsername: SSH_CREDENTIAL,
      sshHost: "ssh.app.daytona.io",
      expiresAt: EXPIRES_AT,
    });
    const args = vi.mocked(spawnProcess).mock.calls[0]![1];
    const userDataDirectory = args[args.indexOf("--user-data-dir") + 1]!;
    const accessDirectory = path.dirname(userDataDirectory);

    await runtime.dispose();

    await expect(stat(accessDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not project a new credential after the runtime is disposed", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    const spawnProcess = vi.fn() as unknown as SpawnCloudProcess;
    const runtime = new CloudWorkspaceSshRuntime({
      runtimeRoot,
      knownHostsPath,
      spawn: spawnProcess,
      allowTrustOnFirstUse: true,
    });

    await runtime.dispose();

    await expect(
      runtime.launchTerminal({
        sshUsername: SSH_CREDENTIAL,
        sshHost: "ssh.app.daytona.io",
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toThrow(/authority.*ended/i);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("erases every projected credential when native launches throw synchronously", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    const spawnProcess = vi.fn(() => {
      throw new Error("native spawn refused");
    }) as unknown as SpawnCloudProcess;
    const runtime = new CloudWorkspaceSshRuntime({
      runtimeRoot,
      knownHostsPath,
      spawn: spawnProcess,
      allowTrustOnFirstUse: true,
      resolveIdeBinary: vi.fn(
        async () => "/Applications/Cursor.app/bin/cursor",
      ),
    });

    await expect(
      runtime.launchTerminal({
        sshUsername: SSH_CREDENTIAL,
        sshHost: "ssh.app.daytona.io",
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toThrow(/spawn refused/i);

    expect(await readdir(runtimeRoot)).toEqual([]);

    await expect(
      runtime.launchIde({
        appId: "cursor",
        sshUsername: SSH_CREDENTIAL,
        sshHost: "ssh.app.daytona.io",
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toThrow(/spawn refused/i);
    expect(await readdir(runtimeRoot)).toEqual([]);

    await expect(
      runtime.startTunnel({
        localHost: "127.0.0.1",
        localPort: 54173,
        remoteHost: "127.0.0.1",
        remotePort: 4173,
        sshUsername: SSH_CREDENTIAL,
        sshHost: "ssh.app.daytona.io",
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toThrow(/spawn refused/i);
    expect(await readdir(runtimeRoot)).toEqual([]);
  });

  it("treats an asynchronously rejected native launch as a failure and erases its credential", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    const rejectedChild = child();
    const spawnProcess = vi.fn((..._args: Parameters<SpawnCloudProcess>) => {
      queueMicrotask(() => {
        rejectedChild.emit("spawn");
        rejectedChild.exitCode = 1;
        rejectedChild.emit("close", 1, null);
      });
      return rejectedChild;
    }) as unknown as SpawnCloudProcess;
    const runtime = new CloudWorkspaceSshRuntime({
      runtimeRoot,
      knownHostsPath,
      spawn: spawnProcess,
      allowTrustOnFirstUse: true,
    });

    await expect(
      runtime.launchTerminal({
        sshUsername: SSH_CREDENTIAL,
        sshHost: "ssh.app.daytona.io",
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toThrow(/launch.*failed/i);
    expect(await readdir(runtimeRoot)).toEqual([]);
  });

  it("fails before spawning on an injected SSH host or privileged port", async () => {
    const { runtimeRoot, knownHostsPath } = await fixture();
    const spawnProcess = vi.fn() as unknown as SpawnCloudProcess;
    const runtime = new CloudWorkspaceSshRuntime({
      runtimeRoot,
      knownHostsPath,
      spawn: spawnProcess,
      allowTrustOnFirstUse: true,
    });

    await expect(
      runtime.startTunnel({
        localHost: "127.0.0.1",
        localPort: 54173,
        remoteHost: "127.0.0.1",
        remotePort: 22,
        sshUsername: SSH_CREDENTIAL,
        sshHost: "ssh.app.daytona.io\nProxyCommand evil",
        expiresAt: EXPIRES_AT,
      }),
    ).rejects.toThrow(/invalid/i);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
