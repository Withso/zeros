// ──────────────────────────────────────────────────────────
// Config — every knob comes from the environment, validated at boot.
//
// Auth0 is the AUTH ISSUER ONLY (docs/teams.md Part C):
// we derive its JWKS + issuer URLs from AUTH0_DOMAIN and verify tokens
// locally. Swapping the issuer later = changing these URLs, nothing else.
// ──────────────────────────────────────────────────────────

import { z } from "zod";

const EnvSchema = z.object({
  /** Postgres connection string (Railway: the service's DATABASE_URL). */
  DATABASE_URL: z.string().min(1),
  /** The Auth0 tenant domain, e.g. your-tenant.us.auth0.com (no scheme). */
  AUTH0_DOMAIN: z.string().min(1),
  /**
   * Accepted `iss` claims, comma-separated; defaults to
   * `https://${AUTH0_DOMAIN}/`. A custom Auth0 domain deployment lists BOTH
   * the tenant's default `<tenant>.auth0.com` issuer and the custom one,
   * since Auth0 can mint under either depending on config.
   */
  AUTH_ISSUER: z.string().optional(),
  /** Override the JWKS URL; defaults to `https://${AUTH0_DOMAIN}/.well-known/jwks.json`. */
  AUTH_JWKS_URL: z.string().url().optional(),
  /** Expected `aud` claim — the Auth0 API identifier registered for this backend. */
  AUTH_AUDIENCE: z.string().min(1),
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
  /** Public app slug used to build the installation URL. */
  GITHUB_APP_SLUG: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]+$/),
  /** Registered GitHub user-authorization callback. */
  GITHUB_OAUTH_CALLBACK_URL: z.string().url(),
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
  /** HMAC key for the refresh binding. Separate so rotating the OAuth client
   *  secret does not invalidate every outstanding binding at once. */
  refreshBindingSecret: string;
  appSlug: string;
  oauthCallbackUrl: string;
  webBaseUrl: string;
  apiBaseUrl: string;
  variantKey: "github.com";
  desktopSchemes: readonly ["zeros", "zeros-alpha", "zeros-beta", "zeros-dev"];
};

export type Config = {
  databaseUrl: string;
  authIssuers: string[];
  authJwksUrl: string;
  authAudience: string;
  port: number;
  isProduction: boolean;
  /** Null when no GitHub App is registered for this environment. */
  github: GithubBackendConfig | null;
};

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
  const callback = new URL(e.GITHUB_OAUTH_CALLBACK_URL);
  if (
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    (callback.protocol !== "https:" &&
      !(
        e.NODE_ENV !== "production" &&
        callback.protocol === "http:" &&
        (callback.hostname === "127.0.0.1" ||
          callback.hostname === "[::1]" ||
          callback.hostname === "localhost")
      ))
  ) {
    throw new Error(
      "GITHUB_OAUTH_CALLBACK_URL must use HTTPS (or dev loopback HTTP)",
    );
  }
  return {
    appId: e.GITHUB_APP_ID,
    clientId: e.GITHUB_APP_CLIENT_ID,
    clientSecret: e.GITHUB_APP_CLIENT_SECRET,
    refreshBindingSecret:
      e.GITHUB_REFRESH_BINDING_SECRET ?? e.GITHUB_APP_CLIENT_SECRET,
    appSlug: e.GITHUB_APP_SLUG,
    oauthCallbackUrl: callback.toString(),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${missing}`);
  }
  const e = parsed.data;
  const base = `https://${e.AUTH0_DOMAIN.replace(/\/+$/, "")}`;
  const issuers = (e.AUTH_ISSUER ?? `${base}/`)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

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
    authIssuers: issuers,
    authJwksUrl: e.AUTH_JWKS_URL ?? `${base}/.well-known/jwks.json`,
    authAudience: e.AUTH_AUDIENCE,
    port: e.PORT,
    isProduction: e.NODE_ENV === "production",
    github,
  };
}
