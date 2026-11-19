// Launcher-start prune for the development family (docs/storage-layout.md).
// Best effort: it never throws, never fails a launch, stops at its time budget,
// skips the launching identity and any identity with a live launcher, and
// removes only resolver-derived targets inside their expected folders.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { lockOwnerState, pidAlive } from "./exclusive-file-lock.mjs";
import { readRegistry, registryPath, removeInstance } from "./local-instance-registry.mjs";
import { hasWorkspaceEntries, providerStoreReferences, removeContained } from "./storage-removal.mjs";

const require = createRequire(import.meta.url);
const paths = require("../apps/desktop/src/engine/db/local-development-paths.cjs");

export const STALE_INSTANCE_MS = 14 * 24 * 60 * 60 * 1000;
const INSTANCE_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Every removable root of one identity with the folder it must sit in.
 * `regenerable` targets rebuild on the next launch. */
export function identityTargets(roots, containers) {
  const legacy = roots.layout === "legacy";
  const darwinLogs = containers.logs !== null;
  const targets = [
    { kind: "bundle", target: roots.bundleDir, container: legacy ? roots.stateRoot : containers.bundles, regenerable: true },
    { kind: "cache", target: roots.cacheDir, container: legacy ? containers.cache : containers.cacheInstances, regenerable: true },
    {
      kind: "logs",
      target: roots.logDir,
      container: darwinLogs ? (legacy ? containers.logs : containers.logInstances) : roots.dataDir,
      regenerable: true,
    },
  ];
  if (roots.preferencesFile)
    targets.push({ kind: "preferences", target: roots.preferencesFile, container: containers.preferences, regenerable: true, file: true });
  for (const [kind, target, container] of [
    ["http-storage", roots.httpStorageDir, containers.httpStorages],
    ["webkit", roots.webKitDir, containers.webKit],
    ["saved-state", roots.savedStateDir, containers.savedState],
  ])
    if (target) targets.push({ kind, target, container, regenerable: true });
  targets.push(
    { kind: "data", target: roots.dataDir, container: legacy ? containers.appData : containers.dataInstances, regenerable: false },
    { kind: "state", target: roots.stateRoot, container: containers.stateInstances, regenerable: false },
    { kind: "visible", target: roots.visibleRoot, container: legacy ? containers.home : containers.visibleInstances, regenerable: false },
  );
  return targets;
}

/** Remove `targets` (all, or only regenerable ones); returns removed paths. */
export function removeTargets(targets, { home, onlyRegenerable = false, deadline = Infinity, log = () => {} }) {
  const removed = [];
  for (const entry of targets) {
    if (onlyRegenerable && !entry.regenerable) continue;
    if (Date.now() > deadline) break;
    try {
      const outcome = removeContained(entry.target, {
        container: entry.container,
        home,
        kind: entry.file ? "file" : "directory",
      });
      if (outcome === "removed") removed.push(entry.target);
      else if (outcome !== "missing") log(`kept ${entry.kind} (${outcome})`);
    } catch {
      log(`could not remove ${entry.kind}`);
    }
  }
  return removed;
}

function allGone(targets) {
  return targets.every((entry) => {
    try {
      fs.lstatSync(entry.target);
      return false;
    } catch (error) {
      return error.code === "ENOENT";
    }
  });
}

function checkoutState(checkout) {
  if (typeof checkout !== "string" || !path.isAbsolute(checkout)) return "unknown";
  try {
    fs.lstatSync(checkout);
    return "present";
  } catch (error) {
    return error.code === "ENOENT" ? "gone" : "unknown";
  }
}

function defaultLauncherLive(instance, entry, roots) {
  if (entry.kind === "ephemeral")
    return !Number.isSafeInteger(entry.ownerPid) || entry.ownerPid <= 0 || pidAlive(entry.ownerPid);
  const locks = [path.join(roots.stateRoot, "launcher.lock")];
  if (typeof entry.checkout === "string" && path.isAbsolute(entry.checkout))
    locks.push(path.join(entry.checkout, ".context", "zeros-local", "launcher.lock"));
  return locks.some((lock) => lockOwnerState(lock) !== "absent");
}

function bundleBuiltFor(bundleDir) {
  let entries;
  try {
    entries = fs.readdirSync(bundleDir);
  } catch {
    return null;
  }
  const versions = new Set();
  for (const name of entries) {
    if (!name.endsWith(".app.version")) continue;
    try {
      versions.add(fs.readFileSync(path.join(bundleDir, name), "utf8").trim());
    } catch {
      return null;
    }
  }
  return versions.size === 1 ? [...versions][0] : null;
}

export function pruneDevelopmentInstances({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  currentInstance,
  electronVersion = null,
  now = Date.now(),
  budgetMs = 3_000,
  launcherLive = defaultLauncherLive,
  log = () => {},
} = {}) {
  const deadline = Date.now() + budgetMs;
  const actions = [];
  try {
    const file = registryPath({ home, platform, env });
    const registry = readRegistry(file);
    const containers = paths.developmentContainers({ home, platform, env });
    for (const [instance, entry] of Object.entries(registry.instances)) {
      if (Date.now() > deadline) break;
      try {
        if (instance === currentInstance || !INSTANCE_ID.test(instance)) continue;
        if (entry.layout !== "v2" && entry.layout !== "legacy") continue;
        const roots = paths.developmentPaths({ instance, layout: entry.layout, home, platform, env });
        if (launcherLive(instance, entry, roots)) continue;
        const lastUsed = Date.parse(entry.lastUsedAt);
        const stale = Number.isFinite(lastUsed) && now - lastUsed > STALE_INSTANCE_MS;
        const targets = identityTargets(roots, containers);
        // Keep the data dir (and the rest of the identity) whenever the shared
        // Local store may still point at a provider profile inside it.
        const referenced = () => providerStoreReferences({ dataDir: roots.dataDir, sharedDataDir: containers.sharedDataDir });
        if (entry.kind === "ephemeral") {
          if (referenced()) {
            const removed = removeTargets(targets, { home, onlyRegenerable: true, deadline, log });
            actions.push({ instance, rule: "ephemeral-kept-provider-profiles", removed });
            continue;
          }
          const removed = removeTargets(targets, { home, deadline, log });
          if (allGone(targets)) removeInstance(file, instance, entry);
          actions.push({ instance, rule: "ephemeral", removed });
          continue;
        }
        if (entry.kind === "checkout" && stale && checkoutState(entry.checkout) === "gone") {
          const removed = removeTargets(targets, { home, onlyRegenerable: true, deadline, log });
          if (referenced()) actions.push({ instance, rule: "checkout-gone-kept-provider-profiles", removed });
          else if (!hasWorkspaceEntries(roots.visibleRoot)) {
            removed.push(...removeTargets(targets.filter((t) => !t.regenerable), { home, deadline, log }));
            if (allGone(targets)) removeInstance(file, instance, entry);
            actions.push({ instance, rule: "checkout-gone", removed });
          } else actions.push({ instance, rule: "checkout-gone-kept-work", removed });
          continue;
        }
        if (stale && electronVersion) {
          const built = bundleBuiltFor(roots.bundleDir);
          if (built && built !== electronVersion) {
            const removed = removeTargets(targets.filter((t) => t.kind === "bundle"), { home, deadline, log });
            actions.push({ instance, rule: "bundle-version", removed });
          }
        }
      } catch {
        log(`skipped ${instance}`);
      }
    }
  } catch {
    log("prune skipped");
  }
  return actions;
}
