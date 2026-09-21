import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";

const CONTRACT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "scripts/zsr-qualification/pin.json",
  "scripts/cloud-workspace-validation/sandbox/cloud-worker.json",
  "scripts/cloud-workspace-validation/sandbox/runtime-layout.json",
];
const ARTIFACTS = [
  "dist-engine/cli.js",
  "dist-engine/design-capture-worker.js",
  "binaries/zsr-supervisor.mjs",
];
const SHA256 = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
function command(file, args, extraEnv = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: "/opt/zeros-runtime/bin:/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      ...extraEnv,
    },
  });
  if (result.status !== 0)
    throw new Error("Image source or inventory verification failed");
  return result.stdout.trim();
}
export function cloudImageSourceIdentity(engine) {
  const commit = command("/usr/bin/git", ["-C", engine, "rev-parse", "HEAD"]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
    throw new Error("Invalid image source commit");
  // Git's normal index is a mutable cache: stat refresh can rewrite it during
  // attestation, and assume-unchanged/skip-worktree flags can hide modified
  // source. Reconstruct a private index from the pinned commit instead. This
  // also permits immutable runtime images to omit .git/index altogether.
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-image-index-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(directory, "index") };
    const prefix = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.sparseCheckout=false", "-C", engine];
    command("/usr/bin/git", [...prefix, "read-tree", commit], env);
    command("/usr/bin/git", [...prefix, "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none",
      "--exit-code", "--quiet", commit, "--"], env);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  return {
    commit,
    contractSha256: hash(
      CONTRACT_FILES.map(
        (file) => `${file}\0${readFileSync(path.join(engine, file))}\0`,
      ).join(""),
    ),
  };
}
export function cloudImageArtifactHashes(engine) {
  return Object.fromEntries(
    ARTIFACTS.map((file) => [
      file,
      hash(readFileSync(path.join(engine, file))),
    ]),
  );
}
export function readCloudImageNativeInventory() {
  const packages = command("/usr/bin/dpkg-query", [
    "-W",
    "-f=${Package}\t${Version}\n",
  ])
    .split("\n")
    .sort()
    .join("\n");
  return {
    osReleaseSha256: hash(readFileSync("/etc/os-release")),
    packageInventorySha256: hash(packages),
    nodeSha256: hash(readFileSync(process.execPath)),
  };
}
export function cloudImageBaseOrigin(reference, inventory) {
  if (reference === "native-linux") {
    const fields = ["osReleaseSha256", "packageInventorySha256", "nodeSha256"];
    if (
      !inventory ||
      fields.some((field) => !SHA256.test(inventory[field] ?? ""))
    )
      throw new Error("Invalid native image base inventory");
    const baseOrigin = {
      kind: "native-linux",
      ...Object.fromEntries(fields.map((field) => [field, inventory[field]])),
    };
    return {
      baseImage: `native-linux@sha256:${hash(JSON.stringify(baseOrigin))}`,
      baseOrigin,
    };
  }
  if (
    typeof reference !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/:+-]*@sha256:[a-f0-9]{64}$/.test(reference)
  )
    throw new Error("Invalid immutable image base reference");
  return { baseImage: reference, baseOrigin: { kind: "oci", reference } };
}
export function cloudImageBuildMatchesInstallation(build, engine) {
  try {
    if (
      build?.version !== 2 ||
      !build.source ||
      !build.artifacts ||
      Object.keys(build.artifacts).sort().join("\0") !==
        [...ARTIFACTS].sort().join("\0")
    )
      return false;
    const source = cloudImageSourceIdentity(engine);
    const artifacts = cloudImageArtifactHashes(engine);
    return (
      build.source.commit === source.commit &&
      build.source.contractSha256 === source.contractSha256 &&
      ARTIFACTS.every((file) => build.artifacts[file] === artifacts[file])
    );
  } catch {
    return false;
  }
}
