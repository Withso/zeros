import { z } from "zod";
import type { AuthTokenContractConfig } from "../auth-token-contract.js";
import type { CloudAgentCredentialKeys } from "../cloud-workspaces/agent-credential-envelope.js";
import type { GithubConfig } from "./github.js";
export type DevConnectionsConfig = {
  databaseUrl: string;
  port: number;
  origin: string;
  provisionerToken: string;
  keys: CloudAgentCredentialKeys;
  auth: AuthTokenContractConfig & {
    jwksUrl: string;
    apiKey: string;
    organization: string;
  };
  github: GithubConfig;
};
export function devConnectionsEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env.ZEROS_DEPLOY_ENV === "dev" &&
    env.ZEROS_DEV_CONNECTIONS_ENABLED === "true"
  );
}
export function loadDevConnectionsConfig(
  env: NodeJS.ProcessEnv = process.env,
): DevConnectionsConfig {
  const fail = (): never => {
    throw new Error("Invalid Dev connections configuration");
  };
  if (
    !devConnectionsEnabled(env) ||
    (env.RAILWAY_ENVIRONMENT_NAME &&
      env.RAILWAY_ENVIRONMENT_NAME !== "zeros-dev-connections")
  )
    fail();
  const required = (name: string) => {
    const value = env[name];
    if (!value) return fail();
    return value;
  };
  const https = (value: string) => {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        fail();
      return value;
    } catch {
      return fail();
    }
  };
  const keyring = (name: string) => {
    try {
      const raw = z
        .object({
          currentKeyVersion: z.number().int().positive(),
          keys: z.record(
            z.string().regex(/^[1-9][0-9]*$/),
            z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          ),
        })
        .strict()
        .parse(JSON.parse(required(name)));
      if (
        !raw.keys[raw.currentKeyVersion] ||
        Object.values(raw.keys).some(
          (k) => Buffer.from(k, "base64url").toString("base64url") !== k,
        )
      )
        fail();
      return raw;
    } catch {
      return fail();
    }
  };
  const keys = keyring("DEV_CONNECTIONS_ENCRYPTION_KEYS"),
    fingerprints = keyring("DEV_CONNECTIONS_FINGERPRINT_KEYS");
  if (
    Object.values(keys.keys).some((k) =>
      Object.values(fingerprints.keys).includes(k),
    )
  )
    fail();
  const origin = https(required("DEV_CONNECTIONS_ORIGIN"));
  if (new URL(origin).origin !== origin) fail();
  const webClientId = required("DEV_CONNECTIONS_WORKOS_WEB_CLIENT_ID"),
    desktopClientId = required("DEV_CONNECTIONS_WORKOS_DESKTOP_CLIENT_ID");
  if (
    !/^client_[A-Za-z0-9_-]+$/.test(webClientId) ||
    !/^client_[A-Za-z0-9_-]+$/.test(desktopClientId) ||
    webClientId === desktopClientId
  )
    fail();
  const issuer = https(required("DEV_CONNECTIONS_WORKOS_ISSUER")),
    jwksUrl = https(required("DEV_CONNECTIONS_WORKOS_JWKS_URL"));
  if (
    issuer !== `https://api.workos.com/user_management/${webClientId}` ||
    jwksUrl !== `https://api.workos.com/sso/jwks/${webClientId}`
  )
    fail();
  const provisionerToken = required("DEV_CONNECTIONS_PROVISIONER_TOKEN");
  if (!/^[A-Za-z0-9_-]{43}$/.test(provisionerToken)) fail();
  const databaseUrl = required("DEV_CONNECTIONS_DATABASE_URL");
  try {
    if (!["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol))
      fail();
  } catch {
    fail();
  }
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail();
  const organization = required("DEV_CONNECTIONS_WORKOS_ORGANIZATION_ID");
  if (!/^org_[A-Za-z0-9_-]+$/.test(organization)) fail();
  return {
    databaseUrl,
    origin,
    port,
    provisionerToken,
    keys: { ...keys, refreshFingerprints: fingerprints },
    auth: {
      issuer,
      jwksUrl,
      organization,
      webClientId,
      desktopClientId,
      audience: https(required("DEV_CONNECTIONS_WORKOS_AUDIENCE")),
      apiKey: required("DEV_CONNECTIONS_WORKOS_API_KEY"),
    },
    github: {
      appId: required("DEV_CONNECTIONS_GITHUB_APP_ID"),
      clientId: required("DEV_CONNECTIONS_GITHUB_CLIENT_ID"),
      clientSecret: required("DEV_CONNECTIONS_GITHUB_CLIENT_SECRET"),
    },
  };
}
