#!/usr/bin/env node
// pnpm storage:inventory — a read-only report of what Zeros keeps on this
// machine outside the installed apps' own profiles. It never deletes, moves or
// writes anything, never changes the Keychain and prints no commands. Node
// built-ins only, so it runs in a checkout without node_modules.
//
// Categories:
//   dev-desktop    the retired Zeros Dev desktop: com.zeros.dev*, "Zeros Dev",
//                  "Zeros — <label>", design.zeros.app.dev* in the Library
//                  folders; ~/zeros-dev*; ~/.zeros-dev/{dev-instances,worktrees}
//   beta           the retired Beta channel: com.zeros.beta*, design.zeros.beta*;
//                  ~/.zeros-beta; ~/zeros-beta
//   legacy-scheme  the retired design.zeros.app / design.zeros.oCanvas folders
//   development    development identities (local-development-paths.cjs), in
//                  either layout, registered or not, with their status
//
// For each identity it reports what it holds that a person may need (a
// database, provider profiles, worktrees under its state root, entries in its
// visible root, a renderer profile, a reference from the shared Local
// provider store) and whether it looks in use (a launcher lock, the app's
// SingletonLock, a running process naming it). Anything it could not read is
// reported as unknown. It refuses a home reached through a link and never
// reads below a linked folder.
//
//   --only <category,…>   limit the report
//   --keychain            also report whether the Zeros Dev / Zeros Beta Safe
//                         Storage items exist (their contents are never read)
//   --json                machine-readable output
//   --help
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { lockOwnerState, pidAlive, readRegularFile } from "./exclusive-file-lock.mjs";
import { readRegistry, registryPath } from "./local-instance-registry.mjs";

const require = createRequire(import.meta.url);
const paths = require("../apps/desktop/src/engine/db/local-development-paths.cjs");

export const CATEGORIES = ["dev-desktop", "beta", "legacy-scheme", "development"];
const KEYCHAIN = [
  { category: "dev-desktop", service: "Zeros Dev Safe Storage" },
  { category: "beta", service: "Zeros Beta Safe Storage" },
];
const INSTANCE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const IGNORABLE = new Set([".DS_Store"]);
const EMPTY_WORK_FOLDERS = new Set(["workspaces", "design workspaces", "cloud-sync"]);

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

/** One Dev identity was spelled as a slug, a display label and a folder suffix. */
function devIdentity(raw) {
  const slug = String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return slug || "dev";
}

