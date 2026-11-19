// The development family's on-disk shapes. Plain CommonJS with Node built-ins
// only: paths.ts, the launchers, the prune and `pnpm storage:sweep` (which must
// run in a checkout without node_modules) all import this one definition.
const path = require("node:path");
const { homedir } = require("node:os");

const FAMILY_ID = "com.zeros.local";
const FAMILY_XDG = "zeros-local";
const RESERVED_INSTANCE_IDS = Object.freeze(["alpha", "default"]);
const INSTANCE_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;

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
        preferences: path.join(home, "Library", "Preferences"),
        httpStorages: path.join(home, "Library", "HTTPStorages"),
        webKit: path.join(home, "Library", "WebKit"),
        savedState: path.join(home, "Library", "Saved Application State"),
      };
    case "win32":
      return {
        appData: env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        cache: env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
        logs: null,
        preferences: null,
        httpStorages: null,
        webKit: null,
        savedState: null,
      };
    default:
      return {
        appData: env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
        cache: env.XDG_CACHE_HOME ?? path.join(home, ".cache"),
        logs: null,
        preferences: null,
        httpStorages: null,
        webKit: null,
        savedState: null,
      };
  }
}

/** Every root one development identity owns. `legacy` is the pre-registry
 * shape whose databases and Keychain-bound provider profiles hold absolute
 * paths, so it is resolved in place rather than moved. */
function developmentPaths({
  instance,
  layout = "v2",
  home = homedir(),
  platform = process.platform,
  env = process.env,
  cacheRoot,
} = {}) {
  assertInstanceId(instance);
  if (layout !== "v2" && layout !== "legacy")
    throw new Error("Invalid Zeros Local layout");
  const roots = platformRoots({ home, platform, env });
  const reverseDns = platform === "darwin" || platform === "win32";
  const legacy = layout === "legacy";
  const sharedDataDir = path.join(roots.appData, reverseDns ? FAMILY_ID : FAMILY_XDG);
  const dataDir = legacy
    ? path.join(roots.appData, reverseDns ? `${FAMILY_ID}.${instance}` : `${FAMILY_XDG}-${instance}`)
    : path.join(sharedDataDir, "instances", instance);
  const cacheBase = cacheRoot ?? roots.cache;
  const cacheDir = legacy
    ? path.join(cacheBase, `${FAMILY_ID}.${instance}`)
    : path.join(cacheBase, FAMILY_ID, "instances", instance);
  const logDir = roots.logs
    ? legacy
      ? path.join(roots.logs, `${FAMILY_ID}.${instance}`)
      : path.join(roots.logs, FAMILY_ID, instance)
    : path.join(dataDir, "logs");
  const stateRoot = localInstanceStateRoot(instance, home);
  const visibleRoot = legacy
    ? path.join(home, `${FAMILY_XDG}-${instance}`)
    : path.join(home, FAMILY_XDG, instance);
  const bundleId = `${FAMILY_ID}.${instance}`;
  return {
    instance,
    layout,
    sharedDataDir,
    registryPath: path.join(sharedDataDir, "instances.json"),
    dataDir,
    cacheDir,
    // Phase 3 moves renderer session data under the data dir.
    sessionDataDir: cacheDir,
    logDir,
    stateRoot,
    visibleRoot,
    workspacesRoot: path.join(visibleRoot, "workspaces"),
    designWorkspacesRoot: path.join(visibleRoot, "design workspaces"),
    bundleDir: legacy
      ? path.join(stateRoot, "bundle")
      : path.join(roots.cache, FAMILY_ID, "bundles", instance),
    bundleId,
    preferencesFile: roots.preferences
      ? path.join(roots.preferences, `${bundleId}.plist`)
      : null,
    // macOS creates these from the bundle id; all regenerable.
    httpStorageDir: roots.httpStorages ? path.join(roots.httpStorages, bundleId) : null,
    webKitDir: roots.webKit ? path.join(roots.webKit, bundleId) : null,
    savedStateDir: roots.savedState ? path.join(roots.savedState, `${bundleId}.savedState`) : null,
  };
}

/** The containers a removal target must sit directly inside, for prune/sweep
 * containment checks. */
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
    preferences: roots.preferences,
    httpStorages: roots.httpStorages,
    webKit: roots.webKit,
    savedState: roots.savedState,
    sharedDataDir: shared,
    dataInstances: path.join(shared, "instances"),
    cacheInstances: path.join(roots.cache, FAMILY_ID, "instances"),
    bundles: path.join(roots.cache, FAMILY_ID, "bundles"),
    logInstances: roots.logs ? path.join(roots.logs, FAMILY_ID) : null,
    stateInstances: path.join(home, ".zeros-local", "instances"),
    visibleInstances: path.join(home, FAMILY_XDG),
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
    bundleDir: roots.bundleDir,
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
  developmentLayout,
  developmentPaths,
  developmentContainers,
  localInstanceStateRoot,
  localInstanceBundlePaths,
};
