import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";

export const DEV_AUTH_ENV_KEYS = Object.freeze([
  "AUTH_PROVIDER",
  "AUTH_DESKTOP_CLIENT_ID",
  "AUTH_ISSUER",
  "AUTH_JWKS_URL",
  "AUTH_AUDIENCE",
  "VITE_APP_BASE_URL",
  "VITE_CONTROL_PLANE_URL",
]);

const DEV_AUTH_ENV_KEY_SET = new Set(DEV_AUTH_ENV_KEYS);
const ALPHA_APP_ORIGIN = "https://app-alpha.zeros.build";
const ALPHA_API_ORIGIN = "https://api-alpha.zeros.build";
const WORKOS_API_ORIGIN = "https://api.workos.com";
const WORKOS_CLIENT_ID = /^client_[A-Za-z0-9_-]{1,240}$/;
const CONFIG_URL = `${ALPHA_API_ORIGIN}/auth/desktop/dev-config`;
const CACHE_MAX_AGE_MS = 60 * 60_000;
const MAX_CONFIG_BYTES = 8_192;

class DevAuthUnavailableError extends Error {
  /** Mark transport failures that may reuse a previously validated cache. */
  constructor() {
    super(
      "Could not load Alpha sign-in configuration. Check your connection and restart Zeros Dev.",
    );
  }
}

/** Reject incomplete or cross-channel public values without echoing them. */
function assertAlphaProfile(env) {
  const issue = devAuthEnvironmentIssue(env);
  if (issue)
    throw new Error(`Invalid Alpha public sign-in configuration (${issue}).`);
}

/** Trust only a canonical user-owned cache directory; validate its nearest
 * existing ancestor before creating a missing first-use directory. */
function assertDevAuthDirectory(directory) {
  const requested = path.resolve(directory);
  const unsafe = () =>
    new Error(
      "Unsafe Zeros Dev auth profile directory. Use a real directory owned by your user without group or world write permissions.",
    );
  let existing = requested;
  let stat;
  for (;;) {
    try {
      stat = fs.lstatSync(existing);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw unsafe();
      const parent = path.dirname(existing);
      if (parent === existing) throw unsafe();
      existing = parent;
    }
  }
  // A missing first-use directory still needs a canonical ancestor: mkdir
  // must not follow a symlink before the final directory can be checked.
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(existing) !== existing ||
    (existing === requested &&
      ((typeof process.getuid === "function" &&
        stat.uid !== process.getuid()) ||
        (stat.mode & 0o022) !== 0))
  )
    throw unsafe();
}

/** Fetch the fixed Alpha endpoint with bounded time and bytes, then validate
 * its versioned public projection before any value reaches disk or a child. */
async function fetchAlphaProfile(fetchImpl) {
  let response;
  try {
    response = await fetchImpl(CONFIG_URL, {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
      credentials: "omit",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new DevAuthUnavailableError();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new DevAuthUnavailableError();
  }
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Invalid Alpha public sign-in configuration response.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty Alpha public sign-in configuration.");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(() => {
        throw new DevAuthUnavailableError();
      });
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CONFIG_BYTES) {
        throw new Error("Oversized Alpha public sign-in configuration.");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  let document;
  try {
    document = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid Alpha public sign-in configuration response.");
  }
  if (
    document?.version !== 1 ||
    document?.environment !== "alpha" ||
    !document.env ||
    typeof document.env !== "object" ||
    Array.isArray(document.env)
  ) {
    throw new Error("Unsupported Alpha public sign-in configuration.");
  }
  const env = publicAuthValues(document.env);
  assertAlphaProfile(env);
  return env;
}

/** Atomically publish already validated public values in an owner-only file,
 * rechecking directory trust after the request and before the rename. */
