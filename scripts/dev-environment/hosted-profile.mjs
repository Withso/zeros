import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readPrivateJson, privateDirectory, writePrivateFile } from "./state.mjs";
import { developmentProfilePath, profileExists, PROFILE_NAME, assertIgnoredProfileDestination } from "./profile-path.mjs";
import { publicDevProfile } from "./profile.mjs";
import { fixtureIssues } from "./hosted-fixtures.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BUCKET = /^(?=.*(?:^|-)dev(?:-|$))(?!.*(?:^|-)(?:alpha|beta|prod|production)(?:-|$))[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** Cloud injection is a fallback only; never replace an existing registry key.
 * Local Conductor Files to copy does not populate cloud workspaces. */
export function hostedProfilePath(root, { env = process.env, homeDir } = {}) {
  const file = developmentProfilePath(root, { env, homeDir });
  if (profileExists(file) || env.ZEROS_DEV_PROFILE_PATH || !env.ZEROS_DEV_PROFILE_B64) return file;
  let bytes, profile;
  try {
    const encoded = env.ZEROS_DEV_PROFILE_B64;
    if (typeof encoded !== "string" || encoded.length > 174764) throw new Error();
    bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.length > 128 * 1024 || bytes.toString("base64") !== encoded) throw new Error();
    profile = JSON.parse(bytes.toString("utf8"));
  } catch { throw new Error("ZEROS_DEV_PROFILE_B64 must encode valid portable JSON smaller than 128 KiB; contents withheld"); }
  if (hostedProfileIssues(profile).length || /YOUR_|GENERATE_32_|"your-/i.test(JSON.stringify(profile))) throw new Error("ZEROS_DEV_PROFILE_B64 contains an invalid hosted profile or example placeholders; contents withheld");
  assertIgnoredProfileDestination(root);
  const destination = path.join(root, PROFILE_NAME);
  writePrivateFile(destination, bytes, { create: true });
  if (!isDeepStrictEqual(readPrivateJson(destination), profile)) throw new Error("A concurrent Dev profile import differs; reconcile the existing registry key before retrying");
  return destination;
}

export function loadHostedProfile(root, options = {}) {
  const file = hostedProfilePath(root, options);
  if (!profileExists(file)) throw new Error("Run bash scripts/setup-zeros-dev.sh --profile /path/to/zeros-dev-env.json. Use zeros-dev-env-example.json for the required fields. Dev never falls back to the Alpha backend.");
  const profile = readPrivateJson(file);
  const issues = hostedProfileIssues(profile);
  if (issues.length) throw new Error(issues.join("\n"));
  return profile;
}

export function hostedProfileIssues(p) {
  const issues = [];
  if (p?.version !== 2 || p.mode !== "hosted") return ["Use version 2, mode hosted for Railway/PlanetScale Dev; the local tunnel profile is a separate mode"];
  const c = p.cloudflare, r = p.railway, db = p.planetscale, w = p.workos, g = p.github, b = p.boat;
  if (!ID.test(c?.accountId ?? "") || !ID.test(c?.zoneId ?? "") || !c.apiToken ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(c?.domain ?? "") || c.domain.length > 180) issues.push("cloudflare: accountId, zoneId, domain and a Pages Edit / DNS Edit token are required");
  if (!UUID.test(r?.projectId ?? "") || !UUID.test(r?.serviceId ?? "") || !r.apiToken ||
      !Array.isArray(r?.protectedEnvironmentIds) || !r.protectedEnvironmentIds.length || r.protectedEnvironmentIds.some(id => !UUID.test(id))) issues.push("railway: set projectId, serviceId, protectedEnvironmentIds and a workspace API token (an Alpha project token cannot provision Dev)");
  if (!NAME.test(db?.organization ?? "") || !NAME.test(db?.database ?? "") || !NAME.test(db?.protectedBranch ?? "") ||
      !db.tokenId || !db.token || db.clusterSize !== "development" || !db.region) issues.push('planetscale: configure the PostgreSQL database, protectedBranch, region, clusterSize "development" and branch/role provisioning service token');
  for (const kind of ["registry", "storage"]) {
    const s = p[kind];
    if (s?.endpoint !== `https://${c?.accountId}.r2.cloudflarestorage.com` || !BUCKET.test(s?.bucket ?? "") || !s.accessKeyId || !s.secretAccessKey) issues.push(`${kind}: configure a dedicated Dev R2 bucket and scoped S3 credentials`);
  }
  if (!HEX.test(p.registry?.encryptionKey ?? "") || p.registry?.bucket === p.storage?.bucket) issues.push("registry: use a separate bucket and a shared 32-byte encryptionKey (hex)");
  if (!["alpha", "dev"].includes(w?.environment) || !/^client_[A-Za-z0-9_-]+$/.test(w?.webClientId ?? "") ||
      !/^client_[A-Za-z0-9_-]+$/.test(w?.desktopClientId ?? "") || w.webClientId === w.desktopClientId || !w.apiKey) issues.push("workos: configure distinct Web/Desktop clients and explicitly select alpha to reuse Alpha identity");
  if (!Number.isSafeInteger(g?.appId) || g.appId < 1 || !/^[a-zA-Z0-9-]+$/.test(g?.appSlug ?? "") || !g.clientId || !g.clientSecret || !g.privateKeyBase64) issues.push("github: configure the selected GitHub App and OAuth credentials");
  if (!b?.apiKey || !b.billingOrg || !b.accountScope || !NAME.test(b.baseSnapshot ?? "") ||
      !Number.isFinite(b.secondsPerDollar) || b.secondsPerDollar <= 0 ||
      !Number.isFinite(b.builderBudgetHours) || b.builderBudgetHours <= 0 || b.builderBudgetHours > 2) issues.push("boat: configure API/billing identity, baseSnapshot, secondsPerDollar and builderBudgetHours (0–2 hours)");
  if(p.connections && (p.connections.enabled!==true || p.connections.cutover!=="connect-once" || !UUID.test(p.connections.projectId??"") || p.connections.projectId===r?.projectId ||
      Object.keys(p.connections).some(key=>!["enabled","cutover","projectId"].includes(key)))) issues.push("connections: use a separate protected projectId and connect-once cutover; operator secrets cannot enter this profile");
  return [...issues, ...fixtureIssues(p.fixture)];
}

