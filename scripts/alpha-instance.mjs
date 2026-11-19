// `pnpm electron:alpha`: hosted development against Alpha on the dev channel,
// with the identity it has always had (com.zeros.dev, ~/.zeros-dev,
// ~/zeros-dev). The launcher's child environment carries no ZEROS_INSTANCE,
// so every launch opens the primary profile. Two launchers must not run it at
// once:
// - `~/.zeros-dev/electron-alpha.lock` refuses a second launch from any
//   checkout before auth or build work;
// - `.context/zeros-local/launcher.lock` is shared with electron:local, which
//   rebuilds the same checkout's outputs.
// A lock whose holder process is gone is recovered automatically.
import os from "node:os";
import path from "node:path";
import { acquireCheckoutLauncherLock, acquireLauncherLock } from "./exclusive-file-lock.mjs";

/** Claim this hosted profile and this checkout's builds. Throws before any
 * build or auth refresh when either is in use. Returns the release, to be
 * called once the whole app stack has exited. */
export function prepareAlphaLaunch({ home = os.homedir(), root = process.cwd() } = {}) {
  const releaseCheckout = acquireCheckoutLauncherLock(root, { launcher: "electron:alpha" });
  try {
    const lock = path.join(home, ".zeros-dev", "electron-alpha.lock");
    const releaseProfile = acquireLauncherLock(lock, {
      record: { launcher: "electron:alpha", root },
      busyMessage:
        `pnpm electron:alpha is already running for this Zeros Dev profile (from this or another checkout). Quit it before launching again. ` +
        `If none is running, the lock ${lock} is stale: it is safe to remove only when no Zeros Dev app is running.`,
    });
    return () => {
      try {
        releaseProfile();
      } finally {
        releaseCheckout();
      }
    };
  } catch (error) {
    releaseCheckout();
    throw error;
  }
}
