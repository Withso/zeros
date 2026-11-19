#!/usr/bin/env node
// pnpm storage:sweep — remove developer-machine residue left by retired Zeros
// identities (docs/storage-layout.md). Dry run unless --apply. Node built-ins
// only, so it runs in a checkout without node_modules.
//
//   --apply                 delete what the dry run lists as removable
//   --only <category,…>     dev-desktop, beta, legacy-scheme,
//                           local-unregistered, local-orphaned
//   --identity <id,…>       only these identities, including ones that hold data
//   --keychain              also the Zeros Dev / Zeros Beta Safe Storage items
//
// Unknown is kept. Without --identity only bundles, and identities provably
// empty of user data, are removed. Nothing is removed while it may be in use,
// nor when a missing or corrupt registry, an unreadable folder or an
// unavailable process list could hide what it holds. Apply re-validates each
// group immediately before deleting it, holding the identity's lease.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readRegistry, registryPath, removeInstance } from "./local-instance-registry.mjs";
import { identityTargets } from "./local-instance-prune.mjs";
import { acquireLease, identityInUse, profileInUse } from "./local-instance-lease.mjs";
import { hasWorkspaceEntries, providerStoreReferences, refusal, removeContained, sizeOf } from "./storage-removal.mjs";

const require = createRequire(import.meta.url);
const paths = require("../apps/desktop/src/engine/db/local-development-paths.cjs");

export const CATEGORIES = ["dev-desktop", "beta", "legacy-scheme", "local-unregistered", "local-orphaned"];
const KEYCHAIN = [
  { category: "dev-desktop", service: "Zeros Dev Safe Storage" },
  { category: "beta", service: "Zeros Beta Safe Storage" },
];
const INSTANCE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const LOCAL_CATEGORIES = ["local-unregistered", "local-orphaned"];
const LOCAL_LIBRARY = ["Application Support", "Caches", "Logs", "Preferences", "HTTPStorages", "WebKit", "Saved Application State"];
/** Must equal REGENERABLE_SESSION_ENTRIES (session-entries.ts); a test holds them equal. */
export const REGENERABLE_ENTRIES = new Set([
  "Cache", "Code Cache", "GPUCache", "DawnWebGPUCache", "DawnGraphiteCache", "GrShaderCache", "GraphiteDawnCache",
  "ShaderCache", "Shared Dictionary", "VideoDecodeStats", "Dictionaries", "blob_storage",
]);
const IGNORABLE = new Set([".DS_Store"]);
const STATE_PLUMBING = new Set(["bundle", "worktrees", "launcher.lease", "launcher.lock"]);
const DURABLE_ROLES = ["data", "state", "visible", "session"];

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

/** One Dev identity was spelled as a slug, a display label and a folder
 * suffix; all of them name one group. */
function devIdentity(raw) {
  const slug = String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return slug || "dev";
}

/** Exact name patterns. `shared` marks a folder every Dev identity used. */
const LIBRARY_PATTERNS = {
  "dev-desktop": [
    { re: /^com\.zeros\.dev$/, identity: () => "dev", shared: true },
    { re: /^com\.zeros\.dev\.(.+)$/, identity: (m) => devIdentity(m[1]) },
    { re: /^Zeros Dev$/, identity: () => "dev", shared: true },
    { re: /^Zeros — (.+)$/, identity: (m) => devIdentity(m[1]), shared: true },
    { re: /^design\.zeros\.app\.dev(?:\.(.+))?$/, identity: (m) => devIdentity(m[1]) },
  ],
  beta: [
    { re: /^com\.zeros\.beta(?:\.(.+))?$/, identity: () => "beta" },
    { re: /^design\.zeros\.beta(?:\.(.+))?$/, identity: () => "beta" },
  ],
  "legacy-scheme": [
    { re: /^design\.zeros\.app$/, identity: () => "design.zeros.app" },
    { re: /^design\.zeros\.oCanvas$/, identity: () => "design.zeros.oCanvas" },
  ],
};
const LIBRARY_ROLE = { "Application Support": "data", Caches: "session" };

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

