import { spawn } from "node:child_process";
import {
  access,
  chmod,
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
import {
  armCursorStateRecovery,
  prepareCursorStateOverlay,
} from "../../adapters/cursor-sdk/state-overlay";
import { AdmissionGate } from "../admission-gate";
import { MacosContainerWorkerUnavailableError } from "../macos-orbstack-container-worker";
import type { MacosProcessDomainCommandRunner } from "../macos-process-domain";
import {
  armProviderHomeRecovery,
  prepareProviderHomeOverlay,
} from "../provider-home-overlay";
import {
  ZsrExecutionBoundary as RuntimeZsrExecutionBoundary,
  type ZsrBoundaryOptions,
} from "../zsr-boundary";
import { sessionDir } from "../../session-paths";

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
      // Most tests below exercise the separately retained cloud/isolated
      // machinery. Production desktop constructors select host parity
      // explicitly; tests opt into that contract where it is material.
      localHostParity: options.localHostParity ?? false,
      ...(process.platform === "darwin" ? { macosProcessDomainRunner } : {}),
    });
  }
}

const PASSING_SUPERVISOR = String.raw`
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
const commandPath = process.argv[process.argv.indexOf("--command") + 1];
const descriptor = JSON.parse(readFileSync(commandPath, "utf8"));
if (descriptor.env.HOST_PARITY_CANARY) {
  const spec = JSON.parse(Buffer.from(descriptor.args.at(-1), "base64url").toString("utf8"));
  const designWritable = spec.actor === "design-agent";
  const result = {
    codeWrite: !designWritable,
    designWrite: spec.designDirectories.map(() => designWritable),
    designAliasWrite: spec.designDirectories.length > 0 ? designWritable : true,
    hostRead: true,
    canonicalGitRead: true,
    environmentExact: Object.entries(spec.expectedEnv).every(
      ([name, value]) => descriptor.env[name] === value,
    ),
    // The real supervisor rewrites TLS-trust variables only when it snapshotted a
    // private bundle, which host parity never does. This stub stands in for that
    // decision, so it answers from the descriptor the engine actually wrote.
    environmentUninjected: spec.absentEnv.every(
      (name) => descriptor.env[name] === undefined,
    ),
    sandboxPid: process.pid,
  };
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
}
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
  let previousSrtDebug: string | undefined;
  let supervisor: string;
  let workspace: string;

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(boundaryTmpdir, "zeros-zsr-boundary-test-")),
    );
    previousDataDir = process.env.ZEROS_DATA_DIR;
    previousSrtDebug = process.env.SRT_DEBUG;
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
    if (previousSrtDebug === undefined) delete process.env.SRT_DEBUG;
    else process.env.SRT_DEBUG = previousSrtDebug;
    await rm(root, { recursive: true, force: true });
  });

  it("admits only after a behavioral canary and emits one-shot private descriptors", async () => {
    process.env.SRT_DEBUG = "1";
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
    await expect(
      readFile(path.join(sessionDir(request.executionId), "meta.json"), "utf8"),
    ).resolves.toSatisfy((raw: string) => {
      const meta = JSON.parse(raw) as Record<string, unknown>;
      return (
        meta.agentId === request.providerId &&
        meta.actor === request.actor &&
        meta.cwd === request.cwd &&
        meta.pid === process.pid &&
        typeof meta.createdAt === "number" &&
        meta.createdAt > 0
      );
    });
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
    // Debugging is a trusted-supervisor concern: operators can turn on SRT's
    // redacted proxy diagnostics, but the provider child still receives only
    // its explicit descriptor environment below.
    expect(launch.env.SRT_DEBUG).toBe("1");
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
    expect(descriptor.env.SRT_DEBUG).toBeUndefined();
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
    await expect(access(sessionDir(request.executionId))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });

  it("keeps the canonical host environment and Git in local host-parity mode", async () => {
    await runFile("git", ["init", "-b", "main"], { cwd: workspace });
    const design = path.join(workspace, "Zeros Design");
    const secondDesign = path.join(workspace, "examples", "Design");
    const hostHome = path.join(root, "real-home");
    await Promise.all([
      mkdir(design, { recursive: true }),
      mkdir(secondDesign, { recursive: true }),
      mkdir(hostHome, { recursive: true }),
    ]);
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      localHostParity: true,
    });
    const prepared = await boundary.prepare({
      executionId: "execution-host-parity",
      actor: "agent-code",
      providerId: "codex",
      providerStateEnv: { HOME: hostHome },
      cwd: workspace,
      workspaceRoot: workspace,
      territory: {
        agentRole: "code",
        workspaceRoot: workspace,
        designDirectory: design,
        protectedDesignDirectories: [design, secondDesign],
        designRecognitionPaths: [
          path.join(workspace, ".zeros"),
          path.join(design, ".zeros-canvas.json"),
        ],
        writeCapabilities: {
          workspace: "write",
          deniedPaths: [design, secondDesign, path.join(workspace, ".git")],
        },
      },
    });
    expect(prepared.providerHomePath).toBe(hostHome);
    // A parity session in a real repository reports `native`, not
    // `not-applicable`: it uses the workspace's own Git with nothing to promote,
    // and the chat's boundary row renders the two differently.
    expect(prepared.status.git?.state).toBe("native");

    const childEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: hostHome,
      GH_TOKEN: "host-gh-token",
      GITHUB_TOKEN: "host-github-token",
      SSH_AUTH_SOCK: path.join(root, "ssh-agent.sock"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Host User",
    };
    const launch = prepared.wrapSpawn({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      env: childEnv,
    });
    const commandPath = launch.args[launch.args.indexOf("--command") + 1];
    const policyPath = launch.args[launch.args.indexOf("--policy") + 1];
    const descriptor = JSON.parse(await readFile(commandPath, "utf8")) as {
      env: Record<string, string>;
      credentialCapabilities?: unknown[];
      filesystemProjections?: unknown[];
      networkBridge?: unknown;
    };
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
      filesystem: { denyRead: string[]; denyWrite: string[] };
      runtime: { localHostParity?: boolean };
    };

    expect(descriptor.env).toMatchObject(childEnv);
    expect(descriptor.env.GIT_DIR).toBeUndefined();
    expect(descriptor.env.DOCKER_HOST).toBeUndefined();
    expect(descriptor.credentialCapabilities).toBeUndefined();
    expect(descriptor.filesystemProjections).toBeUndefined();
    expect(descriptor.networkBridge).toBeUndefined();
    expect(policy.runtime.localHostParity).toBe(true);
    expect(policy.filesystem.denyWrite).toEqual(
      expect.arrayContaining([design, secondDesign]),
    );
    expect(policy.filesystem.denyWrite).not.toContain(
      path.join(workspace, ".git"),
    );
    // Recognition inputs are NOT denied under parity: `.zeros/settings.toml` is
    // committed repository content, and denying it broke every `git pull` that
    // had to rewrite it. Engine-side sticky recognition covers de-registration
    // instead — so the memory itself is denied, since nothing checks that out.
    expect(policy.filesystem.denyWrite).not.toContain(
      path.join(workspace, ".zeros"),
    );
    expect(policy.filesystem.denyWrite).toContain(
      path.join(process.env.ZEROS_DATA_DIR ?? "", "design-recognition.json"),
    );
    // The canvas marker needs no rule of its own: it lives inside a protected
    // directory, so the Design content deny already covers it.
    expect(policy.filesystem.denyWrite).not.toContain(
      path.join(design, ".zeros-canvas.json"),
    );
    expect(policy.filesystem.denyRead).not.toContain(
      process.env.ZEROS_DATA_DIR,
    );

    await expect(
      prepared.requestPort({
        protocol: "udp",
        preferredPort: 80,
        purpose: "dev-server",
      }),
    ).resolves.toMatchObject({ port: 80, targetPort: 80 });
    await prepared.stopAndProve();
  });

  it("reports no repository when a local host-parity workspace has none", async () => {
    const bare = path.join(root, "not-a-repo");
    await mkdir(bare, { recursive: true });
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      localHostParity: true,
    });
    const prepared = await boundary.prepare({
      executionId: "execution-host-parity-no-git",
      actor: "agent-code",
      providerId: "codex",
      cwd: bare,
      workspaceRoot: bare,
    });
    expect(prepared.status.git?.state).toBe("not-applicable");
    await prepared.stopAndProve();
  });

  it("cancels a local host-parity admission and leaves nothing behind", async () => {
    const design = path.join(workspace, "Zeros Design");
    await mkdir(design, { recursive: true });
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      localHostParity: true,
    });
    const controller = new AbortController();
    // Aborted before `prepare` runs, so the very first checkpoint fires. The
    // signal used to be read once and then dropped, which meant a chat closed
    // mid-admission still got a fully-built boundary handed to nobody.
    controller.abort();
    const executionId = "execution-host-parity-cancelled";
    await expect(
      boundary.prepare(
        {
          executionId,
          actor: "agent-code",
          providerId: "codex",
          cwd: workspace,
          workspaceRoot: workspace,
          territory: {
            agentRole: "code",
            workspaceRoot: workspace,
            designDirectory: design,
            protectedDesignDirectories: [design],
            designRecognitionPaths: [],
            writeCapabilities: { workspace: "write", deniedPaths: [design] },
          },
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled/);
    await expect(access(sessionDir(executionId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  (process.platform === "linux" ? it : it.skip)(
    "enforces the host-parity write fence in the real Linux runtime",
    async () => {
      const design = path.join(workspace, "Zeros Design");
      const protectedFile = path.join(design, "protected.txt");
      const hostVisibleFile = path.join(root, "host-visible.log");
      const hostHome = path.join(root, "host-home-parity");
      const hookMarker = path.join(root, "pre-push-ran");
      const remote = path.join(root, "remote.git");
      await Promise.all([
        mkdir(design, { recursive: true }),
        mkdir(hostHome, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(protectedFile, "original\n"),
        writeFile(hostVisibleFile, "host-log\n"),
      ]);
      await runFile("git", ["init", "-b", "main"], { cwd: workspace });
      await runFile("git", ["config", "user.name", "Host User"], {
        cwd: workspace,
      });
      await runFile("git", ["config", "user.email", "host@example.test"], {
        cwd: workspace,
      });
      await writeFile(path.join(workspace, "code.txt"), "initial\n");
      await runFile("git", ["add", "code.txt"], { cwd: workspace });
      await runFile("git", ["commit", "-m", "initial"], { cwd: workspace });
      await runFile("git", ["init", "--bare", remote], { cwd: root });
      await runFile("git", ["remote", "add", "origin", remote], {
        cwd: workspace,
      });
      const prePushHook = path.join(workspace, ".git", "hooks", "pre-push");
      await writeFile(
        prePushHook,
        `#!/bin/sh\nprintf 'ran\\n' > ${JSON.stringify(hookMarker)}\n`,
      );
      await chmod(prePushHook, 0o700);
      const boundary = new RuntimeZsrExecutionBoundary({
        projectRoot: process.cwd(),
        localHostParity: true,
      });
      const prepared = await boundary.prepare({
        executionId: "execution-real-host-parity",
        actor: "agent-code",
        providerId: "codex",
        providerStateEnv: { HOME: hostHome },
        cwd: workspace,
        workspaceRoot: workspace,
        territory: {
          agentRole: "code",
          workspaceRoot: workspace,
          designDirectory: design,
          protectedDesignDirectories: [design],
          designRecognitionPaths: [],
          writeCapabilities: {
            workspace: "write",
            deniedPaths: [design, path.join(workspace, ".git")],
          },
        },
      });
      try {
        const child = await prepared.spawn({
          command: process.execPath,
          args: [
            "-e",
            String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [hostFile, codeFile, designFile] = process.argv.slice(1);
let designDenied = false;
try { fs.writeFileSync(designFile, "mutated\n"); } catch { designDenied = true; }
fs.writeFileSync(codeFile, "code\n");
const commands = [
  ["-c", "core.abbrev=12", "status", "--porcelain"],
  ["add", "code.txt"],
  ["commit", "-m", "host parity"],
  ["reset", "--hard", "HEAD"],
  ["push", "-u", "origin", "main"],
];
const git = commands.map((args) => spawnSync("git", args, { encoding: "utf8" }));
process.stdout.write(JSON.stringify({
  host: fs.readFileSync(hostFile, "utf8"),
  designDenied,
  design: fs.readFileSync(designFile, "utf8"),
  gh: process.env.GH_TOKEN,
  ssh: process.env.SSH_AUTH_SOCK,
  home: process.env.HOME,
  gitStatuses: git.map((result) => result.status),
  gitStderr: git.map((result) => result.stderr).join(""),
}) + "\n");`,
            hostVisibleFile,
            path.join(workspace, "code.txt"),
            protectedFile,
          ],
          cwd: workspace,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: hostHome,
            GH_TOKEN: "real-host-token",
            SSH_AUTH_SOCK: path.join(root, "real-host-agent.sock"),
          },
          stdio: "pipe",
        });
        let stdout = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        await expect(child.wait()).resolves.toMatchObject({ code: 0 });
        const result = JSON.parse(stdout.trim()) as {
          gitStderr: string;
          [key: string]: unknown;
        };
        expect(result.gitStderr).not.toContain("[zsr");
        expect(result).toMatchObject({
          host: "host-log\n",
          designDenied: true,
          design: "original\n",
          gh: "real-host-token",
          ssh: path.join(root, "real-host-agent.sock"),
          home: hostHome,
          gitStatuses: [0, 0, 0, 0, 0],
        });
        await expect(readFile(hookMarker, "utf8")).resolves.toBe("ran\n");
      } finally {
        await prepared.stopAndProve();
      }
    },
  );

  // The two fence tests above run `git reset --hard` with the Design tree already
  // matching HEAD, so git never actually tries to write a Design path and the
  // kernel deny is never exercised THROUGH git. This one diverges the tracked
  // Design file from HEAD first, from outside the fence, so the restore genuinely
  // attempts the write the boundary must refuse.
  (process.platform === "linux" ? it : it.skip)(
    "preserves Design bytes when git itself tries to restore them",
    async () => {
      const design = path.join(workspace, "Zeros Design");
      const designFile = path.join(design, "canvas.json");
      const codeFile = path.join(workspace, "code.txt");
      const hostHome = path.join(root, "host-home-git-restore");
      await Promise.all([
        mkdir(design, { recursive: true }),
        mkdir(hostHome, { recursive: true }),
      ]);
      await runFile("git", ["init", "-b", "main"], { cwd: workspace });
      await runFile("git", ["config", "user.name", "Host User"], {
        cwd: workspace,
      });
      await runFile("git", ["config", "user.email", "host@example.test"], {
        cwd: workspace,
      });
      await Promise.all([
        writeFile(codeFile, "committed-code\n"),
        writeFile(designFile, '{"generation":1}\n'),
      ]);
      await runFile("git", ["add", "--", "code.txt", "Zeros Design"], {
        cwd: workspace,
      });
      await runFile("git", ["commit", "-m", "committed"], { cwd: workspace });
      // Divergence created by the trusted side, which is exactly how it happens
      // in production: the Design canvas is edited by Zeros itself while a code
      // agent works in the same checkout.
      await Promise.all([
        writeFile(codeFile, "working-tree-code\n"),
        writeFile(designFile, '{"generation":2}\n'),
      ]);
      const boundary = new RuntimeZsrExecutionBoundary({
        projectRoot: process.cwd(),
        localHostParity: true,
      });
      const prepared = await boundary.prepare({
        executionId: "execution-parity-git-restore",
        actor: "agent-code",
        providerId: "codex",
        providerStateEnv: { HOME: hostHome },
        cwd: workspace,
        workspaceRoot: workspace,
        territory: {
          agentRole: "code",
          workspaceRoot: workspace,
          designDirectory: design,
          protectedDesignDirectories: [design],
          designRecognitionPaths: [
            path.join(workspace, ".zeros"),
            path.join(design, ".zeros-canvas.json"),
          ],
          writeCapabilities: {
            workspace: "write",
            deniedPaths: [design, path.join(workspace, ".git")],
          },
        },
      });
      try {
        const child = await prepared.spawn({
          command: process.execPath,
          args: [
            "-e",
            String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [designFile, codeFile] = process.argv.slice(1);
const reset = spawnSync("git", ["reset", "--hard", "HEAD"], { encoding: "utf8" });
const checkout = spawnSync("git", ["checkout", "--", "."], { encoding: "utf8" });
process.stdout.write(JSON.stringify({
  resetStatus: reset.status,
  resetStderr: reset.stderr,
  checkoutStatus: checkout.status,
  design: fs.readFileSync(designFile, "utf8"),
  code: fs.readFileSync(codeFile, "utf8"),
}) + "\n");`,
            designFile,
            codeFile,
          ],
          cwd: workspace,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: hostHome,
          },
          stdio: "pipe",
        });
        let stdout = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        await expect(child.wait()).resolves.toMatchObject({ code: 0 });
        const result = JSON.parse(stdout.trim()) as {
          resetStatus: number | null;
          resetStderr: string;
          checkoutStatus: number | null;
          design: string;
          code: string;
        };
        // The invariant: git ran as the agent's own native git, tried to write a
        // protected path, and failed on that path alone. Design bytes are
        // untouched and the failure is git's own — not a Zeros wrapper message.
        expect(result.design).toBe('{"generation":2}\n');
        expect(result.resetStatus).not.toBe(0);
        expect(result.checkoutStatus).not.toBe(0);
        expect(result.resetStderr).not.toContain("[zsr");
        expect(result.resetStderr).toContain("Zeros Design/canvas.json");
        // And the accepted trade (see the pivot decision): the operation is not
        // atomic any more. The code half of the same command is free to have
        // applied, which is why this asserts the Design guarantee rather than
        // whole-command rollback.
        expect(["committed-code\n", "working-tree-code\n"]).toContain(
          result.code,
        );
        // Nothing outside the fence changed the file either.
        await expect(readFile(designFile, "utf8")).resolves.toBe(
          '{"generation":2}\n',
        );
      } finally {
        await prepared.stopAndProve();
      }
    },
  );

  // The decision that replaced denying the recognition inputs: `.zeros` is
  // ordinary committed repository content, so a fenced checkout or pull that has
  // to rewrite the Design pointer must succeed like any other file. De-recognition
  // is covered by engine-side sticky recognition instead. Denying this path made
  // every `git pull` that touched team settings fail on it, which is exactly the
  // "works like before ZSR" promise being broken for a narrow gain.
  (process.platform === "linux" ? it : it.skip)(
    "lets git restore the Design pointer like any other tracked file",
    async () => {
      const design = path.join(workspace, "Zeros Design");
      const settings = path.join(workspace, ".zeros");
      const settingsFile = path.join(settings, "settings.toml");
      const codeFile = path.join(workspace, "code.txt");
      await Promise.all([
        mkdir(design, { recursive: true }),
        mkdir(settings, { recursive: true }),
      ]);
      await runFile("git", ["init", "-b", "main"], { cwd: workspace });
      await runFile("git", ["config", "user.name", "Host User"], {
        cwd: workspace,
      });
      await runFile("git", ["config", "user.email", "host@example.test"], {
        cwd: workspace,
      });
      await Promise.all([
        writeFile(path.join(design, ".zeros-canvas.json"), "{}\n"),
        writeFile(settingsFile, '[design]\ndirectory = "Zeros Design"\n'),
        writeFile(codeFile, "v1\n"),
      ]);
      await runFile("git", ["add", "-A"], { cwd: workspace });
      await runFile("git", ["commit", "-m", "one"], { cwd: workspace });
      const base = (
        await runFile("git", ["rev-parse", "HEAD"], { cwd: workspace })
      ).stdout.trim();
      await Promise.all([
        writeFile(
          settingsFile,
          '[design]\ndirectory = "Zeros Design"\n[agents]\nfoo = "bar"\n',
        ),
        writeFile(codeFile, "v2\n"),
      ]);
      await runFile("git", ["add", "-A"], { cwd: workspace });
      await runFile("git", ["commit", "-m", "two"], { cwd: workspace });
      const boundary = new RuntimeZsrExecutionBoundary({
        projectRoot: process.cwd(),
        localHostParity: true,
      });
      const prepared = await boundary.prepare({
        executionId: "execution-parity-settings-checkout",
        actor: "agent-code",
        providerId: "codex",
        cwd: workspace,
        workspaceRoot: workspace,
        territory: {
          agentRole: "code",
          workspaceRoot: workspace,
          designDirectory: design,
          protectedDesignDirectories: [design],
          designRecognitionPaths: [
            settings,
            path.join(design, ".zeros-canvas.json"),
          ],
          writeCapabilities: {
            workspace: "write",
            deniedPaths: [design, settings],
          },
        },
      });
      try {
        const child = await prepared.spawn({
          command: process.execPath,
          args: [
            "-e",
            String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const base = process.argv[1];
const checkout = spawnSync("git", ["checkout", base, "--", ".zeros/settings.toml", "code.txt"], { encoding: "utf8" });
let markerDenied = false;
try { fs.writeFileSync("Zeros Design/.zeros-canvas.json", "de-registered\n"); }
catch { markerDenied = true; }
process.stdout.write(JSON.stringify({
  status: checkout.status,
  stderr: checkout.stderr,
  code: fs.readFileSync("code.txt", "utf8"),
  settings: fs.readFileSync(".zeros/settings.toml", "utf8"),
  markerDenied,
}) + "\n");`,
            base,
          ],
          cwd: workspace,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          stdio: "pipe",
        });
        let stdout = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        await expect(child.wait()).resolves.toMatchObject({ code: 0 });
        const result = JSON.parse(stdout.trim()) as {
          status: number | null;
          stderr: string;
          code: string;
          settings: string;
          markerDenied: boolean;
        };
        // The whole command succeeds — pointer and code both restored. This is
        // the `git pull` case that the earlier deny turned into a hard failure.
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.settings).not.toContain('foo = "bar"');
        expect(result.code).toBe("v1\n");
        // And the marker is still unwritable, because it lives inside protected
        // Design territory. Dropping the recognition deny gave up the `.zeros`
        // pointer, not the Design tree.
        expect(result.markerDenied).toBe(true);
      } finally {
        await prepared.stopAndProve();
      }
    },
  );

  (process.platform === "linux" ? it : it.skip)(
    "enforces the inverse design-agent write fence in the real Linux runtime",
    async () => {
      const design = path.join(workspace, "Zeros Design");
      const designFile = path.join(design, "canvas.json");
      const outside = path.join(root, "outside-cache");
      await mkdir(design, { recursive: true });
      await writeFile(designFile, "before\n");
      await runFile("git", ["init", "-b", "main"], { cwd: workspace });
      await runFile("git", ["config", "user.name", "Zeros Test"], {
        cwd: workspace,
      });
      await runFile("git", ["config", "user.email", "zeros@example.invalid"], {
        cwd: workspace,
      });
      await writeFile(path.join(workspace, "tracked-code.txt"), "before\n");
      await runFile("git", ["add", "--", "tracked-code.txt"], {
        cwd: workspace,
      });
      await runFile("git", ["commit", "-m", "initial"], { cwd: workspace });
      const boundary = new RuntimeZsrExecutionBoundary({
        projectRoot: process.cwd(),
        localHostParity: true,
      });
      const prepared = await boundary.prepare({
        executionId: "execution-real-design-parity",
        actor: "design-agent",
        cwd: workspace,
        workspaceRoot: workspace,
        territory: {
          agentRole: "code",
          workspaceRoot: workspace,
          designDirectory: design,
          protectedDesignDirectories: [design],
          designRecognitionPaths: [],
          writeCapabilities: {
            workspace: "write",
            deniedPaths: [design, path.join(workspace, ".git")],
          },
        },
      });
      try {
        const child = await prepared.spawn({
          command: process.execPath,
          args: [
            "-e",
            String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [codeFile, designFile, outsideFile] = process.argv.slice(1);
let codeDenied = false;
try { fs.writeFileSync(codeFile, "code\n", { flag: "wx" }); } catch { codeDenied = true; }
fs.writeFileSync(designFile, "after\n");
fs.writeFileSync(outsideFile, "cache\n");
const git = spawnSync("git", ["add", "Zeros Design/canvas.json"], { encoding: "utf8" });
process.stdout.write(JSON.stringify({
  codeDenied,
  design: fs.readFileSync(designFile, "utf8"),
  gitStatus: git.status,
  gitStderr: git.stderr,
}));`,
            path.join(workspace, "forbidden-code.txt"),
            designFile,
            outside,
          ],
          cwd: workspace,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          stdio: "pipe",
        });
        let stdout = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        await expect(child.wait()).resolves.toMatchObject({ code: 0 });
        expect(JSON.parse(stdout)).toEqual({
          codeDenied: true,
          design: "after\n",
          gitStatus: 0,
          gitStderr: "",
        });
        await expect(readFile(outside, "utf8")).resolves.toBe("cache\n");
      } finally {
        await prepared.stopAndProve();
      }
    },
  );

  it("shares one credential-free OrbStack worker per local workspace", async () => {
    const design = path.join(workspace, "Zeros Design");
    await mkdir(design, { recursive: true });
    let reservations = 0;
    let starts = 0;
    let stops = 0;
    let reservedExecutionId = "";
    let reservedSessionRoot = "";
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      localHostParity: true,
      macosContainerWorkerFactory: () => ({
        reserve: async (request) => {
          reservations += 1;
          reservedExecutionId = request.executionId;
          reservedSessionRoot = request.sessionRoot;
          return {
            hostPort: 43_219,
            machineName: "zeros-zsr-workspace-shared",
            environment: {
              DOCKER_HOST: "tcp://127.0.0.1:43219",
              CONTAINER_HOST: "tcp://127.0.0.1:43219",
            },
            start: async () => {
              starts += 1;
            },
            stopAndProve: async () => {
              stops += 1;
            },
          };
        },
      }),
    });
    const request = (executionId: string) => ({
      executionId,
      actor: "agent-code" as const,
      cwd: workspace,
      workspaceRoot: workspace,
      territory: {
        agentRole: "code" as const,
        workspaceRoot: workspace,
        designDirectory: design,
        protectedDesignDirectories: [design],
        designRecognitionPaths: [],
        writeCapabilities: {
          workspace: "write" as const,
          deniedPaths: [design, path.join(workspace, ".git")],
        },
      },
      containerWorker: {
        runtime: "podman" as const,
        backend: "orbstack-machine" as const,
        executable: process.execPath,
      },
      containerWorkflowExpected: true,
    });

    const first = await boundary.prepare(request("workspace-worker-one"));
    const second = await boundary.prepare(request("workspace-worker-two"));
    expect(reservations).toBe(1);
    expect(starts).toBe(2);
    expect(reservedExecutionId).toMatch(/^zsrw-[a-f0-9]{20}$/);
    expect(path.basename(reservedSessionRoot)).toBe(reservedExecutionId);
    expect(reservedSessionRoot).not.toContain("workspace-worker-one");
    expect(reservedSessionRoot).not.toContain("workspace-worker-two");

    await first.stopAndProve();
    expect(stops).toBe(0);
    await second.stopAndProve();
    expect(stops).toBe(1);
  });

  it("keeps exact-admission support paths out of the Git worktree", async () => {
    const design = path.join(workspace, "Zeros Design");
    const witness = path.join(root, "admission-paths.json");
    await mkdir(design, { recursive: true });
    await writeFile(
      supervisor,
      PASSING_SUPERVISOR.replace(
        'if (descriptor.env.ZEROS_ADMISSION_SENTINEL) {\n  const spec = JSON.parse(Buffer.from(descriptor.args.at(-1), "base64url").toString("utf8"));',
        `if (descriptor.env.ZEROS_ADMISSION_SENTINEL) {
  const spec = JSON.parse(Buffer.from(descriptor.args.at(-1), "base64url").toString("utf8"));
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
        designRecognitionPaths: [],
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
    // The trusted-runtime check rejects group/world-writable ancestors, and a
    // permissive host umask (0002 on some CI/sandbox images) would leak into
    // the recursive mkdir above. Pin the bundle chain explicitly.
    for (const directory of [
      path.dirname(contents),
      contents,
      path.dirname(runtime),
      path.join(contents, "Frameworks"),
    ]) {
      await chmod(directory, 0o755);
    }
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
    const reserve = vi.fn(async () => {
      throw new MacosContainerWorkerUnavailableError(
        "insufficient-disk-space",
        "OrbStack needs at least 4 GiB free",
      );
    });
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      macosContainerWorkerFactory: () => ({
        reserve,
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
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "orbstack-unavailable" }),
      { activation: "on-first-connection" },
    );
    await prepared.stopAndProve();
    warning.mockRestore();
  });

  it("re-admits after a container-worker fallback without re-entering the admission gate", async () => {
    // The fallback re-runs admission from inside an admission that already
    // holds a gate slot. Taking the gate again there would deadlock the moment
    // the slot count is exhausted — which in production is two. A gate of one
    // makes that failure deterministic instead of load-dependent.
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stopAndProve = vi.fn(async () => undefined);
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      admissionGate: new AdmissionGate({ limit: 1 }),
      macosContainerWorkerFactory: () => ({
        reserve: async () => ({
          hostPort: 42_321,
          machineName: "zeros-zsr-abcdef0123456789abce",
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
      executionId: "orbstack-gate-reentry",
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

    expect(prepared.status.parity.restrictions).toContain(
      "container-workflows-unavailable",
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
    const launch = prepared.wrapSpawn({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: path.join(root, "provider-home"),
      },
    });
    const commandPath = launch.args[launch.args.indexOf("--command") + 1];
    const descriptor = JSON.parse(await readFile(commandPath, "utf8")) as {
      env: Record<string, string>;
    };
    const recoverySentinel = path.join(
      descriptor.env.HOME,
      ".codex",
      "recovery-sentinel",
    );
    await mkdir(path.dirname(recoverySentinel), { recursive: true });
    await writeFile(recoverySentinel, "must remain until proof\n");

    await expect(prepared.stopAndProve()).rejects.toThrow(
      "failed to revoke boundary capabilities",
    );
    await expect(readFile(recoverySentinel, "utf8")).resolves.toBe(
      "must remain until proof\n",
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

  it("refuses a container engine to a design actor and says why", async () => {
    // A container engine is a shared namespace, so it must never be a place
    // where design and code authority can meet. The refusal is by rule: it
    // happens before any backend/platform validation, and it degrades to the
    // ordinary parity restriction rather than failing the session.
    await writeFile(
      supervisor,
      // A design actor must prove it CANNOT write code territory.
      PASSING_SUPERVISOR.replace("codeWrite: true,", "codeWrite: false,"),
      { mode: 0o700 },
    );
    const hostHome = path.join(root, "host-home");
    await mkdir(hostHome, { recursive: true });
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const prepared = await boundary.prepare({
      executionId: "design-container-refusal",
      actor: "design-agent",
      providerId: "codex",
      providerStateEnv: { HOME: hostHome },
      cwd: workspace,
      workspaceRoot: workspace,
      containerWorkflowExpected: true,
      containerWorker: {
        runtime: "podman",
        backend: "embedded-linux",
        executable: "/bin/sh",
      },
    });
    try {
      expect(prepared.status.parity.restrictions).toContain(
        "container-workflows-unavailable",
      );
      expect(prepared.status.remediation).toMatch(
        /Design sessions never run containers/,
      );
      expect(prepared.status.services?.kinds ?? []).not.toContain("podman");
      expect(prepared.status.services?.activeCount).toBe(0);
    } finally {
      await prepared.stopAndProve();
    }

    // The rule is scoped to design actors: a code actor's invalid worker still
    // reaches validation instead of being silently dropped.
    await expect(
      boundary.prepare({
        executionId: "code-container-validated",
        actor: "agent-code",
        providerId: "codex",
        providerStateEnv: { HOME: hostHome },
        cwd: workspace,
        workspaceRoot: workspace,
        containerWorker: {
          runtime: "docker" as unknown as "podman",
          backend: "embedded-linux",
          executable: "/bin/sh",
        },
      }),
    ).rejects.toThrow(/container-worker request is invalid/);
  });

  it("reports the canary's own phase timings and ignores implausible ones", async () => {
    // canary-attest is ~half of a median admission but spans three process
    // starts AND every in-sandbox probe. The canary therefore reports its own
    // split. That report comes from inside the fence, so it is logging-only
    // input: a hostile or broken value must be dropped or clamped, never
    // trusted and never able to invent a stage name.
    process.env.SRT_DEBUG = "1";
    await writeFile(
      supervisor,
      PASSING_SUPERVISOR.replace(
        "dynamicBindMapped: true,",
        "dynamicBindMapped: true,\n" +
          "    timings: { boot: 1234, probes: 5, git: 678, bind: 9," +
          ' "canary-release": 99999, hostile: 42, negative: -5, nan: "slow" },',
      ),
      { mode: 0o700 },
    );
    const hostHome = path.join(root, "host-home");
    await mkdir(hostHome, { recursive: true });
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const boundary = new ZsrExecutionBoundary({
        projectRoot: root,
        supervisorScript: supervisor,
        supervisorRuntime: process.execPath,
        networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      });
      const prepared = await boundary.prepare({
        executionId: "canary-timings-1",
        actor: "agent-code",
        providerId: "codex",
        providerStateEnv: { HOME: hostHome },
        cwd: workspace,
        workspaceRoot: workspace,
      });
      const line = logged.mock.calls
        .map((call) => String(call[0]))
        .find((text) => text.includes("[zsr] admitted"));
      expect(line).toBeDefined();
      expect(line).toContain("canary-boot=1234ms");
      expect(line).toContain("canary-probes=5ms");
      expect(line).toContain("canary-git=678ms");
      expect(line).toContain("canary-bind=9ms");
      // Only the four known phases are read: no injected stage name, no
      // negative or non-numeric value, and nothing above the probe timeout.
      expect(line).not.toContain("hostile=");
      expect(line).not.toContain("negative=");
      expect(line).not.toContain("nan=");
      expect(line).not.toContain("canary-release=99999ms");
      await prepared.stopAndProve();
    } finally {
      logged.mockRestore();
    }
  });

  it("cleans up in-flight shadow Git when the overlapped provider overlay fails", async () => {
    // Shadow Git and the provider HOME overlay are prepared concurrently, so
    // an overlay failure has to stop a collection that is still being built
    // rather than leaving it — and the next admission must stay admissible,
    // which it would not be if teardown had gone unproven.
    await runFile("git", ["init", "-b", "main"], { cwd: workspace });
    await runFile("git", ["config", "user.name", "Zeros Test"], {
      cwd: workspace,
    });
    await runFile("git", ["config", "user.email", "zeros@example.invalid"], {
      cwd: workspace,
    });
    await writeFile(path.join(workspace, "code.txt"), "initial\n");
    await runFile("git", ["add", "--", "code.txt"], { cwd: workspace });
    await runFile("git", ["commit", "-m", "initial"], { cwd: workspace });

    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    await expect(
      boundary.prepare({
        executionId: "overlay-failure-1",
        actor: "agent-code",
        providerId: "codex",
        // The filesystem root is a rejected host HOME, so the overlay throws
        // while the collection is still in flight.
        providerStateEnv: { HOME: path.parse(workspace).root },
        cwd: workspace,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(/host HOME cannot be the filesystem root/);
    await expect(access(sessionDir("overlay-failure-1"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );

    const hostHome = path.join(root, "host-home");
    await mkdir(hostHome, { recursive: true });
    const prepared = await boundary.prepare({
      executionId: "overlay-failure-2",
      actor: "agent-code",
      providerId: "codex",
      providerStateEnv: { HOME: hostHome },
      cwd: workspace,
      workspaceRoot: workspace,
    });
    await prepared.stopAndProve();
  });

  it("admits a design actor only when the live canary proves code writes are denied", async () => {
    // The design actor's guarantee is the inverse of the code actor's, so the
    // canary that proves it is the same probe read the other way round.
    await writeFile(
      supervisor,
      PASSING_SUPERVISOR.replace(
        '  writeFileSync(spec.codeFile, "ok\\n", { flag: "wx" });\n' +
          "  unlinkSync(spec.codeFile);\n",
        "",
      ).replace("    codeWrite: true,", "    codeWrite: false,"),
      { mode: 0o700 },
    );
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const prepared = await boundary.prepare({
      executionId: "design-actor-1",
      actor: "design-agent",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    const descriptor = JSON.parse(
      await readFile(
        path.join(
          sessionDir("design-actor-1"),
          "boundary",
          prepared.generation,
          "policy.json",
        ),
        "utf8",
      ),
    ) as {
      actor: string;
      filesystem: { allowWrite: string[]; denyWrite: string[] };
    };
    expect(descriptor.actor).toBe("design-agent");
    expect(descriptor.filesystem.allowWrite).not.toContain(workspace);
    expect(descriptor.filesystem.denyWrite).toContain(workspace);
    await prepared.stopAndProve();
  });

  it("fails closed when a design actor can still write code territory", async () => {
    // PASSING_SUPERVISOR reports the ordinary code-actor result, which is
    // exactly the failure a design admission must refuse.
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    await expect(
      boundary.prepare({
        executionId: "design-actor-2",
        actor: "design-agent",
        cwd: workspace,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(/design actor write code territory/);
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
    expect(
      (
        await stat(
          path.join(
            path.dirname(firstDescriptor.env.HOME),
            ".provider-home-recovery.json",
          ),
        )
      ).isFile(),
    ).toBe(true);
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

  it("defers mutable crash recovery until container retirement is complete", async () => {
    const hostHome = path.join(root, "crash-host-home");
    const generationRoot = path.join(
      process.env.ZEROS_DATA_DIR!,
      "sessions",
      "crashed-provider",
      "boundary",
      "generation",
    );
    const localHome = path.join(generationRoot, "home");
    await Promise.all([
      mkdir(path.join(hostHome, ".codex"), { recursive: true }),
      mkdir(localHome, { recursive: true }),
    ]);
    const overlay = await prepareProviderHomeOverlay({
      providerId: "codex",
      workspaceRoot: workspace,
      localHome,
      ambientEnv: { HOME: hostHome },
    });
    await armProviderHomeRecovery(overlay);
    await writeFile(
      path.join(localHome, ".codex", "crashed-session.jsonl"),
      "survived\n",
    );
    const cursorGenerationRoot = path.join(
      process.env.ZEROS_DATA_DIR!,
      "sessions",
      "crashed-cursor",
      "boundary",
      "generation",
    );
    const cursorLocalRoot = path.join(
      cursorGenerationRoot,
      "provider",
      "cursor",
    );
    await mkdir(cursorLocalRoot, { recursive: true, mode: 0o700 });
    const cursorOverlay = await armCursorStateRecovery(
      await prepareCursorStateOverlay(cursorLocalRoot, workspace),
    );
    await writeFile(
      path.join(cursorOverlay.localRoot, "agents.ndjson"),
      '{"agentId":"survived","name":"Recovered"}\n',
    );
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });

    await boundary.recoverStaleProcesses();
    await expect(
      stat(path.join(generationRoot, ".provider-home-recovery.json")),
    ).resolves.toBeDefined();
    await expect(boundary.recoverStaleMutableState()).resolves.toMatchObject({
      discovered: 2,
      recovered: 2,
      preserved: 0,
    });
    await expect(
      stat(path.join(generationRoot, ".provider-home-recovery.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(path.join(cursorGenerationRoot, ".cursor-state-recovery.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(
        path.join(cursorOverlay.persistentRoot, "agents.ndjson"),
        "utf8",
      ),
    ).resolves.toContain('"agentId":"survived"');
  });

  it("reclaims pre-parity provider/Git state roots and then stops scanning them", async () => {
    const dataDir = process.env.ZEROS_DATA_DIR!;
    const shadowGitRecovery = path.join(dataDir, "recovery", "shadow-git");
    const providerHome = path.join(dataDir, "provider-home", "codex");
    const parked = path.join(dataDir, "provider-home-parked", "codex");
    await Promise.all([
      mkdir(shadowGitRecovery, { recursive: true }),
      mkdir(providerHome, { recursive: true }),
      mkdir(parked, { recursive: true }),
    ]);
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      localHostParity: true,
    });

    await boundary.recoverStaleMutableState();

    // A parity session writes none of this, so once the sweeps have nothing left
    // to recover the roots go away — which is also what makes every later boot
    // skip the walk instead of re-scanning trees that can no longer grow.
    for (const directory of [shadowGitRecovery, providerHome, parked]) {
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(
      stat(path.join(dataDir, "provider-home")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Idempotent: a second boot with nothing there does no work and does not fail.
    await expect(
      boundary.recoverStaleMutableState(),
    ).resolves.toMatchObject({ discovered: 0, recovered: 0, preserved: 0 });
  });

  it("keeps sweeping pre-parity roots that still hold unrecovered state", async () => {
    const dataDir = process.env.ZEROS_DATA_DIR!;
    const preserved = path.join(
      dataDir,
      "recovery",
      "shadow-git",
      "unfinished",
    );
    await mkdir(preserved, { recursive: true });
    await writeFile(path.join(preserved, "manifest.json"), "{ truncated");
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
      localHostParity: true,
    });

    const result = await boundary.recoverStaleMutableState();

    // The sweep could not prove this entry safe to discard, so it retained it —
    // and the root must survive so the next boot tries again. Reclaiming here
    // would make the tidy-up the thing that loses a user's unmerged work.
    expect(result.preserved).toBeGreaterThan(0);
    await expect(stat(preserved)).resolves.toBeDefined();
  });

  it("retains the boundary root when provider HOME recovery cannot be proven", async () => {
    const hostHome = path.join(root, "host-home-recovery-failure");
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
    const prepared = await boundary.prepare({
      executionId: "execution-provider-home-recovery-failure",
      actor: "agent-code",
      providerId: "codex",
      providerStateEnv: { HOME: hostHome },
      cwd: workspace,
      workspaceRoot: workspace,
    });
    const launch = prepared.wrapSpawn({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: hostHome },
    });
    const commandPath = launch.args[launch.args.indexOf("--command") + 1];
    const descriptor = JSON.parse(await readFile(commandPath, "utf8")) as {
      env: Record<string, string>;
    };
    const projectedHome = descriptor.env.HOME;
    await writeFile(path.join(projectedHome, ".codex", "unsaved.jsonl"), "x\n");

    const providerBase = path.join(
      process.env.ZEROS_DATA_DIR!,
      "provider-home",
      "codex",
    );
    const [persistentKey] = await readdir(providerBase);
    if (!persistentKey) throw new Error("missing provider persistence root");
    const persistentRoot = path.join(providerBase, persistentKey);
    await rm(persistentRoot, { recursive: true, force: true });
    await writeFile(persistentRoot, "blocks promotion and recovery\n");

    await expect(prepared.stopAndProve()).rejects.toBeDefined();
    await expect(
      readFile(path.join(projectedHome, ".codex", "unsaved.jsonl"), "utf8"),
    ).resolves.toBe("x\n");
  });

  it("retains the boundary root while Cursor state promotion is pending", async () => {
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      networkBridgeScript: NETWORK_BRIDGE_SCRIPT,
    });
    const prepared = await boundary.prepare({
      executionId: "execution-cursor-state-recovery",
      actor: "agent-code",
      providerId: "cursor",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    const localState = prepared.privateStateDirectory("cursor");
    const generationRoot = path.dirname(path.dirname(localState));
    const sentinel = path.join(localState, "agents.ndjson");
    await writeFile(sentinel, '{"agentId":"unsaved"}\n');
    await writeFile(
      path.join(generationRoot, ".cursor-state-recovery.json"),
      '{"version":1}\n',
      { mode: 0o600 },
    );

    await expect(prepared.stopAndProve()).rejects.toThrow(
      "Cursor provider-state promotion is pending recovery",
    );
    await expect(readFile(sentinel, "utf8")).resolves.toContain("unsaved");
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
      designRecognitionPaths: [],
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
