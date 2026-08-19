import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

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
  resetAttestedOrbStackBundlesForTesting,
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
  let forceRelayCleanup: Array<() => void>;

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "zeros-orbstack-worker-test-")),
    );
    workspace = path.join(root, "workspace");
    session = path.join(root, "session");
    orb = path.join(root, "orb");
    cloudInit = path.join(root, "cloud-init.yaml");
    host = path.join(root, "host.mjs");
    worker = path.join(root, "worker.mjs");
    await Promise.all([
      mkdir(path.join(workspace, ".git"), { recursive: true }),
      mkdir(path.join(workspace, "Zeros Design"), { recursive: true }),
      mkdir(session, { recursive: true }),
      writeFile(orb, "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
      writeFile(cloudInit, "#cloud-config\n", { mode: 0o600 }),
      writeFile(host, "// host\n", { mode: 0o600 }),
      writeFile(worker, "// worker\n", { mode: 0o600 }),
    ]);
    await chmod(orb, 0o700);
    internal = null;
    internalPeers = new Set();
    forceRelayCleanup = [];
  });

  afterEach(async () => {
    for (const cleanup of forceRelayCleanup) cleanup();
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
    machineAddress = "::1",
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
      ...(machineAddress.includes(":")
        ? { ip6: machineAddress }
        : { ip4: machineAddress }),
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
      machineAddress?: string;
      orbVersion?: string;
      relayExitsBeforeStdoutDrain?: string;
      relayProbeHangs?: boolean;
      stubbornProbeRelay?: boolean;
      stubbornRelayAfterProbe?: boolean;
      runtimeMarker?: string;
      userReadyFailures?: number;
      workerExitBeforeReady?: boolean;
      workerSpawnFailure?: boolean;
    } = {},
  ): OrbStackCommandRunner & {
    calls: string[][];
    relayKillSignals: NodeJS.Signals[];
  } {
    const calls: string[][] = [];
    const relayKillSignals: NodeJS.Signals[] = [];
    let cloudInitChecks = 0;
    let infoChecks = 0;
    let machineDeleted = false;
    let machineStarted = behavior.initialMachineState !== "stopped";
    let relaySpawns = 0;
    let userReadyChecks = 0;
    const assetByDestination = new Map([
      ["/opt/zeros-zsr/zsr-orbstack-container-host.mjs", host],
      ["/opt/zeros-zsr/zsr-container-worker.mjs", worker],
    ]);
    return {
      calls,
      relayKillSignals,
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
              machineDeleted
                ? []
                : [
                    machineInfo(
                      machineName,
                      mounts,
                      "running",
                      behavior.machineAddress,
                    ),
                  ],
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
                behavior.machineAddress,
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
        if (args.includes("--relay")) {
          relaySpawns += 1;
          if (behavior.stubbornProbeRelay && relaySpawns === 1) {
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            const relay = new EventEmitter() as unknown as ChildProcess;
            const exitCode: number | null = null;
            let signalCode: NodeJS.Signals | null = null;
            Object.defineProperties(relay, {
              exitCode: { configurable: true, get: () => exitCode },
              signalCode: { configurable: true, get: () => signalCode },
              stdin: { configurable: true, value: stdin },
              stdout: { configurable: true, value: stdout },
              stderr: { configurable: true, value: stderr },
            });
            Object.defineProperty(relay, "kill", {
              configurable: true,
              value: (signal: NodeJS.Signals = "SIGTERM") => {
                relayKillSignals.push(signal);
                if (signal === "SIGKILL" && signalCode === null) {
                  signalCode = signal;
                  relay.emit("exit", null, signal);
                  stdout.end();
                  relay.emit("close", null, signal);
                }
                return true;
              },
            });
            return relay;
          }
          if (behavior.relayExitsBeforeStdoutDrain) {
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            const relay = new EventEmitter() as unknown as ChildProcess;
            let exitCode: number | null = null;
            let signalCode: NodeJS.Signals | null = null;
            Object.defineProperties(relay, {
              exitCode: { configurable: true, get: () => exitCode },
              signalCode: { configurable: true, get: () => signalCode },
              stdin: { configurable: true, value: stdin },
              stdout: { configurable: true, value: stdout },
              stderr: { configurable: true, value: stderr },
            });
            Object.defineProperty(relay, "kill", {
              configurable: true,
              value: (signal: NodeJS.Signals = "SIGTERM") => {
                if (exitCode === null && signalCode === null) {
                  signalCode = signal;
                  relay.emit("exit", null, signal);
                  stdout.end();
                  relay.emit("close", null, signal);
                }
                return true;
              },
            });
            let request = "";
            stdin.setEncoding("utf8");
            stdin.on("data", (chunk) => {
              request += chunk;
            });
            stdin.once("finish", () => {
              const challenge = /\/_zeros_zsr\/attest\/([a-f0-9]{64})/.exec(
                request,
              )?.[1];
              if (!challenge) {
                signalCode = "SIGABRT";
                relay.emit("exit", null, signalCode);
                stdout.end();
                relay.emit("close", null, signalCode);
                return;
              }
              const proof = createHmac(
                "sha256",
                behavior.relayExitsBeforeStdoutDrain!,
              )
                .update(challenge)
                .digest("hex");
              const response = `HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n${proof}`;
              exitCode = 0;
              // Node documents that `exit` may precede stdio drain. Model that
              // ordering deterministically so readiness never validates an
              // incomplete response.
              relay.emit("exit", 0, null);
              setImmediate(() => {
                stdout.end(response);
                relay.emit("close", 0, null);
              });
            });
            return relay;
          }
          if (behavior.relayProbeHangs) {
            return spawn(
              process.execPath,
              ["-e", "process.stdin.resume(); setInterval(()=>{},1000)"],
              { stdio: ["pipe", "pipe", "pipe"] },
            );
          }
          if (behavior.stubbornRelayAfterProbe && relaySpawns > 1) {
            const relay = spawn(
              process.execPath,
              ["-e", "process.stdin.resume(); setInterval(()=>{},1000)"],
              { stdio: ["pipe", "pipe", "pipe"] },
            );
            const forceKill = relay.kill.bind(relay);
            Object.defineProperty(relay, "kill", {
              configurable: true,
              value: () => true,
            });
            forceRelayCleanup.push(() => {
              Object.defineProperty(relay, "kill", {
                configurable: true,
                value: forceKill,
              });
              forceKill("SIGKILL");
            });
            return relay;
          }
          return spawn(
            process.execPath,
            [
              "-e",
              `const {connect}=require("node:net");
const peer=connect({host:"127.0.0.1",port:Number(process.argv[1]),allowHalfOpen:true});
peer.once("connect",()=>{process.stdin.pipe(peer);peer.pipe(process.stdout,{end:false});});
peer.once("close",()=>process.exit(0));
peer.once("error",()=>process.exit(125));`,
              String(internalPort),
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
        }
        if (behavior.workerSpawnFailure) {
          throw new Error("synthetic OrbStack exec spawn failure");
        }
        if (behavior.workerExitBeforeReady) {
          return spawn(process.execPath, ["-e", "process.exit(17)"], {
            stdio: ["ignore", "pipe", "pipe"],
          });
        }
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
    // The host fence is app-wide, but this lease mounts only `workspace` and
    // its private session root. A Design owner in another registered workspace
    // is unreachable from this VM and must not make the current lease invalid.
    const unprojectedDesign = path.join(
      root,
      "registered-sibling",
      "Zeros Design",
    );
    await mkdir(unprojectedDesign, { recursive: true });
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
    const lease = await controller.reserve(
      {
        executionId: "execution",
        workspaceRoot: workspace,
        sessionRoot: session,
      },
      { activation: "on-first-connection" },
    );
    await lease.start({
      generation: generation("abcdefghijklmnopqrstuvwx"),
      protectedRoots: [
        path.join(workspace, "Zeros Design"),
        unprojectedDesign,
      ],
    });
    expect(runner.calls).toEqual([]);
    expect(await readdir(session)).not.toContain(
      ORBSTACK_MACHINE_RECOVERY_HOLD_FILE,
    );

    const requestPing = () =>
      new Promise<string>((resolve, reject) => {
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
    const responses = await Promise.all([requestPing(), requestPing()]);
    expect(responses).toEqual([
      expect.stringMatching(/\r\n\r\nOK$/),
      expect.stringMatching(/\r\n\r\nOK$/),
    ]);
    expect(runner.calls.filter((args) => args[0] === "version")).toHaveLength(
      1,
    );
    expect(
      runner.calls.filter((args) => args.includes("--descriptor")),
    ).toHaveLength(1);
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
      protectedRoots?: unknown;
    };
    expect(descriptor.uid).toBe(process.getuid?.() ?? -1);
    expect(descriptor.gid).toBe(501);
    expect(descriptor.protectedRoots).toEqual([
      path.join(workspace, "Zeros Design"),
    ]);
    expect(descriptor).not.toHaveProperty("gitProjections");

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

  it("retires an unused on-demand lease without creating or deleting a machine", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("unused-on-demand", mounts);
    const runner = fakeRunner(machineName, mounts, 1);
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
    });
    const lease = await controller.reserve(
      {
        executionId: "unused-on-demand",
        workspaceRoot: workspace,
        sessionRoot: session,
      },
      { activation: "on-first-connection" },
    );

    await lease.start({
      generation: generation("unusedondemandgeneratio"),
      protectedRoots: [path.join(workspace, "Zeros Design")],
    });
    await lease.stopAndProve();

    expect(runner.calls).toEqual([]);
    expect(await readdir(session)).not.toContain(
      ORBSTACK_MACHINE_RECOVERY_HOLD_FILE,
    );
  });

  it("refuses pre-start proxy connections without emitting an engine error", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("pre-start-proxy", mounts);
    const runner = fakeRunner(machineName, mounts, 1);
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
    });
    const lease = await controller.reserve({
      executionId: "pre-start-proxy",
      workspaceRoot: workspace,
      sessionRoot: session,
    });
    const peer = connect({ host: "127.0.0.1", port: lease.hostPort });
    peer.on("error", () => undefined);

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("pre-start proxy connection stayed open")),
          1_000,
        );
        peer.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } finally {
      peer.destroy();
      await lease.stopAndProve();
    }
  });

  it("uses an exact-HMAC signed-CLI relay when the private machine address cannot reply", async () => {
    const sessionKey = "d".repeat(32);
    internal = createServer({ allowHalfOpen: true }, (peer) => {
      internalPeers.add(peer);
      peer.once("close", () => internalPeers.delete(peer));
      let request = "";
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => {
        request += chunk;
      });
      peer.once("end", () => {
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
    const machineName = orbStackMachineName("localhost-forward", mounts);
    const runner = fakeRunner(machineName, mounts, address.port, {
      machineAddress: "127.0.0.2",
    });
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
      executionId: "localhost-forward",
      workspaceRoot: workspace,
      sessionRoot: session,
    });

    try {
      await expect(
        lease.start({
          generation: generation("localhostforwardgeneration"),
          protectedRoots: [path.join(workspace, "Zeros Design")],
        }),
      ).resolves.toBeUndefined();

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
      expect(runner.calls.some((args) => args.includes("--relay"))).toBe(true);
    } finally {
      await lease.stopAndProve();
    }
  });

  it("bounds relay admission per lease", async () => {
    const sessionKey = "e".repeat(32);
    internal = createServer({ allowHalfOpen: true }, (peer) => {
      internalPeers.add(peer);
      peer.once("close", () => internalPeers.delete(peer));
      let request = "";
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => {
        request += chunk;
      });
      peer.once("end", () => {
        const attestation =
          /^GET \/_zeros_zsr\/attest\/([a-f0-9]{64}) HTTP\/1\.[01]/.exec(
            request,
          );
        if (attestation) {
          const proof = createHmac("sha256", sessionKey)
            .update(attestation[1])
            .digest("hex");
          peer.end(`HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n${proof}`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      internal!.once("error", reject);
      internal!.listen(0, "127.0.0.1", resolve);
    });
    const address = internal.address();
    if (!address || typeof address === "string") throw new Error("no port");

    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("relay-cap", mounts);
    const runner = fakeRunner(machineName, mounts, address.port);
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
      forwardedBridgeTimeoutMs: 100,
      maxActiveRelays: 1,
      sessionKeyFactory: () => sessionKey,
    });
    const lease = await controller.reserve({
      executionId: "relay-cap",
      workspaceRoot: workspace,
      sessionRoot: session,
    });

    let first: Socket | null = null;
    let second: Socket | null = null;
    try {
      await lease.start({
        generation: generation("relaycapgeneration123456"),
        protectedRoots: [path.join(workspace, "Zeros Design")],
      });
      const relayCallsBeforeConnections = runner.calls.filter((args) =>
        args.includes("--relay"),
      ).length;

      first = connect({ host: "127.0.0.1", port: lease.hostPort });
      first.on("error", () => undefined);
      const firstRelayDeadline = Date.now() + 1_000;
      while (
        runner.calls.filter((args) => args.includes("--relay")).length <
        relayCallsBeforeConnections + 1
      ) {
        if (Date.now() >= firstRelayDeadline) {
          throw new Error("first relay was not admitted");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      second = connect({ host: "127.0.0.1", port: lease.hostPort });
      second.on("error", () => undefined);
      const secondClosed = await Promise.race([
        new Promise<boolean>((resolve) =>
          second!.once("close", () => resolve(true)),
        ),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(second?.destroyed ?? true), 200),
        ),
      ]);

      expect(secondClosed).toBe(true);
      expect(
        runner.calls.filter((args) => args.includes("--relay")),
      ).toHaveLength(relayCallsBeforeConnections + 1);
    } finally {
      first?.destroy();
      second?.destroy();
      await lease.stopAndProve();
    }
  });

  it("bounds an unreachable relay probe by the forwarded-bridge deadline", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("relay-deadline", mounts);
    const runner = fakeRunner(machineName, mounts, 1, {
      relayProbeHangs: true,
    });
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
      forwardedBridgeTimeoutMs: 50,
    });
    const lease = await controller.reserve({
      executionId: "relay-deadline",
      workspaceRoot: workspace,
      sessionRoot: session,
    });

    const startedAt = Date.now();
    await expect(
      lease.start({
        generation: generation("relaydeadlinegeneration12"),
        protectedRoots: [path.join(workspace, "Zeros Design")],
      }),
    ).rejects.toMatchObject({
      name: MacosContainerWorkerUnavailableError.name,
      reason: "private-runtime-unavailable",
    });
    expect(Date.now() - startedAt).toBeLessThan(750);
  });

  it("force-kills an attestation relay that ignores graceful teardown", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("stubborn-probe", mounts);
    const runner = fakeRunner(machineName, mounts, 1, {
      stubbornProbeRelay: true,
    });
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
      forwardedBridgeTimeoutMs: 50,
    });
    const lease = await controller.reserve({
      executionId: "stubborn-probe",
      workspaceRoot: workspace,
      sessionRoot: session,
    });

    await expect(
      lease.start({
        generation: generation("stubbornprobegeneration12"),
        protectedRoots: [path.join(workspace, "Zeros Design")],
      }),
    ).rejects.toMatchObject({
      name: MacosContainerWorkerUnavailableError.name,
      reason: "private-runtime-unavailable",
    });
    expect(runner.relayKillSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(
      runner.calls.some(
        (args) => args[0] === "delete" && args.includes(machineName),
      ),
    ).toBe(true);
  });

  it("waits for relay stdout to drain after the CLI child exits", async () => {
    const sessionKey = "1".repeat(32);
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("relay-stdout-drain", mounts);
    const runner = fakeRunner(machineName, mounts, 1, {
      relayExitsBeforeStdoutDrain: sessionKey,
    });
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
      executionId: "relay-stdout-drain",
      workspaceRoot: workspace,
      sessionRoot: session,
    });

    try {
      await expect(
        lease.start({
          generation: generation("relayoutputdrain12345678"),
          protectedRoots: [path.join(workspace, "Zeros Design")],
        }),
      ).resolves.toBeUndefined();
    } finally {
      await lease.stopAndProve();
    }
  });

  it("deletes the private machine even when a relay survives forced teardown", async () => {
    const sessionKey = "f".repeat(32);
    internal = createServer({ allowHalfOpen: true }, (peer) => {
      internalPeers.add(peer);
      peer.once("close", () => internalPeers.delete(peer));
      let request = "";
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => {
        request += chunk;
      });
      peer.once("end", () => {
        const attestation =
          /^GET \/_zeros_zsr\/attest\/([a-f0-9]{64}) HTTP\/1\.[01]/.exec(
            request,
          );
        if (attestation) {
          const proof = createHmac("sha256", sessionKey)
            .update(attestation[1])
            .digest("hex");
          peer.end(`HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n${proof}`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      internal!.once("error", reject);
      internal!.listen(0, "127.0.0.1", resolve);
    });
    const address = internal.address();
    if (!address || typeof address === "string") throw new Error("no port");

    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("stubborn-relay", mounts);
    const runner = fakeRunner(machineName, mounts, address.port, {
      stubbornRelayAfterProbe: true,
    });
    const controller = new MacosOrbStackContainerWorker({
      orbPath: orb,
      cloudInitPath: cloudInit,
      hostScriptPath: host,
      containerWorkerPath: worker,
      orbAttestor: (candidate) => candidate,
      runner,
      forwardedBridgeTimeoutMs: 100,
      sessionKeyFactory: () => sessionKey,
      stopTimeoutMs: 10,
    });
    const lease = await controller.reserve({
      executionId: "stubborn-relay",
      workspaceRoot: workspace,
      sessionRoot: session,
    });
    await lease.start({
      generation: generation("stubbornrelaygeneration12"),
      protectedRoots: [path.join(workspace, "Zeros Design")],
    });
    const probeRelays = runner.calls.filter((args) =>
      args.includes("--relay"),
    ).length;
    const peer = connect({ host: "127.0.0.1", port: lease.hostPort });
    peer.on("error", () => undefined);
    const relayDeadline = Date.now() + 1_000;
    while (
      runner.calls.filter((args) => args.includes("--relay")).length <
      probeRelays + 1
    ) {
      if (Date.now() >= relayDeadline) {
        throw new Error("stubborn relay was not admitted");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    let outcome: "pending" | "resolved" | "rejected" = "pending";
    let cleanupFailure: unknown;
    const stopping = lease.stopAndProve().then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = "rejected";
        cleanupFailure = error;
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const deletedBeforeForcedRelayExit = runner.calls.some(
      (args) => args[0] === "delete" && args.includes(machineName),
    );
    const outcomeBeforeForcedRelayExit = outcome;
    for (const cleanup of forceRelayCleanup.splice(0)) cleanup();
    peer.destroy();
    await stopping;

    expect(deletedBeforeForcedRelayExit).toBe(true);
    expect(outcomeBeforeForcedRelayExit).toBe("rejected");
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    expect((cleanupFailure as Error).message).toMatch(/cleanup was not proven/);
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
      const failure = await lease
        .start({
          generation: generation("forwardcollisiongeneration"),
          protectedRoots: [path.join(workspace, "Zeros Design")],
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(MacosContainerWorkerUnavailableError);
      expect((failure as Error).message).toMatch(/attestation failed/);
    } finally {
      await lease.stopAndProve();
    }
    expect(
      runner.calls.some(
        (args) => args[0] === "delete" && args.includes(machineName),
      ),
    ).toBe(true);
  });

  it("reports a safely retired worker exit as temporary unavailability", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("worker-exit", mounts);
    const runner = fakeRunner(machineName, mounts, 1, {
      workerExitBeforeReady: true,
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
      executionId: "worker-exit",
      workspaceRoot: workspace,
      sessionRoot: session,
    });

    try {
      await expect(
        lease.start({
          generation: generation("workerexitgeneration1234"),
          protectedRoots: [path.join(workspace, "Zeros Design")],
        }),
      ).rejects.toMatchObject({
        name: MacosContainerWorkerUnavailableError.name,
        reason: "private-runtime-unavailable",
      });
    } finally {
      await lease.stopAndProve();
    }
    expect(
      runner.calls.some(
        (args) => args[0] === "delete" && args.includes(machineName),
      ),
    ).toBe(true);
  });

  it("reports a safely retired worker spawn failure as temporary unavailability", async () => {
    const mounts = [workspace, session].sort();
    const machineName = orbStackMachineName("worker-spawn", mounts);
    const runner = fakeRunner(machineName, mounts, 1, {
      workerSpawnFailure: true,
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
      executionId: "worker-spawn",
      workspaceRoot: workspace,
      sessionRoot: session,
    });

    await expect(
      lease.start({
        generation: generation("workerspawngeneration123"),
        protectedRoots: [path.join(workspace, "Zeros Design")],
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
    expect(
      findOrbStackCli({ PATH: root, HOME: root }, () => {
        throw new Error("synthetic attestation refusal");
      }),
    ).toBeNull();
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

  it("memoizes only the whole-bundle sweep, per exact on-disk identity", async () => {
    // `codesign --verify --deep --strict` over OrbStack.app measured 570-900ms
    // on a 680 MiB bundle and ran once per admission — the whole of the
    // container-reserve stage. It is cached; the trust decision is not.
    resetAttestedOrbStackBundlesForTesting();
    const bundle = path.join(root, "Memo.app");
    const candidate = path.join(
      bundle,
      "Contents",
      "MacOS",
      "scli.app",
      "Contents",
      "MacOS",
      "scli",
    );
    const codeResources = path.join(
      bundle,
      "Contents",
      "_CodeSignature",
      "CodeResources",
    );
    await mkdir(path.dirname(candidate), { recursive: true });
    await mkdir(path.dirname(codeResources), { recursive: true });
    await writeFile(candidate, "#!/bin/sh\n", { mode: 0o700 });
    await chmod(candidate, 0o700);
    await writeFile(codeResources, "<plist>v1</plist>\n", { mode: 0o644 });
    // The real bundle path ends in OrbStack.app; point the attestor at this
    // fixture by giving it that exact suffix.
    const orbStackBundle = path.join(root, "OrbStack.app");
    await rm(orbStackBundle, { recursive: true, force: true });
    await mkdir(path.dirname(orbStackBundle), { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(bundle, orbStackBundle);
    const real = path.join(
      orbStackBundle,
      "Contents",
      "MacOS",
      "scli.app",
      "Contents",
      "MacOS",
      "scli",
    );
    const realCodeResources = path.join(
      orbStackBundle,
      "Contents",
      "_CodeSignature",
      "CodeResources",
    );

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
    const deepSweeps = () =>
      calls.filter((args) => args.includes("--deep")).length;
    const trustChecks = () =>
      calls.filter((args) => args.some((arg) => arg.startsWith("-R="))).length;

    expect(attestOrbStackCli(real, verifier, "darwin")).toBe(real);
    expect(deepSweeps()).toBe(1);
    expect(trustChecks()).toBe(1);

    // Second admission, unchanged bundle: sweep memoized, trust decision re-run.
    expect(attestOrbStackCli(real, verifier, "darwin")).toBe(real);
    expect(deepSweeps()).toBe(1);
    expect(trustChecks()).toBe(2);

    // Tampering with any nested file must change CodeResources, which re-sweeps.
    await writeFile(realCodeResources, "<plist>v2 tampered</plist>\n", {
      mode: 0o644,
    });
    expect(attestOrbStackCli(real, verifier, "darwin")).toBe(real);
    expect(deepSweeps()).toBe(2);
    expect(trustChecks()).toBe(3);

    // Replacing the CLI itself re-sweeps too.
    await writeFile(real, "#!/bin/sh\n# changed\n", { mode: 0o700 });
    await chmod(real, 0o700);
    expect(attestOrbStackCli(real, verifier, "darwin")).toBe(real);
    expect(deepSweeps()).toBe(3);

    // A rejected identity must not leave a memo behind: the next admission
    // sweeps again rather than inheriting a verdict recorded beside a failure.
    const rejecting = (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      return {
        status: args.some((arg) => arg.startsWith("-R=")) ? 1 : 0,
        stdout: "",
        stderr:
          args[0] === "-d"
            ? "Identifier=dev.kdrag0n.MacVirt.scli\nTeamIdentifier=HUAQ24HBR6\n"
            : "",
      };
    };
    expect(() => attestOrbStackCli(real, rejecting, "darwin")).toThrow(
      /code-signing identity is untrusted/,
    );
    const sweepsBefore = deepSweeps();
    expect(attestOrbStackCli(real, verifier, "darwin")).toBe(real);
    expect(deepSweeps()).toBe(sweepsBefore + 1);
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