/** Real (non-link) folders from `home` down to `directory`, or false. */
function realPathFrom(home, directory) {
  const relative = path.relative(home, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let cursor = home;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    cursor = segment ? path.join(cursor, segment) : cursor;
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      return error.code === "ENOENT" ? "missing" : false;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}

/** Names in `directory`. ok:false when it exists but cannot be listed, or is
 * reached through a link: what it holds is unknown. */
function list(home, directory) {
  const real = realPathFrom(home, directory);
  if (real === "missing") return { names: [], ok: true };
  if (!real) return { names: [], ok: false };
  try {
    return { names: fs.readdirSync(directory), ok: true };
  } catch (error) {
    return { names: [], ok: error.code === "ENOENT" };
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

/** Whether one candidate may hold user data. Only entries known to be
 * plumbing or rebuilt caches prove it does not; anything else, or anything
 * unreadable, counts. `work` is a workspace or worktree a person made. */
function contents(home, item) {
  if (item.role === "visible") return { work: hasWorkspaceEntries(item.path), data: false };
  if (!DURABLE_ROLES.includes(item.role) || item.kind === "file") return { work: false, data: false };
  const entries = list(home, item.path);
  if (!entries.ok) return { work: true, data: true };
  const names = entries.names.filter((name) => !IGNORABLE.has(name));
  if (item.role === "state") {
    const worktrees = names.includes("worktrees") ? list(home, path.join(item.path, "worktrees")) : { ok: true, names: [] };
    const work = !worktrees.ok || worktrees.names.some((name) => !IGNORABLE.has(name));
    return { work, data: work || names.some((name) => !STATE_PLUMBING.has(name)) };
  }
  return { work: false, data: names.some((name) => !REGENERABLE_ENTRIES.has(name)) };
}

/** Stable's renderer profile has moved once its marker is a file. */
function stableMoved(home) {
  try {
    return fs.lstatSync(path.join(home, "Library", "Application Support", "com.zeros", "electron", paths.SESSION_MOVED_MARKER)).isFile();
  } catch {
    return false;
  }
}

/** Build the plan: every candidate with its size and whether it may go.
 * `restrictTo` (group keys) and `measure: false` serve apply's re-validation. */
export function planSweep({
  home = os.homedir(),
  platform = "darwin",
  env = {},
  only = CATEGORIES,
  identities = null,
  processList = defaultProcessList,
  keychain = false,
  security = defaultSecurity,
  budgetMs = 30_000,
  restrictTo = null,
  measure = true,
  ignoreHeld = false,
} = {}) {
  const deadline = Date.now() + budgetMs;
  const named = identities ? new Set(identities) : null;
  const base = { home, platform, env, only, named, items: [], keychain: [], unlisted: [], problem: null };
  if (realPathFrom(home, home) !== true) return { ...base, problem: "the home folder is missing, a symlink or not a folder" };
  const library = path.join(home, "Library");
  const isProtected = neverTouch(home);
  const containers = paths.developmentContainers({ home, platform, env });
  const file = registryPath({ home, platform, env });
  const registry = readRegistry(file);
  const registryProblem = registry.corrupt ? "the instance registry is corrupt" : !exists(file) ? "there is no instance registry" : null;
  const registered = new Set(Object.keys(registry.instances));
  const unlisted = new Set();
  const groups = new Map();
  const add = (category, identity, target, container, { kind = "directory", role = "other", shared = false, entry } = {}) => {
    if (!only.includes(category) || isProtected(target)) return;
    const key = `${category}\0${identity}`;
    if (restrictTo && !restrictTo.has(key)) return;
    if (!groups.has(key)) groups.set(key, { key, category, identity, items: [], entry: undefined });
    const group = groups.get(key);
    if (group.items.some((item) => item.path === target)) return;
    group.items.push({ path: target, container, kind, role, shared });
    if (entry) group.entry = entry;
  };
  const scan = (categories, directory) => {
    const result = list(home, directory);
    if (!result.ok) for (const category of categories) unlisted.add(category);
    return result.names;
  };

  for (const [folder, suffix] of LIBRARY) {
    const directory = path.join(library, folder);
    for (const name of scan(CATEGORIES, directory)) {
      if (suffix && !name.endsWith(suffix)) continue;
      const stem = suffix ? name.slice(0, -suffix.length) : name;
      const kind = folder === "Preferences" ? "file" : "directory";
      const role = LIBRARY_ROLE[folder] ?? "other";
      for (const [category, patterns] of Object.entries(LIBRARY_PATTERNS))
        for (const pattern of patterns) {
          const match = stem.match(pattern.re);
          if (match) add(category, pattern.identity(match), path.join(directory, name), directory, { kind, role, shared: pattern.shared });
        }
      const local = stem.match(/^com\.zeros\.local\.(.+)$/);
      if (local && INSTANCE.test(local[1]) && !registered.has(local[1]) && LOCAL_LIBRARY.includes(folder))
        add("local-unregistered", local[1], path.join(directory, name), directory, { kind, role });
    }
  }
  for (const name of scan(CATEGORIES, home)) {
    const dev = name.match(/^zeros-dev(?:-(.+))?$/);
    if (dev) add("dev-desktop", devIdentity(dev[1]), path.join(home, name), home, { role: "visible" });
    if (name === "zeros-beta") add("beta", "beta", path.join(home, name), home, { role: "visible" });
    if (name === ".zeros-beta") add("beta", "beta", path.join(home, name), home, { role: "state" });
    const legacyLocal = name.match(/^zeros-local-(.+)$/);
    if (legacyLocal && INSTANCE.test(legacyLocal[1]) && !registered.has(legacyLocal[1]))
      add("local-unregistered", legacyLocal[1], path.join(home, name), home, { role: "visible" });
  }
  add("dev-desktop", "dev", path.join(home, ".zeros-dev", "dev-instances"), path.join(home, ".zeros-dev"), { role: "bundle", shared: true });
  add("local-unregistered", "dev-instances", containers.legacyBundles, path.dirname(containers.legacyBundles), { role: "bundle" });
  for (const [container, role] of [
    [containers.dataInstances, "data"],
    [containers.cacheInstances, "session"],
    [containers.bundles, "bundle"],
    [containers.logInstances, "other"],
    [containers.stateInstances, "state"],
    [containers.visibleInstances, "visible"],
  ]) {
    if (!container) continue;
    for (const name of scan(LOCAL_CATEGORIES, container)) {
      if (!INSTANCE.test(name) || registered.has(name)) continue;
      add("local-unregistered", name, path.join(container, name), container, { role });
      // A legacy-layout bundle lives inside the state root.
      if (role === "state")
        add("local-unregistered", name, path.join(container, name, "bundle"), path.join(container, name), { role: "bundle" });
    }
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
        role: target.kind === "bundle" || DURABLE_ROLES.includes(target.kind) ? target.kind : "other",
        entry: { instance, entry },
      });
  }

  const context = { home, platform, env, containers, registryProblem, unlisted, processes: processList(), named, ignoreHeld };
  for (const group of groups.values()) decide(group, context);
  // A retained Dev identity keeps what every Dev identity shared.
  const devGroups = [...groups.values()].filter((group) => group.category === "dev-desktop");
  if (devGroups.some((group) => group.items.some((item) => !item.shared && item.role !== "bundle" && item.action === "skip")))
    for (const group of devGroups)
      for (const item of group.items)
        if (item.shared && item.role !== "bundle" && item.action === "remove")
          Object.assign(item, { action: "skip", reason: "another Zeros Dev identity depends on it" });

  const seen = new Set();
  let hardlinked = false;
  for (const group of groups.values()) {
    if (named && !named.has(group.identity)) continue;
    // Deleting the state root also deletes the lease held over the rest.
    const ordered = [...group.items].sort((a, b) => (a.role === "state") - (b.role === "state"));
    for (const item of ordered) {
      if (item.missing) continue;
      const size = item.refused || !measure ? { bytes: 0, complete: true, hardlinked: false } : sizeOf(item.path, { deadline, seen });
      hardlinked ||= size.hardlinked;
      base.items.push({ category: group.category, identity: group.identity, group: group.key, role: item.role, path: item.path,
        container: item.container, kind: item.kind, bytes: size.bytes, sizeComplete: size.complete, action: item.action,
        reason: item.reason, evidence: group.evidence, registryEntry: group.entry });
    }
  }
  base.items.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.group.localeCompare(b.group));
  if (keychain && platform === "darwin")
    base.keychain = KEYCHAIN.filter((entry) => only.includes(entry.category))
      .map((entry) => ({ ...entry, present: security(["find-generic-password", "-s", entry.service]) }));
  return { ...base, registryFile: file, unlisted: [...unlisted], hardlinked };
}

