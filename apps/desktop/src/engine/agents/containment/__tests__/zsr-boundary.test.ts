import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, createServer } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runFile } from "../../../git/git-exec";
import { MacosContainerWorkerUnavailableError } from "../macos-orbstack-container-worker";
import type { MacosProcessDomainCommandRunner } from "../macos-process-domain";
import {
  ZsrExecutionBoundary as RuntimeZsrExecutionBoundary,
  type ZsrBoundaryOptions,
} from "../zsr-boundary";

const NETWORK_BRIDGE_SCRIPT = path.join(
  process.cwd(),
  "apps/desktop/src/engine/agents/containment/zsr-network-bridge.mjs",
);
const boundaryTmpdir =
  process.platform === "darwin" ? "/private/tmp" : tmpdir();

const macosProcessDomainRunner: MacosProcessDomainCommandRunner = async (
  _helperPath,
  args,
) => {
  const command = args[0];
  const value =
    command === "self-test"
      ? {
          version: 1,
          platform: "darwin",
          processIdentity: true,
          sandboxInspection: true,
          callerSandboxed: false,
        }
      : command === "identity"
        ? {
            version: 1,
            pid: Number(args[1]),
            uid: process.getuid?.() ?? 501,
            startSec: "1",
            startUsec: "0",
          }
        : command === "match"
          ? { version: 1, match: true }
          : command === "listeners"
            ? { version: 1, listeners: [] }
            : command === "reap"
              ? {
                  version: 1,
                  matched: 0,
                  termSignals: 0,
                  stopSignals: 0,
                  killSignals: 0,
                  remaining: 0,
                  provedEmpty: true,
                }
              : null;
  return {
    exitCode: value ? 0 : 2,
    stdout: value ? `${JSON.stringify(value)}\n` : "",
    stderr: "",
  };
};

class ZsrExecutionBoundary extends RuntimeZsrExecutionBoundary {
  constructor(options: ZsrBoundaryOptions) {
    super({
      ...options,
      ...(process.platform === "darwin" ? { macosProcessDomainRunner } : {}),
    });
  }
}

const PASSING_SUPERVISOR = String.raw`
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
const commandPath = process.argv[process.argv.indexOf("--command") + 1];
const descriptor = JSON.parse(readFileSync(commandPath, "utf8"));
if (descriptor.env.ZEROS_ADMISSION_SENTINEL) {
  const spec = JSON.parse(Buffer.from(descriptor.args.at(-1), "base64url").toString("utf8"));
  writeFileSync(spec.codeFile, "ok\n", { flag: "wx" });
  unlinkSync(spec.codeFile);
  writeFileSync(spec.privateWriteFile, "private\n", { flag: "wx" });
  for (const projection of spec.gitProjections) {
    writeFileSync(
      projection.privateGitDir + "/" + projection.markerName,
      spec.generation + "\n",
      { flag: "wx", mode: 0o600 },
    );
  }
  process.stdout.write(JSON.stringify({
    codeWrite: true,
    policyReadDenied: true,
    environmentExact: !descriptor.env.ZEROS_LOCAL_WS_TOKEN &&
      !descriptor.env.ZEROS_CONTROL_FD &&
      !descriptor.env.ZEROS_ZSR_AMBIENT_SECRET,
    designWriteDenied: spec.designProbes.map(() => true),
    designAliasWriteDenied: true,
    controlWriteDenied: spec.controlWriteFiles.map(() => true),
    controlReadDenied: spec.controlReadFiles.map(() => true),
    gitProjectionPrivate: spec.gitProjections.map(() => true),
    privateStateWrite: true,
    engineRootWriteDenied: true,
    processDomainMarkerReadable: true,
    sandboxPid: process.pid,
    dynamicBindMapped: true,
  }) + "\n");
  process.exit(0);
}
const probe = JSON.parse(Buffer.from(descriptor.args.at(-1), "base64url").toString("utf8"));
writeFileSync(probe.codeFile, "ok\n");
process.stdout.write(JSON.stringify({
  codeWrite: true,
  designWriteDenied: readFileSync(probe.designFile, "utf8") === "original\n",
  designHardlinkDenied: true,
  designCreateDenied: true,
  designUnlinkDenied: true,
  designRenameOutDenied: true,
  designRenameInDenied: true,
  designChmodDenied: true,
  designSymlinkWriteDenied: true,
  secretReadDenied: readFileSync(probe.secret, "utf8") === "engine-only\n",
}));
`;

