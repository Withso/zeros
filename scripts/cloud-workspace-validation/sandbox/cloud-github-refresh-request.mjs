#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUEST_FILE = "/run/zeros/github-credential-refresh.json";
const MAX_DOCUMENT_BYTES = 8 * 1024;
const METHODS = new Set(["gh-cli", "github-app", "pat"]);

function exactKeys(value, expected) {
  return Object.keys(value).sort().join("\0") === expected.sort().join("\0");
}

function validateDirectory(file, expectedUid) {
  const directory = path.dirname(file);
  const metadata = lstatSync(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== expectedUid ||
    (metadata.mode & 0o777) !== 0o700 ||
    realpathSync(directory) !== directory
  ) {
    throw new Error("cloud GitHub refresh directory is unsafe");
  }
}

function parseRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cloud GitHub refresh request is invalid");
  }
  if (
    !exactKeys(value, [
      "audience",
      "generation",
      "method",
      "ownerSubjectSha256",
      "reason",
      "requestedAt",
      "version",
    ]) ||
    value.version !== 1 ||
    value.audience !== "zeros-cloud-github-refresh-v1" ||
    typeof value.generation !== "string" ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(value.generation) ||
    !Number.isSafeInteger(value.requestedAt) ||
    value.requestedAt <= 0 ||
    typeof value.ownerSubjectSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.ownerSubjectSha256) ||
    !METHODS.has(value.method) ||
    value.reason !== "credential-invalid"
  ) {
    throw new Error("cloud GitHub refresh request is invalid");
  }
  return {
    version: 1,
    audience: "zeros-cloud-github-refresh-v1",
    generation: value.generation,
    requestedAt: value.requestedAt,
    ownerSubjectSha256: value.ownerSubjectSha256,
    method: value.method,
    reason: "credential-invalid",
  };
}

function readPhysicalRequest(file, expectedUid) {
  const metadata = lstatSync(file);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== expectedUid ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size < 2 ||
    metadata.size > MAX_DOCUMENT_BYTES ||
    realpathSync(file) !== file
  ) {
    throw new Error("cloud GitHub refresh request is unsafe");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("cloud GitHub refresh request is invalid");
  }
  return parseRequest(parsed);
}

export function readCloudGithubRefreshRequest(
  file = REQUEST_FILE,
  options = {},
) {
  const expectedUid = options.expectedUid ?? 0;
  if (
    !path.isAbsolute(file) ||
    !Number.isInteger(expectedUid) ||
    expectedUid < 0
  ) {
    throw new Error("cloud GitHub refresh helper options are invalid");
  }
  validateDirectory(file, expectedUid);
  try {
    return readPhysicalRequest(file, expectedUid);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Consume only the generation the caller actually refreshed. Renaming to a
 * private quarantine path first prevents an engine write racing acknowledgement
 * from being unlinked. A stale request is restored with link(2), whose EEXIST
 * behavior preserves a newer engine request without any overwrite window. */
export function acknowledgeCloudGithubRefreshRequest(
  file,
  generation,
  options = {},
) {
  const expectedUid = options.expectedUid ?? 0;
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(generation)) {
    throw new Error("cloud GitHub refresh generation is invalid");
  }
  validateDirectory(file, expectedUid);
  const quarantine = path.join(
    path.dirname(file),
    `.github-credential-refresh.ack.${randomBytes(12).toString("hex")}`,
  );
  try {
    renameSync(file, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  let acknowledged = false;
  try {
    chmodSync(quarantine, 0o600);
    const current = readPhysicalRequest(quarantine, expectedUid);
    acknowledged = current.generation === generation;
    if (!acknowledged) {
      try {
        linkSync(quarantine, file);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    return acknowledged;
  } finally {
    try {
      unlinkSync(quarantine);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function main() {
  if (process.getuid?.() !== 0) {
    throw new Error("cloud GitHub refresh helper requires root");
  }
  const operation = process.argv[2];
  if (operation === "read" && process.argv.length === 3) {
    process.stdout.write(
      `${JSON.stringify(readCloudGithubRefreshRequest(REQUEST_FILE))}\n`,
    );
    return;
  }
  if (operation === "ack" && process.argv.length === 3) {
    const generation = process.env.ZEROS_CLOUD_GITHUB_REFRESH_GENERATION;
    if (!generation) throw new Error("cloud GitHub refresh generation is missing");
    const acknowledged = acknowledgeCloudGithubRefreshRequest(
      REQUEST_FILE,
      generation,
    );
    process.stdout.write(acknowledged ? "acknowledged\n" : "stale\n");
    return;
  }
  throw new Error("cloud GitHub refresh helper operation is invalid");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch {
    process.stderr.write("cloud GitHub refresh request rejected\n");
    process.exitCode = 1;
  }
}