export const hostedPublicProfile = (state, profile) => publicDevProfile({ state }, profile);

export function hostedDesktopEnvironment(state, profile, directory) {
  const p = hostedPublicProfile(state, profile);
  return { ...(profile.connections?.enabled?{ZEROS_DEV_CONNECTIONS_ENABLED:"true",ZEROS_DEV_GITHUB_REFERENCE_MODE:"true",ZEROS_DEV_GENERATION:state.generation}:{}), ZEROS_DEV_ENVIRONMENT: "hosted", ZEROS_DEV_AUTH_PROFILE: JSON.stringify(p),
    ZEROS_DEV: "1", ZEROS_CHANNEL: "dev", VITE_ZEROS_CHANNEL: "dev", ZEROS_ISOLATE: "1",
    ZEROS_DEV_NODE_EXECUTABLE: process.execPath,
    ZEROS_INSTANCE: `dev-${state.owner}-${state.generation}`, ZEROS_DATA_DIR: privateDirectory(directory, `desktop-${state.generation}`),
    ZEROS_CONTROL_PLANE_URL: p.apiOrigin, AUTH_PROVIDER: "workos", AUTH_DESKTOP_CLIENT_ID: p.desktopClientId,
    AUTH_ISSUER: p.issuer, AUTH_JWKS_URL: p.jwksUrl, AUTH_AUDIENCE: p.audience,
    VITE_APP_BASE_URL: p.appOrigin, VITE_CONTROL_PLANE_URL: p.apiOrigin, ZEROS_CLOUD_WORKSPACES_ENABLED: "true" };
}

