// `pnpm electron:alpha`: hosted development against Alpha on the dev channel,
// with the identity it has always had (com.zeros.dev, ~/.zeros-dev,
// ~/zeros-dev). It derives no per-worktree instance, so every checkout opens
// the primary profile; an explicit ZEROS_INSTANCE from the caller still
// selects its own, as before. Two launchers must not run it at once:
// - `~/.zeros-dev/electron-alpha[-<instance>].lock` refuses a second launch of
//   the same profile from any checkout before auth or build work;
// - `.context/zeros-local/launcher.lock` is shared with electron:local, which
//   rebuilds the same checkout's outputs.
// A lock whose holder process is gone is recovered automatically.
import os from "node:os";
import path from "node:path";
import { acquireCheckoutLauncherLock, acquireLauncherLock } from "./exclusive-file-lock.mjs";

/** The same normalization main and paths.ts apply to ZEROS_INSTANCE. */
function instanceSlug(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 40);
}

export function alphaLockPath({ home = os.homedir(), instance = process.env.ZEROS_INSTANCE } = {}) {
  const slug = instanceSlug(instance);
  return path.join(home, ".zeros-dev", slug ? `electron-alpha-${slug}.lock` : "electron-alpha.lock");
}

/** Claim this hosted profile and this checkout's builds. Throws before any
 * build or auth refresh when either is in use. Returns the release, to be
 * called once the whole app stack has exited. */
export function prepareAlphaLaunch({
  home = os.homedir(),
  root = process.cwd(),
  instance = process.env.ZEROS_INSTANCE,
} = {}) {
  const releaseCheckout = acquireCheckoutLauncherLock(root, { launcher: "electron:alpha" });
  try {
    const releaseProfile = acquireLauncherLock(alphaLockPath({ home, instance }), {
      record: { launcher: "electron:alpha", root },
      busyMessage: "pnpm electron:alpha is already running for this Zeros Dev profile (from this or another checkout). Quit it before launching again.",
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
