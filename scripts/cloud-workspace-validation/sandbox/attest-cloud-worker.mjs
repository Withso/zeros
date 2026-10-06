#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { parseSetupTimings, setupTimingClock } from "./cloud-setup-timings.mjs";
import * as filesystem from "node:fs";
import { cloudComputerHostRepository } from "./cloud-computer-checkout.mjs";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { availableParallelism } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import {
  createCloudRuntimeResolver,
  parseCloudActiveRuntime,
  resolveCloudRuntime,
  validateCloudRuntimeMarker,
} from "./cloud-runtime-root.mjs";
import runtimeLayout from "./runtime-layout.json" with { type: "json" };
import { effectiveCloudResourceLimits } from "./cgroup-resources.mjs";
import { cloudAllocationCapacity } from "./cloud-resource-admission.mjs";
import {
  cloudImageBuildMatchesInstallation,
  cloudImageBaseOrigin,
  readCloudImageNativeInventory,
} from "./image-build-contract.mjs";
import {
  cloudRuntimeProcessSecurityQualified,
  readCloudHostRuntimeProfile,
} from "./cloud-runtime-profile.mjs";

const MARKER = "/etc/zeros/cloud-worker.json";
const BUILD = "/etc/zeros/image-build.json";
const MAX_OUTPUT = 8 * 1024 * 1024;
const ADMISSION_DIRECTORY = "/run/zeros";
const ADMISSION_PROOF = path.join(
  ADMISSION_DIRECTORY,
  "cloud-worker-admission.json",
);
const ENGINE_LOCK = path.join(ADMISSION_DIRECTORY, "engine.lock");
const LOCKED_ARGUMENT = "--engine-lock-held";

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readOptional(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

function rootControlled(file, executable = false, directory = false) {
  try {
    if (!path.isAbsolute(file) || realpathSync(file) !== file) return false;
    let cursor = file;
    for (;;) {
      const stat = lstatSync(cursor);
      const leaf = cursor === file;
      if (
        stat.isSymbolicLink() ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0 ||
        (leaf
          ? directory
            ? !stat.isDirectory()
            : !stat.isFile()
          : !stat.isDirectory())
      ) {
        return false;
      }
      if (leaf && executable && (stat.mode & 0o111) === 0) return false;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return true;
  } catch {
    return false;
  }
}

function rootControlledTree(root) {
  try {
    const canonicalRoot = realpathSync(root);
    const pending = [canonicalRoot];
    let visited = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      const stat = lstatSync(current);
      visited += 1;
      if (visited > 500_000 || stat.uid !== 0) return false;
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(current);
        const lexical = path.resolve(path.dirname(current), target);
        if (
          lexical !== canonicalRoot &&
          !lexical.startsWith(`${canonicalRoot}${path.sep}`)
        ) {
          return false;
        }
        continue;
      }
      if ((stat.mode & 0o022) !== 0) return false;
      if (stat.isDirectory()) {
        for (const entry of readdirSync(current)) {
          pending.push(path.join(current, entry));
        }
      } else if (!stat.isFile()) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function run(file, args, timeout = 30_000, extraEnv = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: MAX_OUTPUT,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/root",
      ZEROS_ZSR_QUALIFICATION_UID: "10001",
      ZEROS_ZSR_QUALIFICATION_GID: "10001",
      ...extraEnv,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    error: result.error?.message,
  };
}

function version(file, args = ["--version"]) {
  const result = run(file, args);
  return result.status === 0
    ? (result.stdout || result.stderr).split("\n")[0]
    : null;
}

function namespace(name) {
  try {
    return readlinkSync(`/proc/self/ns/${name}`);
  } catch {
    return null;
  }
}

function containerInitStartTicks() {
  try {
    const source = readFileSync("/proc/1/stat", "utf8");
    const commandEnd = source.lastIndexOf(")");
    const fields = source
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function prepareAdmissionDirectory() {
  try {
    mkdirSync(ADMISSION_DIRECTORY, { recursive: true, mode: 0o700 });
    chmodSync(ADMISSION_DIRECTORY, 0o700);
    const stat = lstatSync(ADMISSION_DIRECTORY);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === 0 &&
      (stat.mode & 0o077) === 0 &&
      realpathSync(ADMISSION_DIRECTORY) === ADMISSION_DIRECTORY
    );
  } catch {
    return false;
  }
}

function mountFor(target) {
  const result = run("/usr/bin/findmnt", [
    "--json",
    "--output",
    "TARGET,FSTYPE,OPTIONS",
    "--target",
    target,
  ]);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout).filesystems?.[0] ?? null;
  } catch {
    return null;
  }
}

// Keep the legacy report, proof, checks and output unchanged. V4 never enters
// this branch or reads image-build.json/native package/source-tree metadata.
function attestLegacyCloudWorker() {
const RUNTIME = resolveCloudRuntime();
const ENGINE = RUNTIME.workerRoot;
if (process.platform !== "linux" || process.geteuid?.() !== 0) {
  process.stderr.write("cloud attestation requires a root Linux coordinator\n");
  process.exit(1);
}

// Serialize attestation, stale-scope recovery, and engine lifetime on one
// root-only lock. `--no-fork` makes timeout/termination release the lock with
// the attester instead of leaving a flock wrapper behind.
if (process.argv[2] !== LOCKED_ARGUMENT) {
  if (!prepareAdmissionDirectory()) {
    process.stderr.write("cloud attestation directory is unavailable\n");
    process.exit(1);
  }
  const tokenPath = path.join(
    ADMISSION_DIRECTORY,
    `.attest-lock-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  writeFileSync(tokenPath, `${randomBytes(32).toString("hex")}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const locked = spawnSync(
    "/usr/bin/flock",
    [
      "--no-fork",
      "--nonblock",
      ENGINE_LOCK,
      process.execPath,
      realpathSync(fileURLToPath(import.meta.url)),
      LOCKED_ARGUMENT,
      tokenPath,
    ],
    {
      encoding: "utf8",
      // The locked child itself permits a 180s live qualification after image
      // tree and tenant-limit checks. Keep the outer lock owner bounded but leave enough
      // headroom that it cannot preempt a valid inner timeout at the boundary.
      timeout: 300_000,
      maxBuffer: MAX_OUTPUT,
      env: { PATH: `${RUNTIME.binRoot}:/usr/bin:/bin`, HOME: "/root" },
    },
  );
  rmSync(tokenPath, { force: true });
  if (locked.stdout) process.stdout.write(locked.stdout);
  if (locked.stderr) process.stderr.write(locked.stderr);
  process.exit(locked.status ?? 1);
}

const lockToken = process.argv[3];
try {
  if (path.dirname(lockToken) !== ADMISSION_DIRECTORY) {
    throw new Error("invalid lock handoff");
  }
  const descriptor = openSync(
    lockToken,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(descriptor);
    const current = lstatSync(lockToken);
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      current.isSymbolicLink() ||
      stat.dev !== current.dev ||
      stat.ino !== current.ino ||
      (stat.mode & 0o077) !== 0 ||
      !/^[a-f0-9]{64}$/.test(readFileSync(descriptor, "utf8").trim())
    ) {
      throw new Error("invalid lock handoff");
    }
    unlinkSync(lockToken);
  } finally {
    closeSync(descriptor);
  }
} catch {
  process.stderr.write("cloud attestation lock handoff is invalid\n");
  process.exit(1);
}

// A failed or interrupted re-attestation must invalidate any unconsumed proof
// from an earlier attempt before it does work that may take several minutes.
rmSync(ADMISSION_PROOF, { force: true });

let marker;
let build;
try {
  marker = JSON.parse(readFileSync(MARKER, "utf8"));
  build = JSON.parse(readFileSync(BUILD, "utf8"));
} catch (error) {
  process.stderr.write(
    `cloud attestation metadata is invalid: ${error.message}\n`,
  );
  process.exit(1);
}

const runtimeProfile = readCloudHostRuntimeProfile();
const isolated = runtimeProfile.version >= 2;
let originMatches = build.version === 1;
if (build.version === 2) {
  try {
    const origin = cloudImageBaseOrigin(
      build.baseOrigin?.kind === "native-linux"
        ? "native-linux"
        : build.baseOrigin?.reference,
      build.baseOrigin?.kind === "native-linux"
        ? readCloudImageNativeInventory()
        : undefined,
    );
    originMatches =
      origin.baseImage === build.baseImage &&
      JSON.stringify(origin.baseOrigin) === JSON.stringify(build.baseOrigin);
  } catch {
    /* Unverifiable provenance cannot qualify. */
  }
}
const helperTrust = Object.fromEntries(
  Object.entries(marker.toolchain ?? {}).map(([name, file]) => [
    name,
    typeof file === "string" && rootControlled(file, name !== "supervisor"),
  ]),
);
const deploymentTrust = {
  runtimeProfile: rootControlled(
    `${RUNTIME.libRoot}/cloud-runtime-profile.mjs`,
  ),
  ...(isolated
    ? {
        engineLauncher: rootControlled(
          `${RUNTIME.libRoot}/cloud-engine-launcher.mjs`,
        ),
        engineView: rootControlled(
          `${RUNTIME.libRoot}/cloud-engine-view.mjs`,
        ),
        engineCgroup: rootControlled(
          `${RUNTIME.libRoot}/cloud-engine-cgroup.mjs`,
        ),
        engineNamespace: rootControlled(
          RUNTIME.engineNamespace,
          true,
        ),
        engineAppArmor: rootControlled(
          RUNTIME.profile === "v4" ? "/etc/apparmor.d/zeros-cloud-engine" : `${RUNTIME.libRoot}/zeros-cloud-engine.apparmor`,
        ),
        runtimeTree: rootControlledTree(RUNTIME.root),
        engineQualification: rootControlled(
          `${ENGINE}/scripts/cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs`,
        ),
      }
    : {}),
  supervisorRecovery: rootControlled(
    `${RUNTIME.libRoot}/ensure-cloud-worker-supervisor.mjs`,
  ),
  runtimeLayout:
    rootControlled(`${RUNTIME.libRoot}/runtime-layout.json`) &&
    JSON.stringify(build.runtimeLayout) === JSON.stringify(runtimeLayout),
  resourceInspector: rootControlled(
    `${RUNTIME.libRoot}/cgroup-resources.mjs`,
  ),
  resourceAdmission: rootControlled(
    `${RUNTIME.libRoot}/cloud-resource-admission.mjs`,
  ),
  imageContract: rootControlled(
    `${RUNTIME.libRoot}/image-build-contract.mjs`,
  ),
  setupProcess: rootControlled(
    `${RUNTIME.libRoot}/cloud-setup-process.mjs`,
  ),
  sourceIntegrity:
    originMatches &&
    (build.version === 1 || cloudImageBuildMatchesInstallation(build, ENGINE)),
  marker: rootControlled(MARKER),
  build: rootControlled(BUILD),
  engine: rootControlled(ENGINE, false, true),
  engineTree: rootControlledTree(ENGINE),
  launcher: rootControlled(RUNTIME.startEngine, true),
  admissionConsumer: rootControlled(
    `${RUNTIME.libRoot}/consume-cloud-admission.mjs`,
    true,
  ),
  previewLinkInstaller: rootControlled(
    `${RUNTIME.libRoot}/install-cloud-preview-links.mjs`,
    true,
  ),
  githubCredentialInstaller: rootControlled(
    `${RUNTIME.libRoot}/install-cloud-github-credential.mjs`,
    true,
  ),
  githubRefreshRequestHelper: rootControlled(
    `${RUNTIME.libRoot}/cloud-github-refresh-request.mjs`,
    true,
  ),
  gitAskpass: rootControlled(
    `${RUNTIME.libRoot}/cloud-git-askpass.mjs`,
    true,
  ),
  workerSupervisor: rootControlled(
    `${RUNTIME.libRoot}/cloud-worker-supervisor.mjs`,
    true,
  ),
  setupHelper: rootControlled(
    `${RUNTIME.libRoot}/setup-cloud-workspace.mjs`,
    true,
  ),
  attester: rootControlled(
    `${RUNTIME.libRoot}/attest-cloud-worker.mjs`,
    true,
  ),
  admissionDirectory: prepareAdmissionDirectory(),
};
let resources = effectiveCloudResourceLimits(
  readOptional("/proc/self/cgroup"),
  readOptional,
);
let storageBytes = 0;
try {
  const fs = statfsSync(runtimeLayout.repository, { bigint: true });
  const total = fs.blocks * fs.bsize;
  if (total > 0n && total <= BigInt(Number.MAX_SAFE_INTEGER))
    storageBytes = Number(total);
} catch {
  /* Missing or unmeasurable storage fails admission. */
}
const allocation = cloudAllocationCapacity({
  isolated,
  membership: readOptional("/proc/self/cgroup"),
  read: readOptional,
  architecture: process.arch,
  availableCPUs: availableParallelism(),
  storageBytes,
});

const qualificationResult = run(
  marker.toolchain.node,
  isolated
    ? [`${RUNTIME.libRoot}/cloud-engine-launcher.mjs`, "--qualify"]
    : [
        path.join(ENGINE, "scripts/zsr-qualification/run.mjs"),
        "--cloud-worker",
        "--require-secure",
      ],
  180_000,
);
let qualification = null;
try {
  qualification = JSON.parse(qualificationResult.stdout);
} catch {
  // Preserve only bounded infrastructure diagnostics below.
}
if (isolated)
  resources = qualification?.identity?.resources ?? { finite: false };
const finiteResources = resources.finite === true;
const setupQualificationResult = isolated
  ? run(
      marker.toolchain.node,
      [`${RUNTIME.libRoot}/cloud-setup-process.mjs`, "--qualify"],
      30000,
    )
  : null;
let setupQualification = null;
try {
  if (setupQualificationResult)
    setupQualification = JSON.parse(setupQualificationResult.stdout);
} catch {
  /* Fail closed below. */
}

const status = readFileSync("/proc/self/status", "utf8");
const statusField = (name) =>
  new RegExp(`^${name}:\\s+(.+)$`, "m").exec(status)?.[1]?.trim() ?? null;
const report = {
  version: 1,
  profile: marker.profile,
  qualified:
    marker.version === runtimeProfile.version &&
    marker.backend === "cloud-worker" &&
    marker.uid === 10001 &&
    marker.gid === 10001 &&
    [1, 2].includes(build.version) &&
    build.profile === marker.profile &&
    ["x64", "arm64"].includes(process.arch) &&
    Object.values(helperTrust).length === 4 &&
    Object.values(helperTrust).every(Boolean) &&
    Object.values(deploymentTrust).every(Boolean) &&
    finiteResources &&
    (!isolated ||
      (setupQualificationResult.status === 0 &&
        setupQualification?.secure === true)) &&
    cloudRuntimeProcessSecurityQualified(
      runtimeProfile.version,
      statusField("Seccomp"),
      qualification?.identity,
    ) &&
    ["mnt", "pid", "net", "ipc", "uts", "cgroup", "user"].every(
      (name) => namespace(name) !== null,
    ) &&
    containerInitStartTicks() !== null &&
    qualificationResult.status === 0 &&
    (!isolated || qualification?.identity?.secure === true) &&
    qualification?.secure === true,
  metadata: {
    markerSha256: sha256File(MARKER),
    buildSha256: sha256File(BUILD),
    build,
  },
  platform: {
    architecture: process.arch,
    kernel: readOptional("/proc/sys/kernel/osrelease"),
    lsm: readOptional("/sys/kernel/security/lsm"),
    unprivilegedUserNamespaces: readOptional(
      "/proc/sys/kernel/unprivileged_userns_clone",
    ),
    apparmorRestrictUnprivilegedUserns: readOptional(
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    ),
    seccompMode: statusField("Seccomp"),
    noNewPrivs: statusField("NoNewPrivs"),
    namespaces: Object.fromEntries(
      ["mnt", "pid", "net", "ipc", "uts", "cgroup", "user"].map((name) => [
        name,
        namespace(name),
      ]),
    ),
  },
  helpers: {
    trusted: helperTrust,
    deploymentTrusted: deploymentTrust,
    versions: {
      node: version(marker.toolchain.node),
      bwrap: version(marker.toolchain.bwrap),
      setpriv: version(marker.toolchain.setpriv),
      podman: version("/usr/bin/podman"),
      git: version("/usr/bin/git"),
      gitLfs: version("/usr/bin/git-lfs"),
      rg: version("/usr/bin/rg"),
    },
  },
  mounts: Object.fromEntries(
    [
      "/",
      ENGINE,
      runtimeLayout.repository,
      runtimeLayout.data,
      "/sys/fs/cgroup",
    ].map((target) => [target, mountFor(target)]),
  ),
  resources: {
    ...resources,
    allocation,
    finite: finiteResources,
  },
  qualification,
  setupQualification,
  qualificationError:
    qualificationResult.status === 0
      ? null
      : (qualificationResult.error ?? qualificationResult.stderr.slice(-2_000)),
};

const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
if (report.qualified) {
  const proof = {
    version: 1,
    profile: report.profile,
    qualifiedAtMs: Date.now(),
    reportSha256: createHash("sha256").update(serializedReport).digest("hex"),
    markerSha256: report.metadata.markerSha256,
    buildSha256: report.metadata.buildSha256,
    bootId: readOptional("/proc/sys/kernel/random/boot_id"),
    containerInitStartTicks: containerInitStartTicks(),
    namespaces: Object.fromEntries(
      ["mnt", "pid", "cgroup"].map((name) => [name, namespace(name)]),
    ),
  };
  const temporary = `${ADMISSION_PROOF}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(proof)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o400,
    });
    chmodSync(temporary, 0o400);
    renameSync(temporary, ADMISSION_PROOF);
  } finally {
    rmSync(temporary, { force: true });
  }
}

process.stdout.write(serializedReport);
if (!report.qualified) process.exitCode = 1;
}

// Component-local vocabulary. Arbitrary child output and exception messages
// never enter this vocabulary.
const V4_CHECKS = new Set([
  "active_descriptor", "host_marker", "installer_receipt", "receipt_digest",
  "manifest_digest", "manifest_schema", "base_compatibility", "root_ownership",
  "file_mode", "file_inventory", "hard_link", "symlink_escape", "boot_identity",
  "namespace_binding", "uid_map", "apparmor", "cgroup_controllers",
  "finite_resources", "containment_smoke", "seccomp", "setup_exit", "input_schema",
  "lock_busy", "launch_proof", "pointer_publish", "timeout", "process_signal", "diagnostic_missing",
]);
const V4_STAGES = new Set([
  "validate_input", "lock", "verify_tree", "qualify_engine", "run_setup", "publish_proof", "consume_proof", "done",
]);
export const CLOUD_V4_IDENTITY_FIELDS = Object.freeze([
  "runtimeId", "manifestSha256", "baseCompatibilityId", "installerReceiptSha256", "bootId", "supervisorSessionId",
]);
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const hexDigest = value => typeof value === "string" && value.length === 64 && /^[a-f0-9]+$/.test(value);
function receiptTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match || match[0] !== value) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse normalizes impossible days and 24:00. The installer's RFC3339
  // receipt contract does not, so reject those spellings before parsing.
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    hour < 24 && minute < 60 && second < 60 && Number.isFinite(Date.parse(value));
}
class V4Failure extends Error {
  constructor(check) { super("Cloud v4 attestation failed"); this.check = check; }
}
export function requireCloudV4Check(pass, check) {
  if (!pass) throw new V4Failure(V4_CHECKS.has(check) ? check : "diagnostic_missing");
}
function attemptV4(check, operation) {
  try { return operation(); }
  catch (error) { if (error instanceof V4Failure) throw error; throw new V4Failure(check); }
}
export function cloudV4Diagnostic(error, stage) {
  const check = error instanceof V4Failure && V4_CHECKS.has(error.check) ? error.check : "diagnostic_missing";
  return { schema: "zeros.diagnostic/v1", component: "attester", stage: V4_STAGES.has(stage) ? stage : "validate_input",
    ok: error === null, exitCode: error === null ? 0 : 1, timedOut: error !== null && check === "timeout",
    failedChecks: error === null ? [] : [check] };
}

/** A malformed v4 descriptor/marker must reach the closed diagnostic boundary
 * even when the resolver cannot produce a runtime. No environment selector. */
export function usesCloudV4Attestation() {
  try { return resolveCloudRuntime().profile === "v4"; }
  catch {
    if (/^\/opt\/zeros-infra\/r1-[a-f0-9]{64}\/bin\/node$/.test(process.execPath)) return true;
    // Recognize legacy only to preserve its existing rejection/output path.
    // This bounded peek grants no authority: the legacy branch still runs its
    // original resolver/profile guards. A pinned v4 executable cannot use it.
    let fd;
    try {
      fd = openSync(MARKER, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (stat.isFile() && stat.size >= 2 && stat.size <= 4096) {
        const buffer = Buffer.alloc(4097);
        const size = readSync(fd, buffer, 0, buffer.length, 0);
        if (size === stat.size && [1, 2, 3].includes(JSON.parse(buffer.toString("utf8", 0, size))?.version)) return false;
      }
    } catch { /* Unknown/v4 authority failures use closed diagnostics. */ }
    finally { if (fd !== undefined) closeSync(fd); }
    return true;
  }
}

/** Root-owned authority files are pinned, bounded and read without following
 * links. Tests inject node:fs using the same logical-root fixture as B2. */
export function readCloudV4File(file, maximum, check, mode) {
  attemptV4(check, () => lstatSync(file));
  requireCloudV4Check(rootControlled(file), "root_ownership");
  return attemptV4(check, () => {
    const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd), current = lstatSync(file);
      requireCloudV4Check(stat.isFile() && stat.uid === 0 && stat.dev === current.dev && stat.ino === current.ino &&
        !current.isSymbolicLink(), "root_ownership");
      requireCloudV4Check(stat.nlink === 1, "hard_link");
      requireCloudV4Check((stat.mode & 0o7022) === 0 && (mode === undefined || (stat.mode & 0o777) === mode), "file_mode");
      requireCloudV4Check(stat.size >= 2 && stat.size <= maximum, check);
      const bytes = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (count === 0) break;
        size += count;
      }
      requireCloudV4Check(size === stat.size, check);
      return bytes.subarray(0, size);
    } finally { closeSync(fd); }
  });
}

export function parseCloudV4Document(bytes, check) {
  return attemptV4(check, () => {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const objects = [];
    // JSON.parse silently discards duplicate keys, including escaped aliases.
    for (let index = 0; index < source.length; index++) {
      if (source[index] === "{") objects.push(new Set());
      else if (source[index] === "}") objects.pop();
      else if (source[index] === '"') {
        const start = index++;
        for (; index < source.length; index++) {
          if (source[index] === "\\") index++;
          else if (source[index] === '"') break;
        }
        let next = index + 1;
        while (next < source.length && /\s/.test(source[next])) next++;
        if (source[next] === ":") {
          const key = JSON.parse(source.slice(start, index + 1)), keys = objects.at(-1);
          requireCloudV4Check(keys && /^[\x20-\x7e]+$/.test(key) && !keys.has(key), check);
          keys.add(key);
        }
      }
    }
    return JSON.parse(source);
  });
}

/** The installer authenticates the inventory. Attestation independently binds
 * its raw manifest/receipt/base bytes and the host resolver's physical root.
 * A fresh resolver on each call also detects a supervisor restart mid-probe. */
export function verifyCloudV4Installation() {
  requireCloudV4Check(process.platform === "linux" && process.getuid?.() === 0 && process.geteuid?.() === 0, "root_ownership");
  requireCloudV4Check(process.arch === "x64", "base_compatibility");
  const marker = parseCloudV4Document(readCloudV4File(MARKER, 4096, "host_marker"), "host_marker");
  attemptV4("host_marker", () => validateCloudRuntimeMarker(marker));
  const descriptor = attemptV4("active_descriptor", () => parseCloudActiveRuntime(parseCloudV4Document(
    readCloudV4File("/run/zeros/active-runtime.json", 16384, "active_descriptor", 0o600), "active_descriptor")));
  const resolver = createCloudRuntimeResolver({ filesystem, isOwner: (_file, uid) => uid === 0,
    isEngine: () => false, isReadOnly: () => false, executable: () => process.execPath });
  const runtime = attemptV4("root_ownership", () => resolver.resolve());
  requireCloudV4Check(runtime.profile === "v4" && Object.keys(descriptor).every(key => runtime[key] === descriptor[key]), "active_descriptor");
  const manifestRaw = readCloudV4File(`${runtime.root}/manifest.json`, 64 * 1024 * 1024, "manifest_digest", 0o444);
  requireCloudV4Check(createHash("sha256").update(manifestRaw).digest("hex") === runtime.manifestSha256, "manifest_digest");
  const manifest = parseCloudV4Document(manifestRaw, "manifest_schema");
  requireCloudV4Check(manifest?.schema === "zeros.runtime-manifest/v1" && Array.isArray(manifest.files) &&
    manifest.files.length > 0 && manifest.files.length <= 250_000, "manifest_schema");
  let expandedBytes = 0, fileCount = 0;
  for (const file of manifest.files) {
    requireCloudV4Check(file && ["file", "dir", "symlink"].includes(file.type), "manifest_schema");
    if (file.type === "file") {
      requireCloudV4Check(Number.isSafeInteger(file.size) && file.size >= 0, "manifest_schema");
      expandedBytes += file.size; fileCount++;
    }
  }
  requireCloudV4Check(fileCount > 0 && expandedBytes > 0 && expandedBytes <= 4 * 1024 ** 3, "manifest_schema");
  const compatibility = readCloudV4File("/opt/zeros-bootstrap/compatibility.json", 256 * 1024, "base_compatibility", 0o444);
  requireCloudV4Check(`bc1-${createHash("sha256").update(compatibility).digest("hex")}` === runtime.baseCompatibilityId, "base_compatibility");
  const receiptRaw = readCloudV4File(`/srv/zeros/runtime-installs/${runtime.runtimeId}.json`, 4096, "installer_receipt", 0o600);
  requireCloudV4Check(createHash("sha256").update(receiptRaw).digest("hex") === runtime.installerReceiptSha256, "receipt_digest");
  const receipt = parseCloudV4Document(receiptRaw, "installer_receipt");
  requireCloudV4Check(exactKeys(receipt, ["archiveSha256", "baseCompatibilityId", "bootstrapVersion", "expandedBytes", "fileCount",
    "installedAt", "manifestSha256", "runtimeId", "schema"]) && receipt.schema === "zeros.runtime-install-receipt/v1" &&
    receipt.runtimeId === runtime.runtimeId && receipt.manifestSha256 === runtime.manifestSha256 &&
    receipt.baseCompatibilityId === runtime.baseCompatibilityId && receipt.bootstrapVersion === 1 &&
    hexDigest(receipt.archiveSha256) && receipt.expandedBytes === expandedBytes && receipt.fileCount === fileCount &&
    receiptTimestamp(receipt.installedAt), "installer_receipt");
  try { lstatSync(`${runtime.root}.incomplete`); throw new V4Failure("file_inventory"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  requireCloudV4Check(runtime.bootId === readOptional("/proc/sys/kernel/random/boot_id"), "boot_identity");
  return runtime;
}

export function cloudV4Identity(runtime) {
  return Object.fromEntries(CLOUD_V4_IDENTITY_FIELDS.map(key => [key, runtime[key]]));
}
export function cloudV4LaunchBinding() {
  const namespaces = Object.fromEntries(["mnt", "pid", "cgroup"].map(name => [name, namespace(name)]));
  const ticks = containerInitStartTicks();
  requireCloudV4Check(typeof ticks === "string" && /^[0-9]{1,32}$/.test(ticks) &&
    ["mnt", "pid", "net", "ipc", "uts", "cgroup", "user"].every(name =>
      new RegExp(`^${name}:\\[[0-9]{1,20}\\]$`).test(namespace(name) ?? "")), "namespace_binding");
  return { containerInitStartTicks: ticks, namespaces };
}
export function requireCloudV4AdmissionDirectory() {
  requireCloudV4Check(rootControlled(ADMISSION_DIRECTORY, false, true) &&
    (lstatSync(ADMISSION_DIRECTORY).mode & 0o7077) === 0, "root_ownership");
}

function verifyV4Link(root, file) {
  // Follow raw components before '..', just like the resolver. A final
  // realpath check alone would accept a link that leaves R and reenters it.
  let current = root, pending = file.slice(root.length + 1).split("/"), links = 0;
  while (pending.length) {
    requireCloudV4Check(pending.length <= 4096, "symlink_escape");
    const component = pending.shift();
    if (!component || component === ".") continue;
    if (component === "..") {
      requireCloudV4Check(current !== root, "symlink_escape");
      current = path.dirname(current);
      continue;
    }
    current = path.join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(current);
      requireCloudV4Check(target.length > 0 && Buffer.byteLength(target) <= 4096 &&
        !path.isAbsolute(target) && !/[\\\0\r\n]/.test(target) && ++links <= 64, "symlink_escape");
      pending = [...target.split("/"), ...pending];
      current = path.dirname(current);
    } else requireCloudV4Check(pending.length ? stat.isDirectory() : stat.isFile() || stat.isDirectory(), "symlink_escape");
  }
}

function verifyV4Tree(root) {
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    const file = pending.pop(), stat = lstatSync(file);
    requireCloudV4Check(++visited <= 250_002, "file_inventory");
    requireCloudV4Check(stat.uid === 0, "root_ownership");
    if (stat.isSymbolicLink()) {
      attemptV4("symlink_escape", () => verifyV4Link(root, file));
    } else {
      requireCloudV4Check((stat.mode & 0o7022) === 0, "file_mode");
      if (stat.isDirectory()) for (const entry of readdirSync(file)) pending.push(path.join(file, entry));
      else {
        requireCloudV4Check(stat.isFile(), "file_inventory");
        requireCloudV4Check(stat.nlink === 1, "hard_link");
      }
    }
  }
}

function verifyV4Helpers(runtime) {
  const toolchain = { node: runtime.node, bwrap: "/usr/bin/bwrap", setpriv: "/usr/bin/setpriv",
    supervisor: `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs` };
  const trusted = Object.fromEntries(Object.entries(toolchain).map(([name, file]) => [name, rootControlled(file, name !== "supervisor")]));
  requireCloudV4Check(Object.values(trusted).every(Boolean), "root_ownership");
  const deploymentTrusted = {};
  for (const [name, relative, executable] of [
    ["runtimeProfile", "cloud-runtime-profile.mjs"], ["engineLauncher", "cloud-engine-launcher.mjs"],
    ["engineView", "cloud-engine-view.mjs"], ["engineCgroup", "cloud-engine-cgroup.mjs"],
    ["runtimeLayout", "runtime-layout.json"], ["resourceInspector", "cgroup-resources.mjs"],
    ["resourceAdmission", "cloud-resource-admission.mjs"], ["setupProcess", "cloud-setup-process.mjs"],
    ["admissionConsumer", "consume-cloud-admission.mjs", true], ["previewLinkInstaller", "install-cloud-preview-links.mjs", true],
    ["githubCredentialInstaller", "install-cloud-github-credential.mjs", true], ["githubRefreshRequestHelper", "cloud-github-refresh-request.mjs", true],
    ["gitAskpass", "cloud-git-askpass.mjs", true], ["workerSupervisor", "cloud-worker-supervisor.mjs", true],
    ["setupHelper", "setup-cloud-workspace.mjs", true], ["attester", "attest-cloud-worker.mjs", true],
  ]) deploymentTrusted[name] = rootControlled(`${runtime.libRoot}/${relative}`, executable);
  deploymentTrusted.engineNamespace = rootControlled(runtime.engineNamespace, true);
  deploymentTrusted.launcher = rootControlled(runtime.startEngine, true);
  deploymentTrusted.engineQualification = rootControlled(`${runtime.workerRoot}/scripts/cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs`);
  requireCloudV4Check(Object.values(deploymentTrusted).every(Boolean), "root_ownership");
  requireCloudV4Check(rootControlled("/etc/apparmor.d/zeros-cloud-engine"), "apparmor");
  deploymentTrusted.engineAppArmor = true;
  attemptV4("root_ownership", () => verifyV4Tree(runtime.root));
  deploymentTrusted.runtimeTree = true;
  deploymentTrusted.admissionDirectory = true;
  return { trusted, deploymentTrusted };
}

function runV4Probe(runtime, helper, timeout, check) {
  const result = spawnSync(runtime.node, [helper, "--qualify"], { encoding: "utf8", timeout, maxBuffer: MAX_OUTPUT,
    env: { PATH: `${runtime.binRoot}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: "/root",
      ZEROS_ZSR_QUALIFICATION_UID: "10001", ZEROS_ZSR_QUALIFICATION_GID: "10001" } });
  requireCloudV4Check(result.error?.code !== "ETIMEDOUT", "timeout");
  requireCloudV4Check(!result.signal, "process_signal");
  requireCloudV4Check(!result.error && result.status === 0, check);
  return parseCloudV4Document(Buffer.from(result.stdout ?? ""), "diagnostic_missing");
}

