#!/usr/bin/env node

import {
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOUD_V4_IDENTITY_FIELDS,
  cloudV4Diagnostic,
  cloudV4LaunchBinding,
  parseCloudV4Document,
  readCloudV4File,
  requireCloudV4AdmissionDirectory,
  requireCloudV4Check,
  verifyCloudV4Installation,
} from "./attest-cloud-worker.mjs";

const DIRECTORY = "/run/zeros";
const PROOF = path.join(DIRECTORY, "cloud-worker-admission.json");
const MAX_PROOF_BYTES = 16 * 1024;
const MAX_PROOF_AGE_MS = 5 * 60 * 1000;

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
  consumeV4CloudAdmission();
}
