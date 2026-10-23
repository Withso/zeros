import type { CodexFingerprintKeys } from "./agent-credentials/codex-fingerprint-keys.js";
import { CloudAgentCredentialEnvSchema, loadCloudAgentCredentialConfig, type CloudAgentCredentialConfig } from "./agent-credentials/agent-credential-config.js";
// ──────────────────────────────────────────────────────────
// Config — every knob comes from the environment, validated at boot.
//
// Authentication is selected explicitly. Legacy Auth0 deployments may still
// derive their verification URLs from AUTH0_DOMAIN during the staged cutover;
// WorkOS and future providers must supply the exact issuer/JWKS contract.
// ──────────────────────────────────────────────────────────

import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";

import { FEEDBACK_TYPES, type FeedbackType } from "./feedback-types.js";
import { validateDatabaseConnections } from "./database-config.js";
import { developmentIdentity, type DevelopmentIdentity } from "./development-environment.js";
import {parseDatabaseTarget, validateMigrationRole} from "./database-target.js";
import { cloudWorkspaceChannelEnabled } from "./cloud/channel-policy.js";
import { loadZerosDevAuthConfig, type ZerosDevAuthConfig } from "./zeros-dev-auth-config.js";
import { BOAT_BILLING_ORG_PATTERN } from "./cloud/boat-client.js";
import { DEFAULT_SLOW_REQUEST_LOG_MS } from "./request-timing.js";
import { loadWorkerPollIntervals, type WorkerPollIntervals } from "./worker-polling-config.js";
import { validateReleaseLedgerUrl } from "./client-compatibility.js";
import { CloudV2WorkerSigner } from "./cloud/worker-auth.js";

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const EnvSchema = z.object({
  /** Runtime Postgres connection; production uses an unprivileged login. */
  DATABASE_URL: z.string().min(1),
  DATABASE_LISTEN_URL: z.string().min(1).optional(),
  DATABASE_MIGRATION_URL: z.string().min(1).optional(),
  DATABASE_MIGRATION_ROLE: z.string().min(1).optional(),
  DATABASE_MIGRATIONS_ON_BOOT: z.enum(["true", "false"]).default("true"),
  DATABASE_MAINTENANCE_MODE: z.enum(["true", "false"]).default("false"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(6),
  CONTROL_PLANE_PROCESS_ROLE: z.enum(["api", "worker", "realtime", "combined"]).default("combined"),
  /** Graceful drain window on SIGTERM; 0 keeps the immediate close. */
  CONTROL_PLANE_DRAIN_SECONDS: z.coerce.number().int().min(0).max(120).default(0),
  SLOW_REQUEST_LOG_MS: z.coerce.number().int().min(50).max(60_000).default(DEFAULT_SLOW_REQUEST_LOG_MS),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().optional(),
  CONTROL_PLANE_TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0),
  DESKTOP_RELEASE_LEDGER_URL: z.string().optional(),
  AUTH_PROVIDER: z.enum(["auth0", "workos"]).default("auth0"),
  /** The Auth0 tenant domain, e.g. your-tenant.us.auth0.com (no scheme). */
  AUTH0_DOMAIN: z.string().trim().min(1).optional(),
  /**
   * Accepted `iss` claims, comma-separated; defaults to
   * `https://${AUTH0_DOMAIN}/`. A custom Auth0 domain deployment lists BOTH
   * the tenant's default `<tenant>.auth0.com` issuer and the custom one,
   * since Auth0 can mint under either depending on config.
   */
  AUTH_ISSUER: z.string().optional(),
  /** Override the JWKS URL; defaults to `https://${AUTH0_DOMAIN}/.well-known/jwks.json`. */
  AUTH_JWKS_URL: z.string().url().optional(),
  /** Expected `aud` claim for this resource server. */
  AUTH_AUDIENCE: z.string().min(1),
  /** Allowed WorkOS Applications. Required only in WorkOS mode. */
  AUTH_WEB_CLIENT_ID: z.string().trim().min(1).optional(),
  AUTH_DESKTOP_CLIENT_ID: z.string().trim().min(1).optional(),
  /** Canonical browser application origin used for callbacks and cookies. */
  APP_ORIGIN: z.string().trim().min(1).optional(),
  /** Optional isolated staff console origin. Deliberately absent in Beta. */
  OPS_ORIGIN: z.string().trim().min(1).optional(),
  /** Exact browser landing page used in organization invitations. */
  INVITE_LINK_BASE: z.string().trim().min(1).optional(),
  /** Railway-only WorkOS browser-session credentials. */
  WORKOS_API_KEY: z.string().trim().min(1).optional(),
  WORKOS_COOKIE_PASSWORD: z.string().trim().min(32).optional(),
  WORKOS_WEBHOOK_SECRET: z.string().trim().min(16).optional(),
  /** Explicit escape from Zeros-hosted channel/domain assertions for templates. */
  ZEROS_SELF_HOSTED: z.enum(["true", "false"]).default("false"),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.enum(["127.0.0.1", "0.0.0.0", "::"]).optional(),
  /** "production" tightens error bodies; anything else is dev-friendly. */
  NODE_ENV: z.string().default("development"),
  /** Optional server-only key; never projected into desktop or cloud agents. */
  CHAT_TITLE_OPENAI_API_KEY: z.string().trim().max(512).refine((value) => !/\s/.test(value)).optional(),
});

