#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const DIRECTORY = "/run/zeros";
const PROOF = path.join(DIRECTORY, "cloud-worker-admission.json");
const MARKER = "/etc/zeros/cloud-worker.json";
const BUILD = "/etc/zeros/image-build.json";
const MAX_PROOF_BYTES = 16 * 1024;
const MAX_PROOF_AGE_MS = 5 * 60 * 1000;

function fail(message) {
  throw new Error(message);
}

process.on("uncaughtException", (error) => {
  const message =
    error instanceof Error ? error.message.slice(0, 500) : "admission failed";
  process.stderr.write(`[cloud-admission] ${message}\n`);
  process.exit(1);
});

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function namespace(name) {
  try {
    return readlinkSync(`/proc/self/ns/${name}`);
  } catch {
    return null;
  }
}

function readOptional(file) {
  try {
    return readFileSync(file, "utf8").trim();
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

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

if (process.platform !== "linux" || process.geteuid?.() !== 0) {
  fail("a root Linux coordinator is required");
}

let directoryStat;
try {
  directoryStat = lstatSync(DIRECTORY);
} catch {
  fail("a fresh runtime qualification is required");
}
if (
  !directoryStat.isDirectory() ||
  directoryStat.isSymbolicLink() ||
  directoryStat.uid !== 0 ||
  (directoryStat.mode & 0o077) !== 0 ||
  realpathSync(DIRECTORY) !== DIRECTORY
) {
  fail("the runtime qualification directory is unsafe");
}

const consumed = path.join(
  DIRECTORY,
  `.cloud-worker-admission.${process.pid}.consumed`,
);
try {
  renameSync(PROOF, consumed);
} catch {
  fail("a fresh one-use runtime qualification is required");
}

try {
  const stat = lstatSync(consumed);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    stat.size < 2 ||
    stat.size > MAX_PROOF_BYTES ||
    realpathSync(consumed) !== consumed
  ) {
    fail("the runtime qualification proof is unsafe");
  }
  let proof;
  try {
    proof = JSON.parse(readFileSync(consumed, "utf8"));
  } catch {
    fail("the runtime qualification proof is malformed");
  }
  if (
    !exactKeys(proof, [
      "bootId",
      "buildSha256",
      "containerInitStartTicks",
      "markerSha256",
      "namespaces",
      "profile",
      "qualifiedAtMs",
      "reportSha256",
      "version",
    ]) ||
    !exactKeys(proof.namespaces, ["cgroup", "mnt", "pid"]) ||
    proof.version !== 1 ||
    proof.profile !== "zeros-cloud-worker-v1" ||
    !Number.isSafeInteger(proof.qualifiedAtMs) ||
    Date.now() - proof.qualifiedAtMs < -5_000 ||
    Date.now() - proof.qualifiedAtMs > MAX_PROOF_AGE_MS ||
    !/^[a-f0-9]{64}$/.test(proof.reportSha256 ?? "") ||
    proof.markerSha256 !== sha256File(MARKER) ||
    proof.buildSha256 !== sha256File(BUILD) ||
    proof.bootId !== readOptional("/proc/sys/kernel/random/boot_id") ||
    proof.containerInitStartTicks !== containerInitStartTicks() ||
    proof.namespaces.mnt !== namespace("mnt") ||
    proof.namespaces.pid !== namespace("pid") ||
    proof.namespaces.cgroup !== namespace("cgroup")
  ) {
    fail("the runtime qualification proof is stale or invalid");
  }
} finally {
  rmSync(consumed, { force: true });
}

process.stdout.write("[cloud-admission] qualified runtime proof consumed\n");
