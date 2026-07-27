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

export type Config = {
  databaseUrl: string;
  authIssuers: string[];
  authJwksUrl: string;
  authAudience: string;
  port: number;
  isProduction: boolean;
};

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
  return {
    databaseUrl: e.DATABASE_URL,
    authIssuers: issuers,
    authJwksUrl: e.AUTH_JWKS_URL ?? `${base}/.well-known/jwks.json`,
    authAudience: e.AUTH_AUDIENCE,
    port: e.PORT,
    isProduction: e.NODE_ENV === "production",
  };
}