// ──────────────────────────────────────────────────────────
// GitHub App — an OPTIONAL feature block, not a boot requirement.
//
// These five values only exist once a GitHub App has been registered for the
// environment. Requiring them at boot made an unset variable take down the
// entire control plane — teams, invitations, settings, and `/healthz` with it,
// which on Railway (healthcheck + restart-on-failure) becomes a crash loop.
// A missing registration must cost exactly one feature, so an absent or
// unusable block resolves to `null` and the GitHub routes answer
// `github_not_configured`, which the desktop already renders as
// "use gh CLI or a Personal Access Token for now".
// ──────────────────────────────────────────────────────────

const GithubEnvSchema = z.object({
  /** Public numeric id of the environment-specific GitHub App registration. */
  GITHUB_APP_ID: z.coerce.number().int().positive(),
  /** Public OAuth client id. This is not the numeric App id. */
  GITHUB_APP_CLIENT_ID: z.string().trim().min(1),
  /** Confidential OAuth secret; backend-only, never shipped in the desktop. */
  GITHUB_APP_CLIENT_SECRET: z.string().min(1),
  /** Backend-only RSA private key used to mint one-hour installation tokens
   * for cloud workspaces. Optional so desktop OAuth remains independently
   * available when cloud Git has not been configured yet. */
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .min(1)
    .max(64 * 1024)
    .optional(),
  /** Public app slug used to build the installation URL. */
  GITHUB_APP_SLUG: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]+$/),
  /** Registered GitHub user-authorization callback. */
  GITHUB_OAUTH_CALLBACK_URL: z.string().url(),
  /** Hosted browser page that hands the completed flow back to the desktop. */
  GITHUB_COMPLETION_PAGE_URL: z
    .string()
    .url()
    .default("https://app.zeros.build/github/connected"),
  /**
   * Key for the refresh-token binding HMAC. Defaults to the client secret for
   * continuity, but SET IT SEPARATELY in any environment that rotates the
   * client secret: bindings signed with the old secret stop verifying, and the
   * desktop treats a rejected binding as "reconnect", so sharing the two keys
   * makes routine secret rotation a fleet-wide reconnect prompt.
   */
  GITHUB_REFRESH_BINDING_SECRET: z.string().min(16).optional(),
  /** Host seams for a future GHES registration. */
  GITHUB_WEB_BASE_URL: z.string().url().default("https://github.com"),
  GITHUB_API_BASE_URL: z.string().url().default("https://api.github.com"),
  NODE_ENV: z.string().default("development"),
});

const GITHUB_REQUIRED_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_SLUG",
  "GITHUB_OAUTH_CALLBACK_URL",
] as const;

export type GithubBackendConfig = {
  appId: number;
  clientId: string;
  clientSecret: string;
  privateKey?: string;
  /** HMAC key for the refresh binding. Separate so rotating the OAuth client
   *  secret does not invalidate every outstanding binding at once. */
  refreshBindingSecret: string;
  appSlug: string;
  oauthCallbackUrl: string;
  completionPageUrl: string;
  webBaseUrl: string;
  apiBaseUrl: string;
  variantKey: "github.com";
  desktopSchemes: readonly ["zeros", "zeros-alpha", "zeros-beta", "zeros-dev"];
};

export type FeedbackBackendConfig = {
  intercom: {
    token: string;
    region: "us" | "eu" | "au";
    adminId: string | null;
    tagIds: Readonly<Partial<Record<FeedbackType, string>>>;
    appId: string | null;
  } | null;
  linear: {
    apiKey: string;
    teamId: string;
    labelIds: Readonly<Partial<Record<FeedbackType, string>>>;
  } | null;
  posthogProjectUrl: string | null;
};

export type AuthBackendConfig =
  | {
      provider: "auth0";
      issuers: string[];
      jwksUrl: string;
      audience: string;
    }
  | {
      provider: "workos";
      issuer: string;
      jwksUrl: string;
      audience: string;
      webClientId: string;
      desktopClientId: string;
    };

