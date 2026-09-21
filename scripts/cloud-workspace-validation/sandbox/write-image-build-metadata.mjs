#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import runtimeLayout from "./runtime-layout.json" with { type: "json" };
import { readCloudHostRuntimeProfile } from "./cloud-runtime-profile.mjs";
import {
  cloudImageSourceIdentity,
  cloudImageArtifactHashes,
  cloudImageBaseOrigin,
  readCloudImageNativeInventory,
} from "./image-build-contract.mjs";

function fail(message) {
  process.stderr.write(`[image-metadata] ${message}\n`);
  process.exit(1);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function command(file, args) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    env: { PATH: "/opt/zeros-runtime/bin:/usr/bin:/bin" },
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`${path.basename(file)} failed while recording image metadata`);
  }
  return result.stdout.trim();
}

const [
  output,
  baseImage,
  repositoryUrl,
  repositoryRef,
  engineDirectory,
  imageContractSha256,
] = process.argv.slice(2);
if (
  !output ||
  !path.isAbsolute(output) ||
  !baseImage ||
  (baseImage !== "native-linux" && !/@sha256:[a-f0-9]{64}$/.test(baseImage)) ||
  !repositoryUrl ||
  !repositoryRef ||
  !engineDirectory ||
  !path.isAbsolute(engineDirectory) ||
  !/^[a-f0-9]{64}$/.test(imageContractSha256 ?? "")
) {
  fail("invalid metadata arguments");
}
const engine = realpathSync(engineDirectory);
const engineStat = lstatSync(engine);
if (
  !engineStat.isDirectory() ||
  engineStat.uid !== 0 ||
  (engineStat.mode & 0o022) !== 0
) {
  fail("engine installation is not root-controlled");
}

const pin = JSON.parse(
  readFileSync(path.join(engine, "scripts/zsr-qualification/pin.json"), "utf8"),
);
const selectedPackages = [
  "acl",
  "apparmor",
  "bubblewrap",
  "busybox-static",
  "crun",
  "git",
  "git-lfs",
  "gnupg",
  "inotify-tools",
  "openssh-sftp-server",
  "podman",
  "ripgrep",
  "slirp4netns",
  "socat",
  "uidmap",
  "util-linux",
];
const packageVersions = Object.fromEntries(
  selectedPackages.map((name) => [
    name,
    command("/usr/bin/dpkg-query", ["-W", "-f=${Version}", name]),
  ]),
);
const metadata = {
  version: 2,
  profile: readCloudHostRuntimeProfile().profile,
  ...cloudImageBaseOrigin(
    baseImage,
    baseImage === "native-linux" ? readCloudImageNativeInventory() : undefined,
  ),
  architecture: process.arch,
  runtimeLayout,
  imageContractSha256,
  source: {
    repositoryUrlSha256: sha256(repositoryUrl),
    ref: repositoryRef,
    ...cloudImageSourceIdentity(engine),
  },
  artifacts: cloudImageArtifactHashes(engine),
  zsr: {
    package: pin.package,
    version: pin.version,
    upstreamCommit: pin.upstreamCommit,
    patchSha256: pin.patchSha256,
  },
  packages: packageVersions,
};

mkdirSync(path.dirname(output), { recursive: true, mode: 0o755 });
writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o444,
});
chmodSync(output, 0o444);
