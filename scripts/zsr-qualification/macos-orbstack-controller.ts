#!/usr/bin/env tsx

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  lstat,
  rm,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MacosOrbStackContainerWorker,
  orbStackMachineName,
} from "../../apps/desktop/src/engine/agents/containment/macos-orbstack-container-worker";
import type { TerritoryGeneration } from "../../apps/desktop/src/engine/agents/containment/types";
import { ORBSTACK_MACHINE_RECOVERY_HOLD_FILE } from "../../apps/desktop/src/engine/agents/session-paths";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");
const orb = path.join(os.homedir(), ".orbstack", "bin", "orb");
const startedAt = Date.now();

function reportStage(stage: string): void {
  process.stdout.write(
    `${JSON.stringify({
      event: "macos-orbstack-qualification-stage",
      stage,
      elapsedMs: Date.now() - startedAt,
    })}\n`,
  );
}

function run(
  file: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    allowFailure?: boolean;
  } = {},
) {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${path.basename(file)} failed (${result.status ?? result.signal}): ${(
        result.stderr || result.stdout
      ).slice(-2_000)}`,
    );
  }
  return result;
}

async function runAsync(
  file: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    allowFailure?: boolean;
  } = {},
): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(file, [...args], {
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-8 * 1024 * 1024);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8 * 1024 * 1024);
  });
  let forceTimer: NodeJS.Timeout | null = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  }, options.timeout ?? 120_000);
  const outcome = await new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve({ status, signal }));
  }).finally(() => {
    clearTimeout(timeout);
    if (forceTimer) clearTimeout(forceTimer);
  });
  if ((timedOut || outcome.status !== 0) && !options.allowFailure) {
    throw new Error(
      `${path.basename(file)} failed (${timedOut ? "timeout" : (outcome.status ?? outcome.signal)}): ${(
        stderr || stdout
      ).slice(-2_000)}`,
    );
  }
  return { ...outcome, stdout, stderr };
}

async function ping(port: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const pending = request(
      { host: "127.0.0.1", port, path: "/_ping", method: "GET" },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.once("end", () => resolve(body));
      },
    );
    pending.setTimeout(5_000, () => pending.destroy(new Error("timeout")));
    pending.once("error", reject);
    pending.end();
  });
}

async function getApi(
  port: number,
  apiPath: string,
): Promise<{
  status: number;
  body: string;
}> {
  return await new Promise((resolve, reject) => {
    const pending = request(
      {
        host: "127.0.0.1",
        port,
        path: apiPath,
        method: "GET",
        headers: { Connection: "close" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body = (body + chunk).slice(-64 * 1024);
        });
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, body }),
        );
      },
    );
    pending.setTimeout(5_000, () => pending.destroy(new Error("timeout")));
    pending.once("error", reject);
    pending.end();
  });
}

async function waitForPortClosed(port: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await ping(port);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("macOS OrbStack qualification must run on macOS");
  }
  const executionId = `qualification-${randomUUID()}`;
  const fixtureRoot = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "zeros-zsr-orb-"),
  );
  reportStage("fixture-created");
  const workspace = path.join(fixtureRoot, "workspace");
  // Match the production sessions/<executionId> layout so a hard-crash hold
  // remains independently valid deletion authority while its exact selective
  // mount sources are preserved.
  const session = path.join(fixtureRoot, executionId);
  const design = path.join(workspace, "Zeros Design");
  const canonicalGit = path.join(workspace, ".git");
  const code = path.join(workspace, "code");
  await Promise.all([
    mkdir(design, { recursive: true }),
    mkdir(canonicalGit, { recursive: true }),
    mkdir(code, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(design, "protected.txt"), "design\n"),
    writeFile(path.join(canonicalGit, "identity"), "canonical\n"),
    writeFile(path.join(code, "input.txt"), "code\n"),
  ]);
  await chmod(session, 0o700);

  const controller = new MacosOrbStackContainerWorker({
    orbPath: orb,
    cloudInitPath: path.join(
      projectRoot,
      "apps/desktop/src/engine/agents/containment/zsr-orbstack-cloud-init.yaml",
    ),
    hostScriptPath: path.join(
      projectRoot,
      "apps/desktop/src/engine/agents/containment/zsr-orbstack-container-host.mjs",
    ),
    containerWorkerPath: path.join(
      projectRoot,
      "apps/desktop/src/engine/agents/containment/zsr-container-worker.mjs",
    ),
  });
  let lease: Awaited<ReturnType<typeof controller.reserve>> | null = null;
  let machineName: string | null = null;
  let containerId = "";
  let qualificationError: unknown;
  try {
    machineName = orbStackMachineName(executionId, [workspace, session]);
    reportStage("reservation-started");
    lease = await controller.reserve({
      executionId,
      workspaceRoot: workspace,
      sessionRoot: session,
    });
    if (lease.machineName !== machineName) {
      throw new Error("controller machine identity changed during reservation");
    }
    reportStage("reservation-ready");

    const rootfs = path.join(workspace, "rootfs");
    const archive = path.join(workspace, "rootfs.tar");
    run(orb, [
      "-m",
      machineName,
      "-u",
      "root",
      "/usr/bin/mkdir",
      "-p",
      path.join(rootfs, "bin"),
    ]);
    run(orb, [
      "-m",
      machineName,
      "-u",
      "root",
      "/usr/bin/cp",
      "/usr/bin/busybox",
      path.join(rootfs, "bin", "busybox"),
    ]);
    run(orb, [
      "-m",
      machineName,
      "-u",
      "root",
      "/usr/bin/ln",
      "-sf",
      "busybox",
      path.join(rootfs, "bin", "sh"),
    ]);
    run(orb, [
      "-m",
      machineName,
      "-u",
      "root",
      "/usr/bin/tar",
      "-C",
      rootfs,
      "-cf",
      archive,
      ".",
    ]);
    reportStage("rootfs-ready");

    reportStage("worker-started");
    await lease.start({
      generation:
        `orb_${randomUUID().replaceAll("-", "")}` as TerritoryGeneration,
      protectedRoots: [design],
    });
    reportStage("worker-ready");
    if ((await ping(lease.hostPort)).trim() !== "OK") {
      throw new Error("private Podman API did not answer its exact proxy");
    }
    reportStage("api-ready");
    const apiVersion = await getApi(lease.hostPort, "/v1.40/version");
    if (apiVersion.status !== 200) {
      throw new Error("private Podman version endpoint was incompatible");
    }
    const apiIdentity = JSON.parse(apiVersion.body) as {
      ApiVersion?: unknown;
    };
    if (typeof apiIdentity.ApiVersion !== "string") {
      throw new Error("private Podman version response was malformed");
    }
    reportStage("raw-docker-api-ready");
    const docker = run("/usr/bin/which", ["docker"]).stdout.trim();
    if (!path.isAbsolute(docker))
      throw new Error("Docker-compatible CLI missing");
    const env = { ...process.env, ...lease.environment };
    await runAsync(docker, ["version", "--format", "{{json .Server}}"], {
      env,
      timeout: 15_000,
    });
    reportStage("docker-api-negotiated");
    await runAsync(
      docker,
      ["import", archive, "localhost/zeros-busybox:qualification"],
      { env },
    );
    reportStage("image-imported");
    await runAsync(
      docker,
      [
        "run",
        "--rm",
        "-v",
        `${workspace}:/work`,
        "localhost/zeros-busybox:qualification",
        "/bin/sh",
        "-c",
        'set -eu; echo container-code > /work/code/container.txt; grep -qx canonical /work/.git/identity; echo canonical-write > /work/.git/container-marker; if echo mutation > "/work/Zeros Design/protected.txt" 2>/dev/null; then exit 77; fi',
      ],
      { env },
    );
    reportStage("normal-container-passed");
    const privileged = await runAsync(
      docker,
      [
        "run",
        "--rm",
        "--privileged",
        "-v",
        `${design}:/design`,
        "localhost/zeros-busybox:qualification",
        "/bin/sh",
        "-c",
        "if echo privileged-mutation > /design/protected.txt 2>/dev/null; then exit 78; fi",
      ],
      { env, allowFailure: true },
    );
    if (privileged.status === 78) {
      throw new Error("privileged container mutated protected Design");
    }
    reportStage("privileged-container-passed");
    if (
      (await readFile(path.join(code, "container.txt"), "utf8")) !==
        "container-code\n" ||
      (await readFile(path.join(design, "protected.txt"), "utf8")) !==
        "design\n" ||
      (await readFile(path.join(canonicalGit, "identity"), "utf8")) !==
        "canonical\n" ||
      (await readFile(path.join(canonicalGit, "container-marker"), "utf8")) !==
        "canonical-write\n"
    ) {
      throw new Error("container filesystem projection diverged");
    }
    reportStage("filesystem-projection-passed");

    const publishedPort = 39_091;
    const started = await runAsync(
      docker,
      [
        "run",
        "-d",
        "-p",
        `${publishedPort}:8080`,
        "localhost/zeros-busybox:qualification",
        "/bin/busybox",
        "httpd",
        "-f",
        "-p",
        "8080",
      ],
      { env },
    );
    containerId = started.stdout.trim();
    const curl = spawnSync(
      "/usr/bin/curl",
      [
        "--fail",
        "--silent",
        "--max-time",
        "2",
        `http://127.0.0.1:${publishedPort}/`,
      ],
      { encoding: "utf8" },
    );
    if (curl.status === 0) {
      throw new Error("unleased container port bypassed the VM firewall");
    }
    reportStage("unleased-port-blocked");
    await runAsync(docker, ["rm", "-f", containerId], {
      env,
      allowFailure: true,
    });
    containerId = "";

    const endpointPort = lease.hostPort;
    await lease.stopAndProve();
    lease = null;
    if (!(await waitForPortClosed(endpointPort))) {
      throw new Error("private container endpoint survived revocation");
    }
    reportStage("teardown-proven");
    process.stdout.write(
      `${JSON.stringify({
        status: "passed",
        backend: "orbstack-rootless-podman",
        codeWrite: true,
        designDenied: true,
        privateGit: true,
        privilegedDesignDenied: privileged.status !== 78,
        unleasedPortBlocked: true,
        teardownProven: true,
      })}\n`,
    );
  } catch (error) {
    qualificationError = error;
  }
  if (containerId && lease) {
    const docker = run("/usr/bin/which", ["docker"], {
      allowFailure: true,
    }).stdout.trim();
    if (path.isAbsolute(docker)) {
      await runAsync(docker, ["rm", "-f", containerId], {
        env: { ...process.env, ...lease.environment },
        allowFailure: true,
      });
    }
  }
  let leaseCleanupError: unknown;
  try {
    await lease?.stopAndProve();
  } catch (error) {
    leaseCleanupError = error;
  }
  let hasRecoveryHold = false;
  try {
    const hold = await lstat(
      path.join(session, ORBSTACK_MACHINE_RECOVERY_HOLD_FILE),
    );
    hasRecoveryHold = !hold.isDirectory();
  } catch {
    // Missing means creation never began or lease teardown already proved
    // deletion and cleared the hold.
  }
  const deletionRequired = Boolean(machineName && (lease || hasRecoveryHold));
  let deletionError: unknown;
  if (machineName && deletionRequired) {
    try {
      await controller.deleteMachineAndProve(machineName);
    } catch (error) {
      deletionError = error;
    }
  }
  // Keep the exact selective-mount sources alive when VM deletion cannot be
  // proven. Removing them first creates an unbootable orphan that OrbStack may
  // be unable to delete under low-disk recovery conditions.
  if (!deletionError) {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
  const cleanupError = deletionError ?? leaseCleanupError;
  if (qualificationError && cleanupError) {
    throw new AggregateError(
      [qualificationError, cleanupError],
      "OrbStack qualification failed and cleanup was not proven",
    );
  }
  if (qualificationError) throw qualificationError;
  if (cleanupError) throw cleanupError;
}

void main().catch((error) => {
  process.stderr.write(
    `[macos-orbstack-qualification] ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