function v4DelegatedResources(runtime, qualification) {
  const root = runtime.cgroupRoot;
  requireCloudV4Check(statfsSync(root).type === 0x63677270, "cgroup_controllers");
  for (let cursor = root; ; cursor = path.dirname(cursor)) {
    const stat = lstatSync(cursor);
    const kernelAncestor = ["/sys", "/sys/fs"].includes(cursor) && stat.uid === 65534 && statfsSync(cursor).type === 0x62656572;
    requireCloudV4Check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.uid === 0 || kernelAncestor) &&
      !(stat.mode & 0o022), "cgroup_controllers");
    if (cursor === "/") break;
  }
  for (const control of ["cgroup.controllers", "cgroup.subtree_control", "cgroup.procs"]) {
    const stat = lstatSync(`${root}/${control}`);
    requireCloudV4Check(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022), "cgroup_controllers");
  }
  requireCloudV4Check(readOptional(`${root}/cgroup.procs`) === "" &&
    ["cgroup.controllers", "cgroup.subtree_control"].every(name =>
      ["cpu", "memory", "pids"].every(controller => readOptional(`${root}/${name}`)?.split(/\s+/).includes(controller))), "cgroup_controllers");
  const resources = qualification?.identity?.resources;
  const relative = root.slice("/sys/fs/cgroup".length), leaf = resources?.hierarchy?.[0]?.path;
  requireCloudV4Check(typeof leaf === "string" && leaf.length === relative.length + 44 && leaf.startsWith(`${relative}/engine-`) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(leaf.slice(relative.length + 8)), "cgroup_controllers");
  requireCloudV4Check(resources?.finite === true &&
    [resources.memoryMax, resources.pidsMax].every(value => typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value))) &&
    typeof resources.cpuMax === "string" && /^[1-9][0-9]{0,15} [1-9][0-9]{0,15}$/.test(resources.cpuMax), "finite_resources");
  const storage = statfsSync(cloudComputerHostRepository(runtime), { bigint: true });
  const allocation = cloudAllocationCapacity({ isolated: false, membership: `0::${relative}\n`, read: readOptional,
    architecture: process.arch, availableCPUs: availableParallelism(), storageBytes: Number(storage.blocks * storage.bsize) });
  requireCloudV4Check([allocation.cpuMillicores, allocation.memoryBytes, allocation.storageBytes].every(value => Number.isSafeInteger(value) && value > 0), "finite_resources");
  return { finite: true, cpuMax: resources.cpuMax, memoryMax: resources.memoryMax, pidsMax: resources.pidsMax, allocation };
}