/** Decide every item of one group, in place. */
function decide(group, { home, platform, env, containers, registryProblem, unlisted, processes, named, ignoreHeld }) {
  const isNamed = named?.has(group.identity) ?? false;
  const local = LOCAL_CATEGORIES.includes(group.category) && group.identity !== "dev-instances";
  const layouts = local
    ? ["v2", "legacy"].map((layout) => paths.developmentPaths({ instance: group.identity, layout, home, platform, env }))
    : [];
  for (const item of group.items) {
    const refused = refusal(item.path, { container: item.container, home, kind: item.kind });
    item.missing = refused === "missing";
    item.refused = refused !== null && !item.missing;
    item.reason = item.refused ? refused : null;
  }
  const present = group.items.filter((item) => !item.missing);

  let groupReason = null;
  if (processes === null) groupReason = "process list unavailable";
  else if (unlisted.has(group.category)) groupReason = "a folder could not be listed";
  else if (group.category === "local-unregistered" && registryProblem) groupReason = registryProblem;
  else if (local && paths.RESERVED_INSTANCE_IDS.includes(group.identity) && !isNamed) groupReason = "a reserved identity";
  else if (group.category === "legacy-scheme" && !stableMoved(home))
    groupReason = "Stable's renderer profile has not moved yet; this may be its only copy";
  else if (present.some((item) => processes.includes(item.path))) groupReason = "in use by a running process";
  else {
    let inUse = null;
    for (const roots of layouts) inUse ??= identityInUse(roots, group.entry?.entry ?? {}, { ignoreHeld });
    for (const item of present) if (item.role === "data" && !item.refused) inUse ??= profileInUse(item.path);
    if (inUse) groupReason = `in use (${inUse})`;
  }

  // What the identity holds; anything refused or unreadable counts as work.
  let work = present.some((item) => item.refused), data = work;
  if (!work) {
    for (const item of present) {
      const found = contents(home, item);
      work ||= found.work;
      data ||= found.data || found.work;
    }
    // Worktrees the engine keeps under the state root, which a scan may not list.
    for (const roots of layouts) {
      const state = { path: roots.stateRoot, role: "state", kind: "directory" };
      if (exists(state.path) && !present.some((item) => item.path === state.path)) {
        const found = contents(home, state);
        work ||= found.work;
        data ||= found.data;
      }
    }
  }
  const referenced = local && present.some((item) => item.role === "data" && !item.refused &&
    providerStoreReferences({ dataDir: item.path, sharedDataDir: containers.sharedDataDir }));
  group.evidence = JSON.stringify({ work, data, referenced });

  for (const item of present) {
    let reason = item.reason ?? groupReason;
    if (!reason && item.role !== "bundle") {
      if (referenced && DURABLE_ROLES.includes(item.role)) reason = "provider profiles referenced by the shared Local store";
      else if (data && !isNamed) reason = work ? "has workspaces; name it with --identity to remove" : "holds user data; name it with --identity to remove";
    }
    item.action = reason ? "skip" : "remove";
    item.reason = reason;
  }
}

