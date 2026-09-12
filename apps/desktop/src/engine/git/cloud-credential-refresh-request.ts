import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { GithubAuthMethod } from "@zeros/protocol/github-auth";
import { cloudOwnerSubjectSha256 } from "./cloud-credential-projection";

export const CLOUD_GITHUB_REFRESH_REQUEST_FILE =
  "/run/zeros/github-credential-refresh.json";
const MAX_DOCUMENT_BYTES = 8 * 1024;
const METHODS = new Set<GithubAuthMethod>(["gh-cli", "github-app", "pat"]);

export interface CloudGithubCredentialRefreshRequest {
  readonly version: 1;
  readonly audience: "zeros-cloud-github-refresh-v1";
  readonly generation: string;
  readonly requestedAt: number;
  readonly ownerSubjectSha256: string;
  readonly method: GithubAuthMethod;
  readonly reason: "credential-invalid";
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return Object.keys(value).sort().join("\0") === expected.sort().join("\0");
}

function validateDirectory(file: string, expectedUid: number): void {
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

function validateFile(file: string, expectedUid: number): void {
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
}

function parseRequest(raw: unknown): CloudGithubCredentialRefreshRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cloud GitHub refresh request is invalid");
  }
  const value = raw as Record<string, unknown>;
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
    Number(value.requestedAt) <= 0 ||
    typeof value.ownerSubjectSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.ownerSubjectSha256) ||
    !METHODS.has(value.method as GithubAuthMethod) ||
    value.reason !== "credential-invalid"
  ) {
    throw new Error("cloud GitHub refresh request is invalid");
  }
  return {
    version: 1,
    audience: "zeros-cloud-github-refresh-v1",
    generation: value.generation,
    requestedAt: Number(value.requestedAt),
    ownerSubjectSha256: value.ownerSubjectSha256,
    method: value.method as GithubAuthMethod,
    reason: "credential-invalid",
  };
}

/** A quarantined marker may temporarily have more than one hard link while a
 * second engine restores the canonical name. Read the random private path from
 * a pinned no-follow descriptor instead of applying the canonical nlink=1
 * invariant, which would make both acknowledgements delete the marker. */
function readQuarantinedRequest(
  file: string,
  expectedUid: number,
): CloudGithubCredentialRefreshRequest {
  const descriptor = openSync(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = fstatSync(descriptor);
    const current = lstatSync(file);
    if (
      !metadata.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino ||
      metadata.uid !== expectedUid ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size < 2 ||
      metadata.size > MAX_DOCUMENT_BYTES
    ) {
      throw new Error("cloud GitHub refresh request is unsafe");
    }
    try {
      return parseRequest(
        JSON.parse(readFileSync(descriptor, "utf8")) as unknown,
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("cloud GitHub refresh request is invalid");
      }
      throw error;
    }
  } finally {
    closeSync(descriptor);
  }
}

export function readCloudGithubCredentialRefreshRequest(
  options: {
    readonly file?: string;
    readonly expectedUid?: number;
  } = {},
): CloudGithubCredentialRefreshRequest | null {
  const file = options.file ?? CLOUD_GITHUB_REFRESH_REQUEST_FILE;
  const expectedUid = options.expectedUid ?? 0;
  if (
    !path.isAbsolute(file) ||
    !Number.isInteger(expectedUid) ||
    expectedUid < 0
  ) {
    throw new Error("cloud GitHub refresh options are invalid");
  }
  validateDirectory(file, expectedUid);
  try {
    validateFile(file, expectedUid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return parseRequest(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("cloud GitHub refresh request is invalid");
    }
    throw error;
  }
}

export function requestCloudGithubCredentialRefresh(options: {
  readonly ownerSubject: string;
  readonly method: GithubAuthMethod;
  readonly reason: "credential-invalid";
  readonly file?: string;
  readonly expectedUid?: number;
  readonly generation?: string;
  readonly now?: number;
}): CloudGithubCredentialRefreshRequest {
  const file = options.file ?? CLOUD_GITHUB_REFRESH_REQUEST_FILE;
  const expectedUid = options.expectedUid ?? 0;
  const generation =
    options.generation ?? randomBytes(24).toString("base64url");
  const requestedAt = options.now ?? Date.now();
  if (
    !path.isAbsolute(file) ||
    !Number.isInteger(expectedUid) ||
    expectedUid < 0 ||
    !METHODS.has(options.method) ||
    options.reason !== "credential-invalid" ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(generation) ||
    !Number.isSafeInteger(requestedAt) ||
    requestedAt <= 0
  ) {
    throw new Error("cloud GitHub refresh options are invalid");
  }
  validateDirectory(file, expectedUid);
  const existing = readCloudGithubCredentialRefreshRequest({
    file,
    expectedUid,
  });
  void existing;
  const request: CloudGithubCredentialRefreshRequest = {
    version: 1,
    audience: "zeros-cloud-github-refresh-v1",
    generation,
    requestedAt,
    ownerSubjectSha256: cloudOwnerSubjectSha256(options.ownerSubject),
    method: options.method,
    reason: "credential-invalid",
  };
  const temporary = path.join(
    path.dirname(file),
    `.github-credential-refresh.${generation}.tmp`,
  );
  let descriptor: number | null = null;
  let operationError: unknown = null;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(request)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    validateFile(file, expectedUid);
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown = null;
  if (descriptor !== null) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    unlinkSync(temporary);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" &&
      cleanupError === null
    ) {
      cleanupError = error;
    }
  }
  if (operationError !== null) throw operationError;
  if (cleanupError !== null) throw cleanupError;
  return request;
}

/** Acknowledge only the marker whose credential was actually installed. A
 * concurrent newer request wins: link(2) restores a stale quarantined marker
 * only when the canonical path is still absent. */
export function acknowledgeCloudGithubCredentialRefreshRequest(options: {
  readonly generation: string;
  readonly file?: string;
  readonly expectedUid?: number;
}): boolean {
  const file = options.file ?? CLOUD_GITHUB_REFRESH_REQUEST_FILE;
  const expectedUid = options.expectedUid ?? 0;
  if (
    !path.isAbsolute(file) ||
    !Number.isInteger(expectedUid) ||
    expectedUid < 0 ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(options.generation)
  ) {
    throw new Error("cloud GitHub refresh acknowledgement is invalid");
  }
  validateDirectory(file, expectedUid);
  const quarantine = path.join(
    path.dirname(file),
    `.github-credential-refresh.ack.${randomBytes(12).toString("hex")}`,
  );
  try {
    renameSync(file, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  let acknowledged = false;
  const removeQuarantine = () => {
    try {
      unlinkSync(quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  try {
    chmodSync(quarantine, 0o600);
    const current = readQuarantinedRequest(quarantine, expectedUid);
    acknowledged = current.generation === options.generation;
    if (!acknowledged) {
      try {
        linkSync(quarantine, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  } catch (error) {
    removeQuarantine();
    throw error;
  }
  removeQuarantine();
  return acknowledged;
}
