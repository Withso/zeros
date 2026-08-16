#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT = "/run/zeros/github-credential.json";
const MAX_ENCODED_BYTES = 32 * 1024;
const MAX_TOKEN_BYTES = 4 * 1024;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 60_000;
const MIN_REMAINING_MS = 5_000;
const METHODS = new Set(["gh-cli", "github-app", "pat"]);

function exactKeys(value, expected) {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function optionalString(value, maxBytes, pattern) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\0\r\n]/.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    return null;
  }
  return value;
}

function parseCredential(value, method, now, documentExpiresAt) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const app = method === "github-app";
  const expected = [
    "method",
    "accessToken",
    "gitHost",
    "gitHttpUsername",
    ...(value.login === undefined ? [] : ["login"]),
    ...(app ? ["expiresAtMs"] : []),
    ...(app && value.variantKey !== undefined ? ["variantKey"] : []),
  ];
  if (!exactKeys(value, expected) || value.method !== method) return null;
  const accessToken = optionalString(value.accessToken, MAX_TOKEN_BYTES);
  const login = optionalString(value.login, 100, /^[A-Za-z0-9-]+$/);
  const variantKey = optionalString(
    value.variantKey,
    253,
    /^[A-Za-z0-9.-]+$/,
  );
  if (
    accessToken === null ||
    accessToken === undefined ||
    login === null ||
    variantKey === null ||
    value.gitHost !== "github.com" ||
    value.gitHttpUsername !== "x-access-token"
  ) {
    return null;
  }
  if (
    app &&
    (!Number.isSafeInteger(value.expiresAtMs) ||
      value.expiresAtMs - now < MIN_REMAINING_MS ||
      value.expiresAtMs > documentExpiresAt)
  ) {
    return null;
  }
  return {
    method,
    accessToken,
    gitHost: "github.com",
    gitHttpUsername: "x-access-token",
    ...(login ? { login } : {}),
    ...(app ? { expiresAtMs: value.expiresAtMs } : {}),
    ...(variantKey ? { variantKey } : {}),
  };
}

export function cloudOwnerSubjectSha256(ownerSubject) {
  if (
    typeof ownerSubject !== "string" ||
    ownerSubject.length < 1 ||
    ownerSubject.length > 512 ||
    ownerSubject !== ownerSubject.trim() ||
    /[\0\r\n]/.test(ownerSubject)
  ) {
    throw new Error("cloud GitHub credential owner is invalid");
  }
  return createHash("sha256").update(ownerSubject, "utf8").digest("hex");
}

export function parseCloudGithubCredentialPayload(
  encoded,
  { now = Date.now(), expectedOwnerSubjectSha256 } = {},
) {
  if (
    typeof encoded !== "string" ||
    encoded.length < 2 ||
    Buffer.byteLength(encoded, "utf8") > MAX_ENCODED_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    !Number.isSafeInteger(now) ||
    typeof expectedOwnerSubjectSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedOwnerSubjectSha256)
  ) {
    throw new Error("cloud GitHub credential payload is invalid");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) {
    decoded.fill(0);
    throw new Error("cloud GitHub credential payload is not canonical");
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } finally {
    decoded.fill(0);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !exactKeys(parsed, [
      "audience",
      "credential",
      "expiresAt",
      "generation",
      "issuedAt",
      "method",
      "ownerSubjectSha256",
      "version",
    ]) ||
    parsed.version !== 1 ||
    parsed.audience !== "zeros-cloud-github-credential-v1" ||
    typeof parsed.generation !== "string" ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(parsed.generation) ||
    !Number.isSafeInteger(parsed.issuedAt) ||
    !Number.isSafeInteger(parsed.expiresAt) ||
    parsed.issuedAt > now + CLOCK_SKEW_MS ||
    parsed.expiresAt - now < MIN_REMAINING_MS ||
    parsed.expiresAt <= parsed.issuedAt ||
    parsed.expiresAt - parsed.issuedAt > MAX_LIFETIME_MS + CLOCK_SKEW_MS ||
    parsed.ownerSubjectSha256 !== expectedOwnerSubjectSha256 ||
    !METHODS.has(parsed.method)
  ) {
    throw new Error("cloud GitHub credential document is invalid");
  }
  const credential = parseCredential(
    parsed.credential,
    parsed.method,
    now,
    parsed.expiresAt,
  );
  if (parsed.credential !== null && credential === null) {
    throw new Error("cloud GitHub credential working copy is invalid");
  }
  return {
    version: 1,
    audience: "zeros-cloud-github-credential-v1",
    generation: parsed.generation,
    issuedAt: parsed.issuedAt,
    expiresAt: parsed.expiresAt,
    ownerSubjectSha256: parsed.ownerSubjectSha256,
    method: parsed.method,
    credential,
  };
}

function assertPrivateDirectory(directory, expectedUid) {
  if (!path.isAbsolute(directory) || realpathSync(directory) !== directory) {
    throw new Error("cloud GitHub credential runtime directory is not canonical");
  }
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("cloud GitHub credential runtime directory is not private");
  }
}

function assertReplaceableOutput(output, expectedUid) {
  if (!existsSync(output)) return;
  const stat = lstatSync(output);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(output) !== output
  ) {
    throw new Error("existing cloud GitHub credential is not replaceable");
  }
}

export function installCloudGithubCredentialPayload(
  encoded,
  {
    output = OUTPUT,
    expectedUid = 0,
    expectedOwnerSubjectSha256,
    now = Date.now(),
  } = {},
) {
  if (
    !path.isAbsolute(output) ||
    !Number.isInteger(expectedUid) ||
    expectedUid < 0
  ) {
    throw new Error("cloud GitHub credential installer options are invalid");
  }
  const directory = path.dirname(output);
  assertPrivateDirectory(directory, expectedUid);
  assertReplaceableOutput(output, expectedUid);
  const document = parseCloudGithubCredentialPayload(encoded, {
    now,
    expectedOwnerSubjectSha256,
  });
  const serialized = `${JSON.stringify(document)}\n`;
  const temporary = path.join(
    directory,
    `.github-credential-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, serialized, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, output);
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  return document;
}

const direct =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct) {
  const encoded = process.env.ZEROS_CLOUD_GITHUB_CREDENTIAL_B64 ?? "";
  const ownerSubject = process.env.ZEROS_CLOUD_OWNER_SUB ?? "";
  delete process.env.ZEROS_CLOUD_GITHUB_CREDENTIAL_B64;
  try {
    if (process.platform !== "linux" || process.geteuid?.() !== 0) {
      throw new Error("root Linux coordinator required");
    }
    installCloudGithubCredentialPayload(encoded, {
      expectedOwnerSubjectSha256: cloudOwnerSubjectSha256(ownerSubject),
    });
    process.stdout.write("installed cloud GitHub credential\n");
  } catch {
    process.stderr.write("cloud GitHub credential installation rejected\n");
    process.exit(1);
  }
}