/** Delete every removable item, one group at a time: take the identity's
 * lease, re-plan that group from fresh evidence, and remove only what is still
 * removable for the same reasons. */
export function applySweep(plan, { security = defaultSecurity, processList = defaultProcessList } = {}) {
  const results = [];
  const groupKeys = [...new Set(plan.items.filter((item) => item.action === "remove").map((item) => item.group))];
  for (const key of groupKeys) {
    const planned = plan.items.filter((item) => item.group === key && item.action === "remove");
    const sample = planned[0];
    const releases = [];
    let blocked = null;
    if (LOCAL_CATEGORIES.includes(sample.category) && sample.identity !== "dev-instances") {
      const roots = paths.developmentPaths({ instance: sample.identity, home: plan.home, platform: plan.platform, env: plan.env });
      if (exists(roots.stateRoot)) {
        try {
          releases.push(acquireLease(roots, { busyMessage: "in use", record: { instance: sample.identity, sweep: true } }));
        } catch {
          blocked = "in use (a launcher holds it)";
        }
      }
    }
    try {
      const fresh = blocked ? null : planSweep({ home: plan.home, platform: plan.platform, env: plan.env, only: plan.only,
        identities: plan.named, processList, restrictTo: new Set([key]), measure: false, ignoreHeld: true });
      const now = new Map((fresh?.items ?? []).map((item) => [item.path, item]));
      for (const item of planned) {
        const current = now.get(item.path);
        const changed = blocked ?? (!current ? "changed since the plan"
          : current.action !== "remove" ? current.reason
            : current.evidence !== item.evidence ? "changed since the plan" : null);
        if (changed) {
          results.push({ path: item.path, outcome: changed, bytes: 0 });
          continue;
        }
        let outcome;
        try {
          outcome = removeContained(item.path, { container: item.container, home: plan.home, kind: item.kind });
        } catch (error) {
          outcome = error.code ?? "failed";
        }
        results.push({ path: item.path, outcome, bytes: outcome === "removed" ? item.bytes : 0 });
      }
    } finally {
      for (const release of releases) release();
    }
  }
  const entries = new Map();
  for (const item of plan.items) if (item.registryEntry) entries.set(item.registryEntry.instance, item);
  for (const [instance, sample] of entries) {
    const all = plan.items.filter((item) => item.registryEntry?.instance === instance);
    if (all.every((item) => !exists(item.path))) removeInstance(plan.registryFile, instance, sample.registryEntry.entry);
  }
  const keychain = [];
  if (plan.keychain.length) {
    for (const item of plan.keychain) {
      if (!item.present) continue;
      // Only once nothing of that app is left, or could be hidden.
      const after = planSweep({ home: plan.home, platform: plan.platform, env: plan.env, only: [item.category],
        processList: () => "", measure: false });
      if (after.problem || after.unlisted.length || after.items.length) {
        keychain.push({ service: item.service, removed: 0, reason: "files of that app remain" });
        continue;
      }
      let removed = 0;
      while (removed < 16 && security(["delete-generic-password", "-s", item.service])) removed++;
      keychain.push({ service: item.service, removed });
    }
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

export function formatPlan(plan, outcome = null) {
  const lines = [];
  if (plan.problem) lines.push(`Nothing swept: ${plan.problem}.`);
  const done = outcome ? new Map(outcome.results.map((result) => [result.path, result])) : null;
  let total = 0;
  for (const category of CATEGORIES) {
    const rows = plan.items.filter((item) => item.category === category);
    if (!rows.length) continue;
    lines.push(`${category}:`);
    for (const row of rows) {
      const result = done?.get(row.path);
      const removed = result?.outcome === "removed";
      const verb = row.action !== "remove" ? "skip" : !done ? "would remove" : removed ? "removed" : "kept";
      const why = row.reason ?? (result && !removed ? result.outcome : null);
      const size = `${human(row.bytes)}${row.sizeComplete ? "" : "+"}`;
      lines.push(`  ${verb.padEnd(12)}  ${size.padStart(9)}  ${path.join("~", path.relative(plan.home, row.path))}  [${row.identity}]${why ? `  (${why})` : ""}`);
      if (done ? removed : row.action === "remove") total += done ? result.bytes : row.bytes;
    }
  }
  for (const item of plan.keychain) {
    const result = outcome?.keychain.find((entry) => entry.service === item.service);
    const state = !item.present ? "not present" : !outcome ? "would remove once nothing of that app remains"
      : result?.removed ? "removed" : `kept${result?.reason ? ` (${result.reason})` : ""}`;
    lines.push(`keychain: ${item.service} — ${state}`);
  }
  const bound = plan.hardlinked ? "; an upper bound: some files have hardlinks that may keep their space in use" : "";
  lines.push(outcome
    ? `Total removed: ${human(total)}${bound ? ` (${bound.slice(2)})` : ""}`
    : `Total removable: ${human(total)} (dry run; pass --apply to delete${bound})`);
  return lines.join("\n");
}

export function parseArguments(argv) {
  const options = { apply: false, only: CATEGORIES, identities: null, keychain: false };
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
      const names = (argv[++index] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      if (!names.length || names.some((name) => !/^[^/\0]{1,80}$/.test(name)))
        throw new Error("--identity takes one or more identities from the dry run, comma-separated");
      options.identities = new Set(names);
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
  const plan = planSweep({ home, platform, only: options.only, identities: options.identities, keychain: options.keychain, ...deps });
  if (plan.problem) {
    console.log(formatPlan(plan));
    return 2;
  }
  if (options.apply) {
    const outcome = applySweep(plan, deps);
    console.log(formatPlan(plan, outcome));
    const failed = outcome.results.filter((result) => result.outcome !== "removed" && result.outcome !== "missing");
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
