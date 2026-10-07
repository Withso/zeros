import { readPrivateJson, privateDirectory } from "./state.mjs";
import { developmentProfilePath, profileExists } from "./profile-path.mjs";
import { workspaceHostnames } from "./cloudflare.mjs";
import { databaseUrl } from "./postgres.mjs";

const CLIENT_ID = /^client_[A-Za-z0-9_-]{1,240}$/;
export function loadProfile(homeDir, { env = process.env } = {}) {
  const file = developmentProfilePath(undefined, { homeDir, env });
  if (!profileExists(file)) {
    throw new Error("Local Dev recovery needs ~/.zeros-dev/zeros-dev-env.json or an explicit ZEROS_DEV_PROFILE_PATH pointing to the original version 1 profile. For hosted Dev, run bash scripts/setup-zeros-dev.sh --profile /path/to/zeros-dev-env.json.");
  }
  const profile = readPrivateJson(file);
  if (profile?.version !== 1) throw new Error("Unsupported Dev configuration version");
  return profile;
}

export function profileIssues(profile, { cloud = false } = {}) {
  const issues = [];
  if (!profile.cloudflare?.accountId || !profile.cloudflare?.zoneId || !profile.cloudflare?.domain || !profile.cloudflare?.apiToken) {
    issues.push("cloudflare: accountId, zoneId, domain and a Tunnel Edit / DNS Edit token are required");
  }
  const auth = profile.workos;
  if (!auth || !CLIENT_ID.test(auth.webClientId ?? "") || !CLIENT_ID.test(auth.desktopClientId ?? "") ||
      auth.webClientId === auth.desktopClientId || typeof auth.apiKey !== "string" || auth.apiKey.length < 16 ||
      ![undefined, "dev", "alpha"].includes(auth.environment)) {
    issues.push("workos: configure Web and Desktop applications and apiKey; select environment alpha explicitly to share Alpha identity");
  }
  if (cloud) {
    const github = profile.github;
    if (!Number.isSafeInteger(github?.appId) || github.appId < 1 ||
        !/^[a-zA-Z0-9-]+$/.test(github.appSlug ?? "") || !github.clientId || !github.clientSecret || !github.privateKeyBase64) {
      issues.push("github: configure the Dev GitHub App identity, OAuth credentials and private key");
    }
    const runtime = profile.cloud;
    if (!profile.boat?.apiKey || !profile.boat?.billingOrg || !runtime?.accountScope || !runtime?.sourceInputsSha256 || !runtime?.sourceCommit || !runtime?.snapshotId || !runtime?.buildSha256 || !runtime?.secondsPerDollar) {
      issues.push("cloud: configure a qualified Dev worker snapshot and matching source/build evidence");
    }
  }
  return issues;
}

export function publicDevProfile(workspace, profile) {
  const issues = profileIssues(profile); if (issues.length) throw new Error(issues.join("\n"));
  const hosts = workspaceHostnames(workspace, profile.cloudflare.domain);
  const auth = profile.workos;
  return {
    version: 1, owner: workspace.state.owner, domain: profile.cloudflare.domain,
    webClientId: auth.webClientId, desktopClientId: auth.desktopClientId,
    authEnvironment: auth.environment ?? "dev",
    audience: auth.environment === "alpha" ? "https://api-alpha.zeros.build" : `https://api-dev.${profile.cloudflare.domain}`,
    appOrigin: `https://${hosts.app}`, apiOrigin: `https://${hosts.api}`,
    issuer: `https://api.workos.com/user_management/${auth.webClientId}`,
    jwksUrl: `https://api.workos.com/sso/jwks/${auth.webClientId}`,
  };
}

export function desktopEnvironment(workspace, profile) {
  const p = publicDevProfile(workspace, profile);
  return {
    ZEROS_DEV_ENVIRONMENT: "local", ZEROS_DEV_AUTH_PROFILE: JSON.stringify(p),
    ZEROS_DEV: "1", ZEROS_CHANNEL: "dev", ZEROS_ISOLATE: "1",
    VITE_ZEROS_CHANNEL: "dev", ZEROS_CONTROL_PLANE_URL: p.apiOrigin,
    ZEROS_INSTANCE: `local-${workspace.state.owner}`,
    ZEROS_DATA_DIR: privateDirectory(workspace.directory, "desktop"),
    AUTH_PROVIDER: "workos", AUTH_DESKTOP_CLIENT_ID: p.desktopClientId,
    AUTH_ISSUER: p.issuer, AUTH_JWKS_URL: p.jwksUrl, AUTH_AUDIENCE: p.audience,
    VITE_APP_BASE_URL: p.appOrigin, VITE_CONTROL_PLANE_URL: p.apiOrigin,
    ZEROS_CLOUD_WORKSPACES_ENABLED: profile.cloud ? "true" : "false",
  };
}

