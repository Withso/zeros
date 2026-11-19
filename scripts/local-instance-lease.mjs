// One stable liveness answer per development identity, for the launcher
// prune and `pnpm storage:sweep`. Node built-ins only.
//
// Every launcher (Local and alpha) holds `<state root>/launcher.lease` for the
// lifetime of its app stack. The lease lives in the state root, which never
// moves, so a renamed or unmounted checkout cannot hide a running identity.
// Electron's own SingletonLock in the identity's data dir covers an app that
// outlived its launcher. Anything unknown counts as live.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireExclusiveLock, launcherOwnerClassifier, lockOwnerState, pidAlive } from "./exclusive-file-lock.mjs";

export const LEASE_FILE = "launcher.lease";
const LAUNCHER_MARKERS = ["electron-local.mjs", "dev-environment/launcher.mjs", "storage-sweep.mjs"];

export function leasePath(roots) {
  return path.join(roots.stateRoot, LEASE_FILE);
}

/** Hold an identity's lease; throws LockBusyError while another holder lives. */
export function acquireLease(roots, { busyMessage, record = {} } = {}) {
  return acquireExclusiveLock({
    file: leasePath(roots),
    record,
    classify: launcherOwnerClassifier(
      LAUNCHER_MARKERS,
      `The launcher lease at ${leasePath(roots)} is incomplete; stop that launcher before removing it.`,
      "Invalid launcher lease.",
    ),
    busyMessage: busyMessage ?? "This Zeros identity is in use by another launcher.",
    recoveryBusyMessage: "Lease recovery is already in progress; retry after it completes.",
    changedMessage: "The launcher lease changed; retry.",
  });
}

/** "live" / "unknown" / "absent" for Chromium's SingletonLock (`<host>-<pid>`). */
function singletonState(dataDir, hostname) {
  let link;
  try {
    link = fs.readlinkSync(path.join(dataDir, "SingletonLock"));
  } catch (error) {
    return error.code === "ENOENT" ? "absent" : "unknown";
  }
  const match = /^(.+)-(\d+)$/.exec(link);
  if (!match || match[1] !== hostname) return "unknown";
  return pidAlive(Number(match[2])) ? "live" : "absent";
}

/** Why `roots` (one identity in one layout) may be in use, or null.
 * `ignoreHeld` skips a lease this process holds (the sweep, while removing). */
export function identityInUse(roots, entry = {}, { hostname = os.hostname(), ignoreHeld = false } = {}) {
  const locks = [leasePath(roots), path.join(roots.stateRoot, "launcher.lock")];
  if (typeof entry.checkout === "string" && path.isAbsolute(entry.checkout))
    locks.push(path.join(entry.checkout, ".context", "zeros-local", "launcher.lock"));
  for (const lock of locks) {
    const state = lockOwnerState(lock, { ignoreHeld });
    if (state !== "absent") return state === "live" ? "a launcher holds it" : "a launcher lock cannot be read";
  }
  const profile = profileInUse(roots.dataDir, { hostname });
  if (profile) return profile;
  if (entry.kind === "ephemeral" && (!Number.isSafeInteger(entry.ownerPid) || entry.ownerPid <= 0 || pidAlive(entry.ownerPid)))
    return "its owning process is alive or unknown";
  return null;
}

/** One lock per checkout, shared by `electron:local` and `electron:alpha`:
 * both rebuild the checkout's dist-electron and dist-engine. */
export function acquireCheckoutLock(root, record = {}) {
  return acquireExclusiveLock({
    file: path.join(root, ".context", "zeros-local", "launcher.lock"),
    record,
    classify: launcherOwnerClassifier(
      LAUNCHER_MARKERS,
      "Zeros Local launcher lock is incomplete; stop Local before removing .context/zeros-local/launcher.lock.",
      "Invalid Zeros Local launcher lock.",
    ),
    busyMessage: "A Zeros launcher (electron:local or electron:alpha) is already running from this checkout. Stop it before launching again.",
    recoveryBusyMessage: "Zeros Local lock recovery is already in progress; retry after it completes.",
    changedMessage: "Zeros Local launcher lock changed; retry.",
  });
}

/** Why an Electron profile in `dataDir` may be open, or null. */
export function profileInUse(dataDir, { hostname = os.hostname() } = {}) {
  const singleton = singletonState(dataDir, hostname);
  return singleton === "absent" ? null : singleton === "live" ? "the app is running" : "the app's profile lock cannot be read";
}

/** True while this identity's app may still be running (its SingletonLock
 * names a live process, or cannot be read). */
export function appRunning(roots, { hostname = os.hostname() } = {}) {
  return singletonState(roots.dataDir, hostname) !== "absent";
}