describe("ZSR execution boundary", () => {
  let root: string;
  let previousDataDir: string | undefined;
  let supervisor: string;
  let workspace: string;

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(boundaryTmpdir, "zeros-zsr-boundary-test-")),
    );
    previousDataDir = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = path.join(root, "engine");
    supervisor = path.join(root, "fake-supervisor.mjs");
    workspace = path.join(root, "workspace");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(path.join(root, "provider-home"), { recursive: true }),
    ]);
    if (process.platform === "darwin") {
      const binaries = path.join(root, "binaries");
      await mkdir(binaries, { mode: 0o700 });
      await Promise.all([
        writeFile(path.join(binaries, "zsr-macos-process-domain"), "test\n", {
          mode: 0o500,
        }),
        copyFile(
          path.join(process.cwd(), "binaries", "zsr-macos-port-bind.dylib"),
          path.join(binaries, "zsr-macos-port-bind.dylib"),
        ),
      ]);
    }
    await writeFile(supervisor, PASSING_SUPERVISOR, { mode: 0o700 });
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
    else process.env.ZEROS_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  });

  it("admits only after a behavioral canary and emits one-shot private descriptors", async () => {
    const hostHome = path.join(root, "host-home");
    await mkdir(hostHome, { recursive: true });
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const request = {
      executionId: "execution-1",
      actor: "agent-code" as const,
      providerId: "codex",
      providerStateEnv: { HOME: hostHome },
      cwd: workspace,
      workspaceRoot: workspace,
    };
    await expect(boundary.probe(request)).resolves.toMatchObject({
      available: true,
      secureNestedIsolation: true,
    });

    const prepared = await boundary.prepare(request);
    const launch = prepared.wrapSpawn({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      env: {
        PATH: "/child/bin",
        HOME: "/user/home",
        SENTINEL: "present",
        NODE_OPTIONS: "--require=/workspace/preload.cjs",
        LD_PRELOAD: "/workspace/preload.so",
        ZEROS_LOCAL_WS_TOKEN: "must-not-cross",
        OPENAI_API_KEY: "sk-boundary-real-value",
        DOCKER_HOST: "tcp://127.0.0.1:2375",
        DOCKER_CONTEXT: "host-context",
      },
    });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toBe(supervisor);
    expect(launch.env.HOME).not.toBe("/user/home");
    expect(launch.env.PATH).not.toBe("/child/bin");
    expect(launch.env.SENTINEL).toBeUndefined();
    expect(launch.env.NODE_OPTIONS).toBeUndefined();
    expect(launch.env.LD_PRELOAD).toBeUndefined();
    expect(launch.env.ZEROS_LOCAL_WS_TOKEN).toBeUndefined();
    expect(launch.env.OPENAI_API_KEY).toBeUndefined();
    const commandPath = launch.args[launch.args.indexOf("--command") + 1];
    expect((await stat(commandPath)).mode & 0o777).toBe(0o600);
    const descriptor = JSON.parse(await readFile(commandPath, "utf8")) as {
      env: Record<string, string>;
      filesystemProjections?: Array<{
        source: string;
        destination: string;
        readOnly: boolean;
      }>;
      internalProxyPorts: { http: number; socks: number };
      credentialCapabilities?: Array<{
        name: string;
        injectAuthorities: string[];
        allowPlaintext: boolean;
      }>;
    };
    expect(descriptor).toMatchObject({
      version: 5,
      generation: prepared.generation,
      command: process.execPath,
      cwd: workspace,
      env: {
        PATH: "/child/bin",
        SENTINEL: "present",
        NODE_OPTIONS: "--require=/workspace/preload.cjs",
        LD_PRELOAD: "/workspace/preload.so",
      },
    });
    expect(descriptor.env.HOME).not.toBe("/user/home");
    expect(descriptor.env.HOME).toMatch(/\/boundary\/[^/]+\/home$/);
    expect(descriptor.env.XDG_CONFIG_HOME).toBe(
      path.join(descriptor.env.HOME, ".config"),
    );
    expect(descriptor.env.DOCKER_HOST).toMatch(
      /^unix:\/\/.*container-worker-unavailable\.sock$/,
    );
    expect(descriptor.env.CONTAINER_HOST).toBe(descriptor.env.DOCKER_HOST);
    expect(descriptor.env.DOCKER_CONTEXT).toBeUndefined();
    expect(descriptor.internalProxyPorts.http).toBeGreaterThanOrEqual(20_000);
    expect(descriptor.internalProxyPorts.socks).toBeGreaterThanOrEqual(20_000);
    expect(descriptor.internalProxyPorts.http).not.toBe(
      descriptor.internalProxyPorts.socks,
    );
    expect(descriptor.credentialCapabilities).toEqual([
      {
        name: "OPENAI_API_KEY",
        injectAuthorities: ["api.openai.com:443"],
        allowPlaintext: false,
      },
    ]);
    expect([1080, 3000, 3128, 5173, 8000, 8080]).not.toContain(
      descriptor.internalProxyPorts.http,
    );
    expect([1080, 3000, 3128, 5173, 8000, 8080]).not.toContain(
      descriptor.internalProxyPorts.socks,
    );
    expect(
      JSON.parse(await readFile(commandPath, "utf8")).env.ZEROS_LOCAL_WS_TOKEN,
    ).toBeUndefined();
    await prepared.stopAndProve();
  });

  it("keeps exact-admission support paths out of the Git worktree", async () => {
    const design = path.join(workspace, "Zeros Design");
    const witness = path.join(root, "admission-paths.json");
    await mkdir(design, { recursive: true });
    await writeFile(
      supervisor,
      PASSING_SUPERVISOR.replace(
        'const spec = JSON.parse(Buffer.from(descriptor.args.at(-1), "base64url").toString("utf8"));',
        `const spec = JSON.parse(Buffer.from(descriptor.args.at(-1), "base64url").toString("utf8"));
  writeFileSync(${JSON.stringify(witness)}, JSON.stringify({
    codeFile: spec.codeFile,
    designAlias: spec.designAlias,
    releaseFile: spec.processDomain?.releaseFile ?? null,
  }));`,
      ),
      { mode: 0o700 },
    );
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });

    const prepared = await boundary.prepare({
      executionId: "private-admission-support",
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
      territory: {
        agentRole: "code",
        workspaceRoot: workspace,
        designDirectory: design,
        protectedDesignDirectories: [design],
        writeCapabilities: {
          workspace: "write",
          deniedPaths: [design, path.join(workspace, ".git")],
        },
      },
    });
    try {
      const paths = JSON.parse(await readFile(witness, "utf8")) as {
        codeFile: string;
        designAlias: string;
        releaseFile: string | null;
      };
      expect(path.dirname(paths.codeFile)).toBe(workspace);
      expect(path.relative(workspace, paths.designAlias)).toMatch(/^\.\./);
      if (paths.releaseFile) {
        expect(path.relative(workspace, paths.releaseFile)).toMatch(/^\.\./);
      }
      expect(await readdir(workspace)).not.toContainEqual(
        expect.stringMatching(/^\.zeros-zsr-admission-/),
      );
      await expect(stat(paths.codeFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await prepared.stopAndProve();
    }
  });

  it("keeps Electron in Node mode inside the behavioral canary", async () => {
    const previousElectronRuntime = process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON;
    process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON = "1";
    await writeFile(
      supervisor,
      PASSING_SUPERVISOR.replace(
        'const descriptor = JSON.parse(readFileSync(commandPath, "utf8"));',
        `const descriptor = JSON.parse(readFileSync(commandPath, "utf8"));
if (descriptor.env.ELECTRON_RUN_AS_NODE !== "1") {
  process.stderr.write("behavioral canary dropped Electron Node mode\\n");
  process.exit(70);
}`,
      ),
      { mode: 0o700 },
    );
    try {
      const boundary = new ZsrExecutionBoundary({
        projectRoot: root,
        supervisorScript: supervisor,
        supervisorRuntime: process.execPath,
        networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      });

      await expect(
        boundary.probe({
          executionId: "electron-canary",
          actor: "agent-code",
          cwd: workspace,
          workspaceRoot: workspace,
        }),
      ).resolves.toMatchObject({
        available: true,
        secureNestedIsolation: true,
      });
    } finally {
      if (previousElectronRuntime === undefined) {
        delete process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON;
      } else {
        process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON = previousElectronRuntime;
      }
    }
  });

  it("admits only the Electron app contents needed by an engine-private runtime", async () => {
    const previousElectronRuntime = process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON;
    process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON = "1";
    const contents = path.join(
      process.env.ZEROS_DATA_DIR!,
      "dev-instances",
      "Zeros Test.app",
      "Contents",
    );
    const runtime = path.join(contents, "MacOS", "Zeros Test");
    await mkdir(path.dirname(runtime), { recursive: true });
    await mkdir(path.join(contents, "Frameworks"), { recursive: true });
    await writeFile(
      runtime,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o700 },
    );
    try {
      const boundary = new ZsrExecutionBoundary({
        projectRoot: root,
        supervisorScript: supervisor,
        supervisorRuntime: runtime,
        networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      });
      const prepared = await boundary.prepare({
        executionId: "electron-runtime-read",
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
      });
      try {
        const launch = prepared.wrapSpawn({
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: workspace,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        });
        const policyPath = launch.args[launch.args.indexOf("--policy") + 1];
        const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
          filesystem: {
            allowRead: string[];
            allowWrite: string[];
            denyRead: string[];
            denyWrite: string[];
          };
        };
        expect(policy.filesystem.allowRead).toContain(contents);
        expect(policy.filesystem.allowRead).not.toContain(
          path.dirname(contents),
        );
        expect(policy.filesystem.allowWrite).not.toContain(contents);
        expect(
          policy.filesystem.denyRead.some((denied) =>
            path.relative(denied, contents).startsWith("dev-"),
          ),
        ).toBe(true);
        expect(
          policy.filesystem.denyWrite.some((denied) =>
            path.relative(denied, contents).startsWith("dev-"),
          ),
        ).toBe(true);
      } finally {
        await prepared.stopAndProve();
      }
    } finally {
      if (previousElectronRuntime === undefined) {
        delete process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON;
      } else {
        process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON = previousElectronRuntime;
      }
    }
  });

  it("keeps code usable and reports restricted parity when OrbStack is safely unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      macosContainerWorkerFactory: () => ({
        reserve: async () => {
          throw new MacosContainerWorkerUnavailableError(
            "insufficient-disk-space",
            "OrbStack needs at least 4 GiB free",
          );
        },
      }),
    });

    const prepared = await boundary.prepare({
      executionId: "orbstack-unavailable",
      actor: "agent-code",
      providerId: "codex",
      providerStateEnv: { HOME: path.join(root, "provider-home") },
      cwd: workspace,
      workspaceRoot: workspace,
      containerWorkflowExpected: true,
      containerWorker: {
        runtime: "podman",
        backend: "orbstack-machine",
        executable: process.execPath,
      },
    });

    expect(prepared.status.parity).toEqual({
      level: "restricted",
      restrictions: ["container-workflows-unavailable"],
    });
    expect(prepared.status.services?.kinds ?? []).not.toContain("podman");
    expect(prepared.status.remediation).toMatch(/Free at least 4 GiB/);
    expect(warning).toHaveBeenCalledWith(
      "[zsr] OrbStack needs at least 4 GiB free",
    );
    await prepared.stopAndProve();
    warning.mockRestore();
  });

  it("keeps code usable when a reserved OrbStack worker becomes safely unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stopAndProve = vi.fn(async () => undefined);
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      macosContainerWorkerFactory: () => ({
        reserve: async () => ({
          hostPort: 42_320,
          machineName: "zeros-zsr-abcdef0123456789abcd",
          environment: {},
          start: async () => {
            throw new MacosContainerWorkerUnavailableError(
              "private-runtime-unavailable",
              "The private OrbStack bridge is temporarily unavailable",
            );
          },
          stopAndProve,
        }),
      }),
    });

    const prepared = await boundary.prepare({
      executionId: "orbstack-start-unavailable",
      actor: "agent-code",
      providerId: "codex",
      providerStateEnv: { HOME: path.join(root, "provider-home") },
      cwd: workspace,
      workspaceRoot: workspace,
      containerWorkflowExpected: true,
      containerWorker: {
        runtime: "podman",
        backend: "orbstack-machine",
        executable: process.execPath,
      },
    });

    expect(stopAndProve).toHaveBeenCalledOnce();
    expect(prepared.status.parity).toEqual({
      level: "restricted",
      restrictions: ["container-workflows-unavailable"],
    });
    expect(prepared.status.services?.kinds ?? []).not.toContain("podman");
    expect(prepared.status.remediation).toMatch(/OrbStack runtime/i);
    expect(warning).toHaveBeenCalledWith(
      "[zsr] The private OrbStack bridge is temporarily unavailable",
    );
    await prepared.stopAndProve();
    warning.mockRestore();
  });

  it("poisons later admissions when any prepared boundary cannot prove teardown", async () => {
    const teardownFailure = new Error("container worker teardown proof failed");
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      macosContainerWorkerFactory: () => ({
        reserve: async () => ({
          hostPort: 42_321,
          machineName: "zeros-zsr-0123456789abcdef0123",
          environment: {},
          start: async () => {},
          stopAndProve: async () => {
            throw teardownFailure;
          },
        }),
      }),
    });
    const request = {
      executionId: "unproven-retirement-1",
      actor: "agent-code" as const,
      providerId: "codex",
      providerStateEnv: { HOME: path.join(root, "provider-home") },
      cwd: workspace,
      workspaceRoot: workspace,
      containerWorker: {
        runtime: "podman" as const,
        backend: "orbstack-machine" as const,
        executable: process.execPath,
      },
    };

    const prepared = await boundary.prepare(request);
    await expect(prepared.stopAndProve()).rejects.toThrow(
      "failed to revoke boundary capabilities",
    );
    await expect(
      boundary.prepare({ ...request, executionId: "unproven-retirement-2" }),
    ).rejects.toThrow(/prior execution boundary could not be proven stopped/);
    await expect(boundary.probe(request)).resolves.toMatchObject({
      available: false,
      secureNestedIsolation: false,
      reasons: [expect.stringMatching(/restart Zeros/)],
    });
  });

  it("poisons later admissions when preparation cleanup cannot be proven", async () => {
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      macosContainerWorkerFactory: () => ({
        reserve: async () => ({
          hostPort: 42_322,
          machineName: "zeros-zsr-123456789abcdef01234",
          environment: {},
          start: async () => {
            throw new Error("container worker startup failed");
          },
          stopAndProve: async () => {
            throw new Error("preparation cleanup proof failed");
          },
        }),
      }),
    });
    const request = {
      executionId: "failed-preparation-1",
      actor: "repo-code-task" as const,
      providerId: "generic",
      cwd: workspace,
      workspaceRoot: workspace,
      containerWorker: {
        runtime: "podman" as const,
        backend: "orbstack-machine" as const,
        executable: process.execPath,
      },
    };

    await expect(boundary.prepare(request)).rejects.toThrow(
      /cleanup could not be proven/,
    );
    await expect(
      boundary.prepare({ ...request, executionId: "failed-preparation-2" }),
    ).rejects.toThrow(/prior execution boundary could not be proven stopped/);
  });

  it("fails closed when a live canary reports a protected write", async () => {
    await writeFile(
      supervisor,
      PASSING_SUPERVISOR.replace(
        'designWriteDenied: readFileSync(probe.designFile, "utf8") === "original\\n"',
        "designWriteDenied: false",
      ),
      { mode: 0o700 },
    );
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const request = {
      executionId: "execution-2",
      actor: "agent-code" as const,
      cwd: workspace,
      workspaceRoot: workspace,
    };
    const probe = await boundary.probe(request);
    expect(probe.available).toBe(false);
    expect(probe.reasons.join(" ")).toMatch(/protected Design/);
    await expect(boundary.prepare(request)).rejects.toThrow(/protected Design/);
  });

  it("fails closed when a live canary can create a Design hard-link alias", async () => {
    await writeFile(
      supervisor,
      PASSING_SUPERVISOR.replace(
        "designHardlinkDenied: true",
        "designHardlinkDenied: false",
      ),
      { mode: 0o700 },
    );
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const request = {
      executionId: "execution-hardlink-failure",
      actor: "agent-code" as const,
      cwd: workspace,
      workspaceRoot: workspace,
    };

    const probe = await boundary.probe(request);
    expect(probe.available).toBe(false);
    expect(probe.reasons.join(" ")).toMatch(/hard-link alias/i);
    await expect(boundary.prepare(request)).rejects.toThrow(/hard-link alias/i);
  });

  it("fails closed when a live canary can rename a protected Design file", async () => {
    await writeFile(
      supervisor,
      PASSING_SUPERVISOR.replace(
        "designRenameOutDenied: true",
        "designRenameOutDenied: false",
      ),
      { mode: 0o700 },
    );
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const request = {
      executionId: "execution-rename-failure",
      actor: "agent-code" as const,
      cwd: workspace,
      workspaceRoot: workspace,
    };

    const probe = await boundary.probe(request);
    expect(probe.available).toBe(false);
    expect(probe.reasons.join(" ")).toMatch(/rename.*protected Design/i);
    await expect(boundary.prepare(request)).rejects.toThrow(
      /rename.*protected Design/i,
    );
  });

  it("fails closed when the exact request policy exposes engine state", async () => {
    await writeFile(
      supervisor,
      PASSING_SUPERVISOR.replace(
        "policyReadDenied: true",
        "policyReadDenied: false",
      ),
      { mode: 0o700 },
    );
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    await expect(
      boundary.prepare({
        executionId: "execution-exact-failure",
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(/engine-private policy state/);
  });

  it("revokes leases and kills every ordinary process-group descendant", async () => {
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const prepared = await boundary.prepare({
      executionId: "execution-3",
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    const lease = await prepared.requestPort({
      protocol: "tcp",
      ...(process.platform === "darwin" ? {} : { preferredPort: 43123 }),
      purpose: "dev-server",
    });
    expect(lease).toMatchObject({
      host: "127.0.0.1",
      port: process.platform === "darwin" ? expect.any(Number) : 43123,
    });

    const child = spawn(
      process.execPath,
      [
        "-e",
        "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000)",
      ],
      { detached: true, stdio: "ignore" },
    );
    const tracked = prepared.trackProcess(child);
    await prepared.stopAndProve();
    await expect(tracked.wait()).resolves.toMatchObject({ signal: "SIGTERM" });
    await expect(lease.revoke()).resolves.toBeUndefined();
  });

  it("never turns a reserved engine port into a browser lease", async () => {
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const prepared = await boundary.prepare({
      executionId: "execution-engine-port",
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    await expect(
      prepared.requestPort({
        protocol: "tcp",
        preferredPort: 24293,
        targetPort: 24293,
        purpose: "debug",
      }),
    ).rejects.toThrow(/reserved control port/);
    await prepared.stopAndProve();
  });

  it("leases only a predeclared exact local service and revokes its façade", async () => {
    const target = createServer((peer) => {
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => peer.end(`postgres:${chunk}`));
    });
    await new Promise<void>((resolve, reject) => {
      target.once("error", reject);
      target.listen(0, "127.0.0.1", resolve);
    });
    const address = target.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const prepared = await boundary.prepare({
      executionId: "execution-service",
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
      localServices: [
        {
          serviceId: "db",
          kind: "database",
          transport: "tcp",
          targetHost: "127.0.0.1",
          targetPort: address.port,
          adapter: "postgres",
        },
      ],
    });
    try {
      await expect(
        prepared.requestLocalService({ kind: "docker", serviceId: "db" }),
      ).rejects.toThrow(/kind/i);
      const lease = await prepared.requestLocalService({
        kind: "database",
        serviceId: "db",
      });
      const facadePort = Number(lease.env.PGPORT);
      const response = await new Promise<string>((resolve, reject) => {
        const peer = connect({ host: lease.env.PGHOST, port: facadePort });
        let received = "";
        peer.setEncoding("utf8");
        peer.once("connect", () => peer.write("query"));
        peer.on("data", (chunk) => (received += chunk));
        peer.once("end", () => resolve(received));
        peer.once("error", reject);
      });
      expect(response).toBe("postgres:query");
      await lease.revoke();
    } finally {
      await prepared.stopAndProve();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("uses a sanitized writable GPG home while the exact agent lease is active", async () => {
    const sourceHome = path.join(root, "host-gnupg");
    await mkdir(path.join(sourceHome, "private-keys-v1.d"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(path.join(sourceHome, "pubring.kbx"), "public\n", {
      mode: 0o600,
    });
    await writeFile(
      path.join(sourceHome, "private-keys-v1.d", "private.key"),
      "secret\n",
      { mode: 0o600 },
    );
    const targetPath = path.join(sourceHome, "S.gpg-agent");
    const target = createServer((peer) => {
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => peer.write(`agent:${chunk}`));
    });
    await new Promise<void>((resolve, reject) => {
      target.once("error", reject);
      target.listen(targetPath, resolve);
    });
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const prepared = await boundary.prepare({
      executionId: "execution-gpg-service",
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
      localServices: [
        {
          serviceId: "gpg",
          kind: "gpg-agent",
          transport: "unix",
          targetPath,
          adapter: "gpg-agent",
          sourceHome,
        },
      ],
    });
    try {
      const lease = await prepared.requestLocalService({
        kind: "gpg-agent",
        serviceId: "gpg",
      });
      const launch = prepared.wrapSpawn({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: root,
          GNUPGHOME: sourceHome,
          GPG_AGENT_INFO: `${targetPath}:123:1`,
        },
      });
      const commandPath = launch.args[launch.args.indexOf("--command") + 1];
      const policyPath = launch.args[launch.args.indexOf("--policy") + 1];
      const descriptor = JSON.parse(await readFile(commandPath, "utf8")) as {
        env: Record<string, string>;
      };
      const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
        filesystem: { allowRead: string[]; allowWrite: string[] };
      };
      const projectedHome = descriptor.env.GNUPGHOME;
      const projectedSocket = path.join(projectedHome, "S.gpg-agent");
      expect(projectedHome).not.toBe(sourceHome);
      expect(descriptor.env.GPG_AGENT_INFO).toBe(`${projectedSocket}:0:1`);
      expect(
        await readFile(path.join(projectedHome, "pubring.kbx"), "utf8"),
      ).toBe("public\n");
      await expect(
        access(path.join(projectedHome, "private-keys-v1.d", "private.key")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        policy.filesystem.allowWrite.some(
          (allowed) =>
            path.relative(allowed, projectedHome) === "" ||
            (!path.relative(allowed, projectedHome).startsWith("..") &&
              !path.isAbsolute(path.relative(allowed, projectedHome))),
        ),
      ).toBe(true);
      expect(policy.filesystem.allowRead).not.toContain(sourceHome);
      const response = await new Promise<string>((resolve, reject) => {
        const peer = connect(projectedSocket);
        let received = "";
        peer.setEncoding("utf8");
        peer.once("connect", () => peer.write("sign"));
        peer.on("data", (chunk) => {
          received += chunk;
          peer.end();
        });
        peer.once("end", () => resolve(received));
        peer.once("error", reject);
      });
      expect(response).toBe("agent:sign");
      await lease.revoke();
    } finally {
      await prepared.stopAndProve();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  it("projects and durably promotes provider HOME without exposing host HOME", async () => {
    const hostHome = path.join(root, "host-home");
    await mkdir(path.join(hostHome, ".codex"), { recursive: true });
    await writeFile(
      path.join(hostHome, ".codex", "config.toml"),
      "model='host'\n",
    );
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const request = {
      executionId: "execution-provider-home-a",
      actor: "agent-code" as const,
      providerId: "codex",
      providerStateEnv: { HOME: hostHome },
      cwd: workspace,
      workspaceRoot: workspace,
    };
    const first = await boundary.prepare(request);
    const firstLaunch = first.wrapSpawn({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: hostHome },
    });
    const firstCommand =
      firstLaunch.args[firstLaunch.args.indexOf("--command") + 1];
    const firstDescriptor = JSON.parse(
      await readFile(firstCommand, "utf8"),
    ) as { env: Record<string, string> };
    expect(firstDescriptor.env.HOME).not.toBe(hostHome);
    expect(
      await readFile(
        path.join(firstDescriptor.env.HOME, ".codex", "config.toml"),
        "utf8",
      ),
    ).toBe("model='host'\n");
    await writeFile(
      path.join(firstDescriptor.env.HOME, ".codex", "config.toml"),
      "model='private'\n",
    );
    await first.stopAndProve();

    const second = await boundary.prepare({
      ...request,
      executionId: "execution-provider-home-b",
    });
    const secondLaunch = second.wrapSpawn({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: hostHome },
    });
    const secondCommand =
      secondLaunch.args[secondLaunch.args.indexOf("--command") + 1];
    const secondDescriptor = JSON.parse(
      await readFile(secondCommand, "utf8"),
    ) as { env: Record<string, string> };
    expect(
      await readFile(
        path.join(secondDescriptor.env.HOME, ".codex", "config.toml"),
        "utf8",
      ),
    ).toBe("model='private'\n");
    expect(
      await readFile(path.join(hostHome, ".codex", "config.toml"), "utf8"),
    ).toBe("model='host'\n");
    await second.stopAndProve();
  });

  it("projects a private Git repository and denies canonical control metadata", async () => {
    await runFile("git", ["init", "-b", "main"], { cwd: workspace });
    await runFile("git", ["config", "user.name", "Zeros Test"], {
      cwd: workspace,
    });
    await runFile("git", ["config", "user.email", "zeros@example.invalid"], {
      cwd: workspace,
    });
    await writeFile(path.join(workspace, "code.txt"), "initial\n");
    await runFile("git", ["add", "code.txt"], { cwd: workspace });
    await runFile("git", ["commit", "-m", "initial"], { cwd: workspace });

    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const prepared = await boundary.prepare({
      executionId: "execution-shadow-git",
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    const launch = prepared.wrapSpawn({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GH_TOKEN: "must-not-cross",
        SSH_AUTH_SOCK: "/tmp/host-agent.sock",
        ZEROS_GIT_AUTH_SOCKET: "/tmp/old-broker.sock",
      },
    });
    const commandPath = launch.args[launch.args.indexOf("--command") + 1];
    const policyPath = launch.args[launch.args.indexOf("--policy") + 1];
    const descriptor = JSON.parse(await readFile(commandPath, "utf8")) as {
      env: Record<string, string>;
      filesystemProjections?: Array<{
        source: string;
        destination: string;
        readOnly: boolean;
      }>;
    };
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
      filesystem: {
        allowRead: string[];
        denyRead: string[];
        denyWrite: string[];
      };
    };
    if (process.platform === "darwin") {
      expect(descriptor.env.GIT_DIR).toMatch(
        /\/boundary\/[^/]+\/git\/0-[^/]+\/git$/,
      );
      expect(descriptor.env.GIT_COMMON_DIR).toBe(descriptor.env.GIT_DIR);
      expect(descriptor.env.GIT_WORK_TREE).toBe(workspace);
      expect(descriptor.env.GIT_DIR).not.toBe(path.join(workspace, ".git"));
    } else {
      expect(descriptor.env.GIT_DIR).toBeUndefined();
      expect(descriptor.env.GIT_COMMON_DIR).toBeUndefined();
      expect(descriptor.env.GIT_WORK_TREE).toBeUndefined();
    }
    let repositoryProjection:
      | { source: string; destination: string; readOnly: boolean }
      | undefined;
    if (process.platform === "linux") {
      expect(descriptor.filesystemProjections).toHaveLength(1);
      repositoryProjection = descriptor.filesystemProjections![0];
      expect(repositoryProjection).toMatchObject({
        destination: path.join(workspace, ".git"),
        readOnly: false,
      });
    } else {
      expect(descriptor.filesystemProjections).toBeUndefined();
    }
    expect(descriptor.env.PATH?.split(path.delimiter)[0]).not.toBe(
      (process.env.PATH ?? "").split(path.delimiter)[0],
    );
    expect(descriptor.env.GH_TOKEN).toBeUndefined();
    expect(descriptor.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(descriptor.env.ZEROS_GIT_AUTH_SOCKET).toBeUndefined();
    expect(policy.filesystem.denyWrite).toContain(path.join(workspace, ".git"));
    expect(policy.filesystem.denyRead).toContain(path.join(workspace, ".git"));
    expect(policy.filesystem.allowRead).toContain(
      path.join(workspace, ".git", "objects"),
    );
    const toolsRoot = descriptor.env.PATH!.split(path.delimiter)[0]!;
    const dispatcher = await readFile(
      path.join(toolsRoot, "git-dispatcher.mjs"),
      "utf8",
    );
    expect(dispatcher).toContain("discoverEntry");
    const repositoryId = repositoryProjection
      ? path.basename(path.dirname(repositoryProjection.source))
      : /git-repositories\/([^/]+)\/git/.exec(dispatcher)?.[1];
    expect(repositoryId).toBeTruthy();
    const gitClient = await readFile(
      path.join(toolsRoot, "git-repositories", repositoryId!, "git-client.mjs"),
      "utf8",
    );
    expect(gitClient).toContain('"host":"127.0.0.1"');
    expect(gitClient).toMatch(/"port":\d+/);
    const networkPolicy = JSON.parse(await readFile(policyPath, "utf8")) as {
      runtime: { allowedLocalPorts: number[]; deniedLocalPorts: number[] };
    };
    expect(networkPolicy.runtime.allowedLocalPorts).toHaveLength(1);
    expect(networkPolicy.runtime.deniedLocalPorts).not.toContain(
      networkPolicy.runtime.allowedLocalPorts[0],
    );
    await prepared.stopAndProve();
  });

  it("projects every admitted Design-bearing Git owner and rejects an owner outside its grant", async () => {
    const secondary = path.join(root, "secondary");
    const primaryDesign = path.join(workspace, "Zeros Design");
    const secondaryDesign = path.join(secondary, "Zeros Design");
    await Promise.all([
      mkdir(primaryDesign, { recursive: true }),
      mkdir(secondaryDesign, { recursive: true }),
    ]);
    for (const repository of [workspace, secondary]) {
      await runFile("git", ["init", "-b", "main"], { cwd: repository });
      await runFile("git", ["config", "user.name", "Zeros Test"], {
        cwd: repository,
      });
      await runFile("git", ["config", "user.email", "zeros@example.invalid"], {
        cwd: repository,
      });
      await Promise.all([
        writeFile(path.join(repository, "code.txt"), "initial\n"),
        writeFile(
          path.join(repository, "Zeros Design", "document.json"),
          '{"safe":true}\n',
        ),
      ]);
      await runFile("git", ["add", "--", "code.txt", "Zeros Design"], {
        cwd: repository,
      });
      await runFile("git", ["commit", "-m", "initial"], {
        cwd: repository,
      });
    }
    const territory = {
      agentRole: "code" as const,
      workspaceRoot: workspace,
      designDirectory: primaryDesign,
      protectedDesignDirectories: [primaryDesign, secondaryDesign],
      writeCapabilities: {
        workspace: "write" as const,
        deniedPaths: [
          primaryDesign,
          path.join(workspace, ".git"),
          secondaryDesign,
          path.join(secondary, ".git"),
        ],
      },
    };
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const baseRequest = {
      executionId: "execution-multi-shadow-git",
      actor: "agent-code" as const,
      cwd: workspace,
      workspaceRoot: workspace,
      territory,
      additionalGitWorkspaceRoots: [secondary],
    };
    await expect(boundary.prepare(baseRequest)).rejects.toThrow(
      /outside write grants/,
    );

    const prepared = await boundary.prepare({
      ...baseRequest,
      executionId: "execution-multi-shadow-git-admitted",
      additionalReadWriteRoots: [secondary],
    });
    const launch = prepared.wrapSpawn({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    const commandPath = launch.args[launch.args.indexOf("--command") + 1];
    const descriptor = JSON.parse(await readFile(commandPath, "utf8")) as {
      filesystemProjections?: Array<{
        source: string;
        destination: string;
        readOnly: boolean;
      }>;
    };
    if (process.platform === "linux") {
      expect(
        descriptor.filesystemProjections?.map(
          (projection) => projection.destination,
        ),
      ).toEqual([path.join(workspace, ".git"), path.join(secondary, ".git")]);
    }
    expect(prepared.status.parity).toEqual({ level: "full", restrictions: [] });
    await prepared.stopAndProve();
  });

  it("projects a read-only .git pointer for linked worktrees", async () => {
    const repository = path.join(root, "repository");
    await mkdir(repository);
    await runFile("git", ["init", "-b", "main"], { cwd: repository });
    await runFile("git", ["config", "user.name", "Zeros Test"], {
      cwd: repository,
    });
    await runFile("git", ["config", "user.email", "zeros@example.invalid"], {
      cwd: repository,
    });
    await writeFile(path.join(repository, "code.txt"), "initial\n");
    await runFile("git", ["add", "code.txt"], { cwd: repository });
    await runFile("git", ["commit", "-m", "initial"], { cwd: repository });
    await rm(workspace, { recursive: true, force: true });
    await runFile("git", ["worktree", "add", "-b", "feature", workspace], {
      cwd: repository,
    });

    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const prepared = await boundary.prepare({
      executionId: "execution-linked-worktree",
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    const launch = prepared.wrapSpawn({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    const commandPath = launch.args[launch.args.indexOf("--command") + 1];
    const descriptor = JSON.parse(await readFile(commandPath, "utf8")) as {
      env: Record<string, string>;
      filesystemProjections?: Array<{
        source: string;
        destination: string;
        readOnly: boolean;
      }>;
    };
    if (process.platform === "linux") {
      expect(descriptor.filesystemProjections).toHaveLength(1);
      const projection = descriptor.filesystemProjections![0];
      expect(projection).toMatchObject({
        destination: path.join(workspace, ".git"),
        readOnly: true,
      });
      const pointer = await readFile(projection.source, "utf8");
      expect(pointer).toMatch(/^gitdir: \/.*\/git\n$/);
      expect(pointer).not.toContain(path.join(workspace, ".git"));
    } else {
      expect(descriptor.filesystemProjections).toBeUndefined();
    }
    await prepared.stopAndProve();
  });
});