export type WorkOSBackendConfig = {
  appOrigin: string;
  opsOrigin: string | null;
  apiKey: string;
  cookiePassword: string;
  webhookSecret: string;
};

export type Config = {
  databaseUrl: string;
  databaseListenUrl?: string;
  /** Optional for embedders; loadConfig always supplies resolved defaults. */
  databaseMigrationUrl?: string;
  databaseMigrationRole?: string;
  databaseMigrationsOnBoot?: boolean;
  databasePoolMax?: number;
  /** Combined preserves existing deployments; dedicated workers and realtime
   * replicas scale independently. */
  processRole?: "api" | "worker" | "realtime" | "combined";
  /** SIGTERM drain window for WebSocket sessions; 0 closes them at once. */
  shutdownDrainMs?: number;
  workerPollIntervalsMs?: WorkerPollIntervals;
  /** Requests at least this slow are logged once by route template. */
  slowRequestLogMs?: number;
  /** Absent when tracing is disabled; see `traceExportUrl`. */
  tracesUrl?: string;
  traceSampleRatio?: number;
  /** All application routes and background writers are disabled during cutover. */
  databaseMaintenanceMode?: boolean;
  auth: AuthBackendConfig;
  /** Null in legacy Auth0 mode. WorkOS secrets live only on Railway. */
  workos: WorkOSBackendConfig | null;
  /** Fixed Alpha test identity; omitted/disabled everywhere else. No password. */
  zerosDevAuth?: ZerosDevAuthConfig | null;
  /** Exact, environment-bound invitation landing page (without a query). */
  inviteLinkBase: string;
  port: number;
  host?: string;
  development?: DevelopmentIdentity;
  isProduction: boolean;
  deploymentChannel: "development" | "alpha" | "beta" | "production";
  desktopReleaseLedgerUrl?: string | null;
  /** Null when no GitHub App is registered for this environment. */
  github: GithubBackendConfig | null;
  /** Null when neither feedback destination is configured. */
  feedback: FeedbackBackendConfig | null;
  /** Dedicated server credential for automatic titles; absent disables titles. */
  chatTitleApiKey?: string | null;
  cloudAgentCredentials?: CloudAgentCredentialConfig | null;
  /** Cloud workspace v2: Boat VMs run by a small worker. Null unless enabled. */
  cloudV2?: CloudV2Config | null;
};

export type CloudV2Config = {
  /** Enable only after publishing the matching outbox-capable runtime. */
  promptOutbox?: boolean;
  boat: { apiKey: string; billingOrg?: string };
  /** https:// origin of the API service; agents reach the model proxy here. */
  apiUrl: string;
  /** wss:// origin of the realtime service; the Mac app connects here. */
  realtimeUrl: string;
  workerSigningKey: string;
  workerSigningKeyPrevious?: string;
  /** The worker runtime every VM runs, by sha256, and where it is stored. */
  runtime: { sha256: string; store: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string } };
};

