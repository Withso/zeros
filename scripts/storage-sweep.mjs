#!/usr/bin/env node
// pnpm storage:sweep — remove developer-machine residue left by retired Zeros
// identities (docs/storage-layout.md). Dry run unless --apply. Node built-ins
// only, so it runs in a checkout without node_modules.
//
//   --apply                 delete what the dry run lists as removable
//   --only <category,…>     dev-desktop, beta, legacy-scheme,
//                           local-unregistered, local-orphaned
//   --identity <inst>       only that identity; also lifts its "has workspaces" skip
//   --keychain              also the Zeros Dev / Zeros Beta Safe Storage items
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readRegistry, registryPath, removeInstance } from "./local-instance-registry.mjs";
import { identityTargets } from "./local-instance-prune.mjs";
import { hasWorkspaceEntries, providerStoreReferences, refusal, removeContained, sizeOf } from "./storage-removal.mjs";

const require = createRequire(import.meta.url);
const paths = require("../apps/desktop/src/engine/db/local-development-paths.cjs");

export const CATEGORIES = ["dev-desktop", "beta", "legacy-scheme", "local-unregistered", "local-orphaned"];
const KEYCHAIN_SERVICES = ["Zeros Dev Safe Storage", "Zeros Beta Safe Storage"];
const INSTANCE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const CHECKOUT_ID = /^[0-9a-f]{16}$/;
const RECENT_MS = 14 * 24 * 60 * 60 * 1000;
const LOCAL_CATEGORIES = ["local-unregistered", "local-orphaned"];
const LOCAL_LIBRARY = ["Application Support", "Caches", "Logs", "Preferences", "HTTPStorages", "WebKit", "Saved Application State"];

// Library folders, and the suffix macOS appends to a bundle id in each.
const LIBRARY = [
  ["Application Support", ""],
  ["Caches", ""],
  ["Logs", ""],
  ["Preferences", ".plist"],
  ["HTTPStorages", ""],
  ["WebKit", ""],
  ["Saved Application State", ".savedState"],
];

/** Exact name patterns; `slug` names the identity a match belongs to. */
const LIBRARY_PATTERNS = {
  "dev-desktop": [
    { re: /^com\.zeros\.dev$/, slug: () => "" },
    { re: /^com\.zeros\.dev\.(.+)$/, slug: (m) => m[1] },
    { re: /^Zeros Dev$/, slug: () => "" },
    { re: /^Zeros — (.+)$/, slug: (m) => m[1] },
    { re: /^design\.zeros\.app\.dev(?:\.(.+))?$/, slug: (m) => m[1] ?? "" },
  ],
  beta: [
    { re: /^com\.zeros\.beta(?:\.(.+))?$/, slug: (m) => m[1] ?? "" },
    { re: /^design\.zeros\.beta(?:\.(.+))?$/, slug: (m) => m[1] ?? "" },
  ],
  "legacy-scheme": [
    { re: /^design\.zeros\.app$/, slug: () => "" },
    { re: /^design\.zeros\.oCanvas$/, slug: () => "" },
  ],
};

/** The never-touch list, checked again for every candidate behind the exact
 * patterns above. */
export function neverTouch(home) {
  const library = path.join(home, "Library");
  const protectedPaths = new Set([
    path.join(home, ".zeros"),
    path.join(home, ".zeros-alpha"),
    path.join(home, "zeros"),
    path.join(home, "zeros-alpha"),
    path.join(home, ".zeros-dev"),
    path.join(library, "Application Support", "com.zeros.local"),
  ]);
  for (const [folder, suffix] of LIBRARY)
    for (const id of ["com.zeros", "com.zeros.alpha"]) protectedPaths.add(path.join(library, folder, `${id}${suffix}`));
  const devKeep = path.join(home, ".zeros-dev");
  const shared = path.join(library, "Application Support", "com.zeros.local");
  return (target) =>
    protectedPaths.has(target) ||
    (target.startsWith(`${devKeep}${path.sep}`) && target !== path.join(devKeep, "dev-instances")) ||
    (path.dirname(target) === shared && target !== path.join(shared, "instances"));
}