export function validV4Diagnostic(value) {
  return exactKeys(value, ["schema", "component", "stage", "ok", "exitCode", "timedOut", "failedChecks", ...(value?.timings === undefined ? [] : ["timings"])]) &&
    (value.timings === undefined || parseSetupTimings(value.timings) !== undefined) &&
    value.schema === "zeros.diagnostic/v1" && value.component === "attester" && V4_STAGES.has(value.stage) &&
    typeof value.ok === "boolean" && value.exitCode === (value.ok ? 0 : 1) && typeof value.timedOut === "boolean" &&
    Array.isArray(value.failedChecks) && value.failedChecks.length <= 32 && new Set(value.failedChecks).size === value.failedChecks.length &&
    value.failedChecks.every(check => V4_CHECKS.has(check)) && (value.ok ? value.failedChecks.length === 0 : value.failedChecks.length > 0) &&
    value.timedOut === value.failedChecks.includes("timeout");
}

function attestV4CloudWorker() {
  let stage = "validate_input";
  const timings = setupTimingClock("attester_preflight");
  let finished;
  const next = value => { finished?.(); finished = timings.start(value); };
  try {
    requireCloudV4Check(process.platform === "linux" && process.geteuid?.() === 0, "root_ownership");
    stage = "lock";
    next(stage);
    requireCloudV4AdmissionDirectory();
    if (process.argv[2] !== LOCKED_ARGUMENT) {
      requireCloudV4Check(process.argv.length === 2, "input_schema");
      const token = path.join(ADMISSION_DIRECTORY, `.attest-lock-${process.pid}-${randomBytes(8).toString("hex")}`);
      let child;
      try {
        writeFileSync(token, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
        child = spawnSync("/usr/bin/flock", ["--no-fork", "--nonblock", "--conflict-exit-code", "75", ENGINE_LOCK,
          process.execPath, realpathSync(fileURLToPath(import.meta.url)), LOCKED_ARGUMENT, token],
        { encoding: "utf8", timeout: 300_000, maxBuffer: MAX_OUTPUT, env: { PATH: "/usr/bin:/bin", HOME: "/root" } });
      } finally { rmSync(token, { force: true }); }
      requireCloudV4Check(child.error?.code !== "ETIMEDOUT", "timeout");
      requireCloudV4Check(!child.signal, "process_signal");
      requireCloudV4Check(child.status !== 75, "lock_busy");
      requireCloudV4Check(!child.error, "diagnostic_missing");
      const lines = (child.stdout ?? "").trim().split("\n");
      const diagnostic = attemptV4("diagnostic_missing", () => JSON.parse(lines.at(-1)));
      requireCloudV4Check(validV4Diagnostic(diagnostic) && child.status === diagnostic.exitCode, "diagnostic_missing");
      if (diagnostic.ok) {
        requireCloudV4Check(lines.length === 2, "diagnostic_missing");
        const report = attemptV4("diagnostic_missing", () => JSON.parse(lines[0]));
        requireCloudV4Check(report?.version === 1 && report.profile === "zeros-cloud-worker-v4" && report.qualified === true, "diagnostic_missing");
        process.stdout.write(`${JSON.stringify(report)}\n`);
      }
      process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
      process.exitCode = diagnostic.exitCode;
      return;
    }
    requireCloudV4Check(process.argv.length === 4 && typeof process.argv[3] === "string" &&
      path.dirname(process.argv[3]) === ADMISSION_DIRECTORY, "input_schema");
    const token = readCloudV4File(process.argv[3], 65, "input_schema", 0o600);
    requireCloudV4Check(hexDigest(token.toString("utf8").trim()), "input_schema");
    unlinkSync(process.argv[3]);
    // Hold the engine lock before invalidating any prior unconsumed authority.
    rmSync(ADMISSION_PROOF, { force: true });
    stage = "verify_tree";
    next(stage);
    const runtime = verifyCloudV4Installation(), binding = cloudV4LaunchBinding();
    const helpers = verifyV4Helpers(runtime);
    stage = "qualify_engine";
    next(stage);
    const qualification = runV4Probe(runtime, runtime.helpers.launcher, 180_000, "containment_smoke");
    requireCloudV4Check(qualification?.identity?.hostUid === 10003 && qualification?.identity?.namespaceUid === 0, "uid_map");
    requireCloudV4Check(cloudRuntimeProcessSecurityQualified(4, null, qualification?.identity), "seccomp");
    requireCloudV4Check(qualification?.secure === true && qualification?.identity?.secure === true &&
      ["workload", "capture", "humanServices", "actorTools"].every(name => qualification[name]?.secure === true), "containment_smoke");
    const resources = attemptV4("cgroup_controllers", () => v4DelegatedResources(runtime, qualification));
    stage = "run_setup";
    next(stage);
    const setup = runV4Probe(runtime, runtime.helpers.setupProcess, 30_000, "setup_exit");
    requireCloudV4Check(["secure", "unprivileged", "detachedDescendantsRetired", "timeoutRetired"].every(name => setup?.[name] === true), "setup_exit");
    stage = "publish_proof";
    next(stage);
    const current = verifyCloudV4Installation();
    requireCloudV4Check([...CLOUD_V4_IDENTITY_FIELDS, "cgroupRoot"].every(key => current[key] === runtime[key]), "active_descriptor");
    requireCloudV4Check(JSON.stringify(cloudV4LaunchBinding()) === JSON.stringify(binding), "namespace_binding");
    // Project only fixed fields. Probe stdout/stderr may include workload data.
    const report = { version: 1, profile: "zeros-cloud-worker-v4", qualified: true, runtime: cloudV4Identity(runtime), helpers, resources,
      qualification: { secure: true, identity: { secure: true, hostUid: 10003, namespaceUid: 0, noNewPrivs: 1, seccompMode: 2 },
        workload: { secure: true }, capture: { secure: true }, humanServices: { secure: true }, actorTools: { secure: true } },
      setupQualification: { secure: true, unprivileged: true, detachedDescendantsRetired: true, timeoutRetired: true } };
    const serialized = `${JSON.stringify(report)}\n`;
    const proof = { version: 2, profile: report.profile, qualifiedAtMs: Date.now(), reportSha256: createHash("sha256").update(serialized).digest("hex"),
      ...report.runtime, ...binding };
    const temporary = `${ADMISSION_PROOF}.${process.pid}.tmp`;
    attemptV4("pointer_publish", () => {
      try {
        writeFileSync(temporary, `${JSON.stringify(proof)}\n`, { flag: "wx", mode: 0o400 });
        chmodSync(temporary, 0o400);
        renameSync(temporary, ADMISSION_PROOF);
      } finally { rmSync(temporary, { force: true }); }
    });
    process.stdout.write(serialized);
    finished?.();
    process.stdout.write(`${JSON.stringify({ ...cloudV4Diagnostic(null, "done"), timings: timings.snapshot() })}\n`);
  } catch (error) {
    finished?.("failed");
    process.stdout.write(`${JSON.stringify({ ...cloudV4Diagnostic(error ?? {}, stage), timings: timings.snapshot() })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (usesCloudV4Attestation()) attestV4CloudWorker();
  else attestLegacyCloudWorker();
}
