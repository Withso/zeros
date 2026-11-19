// Launcher prune for the development family (docs/storage-layout.md). It
// removes only what is provably regenerable: a gone checkout's native dev
// bundle, a bundle built for another Electron, and a dead ephemeral identity
// that a script registered. App data, state roots, visible roots, session data
// and registry entries of every other identity are never touched; durable
// removal is `pnpm storage:sweep`, run by a person.
//
// Asynchronous end to end: launchers start it after the app stack has been
// spawned, and it can never delay or fail a launch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { readRegistry, registryPath, removeInstance } from "./local-instance-registry.mjs";
import { identityInUse } from "./local-instance-lease.mjs";
import { providerStoreReferences, removeContained } from "./storage-removal.mjs";

const require = createRequire(import.meta.url);
const paths = require("../apps/desktop/src/engine/db/local-development-paths.cjs");
const contained = require("../apps/desktop/src/engine/db/contained-removal.cjs");

export const STALE_INSTANCE_MS = 14 * 24 * 60 * 60 * 1000;
const INSTANCE_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Every root one identity owns, with the folder it must sit directly in.
 * Only the native bundle is regenerable: the legacy cache dir and the old v2
 * cache location are Electron session data. */
export function identityTargets(roots, containers) {
  const legacy = roots.layout === "legacy";
  const darwinLogs = containers.logs !== null;
  const targets = [
    { kind: "bundle", target: roots.bundleDir, container: legacy ? roots.stateRoot : containers.bundles, regenerable: true },
    { kind: "session", target: roots.cacheDir, container: legacy ? containers.cache : containers.cacheInstances, regenerable: false },
    {
      kind: "logs",
      target: roots.logDir,
      container: darwinLogs ? (legacy ? containers.logs : containers.logInstances) : roots.dataDir,
      regenerable: false,
    },
  ];
  if (roots.preferencesFile)
    targets.push({ kind: "preferences", target: roots.preferencesFile, container: containers.preferences, regenerable: false, file: true });
  for (const [kind, target, container] of [
    ["http-storage", roots.httpStorageDir, containers.httpStorages],
    ["webkit", roots.webKitDir, containers.webKit],
    ["saved-state", roots.savedStateDir, containers.savedState],
  ])
    if (target) targets.push({ kind, target, container, regenerable: false });
  targets.push(
    { kind: "data", target: roots.dataDir, container: legacy ? containers.appData : containers.dataInstances, regenerable: false },
    { kind: "state", target: roots.stateRoot, container: containers.stateInstances, regenerable: false },
    { kind: "visible", target: roots.visibleRoot, container: legacy ? containers.home : containers.visibleInstances, regenerable: false },
  );
  return targets;
}

/** Synchronous removal, for scripts disposing their own retired identity. */
export function removeTargets(targets, { home, onlyRegenerable = false, log = () => {} }) {
  const removed = [];
  for (const entry of targets) {
    if (onlyRegenerable && !entry.regenerable) continue;
    try {
      const outcome = removeContained(entry.target, { container: entry.container, home, kind: entry.file ? "file" : "directory" });
      if (outcome === "removed") removed.push(entry.target);
      else if (outcome !== "missing") log(`kept ${entry.kind} (${outcome})`);
    } catch {
      log(`could not remove ${entry.kind}`);
    }
  }
  return removed;
}

async function removeTargetsAsync(targets, { home, deadline, log }) {
  const removed = [];
  for (const entry of targets) {
    if (Date.now() > deadline) break;
    try {
      const outcome = await contained.removeContainedAsync(entry.target, { container: entry.container, root: home, kind: entry.file ? "file" : "directory" });
      if (outcome === "removed") removed.push(entry.target);
      else if (outcome !== "missing") log(`kept ${entry.kind} (${outcome})`);
    } catch {
      log(`could not remove ${entry.kind}`);
    }
  }
  return removed;
}

