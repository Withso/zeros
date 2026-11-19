// `pnpm electron:alpha`: ONE hosted development instance for every checkout.
// It keeps the dev channel (Alpha sign-in, dev ports, zeros-dev://) and is
// never account-free; only its on-disk identity lives in the development
// family (docs/storage-layout.md).
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { acquireExclusiveLock, launcherOwnerClassifier } from "./exclusive-file-lock.mjs";
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

/** Take the single-instance launcher lock, then register and prune. Returns
 * the lock release. Throws before any build when another launch is live. */
export function prepareAlphaLaunch({
  home = os.homedir(),
  platform = process.platform,
  prune = pruneDevelopmentInstances,
  log = (line) => console.warn(`[electron:alpha] ${line}`),
} = {}) {
  const roots = paths.developmentPaths({ instance: ALPHA_INSTANCE, home, platform, env: {} });
  const release = acquireExclusiveLock({
    file: path.join(roots.stateRoot, "launcher.lock"),
    record: { instance: ALPHA_INSTANCE },
    classify: launcherOwnerClassifier(
      "dev-environment/launcher.mjs",
      `The ${ALPHA_NAME} launcher lock is incomplete; quit ${ALPHA_NAME} before removing ${path.join(roots.stateRoot, "launcher.lock")}.`,
      `Invalid ${ALPHA_NAME} launcher lock.`,
    ),
    busyMessage: `${ALPHA_NAME} (pnpm electron:alpha) is already running. It is one profile for every checkout; quit it before launching again.`,
    recoveryBusyMessage: `${ALPHA_NAME} lock recovery is already in progress; retry after it completes.`,
    changedMessage: `${ALPHA_NAME} launcher lock changed; retry.`,
  });
  try {
    upsertInstance(registryPath({ home, platform, env: {} }), ALPHA_INSTANCE, {
      kind: "alpha",
      name: ALPHA_NAME,
      checkout: null,
      layout: "v2",
    });
  } catch {
    log("instance registry is unavailable; continuing");
  }
  try {
    prune({ home, platform, env: {}, currentInstance: ALPHA_INSTANCE, electronVersion: bundle.currentElectronVersion() });
  } catch {
    log("development prune skipped");
  }
  return release;
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
