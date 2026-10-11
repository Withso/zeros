#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  chmodSync,
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
import { resolveCloudRuntime } from "./cloud-runtime-root.mjs";
import { effectiveCloudResourceLimits } from "./cgroup-resources.mjs";
import { cloudRuntimeResourcesQualified, validCloudResourceBudgetProjection } from "./cloud-resource-admission.mjs";
import { readCloudResourceBudgetProjection } from "./cloud-resource-budget.mjs";
import { loadCloudWorkloadCustody, nativeCloudWorkloadIO } from "../../../apps/desktop/src/engine/agents/containment/cloud-workload-cgroup.mjs";
import { cloudEnginePrivilegeStatus } from "./cloud-engine-privilege.mjs";
import { loadCloudQualificationRoles } from "./cloud-qualification-loader.mjs";

function optional(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}
/** Qualification targets use the same original pre-exec workload entry as
 * every cloud command. Unknown launch/timeout/retirement is not denial proof.
 * @param {import('./cloud-qualification-runtime').CloudQualificationRuntime} context
 * @param {{binRoot:string}} runtime
 * @param {string} file
 * @param {string[]} args
 */
export async function qualifyCloudEngineCommand(context, runtime, file, args, signal = globalThis.AbortSignal.timeout(5000)) {
  if (signal.aborted) throw new Error("Cloud engine command qualification failed");
  const prepared = await context.boundary.prepare({ executionId: randomUUID(), actor: "repo-code-task",
    providerId: "engine-qualification", cwd: "/srv/zeros/workspace", workspaceRoot: "/srv/zeros/workspace" }, { signal });
  try {
    const child = await prepared.spawn({ command: file, args, cwd: "/srv/zeros/workspace",
      env: { PATH: `${runtime.binRoot}:/usr/bin:/bin`, HOME: "/tmp" }, stdio: "pipe" });
    child.stdout?.resume(); child.stderr?.resume();
    const exit = await child.wait();
    if (signal.aborted || !Number.isInteger(exit.code) || exit.code < 0 || exit.signal !== null)
      throw new Error("Cloud engine command qualification failed");
    return exit.code === 0;
  } finally { await prepared.stopAndProve(); }
}
function denied(file) {
  try {
    readFileSync(file);
    return false;
  } catch (error) {
    return ["EACCES", "EPERM"].includes(error?.code);
  }
}

/** Actual root-projected controller and kernel controls, not caller-selected
 * cgroup paths. The explicit IO seam is used only by portable unit fixtures. */
export function qualifyCloudEngineResources(runtime = resolveCloudRuntime(), io = nativeCloudWorkloadIO, read = optional) {
  const custody = loadCloudWorkloadCustody(runtime.cgroupRoot, io);
  const controller = custody.infrastructure.find(birth => birth.pid === io.identity().pid && birth.controlDirectory);
  const projection = readCloudResourceBudgetProjection();
  if (!validCloudResourceBudgetProjection(projection)) throw new Error("Cloud engine resource qualification failed");
  const resources = { ...effectiveCloudResourceLimits(read("/proc/self/cgroup"), read), cpuSplit: custody.cpuSplit,
    memoryBudget: projection.memoryBudget };
  if (!controller || `/sys/fs/cgroup${resources.hierarchy[0]?.path}` !== controller.controlDirectory ||
      !cloudRuntimeResourcesQualified(resources) || resources.memoryBudget.source === "nominal" &&
      resources.cpuMax !== `${projection.resources.cpuMillicores * 100} 100000`)
    throw new Error("Cloud engine resource qualification failed");
  for (const original of [custody.common, custody.workload]) {
    const current = io.directory(original.directory);
    if (current.dev !== original.dev || current.ino !== original.ino || current.uid !== 10003 || current.filesystem !== 0x63677270 || current.mode & 0o022)
      throw new Error("Cloud engine resource qualification failed");
  }
  const controlled = (directory, name, expected) => {
    const metadata = io.control(directory, name);
    if (![0, 65534].includes(metadata.uid) || metadata.mode & 0o022 || metadata.filesystem !== 0x63677270 || io.read(directory, name).trim() !== expected)
      throw new Error("Cloud engine resource qualification failed");
  };
  controlled(controller.controlDirectory, "cpu.max", resources.cpuSplit.engine.cpuMax);
  controlled(controller.controlDirectory, "cpu.weight", "100");
  controlled(custody.workload.directory, "cpu.max", resources.cpuSplit.workload.cap.cpuMax);
  controlled(custody.workload.directory, "cpu.weight", "100");
  controlled(`${runtime.cgroupRoot}/host`, "memory.max", resources.memoryBudget.hostMemoryMax);
  const meminfo = read("/proc/meminfo");
  const lines = typeof meminfo === "string" && meminfo.length <= 65536 ? meminfo.split("\n").filter(line => line.startsWith("MemTotal:")) : [];
  const match = lines.length === 1 && /^MemTotal:\s+([1-9][0-9]{0,15}) kB$/.exec(lines[0]);
  const measured = match ? BigInt(match[1]) * 1024n : null;
  if (resources.memoryBudget.measuredMemoryBytes !== null && measured !== BigInt(resources.memoryBudget.measuredMemoryBytes) ||
      resources.memoryBudget.source === "nominal" && measured !== null &&
      BigInt(resources.memoryMax) > measured - BigInt(resources.memoryBudget.hostMemoryMax))
    throw new Error("Cloud engine resource qualification failed");
  if ([custody.common.directory, path.dirname(custody.workload.directory)]
    .some(directory => io.read(directory, "cgroup.subtree_control").trim() !== "cpu")) throw new Error("Cloud engine resource qualification failed");
  return resources;
}