async function gone(target) {
  try {
    await fs.promises.lstat(target);
    return false;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

/** Anything in the visible root or `<state root>/worktrees` (hidden,
 * archived, adopted or in-recovery worktrees) is work; unreadable is work. */
export async function holdsWork(roots) {
  for (const [root, ignorable] of [[roots.visibleRoot, ["workspaces", "design workspaces", "cloud-sync"]], [path.join(roots.stateRoot, "worktrees"), []]]) {
    let entries;
    try {
      const stat = await fs.promises.lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      return true;
    }
    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      if (!ignorable.includes(entry.name) || !entry.isDirectory()) return true;
      try {
        if ((await fs.promises.readdir(path.join(root, entry.name))).some((name) => name !== ".DS_Store")) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

async function checkoutGone(checkout) {
  if (typeof checkout !== "string" || !path.isAbsolute(checkout)) return false;
  try {
    await fs.promises.lstat(checkout);
    return false;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

async function bundleBuiltFor(bundleDir) {
  let entries;
  try {
    entries = await fs.promises.readdir(bundleDir);
  } catch {
    return null;
  }
  const versions = new Set();
  for (const name of entries) {
    if (!name.endsWith(".app.version")) continue;
    try {
      versions.add((await fs.promises.readFile(path.join(bundleDir, name), "utf8")).trim());
    } catch {
      return null;
    }
  }
  return versions.size === 1 ? [...versions][0] : null;
}

export async function pruneDevelopmentInstances({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  currentInstance,
  electronVersion = null,
  now = Date.now(),
  budgetMs = 3_000,
  inUse = identityInUse,
  log = () => {},
} = {}) {
  const deadline = Date.now() + budgetMs;
  const actions = [];
  try {
    const file = registryPath({ home, platform, env });
    const registry = readRegistry(file);
    if (registry.corrupt) return actions;
    const containers = paths.developmentContainers({ home, platform, env });
    for (const [instance, entry] of Object.entries(registry.instances)) {
      if (Date.now() > deadline) break;
      try {
        if (instance === currentInstance || !INSTANCE_ID.test(instance)) continue;
        if (entry.layout !== "v2" && entry.layout !== "legacy") continue;
        const roots = paths.developmentPaths({ instance, layout: entry.layout, home, platform, env });
        if (inUse(roots, entry)) continue;
        const targets = identityTargets(roots, containers);
        if (entry.kind === "ephemeral") {
          if (entry.layout !== "v2" || (await holdsWork(roots)) ||
              providerStoreReferences({ dataDir: roots.dataDir, sharedDataDir: containers.sharedDataDir })) continue;
          // Recheck just before deleting: a launcher may have started meanwhile.
          if (inUse(roots, entry)) continue;
          const removed = await removeTargetsAsync(targets, { home, deadline, log });
          let complete = true;
          for (const target of targets) if (!(await gone(target.target))) complete = false;
          if (complete) removeInstance(file, instance, entry, { timeoutMs: 250 });
          actions.push({ instance, rule: "ephemeral", removed });
          continue;
        }
        const lastUsed = Date.parse(entry.lastUsedAt);
        const stale = Number.isFinite(lastUsed) && now - lastUsed > STALE_INSTANCE_MS;
        if (!stale) continue;
        const bundle = targets.filter((target) => target.kind === "bundle");
        if (entry.kind === "checkout" && (await checkoutGone(entry.checkout))) {
          const removed = await removeTargetsAsync(bundle, { home, deadline, log });
          if (removed.length) actions.push({ instance, rule: "checkout-gone-bundle", removed });
          continue;
        }
        if (electronVersion) {
          const built = await bundleBuiltFor(roots.bundleDir);
          if (built && built !== electronVersion) {
            const removed = await removeTargetsAsync(bundle, { home, deadline, log });
            if (removed.length) actions.push({ instance, rule: "bundle-version", removed });
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
