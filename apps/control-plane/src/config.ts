// ──────────────────────────────────────────────────────────
// Config — every knob comes from the environment, validated at boot.
//
// Authentication is selected explicitly. Legacy Auth0 deployments may still
// derive their verification URLs from AUTH0_DOMAIN during the staged cutover;
// WorkOS and future providers must supply the exact issuer/JWKS contract.
// ──────────────────────────────────────────────────────────

import { z } from "zod";
import { createPrivateKey } from "node:crypto";

import { FEEDBACK_TYPES, type FeedbackType } from "./feedback-types.js";

const EnvSchema = z.object({
  /** Postgres connection string (Railway: the service's DATABASE_URL). */
  DATABASE_URL: z.string().min(1),
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
  /** Exact browser landing page used in organization invitations. */
  INVITE_LINK_BASE: z.string().trim().min(1).optional(),
  /** Railway-only WorkOS browser-session credentials. */
  WORKOS_API_KEY: z.string().trim().min(1).optional(),
  WORKOS_COOKIE_PASSWORD: z.string().trim().min(32).optional(),
  WORKOS_WEBHOOK_SECRET: z.string().trim().min(16).optional(),
  /** Explicit escape from Zeros-hosted channel/domain assertions for templates. */
  ZEROS_SELF_HOSTED: z.enum(["true", "false"]).default("false"),
  PORT: z.coerce.number().int().positive().default(8080),
  /** "production" tightens error bodies; anything else is dev-friendly. */
  NODE_ENV: z.string().default("development"),
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
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).max(64 * 1024).optional(),
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

export type CloudWorkspaceBackendConfig = {
  provider: "daytona";
  apiKey: string;
  apiUrl: string;
  target: string;
  snapshotId: string;
  imageRef: string;
  architecture: "linux/amd64" | "linux/arm64";
  cpuMillicores: number;
  memoryMiB: number;
  storageMiB: number;
  sourceCommit: string | null;
  operationTimeoutSeconds: number;
  autoArchiveMinutes: number;
  reconcileIntervalMs: number;
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
  apiKey: string;
  cookiePassword: string;
  webhookSecret: string;
};

export type Config = {
  databaseUrl: string;
  auth: AuthBackendConfig;
  /** Null in legacy Auth0 mode. WorkOS secrets live only on Railway. */
  workos: WorkOSBackendConfig | null;
  /** Exact, environment-bound invitation landing page (without a query). */
  inviteLinkBase: string;
  port: number;
  isProduction: boolean;
  /** Null when no GitHub App is registered for this environment. */
  github: GithubBackendConfig | null;
  /** Null when neither feedback destination is configured. */
  feedback: FeedbackBackendConfig | null;
  /** Null unless the explicit paid-resource gate and complete provider block
   * are present. Merely setting a Daytona API key never enables creation. */
  cloudWorkspaces: CloudWorkspaceBackendConfig | null;
};

const CloudWorkspaceEnvSchema = z.object({
  CLOUD_WORKSPACES_ENABLED: z.literal("true"),
  CLOUD_WORKSPACE_PROVIDER: z.literal("daytona").default("daytona"),
  DAYTONA_API_KEY: z.string().trim().min(16).max(4096),
  DAYTONA_API_URL: z
    .string()
    .url()
    .default("https://app.daytona.io/api"),
  DAYTONA_TARGET: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .default("eu"),
  DAYTONA_SNAPSHOT_ID: z.string().trim().min(1).max(512),
  ZEROS_CLOUD_IMAGE_ARCHITECTURE: z
    .enum(["linux/amd64", "linux/arm64"])
    .default("linux/amd64"),
  ZEROS_CLOUD_SOURCE_COMMIT: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .min(40),
  CLOUD_WORKSPACE_CPU_MILLICORES: z.coerce
    .number()
    .int()
    .min(250)
    .max(64_000)
    .default(2_000),
  CLOUD_WORKSPACE_MEMORY_MIB: z.coerce
    .number()
    .int()
    .min(512)
    .max(262_144)
    .default(4_096),
  CLOUD_WORKSPACE_STORAGE_MIB: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(2_097_152)
    .default(20_480),
  CLOUD_WORKSPACE_OPERATION_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(10)
    .max(600)
    .default(180),
  CLOUD_WORKSPACE_AUTO_ARCHIVE_MINUTES: z.coerce
    .number()
    .int()
    .min(60)
    .max(43_200)
    .default(10_080),
  CLOUD_WORKSPACE_RECONCILE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(5_000),
});

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

function validatedAuthUrl(
  raw: string,
  name: string,
  nodeEnv: string,
): string {
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

function requiredAuthValue(
  value: string | undefined,
  name: string,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Invalid environment: ${name} is required`);
  }
  return normalized;
}

function validatedAppOrigin(value: string, nodeEnv: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid environment: APP_ORIGIN must be an exact origin");
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
      "Invalid environment: APP_ORIGIN must be an HTTPS origin (or dev loopback HTTP) with no path, credentials, query, or fragment",
    );
  }
  return url.origin;
}

function loadInviteLinkBase(
  raw: string | undefined,
  appOrigin: string | null,
  nodeEnv: string,
): string {
  const candidate = raw?.trim() || `${appOrigin ?? "https://app.zeros.build"}/invite`;
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
      issuer: validatedAuthUrl(
        issuerValues[0]!,
        "AUTH_ISSUER",
        env.NODE_ENV,
      ),
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

function parseFeedbackMap(
  raw: string | undefined,
  name: string,
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
      console.error(
        `[config] ${name} ignores unknown feedback types: ${unknown.join(", ")}`,
      );
    }
    const normalized: Partial<Record<FeedbackType, string>> = {};
    for (const type of FEEDBACK_TYPES) {
      const value = parsed[type];
      if (value) normalized[type] = value;
    }
    if (parsed.issue) {
      console.warn(
        `[config] ${name} maps legacy "issue" to "bug"; update the variable to use "bug".`,
      );
      normalized.bug ??= parsed.issue;
    }
    return normalized;
  } catch (error) {
    console.error(
      `[config] ${name} is invalid and feedback tagging is DISABLED: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
}

function loadFeedbackConfig(
  env: NodeJS.ProcessEnv,
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
      const tagIds = parseFeedbackMap(env.INTERCOM_TAG_IDS, "INTERCOM_TAG_IDS");
      if (
        (adminId && Object.keys(tagIds).length === 0) ||
        (!adminId && Object.keys(tagIds).length > 0)
      ) {
        console.error(
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
      console.error(
        `[config] Intercom feedback is DISABLED — INTERCOM_REGION must be us, eu, or au (received ${JSON.stringify(region)}).`,
      );
    }
  } else if (intercomSupplied.length > 0) {
    console.error(
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
      labelIds: parseFeedbackMap(env.LINEAR_LABEL_IDS, "LINEAR_LABEL_IDS"),
    };
  } else if (linearSupplied.length > 0) {
    console.error(
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
      console.error(
        `[config] POSTHOG_PROJECT_URL is ignored: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return intercom || linear ? { intercom, linear, posthogProjectUrl } : null;
}

function loadCloudWorkspaceConfig(
  env: NodeJS.ProcessEnv,
  github: GithubBackendConfig | null,
): CloudWorkspaceBackendConfig | null {
  const enabled = env.CLOUD_WORKSPACES_ENABLED?.trim().toLowerCase();
  if (enabled !== "true") {
    if (enabled && enabled !== "false") {
      throw new Error(
        "Invalid environment: CLOUD_WORKSPACES_ENABLED must be true or false",
      );
    }
    return null;
  }

  const parsed = CloudWorkspaceEnvSchema.safeParse({
    ...env,
    CLOUD_WORKSPACES_ENABLED: enabled,
  });
  if (!parsed.success) {
    throw new Error(
      "Invalid cloud workspace environment: " +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
    );
  }
  if (!github?.privateKey) {
    throw new Error(
      "Invalid cloud workspace environment: GITHUB_APP_PRIVATE_KEY is required before cloud provisioning can be enabled",
    );
  }
  try {
    if (createPrivateKey(github.privateKey).asymmetricKeyType !== "rsa") {
      throw new Error("not RSA");
    }
  } catch {
    throw new Error(
      "Invalid cloud workspace environment: GITHUB_APP_PRIVATE_KEY must be a valid RSA private key",
    );
  }
  const value = parsed.data;
  return {
    provider: value.CLOUD_WORKSPACE_PROVIDER,
    apiKey: value.DAYTONA_API_KEY,
    apiUrl: validatedServiceUrl(value.DAYTONA_API_URL, "DAYTONA_API_URL", {
      allowPath: true,
    }),
    target: value.DAYTONA_TARGET,
    snapshotId: value.DAYTONA_SNAPSHOT_ID,
    imageRef: value.DAYTONA_SNAPSHOT_ID,
    architecture: value.ZEROS_CLOUD_IMAGE_ARCHITECTURE,
    cpuMillicores: value.CLOUD_WORKSPACE_CPU_MILLICORES,
    memoryMiB: value.CLOUD_WORKSPACE_MEMORY_MIB,
    storageMiB: value.CLOUD_WORKSPACE_STORAGE_MIB,
    sourceCommit: value.ZEROS_CLOUD_SOURCE_COMMIT,
    operationTimeoutSeconds:
      value.CLOUD_WORKSPACE_OPERATION_TIMEOUT_SECONDS,
    autoArchiveMinutes: value.CLOUD_WORKSPACE_AUTO_ARCHIVE_MINUTES,
    reconcileIntervalMs: value.CLOUD_WORKSPACE_RECONCILE_INTERVAL_MS,
  };
}

const HOSTED_ENVIRONMENTS = {
  alpha: {
    audience: "https://api-alpha.zeros.build",
    appOrigin: "https://app-alpha.zeros.build",
    branch: "main",
  },
  beta: {
    audience: "https://api-beta.zeros.build",
    appOrigin: "https://app-beta.zeros.build",
    branch: "release/",
  },
  production: {
    audience: "https://api.zeros.build",
    appOrigin: "https://app.zeros.build",
    branch: "release/",
  },
} as const;

function validateRailwayEnvironment(
  env: NodeJS.ProcessEnv,
  audience: string,
  appOrigin: string | null,
  inviteLinkBase: string,
  selfHosted: boolean,
): void {
  // Railway injects these values. Local processes and non-Railway hosts have no
  // project id and intentionally skip this deployment-topology assertion.
  if (!env.RAILWAY_PROJECT_ID) return;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${missing}`);
  }
  const e = parsed.data;
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
      console.error(
        "[config] GitHub App sign-in is DISABLED — its configuration is " +
          `incomplete or invalid: ${
            error instanceof Error ? error.message : String(error)
          }. Every other control-plane feature is unaffected; the GitHub ` +
          "routes will answer github_not_configured.",
      );
    }
  }

  return {
    databaseUrl: e.DATABASE_URL,
    auth,
    workos,
    inviteLinkBase,
    port: e.PORT,
    isProduction: e.NODE_ENV === "production",
    github,
    feedback: loadFeedbackConfig(env),
    cloudWorkspaces: loadCloudWorkspaceConfig(env, github),
  };
}