function loadCloudV2Config(env: NodeJS.ProcessEnv): CloudV2Config | null {
  const enabled = env.CLOUD_V2_ENABLED?.trim().toLowerCase();
  if (enabled !== "true") {
    if (enabled && enabled !== "false") throw new Error("Invalid environment: CLOUD_V2_ENABLED must be true or false");
    return null;
  }
  const apiKey = env.BOAT_API_KEY?.trim();
  if (!apiKey) throw new Error("Invalid environment: CLOUD_V2_ENABLED requires BOAT_API_KEY");
  const billingOrg = env.BOAT_BILLING_ORG?.trim();
  const promptOutbox = env.CLOUD_V2_PROMPT_OUTBOX_ENABLED?.trim().toLowerCase();
  if (promptOutbox && !["true", "false"].includes(promptOutbox)) throw new Error("Invalid environment: CLOUD_V2_PROMPT_OUTBOX_ENABLED must be true or false");
  const origin = (name: string, protocol: "https:" | "wss:") => {
    const raw = env[name]?.trim();
    let url: URL;
    try { url = new URL(raw ?? ""); } catch { throw new Error(`Invalid environment: ${name} must be a ${protocol}// origin`); }
    const local = protocol === "wss:" ? url.protocol === "ws:" : url.protocol === "http:";
    if ((url.protocol !== protocol && !(local && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
        url.pathname !== "/" || url.search || url.hash || url.username || url.password)
      throw new Error(`Invalid environment: ${name} must be a ${protocol}// origin`);
    return url.origin;
  };
  const sha256 = env.CLOUD_V2_RUNTIME_SHA256?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid environment: CLOUD_V2_RUNTIME_SHA256 must name a published worker runtime");
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Invalid environment: CLOUD_V2_ENABLED requires ${name}`);
    return value;
  };
  const endpoint = required("CLOUD_V2_RUNTIME_STORE_ENDPOINT");
  if (!endpoint.startsWith("https://")) throw new Error("Invalid environment: CLOUD_V2_RUNTIME_STORE_ENDPOINT must be https");
  const workerSigningKey = required("CLOUD_V2_WORKER_SIGNING_KEY"), previous = env.CLOUD_V2_WORKER_SIGNING_KEY_PREVIOUS?.trim();
  new CloudV2WorkerSigner(workerSigningKey, previous);
  return {
    boat: { apiKey, ...(billingOrg ? { billingOrg } : {}) },
    promptOutbox: promptOutbox === "true",
    workerSigningKey, ...(previous ? { workerSigningKeyPrevious: previous } : {}),
    apiUrl: origin("CLOUD_V2_API_URL", "https:"),
    realtimeUrl: origin("CLOUD_V2_REALTIME_URL", "wss:"),
    runtime: { sha256, store: {
      endpoint, bucket: required("CLOUD_V2_RUNTIME_STORE_BUCKET"),
      accessKeyId: required("CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID"), secretAccessKey: required("CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY"),
    } },
  };
}

function validatedServiceUrl(
  raw: string,
  name: string,
  options: { allowPath: boolean },
): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!options.allowPath && url.pathname !== "/")
  ) {
    throw new Error(
      `Invalid environment: ${name} must be a credential-free HTTPS ${
        options.allowPath ? "base URL" : "origin"
      }`,
    );
  }
  return url.toString().replace(/\/+$/, "");
}

/** The realtime service origin engines dial for the uplink: a
 * credential-free HTTPS/WSS origin, normalized to `wss`. */
function validatedBrowserUrl(
  raw: string,
  name: string,
  nodeEnv: string,
): string {
  const url = new URL(raw);
  const devLoopback =
    nodeEnv !== "production" &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !devLoopback) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `Invalid environment: ${name} must use HTTPS (or dev loopback HTTP) and contain no credentials, query, or fragment`,
    );
  }
  return url.toString();
}

function validatedAuthUrl(raw: string, name: string, nodeEnv: string): string {
  const value = raw.trim();
  const url = new URL(value);
  const devLoopback =
    nodeEnv !== "production" &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !devLoopback) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `Invalid environment: ${name} must use HTTPS (or dev loopback HTTP) and contain no credentials, query, or fragment`,
    );
  }
  // The issuer is an exact JWT string contract, including trailing slashes.
  // Preserve the operator-provided spelling after URL validation.
  return value;
}

function requiredAuthValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Invalid environment: ${name} is required`);
  }
  return normalized;
}