function list(directory) {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function defaultProcessList() {
  try {
    return execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8", timeout: 5_000, maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function defaultSecurity(args) {
  try {
    execFileSync("/usr/bin/security", args, { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Build the plan: every candidate with its size and whether it may go. */
export function planSweep({
  home = os.homedir(),
  platform = "darwin",
  env = {},
  only = CATEGORIES,
  identity = null,
  processList = defaultProcessList,
  keychain = false,
  security = defaultSecurity,
  budgetMs = 30_000,
} = {}) {
  const deadline = Date.now() + budgetMs;
  const library = path.join(home, "Library");
  const isProtected = neverTouch(home);
  const containers = paths.developmentContainers({ home, platform, env });
  const file = registryPath({ home, platform, env });
  const registry = readRegistry(file);
  const registered = new Set(Object.keys(registry.instances));
  const groups = new Map();
  // role: "data" | "state" | "visible" | "regenerable".
  const add = (category, slug, target, container, { kind = "directory", role = "regenerable", registryEntry } = {}) => {
    if (!only.includes(category) || isProtected(target)) return;
    const key = `${category}\0${slug}`;
    if (!groups.has(key)) groups.set(key, { key, category, identity: slug, items: [], registryEntry: undefined });
    const group = groups.get(key);
    if (group.items.some((item) => item.path === target)) return;
    group.items.push({ path: target, container, kind, role });
    if (registryEntry) group.registryEntry = registryEntry;
  };

  for (const [folder, suffix] of LIBRARY) {
    const directory = path.join(library, folder);
    for (const name of list(directory)) {
      if (suffix && !name.endsWith(suffix)) continue;
      const base = suffix ? name.slice(0, -suffix.length) : name;
      const kind = folder === "Preferences" ? "file" : "directory";
      for (const [category, patterns] of Object.entries(LIBRARY_PATTERNS))
        for (const pattern of patterns) {
          const match = base.match(pattern.re);
          if (match) add(category, pattern.slug(match), path.join(directory, name), directory, { kind });
        }
      const local = base.match(/^com\.zeros\.local\.(.+)$/);
      if (local && INSTANCE.test(local[1]) && !registered.has(local[1]) && LOCAL_LIBRARY.includes(folder))
        add("local-unregistered", local[1], path.join(directory, name), directory,
          { kind, role: folder === "Application Support" ? "data" : "regenerable" });
    }
  }
  for (const name of list(home)) {
    const dev = name.match(/^zeros-dev(?:-(.+))?$/);
    if (dev) add("dev-desktop", dev[1] ?? "", path.join(home, name), home, { role: "visible" });
    if (name === "zeros-beta") add("beta", "", path.join(home, name), home, { role: "visible" });
    if (name === ".zeros-beta") add("beta", "", path.join(home, name), home);
    const legacyLocal = name.match(/^zeros-local-(.+)$/);
    if (legacyLocal && INSTANCE.test(legacyLocal[1]) && !registered.has(legacyLocal[1]))
      add("local-unregistered", legacyLocal[1], path.join(home, name), home, { role: "visible" });
  }
  add("dev-desktop", "", path.join(home, ".zeros-dev", "dev-instances"), path.join(home, ".zeros-dev"));
  add("local-unregistered", "", containers.legacyBundles, path.dirname(containers.legacyBundles));
  const v2 = [
    [containers.dataInstances, "data"],
    [containers.cacheInstances, "regenerable"],
    [containers.bundles, "regenerable"],
    [containers.logInstances, "regenerable"],
    [containers.stateInstances, "state"],
    [containers.visibleInstances, "visible"],
  ];
  for (const [container, role] of v2) {
    if (!container) continue;
    for (const name of list(container))
      if (INSTANCE.test(name) && !registered.has(name)) add("local-unregistered", name, path.join(container, name), container, { role });
  }
  for (const [instance, entry] of Object.entries(registry.instances)) {
    if (!INSTANCE.test(instance) || entry.kind !== "checkout") continue;
    if (entry.layout !== "v2" && entry.layout !== "legacy") continue;
    if (typeof entry.checkout !== "string" || !path.isAbsolute(entry.checkout)) continue;
    try {
      fs.lstatSync(entry.checkout);
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") continue;
    }
    const roots = paths.developmentPaths({ instance, layout: entry.layout, home, platform, env });
    for (const target of identityTargets(roots, containers))
      add("local-orphaned", instance, target.target, target.container, {
        kind: target.file ? "file" : "directory",
        role: target.regenerable ? "regenerable" : target.kind,
        registryEntry: { instance, entry },
      });
  }

  const processes = processList();
  const named = identity !== null;
  const seen = new Set();
  const items = [];
  for (const group of groups.values()) {
    if (named && group.identity !== identity) continue;
    const present = group.items.filter((item) => refusal(item.path, { container: item.container, home, kind: item.kind }) !== "missing");
    if (!present.length) continue;
    const data = present.filter((item) => item.role === "data");
    const work = !named && present.some((item) => item.role === "visible" && hasWorkspaceEntries(item.path));
    // Before the registry existed, a checkout that only opens plain folders
    // has chats in zeros.db and nothing under its visible root.
    const recent = !named && group.category === "local-unregistered" && CHECKOUT_ID.test(group.identity) &&
      data.some((item) => usedWithin(item.path, RECENT_MS));
    const live = processes === null ? "unknown" : present.some((item) => processes.includes(item.path)) ? "live" : "idle";
    const referenced = LOCAL_CATEGORIES.includes(group.category) &&
      data.some((item) => providerStoreReferences({ dataDir: item.path, sharedDataDir: containers.sharedDataDir }));
    for (const item of present) {
      const refused = refusal(item.path, { container: item.container, home, kind: item.kind });
      const reason = refused ?? (work ? "has workspaces"
        : recent ? "used recently; launch it once to register it, or pass --identity"
          : live === "live" ? "in use by a running process"
            : live === "unknown" ? "process list unavailable"
              : referenced && item.role !== "regenerable" ? "provider profiles referenced by the shared Local store" : null);
      const size = sizeOf(item.path, { deadline, seen });
      items.push({ category: group.category, identity: group.identity, group: group.key, role: item.role, path: item.path,
        container: item.container, kind: item.kind, bytes: size.bytes, sizeComplete: size.complete,
        action: reason ? "skip" : "remove", reason, registryEntry: group.registryEntry });
    }
  }
  items.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.path.localeCompare(b.path));
  const keychainItems = keychain && platform === "darwin"
    ? KEYCHAIN_SERVICES.map((service) => ({ service, present: security(["find-generic-password", "-s", service]) }))
    : [];
  return { home, named, registryFile: file, items, keychain: keychainItems };
}

function usedWithin(dataDir, windowMs) {
  return ["zeros.db", "zeros.db-wal"].some((name) => {
    try {
      return Date.now() - fs.lstatSync(path.join(dataDir, name)).mtimeMs < windowMs;
    } catch (error) {
      return error.code !== "ENOENT";
    }
  });
}

/** Delete every removable item in the plan, then registry entries whose
 * identity is completely gone. */
export function applySweep(plan, { security = defaultSecurity } = {}) {
  const results = [];
  // A visible root that gained work since the plan keeps its whole identity.
  const gainedWork = (item) => !plan.named && item.role === "visible" && hasWorkspaceEntries(item.path);
  const heldGroups = new Set(plan.items.filter((item) => item.action === "remove" && gainedWork(item)).map((item) => item.group));
  for (const item of plan.items) {
    if (item.action !== "remove") continue;
    let outcome;
    try {
      outcome = heldGroups.has(item.group) || gainedWork(item)
        ? "has workspaces"
        : removeContained(item.path, { container: item.container, home: plan.home, kind: item.kind });
    } catch (error) {
      outcome = error.code ?? "failed";
    }
    results.push({ path: item.path, outcome });
  }
  const entries = new Map();
  for (const item of plan.items) if (item.registryEntry) entries.set(item.registryEntry.instance, item);
  for (const [instance, sample] of entries) {
    const all = plan.items.filter((item) => item.registryEntry?.instance === instance);
    const gone = all.every((item) => {
      try {
        fs.lstatSync(item.path);
        return false;
      } catch (error) {
        return error.code === "ENOENT";
      }
    });
    if (gone) removeInstance(plan.registryFile, instance, sample.registryEntry.entry);
  }
  const keychain = [];
  for (const item of plan.keychain) {
    if (!item.present) continue;
    let removed = 0;
    while (removed < 16 && security(["delete-generic-password", "-s", item.service])) removed++;
    keychain.push({ service: item.service, removed });
  }
  return { results, keychain };
}

function human(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export function formatPlan(plan, { apply = false } = {}) {
  const lines = [];
  let removable = 0;
  for (const category of CATEGORIES) {
    const rows = plan.items.filter((item) => item.category === category);
    if (!rows.length) continue;
    lines.push(`${category}:`);
    for (const row of rows) {
      const size = `${human(row.bytes)}${row.sizeComplete ? "" : "+"}`;
      lines.push(`  ${row.action === "remove" ? (apply ? "remove" : "would remove") : "skip"}  ${size.padStart(9)}  ${path.join("~", path.relative(plan.home, row.path))}${row.reason ? `  (${row.reason})` : ""}`);
      if (row.action === "remove") removable += row.bytes;
    }
  }
  for (const item of plan.keychain)
    lines.push(`keychain: ${item.service} — ${item.present ? (apply ? "remove" : "would remove") : "not present"}`);
  lines.push(`Total ${apply ? "removed" : "removable"}: ${human(removable)}${apply ? "" : " (dry run; pass --apply to delete)"}`);
  return lines.join("\n");
}

export function parseArguments(argv) {
  const options = { apply: false, only: CATEGORIES, identity: null, keychain: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--keychain") options.keychain = true;
    else if (arg === "--only") {
      const only = (argv[++index] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      const unknown = only.filter((value) => !CATEGORIES.includes(value));
      if (!only.length || unknown.length) throw new Error(`--only takes ${CATEGORIES.join(", ")}`);
      options.only = only;
    } else if (arg === "--identity") {
      const identity = argv[++index] ?? "";
      if (!INSTANCE.test(identity) && !/^[^/\0]{1,80}$/.test(identity)) throw new Error("--identity needs an instance id");
      options.identity = identity;
    } else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2), { platform = process.platform, home = os.homedir(), ...deps } = {}) {
  const options = parseArguments(argv);
  if (platform !== "darwin") {
    console.log("storage:sweep inspects macOS Library folders; nothing to sweep on this platform.");
    return 0;
  }
  const plan = planSweep({ home, platform, only: options.only, identity: options.identity, keychain: options.keychain, ...deps });
  if (options.apply) {
    const outcome = applySweep(plan, deps);
    console.log(formatPlan(plan, { apply: true }));
    const failed = outcome.results.filter((result) => result.outcome !== "removed" && result.outcome !== "missing");
    for (const result of failed) console.log(`  not removed: ${result.path} (${result.outcome})`);
    return failed.length ? 1 : 0;
  }
  console.log(formatPlan(plan));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[storage:sweep] ${error.message}`);
    process.exitCode = 2;
  }
}
