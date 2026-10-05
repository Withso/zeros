#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCloudHostRuntimeProfile } from "./cloud-runtime-profile.mjs";
import {
  CLOUD_V4_IDENTITY_FIELDS,
  cloudV4Diagnostic,
  cloudV4LaunchBinding,
  parseCloudV4Document,
  readCloudV4File,
  requireCloudV4AdmissionDirectory,
  requireCloudV4Check,
  usesCloudV4Attestation,
  verifyCloudV4Installation,
} from "./attest-cloud-worker.mjs";

const DIRECTORY = "/run/zeros";
const PROOF = path.join(DIRECTORY, "cloud-worker-admission.json");
const MARKER = "/etc/zeros/cloud-worker.json";
const BUILD = "/etc/zeros/image-build.json";
const MAX_PROOF_BYTES = 16 * 1024;
const MAX_PROOF_AGE_MS = 5 * 60 * 1000;

function consumeLegacyCloudAdmission() {
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
  let proof;
  const descriptor = openSync(
    consumed,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(descriptor);
    const current = lstatSync(consumed);
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      current.isSymbolicLink() ||
      stat.dev !== current.dev ||
      stat.ino !== current.ino ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 2 ||
      stat.size > MAX_PROOF_BYTES ||
      realpathSync(consumed) !== consumed
    ) {
      fail("the runtime qualification proof is unsafe");
    }
    try {
      proof = JSON.parse(readFileSync(descriptor, "utf8"));
    } catch {
      fail("the runtime qualification proof is malformed");
    }
  } finally {
    closeSync(descriptor);
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
    proof.profile !== readCloudHostRuntimeProfile().profile ||
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
}

function consumeV4CloudAdmission() {
  let failure = null, renamed = false;
  const consumed = path.join(DIRECTORY, `.cloud-worker-admission.${process.pid}.consumed`);
  try {
    requireCloudV4Check(process.platform === "linux" && process.getuid?.() === 0 && process.geteuid?.() === 0, "root_ownership");
    requireCloudV4AdmissionDirectory();
    // Rename before validation: a rejected, stale or replayed proof never gets
    // another attempt, and concurrent consumers cannot both acquire it.
    try { renameSync(PROOF, consumed); renamed = true; }
    catch { requireCloudV4Check(false, "launch_proof"); }
    const proof = parseCloudV4Document(readCloudV4File(consumed, MAX_PROOF_BYTES, "launch_proof", 0o400), "launch_proof");
    const keys = ["version", "profile", "qualifiedAtMs", "reportSha256", ...CLOUD_V4_IDENTITY_FIELDS, "containerInitStartTicks", "namespaces"];
    requireCloudV4Check(proof !== null && typeof proof === "object" && !Array.isArray(proof) &&
      Object.keys(proof).sort().join("\0") === keys.sort().join("\0") && proof.version === 2 &&
      proof.profile === "zeros-cloud-worker-v4" && Number.isSafeInteger(proof.qualifiedAtMs) &&
      Date.now() - proof.qualifiedAtMs >= -5_000 && Date.now() - proof.qualifiedAtMs <= MAX_PROOF_AGE_MS &&
      typeof proof.reportSha256 === "string" && proof.reportSha256.length === 64 && /^[a-f0-9]+$/.test(proof.reportSha256), "launch_proof");
    const runtime = verifyCloudV4Installation(), binding = cloudV4LaunchBinding();
    requireCloudV4Check(CLOUD_V4_IDENTITY_FIELDS.every(key => proof[key] === runtime[key]) &&
      proof.containerInitStartTicks === binding.containerInitStartTicks && proof.namespaces !== null &&
      typeof proof.namespaces === "object" && !Array.isArray(proof.namespaces) &&
      Object.keys(proof.namespaces).sort().join(",") === "cgroup,mnt,pid" &&
      Object.keys(binding.namespaces).every(key => proof.namespaces[key] === binding.namespaces[key]), "launch_proof");
  } catch (error) { failure = error ?? {}; }
  finally {
    if (renamed) {
      try { rmSync(consumed, { force: true }); }
      catch (error) { failure = error ?? {}; }
    }
  }
  const diagnostic = cloudV4Diagnostic(failure, "consume_proof");
  process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
  process.exitCode = diagnostic.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (usesCloudV4Attestation()) consumeV4CloudAdmission();
  else consumeLegacyCloudAdmission();
}
