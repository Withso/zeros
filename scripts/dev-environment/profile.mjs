import { readPrivateJson, privateDirectory } from "./state.mjs";
import { developmentProfilePath, profileExists } from "./profile-path.mjs";
import { workspaceHostnames } from "./cloudflare.mjs";
import { databaseUrl } from "./postgres.mjs";
import { cloudCredentialKeyring, cloudV2RuntimeSha256, cloudV2WorkerSigningKey } from "./cloud-v2-keys.mjs";

const CLIENT_ID = /^client_[A-Za-z0-9_-]{1,240}$/;
/** A version 1 local profile is returned unchanged. A version 2 hosted profile
 * also carries Railway, PlanetScale and registry authority, which electron:cloud
 * never uses, so only these sections survive before any process sees it. */
const LOCAL_SECTIONS = ["cloudflare", "workos", "github", "boat", "storage", "fixture"];
export function loadProfile(homeDir, { env = process.env, root } = {}) {
  const file = developmentProfilePath(root, { homeDir, env });
  if (!profileExists(file)) {
    throw new Error("electron:cloud needs zeros-dev-env.json in the checkout or ~/.zeros-dev, or ZEROS_DEV_PROFILE_PATH. Use scripts/dev-environment/profile.example.json for the fields.");
  }
  const profile = readPrivateJson(file);
  if (profile?.version === 1) return profile;
  if (profile?.version !== 2) throw new Error("Unsupported Dev configuration version");
  return Object.fromEntries([["version", 1], ...LOCAL_SECTIONS.filter(name => profile[name] !== undefined).map(name => [name, profile[name]])]);
}

export function profileIssues(profile) {
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
    ZEROS_CLOUD_WORKSPACES_ENABLED: "true",
  };
}

/** electron:cloud runs this branch's cloud v2 against its own tunnel origin. The
 * Boat key and runtime store stay in the backend; the VM fetches the pinned
 * runtime by presigned URL and trusts only this workspace's signing key. */
function cloudV2Environment(workspace, profile, apiOrigin, env) {
  const runtime = cloudV2RuntimeSha256(env);
  const b = profile.boat, s = profile.storage;
  if (!b?.apiKey) throw new Error("electron:cloud needs the private profile's boat.apiKey (and billingOrg for an organization wallet)");
  if (!s?.endpoint || !s.bucket || !s.accessKeyId || !s.secretAccessKey)
    throw new Error("electron:cloud needs the private profile's storage endpoint, bucket, accessKeyId and secretAccessKey for worker runtimes");
  return {
    CLOUD_V2_ENABLED: "true", CLOUD_V2_API_URL: apiOrigin, CLOUD_V2_REALTIME_URL: apiOrigin.replace(/^https:/, "wss:"),
    CLOUD_V2_PROMPT_OUTBOX_ENABLED: env.CLOUD_V2_PROMPT_OUTBOX_ENABLED ?? "true",
    CLOUD_V2_RUNTIME_SHA256: runtime, CLOUD_V2_RUNTIME_STORE_ENDPOINT: s.endpoint, CLOUD_V2_RUNTIME_STORE_BUCKET: s.bucket,
    CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID: s.accessKeyId, CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY: s.secretAccessKey,
    BOAT_API_KEY: b.apiKey, ...(b.billingOrg ? { BOAT_BILLING_ORG: b.billingOrg } : {}),
    CLOUD_V2_WORKER_SIGNING_KEY: cloudV2WorkerSigningKey(workspace.state),
    ...cloudCredentialKeyring(workspace.state),
  };
}

export function backendEnvironment(workspace, profile, ports, runId, processEnv = process.env) {
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
    WORKOS_WEBHOOK_SECRET: secret,
    ...cloudV2Environment(workspace, profile, p.apiOrigin, processEnv),
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