export function backendEnvironment(workspace, profile, ports, runId) {
  const p = publicDevProfile(workspace, profile);
  const secret = workspace.state.workosWebhook?.secret;
  if (typeof secret !== "string" || secret.length < 16) throw new Error("The workspace's WorkOS webhook must be provisioned before API startup");
  const env = {
    NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(ports.api),
    ZEROS_DEV_ENVIRONMENT: "local", ZEROS_DEV_OWNER: p.owner, ZEROS_DEV_RUN_ID: runId,
    ZEROS_DEV_DOMAIN: p.domain, ZEROS_DEV_AUTH_ENVIRONMENT: p.authEnvironment,
    DATABASE_URL: databaseUrl(workspace, ports.database), DATABASE_MIGRATIONS_ON_BOOT: "false",
    AUTH_PROVIDER: "workos", AUTH_WEB_CLIENT_ID: p.webClientId, AUTH_DESKTOP_CLIENT_ID: p.desktopClientId,
    AUTH_ISSUER: p.issuer, AUTH_JWKS_URL: p.jwksUrl, AUTH_AUDIENCE: p.audience,
    APP_ORIGIN: p.appOrigin, INVITE_LINK_BASE: `${p.appOrigin}/invite`,
    WORKOS_API_KEY: profile.workos.apiKey, WORKOS_COOKIE_PASSWORD: workspace.state.keys.cookie,
    WORKOS_WEBHOOK_SECRET: secret, CLOUD_WORKSPACES_ENABLED: "false",
  };
  if (profile.github) {
    const g = profile.github;
    Object.assign(env, { GITHUB_APP_ID: String(g.appId), GITHUB_APP_SLUG: g.appSlug,
      GITHUB_APP_CLIENT_ID: g.clientId, GITHUB_APP_CLIENT_SECRET: g.clientSecret,
      GITHUB_APP_PRIVATE_KEY: Buffer.from(g.privateKeyBase64, "base64").toString("utf8"),
      GITHUB_OAUTH_CALLBACK_URL: `${p.apiOrigin}/v1/github/oauth/callback`,
      GITHUB_COMPLETION_PAGE_URL: `${p.appOrigin}/github/connected`,
    });
  }
  if (profile.cloud) {
    const issues = profileIssues(profile, { cloud: true }); if (issues.length) throw new Error(issues.join("\n"));
    const c = profile.cloud, key = name => Buffer.from(workspace.state.keys[name], "hex").toString("base64url");
    Object.assign(env, {
      CLOUD_WORKSPACES_ENABLED: "true", CLOUD_WORKSPACE_PROVIDER: "boat", CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "true",
      CLOUD_WORKSPACE_CONTROL_PLANE_URL: p.apiOrigin, ZEROS_CLOUD_SOURCE_COMMIT: c.sourceCommit,
      BOAT_API_KEY: profile.boat.apiKey, BOAT_ACCOUNT_SCOPE: c.accountScope, BOAT_BILLING_ORG: profile.boat.billingOrg,
      BOAT_SNAPSHOT_ID: c.snapshotId, BOAT_IMAGE_BUILD_SHA256: c.buildSha256,
      BOAT_TTL_SECONDS: String(c.ttlSeconds ?? 900), BOAT_COMPUTE_POLICY_ID: c.computePolicyId ?? "local-dev",
      BOAT_SECONDS_PER_DOLLAR: String(c.secondsPerDollar), ZEROS_CLOUD_IMAGE_ARCHITECTURE: "linux/amd64",
      CLOUD_WORKSPACE_CPU_MILLICORES: String(c.cpuMillicores ?? 4000),
      CLOUD_WORKSPACE_MEMORY_MIB: String(c.memoryMiB ?? 8192), CLOUD_WORKSPACE_STORAGE_MIB: String(c.storageMiB ?? 20480),
      CLOUD_WORKSPACE_SECRET_KEY_V1: key("settings"),
      CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON: JSON.stringify({ 1: key("agent") }),
      CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION: "1",
      CLOUD_WORKSPACE_OBJECT_KEY_V1: key("objects"), CLOUD_WORKSPACE_OBJECT_STORE_KIND: "filesystem",
      CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY: privateDirectory(workspace.directory, "objects"),
    });
  }
  return env;
}

/** Public-only wrangler bindings. Provider and database credentials belong to
 * the backend, never the web facade, desktop, compiler, renderer or terminal. */
export function webEnvironment(workspace, profile, apiPort) {
  const p = publicDevProfile(workspace, profile);
  return { AUTH_PROVIDER: "workos", APP_ORIGIN: p.appOrigin,
    APP_HOSTS: `${new URL(p.appOrigin).hostname},127.0.0.1,localhost`,
    CONTROL_PLANE_URL: `http://127.0.0.1:${apiPort}` };
}
