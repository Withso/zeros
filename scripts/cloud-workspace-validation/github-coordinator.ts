import { createHash, timingSafeEqual } from "node:crypto";

import {
  sanitizeGithubCredential,
  type GithubAuthMethod,
  type GithubCredential,
} from "@zeros/protocol/github-auth";

import { collectCloudGithubCredential } from "./config";

export interface CloudGithubCoordinatorDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

function boundedValue(
  env: NodeJS.ProcessEnv,
  name: string,
  maxBytes: number,
): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (
    raw !== value ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(`qualified cloud GitHub ${name} is invalid`);
  }
  return value;
}

function ownerHash(subject: string): string {
  return createHash("sha256").update(subject, "utf8").digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function accountTokenSubject(token: string): string | null {
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) return null;
  let bytes: Buffer | null = null;
  try {
    bytes = Buffer.from(segments[1], "base64url");
    if (bytes.length > 16 * 1024) return null;
    const payload = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const sub = (payload as Record<string, unknown>).sub;
    return typeof sub === "string" && sub.length <= 512 ? sub : null;
  } catch {
    return null;
  } finally {
    bytes?.fill(0);
  }
}

function parseRepositories(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const repositories = raw.split(",").map((value) => value.trim());
  if (
    repositories.length < 1 ||
    repositories.length > 500 ||
    new Set(repositories).size !== repositories.length ||
    repositories.some(
      (value) =>
        value.length < 1 ||
        value.length > 100 ||
        !/^[A-Za-z0-9._-]+$/.test(value),
    )
  ) {
    throw new Error("qualified cloud GitHub repository scope is invalid");
  }
  return repositories;
}

function parseControlPlaneUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("qualified cloud GitHub control-plane URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("qualified cloud GitHub control-plane URL is invalid");
  }
  return url;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).sort().join("\0") === expected.sort().join("\0")
  );
}

/** Resolve either an explicit operator credential or a one-hour GitHub App
 * installation token minted by the authenticated control plane. No returned
 * bearer is persisted by this coordinator module. */
export async function resolveQualifiedCloudGithubCredential(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: CloudGithubCoordinatorDependencies = {},
): Promise<GithubCredential | null> {
  const ownerSubject = boundedValue(env, "ZEROS_CLOUD_OWNER_SUB", 512);
  if (!ownerSubject) {
    throw new Error("qualified cloud GitHub owner binding is missing");
  }
  const explicit = collectCloudGithubCredential(env);
  if (explicit) return explicit;

  const installationRaw = boundedValue(
    env,
    "ZEROS_CLOUD_GITHUB_INSTALLATION_ID",
    32,
  );
  if (!installationRaw) return null;
  const installationId = Number(installationRaw);
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    throw new Error("qualified cloud GitHub installation id is invalid");
  }
  const controlPlaneRaw = boundedValue(
    env,
    "ZEROS_CONTROL_PLANE_URL",
    4_096,
  );
  const accountToken = boundedValue(
    env,
    "ZEROS_ACCOUNT_ACCESS_TOKEN",
    16_384,
  );
  if (!controlPlaneRaw || !accountToken) {
    throw new Error(
      "qualified cloud GitHub control-plane authentication is incomplete",
    );
  }
  // The control plane verifies the signature. This local structural check ties
  // the token being sent to the worker's immutable owner before any request;
  // a forged payload cannot produce a response from the authenticated route.
  if (accountTokenSubject(accountToken) !== ownerSubject) {
    throw new Error("qualified cloud GitHub account owner binding is invalid");
  }
  const repositories = parseRepositories(
    boundedValue(env, "ZEROS_CLOUD_GITHUB_REPOSITORIES", 64 * 1024),
  );
  const base = parseControlPlaneUrl(controlPlaneRaw);
  const endpoint = new URL(
    `/v1/github/installations/${installationId}/token`,
    base,
  );
  const response = await (dependencies.fetch ?? fetch)(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accountToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(repositories ? { repositories } : {}),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => {
    throw new Error("qualified cloud GitHub credential mint failed");
  });
  if (!response.ok) {
    throw new Error("qualified cloud GitHub credential mint was rejected");
  }
  const serialized = await response.text();
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
    throw new Error("qualified cloud GitHub credential response is invalid");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } finally {
    // Strings cannot be zeroed, but drop the only local binding immediately;
    // the parsed access token remains solely in the returned working copy.
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("qualified cloud GitHub credential response is invalid");
  }
  const value = raw as Record<string, unknown>;
  const expected = [
    "accessToken",
    "expiresAtMs",
    "gitHost",
    "gitHttpUsername",
    "method",
    "ownerSubjectSha256",
    "variantKey",
    ...(value.login === undefined ? [] : ["login"]),
  ];
  if (
    !exactKeys(value, expected) ||
    typeof value.ownerSubjectSha256 !== "string" ||
    !hashesMatch(value.ownerSubjectSha256, ownerHash(ownerSubject))
  ) {
    throw new Error("qualified cloud GitHub credential owner binding is invalid");
  }
  const credential = sanitizeGithubCredential({
    method: value.method,
    accessToken: value.accessToken,
    expiresAtMs: value.expiresAtMs,
    gitHost: value.gitHost,
    gitHttpUsername: value.gitHttpUsername,
    variantKey: value.variantKey,
    ...(value.login === undefined ? {} : { login: value.login }),
  });
  const now = (dependencies.now ?? Date.now)();
  if (
    !credential ||
    credential.method !== "github-app" ||
    !credential.expiresAtMs ||
    credential.expiresAtMs - now < 5 * 60_000 ||
    credential.expiresAtMs - now > 70 * 60_000 ||
    credential.gitHost !== "github.com" ||
    credential.gitHttpUsername !== "x-access-token" ||
    credential.variantKey !== "github.com"
  ) {
    throw new Error("qualified cloud GitHub credential response is invalid");
  }
  return credential;
}

/** Resolve a replacement after the engine rejected its current working copy.
 * Only control-plane-minted GitHub App installation credentials are renewable.
 * Explicit PAT/gh-cli/App bearers are cleared so an engine restart cannot
 * resurrect the same rejected value; the operator can restart the coordinator
 * after supplying a replacement. */
export async function resolveQualifiedCloudGithubCredentialAfterInvalidation(
  method: GithubAuthMethod,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: CloudGithubCoordinatorDependencies = {},
): Promise<GithubCredential | null> {
  if (method !== "github-app") return null;
  if (collectCloudGithubCredential(env)) return null;
  const installationId = boundedValue(
    env,
    "ZEROS_CLOUD_GITHUB_INSTALLATION_ID",
    32,
  );
  if (!installationId) return null;
  return resolveQualifiedCloudGithubCredential(env, dependencies);
}
