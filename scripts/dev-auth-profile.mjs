import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

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
