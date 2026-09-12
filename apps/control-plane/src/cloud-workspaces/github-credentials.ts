import type { GithubBackendConfig } from "../config.js";
import { createGithubAppJwt } from "../github-app-jwt.js";
import type { CloudWorkspaceRepositoryCredentialBroker } from "./setup-materials.js";

const GITHUB_API_VERSION = "2026-03-10";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

type FetchLike = typeof fetch;

export type GithubCloudWorkspaceCredentialBrokerDependencies = {
  fetch?: FetchLike;
  now?: () => number;
};

function unavailable(): Error {
  return new Error("cloud workspace GitHub credential is unavailable");
}

function validToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    value === value.trim() &&
    !/[\0\r\n]/.test(value)
  );
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    (declaredLength < 0 || declaredLength > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw unavailable();
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw unavailable();
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
    throw unavailable();
  }
}

/** Backend-only GitHub App broker used by the image setup exchange. It never
 * mints an all-repository or write credential: GitHub receives the exact
 * repository name and an explicit contents:read permission reduction. */
export class GithubCloudWorkspaceCredentialBroker implements CloudWorkspaceRepositoryCredentialBroker {
  private readonly fetch: FetchLike;
  private readonly now: () => number;

  constructor(
    private readonly config: GithubBackendConfig,
    dependencies: GithubCloudWorkspaceCredentialBrokerDependencies = {},
  ) {
    if (
      config.variantKey !== "github.com" ||
      config.webBaseUrl !== "https://github.com" ||
      config.apiBaseUrl !== "https://api.github.com"
    ) {
      throw new Error(
        "cloud workspace GitHub.com credential broker does not support a different forge origin",
      );
    }
    if (!config.privateKey) {
      throw new Error(
        "cloud workspace GitHub credential broker is not configured",
      );
    }
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
  }

  async mint(input: {
    installationId: number;
    owner: string;
    repository: string;
  }): Promise<{ token: string; expiresAtMs: number }> {
    if (
      !Number.isSafeInteger(input.installationId) ||
      input.installationId < 1 ||
      !NAME_PATTERN.test(input.owner) ||
      !NAME_PATTERN.test(input.repository)
    ) {
      throw new Error("cloud workspace GitHub credential scope is invalid");
    }
    const now = this.now();
    let response: Response;
    try {
      response = await this.fetch(
        `${this.config.apiBaseUrl}/app/installations/${input.installationId}/access_tokens`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${createGithubAppJwt(this.config, now)}`,
            "content-type": "application/json",
            "user-agent": "zeros-control-plane",
            "x-github-api-version": GITHUB_API_VERSION,
          },
          body: JSON.stringify({
            repositories: [input.repository],
            permissions: { contents: "read" },
          }),
        },
      );
    } catch {
      throw unavailable();
    }
    const raw = await boundedJson(response);
    const body =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const expiresAtMs = Date.parse(String(body.expires_at ?? ""));
    const mintedToken = validToken(body.token) ? body.token : null;
    if (
      response.status !== 201 ||
      !mintedToken ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs - now < 5 * 60_000 ||
      expiresAtMs - now > 70 * 60_000
    ) {
      // A 201 response can contain a real bearer whose metadata fails our
      // tighter lifetime contract. Revoke that bearer here: callers cannot
      // clean it up because a rejected mint never returns the token to them.
      if (mintedToken) {
        await this.revoke(mintedToken).catch(() => undefined);
      }
      throw unavailable();
    }
    return { token: mintedToken, expiresAtMs };
  }

  async revoke(token: string): Promise<void> {
    if (!validToken(token)) throw unavailable();
    let response: Response;
    try {
      response = await this.fetch(
        `${this.config.apiBaseUrl}/installation/token`,
        {
          method: "DELETE",
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "zeros-control-plane",
            "x-github-api-version": GITHUB_API_VERSION,
          },
        },
      );
    } catch {
      throw unavailable();
    }
    if (response.status !== 204 && response.status !== 404) {
      await response.body?.cancel().catch(() => undefined);
      throw unavailable();
    }
    await response.body?.cancel().catch(() => undefined);
  }
}