function validatedAppOrigin(
  value: string,
  nodeEnv: string,
  name = "APP_ORIGIN",
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid environment: ${name} must be an exact origin`);
  }
  const devLoopback =
    nodeEnv !== "production" &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !devLoopback) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `Invalid environment: ${name} must be an HTTPS origin (or dev loopback HTTP) with no path, credentials, query, or fragment`,
    );
  }
  return url.origin;
}

function loadInviteLinkBase(
  raw: string | undefined,
  appOrigin: string | null,
  nodeEnv: string,
): string {
  const candidate =
    raw?.trim() || `${appOrigin ?? "https://app.zeros.build"}/invite`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(
      "Invalid environment: INVITE_LINK_BASE must be an exact /invite URL",
    );
  }
  const devLoopback =
    nodeEnv !== "production" &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !devLoopback) ||
    url.username ||
    url.password ||
    url.pathname.replace(/\/+$/, "") !== "/invite" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Invalid environment: INVITE_LINK_BASE must use HTTPS (or dev loopback HTTP) and be an exact, credential-free /invite URL with no query or fragment",
    );
  }
  if (appOrigin !== null && url.origin !== appOrigin) {
    throw new Error(
      "Invalid environment: INVITE_LINK_BASE must use the exact APP_ORIGIN",
    );
  }
  return `${url.origin}/invite`;
}

function loadWorkOSBackendConfig(
  env: z.infer<typeof EnvSchema>,
  appOrigin: string | null,
): WorkOSBackendConfig | null {
  if (env.AUTH_PROVIDER !== "workos") return null;
  if (appOrigin === null) {
    throw new Error("Invalid environment: APP_ORIGIN is required");
  }
  return {
    appOrigin,
    opsOrigin: env.OPS_ORIGIN
      ? validatedAppOrigin(env.OPS_ORIGIN, env.NODE_ENV, "OPS_ORIGIN")
      : null,
    apiKey: requiredAuthValue(env.WORKOS_API_KEY, "WORKOS_API_KEY"),
    cookiePassword: requiredAuthValue(
      env.WORKOS_COOKIE_PASSWORD,
      "WORKOS_COOKIE_PASSWORD",
    ),
    webhookSecret: requiredAuthValue(
      env.WORKOS_WEBHOOK_SECRET,
      "WORKOS_WEBHOOK_SECRET",
    ),
  };
}

function validateWorkOSOriginSeparation(
  auth: Extract<AuthBackendConfig, { provider: "workos" }>,
  backend: WorkOSBackendConfig,
): void {
  let audienceOrigin: string | null = null;
  try {
    audienceOrigin = new URL(auth.audience).origin;
  } catch {
    // OAuth audiences may be non-URL identifiers. Hosted Zeros environments
    // apply their stricter exact-audience matrix below.
  }
  if (audienceOrigin === backend.appOrigin) {
    throw new Error(
      "Invalid environment: APP_ORIGIN and the WorkOS API audience must use separate origins",
    );
  }
  if (backend.opsOrigin === backend.appOrigin) {
    throw new Error(
      "Invalid environment: OPS_ORIGIN and APP_ORIGIN must be separate origins",
    );
  }
  if (audienceOrigin !== null && audienceOrigin === backend.opsOrigin) {
    throw new Error(
      "Invalid environment: OPS_ORIGIN and the WorkOS API audience must use separate origins",
    );
  }
}

function loadAuthConfig(env: z.infer<typeof EnvSchema>): AuthBackendConfig {
  if (env.AUTH_PROVIDER === "workos") {
    const issuerValues = requiredAuthValue(env.AUTH_ISSUER, "AUTH_ISSUER")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (issuerValues.length !== 1) {
      throw new Error(
        "Invalid environment: AUTH_ISSUER must contain exactly one issuer in WorkOS mode",
      );
    }
    const webClientId = requiredAuthValue(
      env.AUTH_WEB_CLIENT_ID,
      "AUTH_WEB_CLIENT_ID",
    );
    const desktopClientId = requiredAuthValue(
      env.AUTH_DESKTOP_CLIENT_ID,
      "AUTH_DESKTOP_CLIENT_ID",
    );
    if (webClientId === desktopClientId) {
      throw new Error(
        "Invalid environment: AUTH_WEB_CLIENT_ID and AUTH_DESKTOP_CLIENT_ID must be different",
      );
    }
    return {
      provider: "workos",
      issuer: validatedAuthUrl(issuerValues[0]!, "AUTH_ISSUER", env.NODE_ENV),
      jwksUrl: validatedAuthUrl(
        requiredAuthValue(env.AUTH_JWKS_URL, "AUTH_JWKS_URL"),
        "AUTH_JWKS_URL",
        env.NODE_ENV,
      ),
      audience: env.AUTH_AUDIENCE,
      webClientId,
      desktopClientId,
    };
  }

  const domain = env.AUTH0_DOMAIN?.replace(/\/+$/, "") || null;
  if (!domain && (!env.AUTH_ISSUER?.trim() || !env.AUTH_JWKS_URL?.trim())) {
    throw new Error(
      "Invalid environment: AUTH0_DOMAIN is required unless both AUTH_ISSUER and AUTH_JWKS_URL are configured",
    );
  }
  const base = domain ? `https://${domain}` : null;
  const issuers = (env.AUTH_ISSUER ?? `${base}/`)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => validatedAuthUrl(value, "AUTH_ISSUER", env.NODE_ENV));
  if (issuers.length === 0) {
    throw new Error("Invalid environment: AUTH_ISSUER is required");
  }
  return {
    provider: "auth0",
    issuers,
    jwksUrl: validatedAuthUrl(
      env.AUTH_JWKS_URL ?? `${base}/.well-known/jwks.json`,
      "AUTH_JWKS_URL",
      env.NODE_ENV,
    ),
    audience: env.AUTH_AUDIENCE,
  };
}

/** Resolve the optional GitHub App block. Throws only so `loadConfig` can turn
 *  the reason into a warning — never into a failed boot. */
