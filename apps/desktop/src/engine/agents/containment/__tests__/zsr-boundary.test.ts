import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runFile } from "../../../git/git-exec";
import type { MacosProcessDomainCommandRunner } from "../macos-process-domain";
import {
  cleanupZsrPreparationProcessDomain,
  ZsrExecutionBoundary as RuntimeZsrExecutionBoundary,
  type ZsrBoundaryOptions,
} from "../zsr-boundary";
import { sessionDir } from "../../session-paths";

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
import { readFileSync, writeFileSync } from "node:fs";
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
  designAncestorRenameDenied: true,
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
      await writeFile(
        path.join(binaries, "zsr-macos-process-domain"),
        "test\n",
        { mode: 0o500 },
      );
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

  it("preserves process-domain recovery evidence when preparation reap fails", async () => {
    const policyRoot = path.join(root, "failed-preparation-policy");
    await mkdir(policyRoot);
    await writeFile(path.join(policyRoot, "process-domain.json"), "evidence\n");
    const retireMetadata = vi.fn(async () => undefined);

    await expect(
      cleanupZsrPreparationProcessDomain(
        {
          reap: async () => {
            throw new Error("process domain survived");
          },
          retireMetadata,
        },
        policyRoot,
      ),
    ).rejects.toThrow(/process domain survived/i);

    await expect(stat(policyRoot)).resolves.toBeDefined();
    expect(retireMetadata).not.toHaveBeenCalled();
  });

  it("preserves host authority while keeping the supervisor bootstrap private", async () => {
    process.env.SRT_DEBUG = "1";
    const hostHome = path.join(root, "host-home");
    await mkdir(hostHome, { recursive: true });
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
    });
    const request = {
      executionId: "execution-1",
      actor: "agent-code" as const,
      providerId: "codex",
      providerStateEnv: { HOME: hostHome },
      cwd: workspace,
      workspaceRoot: workspace,
    };
    const prepared = await boundary.prepare(request);
    await expect(
      readFile(path.join(sessionDir(request.executionId), "meta.json"), "utf8"),
    ).resolves.toSatisfy((raw: string) => {
      const meta = JSON.parse(raw) as Record<string, unknown>;
      return (
        meta.agentId === request.providerId &&
        meta.actor === request.actor &&
        meta.cwd === request.cwd &&
        meta.pid === process.pid
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
        OPENAI_API_KEY: "raw-provider-key",
        DOCKER_HOST: "tcp://127.0.0.1:2375",
        DOCKER_CONTEXT: "host-context",
        CONTAINER_HOST: "unix:///ambient/container.sock",
        CONTAINER_CONNECTION: "ambient-connection",
        PODMAN_HOST: "unix:///ambient/podman.sock",
      },
    });
    expect(launch.env.PATH).not.toBe("/child/bin");
    expect(launch.env.HOME).not.toBe("/user/home");
    expect(launch.env.SENTINEL).toBeUndefined();
    expect(launch.env.OPENAI_API_KEY).toBeUndefined();
    expect(launch.env.SRT_DEBUG).toBe("1");
    expect(path.isAbsolute(launch.env.ZEROS_ZSR_RIPGREP_PATH ?? "")).toBe(true);
    await expect(
      access(launch.env.ZEROS_ZSR_RIPGREP_PATH!),
    ).resolves.toBeUndefined();

    const commandPath = launch.args[launch.args.indexOf("--command") + 1];
    expect((await stat(commandPath)).mode & 0o777).toBe(0o600);
    const descriptor = JSON.parse(await readFile(commandPath, "utf8")) as {
      deniedContainerSockets: string[];
      env: Record<string, string>;
      [key: string]: unknown;
    };
    expect(descriptor).toMatchObject({
      version: 6,
      generation: prepared.generation,
      command: process.execPath,
      cwd: workspace,
      env: {
        HOME: "/user/home",
        SENTINEL: "present",
        NODE_OPTIONS: "--require=/workspace/preload.cjs",
        LD_PRELOAD: "/workspace/preload.so",
        OPENAI_API_KEY: "raw-provider-key",
      },
    });
    expect(descriptor.env.PATH.endsWith(`${path.delimiter}/child/bin`)).toBe(
      true,
    );
    expect(descriptor.env.ZEROS_LOCAL_WS_TOKEN).toBeUndefined();
    expect(descriptor.env.ZEROS_ZSR_RIPGREP_PATH).toBeUndefined();
    for (const ambientContainerSelector of [
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "CONTAINER_HOST",
      "CONTAINER_CONNECTION",
      "PODMAN_HOST",
    ]) {
      expect(descriptor.env[ambientContainerSelector]).toBeUndefined();
    }
    const dockerSocket = await realpath("/var/run/docker.sock").catch(
      () => "/var/run/docker.sock",
    );
    expect(descriptor.deniedContainerSockets).toEqual(
      expect.arrayContaining([
        "/ambient/container.sock",
        "/ambient/podman.sock",
        dockerSocket,
      ]),
    );
    expect(descriptor).not.toHaveProperty("credentialCapabilities");
    expect(descriptor).not.toHaveProperty("filesystemProjections");
    expect(descriptor).not.toHaveProperty("networkBridge");
    expect(descriptor).not.toHaveProperty("portPolicy");
    expect(descriptor).not.toHaveProperty("internalProxyPorts");

    await prepared.stopAndProve();
    await expect(access(sessionDir(request.executionId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("deduplicates physical aliases for an ambient container socket", async () => {
    const socketRoot = path.join(root, "container-runtime");
    const socketAlias = path.join(root, "container-runtime-alias");
    const socket = path.join(socketRoot, "docker.sock");
    await mkdir(socketRoot);
    await writeFile(socket, "socket placeholder\n");
    await symlink(socketRoot, socketAlias, "dir");
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
    });
    const prepared = await boundary.prepare({
      executionId: "ambient-container-alias",
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    try {
      const launch = prepared.wrapSpawn({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          DOCKER_HOST: `unix://${socket}`,
          CONTAINER_HOST: `unix://${path.join(socketAlias, "docker.sock")}`,
        },
      });
      const commandPath = launch.args[launch.args.indexOf("--command") + 1];
      const descriptor = JSON.parse(await readFile(commandPath, "utf8")) as {
        deniedContainerSockets: string[];
      };

      expect(
        descriptor.deniedContainerSockets.filter((candidate) =>
          candidate.startsWith(root),
        ),
      ).toEqual([socket]);
    } finally {
      await prepared.stopAndProve();
    }
  });

  it("owns an asynchronous direct-spawn ENOENT before process registration", async () => {
    const runtime = path.join(root, "ephemeral-node");
    await writeFile(
      runtime,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o700 },
    );
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: runtime,
    });
    const prepared = await boundary.prepare({
      executionId: "direct-spawn-enoent",
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    try {
      await rm(runtime);
      await expect(
        prepared.spawn({
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: workspace,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          stdio: "pipe",
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await prepared.stopAndProve();
    }
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

    expect({ ...descriptor.env, PATH: childEnv.PATH }).toMatchObject(childEnv);
    expect(descriptor.env.PATH.endsWith(`:${childEnv.PATH}`)).toBe(true);
    expect(descriptor.env.ZEROS_ZSR_GIT_DISPATCH_CONFIG).toMatch(
      /git-dispatch\.conf$/,
    );
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

  (process.platform === "linux" ? it : it.skip)(
    "subtracts an advertised ambient container socket from host parity",
    async () => {
      const socketPath = path.join(root, "ambient-container.sock");
      const server = createServer((socket) => socket.end("ambient\n"));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const boundary = new RuntimeZsrExecutionBoundary({
        projectRoot: process.cwd(),
      });
      const prepared = await boundary.prepare({
        executionId: "execution-container-socket-subtraction",
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
      });
      try {
        const child = await prepared.spawn({
          command: process.execPath,
          args: [
            "-e",
            String.raw`
const { connect } = require("node:net");
const socketPath = process.argv[1];
const connection = connect(socketPath);
let finished = false;
const finish = (connected, error) => {
  if (finished) return;
  finished = true;
  connection.destroy();
  process.stdout.write(JSON.stringify({
    connected,
    error,
    dockerHost: process.env.DOCKER_HOST ?? null,
  }));
};
connection.once("connect", () => finish(true, null));
connection.once("error", (error) => finish(false, error.code ?? "error"));
setTimeout(() => finish(false, "timeout"), 1_000).unref();
`,
            socketPath,
          ],
          cwd: workspace,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            DOCKER_HOST: `unix://${socketPath}`,
          },
          stdio: "pipe",
        });
        let stdout = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        await expect(child.wait()).resolves.toMatchObject({ code: 0 });
        expect(JSON.parse(stdout)).toMatchObject({
          connected: false,
          dockerHost: null,
        });
      } finally {
        await prepared.stopAndProve();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  // The two fence tests above run `git reset --hard` with the Design tree already
  // matching HEAD, so git never actually tries to write a Design path and the
  // kernel deny is never exercised THROUGH git. This one diverges the tracked
  // Design file from HEAD first, from outside the fence, so the restore genuinely
  // attempts the write the boundary must refuse.
  (process.platform === "linux" ? it : it.skip)(
    "materializes Design changes for a branch-level Git integration",
    async () => {
      const design = path.join(workspace, "Zeros Design");
      const designFile = path.join(design, "canvas.json");
      const codeFile = path.join(workspace, "code.txt");
      const hostHome = path.join(root, "host-home-git-integration");
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
        writeFile(codeFile, "main-code\n"),
        writeFile(designFile, '{"branch":"main"}\n'),
      ]);
      await runFile("git", ["add", "-A"], { cwd: workspace });
      await runFile("git", ["commit", "-m", "main"], { cwd: workspace });
      await runFile("git", ["checkout", "-b", "incoming"], {
        cwd: workspace,
      });
      await Promise.all([
        writeFile(codeFile, "incoming-code\n"),
        writeFile(designFile, '{"branch":"incoming"}\n'),
      ]);
      await runFile("git", ["add", "-A"], { cwd: workspace });
      await runFile("git", ["commit", "-m", "incoming"], { cwd: workspace });
      await runFile("git", ["checkout", "main"], { cwd: workspace });

      const boundary = new RuntimeZsrExecutionBoundary({
        projectRoot: process.cwd(),
      });
      const prepared = await boundary.prepare({
        executionId: "execution-parity-git-integration",
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
            deniedPaths: [design],
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
const [codeFile, designFile] = process.argv.slice(1);
const checkout = spawnSync("git", ["checkout", "incoming"], { encoding: "utf8" });
process.stdout.write(JSON.stringify({
  status: checkout.status,
  stdout: checkout.stdout,
  stderr: checkout.stderr,
  code: fs.readFileSync(codeFile, "utf8"),
  design: fs.readFileSync(designFile, "utf8"),
}));`,
            codeFile,
            designFile,
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
        expect(JSON.parse(stdout)).toMatchObject({
          status: 0,
          code: "incoming-code\n",
          design: '{"branch":"incoming"}\n',
        });
      } finally {
        await prepared.stopAndProve();
      }
    },
  );

  (process.platform === "linux" ? it : it.skip)(
    "keeps commit-plus-path checkout inside the Design write fence",
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
const ambiguous = spawnSync("git", ["checkout", "Zeros Design/canvas.json"], { encoding: "utf8" });
const designAfterAmbiguous = fs.readFileSync(designFile, "utf8");
const checkout = spawnSync("git", ["checkout", "HEAD", "--", "Zeros Design/canvas.json", "code.txt"], { encoding: "utf8" });
process.stdout.write(JSON.stringify({
  ambiguousStatus: ambiguous.status,
  ambiguousStderr: ambiguous.stderr,
  designAfterAmbiguous,
  checkoutStatus: checkout.status,
  checkoutStderr: checkout.stderr,
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
          ambiguousStatus: number | null;
          ambiguousStderr: string;
          designAfterAmbiguous: string;
          checkoutStatus: number | null;
          checkoutStderr: string;
          design: string;
          code: string;
        };
        // A named path is authoring, not integration: it stays with native Git
        // inside the kernel fence even though branch checkout is brokered.
        expect(result.designAfterAmbiguous).toBe('{"generation":2}\n');
        expect(result.ambiguousStatus).not.toBe(0);
        expect(result.ambiguousStderr).not.toContain("integration broker");
        expect(result.design).toBe('{"generation":2}\n');
        expect(result.checkoutStatus).not.toBe(0);
        expect(result.checkoutStderr).not.toContain("integration broker");
        expect(result.checkoutStderr).toContain("Zeros Design/canvas.json");
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
    const unprojectedDesign = path.join(
      root,
      "registered-sibling",
      "Zeros Design",
    );
    await Promise.all([
      mkdir(design, { recursive: true }),
      mkdir(unprojectedDesign, { recursive: true }),
    ]);
    let reservations = 0;
    let starts = 0;
    let stops = 0;
    let reservedExecutionId = "";
    let reservedSessionRoot = "";
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
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
    const request = (
      executionId: string,
      protectedDesignDirectories: readonly string[] = [design],
    ) => ({
      executionId,
      actor: "agent-code" as const,
      cwd: workspace,
      workspaceRoot: workspace,
      territory: {
        agentRole: "code" as const,
        workspaceRoot: workspace,
        designDirectory: design,
        protectedDesignDirectories,
        designRecognitionPaths: [],
        writeCapabilities: {
          workspace: "write" as const,
          deniedPaths: [
            ...protectedDesignDirectories,
            path.join(workspace, ".git"),
          ],
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
    const second = await boundary.prepare(
      request("workspace-worker-two", [design, unprojectedDesign]),
    );
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

  it("keys shared OrbStack workers by the physical protected-root projection", async () => {
    const firstDesign = path.join(workspace, "First Design");
    const secondDesign = path.join(workspace, "Second Design");
    const aliasParent = path.join(root, "design-aliases");
    const firstAlias = path.join(aliasParent, "first");
    const secondAlias = path.join(aliasParent, "second");
    await Promise.all([
      mkdir(firstDesign, { recursive: true }),
      mkdir(secondDesign, { recursive: true }),
      mkdir(aliasParent, { recursive: true }),
    ]);
    await Promise.all([
      symlink(firstDesign, firstAlias, "dir"),
      symlink(secondDesign, secondAlias, "dir"),
    ]);

    let reservations = 0;
    let stops = 0;
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      macosContainerWorkerFactory: () => ({
        reserve: async () => {
          reservations += 1;
          return {
            hostPort: 43_300 + reservations,
            machineName: `zeros-zsr-physical-${reservations}`,
            environment: {},
            start: async () => undefined,
            stopAndProve: async () => {
              stops += 1;
            },
          };
        },
      }),
    });
    const request = (executionId: string, designDirectory: string) => ({
      executionId,
      actor: "agent-code" as const,
      cwd: workspace,
      workspaceRoot: workspace,
      territory: {
        agentRole: "code" as const,
        workspaceRoot: workspace,
        designDirectory,
        protectedDesignDirectories: [designDirectory],
        designRecognitionPaths: [],
        writeCapabilities: {
          workspace: "write" as const,
          deniedPaths: [designDirectory, path.join(workspace, ".git")],
        },
      },
      containerWorker: {
        runtime: "podman" as const,
        backend: "orbstack-machine" as const,
        executable: process.execPath,
      },
      containerWorkflowExpected: true,
    });

    const first = await boundary.prepare(request("physical-one", firstAlias));
    const second = await boundary.prepare(
      request("physical-two", secondAlias),
    );
    expect(reservations).toBe(2);

    await Promise.all([first.stopAndProve(), second.stopAndProve()]);
    expect(stops).toBe(2);
  });

  (process.platform === "darwin" ? it : it.skip)(
    "reports the original local-parity worker failure after ordered process-domain cleanup",
    async () => {
      const startupFailure = new Error("container worker start rejected");
      const stopAndProve = vi.fn(async () => undefined);
      const boundary = new RuntimeZsrExecutionBoundary({
        projectRoot: root,
        supervisorScript: supervisor,
        supervisorRuntime: process.execPath,
        macosProcessDomainRunner: async (helper, args) => {
          // Make the dependency visible: the policy root must stay present
          // until reap has finished and its metadata has been retired.
          if (args[0] === "reap") {
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
          }
          return macosProcessDomainRunner(helper, args);
        },
        macosContainerWorkerFactory: () => ({
          reserve: async () => ({
            hostPort: 43_220,
            machineName: "zeros-zsr-ordered-preparation-cleanup",
            environment: {},
            start: async () => {
              throw startupFailure;
            },
            stopAndProve,
          }),
        }),
      });
      const executionId = "local-parity-worker-start-failure";

      await expect(
        boundary.prepare({
          executionId,
          actor: "agent-code",
          cwd: workspace,
          workspaceRoot: workspace,
          containerWorker: {
            runtime: "podman",
            backend: "orbstack-machine",
            executable: process.execPath,
          },
        }),
      ).rejects.toBe(startupFailure);
      expect(stopAndProve).toHaveBeenCalledOnce();
      await expect(access(sessionDir(executionId))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );


  (process.platform === "linux" ? it : it.skip)(
    "documents the accepted commit-then-merge Design materialization trade",
    async () => {
      const design = path.join(workspace, "Zeros Design");
      const designFile = path.join(design, "canvas.json");
      const codeFile = path.join(workspace, "code.txt");
      await mkdir(design, { recursive: true });
      await Promise.all([
        writeFile(designFile, '{"source":"main"}\n'),
        writeFile(codeFile, "main\n"),
      ]);
      await runFile("git", ["init", "-b", "main"], { cwd: workspace });
      await runFile("git", ["config", "user.name", "Zeros Test"], {
        cwd: workspace,
      });
      await runFile("git", ["config", "user.email", "zeros@example.invalid"], {
        cwd: workspace,
      });
      await runFile("git", ["add", "-A"], { cwd: workspace });
      await runFile("git", ["commit", "-m", "initial"], { cwd: workspace });

      const boundary = new RuntimeZsrExecutionBoundary({
        projectRoot: process.cwd(),
      });
      const prepared = await boundary.prepare({
        executionId: "execution-commit-merge-trade",
        actor: "agent-code",
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
      });
      try {
        const child = await prepared.spawn({
          command: process.execPath,
          args: [
            "-e",
            String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const designFile = process.argv[1];
const git = (args, input) => spawnSync("git", args, { encoding: "utf8", input });
const base = git(["rev-parse", "HEAD"]).stdout.trim();
const codeBlob = git(["rev-parse", "HEAD:code.txt"]).stdout.trim();
const designBlob = git(["hash-object", "-w", "--stdin"], '{"source":"local-commit"}\n').stdout.trim();
const designTree = git(["mktree"], "100644 blob " + designBlob + "\tcanvas.json\n").stdout.trim();
const rootTree = git(["mktree"], "040000 tree " + designTree + "\tZeros Design\n100644 blob " + codeBlob + "\tcode.txt\n").stdout.trim();
const commit = git(["commit-tree", rootTree, "-p", base], "locally authored Design commit\n").stdout.trim();
const branch = git(["branch", "locally-authored-design", commit]);
const merge = git(["merge", "--no-ff", "--no-edit", "locally-authored-design"]);
process.stdout.write(JSON.stringify({
  branch: branch.status,
  merge: merge.status,
  mergeStderr: merge.stderr,
  design: fs.readFileSync(designFile, "utf8"),
}));`,
            designFile,
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
        const result = JSON.parse(stdout) as {
          branch: number;
          merge: number;
          mergeStderr: string;
          design: string;
        };
        expect(result).toMatchObject({
          branch: 0,
          merge: 0,
          design: '{"source":"local-commit"}\n',
        });
        expect(result.mergeStderr).not.toContain("integration broker");
      } finally {
        await prepared.stopAndProve();
      }
    },
  );

  it("fails admission when the exact host-parity canary reports a write split violation", async () => {
    await writeFile(
      supervisor,
      PASSING_SUPERVISOR.replace(
        "codeWrite: !designWritable,",
        "codeWrite: false,",
      ),
      { mode: 0o700 },
    );
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
    });
    await expect(
      boundary.prepare({
        executionId: "host-parity-canary-failure",
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(/code actor cannot write code territory/);
    await expect(
      access(sessionDir("host-parity-canary-failure")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("surfaces the final supervisor diagnostic when the admission canary exits", async () => {
    await writeFile(
      supervisor,
      PASSING_SUPERVISOR.replace(
        "if (descriptor.env.HOST_PARITY_CANARY) {",
        String.raw`if (descriptor.env.HOST_PARITY_CANARY) {
  process.stderr.write("setup detail that should stay hidden\n");
  process.stderr.write("bwrap: namespace setup was denied\n");
  process.exit(17);`,
      ),
      { mode: 0o700 },
    );
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
    });

    await expect(
      boundary.prepare({
        executionId: "host-parity-canary-diagnostic",
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(
      "host-parity canary exited 17: bwrap: namespace setup was denied",
    );
    await expect(
      access(sessionDir("host-parity-canary-diagnostic")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses container authority to a Design actor before backend validation", async () => {
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
    });
    const prepared = await boundary.prepare({
      executionId: "design-container-refusal",
      actor: "design-agent",
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
      expect(prepared.status.services).toBeUndefined();
    } finally {
      await prepared.stopAndProve();
    }

    await expect(
      boundary.prepare({
        executionId: "code-container-validation",
        actor: "agent-code",
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

  it("revokes direct leases and proves every tracked process group stopped", async () => {
    const boundary = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
    });
    const prepared = await boundary.prepare({
      executionId: "host-parity-process-retirement",
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    const lease = await prepared.requestPort({
      protocol: "tcp",
      preferredPort: 43_123,
      purpose: "dev-server",
    });
    expect(lease).toMatchObject({
      host: "127.0.0.1",
      port: 43_123,
      targetPort: 43_123,
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

});
