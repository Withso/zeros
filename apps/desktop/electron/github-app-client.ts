// Pure control-plane client for the desktop GitHub App flow.
//
// This module deliberately has no Electron imports so response validation,
// terminal/transient classification, and secret-boundary behavior are unit
// testable. OAuth and refresh tokens are accepted/returned only in main-process
// memory; renderer-facing code receives separate metadata-only events.

import type { GithubCredential } from "@zeros/protocol/github-auth";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_AUTHORIZATION_WINDOW_MS = 15 * 60_000;
const MAX_INSTALLATIONS = 1_000;
const MAX_TOKEN_LENGTH = 4_096;
const REFRESH_BINDING_RE =
  /^zghrb_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

type GithubAppCredential = Extract<
  GithubCredential,
  { method: "github-app" }
>;

export type GithubAppFlowKind = "oauth" | "install";

export interface GithubAppStartResult {
  authorizeUrl: string;
  expiresAtMs: number;
  /** Authoritative server decision. It may differ from this Mac's request when
   * another device already recorded the account-level installation. */
  flowKind: GithubAppFlowKind;
}

export type GithubAppTokenResult = Omit<
  GithubAppCredential,
  "method" | "ownerSub" | "gitHost" | "gitHttpUsername"
>;

export interface GithubAppInstallationAggregate {
  installationCount: number;
  activeInstallationCount: number;
  repositoryCount?: number;
  allRepositories: boolean;
}

export interface GithubAppInstallationRefreshResult
  extends GithubAppInstallationAggregate {
  login: string;
  complete: boolean;
}

export class GithubAppClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    /** Only a GitHub refresh-token refusal is terminal for the App slot. */
    public readonly terminal: boolean,
  ) {
    super(message);
    this.name = "GithubAppClientError";
  }
}

interface GithubAppClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  allowInsecureLoopback?: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