function parseGithubConfig(env: NodeJS.ProcessEnv): GithubBackendConfig {
  const parsed = GithubEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }
  const e = parsed.data;
  const privateKey = e.GITHUB_APP_PRIVATE_KEY?.includes("\\n")
    ? e.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n").trim()
    : e.GITHUB_APP_PRIVATE_KEY?.trim();
  return {
    appId: e.GITHUB_APP_ID,
    clientId: e.GITHUB_APP_CLIENT_ID,
    clientSecret: e.GITHUB_APP_CLIENT_SECRET,
    ...(privateKey ? { privateKey } : {}),
    refreshBindingSecret:
      e.GITHUB_REFRESH_BINDING_SECRET ?? e.GITHUB_APP_CLIENT_SECRET,
    appSlug: e.GITHUB_APP_SLUG,
    oauthCallbackUrl: validatedBrowserUrl(
      e.GITHUB_OAUTH_CALLBACK_URL,
      "GITHUB_OAUTH_CALLBACK_URL",
      e.NODE_ENV,
    ),
    completionPageUrl: validatedBrowserUrl(
      e.GITHUB_COMPLETION_PAGE_URL,
      "GITHUB_COMPLETION_PAGE_URL",
      e.NODE_ENV,
    ),
    webBaseUrl: validatedServiceUrl(
      e.GITHUB_WEB_BASE_URL,
      "GITHUB_WEB_BASE_URL",
      { allowPath: false },
    ),
    apiBaseUrl: validatedServiceUrl(
      e.GITHUB_API_BASE_URL,
      "GITHUB_API_BASE_URL",
      { allowPath: true },
    ),
    variantKey: "github.com",
    desktopSchemes: ["zeros", "zeros-alpha", "zeros-beta", "zeros-dev"],
  };
}

type ConfigDiagnostics = Pick<Console, "error" | "warn">;

