import { createHash, createPrivateKey, timingSafeEqual } from "node:crypto";

import {
  sanitizeGithubCredential,
  type GithubAuthMethod,
  type GithubCredential,
} from "@zeros/protocol/github-auth";
import { GithubCloudWorkspaceCredentialBroker } from "../../apps/control-plane/src/cloud-workspaces/github-credentials";

import { collectCloudGithubCredential } from "./config";

export interface CloudGithubCoordinatorDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

const MAX_GITHUB_METADATA_BYTES = 64 * 1024;

async function boundedGithubMetadata(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declared) &&
    (declared < 0 || declared > MAX_GITHUB_METADATA_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("qualified cloud private repository check failed");
  }
  if (!response.body) {
    throw new Error("qualified cloud private repository check failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_GITHUB_METADATA_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("qualified cloud private repository check failed");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("qualified cloud private repository check failed");
  }
}

async function assertPrivateRepositoryScope(input: {
  readonly authority: DirectGithubAppAuthority;
  readonly token: string;
  readonly fetch: typeof fetch;
}): Promise<void> {
  let response: Response;
  try {
    response = await input.fetch(
      `https://api.github.com/repos/${encodeURIComponent(input.authority.owner)}/${encodeURIComponent(input.authority.repository)}`,
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "user-agent": "zeros-cloud-qualification",
          "x-github-api-version": "2026-03-10",
        },
      },
    );
  } catch {
    throw new Error("qualified cloud private repository check failed");
  }
  const raw = await boundedGithubMetadata(response);
  const metadata =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const expectedFullName = `${input.authority.owner}/${input.authority.repository}`;
  if (
    response.status !== 200 ||
    metadata.private !== true ||
    typeof metadata.full_name !== "string" ||
    metadata.full_name.toLowerCase() !== expectedFullName.toLowerCase()
  ) {
    throw new Error("qualified cloud private repository check failed");
  }
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

type DirectGithubAppAuthority = {
  readonly appId: number;
  readonly privateKey: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repository: string;
};

function directGithubAppAuthority(
  env: NodeJS.ProcessEnv,
): DirectGithubAppAuthority | null {
  const names = [
    "ZEROS_CLOUD_GITHUB_APP_ID",
    "ZEROS_CLOUD_GITHUB_APP_PRIVATE_KEY",
    "ZEROS_CLOUD_GITHUB_INSTALLATION_ID",
    "ZEROS_CLOUD_GITHUB_REPOSITORY",
  ] as const;
  const directOnlyNames = [
    "ZEROS_CLOUD_GITHUB_APP_ID",
    "ZEROS_CLOUD_GITHUB_APP_PRIVATE_KEY",
    "ZEROS_CLOUD_GITHUB_REPOSITORY",
  ] as const;
  const supplied = names.filter((name) => (env[name] ?? "").trim() !== "");
  if (
    directOnlyNames.every((name) => (env[name] ?? "").trim() === "")
  ) {
    return null;
  }
  if (supplied.length !== names.length) {
    throw new Error(
      "qualified cloud direct GitHub App authority is incomplete",
    );
  }
  const appIdRaw = boundedValue(env, "ZEROS_CLOUD_GITHUB_APP_ID", 32)!;
  const installationRaw = boundedValue(
    env,
    "ZEROS_CLOUD_GITHUB_INSTALLATION_ID",
    32,
  )!;
  const repositoryRaw = boundedValue(
    env,
    "ZEROS_CLOUD_GITHUB_REPOSITORY",
    256,
  )!;
  const appId = Number(appIdRaw);
  const installationId = Number(installationRaw);
  const repositoryParts = repositoryRaw.split("/");
  const privateKey = env.ZEROS_CLOUD_GITHUB_APP_PRIVATE_KEY!.trim();
  if (
    !Number.isSafeInteger(appId) ||
    appId < 1 ||
    !Number.isSafeInteger(installationId) ||
    installationId < 1 ||
    repositoryParts.length !== 2 ||
    repositoryParts.some(
      (value) =>
        value.length < 1 ||
        value.length > 100 ||
        !/^[A-Za-z0-9_.-]+$/.test(value),
    ) ||
    Buffer.byteLength(privateKey, "utf8") > 64 * 1024 ||
    privateKey.includes("\0")
  ) {
    throw new Error("qualified cloud direct GitHub App authority is invalid");
  }
  try {
    createPrivateKey(privateKey);
  } catch {
    throw new Error("qualified cloud direct GitHub App authority is invalid");
  }
  return {
    appId,
    privateKey,
    installationId,
    owner: repositoryParts[0]!,
    repository: repositoryParts[1]!,
  };
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

  const direct = directGithubAppAuthority(env);
  if (direct) {
    const fetchImpl = dependencies.fetch ?? fetch;
    const broker = new GithubCloudWorkspaceCredentialBroker(
      {
        appId: direct.appId,
        clientId: "qualification-only",
        clientSecret: "qualification-only",
        privateKey: direct.privateKey,
        refreshBindingSecret: "qualification-only",
        appSlug: "qualification-only",
        oauthCallbackUrl: "https://invalid.zeros.invalid/github/callback",
        completionPageUrl: "https://invalid.zeros.invalid/github/connected",
        webBaseUrl: "https://github.com",
        apiBaseUrl: "https://api.github.com",
        variantKey: "github.com",
        desktopSchemes: ["zeros", "zeros-alpha", "zeros-beta", "zeros-dev"],
      },
      { ...dependencies, fetch: fetchImpl },
    );
    const credential = await broker.mint({
      installationId: direct.installationId,
      owner: direct.owner,
      repository: direct.repository,
    });
    try {
      await assertPrivateRepositoryScope({
        authority: direct,
        token: credential.token,
        fetch: fetchImpl,
      });
    } catch (error) {
      await broker.revoke(credential.token).catch(() => undefined);
      throw error;
    }
    return {
      method: "github-app",
      accessToken: credential.token,
      expiresAtMs: credential.expiresAtMs,
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
      variantKey: "github.com",
    };
  }

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
