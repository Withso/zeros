// `pnpm electron:alpha`: ONE hosted development instance for every checkout.
// It keeps the dev channel (Alpha sign-in, dev ports, zeros-dev://) and is
// never account-free; only its on-disk identity lives in the development
// family (docs/storage-layout.md).
import os from "node:os";
import { createRequire } from "node:module";
import { acquireCheckoutLock, acquireLease, appRunning } from "./local-instance-lease.mjs";
import { registryPath, upsertInstance } from "./local-instance-registry.mjs";
import { pruneDevelopmentInstances } from "./local-instance-prune.mjs";

const require = createRequire(import.meta.url);
const paths = require("../apps/desktop/src/engine/db/local-development-paths.cjs");
const bundle = require("./dev-electron-bundle.cjs");

export const ALPHA_INSTANCE = "alpha";
export const ALPHA_NAME = "Zeros Local Alpha";

// Anything that would select another identity, Local admission, a legacy
// layout or another secret store. Main decides the rest.
const FOREIGN_IDENTITY = [
  "ZEROS_INSTANCE",
  "ZEROS_INSTANCE_NAME",
  "ZEROS_LOCAL_DEVELOPMENT",
  "ZEROS_LOCAL_LAYOUT",
  "ZEROS_ISOLATE",
  "ZEROS_SHARED_SECRETS_DIR",
  "ZEROS_DATA_DIR",
  "ZEROS_WORKSPACES_DIR",
  "ZEROS_DESIGN_WORKSPACES_DIR",
];

export function alphaInstanceEnvironment(environment) {
  const env = { ...environment };
  for (const key of FOREIGN_IDENTITY) delete env[key];
  return { ...env, ZEROS_INSTANCE: ALPHA_INSTANCE, ZEROS_INSTANCE_NAME: ALPHA_NAME };
}

/** Claim the one alpha identity and this checkout's builds, then register.
 * Throws before any build or auth refresh when either is in use. Returns the
 * release, to be called once the whole app stack has exited. */
export function prepareAlphaLaunch({
  home = os.homedir(),
  root = process.cwd(),
  platform = process.platform,
  log = (line) => console.warn(`[electron:alpha] ${line}`),
} = {}) {
  const roots = paths.developmentPaths({ instance: ALPHA_INSTANCE, home, platform, env: {} });
  const busy = `${ALPHA_NAME} (pnpm electron:alpha) is already running. It is one profile for every checkout; quit it before launching again.`;
  if (appRunning(roots)) throw new Error(busy);
  const releaseCheckout = acquireCheckoutLock(root, { instance: ALPHA_INSTANCE });
  let releaseLease;
  try {
    releaseLease = acquireLease(roots, { busyMessage: busy, record: { instance: ALPHA_INSTANCE } });
  } catch (error) {
    releaseCheckout();
    throw error;
  }
  try {
    upsertInstance(registryPath({ home, platform, env: {} }), ALPHA_INSTANCE,
      { kind: "alpha", name: ALPHA_NAME, checkout: null, layout: "v2" }, { timeoutMs: 250 });
  } catch {
    log("instance registry is busy or unavailable; continuing");
  }
  return () => {
    try {
      releaseLease();
    } finally {
      releaseCheckout();
    }
  };
}

/** The launcher prune, started once the app stack is running. Never throws. */
export async function startAlphaPrune({
  home = os.homedir(),
  platform = process.platform,
  prune = pruneDevelopmentInstances,
} = {}) {
  try {
    return await prune({ home, platform, env: {}, currentInstance: ALPHA_INSTANCE, electronVersion: bundle.currentElectronVersion() });
  } catch {
    return [];
  }
}

/** Best-effort native bundle with the Dev callback scheme; null falls back to
 * the stock Electron binary. */
export function prepareAlphaBundle({ home = os.homedir() } = {}) {
  try {
    const result = bundle.prepareLocalInstanceBundle({
      slug: ALPHA_INSTANCE,
      name: ALPHA_NAME,
      callbackScheme: true,
      paths: bundle.localInstanceBundlePaths({ slug: ALPHA_INSTANCE, name: ALPHA_NAME, home }),
    });
    return result?.ok ? result.binPath : null;
  } catch (error) {
    console.warn(`[electron:alpha] bundle prep failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}
