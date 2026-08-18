import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ZsrExecutionBoundary } from "../../apps/desktop/src/engine/agents/containment/zsr-boundary";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const supervisorScript = path.join(projectRoot, "binaries/zsr-supervisor.mjs");
const networkBridgeScript = path.join(
  projectRoot,
  "binaries/zsr-network-bridge.mjs",
);
const processDomainHelper = path.join(
  projectRoot,
  "binaries/zsr-macos-process-domain",
);
const fixturePath = fileURLToPath(import.meta.url);

function boundary() {
  return new ZsrExecutionBoundary({
    projectRoot,
    localHostParity: true,
    supervisorScript,
    networkBridgeScript,
    macosProcessDomainHelper: processDomainHelper,
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      if (Number.isSafeInteger(pid) && pid > 1) return pid;
    } catch {
      // The sandbox writes the file after its two detached spawns complete.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("detached qualification process did not report its pid");
}

function hostileSource(pidFile: string): string {
  const grandchild = String.raw`
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
setInterval(() => {}, 1000);
`;
  const middle = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], {
  detached: true,
  stdio: "ignore",
});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid), { flag: "wx" });
child.unref();
`;
  return String.raw`
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(middle)}], {
  detached: true,
  stdio: "ignore",
});
child.unref();
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;
}

async function spawnHostile(
  executionId: string,
  workspace: string,
  pidFile: string,
) {
  const prepared = await boundary().prepare({
    executionId,
    actor: "agent-code",
    cwd: workspace,
    workspaceRoot: workspace,
  });
  await prepared.spawn({
    command: process.execPath,
    args: ["-e", hostileSource(pidFile)],
    cwd: workspace,
    env: {
      HOME: workspace,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    stdio: "pipe",
  });
  return prepared;
}

async function crashChild(root: string): Promise<never> {
  process.env.ZEROS_DATA_DIR = path.join(root, "engine");
  const workspace = path.join(root, "crash-workspace");
  const pidFile = path.join(workspace, "crash-detached.pid");
  await mkdir(workspace, { recursive: true });
  await spawnHostile("crash-domain", workspace, pidFile);
  await waitForPid(pidFile);
  // Deliberately bypass every finally/teardown hook. The supervisor observes
  // parent death and kills its ordinary group; the double-detached grandchild
  // is recovered by the next engine generation from persisted metadata.
  process.exit(0);
}

async function run(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("macOS engine-boundary fixture requires Darwin");
  }
  for (const required of [
    supervisorScript,
    networkBridgeScript,
    processDomainHelper,
  ]) {
    if (!existsSync(required))
      throw new Error("ZSR packaged helper is missing");
  }
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-macos-engine-")),
  );
  process.env.ZEROS_DATA_DIR = path.join(root, "engine");
  let prepared: Awaited<ReturnType<typeof spawnHostile>> | null = null;
  try {
    const workspace = path.join(root, "workspace");
    const detachedPidFile = path.join(workspace, "detached.pid");
    await mkdir(workspace, { recursive: true });
    prepared = await spawnHostile(
      "detached-domain",
      workspace,
      detachedPidFile,
    );
    const detachedPid = await waitForPid(detachedPidFile);
    if (!alive(detachedPid)) throw new Error("detached child exited too early");
    await prepared.stopAndProve();
    if (alive(detachedPid)) {
      throw new Error("detached child survived normal boundary teardown");
    }

    const crash = spawn(
      process.execPath,
      [...process.execArgv, fixturePath, "--crash-child", root],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ZEROS_DATA_DIR: path.join(root, "engine"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let crashStderr = "";
    crash.stderr.setEncoding("utf8");
    crash.stderr.on("data", (chunk: string) => {
      crashStderr = (crashStderr + chunk).slice(-2_000);
    });
    const crashExit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      crash.once("error", reject);
      crash.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (crashExit.code !== 0) {
      throw new Error(
        `crash fixture exited ${crashExit.code ?? crashExit.signal}${
          crashStderr ? " with diagnostics" : ""
        }`,
      );
    }
    const crashPid = await waitForPid(
      path.join(root, "crash-workspace", "crash-detached.pid"),
    );
    const parentDeathDeadline = Date.now() + 5_000;
    while (!alive(crashPid) && Date.now() < parentDeathDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    if (!alive(crashPid)) {
      throw new Error("crash fixture did not leave a detached child");
    }
    const recovery = await boundary().recoverStaleProcesses();
    if (recovery.recovered !== 1 || recovery.preserved !== 0) {
      throw new Error("next-engine process-domain recovery was incomplete");
    }
    if (alive(crashPid)) {
      throw new Error("detached child survived next-engine recovery");
    }
    process.stdout.write(
      `${JSON.stringify({
        normalTeardown: true,
        crashRecovery: true,
        recovered: recovery.recovered,
      })}\n`,
    );
  } finally {
    await prepared?.stopAndProve().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

void (async () => {
  if (process.argv[2] === "--crash-child") {
    const root = process.argv[3];
    if (!root || !path.isAbsolute(root)) {
      throw new Error("crash fixture root must be absolute");
    }
    await crashChild(root);
  } else {
    await run();
  }
})().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  if (process.argv[2] === "--crash-child") process.exit(1);
  process.exitCode = 1;
});
