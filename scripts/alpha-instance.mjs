// `pnpm electron:alpha`: ONE hosted development instance, `alpha`, for every
// checkout. It keeps the dev channel (Alpha sign-in, dev ports, zeros-dev://)
// and is never account-free; only its on-disk identity lives in the
// development family (local-development-paths.cjs). Rules:
// - One profile: a second launch from any checkout is refused before auth or
//   build work, while the first launcher or its app (Chromium's SingletonLock)
//   is alive. The lock is `~/.zeros-local/instances/alpha/launcher.lock`.
// - Local and alpha from one checkout share its build outputs, so they take
//   the same `.context/zeros-local/launcher.lock`.
// - The retired Zeros Dev desktop profile (`com.zeros.dev`) is never imported;
//   signing in to Alpha once is expected. Only its Design font cache is
//   carried over, once, because offline Design frames would otherwise lose it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { acquireCheckoutLauncherLock, acquireLauncherLock, pidAlive } from "./exclusive-file-lock.mjs";
import { registryPath, upsertInstance } from "./local-instance-registry.mjs";

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

/** True while alpha's app may be running: its SingletonLock (`<host>-<pid>`)
 * names a live process here, or cannot be read. A lock naming another host
 * (for example after the Mac was renamed) also counts; quit the app, or remove
 * that one link once no Zeros Local Alpha is running. */
function appRunning(dataDir, hostname = os.hostname()) {
  let link;
  try {
    link = fs.readlinkSync(path.join(dataDir, "SingletonLock"));
  } catch (error) {
    return error.code !== "ENOENT";
  }
  const match = /^(.+)-(\d+)$/.exec(link);
  if (!match || match[1] !== hostname) return true;
  return pidAlive(Number(match[2]));
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
  if (appRunning(roots.dataDir)) throw new Error(busy);
  const releaseCheckout = acquireCheckoutLauncherLock(root, { instance: ALPHA_INSTANCE });
  let releaseIdentity;
  try {
    releaseIdentity = acquireLauncherLock(path.join(roots.stateRoot, "launcher.lock"), {
      busyMessage: busy,
      record: { instance: ALPHA_INSTANCE },
    });
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
  try {
    importHostedFontCache({ home, platform });
  } catch {
    log("the old Design font cache could not be carried over; fonts download again");
  }
  return () => {
    try {
      releaseIdentity();
    } finally {
      releaseCheckout();
    }
  };
}

const CACHED_FONT_CSS = /^[0-9a-f]{32}\.css$/;

/** Copy hosted Dev's old Design font cache (`<app data>/com.zeros.dev/design-fonts`,
 * which style-fonts.ts named after the family data dir) into the family's,
 * once: only while the new folder does not exist, only regular cached
 * stylesheets, through a private folder renamed into place. The old cache is
 * left as it was. Returns "imported", "kept" (already there) or "none". */
export function importHostedFontCache({ home = os.homedir(), platform = process.platform } = {}) {
  const containers = paths.developmentContainers({ home, platform, env: {} });
  const reverseDns = platform === "darwin" || platform === "win32";
  const source = path.join(containers.appData, reverseDns ? "com.zeros.dev" : "zeros-dev", "design-fonts");
  const target = path.join(containers.sharedDataDir, "design-fonts");
  if (exists(target)) return "kept";
  let names;
  try {
    if (!fs.lstatSync(source).isDirectory()) return "none";
    names = fs.readdirSync(source).filter((name) => CACHED_FONT_CSS.test(name));
  } catch {
    return "none";
  }
  const files = names.filter((name) => {
    try {
      return fs.lstatSync(path.join(source, name)).isFile();
    } catch {
      return false;
    }
  });
  if (!files.length) return "none";
  fs.mkdirSync(containers.sharedDataDir, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(containers.sharedDataDir, ".design-fonts-import-"));
  try {
    for (const name of files) fs.copyFileSync(path.join(source, name), path.join(staging, name), fs.constants.COPYFILE_EXCL);
    if (exists(target)) return "kept";
    fs.renameSync(staging, target);
    return "imported";
  } finally {
    // Our own private folder, left only when the rename did not happen.
    if (exists(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    return error.code !== "ENOENT";
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
