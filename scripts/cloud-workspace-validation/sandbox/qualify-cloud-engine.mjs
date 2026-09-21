#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasCloudEngineUserNamespace,
  isCloudDeploymentOwner,
} from "../../../apps/desktop/src/engine/agents/containment/cloud-deployment-authority.mjs";
import { effectiveCloudResourceLimits } from "./cgroup-resources.mjs";

function optional(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}
function command(file, args, options = {}) {
  const child = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
    env: { PATH: "/opt/zeros-runtime/bin:/usr/bin:/bin", HOME: "/tmp" },
    ...options,
  });
  return !child.error && child.signal === null && child.status === 0;
}
function denied(file) {
  try {
    readFileSync(file);
    return false;
  } catch (error) {
    return ["EACCES", "EPERM"].includes(error?.code);
  }
}

/** Runs INSIDE the exact engine view. Host assertions alone cannot prove that
 * the engine lost VM authority or that its children inherit finite limits. */
export function qualifyCloudEngineIdentity() {
  const checks = [];
  const check = (name, pass) =>
    checks.push({ name, status: pass ? "pass" : "fail" });
  const status = optional("/proc/self/status") ?? "";
  const noNewPrivs = Number(/^NoNewPrivs:\s+(\d+)$/m.exec(status)?.[1] ?? -1);
  const seccompMode = Number(/^Seccomp:\s+(\d+)$/m.exec(status)?.[1] ?? -1);
  check(
    "engine-no-new-privileges-and-seccomp",
    noNewPrivs === 1 && seccompMode === 2,
  );
  check("fixed-engine-user-namespace", hasCloudEngineUserNamespace());
  check(
    "readonly-image-authority",
    isCloudDeploymentOwner(
      "/opt/zeros/dist-engine/cli.js",
      statSync("/opt/zeros/dist-engine/cli.js").uid,
    ),
  );
  check(
    "host-authority-absent",
    [
      "/root",
      "/home/user",
      "/srv/zeros/setup",
      "/srv/zeros/broker",
      "/run/zeros/cloud-worker-supervisor.sock",
      "/etc/shadow",
      "/etc/ssh",
    ].every((file) => !existsSync(file)),
  );
  check(
    "host-process-secrets-denied",
    denied("/proc/1/environ") && denied("/proc/1/root/etc/shadow"),
  );
  // Test write admission without writing/truncating a global kernel control.
  // Namespace CAP_DAC_OVERRIDE must never confer authority over VM root.
  check(
    "global-kernel-control-writes-denied",
    [
      "/proc/sys/kernel/modprobe",
      "/proc/sys/kernel/core_pattern",
      "/proc/sysrq-trigger",
      "/proc/sys/fs/file-max",
      "/proc/sys/net/ipv4/ip_forward",
    ].every((file) => {
      let descriptor;
      try {
        descriptor = openSync(
          file,
          constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        return false;
      } catch (error) {
        return ["EACCES", "EPERM", "EROFS"].includes(error?.code);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }),
  );
  check(
    "host-user-namespace-entry-denied",
    !command("/usr/bin/nsenter", [
      "--target",
      "1",
      "--user",
      "--preserve-credentials",
      "/usr/bin/true",
    ]),
  );
  check(
    "readonly-mounts-locked",
    ["/usr", "/opt/zeros", "/opt/zeros-runtime", "/sys/fs/cgroup", "/"].every(
      (file) => !command("/usr/bin/mount", ["-o", "remount,rw", file]),
    ),
  );
  check(
    "inherited-unmount-denied",
    !command("/usr/bin/umount", ["/opt/zeros-runtime"]),
  );
  check(
    "worker-nested-user-namespace",
    command(
      "/usr/bin/unshare",
      ["--user", "--map-root-user", "/usr/bin/true"],
      { uid: 10001, gid: 10001 },
    ),
  );
  const temporary = mkdtempSync("/tmp/zeros-engine-identity-");
  try {
    chmodSync(temporary, 0o711);
    const workerFile = path.join(temporary, "worker");
    const engineFile = path.join(temporary, "engine");
    writeFileSync(workerFile, "worker", { mode: 0o600 });
    chownSync(workerFile, 10001, 10001);
    let ownership = readFileSync(workerFile, "utf8") === "worker";
    writeFileSync(workerFile, "engine edit");
    chmodSync(workerFile, 0o600);
    ownership &&= statSync(workerFile).uid === 10001;
    check("worker-file-ownership-preserved", ownership);
    writeFileSync(engineFile, "engine fixture", { mode: 0o600 });
    check(
      "worker-cannot-read-engine-or-become-engine",
      command(
        process.execPath,
        [
          "-e",
          `
      const fs=require('node:fs');
      if(process.getuid()!==10001)process.exit(2);
      if(fs.readFileSync(process.argv[1],'utf8')!=='engine edit')process.exit(3);
      let denied=false;try{fs.readFileSync(process.argv[2])}catch(e){denied=e.code==='EACCES'}
      if(!denied)process.exit(4);
      try{process.setuid(0);process.exit(5)}catch{}
    `,
          workerFile,
          engineFile,
        ],
        { uid: 10001, gid: 10001 },
      ),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const resources = effectiveCloudResourceLimits(
    optional("/proc/self/cgroup"),
    optional,
  );
  check("finite-engine-and-descendant-resources", resources.finite);
  return {
    hostUid: 10003,
    namespaceUid: process.getuid(),
    noNewPrivs,
    seccompMode,
    checks,
    resources,
    secure: checks.every((entry) => entry.status === "pass"),
  };
}

async function main() {
  // Bootstrap uses a private umask while handling admission material. Keep the
  // live gate under that same constraint even when an operator runs it from a
  // more permissive shell; fixtures must explicitly grant intended reads.
  process.umask(0o077);
  const identity = qualifyCloudEngineIdentity();
  // A failed identity check must never admit workload execution.
  let workload = null;
  let capture = null;
  let humanServices = null;
  let actorTools = null;
  if (identity.secure) {
    const child = spawnSync(
      process.execPath,
      [
        "/opt/zeros/scripts/zsr-qualification/run.mjs",
        "--cloud-worker",
        "--require-secure",
      ],
      {
        env: process.env,
        encoding: "utf8",
        timeout: 165000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (!child.error && child.signal === null) {
      try {
        workload = JSON.parse(child.stdout);
      } catch {
        /* fail closed */
      }
    }
    if (!workload || typeof workload !== "object" || Array.isArray(workload))
      workload = {
        secure: false,
        error: String(child.stderr ?? "").slice(-2000),
      };
    if (child.status !== 0 || child.error || child.signal)
      workload = {
        ...workload,
        secure: false,
        exitCode: child.status,
        signal: child.signal,
        error: String(child.error?.message ?? child.stderr ?? "").slice(-2000),
      };
  }
  if (identity.secure && workload?.secure === true) {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "/opt/zeros/scripts/cloud-workspace-validation/sandbox/qualify-cloud-capture.ts",
      ],
      {
        cwd: "/opt/zeros",
        env: process.env,
        encoding: "utf8",
        timeout: 35000,
        maxBuffer: 65536,
      },
    );
    if (child.status === 0 && !child.error && !child.signal) {
      try {
        capture = JSON.parse(child.stdout);
      } catch {
        /* fail closed */
      }
    }
    if (!capture || capture.secure !== true)
      capture = {
        secure: false,
        error: "Sandboxed cloud capture did not qualify",
      };
  }
  if (identity.secure && workload?.secure === true && capture?.secure === true) {
    const child = spawnSync(process.execPath, ["--import", "tsx",
      "/opt/zeros/scripts/cloud-workspace-validation/sandbox/qualify-cloud-human-services.ts"], {
      cwd: "/opt/zeros", env: process.env, encoding: "utf8", timeout: 35000, maxBuffer: 65536,
    });
    if (!child.error && !child.signal) {
      try { humanServices = JSON.parse(child.stdout); } catch { /* fail closed */ }
    }
    if (!humanServices || typeof humanServices !== "object" || Array.isArray(humanServices))
      humanServices = { secure: false, error: "Cloud human service qualification failed" };
    if (child.status !== 0 || child.error || child.signal) humanServices.secure = false;
  }
  if (identity.secure && workload?.secure === true && humanServices?.secure === true) {
    const child = spawnSync(process.execPath, ["--import", "tsx",
      "/opt/zeros/scripts/cloud-workspace-validation/sandbox/qualify-cloud-actor-tools.ts"], {
      cwd: "/opt/zeros", env: process.env, encoding: "utf8", timeout: 45000, maxBuffer: 65536,
    });
    if (!child.error && !child.signal) {
      try { actorTools = JSON.parse(child.stdout); } catch { /* fail closed */ }
    }
    if (!actorTools || typeof actorTools !== "object" || Array.isArray(actorTools))
      actorTools = { secure: false, error: "Cloud actor tool qualification failed" };
    if (child.status !== 0 || child.error || child.signal) actorTools.secure = false;
  }
  const secure = identity.secure && workload?.secure === true &&
    capture?.secure === true && humanServices?.secure === true && actorTools?.secure === true;
  process.stdout.write(
    `${JSON.stringify({ version: 1, secure, identity, workload, capture, humanServices, actorTools })}\n`,
  );
  if (!secure) process.exitCode = 1;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    process.stderr.write("cloud engine identity qualification failed\n");
    process.exitCode = 1;
  });
}
