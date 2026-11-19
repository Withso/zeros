// The development family's on-disk shapes (the `dev` channel: `pnpm
// electron:local`, `pnpm electron:alpha`, test identities). Plain CommonJS with
// Node built-ins: paths.ts, the launchers and `pnpm storage:inventory` (which
// runs without node_modules) share this one definition.
//
// A new identity (macOS; Linux and Windows use their app-data root):
//   data      ~/Library/Application Support/com.zeros.local/instances/<inst>/
//   session   <data>/electron/  (Electron sessionData; nothing is ever moved in)
//   logs      ~/Library/Logs/com.zeros.local/<inst>/
//   bundle    ~/Library/Caches/com.zeros.local/bundles/<inst>/
//   state     ~/.zeros-local/instances/<inst>/
//   visible   ~/zeros-local-<inst>/{workspaces,design workspaces,cloud-sync}
//   shared    ~/Library/Application Support/com.zeros.local/  (Local provider
//             credentials, instances.json)
//
// Compatibility contracts:
// - `ZEROS_LOCAL_LAYOUT=legacy` is exported only by `pnpm electron:local`, when
//   the identity's pre-registry data folder `com.zeros.local.<inst>` exists. A
//   legacy identity resolves every root exactly as before (data, session and
//   logs under `com.zeros.local.<inst>`, bundle in its state root): its DB and
//   Keychain-bound provider profiles hold absolute paths, so nothing moves.
//   Reserved identities never take it.
// - ZEROS_DATA_DIR, ZEROS_WORKSPACES_DIR and ZEROS_DESIGN_WORKSPACES_DIR replace
//   the data, workspaces and design-workspaces roots (paths.ts).
// - The visible root keeps the flat `zeros-local-<inst>` shape the renderer's
//   managed-path matcher already recognises.
const path = require("node:path");
const { homedir } = require("node:os");

const FAMILY_ID = "com.zeros.local";
const FAMILY_XDG = "zeros-local";
const RESERVED_INSTANCE_IDS = Object.freeze(["alpha", "default"]);
const INSTANCE_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const CHECKOUT_INSTANCE_ID = /^[0-9a-f]{16}$/;

// Same normalization main and paths.ts have always applied to ZEROS_INSTANCE.
function sanitizeInstanceId(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 40);
}

function developmentInstanceId(env = process.env) {
  return sanitizeInstanceId(env.ZEROS_INSTANCE) || "default";
}

function isReservedInstanceId(instance) {
  return RESERVED_INSTANCE_IDS.includes(instance);
}

/** A Local checkout's id: the first 16 hex characters of the SHA-256 of its
 * canonical path. Hosted development identities never take this shape, so
 * account-free Local and hosted Dev can never resolve to one profile. */
function isCheckoutInstanceId(instance) {
  return CHECKOUT_INSTANCE_ID.test(instance);
}

function assertInstanceId(instance) {
  if (typeof instance !== "string" || !INSTANCE_ID.test(instance))
    throw new Error("Invalid Zeros Local instance id");
}

/** `legacy` only when the launcher exported it for a non-reserved identity; it
 * never selects itself. */
function developmentLayout(instance, env = process.env) {
  return env.ZEROS_LOCAL_LAYOUT === "legacy" && !isReservedInstanceId(instance)
    ? "legacy"
    : "v2";
}

function platformRoots({ home, platform, env }) {
  switch (platform) {
    case "darwin":
      return {
        appData: path.join(home, "Library", "Application Support"),
        cache: path.join(home, "Library", "Caches"),
        logs: path.join(home, "Library", "Logs"),
      };
    case "win32":
      return {
        appData: env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        cache: env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
        logs: null,
      };
    default:
      return {
        appData: env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
        cache: env.XDG_CACHE_HOME ?? path.join(home, ".cache"),
        logs: null,
      };
  }
}

/** Every root one development identity owns. */
function developmentPaths({
  instance,
  layout = "v2",
  home = homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  assertInstanceId(instance);
  if (layout !== "v2" && layout !== "legacy")
    throw new Error("Invalid Zeros Local layout");
  const roots = platformRoots({ home, platform, env });
  const reverseDns = platform === "darwin" || platform === "win32";
  const legacy = layout === "legacy";
  const sharedDataDir = path.join(roots.appData, reverseDns ? FAMILY_ID : FAMILY_XDG);
  const bundleId = `${FAMILY_ID}.${instance}`;
  const dataDir = legacy
    ? path.join(roots.appData, reverseDns ? bundleId : `${FAMILY_XDG}-${instance}`)
    : path.join(sharedDataDir, "instances", instance);
  const logDir = roots.logs
    ? legacy
      ? path.join(roots.logs, bundleId)
      : path.join(roots.logs, FAMILY_ID, instance)
    : path.join(dataDir, "logs");
  const stateRoot = localInstanceStateRoot(instance, home);
  const visibleRoot = path.join(home, `${FAMILY_XDG}-${instance}`);
  return {
    instance,
    layout,
    sharedDataDir,
    registryPath: path.join(sharedDataDir, "instances.json"),
    dataDir,
    // Main passes Electron's own cache root for a legacy session (paths.ts).
    sessionDataDir: legacy ? path.join(roots.cache, bundleId) : path.join(dataDir, "electron"),
    logDir,
    stateRoot,
    visibleRoot,
    workspacesRoot: path.join(visibleRoot, "workspaces"),
    designWorkspacesRoot: path.join(visibleRoot, "design workspaces"),
    bundleDir: legacy
      ? path.join(stateRoot, "bundle")
      : path.join(roots.cache, FAMILY_ID, "bundles", instance),
    bundleId,
  };
}

/** The family's shared folders, for the registry and the inventory. */
function developmentContainers({
  home = homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  const roots = platformRoots({ home, platform, env });
  const reverseDns = platform === "darwin" || platform === "win32";
  const shared = path.join(roots.appData, reverseDns ? FAMILY_ID : FAMILY_XDG);
  return {
    home,
    appData: roots.appData,
    cache: roots.cache,
    logs: roots.logs,
    sharedDataDir: shared,
    dataInstances: path.join(shared, "instances"),
    bundles: path.join(roots.cache, FAMILY_ID, "bundles"),
    logInstances: roots.logs ? path.join(roots.logs, FAMILY_ID) : null,
    stateInstances: path.join(home, ".zeros-local", "instances"),
    legacyBundles: path.join(home, ".zeros-local", "dev-instances"),
  };
}

function localInstanceStateRoot(slug, home = homedir()) {
  return path.join(home, ".zeros-local", "instances", slug);
}

function localInstanceBundlePaths({
  slug,
  name,
  home = homedir(),
  layout = "v2",
  platform = "darwin",
}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug) || path.basename(name) !== name)
    throw new Error("Invalid Zeros Local bundle identity");
  const roots = developmentPaths({ instance: slug, layout, home, platform, env: {} });
  const bundlePath = path.join(roots.bundleDir, `${name}.app`);
  return {
    stateRoot: roots.stateRoot,
    bundlePath,
    versionMarker: `${bundlePath}.version`,
    legacyBundleRoot: path.join(home, ".zeros-local", "dev-instances", slug),
  };
}

module.exports = {
  FAMILY_ID,
  RESERVED_INSTANCE_IDS,
  sanitizeInstanceId,
  developmentInstanceId,
  isReservedInstanceId,
  isCheckoutInstanceId,
  developmentLayout,
  developmentPaths,
  developmentContainers,
  localInstanceStateRoot,
  localInstanceBundlePaths,
};
