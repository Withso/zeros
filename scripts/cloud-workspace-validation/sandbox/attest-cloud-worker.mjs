#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
const ENGINE = "/opt/zeros";
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
      env: { PATH: "/opt/zeros-runtime/bin:/usr/bin:/bin", HOME: "/root" },
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
    "/opt/zeros-runtime/lib/zeros/cloud-runtime-profile.mjs",
  ),
  ...(isolated
    ? {
        engineLauncher: rootControlled(
          "/opt/zeros-runtime/lib/zeros/cloud-engine-launcher.mjs",
        ),
        engineView: rootControlled(
          "/opt/zeros-runtime/lib/zeros/cloud-engine-view.mjs",
        ),
        engineCgroup: rootControlled(
          "/opt/zeros-runtime/lib/zeros/cloud-engine-cgroup.mjs",
        ),
        engineNamespace: rootControlled(
          "/opt/zeros-runtime/cloud-engine-namespace",
          true,
        ),
        engineAppArmor: rootControlled(
          "/opt/zeros-runtime/lib/zeros/zeros-cloud-engine.apparmor",
        ),
        runtimeTree: rootControlledTree("/opt/zeros-runtime"),
        engineQualification: rootControlled(
          "/opt/zeros/scripts/cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs",
        ),
      }
    : {}),
  supervisorRecovery: rootControlled(
    "/opt/zeros-runtime/lib/zeros/ensure-cloud-worker-supervisor.mjs",
  ),
  runtimeLayout:
    rootControlled("/opt/zeros-runtime/lib/zeros/runtime-layout.json") &&
    JSON.stringify(build.runtimeLayout) === JSON.stringify(runtimeLayout),
  resourceInspector: rootControlled(
    "/opt/zeros-runtime/lib/zeros/cgroup-resources.mjs",
  ),
  resourceAdmission: rootControlled(
    "/opt/zeros-runtime/lib/zeros/cloud-resource-admission.mjs",
  ),
  imageContract: rootControlled(
    "/opt/zeros-runtime/lib/zeros/image-build-contract.mjs",
  ),
  setupProcess: rootControlled(
    "/opt/zeros-runtime/lib/zeros/cloud-setup-process.mjs",
  ),
  sourceIntegrity:
    originMatches &&
    (build.version === 1 || cloudImageBuildMatchesInstallation(build, ENGINE)),
  marker: rootControlled(MARKER),
  build: rootControlled(BUILD),
  engine: rootControlled(ENGINE, false, true),
  engineTree: rootControlledTree(ENGINE),
  launcher: rootControlled("/opt/zeros-runtime/bin/start-engine.sh", true),
  admissionConsumer: rootControlled(
    "/opt/zeros-runtime/lib/zeros/consume-cloud-admission.mjs",
    true,
  ),
  previewLinkInstaller: rootControlled(
    "/opt/zeros-runtime/lib/zeros/install-cloud-preview-links.mjs",
    true,
  ),
  githubCredentialInstaller: rootControlled(
    "/opt/zeros-runtime/lib/zeros/install-cloud-github-credential.mjs",
    true,
  ),
  githubRefreshRequestHelper: rootControlled(
    "/opt/zeros-runtime/lib/zeros/cloud-github-refresh-request.mjs",
    true,
  ),
  gitAskpass: rootControlled(
    "/opt/zeros-runtime/lib/zeros/cloud-git-askpass.mjs",
    true,
  ),
  workerSupervisor: rootControlled(
    "/opt/zeros-runtime/lib/zeros/cloud-worker-supervisor.mjs",
    true,
  ),
  setupHelper: rootControlled(
    "/opt/zeros-runtime/lib/zeros/setup-cloud-workspace.mjs",
    true,
  ),
  attester: rootControlled(
    "/opt/zeros-runtime/lib/zeros/attest-cloud-worker.mjs",
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
    ? ["/opt/zeros-runtime/lib/zeros/cloud-engine-launcher.mjs", "--qualify"]
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
      ["/opt/zeros-runtime/lib/zeros/cloud-setup-process.mjs", "--qualify"],
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
      "/opt/zeros",
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
