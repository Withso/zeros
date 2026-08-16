import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attestOrbStackCli,
  createOrbStackCommandRunner,
  deleteOrbStackMachineAndProve,
  findOrbStackCli,
  MacosContainerWorkerUnavailableError,
  MacosOrbStackContainerWorker,
  orbStackMachineName,
  recoverOrphanedOrbStackMachines,
  validateOrbStackMachineInfo,
  type OrbStackCommandRunner,
} from "../macos-orbstack-container-worker";
import { ORBSTACK_MACHINE_RECOVERY_HOLD_FILE } from "../../session-paths";
import type { TerritoryGeneration } from "../types";

function generation(value: string): TerritoryGeneration {
  return value as TerritoryGeneration;
}

describe("macOS OrbStack container worker", () => {
  let root: string;
  let workspace: string;
  let session: string;
  let orb: string;
  let cloudInit: string;
  let host: string;
  let worker: string;
  let internal: Server | null;
  let internalPeers: Set<Socket>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "zeros-orbstack-worker-test-"));
    workspace = path.join(root, "workspace");
    session = path.join(root, "session");
    orb = path.join(root, "orb");
    cloudInit = path.join(root, "cloud-init.yaml");
    host = path.join(root, "host.mjs");
    worker = path.join(root, "worker.mjs");
    await Promise.all([
      mkdir(path.join(workspace, ".git"), { recursive: true }),
      mkdir(path.join(workspace, "Zeros Design"), { recursive: true }),
      mkdir(path.join(session, "git"), { recursive: true }),
      writeFile(orb, "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
      writeFile(cloudInit, "#cloud-config\n", { mode: 0o600 }),
      writeFile(host, "// host\n", { mode: 0o600 }),
      writeFile(worker, "// worker\n", { mode: 0o600 }),
    ]);
    await chmod(orb, 0o700);
    internal = null;
    internalPeers = new Set();
  });

  afterEach(async () => {
    if (internal) {
      for (const peer of internalPeers) peer.destroy();
      await new Promise<void>((resolve) => internal!.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  });

  function machineInfo(
    name: string,
    mounts: readonly string[],
    state = "running",
  ) {
    return {
      record: {
        name,
        state,
        image: {
          distro: "ubuntu",
          version: "noble",
          arch: process.arch === "arm64" ? "arm64" : "amd64",
        },
        config: {
          isolated: true,
          isolate_network: true,
          forward_ssh_agent: false,
          default_username: "zeros-agent",
          mounts: mounts.map((mount) => ({
            source: mount,
            destination: mount,
          })),
          memory_limit_mib: 3_072,
          cpu_limit: 2,
          disk_limit_bytes: 16 * 1024 * 1024 * 1024,
        },
      },
      // The controller must use OrbStack's supported localhost forwarding,
      // not this machine-private address.
      ip4: "127.0.0.2",
    };
  }

  function fakeRunner(
    machineName: string,
    mounts: readonly string[],
    internalPort: number,
    behavior: {
      cloudInitFailures?: number;
      createRpcFailureAfterCreation?: boolean;
      infoMissingFailures?: number;
      initialMachineState?: "stopped";
      orbVersion?: string;
      runtimeMarker?: string;
      userReadyFailures?: number;
    } = {},
  ): OrbStackCommandRunner & { calls: string[][] } {
    const calls: string[][] = [];
    let cloudInitChecks = 0;
    let infoChecks = 0;
    let machineDeleted = false;
    let machineStarted = behavior.initialMachineState !== "stopped";
    let userReadyChecks = 0;
    const assetByDestination = new Map([
      ["/opt/zeros-zsr/zsr-orbstack-container-host.mjs", host],
      ["/opt/zeros-zsr/zsr-container-worker.mjs", worker],
    ]);
    return {
      calls,
      run: async (args, options = {}) => {
        calls.push([...args]);
        if (args[0] === "status") {
          return { code: 0, stdout: "Running\n", stderr: "" };
        }
        if (args[0] === "version") {
          return {
            code: 0,
            stdout: `Version: ${behavior.orbVersion ?? "2.2.1"} (2020100)\nCommit: test (v2.2.1)\n`,
            stderr: "",
          };
        }
        if (args[0] === "create" && behavior.createRpcFailureAfterCreation) {
          if (!options.allowFailure) {
            throw new Error(
              'OrbStack command "create" failed; diagnostics were redacted',
            );
          }
          return { code: 125, stdout: "", stderr: "control RPC EOF" };
        }
        if (args[0] === "start" && args.length === 2) {
          machineStarted = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "delete") {
          machineDeleted = true;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "list") {
          return {
            code: 0,
            stdout: JSON.stringify(
              machineDeleted ? [] : [machineInfo(machineName, mounts)],
            ),
            stderr: "",
          };
        }
        if (args[0] === "info") {
          infoChecks += 1;
          if (infoChecks <= (behavior.infoMissingFailures ?? 0)) {
            return { code: 1, stdout: "", stderr: "missing" };
          }
          return {
            code: 0,
            stdout: JSON.stringify(
              machineInfo(
                machineName,
                mounts,
                machineStarted ? "running" : "stopped",
              ),
            ),
            stderr: "",
          };
        }
        if (args.includes("cloud-init")) {
          cloudInitChecks += 1;
          if (cloudInitChecks <= (behavior.cloudInitFailures ?? 0)) {
            if (!options.allowFailure) {
              throw new Error(
                'OrbStack command "cloud-init" failed; diagnostics were redacted',
              );
            }
            return { code: 125, stdout: "", stderr: "not ready" };
          }
          return { code: 0, stdout: "status: done\n", stderr: "" };
        }
        if (args.includes("/usr/bin/getent")) {
          userReadyChecks += 1;
          if (userReadyChecks <= (behavior.userReadyFailures ?? 0)) {
            return { code: 2, stdout: "", stderr: "not ready" };
          }
          return {
            code: 0,
            stdout: `zeros-agent:x:${process.getuid?.() ?? 501}:501::/home/zeros-agent:/bin/bash\n`,
            stderr: "",
          };
        }
        if (args.includes("/bin/cat")) {
          return {
            code: 0,
            stdout:
              behavior.runtimeMarker ??
              '{"version":1,"backend":"orbstack-rootless-podman","distribution":"ubuntu-24.04"}\n',
            stderr: "",
          };
        }
        if (args.includes("/usr/bin/sha256sum")) {
          const source = assetByDestination.get(args.at(-1)!);
          if (!source) throw new Error("unexpected attestation target");
          const digest = createHash("sha256")
            .update(
              await import("node:fs/promises").then((fs) =>
                fs.readFile(source),
              ),
            )
            .digest("hex");
          return {
            code: 0,
            stdout: `${digest}  ${args.at(-1)}\n`,
            stderr: "",
          };
        }
        if (args.includes("--recover")) {
          return {
            code: 0,
            stdout: '{"version":1,"recovered":0}\n',
            stderr: "",
          };
        }
        if (options.allowFailure) {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      spawn: (args): ChildProcess => {
        calls.push([...args]);
        return spawn(
          process.execPath,
          [
            "-e",
            `process.stdout.write(JSON.stringify({version:1,ready:true,port:${internalPort}})+'\\n'); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000)`,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
      },
    };
  }

  it("attests an exact isolated machine and proxies only its private API", async () => {
    const sessionKey = "c".repeat(32);
    internal = createServer({ allowHalfOpen: true }, (peer) => {
      internalPeers.add(peer);
      peer.once("close", () => internalPeers.delete(peer));
      let request = "";
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => {
        request += chunk;
      });
      peer.once("end", () => {
        if (!request.includes("\r\n\r\n")) {
          peer.destroy(new Error("incomplete request"));
          return;
        }
        const attestation =
          /^GET \/_zeros_zsr\/attest\/([a-f0-9]{64}) HTTP\/1\.[01]/.exec(
            request,
          );
        if (attestation) {
          const proof = createHmac("sha256", sessionKey)
            .update(attestation[1])
            .digest("hex");
          peer.end(`HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n${proof}`);
          return;
        }
        peer.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
      });
    });
    await new Promise<void>((resolve, reject) => {
      internal!.once("error", reject);
      internal!.listen(0, "127.0.0.1", resolve);
    });
    const address = internal.address();
    if (!address || typeof address === "string") throw new Error("no port");

    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("execution", mounts);
    const runner = fakeRunner(machineName, mounts, address.port);
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
      forwardedBridgeTimeoutMs: 100,
      sessionKeyFactory: () => sessionKey,
    });
    const lease = await controller.reserve({
      executionId: "execution",
      workspaceRoot: workspace,
      sessionRoot: session,
    });
    await lease.start({
      generation: generation("abcdefghijklmnopqrstuvwx"),
      protectedRoots: [path.join(workspace, "Zeros Design")],
      gitProjections: [
        {
          source: path.join(session, "git"),
          destination: path.join(workspace, ".git"),
          readOnly: false,
        },
      ],
    });

    const response = await new Promise<string>((resolve, reject) => {
      const peer = connect({ host: "127.0.0.1", port: lease.hostPort });
      let value = "";
      peer.setEncoding("utf8");
      peer.once("connect", () => peer.end("GET /_ping HTTP/1.1\r\n\r\n"));
      peer.on("data", (chunk) => {
        value += chunk;
      });
      peer.once("end", () => resolve(value));
      peer.once("error", reject);
    });
    expect(response).toMatch(/\r\n\r\nOK$/);
    expect(lease.environment).toEqual({
      DOCKER_HOST: `tcp://127.0.0.1:${lease.hostPort}`,
      CONTAINER_HOST: `tcp://127.0.0.1:${lease.hostPort}`,
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(session, ORBSTACK_MACHINE_RECOVERY_HOLD_FILE),
          "utf8",
        ),
      ),
    ).toMatchObject({
      version: 2,
      executionId: "execution",
      machineName,
      ownerPid: process.pid,
    });

    const launch = runner.calls.find((args) => args.includes("--descriptor"));
    if (!launch) throw new Error("worker was not launched");
    const descriptor = JSON.parse(await readFile(launch.at(-1)!, "utf8")) as {
      uid?: unknown;
      gid?: unknown;
      gitProjections?: unknown;
    };
    expect(descriptor.uid).toBe(process.getuid?.() ?? -1);
    expect(descriptor.gid).toBe(501);
    expect(descriptor.gitProjections).toEqual([
      {
        source: path.join(session, "git"),
        destination: path.join(workspace, ".git"),
        readOnly: false,
      },
    ]);

    await lease.stopAndProve();
    expect(runner.calls.some((args) => args.includes("--recover"))).toBe(true);
    expect(
      runner.calls.some(
        (args) => args[0] === "delete" && args.includes(machineName),
      ),
    ).toBe(true);
    expect(runner.calls.some((args) => args[0] === "push")).toBe(false);
    expect(
      runner.calls.some(
        (args) =>
          args.includes("/usr/bin/install") &&
          args.some((value) => value.startsWith(`${session}${path.sep}`)),
      ),
    ).toBe(true);
    expect(
      (await readdir(session)).filter((entry) =>
        entry.startsWith("orbstack-runtime-asset-"),
      ),
    ).toEqual([]);
    expect(await readdir(session)).not.toContain(
      ORBSTACK_MACHINE_RECOVERY_HOLD_FILE,
    );
  });

  it("rejects a loopback collision that only mimics Podman ping", async () => {
    internal = createServer({ allowHalfOpen: true }, (peer) => {
      internalPeers.add(peer);
      peer.once("close", () => internalPeers.delete(peer));
      peer.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
    });
    await new Promise<void>((resolve, reject) => {
      internal!.once("error", reject);
      internal!.listen(0, "127.0.0.1", resolve);
    });
    const address = internal.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("forward-collision", mounts);
    const runner = fakeRunner(machineName, mounts, address.port);
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
      forwardedBridgeTimeoutMs: 100,
    });
    const lease = await controller.reserve({
      executionId: "forward-collision",
      workspaceRoot: workspace,
      sessionRoot: session,
    });

    try {
      await expect(
        lease.start({
          generation: generation("forwardcollisiongeneration"),
          protectedRoots: [path.join(workspace, "Zeros Design")],
          gitProjections: [],
        }),
      ).rejects.toThrow(/forwarding did not become ready/);
    } finally {
      await lease.stopAndProve();
    }
    expect(
      runner.calls.some(
        (args) => args[0] === "delete" && args.includes(machineName),
      ),
    ).toBe(true);
  });

  it("rejects a machine that exposes host integration or a broader mount", () => {
    const name = orbStackMachineName("execution", [workspace, session]);
    const info = machineInfo(name, [workspace, session]);
    expect(() =>
      validateOrbStackMachineInfo(
        {
          ...info,
          record: {
            ...info.record,
            config: { ...info.record.config, forward_ssh_agent: true },
          },
        },
        name,
        [workspace, session],
      ),
    ).toThrow(/attestation/);
    expect(() =>
      validateOrbStackMachineInfo(info, name, [root, workspace, session]),
    ).toThrow(/attestation/);
  });

  it("finds only a physical executable and derives a stable mount identity", () => {
    expect(findOrbStackCli({ PATH: root, HOME: root })).toBeNull();
    expect(
      findOrbStackCli({ PATH: root, HOME: root }, (candidate) => candidate),
    ).toBe(orb);
    expect(orbStackMachineName("execution", [session, workspace])).toBe(
      orbStackMachineName("execution", [workspace, session]),
    );
    expect(() => orbStackMachineName("bad/id", [workspace])).toThrow(
      /execution id/,
    );
  });

  it("requires OrbStack's Apple-issued signing chain instead of trusting display text", async () => {
    const candidate = path.join(
      root,
      "OrbStack.app",
      "Contents",
      "MacOS",
      "scli.app",
      "Contents",
      "MacOS",
      "scli",
    );
    await mkdir(path.dirname(candidate), { recursive: true });
    await writeFile(candidate, "#!/bin/sh\n", { mode: 0o700 });
    await chmod(candidate, 0o700);
    const calls: string[][] = [];
    const verifier = (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      return {
        status: 0,
        stdout: "",
        stderr:
          args[0] === "-d"
            ? "Identifier=dev.kdrag0n.MacVirt.scli\nTeamIdentifier=HUAQ24HBR6\n"
            : "",
      };
    };

    expect(attestOrbStackCli(candidate, verifier, "darwin")).toBe(candidate);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain(
      '-R=anchor apple generic and identifier "dev.kdrag0n.MacVirt.scli" and certificate leaf[subject.OU] = "HUAQ24HBR6"',
    );

    const spoofedVerifier = (_command: string, args: readonly string[]) => ({
      status: args.some((arg) => arg.startsWith("-R=")) ? 1 : 0,
      stdout: "",
      stderr:
        args[0] === "-d"
          ? "Identifier=dev.kdrag0n.MacVirt.scli\nTeamIdentifier=HUAQ24HBR6\n"
          : "",
    });
    expect(() =>
      attestOrbStackCli(candidate, spoofedVerifier, "darwin"),
    ).toThrow(/code-signing identity is untrusted/);
  });

  it("reports only the safe OrbStack operation when a command fails", async () => {
    const failingOrb = path.join(root, "failing-orb");
    await writeFile(
      failingOrb,
      "#!/bin/sh\nprintf 'private-path=%s\\n' \"$2\" >&2\nexit 23\n",
      { mode: 0o700 },
    );
    await chmod(failingOrb, 0o700);
    const runner = createOrbStackCommandRunner(failingOrb);

    await expect(
      runner.run(["push", "-m", "machine", "/private/source", "/private/dest"]),
    ).rejects.toThrow(
      'OrbStack command "push" failed; diagnostics were redacted',
    );
    await expect(
      runner.run(["-m", "machine", "-u", "root", "/private/executable"]),
    ).rejects.toThrow(
      'OrbStack command "machine-exec" failed; diagnostics were redacted',
    );
    await expect(
      runner.run([
        "-m",
        "machine",
        "-u",
        "root",
        "/usr/bin/install",
        "/private/source",
        "/private/destination",
      ]),
    ).rejects.toThrow(
      'OrbStack command "runtime-install" failed; diagnostics were redacted',
    );
  });

  it("preserves the orb multicall identity while spawning its physical target", async () => {
    const runner = createOrbStackCommandRunner(process.execPath);
    const result = await runner.run([
      "-e",
      "process.stdout.write(process.argv0)",
    ]);

    expect(result.stdout).toBe("orb");
  });

  it("waits for OrbStack to publish the runtime user before provisioning", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("user-readiness", mounts);
    const runner = fakeRunner(machineName, mounts, 1, {
      userReadyFailures: 2,
    });
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
    });

    const lease = await controller.reserve({
      executionId: "user-readiness",
      workspaceRoot: workspace,
      sessionRoot: session,
    });
    await lease.stopAndProve();

    expect(
      runner.calls.filter((args) => args.includes("/usr/bin/getent")),
    ).toHaveLength(3);
  });

  it("retries cloud-init when a newly created guest is not ready for exec", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("guest-readiness", mounts);
    const runner = fakeRunner(machineName, mounts, 1, {
      cloudInitFailures: 2,
      infoMissingFailures: 1,
    });
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
    });

    const lease = await controller.reserve({
      executionId: "guest-readiness",
      workspaceRoot: workspace,
      sessionRoot: session,
    });
    await lease.stopAndProve();

    expect(
      runner.calls.filter((args) => args.includes("cloud-init")),
    ).toHaveLength(3);
    expect(runner.calls.some((args) => args[0] === "create")).toBe(true);
  });

  it("recovers when OrbStack loses its control RPC after creating the exact machine", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("create-rpc-recovery", mounts);
    const runner = fakeRunner(machineName, mounts, 1, {
      createRpcFailureAfterCreation: true,
      infoMissingFailures: 1,
    });
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
    });

    const lease = await controller.reserve({
      executionId: "create-rpc-recovery",
      workspaceRoot: workspace,
      sessionRoot: session,
    });
    await lease.stopAndProve();

    expect(runner.calls.some((args) => args[0] === "create")).toBe(true);
    expect(runner.calls.filter((args) => args[0] === "info")).toHaveLength(3);
  });

  it("deletes a newly created machine when runtime admission fails", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("failed-admission", mounts);
    const runner = fakeRunner(machineName, mounts, 1, {
      infoMissingFailures: 1,
      runtimeMarker: "stale\n",
    });
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
    });

    await expect(
      controller.reserve({
        executionId: "failed-admission",
        workspaceRoot: workspace,
        sessionRoot: session,
      }),
    ).rejects.toMatchObject({
      name: MacosContainerWorkerUnavailableError.name,
      reason: "private-runtime-unavailable",
    });
    expect(
      runner.calls.some(
        (args) => args[0] === "delete" && args.includes(machineName),
      ),
    ).toBe(true);
  });

  it("deletes the admitted machine if its host proxy cannot reserve a port", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("proxy-bind-failure", mounts);
    const runner = fakeRunner(machineName, mounts, 1);
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
      reserveHostPort: async () => {
        throw new Error("synthetic loopback bind failure");
      },
    });

    await expect(
      controller.reserve({
        executionId: "proxy-bind-failure",
        workspaceRoot: workspace,
        sessionRoot: session,
      }),
    ).rejects.toMatchObject({
      name: MacosContainerWorkerUnavailableError.name,
      reason: "private-runtime-unavailable",
    });
    expect(
      runner.calls.some(
        (args) => args[0] === "delete" && args.includes(machineName),
      ),
    ).toBe(true);
    expect(await readdir(session)).not.toContain(
      ORBSTACK_MACHINE_RECOVERY_HOLD_FILE,
    );
  });

  it("refuses a new sparse VM before OrbStack exhausts the host volume", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("low-disk", mounts);
    const runner = fakeRunner(machineName, mounts, 1, {
      infoMissingFailures: 1,
    });
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
      freeDiskBytes: () => 512n * 1024n * 1024n,
    });

    await expect(
      controller.reserve({
        executionId: "low-disk",
        workspaceRoot: workspace,
        sessionRoot: session,
      }),
    ).rejects.toThrow(/at least 4 GiB free/);
    expect(runner.calls.some((args) => args[0] === "create")).toBe(false);
  });

  it("proves deletion from a successful inventory even when delete loses its RPC reply", async () => {
    const machineName = orbStackMachineName("delete-rpc-recovery", [workspace]);
    const calls: string[][] = [];
    const runner: OrbStackCommandRunner = {
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "delete") {
          return { code: 125, stdout: "", stderr: "control RPC EOF" };
        }
        return { code: 0, stdout: "[]", stderr: "" };
      },
      spawn: () => {
        throw new Error("unexpected spawn");
      },
    };

    await expect(
      deleteOrbStackMachineAndProve(runner, machineName),
    ).resolves.toBeUndefined();
    expect(calls.map((args) => args[0])).toEqual(["delete", "list"]);
    await expect(
      deleteOrbStackMachineAndProve(runner, "personal-machine"),
    ).rejects.toThrow(/non-ZSR/);
  });

  it("deletes and clears a valid crash-recovery hold before session GC", async () => {
    const recoverySession = path.join(root, "orphan");
    await mkdir(recoverySession);
    const mounts = [workspace, recoverySession].sort(
      (left, right) => left.length - right.length || left.localeCompare(right),
    );
    const machineName = orbStackMachineName("orphan", mounts);
    await writeFile(
      path.join(recoverySession, ORBSTACK_MACHINE_RECOVERY_HOLD_FILE),
      `${JSON.stringify({
        version: 1,
        executionId: "orphan",
        machineName,
        mountRoots: mounts,
      })}\n`,
      { mode: 0o600 },
    );
    const runner = fakeRunner(machineName, mounts, 1);

    await expect(
      recoverOrphanedOrbStackMachines({ sessionsRoot: root, runner }),
    ).resolves.toEqual({ recovered: 1, retained: 0, active: 0 });
    expect(await readdir(recoverySession)).not.toContain(
      ORBSTACK_MACHINE_RECOVERY_HOLD_FILE,
    );
  });

  it("never retires an OrbStack machine whose recorded engine owner is still alive", async () => {
    const recoverySession = path.join(root, "active-owner");
    await mkdir(recoverySession);
    const mounts = [workspace, recoverySession].sort(
      (left, right) => left.length - right.length || left.localeCompare(right),
    );
    const machineName = orbStackMachineName("active-owner", mounts);
    await writeFile(
      path.join(recoverySession, ORBSTACK_MACHINE_RECOVERY_HOLD_FILE),
      `${JSON.stringify({
        version: 2,
        executionId: "active-owner",
        machineName,
        mountRoots: mounts,
        ownerPid: 4242,
      })}\n`,
      { mode: 0o600 },
    );
    const calls: string[][] = [];
    const runner: OrbStackCommandRunner = {
      run: async (args) => {
        calls.push([...args]);
        return { code: 0, stdout: "[]", stderr: "" };
      },
      spawn: () => {
        throw new Error("unexpected spawn");
      },
    };

    await expect(
      recoverOrphanedOrbStackMachines({
        sessionsRoot: root,
        runner,
        isProcessAlive: (pid) => pid === 4242,
      }),
    ).resolves.toEqual({ recovered: 0, retained: 0, active: 1 });
    expect(calls).toEqual([]);
    expect(await readdir(recoverySession)).toContain(
      ORBSTACK_MACHINE_RECOVERY_HOLD_FILE,
    );
  });

  it("retires a v2 OrbStack recovery hold after its recorded owner exits", async () => {
    const recoverySession = path.join(root, "dead-owner");
    await mkdir(recoverySession);
    const mounts = [workspace, recoverySession].sort(
      (left, right) => left.length - right.length || left.localeCompare(right),
    );
    const machineName = orbStackMachineName("dead-owner", mounts);
    await writeFile(
      path.join(recoverySession, ORBSTACK_MACHINE_RECOVERY_HOLD_FILE),
      `${JSON.stringify({
        version: 2,
        executionId: "dead-owner",
        machineName,
        mountRoots: mounts,
        ownerPid: 4242,
      })}\n`,
      { mode: 0o600 },
    );
    const runner = fakeRunner(machineName, mounts, 1);

    await expect(
      recoverOrphanedOrbStackMachines({
        sessionsRoot: root,
        runner,
        isProcessAlive: () => false,
      }),
    ).resolves.toEqual({ recovered: 1, retained: 0, active: 0 });
    expect(await readdir(recoverySession)).not.toContain(
      ORBSTACK_MACHINE_RECOVERY_HOLD_FILE,
    );
  });

  it("retains malformed recovery holds without granting deletion authority", async () => {
    const recoverySession = path.join(root, "poisoned");
    await mkdir(recoverySession);
    await writeFile(
      path.join(recoverySession, ORBSTACK_MACHINE_RECOVERY_HOLD_FILE),
      '{"version":1,"executionId":"poisoned","machineName":"personal-machine","mountRoots":[]}\n',
      { mode: 0o600 },
    );
    const calls: string[][] = [];
    const runner: OrbStackCommandRunner = {
      run: async (args) => {
        calls.push([...args]);
        return { code: 0, stdout: "[]", stderr: "" };
      },
      spawn: () => {
        throw new Error("unexpected spawn");
      },
    };

    await expect(
      recoverOrphanedOrbStackMachines({ sessionsRoot: root, runner }),
    ).resolves.toEqual({ recovered: 0, retained: 1, active: 0 });
    expect(calls).toEqual([]);
  });

  it.each(["2.1.9", "2.2.0", "2.2.2", "2.3.0"])(
    "rejects OrbStack %s outside the qualified capability range",
    async (orbVersion) => {
      const mounts = [workspace, session].sort();
      const machineName = orbStackMachineName("old-orbstack", mounts);
      const runner = fakeRunner(machineName, mounts, 1, {
        orbVersion,
      });
      const controller = new MacosOrbStackContainerWorker({
        orbPath: orb,
        cloudInitPath: cloudInit,
        hostScriptPath: host,
        containerWorkerPath: worker,
        orbAttestor: (candidate) => candidate,
        runner,
      });

      const reservation = controller
        .reserve({
          executionId: "old-orbstack",
          workspaceRoot: workspace,
          sessionRoot: session,
        })
        .then(async (lease) => {
          await lease.stopAndProve();
          return lease;
        });
      await expect(reservation).rejects.toThrow(/version is outside/);
    },
  );

  it("restarts and re-attests a stopped exact machine", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("stopped-machine", mounts);
    const runner = fakeRunner(machineName, mounts, 1, {
      initialMachineState: "stopped",
    });
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
    });

    const lease = await controller.reserve({
      executionId: "stopped-machine",
      workspaceRoot: workspace,
      sessionRoot: session,
    });
    await lease.stopAndProve();

    expect(
      runner.calls.some(
        (args) => args[0] === "start" && args[1] === machineName,
      ),
    ).toBe(true);
  });
});