const LIBRARY_PATTERNS = {
  "dev-desktop": [
    { re: /^com\.zeros\.dev$/, identity: () => "dev" },
    { re: /^com\.zeros\.dev\.(.+)$/, identity: (m) => devIdentity(m[1]) },
    { re: /^Zeros Dev$/, identity: () => "dev" },
    { re: /^Zeros — (.+)$/, identity: (m) => devIdentity(m[1]) },
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

/** "ok" when every component from `home` down to `target` is a real folder
 * (the target itself may be a file but not a link), "missing", or "refused". */
function reachable(home, target) {
  const relative = path.relative(home, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "refused";
  let cursor = home;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index <= segments.length; index++) {
    if (index > 0) cursor = path.join(cursor, segments[index - 1]);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      return error.code === "ENOENT" ? "missing" : "refused";
    }
    if (stat.isSymbolicLink()) return "refused";
    if (index < segments.length && !stat.isDirectory()) return "refused";
  }
  return "ok";
}

/** Names in `directory`; ok:false when it exists but is unreadable or reached
 * through a link. */
function list(home, directory) {
  const state = reachable(home, directory);
  if (state === "missing") return { names: [], ok: true };
  if (state !== "ok") return { names: [], ok: false };
  try {
    return { names: fs.readdirSync(directory), ok: true };
  } catch (error) {
    return { names: [], ok: error.code === "ENOENT" };
  }
}

/** Allocated bytes (what `du` reports), each inode once across a report.
 * `hardlinked` flags a file with another link, possibly outside every row. */
function sizeOf(target, { deadline, seen }) {
  let bytes = 0, hardlinked = false;
  const stack = [target];
  while (stack.length) {
    if (Date.now() > deadline) return { bytes, complete: false, hardlinked };
    const current = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (!stat.isDirectory() && stat.nlink > 1) hardlinked = true;
    const inode = `${stat.dev}:${stat.ino}`;
    if (!seen.has(inode)) {
      seen.add(inode);
      bytes += typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size;
    }
    if (!stat.isDirectory()) continue;
    try {
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
    } catch {
      /* counted as far as it could be read */
    }
  }
  return { bytes, complete: true, hardlinked };
}

/** "yes", "no" or "unknown": whether `directory` has entries. */
function hasEntries(home, directory) {
  const result = list(home, directory);
  if (!result.ok) return "unknown";
  return result.names.some((name) => !IGNORABLE.has(name)) ? "yes" : "no";
}

/** A visible root holds work unless it is missing or holds only empty
 * `workspaces`, `design workspaces` and `cloud-sync` folders. */
function visibleWork(home, root) {
  const top = list(home, root);
  if (!top.ok) return "unknown";
  for (const name of top.names) {
    if (IGNORABLE.has(name)) continue;
    if (!EMPTY_WORK_FOLDERS.has(name)) return "yes";
    const inner = hasEntries(home, path.join(root, name));
    if (inner !== "no") return inner;
  }
  return "no";
}

function present(home, target) {
  return reachable(home, target) === "ok";
}

/** Whether the shared Local provider store carries this data dir's migration
 * marker (its records are encrypted; the marker is the plaintext key
 * migrateLocalProviderSecrets() writes). */
function sharedStoreReference(home, sharedDataDir, dataDir) {
  const store = path.join(sharedDataDir, "secrets.json");
  if (reachable(home, store) === "refused") return "unknown";
  let raw;
  try {
    raw = readRegularFile(store);
  } catch {
    return "unknown";
  }
  if (raw === null) return "no";
  try {
    const doc = JSON.parse(raw);
    const marker = `local-provider-migration:${createHash("sha256").update(path.join(dataDir, "secrets.json")).digest("hex")}`;
    return doc && typeof doc === "object" && Object.hasOwn(doc, marker) ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

/** "live", "unknown" or "absent" for Chromium's SingletonLock (`<host>-<pid>`). */
function singleton(home, dataDir, hostname) {
  const link = path.join(dataDir, "SingletonLock");
  if (reachable(home, path.dirname(link)) !== "ok") return reachable(home, path.dirname(link)) === "missing" ? "absent" : "unknown";
  let target;
  try {
    target = fs.readlinkSync(link);
  } catch (error) {
    return error.code === "ENOENT" ? "absent" : "unknown";
  }
  const match = /^(.+)-(\d+)$/.exec(target);
  if (!match || match[1] !== hostname) return "unknown";
  return pidAlive(Number(match[2])) ? "live" : "absent";
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

/** Every development identity's possible roots, both layouts plus the
 * pre-release branch shapes (`~/zeros-local/<inst>`,
 * `Caches/com.zeros.local/instances/<inst>`), with the role each plays. */
function developmentRoots(instance, { home, platform, env, containers }) {
  const v2 = paths.developmentPaths({ instance, layout: "v2", home, platform, env });
  const legacy = paths.isReservedInstanceId(instance)
    ? null
    : paths.developmentPaths({ instance, layout: "legacy", home, platform, env });
  const rows = [
    [v2.dataDir, "data"], [v2.logDir, "logs"], [v2.bundleDir, "bundle"], [v2.stateRoot, "state"], [v2.visibleRoot, "visible"],
    [path.join(home, "zeros-local", instance), "visible"],
    [path.join(containers.cache, paths.FAMILY_ID, "instances", instance), "session"],
  ];
  if (legacy) rows.push([legacy.dataDir, "data"], [legacy.sessionDataDir, "session"], [legacy.logDir, "logs"]);
  const seen = new Set();
  return rows.filter(([target]) => !seen.has(target) && seen.add(target)).map(([target, role]) => ({ path: target, role }));
}

/** Build the report. */
export function inventory({
  home = os.homedir(),
  platform = process.platform,
  env = {},
  only = CATEGORIES,
  processList = defaultProcessList,
  keychain = false,
  security = defaultSecurity,
  hostname = os.hostname(),
  budgetMs = 30_000,
} = {}) {
  const report = { home, platform, groups: [], keychain: [], unlisted: [], hardlinked: false, problem: null, registry: null };
  let realHome = false;
  try {
    realHome = fs.realpathSync(home) === home && reachable(home, home) === "ok";
  } catch {
    realHome = false;
  }
  if (!realHome) return { ...report, problem: "the home folder is missing, not a folder, or reached through a symlink" };
  const deadline = Date.now() + budgetMs;
  const seen = new Set();
  const processes = processList();
  const groups = new Map();
  const group = (category, identity) => {
    const key = `${category}\0${identity}`;
    if (!groups.has(key)) groups.set(key, { category, identity, status: null, items: [], holds: new Set(), unknown: new Set(), inUse: new Set() });
    return groups.get(key);
  };
  const add = (category, identity, target, role) => {
    if (!only.includes(category)) return;
    const owner = group(category, identity);
    if (owner.items.some((item) => item.path === target)) return;
    owner.items.push({ path: target, role, state: reachable(home, target) });
  };
  const scan = (directory) => {
    const result = list(home, directory);
    if (!result.ok) report.unlisted.push(directory);
    return result.names;
  };
  const library = path.join(home, "Library");

  for (const [folder, suffix] of LIBRARY) {
    const directory = path.join(library, folder);
    for (const name of scan(directory)) {
      if (suffix && !name.endsWith(suffix)) continue;
      const stem = suffix ? name.slice(0, -suffix.length) : name;
      for (const [category, patterns] of Object.entries(LIBRARY_PATTERNS))
        for (const pattern of patterns) {
          const match = stem.match(pattern.re);
          if (match) add(category, pattern.identity(match), path.join(directory, name), LIBRARY_ROLE[folder] ?? "other");
        }
    }
  }
  for (const name of scan(home)) {
    const dev = name.match(/^zeros-dev(?:-(.+))?$/);
    if (dev) add("dev-desktop", devIdentity(dev[1]), path.join(home, name), "visible");
    if (name === "zeros-beta") add("beta", "beta", path.join(home, name), "visible");
    if (name === ".zeros-beta") add("beta", "beta", path.join(home, name), "state");
  }
  add("dev-desktop", "dev", path.join(home, ".zeros-dev", "dev-instances"), "bundle");
  add("dev-desktop", "dev", path.join(home, ".zeros-dev", "worktrees"), "worktrees");

  if (only.includes("development")) {
    const containers = paths.developmentContainers({ home, platform, env });
    const file = registryPath({ home, platform, env });
    let registry = { instances: {}, inconsistent: [] };
    if (reachable(home, path.dirname(file)) === "refused") report.registry = "not read (reached through a link)";
    else {
      try {
        registry = readRegistry(file);
        report.registry = registry.corrupt ? "corrupt" : present(home, file) ? "read" : "missing";
      } catch {
        report.registry = "unreadable";
      }
    }
    const ids = new Set([...Object.keys(registry.instances), ...(registry.inconsistent ?? [])]);
    const reverseDns = platform === "darwin" || platform === "win32";
    const flatData = reverseDns ? /^com\.zeros\.local\.(.+)$/ : /^zeros-local-(.+)$/;
    for (const name of scan(containers.dataInstances)) ids.add(name);
    for (const name of scan(containers.appData)) {
      const match = name.match(flatData);
      if (match) ids.add(match[1]);
    }
    for (const name of scan(containers.stateInstances)) ids.add(name);
    for (const name of scan(containers.bundles)) ids.add(name);
    if (containers.logInstances) for (const name of scan(containers.logInstances)) ids.add(name);
    for (const name of scan(path.join(containers.cache, paths.FAMILY_ID, "instances"))) ids.add(name);
    for (const name of scan(home)) {
      const match = name.match(/^zeros-local-(.+)$/);
      if (match) ids.add(match[1]);
    }
    for (const name of scan(path.join(home, "zeros-local"))) ids.add(name);
    add("development", "dev-instances", containers.legacyBundles, "bundle");
    for (const instance of ids) {
      if (!INSTANCE.test(instance)) continue;
      const owner = group("development", instance);
      for (const root of developmentRoots(instance, { home, platform, env, containers })) add("development", instance, root.path, root.role);
      const entry = registry.instances[instance];
      if (registry.inconsistent?.includes(instance)) owner.status = "registry entry inconsistent";
      else if (entry?.kind === "alpha") owner.status = "registered (hosted alpha)";
      else if (entry?.kind === "checkout") {
        const checkout = typeof entry.checkout === "string" ? entry.checkout : "";
        let gone = !checkout;
        try {
          if (checkout) fs.lstatSync(checkout);
        } catch (error) {
          gone = error.code === "ENOENT";
        }
        owner.status = gone ? `registered checkout, checkout gone (${checkout || "unknown"})` : `registered checkout (${checkout})`;
        owner.checkout = checkout;
      } else if (paths.isReservedInstanceId(instance)) owner.status = "reserved, not registered";
      else if (paths.isCheckoutInstanceId(instance)) owner.status = "checkout, not registered";
      else owner.status = "test or hosted identity, not registered";
      // The state root is the same in both layouts.
      const { stateRoot } = paths.developmentPaths({ instance, home, platform, env });
      for (const lock of ["launcher.lock", "launcher.lease"]) {
        const file = path.join(stateRoot, lock);
        const state = reachable(home, file) === "refused" ? "unknown" : lockOwnerState(file);
        if (state === "live") owner.inUse.add("a launcher holds it");
        else if (state === "unknown") owner.inUse.add("a launcher lock could not be read");
      }
      if (owner.checkout && path.isAbsolute(owner.checkout)) {
        const state = lockOwnerState(path.join(owner.checkout, ".context", "zeros-local", "launcher.lock"));
        if (state === "live") owner.inUse.add("its checkout's launcher is running");
        else if (state === "unknown") owner.inUse.add("its checkout's launcher lock could not be read");
      }
      for (const item of owner.items.filter((candidate) => candidate.role === "data")) {
        const reference = sharedStoreReference(home, containers.sharedDataDir, item.path);
        if (reference === "yes") owner.holds.add("a reference from the shared Local provider store");
        else if (reference === "unknown") owner.unknown.add("the shared Local provider store");
      }
    }
  }

  for (const owner of groups.values()) {
    owner.items = owner.items.filter((item) => item.state !== "missing");
    if (!owner.items.length) continue;
    for (const item of owner.items) {
      if (item.state === "refused") {
        owner.unknown.add(`${item.path} (reached through a link)`);
        item.bytes = 0;
        item.complete = true;
        continue;
      }
      const size = Date.now() > deadline ? { bytes: 0, complete: false, hardlinked: false } : sizeOf(item.path, { deadline, seen });
      Object.assign(item, { bytes: size.bytes, complete: size.complete });
      report.hardlinked ||= size.hardlinked;
      if (processes === null) owner.inUse.add("the process list is unavailable");
      else if (processes.includes(item.path)) owner.inUse.add("a running process names it");
      if (item.role === "data") {
        for (const name of ["zeros.db", "zeros.db-wal"]) if (present(home, path.join(item.path, name))) owner.holds.add("a database");
        if (present(home, path.join(item.path, "secrets.json"))) owner.holds.add("a secrets file");
        const profiles = hasEntries(home, path.join(item.path, "provider-accounts"));
        if (profiles === "yes") owner.holds.add("provider profiles");
        else if (profiles === "unknown") owner.unknown.add("provider profiles");
        const electron = hasEntries(home, path.join(item.path, "electron"));
        if (electron === "yes") owner.holds.add("a renderer profile");
        const lock = singleton(home, item.path, hostname);
        if (lock === "live") owner.inUse.add("its app is running");
        else if (lock === "unknown") owner.inUse.add("its app's profile lock names another process or host");
      }
      if (item.role === "session") {
        const entries = hasEntries(home, item.path);
        if (entries === "yes") owner.holds.add("a renderer profile");
        else if (entries === "unknown") owner.unknown.add("its renderer profile");
      }
      if (item.role === "state" || item.role === "worktrees") {
        const worktrees = hasEntries(home, item.role === "state" ? path.join(item.path, "worktrees") : item.path);
        if (worktrees === "yes") owner.holds.add("worktrees");
        else if (worktrees === "unknown") owner.unknown.add("worktrees");
      }
      if (item.role === "visible") {
        const work = visibleWork(home, item.path);
        if (work === "yes") owner.holds.add("workspaces");
        else if (work === "unknown") owner.unknown.add("workspaces");
      }
    }
    report.groups.push({
      category: owner.category,
      identity: owner.identity,
      status: owner.status,
      holds: [...owner.holds],
      unknown: [...owner.unknown],
      inUse: [...owner.inUse],
      items: owner.items.map(({ path: target, role, bytes, complete, state }) => ({ path: target, role, bytes, complete, readable: state === "ok" })),
    });
  }
  report.groups.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.identity.localeCompare(b.identity));
  if (keychain && platform === "darwin")
    report.keychain = KEYCHAIN.filter((entry) => only.includes(entry.category))
      .map((entry) => ({ ...entry, present: security(["find-generic-password", "-s", entry.service]) }));
  return report;
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

export function formatInventory(report) {
  if (report.problem) return `Nothing read: ${report.problem}.`;
  const lines = [];
  const where = (target) => path.join("~", path.relative(report.home, target));
  let total = 0;
  for (const category of CATEGORIES) {
    const rows = report.groups.filter((owner) => owner.category === category);
    if (!rows.length) continue;
    lines.push(`${category}:`);
    for (const owner of rows) {
      const facts = [
        owner.status,
        owner.holds.length ? `holds ${owner.holds.join(", ")}` : "holds nothing a person needs",
        owner.unknown.length ? `could not read ${owner.unknown.join(", ")}` : null,
        owner.inUse.length ? `looks in use: ${owner.inUse.join(", ")}` : "not in use",
      ].filter(Boolean);
      lines.push(`  ${owner.identity} — ${facts.join("; ")}`);
      for (const item of owner.items) {
        total += item.bytes;
        const size = item.readable ? `${human(item.bytes)}${item.complete ? "" : "+"}` : "not read";
        lines.push(`    ${size.padStart(9)}  ${where(item.path)}`);
      }
    }
  }
  if (report.unlisted.length) lines.push(`Could not list (unreadable or reached through a link): ${report.unlisted.map(where).join(", ")}`);
  if (report.registry) lines.push(`Instance registry: ${report.registry}`);
  for (const item of report.keychain) lines.push(`keychain: ${item.service} — ${item.present ? "present" : "not present"}`);
  lines.push(`Total on disk: ${human(total)}${report.hardlinked ? " (an upper bound: some files are hardlinked elsewhere)" : ""}`);
  lines.push("Read-only: nothing was changed.");
  return lines.join("\n");
}

export function helpText() {
  return [
    "pnpm storage:inventory — read-only report of Zeros data outside the installed apps.",
    "",
    "Categories:",
    "  dev-desktop    the retired Zeros Dev desktop's folders",
    "  beta           the retired Beta channel's folders",
    "  legacy-scheme  the retired design.zeros.app / design.zeros.oCanvas folders",
    "  development    development identities, registered or not, with what they hold and whether they look in use",
    "",
    "Options: --only <category,…>  --keychain  --json  --help",
    "It never deletes, moves or writes anything.",
  ].join("\n");
}

export function parseArguments(argv) {
  const options = { only: CATEGORIES, keychain: false, json: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--keychain") options.keychain = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--only") {
      const only = (argv[++index] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      if (!only.length || only.some((value) => !CATEGORIES.includes(value))) throw new Error(`--only takes ${CATEGORIES.join(", ")}`);
      options.only = only;
    } else throw new Error(`Unknown option ${arg}. storage:inventory only reports; see --help.`);
  }
  return options;
}

export function main(argv = process.argv.slice(2), { platform = process.platform, home = os.homedir(), ...deps } = {}) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  const report = inventory({ home, platform, only: options.only, keychain: options.keychain, ...deps });
  console.log(options.json ? JSON.stringify(report, null, 2) : formatInventory(report));
  return report.problem ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[storage:inventory] ${error.message}`);
    process.exitCode = 2;
  }
}