function parseFeedbackMap(
  raw: string | undefined,
  name: string,
  diagnostics: ConfigDiagnostics,
): Readonly<Partial<Record<FeedbackType, string>>> {
  if (!raw?.trim()) return {};
  try {
    const parsed = z.record(z.string().trim().min(1)).parse(JSON.parse(raw));
    const unknown = Object.keys(parsed).filter(
      (key) =>
        key !== "issue" &&
        !FEEDBACK_TYPES.includes(key as (typeof FEEDBACK_TYPES)[number]),
    );
    if (unknown.length > 0) {
      diagnostics.error(
        `[config] ${name} ignores unknown feedback types: ${unknown.join(", ")}`,
      );
    }
    const normalized: Partial<Record<FeedbackType, string>> = {};
    for (const type of FEEDBACK_TYPES) {
      const value = parsed[type];
      if (value) normalized[type] = value;
    }
    if (parsed.issue) {
      diagnostics.warn(
        `[config] ${name} maps legacy "issue" to "bug"; update the variable to use "bug".`,
      );
      normalized.bug ??= parsed.issue;
    }
    return normalized;
  } catch (error) {
    diagnostics.error(
      `[config] ${name} is invalid and feedback tagging is DISABLED: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
}

function loadFeedbackConfig(
  env: NodeJS.ProcessEnv,
  diagnostics: ConfigDiagnostics,
): FeedbackBackendConfig | null {
  const intercomKeys = [
    "INTERCOM_TOKEN",
    "INTERCOM_REGION",
    "INTERCOM_ADMIN_ID",
    "INTERCOM_TAG_IDS",
    "INTERCOM_APP_ID",
  ] as const;
  const intercomSupplied = intercomKeys.filter(
    (key) => (env[key] ?? "").trim().length > 0,
  );
  const intercomToken = env.INTERCOM_TOKEN?.trim();
  let intercom: FeedbackBackendConfig["intercom"] = null;
  if (intercomToken) {
    const region = (env.INTERCOM_REGION?.trim().toLowerCase() ||
      "us") as string;
    if (region === "us" || region === "eu" || region === "au") {
      const adminId = env.INTERCOM_ADMIN_ID?.trim() || null;
      const tagIds = parseFeedbackMap(env.INTERCOM_TAG_IDS, "INTERCOM_TAG_IDS", diagnostics);
      if (
        (adminId && Object.keys(tagIds).length === 0) ||
        (!adminId && Object.keys(tagIds).length > 0)
      ) {
        diagnostics.error(
          "[config] Intercom feedback tags require BOTH INTERCOM_ADMIN_ID and INTERCOM_TAG_IDS; conversations remain enabled without tags.",
        );
      }
      intercom = {
        token: intercomToken,
        region,
        adminId,
        tagIds,
        appId: env.INTERCOM_APP_ID?.trim() || null,
      };
    } else {
      diagnostics.error(
        `[config] Intercom feedback is DISABLED — INTERCOM_REGION must be us, eu, or au (received ${JSON.stringify(region)}).`,
      );
    }
  } else if (intercomSupplied.length > 0) {
    diagnostics.error(
      "[config] Intercom feedback is DISABLED — INTERCOM_TOKEN is missing.",
    );
  }

  const linearKey = env.LINEAR_API_KEY?.trim();
  const linearTeam = env.LINEAR_TEAM_ID?.trim();
  const linearSupplied = [
    "LINEAR_API_KEY",
    "LINEAR_TEAM_ID",
    "LINEAR_LABEL_IDS",
  ].filter((key) => (env[key] ?? "").trim().length > 0);
  let linear: FeedbackBackendConfig["linear"] = null;
  if (linearKey && linearTeam) {
    linear = {
      apiKey: linearKey,
      teamId: linearTeam,
      labelIds: parseFeedbackMap(env.LINEAR_LABEL_IDS, "LINEAR_LABEL_IDS", diagnostics),
    };
  } else if (linearSupplied.length > 0) {
    diagnostics.error(
      "[config] Linear feedback is DISABLED — LINEAR_API_KEY and LINEAR_TEAM_ID must both be set.",
    );
  }

  let posthogProjectUrl: string | null = null;
  if (env.POSTHOG_PROJECT_URL?.trim()) {
    try {
      posthogProjectUrl = validatedServiceUrl(
        env.POSTHOG_PROJECT_URL.trim(),
        "POSTHOG_PROJECT_URL",
        { allowPath: true },
      );
    } catch (error) {
      diagnostics.error(
        `[config] POSTHOG_PROJECT_URL is ignored: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return intercom || linear ? { intercom, linear, posthogProjectUrl } : null;
}

const HOSTED_ENVIRONMENTS = {
  alpha: {
    audience: "https://api-alpha.zeros.build",
    appOrigin: "https://app-alpha.zeros.build",
    opsOrigin: "https://ops-alpha.zeros.build",
    branch: "main",
  },
  beta: {
    audience: "https://api-beta.zeros.build",
    appOrigin: "https://app-beta.zeros.build",
    opsOrigin: null,
    branch: "release/",
  },
  production: {
    audience: "https://api.zeros.build",
    appOrigin: "https://app.zeros.build",
    opsOrigin: "https://ops.zeros.build",
    branch: "release/",
  },
} as const;

function validateRailwayEnvironment(
  env: NodeJS.ProcessEnv,
  audience: string,
  appOrigin: string | null,
  inviteLinkBase: string,
  opsOrigin: string | null,
  selfHosted: boolean,
): void {
  // Railway injects these values. Local processes and non-Railway hosts have no
  // project id and intentionally skip this deployment-topology assertion.
  if (!env.RAILWAY_PROJECT_ID) return;
  // This branch has already passed the stricter workspace/source/database
  // contract. Release names cannot enter it, even when the Dev flag is set.
  if (env.ZEROS_DEV_ENVIRONMENT === "hosted") {
    developmentIdentity(env);
    return;
  }
  // Public templates use installer-owned WorkOS credentials and Railway
  // domains, so the Zeros-hosted channel matrix does not apply. This opt-out
  // is explicit; official deployments keep the fail-closed assertions below.
  if (selfHosted) return;
  const name = (env.RAILWAY_ENVIRONMENT_NAME ?? "").trim().toLowerCase();
  const expected =
    HOSTED_ENVIRONMENTS[name as keyof typeof HOSTED_ENVIRONMENTS];
  if (!expected) {
    throw new Error(
      "Invalid environment: Railway environment must be named alpha, beta, or production",
    );
  }
  if (audience !== expected.audience) {
    throw new Error(
      `Invalid environment: AUTH_AUDIENCE must be ${expected.audience} in Railway ${name}`,
    );
  }
  if (appOrigin !== null && appOrigin !== expected.appOrigin) {
    throw new Error(
      `Invalid environment: APP_ORIGIN must be ${expected.appOrigin} in Railway ${name}`,
    );
  }
  if (appOrigin !== null && opsOrigin !== expected.opsOrigin) {
    throw new Error(
      expected.opsOrigin
        ? `Invalid environment: OPS_ORIGIN must be ${expected.opsOrigin} in Railway ${name}`
        : "Invalid environment: OPS_ORIGIN is not supported in Railway beta",
    );
  }
  const expectedInviteLinkBase = `${expected.appOrigin}/invite`;
  if (inviteLinkBase !== expectedInviteLinkBase) {
    throw new Error(
      `Invalid environment: INVITE_LINK_BASE must be ${expectedInviteLinkBase} in Railway ${name}`,
    );
  }
  const branch = (env.RAILWAY_GIT_BRANCH ?? "").trim();
  if (!branch) {
    throw new Error(
      `Invalid environment: Railway ${name} requires a Git-connected deployment with RAILWAY_GIT_BRANCH metadata`,
    );
  }
  const validReleaseBranch = /^release\/\d+\.\d+\.\d+$/.test(branch);
  if (name === "alpha" ? branch !== expected.branch : !validReleaseBranch) {
    throw new Error(
      `Invalid environment: Railway ${name} cannot deploy Git branch ${JSON.stringify(
        branch,
      )}; expected ${name === "alpha" ? "main" : "release/X.Y.Z"}`,
    );
  }
}

function traceExportUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be a URL"); }
  const privateHttp = url.protocol === "http:" &&
    (url.hostname.endsWith(".railway.internal") || url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((url.protocol !== "https:" && !privateHttp) || url.username || url.password || url.search || url.hash)
    throw new Error("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be https (or http on a Railway private host) without credentials or a query");
  return url.toString();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, diagnostics: ConfigDiagnostics = console): Config {
  const development = developmentIdentity(env);
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${missing}`);
  }
  const e = parsed.data;
  const channel = (env.RAILWAY_ENVIRONMENT_NAME ?? "development").trim().toLowerCase();
  const deploymentChannel = channel === "alpha" || channel === "beta" || channel === "production" ? channel : "development";
  const cloudChannel = cloudWorkspaceChannelEnabled(deploymentChannel);
  validateDatabaseConnections(e);
  const migrationRole = validateMigrationRole(e.DATABASE_MIGRATION_ROLE);
  const auth = loadAuthConfig(e);
  const appOrigin = e.APP_ORIGIN
    ? validatedAppOrigin(e.APP_ORIGIN, e.NODE_ENV)
    : null;
  const workos = loadWorkOSBackendConfig(e, appOrigin);
  const inviteLinkBase = loadInviteLinkBase(
    e.INVITE_LINK_BASE,
    appOrigin,
    e.NODE_ENV,
  );
  if (auth.provider === "workos" && workos) {
    validateWorkOSOriginSeparation(auth, workos);
  }
  validateRailwayEnvironment(
    env,
    e.AUTH_AUDIENCE,
    appOrigin,
    inviteLinkBase,
    workos?.opsOrigin ?? null,
    e.ZEROS_SELF_HOSTED === "true",
  );

  // An operator who supplied NONE of the GitHub variables has simply not
  // registered an App yet — that is a normal state and stays quiet. Anything
  // partial or malformed is a mistake, so it is logged loudly, but it still
  // must not deny the rest of the control plane to every user.
  const supplied = GITHUB_REQUIRED_KEYS.filter(
    (key) => (env[key] ?? "").trim().length > 0,
  );
  let github: GithubBackendConfig | null = null;
  if (supplied.length > 0) {
    try {
      github = parseGithubConfig(env);
    } catch (error) {
      diagnostics.error(
        "[config] GitHub App sign-in is DISABLED — its configuration is " +
          `incomplete or invalid: ${
            error instanceof Error ? error.message : String(error)
          }. Every other control-plane feature is unaffected; the GitHub ` +
          "routes will answer github_not_configured.",
      );
    }
  }

  const tracesUrl = traceExportUrl(e.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  return {
    databaseUrl: parseDatabaseTarget(e.DATABASE_URL).toString(),
    ...(e.DATABASE_LISTEN_URL ? {databaseListenUrl: parseDatabaseTarget(e.DATABASE_LISTEN_URL).toString()} : {}),
    databaseMigrationUrl: parseDatabaseTarget(e.DATABASE_MIGRATION_URL ?? e.DATABASE_URL).toString(),
    ...(migrationRole ? {databaseMigrationRole: migrationRole} : {}),
    databaseMigrationsOnBoot: e.DATABASE_MIGRATIONS_ON_BOOT === "true",
    databasePoolMax: e.DATABASE_POOL_MAX,
    processRole: e.CONTROL_PLANE_PROCESS_ROLE,
    shutdownDrainMs: e.CONTROL_PLANE_DRAIN_SECONDS * 1_000,
    workerPollIntervalsMs: loadWorkerPollIntervals(env),
    slowRequestLogMs: e.SLOW_REQUEST_LOG_MS,
    ...(tracesUrl ? { tracesUrl } : {}),
    traceSampleRatio: e.CONTROL_PLANE_TRACE_SAMPLE_RATIO,
    databaseMaintenanceMode: e.DATABASE_MAINTENANCE_MODE === "true",
    auth,
    workos,
    zerosDevAuth: loadZerosDevAuthConfig(env, deploymentChannel, auth),
    inviteLinkBase,
    port: e.PORT,
    ...(e.HOST ? { host: e.HOST } : {}),
    ...(development ? { development } : {}),
    isProduction: e.NODE_ENV === "production",
    desktopReleaseLedgerUrl: validateReleaseLedgerUrl(e.DESKTOP_RELEASE_LEDGER_URL),
    deploymentChannel,
    github,
    feedback: loadFeedbackConfig(env, diagnostics),
    chatTitleApiKey: e.CHAT_TITLE_OPENAI_API_KEY || null,
    cloudAgentCredentials: cloudChannel ? loadCloudAgentCredentialConfig(env) : null,
    cloudV2: cloudChannel ? loadCloudV2Config(env) : null,
  };
}