export function hostedBackendEnvironment(state, profile, source, worker) {
  const p = hostedPublicProfile(state, profile), roles = state.resources.planetscale?.roles;
  if (!roles?.runtime?.url || !state.resources.workos?.secret || !state.runId ||
      worker.inputsSha256 !== source.workerInputsSha256 || !HEX.test(worker.buildSha256 ?? "")) throw new Error("Dev deployment is missing its database, webhook or qualified matching worker");
  const url = new URL(roles.runtime.url), key = name => Buffer.from(state.keys[name], "hex").toString("base64url");
  if(profile.connections?.enabled && (!state.connectionRegistered || !state.connectionBackendEnvironment)) throw new Error("Register the Dev connection generation before backend deployment");
  return { ...(profile.connections?.enabled?{ZEROS_DEPLOY_ENV:"dev",ZEROS_DEV_CONNECTIONS_ENABLED:"true",...state.connectionBackendEnvironment}:{}), NODE_ENV: "production", HOST: "0.0.0.0", PORT: "3000",
    ZEROS_DEV_ENVIRONMENT: "hosted", ZEROS_DEV_OWNER: state.owner, ZEROS_DEV_GENERATION: state.generation, ZEROS_DEV_RUN_ID: state.runId,
    ...((state.fixture?.endsAt || state.expiresAt) ? { ZEROS_DEV_ADMISSION_EXPIRES_AT: new Date(Math.min(
      ...[state.fixture?.endsAt, state.expiresAt].filter(Boolean).map(value => Date.parse(value)))).toISOString() } : {}),
    ZEROS_DEV_DOMAIN: p.domain, ZEROS_DEV_AUTH_ENVIRONMENT: p.authEnvironment,
    ZEROS_DEV_RAILWAY_PROJECT_ID: profile.railway.projectId, ZEROS_DEV_RAILWAY_ENVIRONMENT_ID: state.resources.railway.id,
    ZEROS_DEV_SOURCE_SHA256: source.sourceSha256, ZEROS_DEV_WORKER_INPUTS_SHA256: source.workerInputsSha256,
    ZEROS_DEV_DATABASE_HOST: url.hostname, ZEROS_DEV_DATABASE_USER: decodeURIComponent(url.username),
    DATABASE_URL: roles.runtime.url, DATABASE_MIGRATIONS_ON_BOOT: "false",
    AUTH_PROVIDER: "workos", AUTH_WEB_CLIENT_ID: p.webClientId, AUTH_DESKTOP_CLIENT_ID: p.desktopClientId,
    AUTH_ISSUER: p.issuer, AUTH_JWKS_URL: p.jwksUrl, AUTH_AUDIENCE: p.audience,
    APP_ORIGIN: p.appOrigin, INVITE_LINK_BASE: `${p.appOrigin}/invite`,
    WORKOS_API_KEY: profile.workos.apiKey, WORKOS_COOKIE_PASSWORD: state.keys.cookie, WORKOS_WEBHOOK_SECRET: state.resources.workos.secret,
    GITHUB_APP_ID: String(profile.github.appId), GITHUB_APP_SLUG: profile.github.appSlug,
    GITHUB_APP_CLIENT_ID: profile.github.clientId, GITHUB_APP_CLIENT_SECRET: profile.github.clientSecret,
    GITHUB_APP_PRIVATE_KEY: Buffer.from(profile.github.privateKeyBase64, "base64").toString("utf8"),
    GITHUB_OAUTH_CALLBACK_URL: `${p.apiOrigin}/v1/github/oauth/callback`, GITHUB_COMPLETION_PAGE_URL: `${p.appOrigin}/github/connected`,
    CLOUD_WORKSPACES_ENABLED: "true", CLOUD_WORKSPACE_PROVIDER: "boat", CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "true",
    CLOUD_WORKSPACE_CONTROL_PLANE_URL: p.apiOrigin, ZEROS_CLOUD_SOURCE_COMMIT: worker.sourceCommit,
    BOAT_API_KEY: profile.boat.apiKey, BOAT_ACCOUNT_SCOPE: profile.boat.accountScope, BOAT_BILLING_ORG: profile.boat.billingOrg,
    BOAT_SNAPSHOT_ID: worker.snapshotId, BOAT_IMAGE_BUILD_SHA256: worker.buildSha256,
    BOAT_TTL_SECONDS: "900", BOAT_COMPUTE_POLICY_ID: "hosted-dev", BOAT_SECONDS_PER_DOLLAR: String(profile.boat.secondsPerDollar),
    ZEROS_CLOUD_IMAGE_ARCHITECTURE: "linux/amd64", CLOUD_WORKSPACE_CPU_MILLICORES: "4000", CLOUD_WORKSPACE_MEMORY_MIB: "8192",
    CLOUD_WORKSPACE_STORAGE_MIB: String(worker.storageMiB),
    CLOUD_WORKSPACE_SECRET_KEY_V1: key("settings"), CLOUD_WORKSPACE_OBJECT_KEY_V1: key("objects"),
    // This generation's separate agent key was reserved in the original Dev
    // receipt. Keep refresh-family fingerprints stable across redeploys and
    // independent of credential encryption key rotation.
    CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON: JSON.stringify({ 1: key("agent") }),
    CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION: "1",
    CLOUD_WORKSPACE_OBJECT_STORE_KIND: "s3", CLOUD_WORKSPACE_S3_ENDPOINT: profile.storage.endpoint, CLOUD_WORKSPACE_S3_BUCKET: profile.storage.bucket,
    CLOUD_WORKSPACE_S3_ACCESS_KEY_ID: profile.storage.accessKeyId, CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY: profile.storage.secretAccessKey,
    CLOUD_WORKSPACE_S3_KEY_PREFIX: `dev/${state.owner}/${state.generation}/` };
}

export function hostedWebEnvironment(state, profile) {
  const p = hostedPublicProfile(state, profile);
  return { CF_PAGES: "1", CF_PAGES_BRANCH: "dev", ZEROS_DEPLOY_ENV: "dev", AUTH_PROVIDER: "workos",
    ZEROS_DEV_OWNER: state.owner, ZEROS_DEV_GENERATION: state.generation, ZEROS_DEV_DOMAIN: p.domain,
    APP_ORIGIN: p.appOrigin, APP_HOSTS: new URL(p.appOrigin).hostname, CONTROL_PLANE_URL: p.apiOrigin };
}