function cacheAlphaProfile(filePath, env) {
  const directory = path.dirname(filePath);
  assertDevAuthDirectory(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertDevAuthDirectory(directory);
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    // Every value has passed the exact Alpha contract. Only the public fields
    // are serialized, and rename publishes a complete profile to other launches.
    fs.writeFileSync(
      temporary,
      `${DEV_AUTH_ENV_KEYS.map((key) => `${key}=${env[key]}`).join("\n")}\n`,
      { flag: "wx", mode: 0o600 },
    );
    assertDevAuthDirectory(directory);
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Bootstrap once per Mac, then refresh the public cache at most hourly. An
 * outage retains a validated cache. Invalid configuration never falls back to
 * a different channel or to Auth0, and shell overrides are never persisted. */
export async function ensureDevAuthEnvironment({
  homeDir = os.homedir(),
  processEnv = process.env,
  fetchImpl = fetch,
} = {}) {
  const cached = loadDevAuthEnvironment({ homeDir, processEnv: {} });
  const explicit = publicAuthValues(processEnv);
  const effective = loadDevAuthEnvironment({ homeDir, processEnv });
  if (
    cached.source === "none" &&
    effective.source === "environment" &&
    !effective.issue
  ) {
    return effective;
  }
  if (cached.source !== "none") {
    assertAlphaProfile(cached.env);
    assertAlphaProfile(effective.env);
    const age = Date.now() - fs.statSync(cached.sharedProfilePath).mtimeMs;
    if (age >= 0 && age < CACHE_MAX_AGE_MS) return effective;
  }
  let downloaded;
  try {
    downloaded = await fetchAlphaProfile(fetchImpl);
  } catch (error) {
    if (error instanceof DevAuthUnavailableError && cached.source !== "none") {
      return { ...effective, cachedOffline: true };
    }
    throw error;
  }
  assertAlphaProfile({ ...downloaded, ...explicit });
  cacheAlphaProfile(cached.sharedProfilePath, downloaded);
  return loadDevAuthEnvironment({ homeDir, processEnv });
}

/** Locate the one user-level Alpha public profile shared by Dev checkouts. */
export function devAuthProfilePath(homeDir = os.homedir()) {
  return path.join(homeDir, ".zeros-dev", "auth", "alpha.env");
}

function publicAuthValues(values) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(
        ([name, value]) =>
          DEV_AUTH_ENV_KEY_SET.has(name) && typeof value === "string",
      )
      .map(([name, value]) => [name, value.trim()]),
  );
}

function readPublicAuthFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  let parsed;
  try {
    parsed = parseEnv(fs.readFileSync(filePath, "utf8"));
  } catch {
    // parseEnv diagnostics may echo file content. Keep the launcher error useful
    // without ever printing a value from a developer's environment file.
    throw new Error(
      `Could not read a valid Zeros Dev auth profile at ${filePath}. Expected KEY=value lines.`,
    );
  }
  return publicAuthValues(parsed);
}

function workOSClientFromPath(raw, prefix) {
  let parsed;
  try {
    parsed = new URL(raw ?? "");
  } catch {
    return null;
  }
  if (
    parsed.origin !== WORKOS_API_ORIGIN ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.startsWith(prefix)
  ) {
    return null;
  }
  const clientId = parsed.pathname.slice(prefix.length);
  return WORKOS_CLIENT_ID.test(clientId) ? clientId : null;
}

/**
 * Mirror the main-process Dev boundary at launcher time. This is intentionally
 * Alpha-specific: a source checkout must never inherit Beta or Production auth
 * just because those values happen to be present in a parent shell.
 */
export function devAuthEnvironmentIssue(env) {
  if ((env.AUTH_PROVIDER ?? "").toLowerCase() !== "workos") {
    return "provider";
  }
  if (!WORKOS_CLIENT_ID.test(env.AUTH_DESKTOP_CLIENT_ID ?? "")) {
    return "desktop_client_id";
  }
  if (env.VITE_APP_BASE_URL !== ALPHA_APP_ORIGIN) return "app_origin";
  if (env.VITE_CONTROL_PLANE_URL !== ALPHA_API_ORIGIN) {
    return "control_plane_origin";
  }
  if (env.AUTH_AUDIENCE !== ALPHA_API_ORIGIN) return "audience";

  const issuerClient = workOSClientFromPath(
    env.AUTH_ISSUER,
    "/user_management/",
  );
  const jwksClient = workOSClientFromPath(env.AUTH_JWKS_URL, "/sso/jwks/");
  if (
    !issuerClient ||
    issuerClient !== jwksClient ||
    env.AUTH_DESKTOP_CLIENT_ID === issuerClient
  ) {
    return "token_contract";
  }
  return null;
}

/**
 * Resolve one effective public-client profile for every checkout.
 *
 * The user-level profile is the durable source. Explicitly exported environment
 * variables may override one run, then the final atomic set is validated so a
 * partial override cannot cross environments. Checkout-local files are absent
 * by design: one stale worktree must not survive a shared-client rotation.
 */
export function loadDevAuthEnvironment({
  homeDir = os.homedir(),
  processEnv = process.env,
} = {}) {
  const sharedProfilePath = devAuthProfilePath(homeDir);
  // Both bootstrap reads pass here before the freshness check can trust a
  // cached profile. Validate again when publishing after the network request.
  assertDevAuthDirectory(path.dirname(sharedProfilePath));
  const shared = readPublicAuthFile(sharedProfilePath);
  const explicit = publicAuthValues(processEnv);
  const env = { ...shared, ...explicit };

  const source =
    Object.keys(explicit).length > 0
      ? "environment"
      : Object.keys(shared).length > 0
        ? "shared"
        : "none";

  return {
    env,
    issue: devAuthEnvironmentIssue(env),
    source,
    sharedProfilePath,
  };
}
