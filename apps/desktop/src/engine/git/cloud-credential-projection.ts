import { createHash, timingSafeEqual } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  sanitizeGithubCredential,
  type GithubAuthMethod,
  type GithubCredential,
} from "@zeros/protocol/github-auth";

export const CLOUD_GITHUB_CREDENTIAL_FILE =
  "/run/zeros/github-credential.json";
const MAX_DOCUMENT_BYTES = 24 * 1024;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 60_000;
const METHODS = new Set<GithubAuthMethod>([
  "gh-cli",
  "github-app",
  "pat",
]);

export interface CloudGithubCredentialProjection {
  readonly version: 1;
  readonly audience: "zeros-cloud-github-credential-v1";
  readonly generation: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly ownerSubjectSha256: string;
  readonly method: GithubAuthMethod;
  readonly credential: GithubCredential | null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).sort().join("\0") === expected.sort().join("\0")
  );
}

export function cloudOwnerSubjectSha256(ownerSubject: string): string {
  const normalized = ownerSubject.trim();
  if (
    normalized !== ownerSubject ||
    normalized.length < 1 ||
    normalized.length > 512 ||
    /[\0\r\n]/.test(normalized)
  ) {
    throw new Error("cloud GitHub credential owner is invalid");
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseCredential(
  raw: unknown,
  method: GithubAuthMethod,
  now: number,
  documentExpiresAt: number,
): GithubCredential | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cloud GitHub credential working copy is invalid");
  }
  const value = raw as Record<string, unknown>;
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
  if (!exactKeys(value, expected)) {
    throw new Error("cloud GitHub credential contains unsupported authority");
  }
  const parsed = sanitizeGithubCredential(value);
  if (
    !parsed ||
    parsed.method !== method ||
    parsed.gitHost !== "github.com" ||
    parsed.gitHttpUsername !== "x-access-token" ||
    (parsed.method === "github-app" &&
      (!parsed.expiresAtMs ||
        parsed.expiresAtMs <= now ||
        parsed.expiresAtMs > documentExpiresAt))
  ) {
    throw new Error("cloud GitHub credential working copy is invalid");
  }
  return parsed.method === "github-app"
    ? {
        method: parsed.method,
        accessToken: parsed.accessToken,
        gitHost: parsed.gitHost,
        gitHttpUsername: parsed.gitHttpUsername,
        ...(parsed.login ? { login: parsed.login } : {}),
        ...(parsed.expiresAtMs ? { expiresAtMs: parsed.expiresAtMs } : {}),
        ...(parsed.variantKey ? { variantKey: parsed.variantKey } : {}),
      }
    : parsed;
}

function parseProjection(
  raw: unknown,
  ownerSubject: string,
  now: number,
): CloudGithubCredentialProjection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cloud GitHub credential document is invalid");
  }
  const value = raw as Record<string, unknown>;
  if (
    !exactKeys(value, [
      "audience",
      "credential",
      "expiresAt",
      "generation",
      "issuedAt",
      "method",
      "ownerSubjectSha256",
      "version",
    ]) ||
    value.version !== 1 ||
    value.audience !== "zeros-cloud-github-credential-v1" ||
    typeof value.generation !== "string" ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(value.generation) ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.issuedAt) > now + CLOCK_SKEW_MS ||
    Number(value.expiresAt) <= now ||
    Number(value.expiresAt) <= Number(value.issuedAt) ||
    Number(value.expiresAt) - Number(value.issuedAt) >
      MAX_LIFETIME_MS + CLOCK_SKEW_MS ||
    typeof value.ownerSubjectSha256 !== "string" ||
    !hashesMatch(
      value.ownerSubjectSha256,
      cloudOwnerSubjectSha256(ownerSubject),
    ) ||
    !METHODS.has(value.method as GithubAuthMethod)
  ) {
    throw new Error("cloud GitHub credential document is invalid");
  }
  const method = value.method as GithubAuthMethod;
  return {
    version: 1,
    audience: "zeros-cloud-github-credential-v1",
    generation: value.generation,
    issuedAt: Number(value.issuedAt),
    expiresAt: Number(value.expiresAt),
    ownerSubjectSha256: value.ownerSubjectSha256,
    method,
    credential: parseCredential(
      value.credential,
      method,
      now,
      Number(value.expiresAt),
    ),
  };
}

export function readCloudGithubCredentialProjection(options: {
  readonly file?: string;
  readonly ownerSubject: string;
  readonly expectedUid?: number;
  readonly now?: number;
}): CloudGithubCredentialProjection | null {
  const file = options.file ?? CLOUD_GITHUB_CREDENTIAL_FILE;
  const expectedUid = options.expectedUid ?? 0;
  const now = options.now ?? Date.now();
  if (
    !path.isAbsolute(file) ||
    !Number.isInteger(expectedUid) ||
    expectedUid < 0 ||
    !Number.isSafeInteger(now)
  ) {
    throw new Error("cloud GitHub credential projection options are invalid");
  }
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("cloud GitHub credential projection is unsafe");
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size < 2 ||
    stat.size > MAX_DOCUMENT_BYTES ||
    realpathSync(file) !== file
  ) {
    throw new Error("cloud GitHub credential projection is unsafe");
  }
  const directory = path.dirname(file);
  const directoryStat = lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== expectedUid ||
    (directoryStat.mode & 0o077) !== 0 ||
    realpathSync(directory) !== directory
  ) {
    throw new Error("cloud GitHub credential projection directory is unsafe");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("cloud GitHub credential document is invalid");
  }
  return parseProjection(raw, options.ownerSubject, now);
}

export interface CloudGithubCredentialProjectionWatcher {
  stop(): void;
}

/** Poll a root-owned atomic projection. Polling avoids inode-watch loss across
 * rename and makes expiry itself a state transition even when no file changes. */
export function watchCloudGithubCredentialProjection(options: {
  readonly ownerSubject: string;
  readonly file?: string;
  readonly expectedUid?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly onChange: (
    credential: GithubCredential | null,
    method: GithubAuthMethod | null,
  ) => void;
  readonly onRejected?: () => void;
}): CloudGithubCredentialProjectionWatcher {
  const pollMs = options.pollMs ?? 1_000;
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60_000) {
    throw new Error("cloud GitHub credential watcher interval is invalid");
  }
  let lastIdentity: string | null = null;
  let stopped = false;
  const poll = () => {
    if (stopped) return;
    try {
      const projection = readCloudGithubCredentialProjection({
        ownerSubject: options.ownerSubject,
        ...(options.file ? { file: options.file } : {}),
        ...(options.expectedUid === undefined
          ? {}
          : { expectedUid: options.expectedUid }),
        now: (options.now ?? Date.now)(),
      });
      const identity = projection
        ? `${projection.generation}:${createHash("sha256")
            .update(JSON.stringify(projection))
            .digest("hex")}`
        : "missing";
      if (identity === lastIdentity) return;
      lastIdentity = identity;
      options.onChange(
        projection?.credential ?? null,
        projection?.method ?? null,
      );
    } catch {
      if (lastIdentity === "rejected") return;
      lastIdentity = "rejected";
      options.onChange(null, null);
      options.onRejected?.();
    }
  };
  poll();
  const timer = setInterval(poll, pollMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