function secureUrl(
  raw: string,
  context: string,
  allowInsecureLoopback: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${context} is not a valid URL`);
  }
  const allowed =
    url.protocol === "https:" ||
    (allowInsecureLoopback &&
      url.protocol === "http:" &&
      isLoopbackHostname(url.hostname));
  if (!allowed || url.username || url.password) {
    throw new Error(`${context} must use HTTPS`);
  }
  return url;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedString(
  value: unknown,
  maxLength: number,
): string | undefined {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
    ? value.trim()
    : undefined;
}

function positiveTimestamp(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

export function aggregateGithubAppInstallations(
  value: unknown,
): GithubAppInstallationAggregate {
  if (!Array.isArray(value) || value.length > MAX_INSTALLATIONS) {
    throw new GithubAppClientError(
      "The control plane returned an invalid installation list.",
      "bad_response",
      502,
      false,
    );
  }
  let activeInstallationCount = 0;
  let knownRepositoryCount = 0;
  let everyRepositoryCountKnown = true;
  let allRepositories = value.length > 0;

  for (const raw of value) {
    const installation = record(raw);
    const suspendedAt = installation.suspendedAt;
    if (
      suspendedAt !== null &&
      suspendedAt !== undefined &&
      typeof suspendedAt !== "string"
    ) {
      throw new GithubAppClientError(
        "The control plane returned invalid installation metadata.",
        "bad_response",
        502,
        false,
      );
    }
    if (typeof suspendedAt === "string" && suspendedAt.length > 0) {
      allRepositories = false;
      continue;
    }
    activeInstallationCount += 1;
    const repositoryCount = nonNegativeInteger(
      installation.repositoryCount,
    );
    if (repositoryCount === undefined) {
      everyRepositoryCountKnown = false;
    } else {
      knownRepositoryCount += repositoryCount;
    }
    if (installation.allRepositories !== true) {
      allRepositories = false;
    }
  }

  return {
    installationCount: value.length,
    activeInstallationCount,
    ...(everyRepositoryCountKnown
      ? { repositoryCount: knownRepositoryCount }
      : {}),
    allRepositories:
      activeInstallationCount > 0 &&
      activeInstallationCount === value.length &&
      allRepositories,
  };
}

function parseTokenResult(
  raw: unknown,
  requireIdentity: boolean,
  nowMs: number,
): GithubAppTokenResult {
  const body = record(raw);
  const accessToken = boundedString(body.accessToken, MAX_TOKEN_LENGTH);
  if (!accessToken) {
    throw new GithubAppClientError(
      "The control plane returned an incomplete GitHub credential.",
      "bad_response",
      502,
      false,
    );
  }
  const refreshToken = boundedString(body.refreshToken, MAX_TOKEN_LENGTH);
  const refreshBinding = boundedString(
    body.refreshBinding,
    MAX_TOKEN_LENGTH,
  );
  const login = boundedString(body.login, 100);
  const variantKey = boundedString(body.variantKey, 200);
  if (
    requireIdentity &&
    (!login ||
      !variantKey ||
      !/^[A-Za-z0-9.-]+$/.test(variantKey))
  ) {
    throw new GithubAppClientError(
      "The control plane returned incomplete GitHub identity metadata.",
      "bad_response",
      502,
      false,
    );
  }
  const expiresAtMs = positiveTimestamp(body.expiresAtMs);
  const refreshTokenExpiresAtMs = positiveTimestamp(
    body.refreshTokenExpiresAtMs,
  );
  if (
    !refreshToken ||
    !refreshBinding ||
    !REFRESH_BINDING_RE.test(refreshBinding) ||
    !expiresAtMs ||
    expiresAtMs <= nowMs ||
    !refreshTokenExpiresAtMs ||
    refreshTokenExpiresAtMs <= expiresAtMs
  ) {
    throw new GithubAppClientError(
      "The control plane returned a GitHub credential that cannot be rotated safely.",
      "bad_response",
      502,
      false,
    );
  }
  const installationsComplete = body.installationsComplete;
  if (
    requireIdentity &&
    typeof installationsComplete !== "boolean"
  ) {
    throw new GithubAppClientError(
      "The control plane omitted installation inventory completeness.",
      "bad_response",
      502,
      false,
    );
  }
  const installations =
    requireIdentity && installationsComplete === true
      ? aggregateGithubAppInstallations(body.installations)
      : null;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(refreshBinding ? { refreshBinding } : {}),
    ...(login ? { login } : {}),
    ...(variantKey ? { variantKey } : {}),
    ...(expiresAtMs ? { expiresAtMs } : {}),
    ...(refreshTokenExpiresAtMs ? { refreshTokenExpiresAtMs } : {}),
    ...(installations ?? {}),
  };
}

export class GithubAppClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly allowInsecureLoopback: boolean;

  constructor(options: GithubAppClientOptions) {
    this.allowInsecureLoopback = options.allowInsecureLoopback ?? false;
    const controlPlaneUrl = secureUrl(
      options.baseUrl,
      "GitHub control-plane URL",
      this.allowInsecureLoopback,
    );
    if (
      (controlPlaneUrl.pathname !== "/" &&
        controlPlaneUrl.pathname !== "") ||
      controlPlaneUrl.search ||
      controlPlaneUrl.hash
    ) {
      throw new Error("GitHub control-plane URL must be an origin");
    }
    this.baseUrl = controlPlaneUrl.origin;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async request(
    accessToken: string,
    path: string,
    body: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GithubAppClientError(
        "The Zeros control plane is temporarily unavailable.",
        "network",
        0,
        false,
      );
    }
    const raw = await response.json().catch(() => null);
    if (!response.ok) {
      const error = record(record(raw).error);
      const code =
        boundedString(error.code, 100) ?? `http_${response.status}`;
      const message =
        boundedString(error.message, 500) ??
        "The GitHub connection request failed.";
      throw new GithubAppClientError(
        message,
        code,
        response.status,
        response.status === 401 &&
          code === "github_authorization_expired",
      );
    }
    return raw;
  }

  async start(
    accessToken: string,
    input: {
      nonce: string;
      variantKey: string;
      scheme: string;
      installFlow: boolean;
      /** Bypass account-level reconnect detection after a complete desktop
       * inventory has confirmed that no installation remains. */
      forceInstall?: boolean;
    },
  ): Promise<GithubAppStartResult> {
    const body = record(
      await this.request(accessToken, "/v1/github/oauth/start", input),
    );
    const authorizeUrl = boundedString(body.authorizeUrl, 4_096);
    const expiresAtRaw = boundedString(body.expiresAt, 100);
    const flowKindRaw = body.flowKind;
    const flowKind =
      flowKindRaw === undefined
        ? input.installFlow
          ? "install"
          : "oauth"
        : flowKindRaw === "oauth" || flowKindRaw === "install"
          ? flowKindRaw
          : null;
    const expiresAtMs = expiresAtRaw
      ? new Date(expiresAtRaw).getTime()
      : Number.NaN;
    if (
      !authorizeUrl ||
      !flowKind ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= this.now() ||
      expiresAtMs - this.now() > MAX_AUTHORIZATION_WINDOW_MS
    ) {
      throw new GithubAppClientError(
        "The control plane returned an invalid authorization session.",
        "bad_response",
        502,
        false,
      );
    }
    const parsedAuthorizeUrl = secureUrl(
      authorizeUrl,
      "GitHub authorization URL",
      this.allowInsecureLoopback,
    );
    if (parsedAuthorizeUrl.hostname.toLowerCase() !== "github.com") {
      throw new GithubAppClientError(
        "The control plane returned an unexpected GitHub authorization destination.",
        "bad_response",
        502,
        false,
      );
    }
    return {
      authorizeUrl: parsedAuthorizeUrl.toString(),
      expiresAtMs,
      flowKind,
    };
  }

  async exchange(
    accessToken: string,
    nonce: string,
  ): Promise<GithubAppTokenResult> {
    return parseTokenResult(
      await this.request(accessToken, "/v1/github/oauth/exchange", {
        nonce,
      }),
      true,
      this.now(),
    );
  }

  async refresh(
    accessToken: string,
    refreshToken: string,
    refreshBinding: string,
  ): Promise<GithubAppTokenResult> {
    return parseTokenResult(
      await this.request(accessToken, "/v1/github/oauth/refresh", {
        refreshToken,
        refreshBinding,
      }),
      false,
      this.now(),
    );
  }

  async revoke(
    accessToken: string,
    githubAccessToken: string,
    refreshToken: string,
    refreshBinding: string,
  ): Promise<void> {
    await this.request(accessToken, "/v1/github/oauth/revoke", {
      accessToken: githubAccessToken,
      refreshToken,
      refreshBinding,
    });
  }

  async refreshInstallations(
    accessToken: string,
    githubAccessToken: string,
  ): Promise<GithubAppInstallationRefreshResult> {
    const body = record(
      await this.request(
        accessToken,
        "/v1/github/installations/refresh",
        { accessToken: githubAccessToken },
      ),
    );
    const login = boundedString(body.login, 100);
    if (!login || body.complete !== true) {
      throw new GithubAppClientError(
        "The control plane could not return a complete installation inventory.",
        "bad_response",
        502,
        false,
      );
    }
    return {
      login,
      complete: body.complete,
      ...aggregateGithubAppInstallations(body.installations),
    };
  }
}