/** Runs INSIDE the exact engine view. Host assertions alone cannot prove that
 * the engine lost VM authority or that its children inherit finite limits. */
/** @param {import('./cloud-qualification-runtime').CloudQualificationRuntime} context */
export async function qualifyCloudEngineIdentity(context) {
  const runtime=resolveCloudRuntime();
  context.custody.assertLive();
  const command = (file, args) => qualifyCloudEngineCommand(context, runtime, file, args);
  const checks = [];
  const check = (name, pass) =>
    checks.push({ name, status: pass ? "pass" : "fail" });
  const status = optional("/proc/self/status") ?? "";
  const { noNewPrivs, seccompMode, capabilities } = cloudEnginePrivilegeStatus(status);
  check(
    "engine-no-new-privileges-and-seccomp",
    noNewPrivs === 1 && seccompMode === 2,
  );
  check("engine-non-root-empty-capabilities", process.getuid?.() === 10003 && process.geteuid?.() === 10003 &&
    process.getgid?.() === 10003 && process.getegid?.() === 10003 && Object.values(capabilities).every(value => value === 0));
  check("fixed-engine-user-namespace", hasCloudEngineUserNamespace(runtime.profile === "v4" ? 4 : undefined));
  check(
    "readonly-image-authority",
    isCloudDeploymentOwner(
      `${runtime.workerRoot}/dist-engine/cli.js`,
      statSync(`${runtime.workerRoot}/dist-engine/cli.js`).uid,
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
      "/opt/zeros-bootstrap",
      "/srv/zeros/runtime-installs",
    ].every((file) => !existsSync(file)),
  );
  check(
    "host-root-authority-denied",
    denied("/proc/1/root/etc/shadow"),
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
    !await command("/usr/bin/nsenter", [
      "--target",
      "1",
      "--user",
      "--preserve-credentials",
      "/usr/bin/true",
    ]),
  );
  let locked = true;
  for (const file of ["/usr", runtime.workerRoot, runtime.root, "/sys/fs/cgroup", "/"])
    if (await command("/usr/bin/mount", ["-o", "remount,rw", file])) locked = false;
  check("readonly-mounts-locked", locked);
  check(
    "inherited-unmount-denied",
    !await command("/usr/bin/umount", [runtime.root]),
  );
  const temporary = mkdtempSync("/tmp/zeros-engine-identity-");
  try {
    chmodSync(temporary, 0o700);
    const file = path.join(temporary, "shared");
    writeFileSync(file, "engine fixture", { mode: 0o600 });
    check("same-engine-child-shared-files", await command(runtime.node, ["-e",
      "const fs=require('node:fs');if(process.getuid()!==10003||process.geteuid()!==10003||process.getgid()!==10003||process.getegid()!==10003)process.exit(2);" +
      "if(fs.readFileSync(process.argv[1],'utf8')!=='engine fixture')process.exit(3);" +
      "fs.writeFileSync(process.argv[1],'shared edit');", file]) && readFileSync(file,"utf8") === "shared edit");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  let resources = null;
  try { resources = qualifyCloudEngineResources(runtime); } catch { /* Unknown custody/limits cannot qualify. */ }
  check("finite-engine-and-descendant-resources", resources !== null);
  return {
    hostUid: 10003,
    namespaceUid: process.getuid(),
    noNewPrivs,
    seccompMode,
    capabilities,
    checks,
    resources,
    qualified: checks.every((entry) => entry.status === "pass"),
  };
}

/** Every true field comes from the fixed probe executed in this exact engine
 * view. Owned groups mean the original detached Host supervisor group and its
 * non-escaped members; this does not prove retirement of arbitrary setsid escapes. */
/** @param {Awaited<ReturnType<typeof qualifyCloudEngineIdentity>>} [identity]
 * @param {typeof loadCloudQualificationRoles} [loadRoles] */
export async function qualifyCloudEngineRuntime(identity, loadRoles = loadCloudQualificationRoles) {
  const report = { version: 2, boundary: "workspace-vm", engineChecksPassed: false, qualified: false, identity,
    execution: null, capture: null, humanServices: null, actorTools: null };
  const identityPassed = value => {
    const capabilities = value?.capabilities;
    return value?.qualified === true && value.hostUid === 10003 && value.namespaceUid === 10003 &&
      value.noNewPrivs === 1 && value.seccompMode === 2 && capabilities &&
      Object.keys(capabilities).sort().join(",") === "ambient,bounding,effective,inheritable,permitted" &&
      Object.values(capabilities).every(value => value === 0) && cloudRuntimeResourcesQualified(value.resources);
  };
  if (identity !== undefined && !identityPassed(identity)) return report;
  let loaded, context;
  try {
    // Inline execution preserves the original root-projected controller birth.
    loaded = await loadRoles();
    const { createCloudQualificationRuntime, qualifyCloudActorTools, qualifyCloudCapture, qualifyCloudHumanServices } = loaded.roles;
    context = createCloudQualificationRuntime();
    if (identity === undefined) {
      report.identity = await qualifyCloudEngineIdentity(context);
      if (!identityPassed(report.identity)) return report;
    }
    const actor = await qualifyCloudActorTools(context);
    const execution = actor?.execution;
    const fields = ["sameEngineIdentity", "noSandbox", "ownedProcessGroups", "originalProcessGroupsRetired", "timeoutRetired", "workloadCgroup"];
    if (!execution || fields.some(key => execution[key] !== true) || execution.vmWorkloadDrain !== false ||
        actor.actorTools?.sameEngineIdentity !== true || actor.actorTools.noSandbox !== true) return report;
    report.execution = { ...Object.fromEntries(fields.map(key => [key, true])), vmWorkloadDrain: false };
    report.actorTools = { sameEngineIdentity: true, noSandbox: true };
    const capture = await qualifyCloudCapture(context);
    if (capture?.sameEngineIdentity !== true || capture.chromiumSandbox !== true) return report;
    report.capture = { sameEngineIdentity: true, chromiumSandbox: true };
    const human = await qualifyCloudHumanServices(context);
    if (human?.sameEngineIdentity !== true || human.noSandbox !== true) return report;
    report.humanServices = { sameEngineIdentity: true, noSandbox: true };
    const inspection = await context.workloads.inspect();
    if (!inspection.complete || inspection.pendingLaunches || inspection.failedRetirements || inspection.workloadPids.length) return report;
    context.custody.assertLive();
    report.engineChecksPassed = true;
  } catch { /* Raw probe failures never become public diagnostics or success. */ }
  finally {
    // Services that role probes start for this controller end with it, as in
    // the engine's stop(); otherwise it never exits to publish this report.
    try { context?.close(); } catch { report.engineChecksPassed = false; }
    await loaded?.unregister();
  }
  return report;
}
async function main() {
  process.umask(0o077);
  const report = await qualifyCloudEngineRuntime();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.engineChecksPassed) process.exitCode = 1;
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
