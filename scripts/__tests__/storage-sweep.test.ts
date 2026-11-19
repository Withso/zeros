import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REGENERABLE_ENTRIES, applySweep, formatPlan, main, neverTouch, parseArguments, planSweep } from "../storage-sweep.mjs";
import { REGENERABLE_SESSION_ENTRIES } from "../../apps/desktop/src/engine/db/session-entries";
import { readRegistry, registryPath, upsertInstance } from "../local-instance-registry.mjs";
import { acquireLease } from "../local-instance-lease.mjs";

const roots: string[] = [];
function temporary(prefix = "zeros-sweep-") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const exists = (file: string) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

function dir(file: string, contents = "x") {
  fs.mkdirSync(file, { recursive: true });
  fs.writeFileSync(path.join(file, "data"), contents);
  return file;
}
function emptyDir(target: string) {
  fs.mkdirSync(target, { recursive: true });
  return path.dirname(target);
}
function file(target: string, contents = "plist") {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

/** A Mac home with residue in every category plus everything that must stay. */
function fixture() {
  const home = temporary();
  const L = (...parts: string[]) => path.join(home, "Library", ...parts);
  const residue = {
    "dev-desktop": [
      dir(L("Application Support", "com.zeros.dev")),
      dir(L("Application Support", "com.zeros.dev.coralline-ebf2")),
      dir(L("Application Support", "Zeros Dev")),
      dir(L("Application Support", "Zeros — Coralline")),
      dir(L("Caches", "com.zeros.dev.coralline-ebf2")),
      dir(L("Caches", "design.zeros.app.dev.coralline-ebf2")),
      dir(L("Logs", "com.zeros.dev")),
      file(L("Preferences", "com.zeros.dev.coralline-ebf2.plist")),
      dir(L("HTTPStorages", "com.zeros.dev")),
      dir(L("WebKit", "com.zeros.dev")),
      dir(L("Saved Application State", "com.zeros.dev.savedState")),
      dir(path.join(home, ".zeros-dev", "dev-instances", "coralline-ebf2")),
      emptyDir(path.join(home, "zeros-dev-coralline-ebf2", "workspaces")),
    ],
    beta: [
      dir(L("Application Support", "com.zeros.beta")),
      dir(L("Caches", "design.zeros.beta")),
      file(L("Preferences", "com.zeros.beta.plist")),
      dir(path.join(home, ".zeros-beta")),
      emptyDir(path.join(home, "zeros-beta", "design workspaces")),
    ],
    "legacy-scheme": [
      dir(L("Application Support", "design.zeros.app")),
      dir(L("Caches", "design.zeros.oCanvas")),
      file(L("Preferences", "design.zeros.app.plist")),
    ],
    "local-unregistered": [
      dir(L("Application Support", "com.zeros.local.b123456789abcdef")),
      dir(L("Caches", "com.zeros.local.b123456789abcdef")),
      dir(L("Logs", "com.zeros.local.b123456789abcdef")),
      file(L("Preferences", "com.zeros.local.b123456789abcdef.plist")),
      dir(L("HTTPStorages", "com.zeros.local.b123456789abcdef")),
      dir(L("WebKit", "com.zeros.local.b123456789abcdef")),
      dir(L("Saved Application State", "com.zeros.local.b123456789abcdef.savedState")),
      dir(path.join(home, ".zeros-local", "instances", "b123456789abcdef")),
      dir(path.join(home, ".zeros-local", "dev-instances")),
      emptyDir(path.join(home, "zeros-local-b123456789abcdef", "workspaces")),
      dir(L("Application Support", "com.zeros.local", "instances", "design-qual-0011aabb")),
      dir(L("Caches", "com.zeros.local", "bundles", "design-qual-0011aabb")),
    ],
  };
  const keep = [
    dir(L("Application Support", "com.zeros")),
    dir(L("Application Support", "com.zeros.alpha")),
    dir(L("Caches", "com.zeros")),
    dir(L("Logs", "com.zeros.alpha")),
    file(L("Preferences", "com.zeros.plist")),
    file(L("Preferences", "com.zeros.alpha.plist")),
    dir(L("Application Support", "com.zeros.devtools-unrelated")),
    dir(path.join(home, ".zeros")),
    dir(path.join(home, ".zeros-alpha")),
    dir(path.join(home, "zeros", "workspaces")),
    dir(path.join(home, "zeros-alpha")),
    dir(path.join(home, ".zeros-dev", "environments")),
    dir(path.join(home, ".zeros-dev", "auth")),
    dir(path.join(home, ".zeros-dev", "callbacks")),
    file(L("Application Support", "com.zeros.local", "secrets.json"), "{}"),
    file(L("Application Support", "com.zeros", "electron", ".zeros-session-relocated"), "2026-11-01"),
  ];
  // Registered and live: never swept.
  const registered = dir(L("Application Support", "com.zeros.local", "instances", "alpha"));
  upsertInstance(registryPath({ home, platform: "darwin", env: {} }), "alpha",
    { kind: "alpha", name: "Zeros Local Alpha", checkout: null, layout: "v2" });
  keep.push(registered, registryPath({ home, platform: "darwin", env: {} }));
  // Registered, checkout gone: orphaned.
  const orphan = "c123456789abcdef";
  upsertInstance(registryPath({ home, platform: "darwin", env: {} }), orphan,
    { kind: "checkout", name: "C", checkout: path.join(home, "deleted-checkout"), layout: "v2" });
  const orphaned = [
    dir(L("Application Support", "com.zeros.local", "instances", orphan)),
    dir(L("Caches", "com.zeros.local", "instances", orphan)),
    dir(L("Logs", "com.zeros.local", orphan)),
    dir(path.join(home, ".zeros-local", "instances", orphan)),
    emptyDir(path.join(home, "zeros-local", orphan, "workspaces")),
  ];
  // Every identity the fixture holds, as the plan names them.
  const identities = ["dev", "coralline-ebf2", "coralline", "beta", "design.zeros.app", "design.zeros.oCanvas",
    "b123456789abcdef", "dev-instances", "design-qual-0011aabb", orphan];
  return { home, residue: { ...residue, "local-orphaned": orphaned }, keep, orphan, identities };
}

const idle = () => "";
const quietly = () => vi.spyOn(console, "log").mockImplementation(() => {});

type Row = { path: string; action: string; reason: string | null; identity: string; category: string; bytes: number };
type Plan = { items: Row[] };
const rowFor = (plan: Plan, target: string) => plan.items.find((item) => item.path === target);
const L = (home: string, ...parts: string[]) => path.join(home, "Library", ...parts);
// A real process whose command line names a launcher, as the lease classifier reads it.
const launchers: Array<ReturnType<typeof spawn>> = [];
function launcher() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)", "scripts/electron-local.mjs"], { stdio: "ignore" });
  launchers.push(child);
  return child.pid as number;
}
afterEach(() => {
  for (const child of launchers.splice(0)) child.kill("SIGKILL");
});
function lease(stateRoot: string, pid: number) {
  file(path.join(stateRoot, "launcher.lease"), JSON.stringify({ pid, token: "launcher", at: Date.now() }));
}

describe("pnpm storage:sweep", () => {
  it("is a dry run by default that lists every category with sizes and deletes nothing", () => {
    const { home, residue, keep } = fixture();
    const log = quietly();
    expect(main([], { platform: "darwin", home, processList: idle })).toBe(0);
    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    for (const category of Object.keys(residue)) expect(output).toContain(`${category}:`);
    expect(output).toContain("would remove");
    expect(output).toMatch(/Total removable: .* \(dry run; pass --apply to delete/);
    for (const target of [...Object.values(residue).flat(), ...keep]) expect(exists(target), target).toBe(true);
  });

  it("removes every named identity and never touches the protected list", () => {
    const { home, residue, keep, orphan, identities } = fixture();
    quietly();
    expect(main(["--apply", "--identity", identities.join(",")], { platform: "darwin", home, processList: idle })).toBe(0);
    for (const [category, targets] of Object.entries(residue))
      for (const target of targets) expect(exists(target), `${category}: ${target}`).toBe(false);
    for (const target of keep) expect(exists(target), target).toBe(true);
    const registry = readRegistry(registryPath({ home, platform: "darwin", env: {} }));
    expect(Object.keys(registry.instances)).toEqual(["alpha"]);
    expect(registry.instances[orphan]).toBeUndefined();
  });

  it("without naming, removes only bundles and identities provably empty of user data", () => {
    const { home, residue } = fixture();
    const empty = L(home, "Caches", "com.zeros.dev.empty-1234");
    fs.mkdirSync(path.join(empty, "GPUCache"), { recursive: true });
    fs.mkdirSync(path.join(empty, "Code Cache"));
    const plan = planSweep({ home, processList: idle });
    expect(rowFor(plan, empty)).toMatchObject({ action: "remove", identity: "empty-1234" });
    const bundles = [path.join(home, ".zeros-dev", "dev-instances"), path.join(home, ".zeros-local", "dev-instances"),
      L(home, "Caches", "com.zeros.local", "bundles", "design-qual-0011aabb")];
    for (const target of bundles) expect(rowFor(plan, target), target).toMatchObject({ action: "remove" });
    const kept = Object.values(residue).flat().filter((target) => !bundles.some((bundle) => target === bundle || target.startsWith(`${bundle}/`)));
    for (const target of kept) {
      const row = rowFor(plan, target);
      if (row) expect(row.action, target).toBe("skip");
    }
    expect(rowFor(plan, L(home, "Application Support", "com.zeros.dev"))).toMatchObject({
      action: "skip", reason: "holds user data; name it with --identity to remove" });
    applySweep(plan);
    expect(exists(empty)).toBe(false);
    for (const target of bundles) expect(exists(target), target).toBe(false);
    for (const target of kept) expect(exists(target), target).toBe(true);
  });

  it("guards the never-touch list independently of the patterns", () => {
    const home = "/Users/fixture", L = `${home}/Library`;
    const blocked = neverTouch(home);
    for (const target of [
      `${L}/Application Support/com.zeros`, `${L}/Application Support/com.zeros.alpha`, `${L}/Caches/com.zeros.alpha`,
      `${L}/Logs/com.zeros`, `${L}/Preferences/com.zeros.plist`, `${L}/Preferences/com.zeros.alpha.plist`,
      `${L}/Saved Application State/com.zeros.savedState`, `${home}/.zeros`, `${home}/.zeros-alpha`, `${home}/zeros`,
      `${home}/zeros-alpha`, `${home}/.zeros-dev`, `${home}/.zeros-dev/environments`, `${home}/.zeros-dev/auth`,
      `${L}/Application Support/com.zeros.local`, `${L}/Application Support/com.zeros.local/secrets.json`,
      `${L}/Application Support/com.zeros.local/instances.json`,
    ]) expect(blocked(target), target).toBe(true);
    for (const target of [`${home}/.zeros-dev/dev-instances`, `${L}/Application Support/com.zeros.local/instances/x`,
      `${L}/Application Support/com.zeros.dev`]) expect(blocked(target), target).toBe(false);
  });

  it("narrows to --only categories and takes a comma-separated --identity", () => {
    const { home, residue } = fixture();
    const plan = planSweep({ home, only: ["beta"], identities: ["beta"], processList: idle });
    expect(new Set(plan.items.map((item: Row) => item.category))).toEqual(new Set(["beta"]));
    applySweep(plan);
    for (const target of residue.beta) expect(exists(target)).toBe(false);
    for (const target of residue["dev-desktop"]) expect(exists(target)).toBe(true);
    expect(() => parseArguments(["--only", "beta,production"])).toThrow(/--only/);
    expect(parseArguments(["--identity", "a, b,c"]).identities).toEqual(new Set(["a", "b", "c"]));
    expect(() => parseArguments(["--identity", ","])).toThrow(/--identity/);
  });

  it("keeps an identity whose visible root has workspaces unless it is named", () => {
    const { home } = fixture();
    const data = L(home, "Application Support/com.zeros.dev.coralline-ebf2");
    const work = path.join(home, "zeros-dev-coralline-ebf2", "workspaces", "repo", "ws");
    fs.mkdirSync(work, { recursive: true });
    const plan = planSweep({ home, processList: idle });
    const rows = plan.items.filter((item: Row) => item.category === "dev-desktop" && item.identity === "coralline-ebf2");
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(row).toMatchObject({ action: "skip", reason: "has workspaces; name it with --identity to remove" });
    applySweep(plan);
    expect(exists(work)).toBe(true);
    expect(exists(data)).toBe(true);
    const named = planSweep({ home, identities: ["coralline-ebf2"], processList: idle });
    expect(new Set(named.items.map((item: Row) => item.identity))).toEqual(new Set(["coralline-ebf2"]));
    applySweep(named);
    expect(exists(work)).toBe(false);
    expect(exists(data)).toBe(false);
  });

  it("keeps a registered checkout's remaining work", () => {
    const { home, orphan } = fixture();
    const work = path.join(home, "zeros-local", orphan, "workspaces", "repo");
    fs.mkdirSync(work, { recursive: true });
    const plan = planSweep({ home, only: ["local-orphaned"], processList: idle });
    expect(plan.items.every((item: Row) => item.action === "skip")).toBe(true);
    applySweep(plan);
    expect(exists(work)).toBe(true);
    expect(readRegistry(registryPath({ home, platform: "darwin", env: {} })).instances[orphan]).toBeDefined();
  });

  // Phase 2 finding 1: the state root can hold the only copy of a worktree.
  it("keeps an orphan whose only work is a worktree under its state root, and Beta's hidden worktrees", () => {
    const { home, orphan } = fixture();
    const worktree = file(path.join(home, ".zeros-local", "instances", orphan, "worktrees", "repo", "ws_101", "notes.txt"), "only copy");
    const beta = file(path.join(home, ".zeros-beta", "worktrees", "repo", "ws_7", "draft.md"), "only copy");
    const plan = planSweep({ home, only: ["local-orphaned", "beta"], processList: idle });
    for (const row of plan.items.filter((item: Row) => item.identity === orphan || item.category === "beta"))
      expect(row, row.path).toMatchObject({ action: "skip", reason: "has workspaces; name it with --identity to remove" });
    applySweep(plan);
    expect(fs.readFileSync(worktree, "utf8")).toBe("only copy");
    expect(fs.readFileSync(beta, "utf8")).toBe("only copy");
  });

  // Phase 2 finding 5: a kept identity keeps its renderer profile, in both layouts.
  it("keeps a legacy orphan's whole session cache while it holds work", () => {
    const home = temporary();
    const instance = "e123456789abcdef";
    upsertInstance(registryPath({ home, platform: "darwin", env: {} }), instance,
      { kind: "checkout", name: "E", checkout: path.join(home, "gone"), layout: "legacy" });
    const leveldb = file(L(home, "Caches", `com.zeros.local.${instance}`, "Local Storage", "leveldb", "000003.log"), "draft");
    fs.mkdirSync(path.join(home, `zeros-local-${instance}`, "design workspaces", "site", "home"), { recursive: true });
    const bundle = dir(path.join(home, ".zeros-local", "instances", instance, "bundle"));
    const plan = planSweep({ home, processList: idle });
    expect(rowFor(plan, L(home, "Caches", `com.zeros.local.${instance}`))).toMatchObject({ action: "skip" });
    expect(rowFor(plan, bundle)).toMatchObject({ action: "remove" });
    applySweep(plan);
    expect(fs.readFileSync(leveldb, "utf8")).toBe("draft");
    expect(exists(bundle)).toBe(false);
  });

  // Phase 2 finding 4: the lease lives in the state root, which a renamed checkout does not move.
  it("keeps an orphan whose checkout was renamed while its launcher still holds the lease, even when named", () => {
    const { home, orphan } = fixture();
    lease(path.join(home, ".zeros-local", "instances", orphan), launcher());
    const plan = planSweep({ home, only: ["local-orphaned"], identities: [orphan], processList: idle });
    expect(plan.items.length).toBeGreaterThan(0);
    for (const row of plan.items) expect(row).toMatchObject({ action: "skip", reason: "in use (a launcher holds it)" });
    applySweep(plan);
    expect(exists(L(home, "Application Support", "com.zeros.local", "instances", orphan))).toBe(true);
  });

  // Phase 2 finding 3: a missing or corrupt registry is not evidence of abandonment.
  it.each([
    ["missing", (registry: string) => fs.rmSync(registry)],
    ["corrupt", (registry: string) => fs.writeFileSync(registry, "{not json")],
  ])("keeps unregistered Local data when the registry is %s, and a reserved identity unless named", (label, damage) => {
    const home = temporary();
    const registry = registryPath({ home, platform: "darwin", env: {} });
    upsertInstance(registry, "alpha", { kind: "alpha", name: "Zeros Local Alpha", checkout: null, layout: "v2" });
    damage(registry);
    const hashed = L(home, "Application Support", "com.zeros.local", "instances", "f123456789abcdef");
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file(path.join(hashed, "zeros.db"), "db"), old, old);
    const alpha = file(L(home, "Application Support", "com.zeros.local", "instances", "alpha", "secrets.json"), "{}");
    const bundle = dir(L(home, "Caches", "com.zeros.local", "bundles", "f123456789abcdef"));
    const plan = planSweep({ home, identities: label === "missing" ? ["f123456789abcdef"] : null, processList: idle });
    const reason = label === "missing" ? "there is no instance registry" : "the instance registry is corrupt";
    expect(rowFor(plan, hashed)).toMatchObject({ action: "skip", reason });
    expect(rowFor(plan, bundle)).toMatchObject({ action: "skip", reason });
    applySweep(plan);
    expect(exists(path.join(hashed, "zeros.db"))).toBe(true);
    expect(exists(alpha)).toBe(true);
    expect(exists(bundle)).toBe(true);
  });

  it("keeps a reserved identity unless named, and a live alpha lease even when named", () => {
    const home = temporary();
    upsertInstance(registryPath({ home, platform: "darwin", env: {} }), "other", { kind: "alpha", name: "x", checkout: null, layout: "v2" });
    const alpha = dir(L(home, "Caches", "com.zeros.local", "bundles", "alpha"));
    expect(rowFor(planSweep({ home, processList: idle }), alpha)).toMatchObject({ action: "skip", reason: "a reserved identity" });
    lease(path.join(home, ".zeros-local", "instances", "alpha"), launcher());
    const plan = planSweep({ home, identities: ["alpha"], processList: idle });
    expect(rowFor(plan, alpha)).toMatchObject({ action: "skip", reason: "in use (a launcher holds it)" });
    applySweep(plan);
    expect(exists(alpha)).toBe(true);
  });

  it("keeps every group a failed folder listing may hide (EACCES on the visible root container)", () => {
    const { home } = fixture();
    const instance = "a923456789abcdef";
    const data = file(L(home, "Application Support", "com.zeros.local", "instances", instance, "zeros.db"), "db");
    fs.mkdirSync(path.join(home, "zeros-local", instance, "workspaces", "repo", "ws"), { recursive: true });
    const real = fs.readdirSync.bind(fs);
    const hidden = path.join(home, "zeros-local");
    vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === hidden) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return (real as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readdirSync);
    const plan = planSweep({ home, only: ["local-unregistered"], identities: [instance], processList: idle });
    expect(rowFor(plan, path.dirname(data))).toMatchObject({ action: "skip", reason: "a folder could not be listed" });
    applySweep(plan);
    expect(exists(data)).toBe(true);
  });

  it("refuses symlinks and never follows them", () => {
    const { home } = fixture();
    const outside = temporary("zeros-sweep-outside-");
    dir(path.join(outside, "precious"));
    fs.symlinkSync(path.join(outside, "precious"), L(home, "Caches/com.zeros.dev.evil"));
    fs.symlinkSync(outside, path.join(home, "zeros-dev-linked"));
    const plan = planSweep({ home, identities: ["evil", "linked"], processList: idle });
    for (const name of ["Library/Caches/com.zeros.dev.evil", "zeros-dev-linked"])
      expect(rowFor(plan, path.join(home, name))).toMatchObject({ action: "skip", reason: "symlink" });
    applySweep(plan);
    expect(exists(path.join(outside, "precious", "data"))).toBe(true);
    expect(exists(L(home, "Caches/com.zeros.dev.evil"))).toBe(true);
  });

  // Phase 2 finding 8: no I/O, sizing included, below a refused ancestor; $HOME itself is checked.
  it("lists, sizes and removes nothing reached through a symlinked Library folder or home", () => {
    const { home } = fixture();
    const outside = temporary("zeros-sweep-outside-");
    fs.writeFileSync(file(path.join(outside, "com.zeros.dev.linked", "blob"), ""), Buffer.alloc(64 * 1024, 1));
    fs.renameSync(L(home, "Caches"), path.join(outside, "real-caches"));
    fs.symlinkSync(outside, L(home, "Caches"));
    const readdir = vi.spyOn(fs, "readdirSync");
    const plan = planSweep({ home, identities: ["linked", "dev"], processList: idle });
    expect(readdir.mock.calls.some(([target]) => String(target).startsWith(L(home, "Caches")))).toBe(false);
    expect(plan.items.some((item: Row) => item.path.startsWith(L(home, "Caches")))).toBe(false);
    expect(plan.items.filter((item: Row) => item.category === "dev-desktop").every((item: Row) =>
      item.action === "skip" && item.reason === "a folder could not be listed")).toBe(true);
    applySweep(plan);
    expect(fs.statSync(path.join(outside, "com.zeros.dev.linked", "blob")).size).toBe(64 * 1024);

    const realHome = temporary(), linkedHome = path.join(temporary(), "home");
    dir(path.join(realHome, ".zeros-dev", "dev-instances"));
    fs.symlinkSync(realHome, linkedHome);
    const log = quietly();
    expect(main(["--apply"], { platform: "darwin", home: linkedHome, processList: idle })).toBe(2);
    expect(log.mock.calls.join("\n")).toContain("Nothing swept: the home folder is missing, a symlink or not a folder.");
    expect(exists(path.join(realHome, ".zeros-dev", "dev-instances", "data"))).toBe(true);
  });

  it("skips anything a running process uses, and everything when processes are unknown", () => {
    const { home, identities } = fixture();
    const live = L(home, "Application Support/com.zeros.dev.coralline-ebf2");
    const helper = `/x/Electron Helper --type=renderer --user-data-dir=${live}`;
    const plan = planSweep({ home, identities, processList: () => helper });
    for (const row of plan.items.filter((item: Row) => item.category === "dev-desktop" && item.identity === "coralline-ebf2"))
      expect(row.reason).toBe("in use by a running process");
    const unknown = planSweep({ home, identities, processList: () => null });
    expect(unknown.items.every((item: Row) => item.action === "skip" && item.reason === "process list unavailable")).toBe(true);
  });

  it("skips a Dev identity whose app profile lock names a live process", () => {
    const { home } = fixture();
    const data = L(home, "Application Support/com.zeros.dev.coralline-ebf2");
    fs.symlinkSync(`${os.hostname()}-${launcher()}`, path.join(data, "SingletonLock"));
    const plan = planSweep({ home, identities: ["coralline-ebf2"], processList: idle });
    for (const row of plan.items) expect(row).toMatchObject({ action: "skip", reason: "in use (the app is running)" });
  });

  const keychainCalls = (present: string[]) => {
    const calls: string[][] = [];
    const security = (args: string[]) => {
      calls.push(args);
      if (args[0] === "find-generic-password") return present.includes(args[2]);
      return calls.filter((call) => call[0] === "delete-generic-password" && call[2] === args[2]).length === 1;
    };
    return { calls, security };
  };

  it("reports Safe Storage items without reading them and removes one only once its family is gone", () => {
    const home = temporary();
    const { calls, security } = keychainCalls(["Zeros Dev Safe Storage", "Zeros Beta Safe Storage"]);
    const plan = planSweep({ home, keychain: true, security, processList: idle, only: ["dev-desktop"] });
    expect(plan.keychain).toEqual([{ category: "dev-desktop", service: "Zeros Dev Safe Storage", present: true }]);
    expect(calls.every((args) => !args.includes("-w") && !args.includes("-g"))).toBe(true);
    expect(calls.some((args) => args[0] === "delete-generic-password")).toBe(false);
    expect(applySweep(plan, { security }).keychain).toEqual([{ service: "Zeros Dev Safe Storage", removed: 1 }]);
    expect(calls.some((args) => args[2] === "Zeros Beta Safe Storage" && args[0] === "delete-generic-password")).toBe(false);
  });

  // Phase 2 finding 7: keychain deletion is scoped to a swept, fully removed family.
  it("keeps both Safe Storage items when every Beta file is kept for work", () => {
    const { home } = fixture();
    fs.mkdirSync(path.join(home, "zeros-beta", "design workspaces", "site", "home"), { recursive: true });
    const { calls, security } = keychainCalls(["Zeros Dev Safe Storage", "Zeros Beta Safe Storage"]);
    const plan = planSweep({ home, keychain: true, security, processList: idle, only: ["beta"] });
    expect(plan.items.every((item: Row) => item.action === "skip")).toBe(true);
    const outcome = applySweep(plan, { security });
    expect(calls.some((args) => args[0] === "delete-generic-password")).toBe(false);
    expect(outcome.keychain).toEqual([{ service: "Zeros Beta Safe Storage", removed: 0, reason: "files of that app remain" }]);
  });

  // Phase 2 finding 7: one Dev identity used its slug, its display label and the shared store.
  it("keeps what a retained Dev identity depends on: its label folder and the shared com.zeros.dev store", () => {
    const home = temporary();
    const db = file(L(home, "Application Support", "com.zeros.dev.coral-reef", "zeros.db"), "db");
    fs.mkdirSync(path.join(home, "zeros-dev-coral-reef", "workspaces", "repo", "ws"), { recursive: true });
    const settings = file(L(home, "Application Support", "Zeros — Coral Reef", "app-settings.json"), "{}");
    const shared = file(L(home, "Application Support", "com.zeros.dev", "secrets.json"), "{}");
    const unnamed = planSweep({ home, processList: idle });
    expect(rowFor(unnamed, path.dirname(settings))).toMatchObject({ identity: "coral-reef", action: "skip" });
    applySweep(unnamed);
    for (const target of [db, settings, shared]) expect(exists(target), target).toBe(true);
    const sharedOnly = planSweep({ home, identities: ["dev"], processList: idle });
    expect(rowFor(sharedOnly, path.dirname(shared))).toMatchObject({ action: "skip", reason: "another Zeros Dev identity depends on it" });
    applySweep(sharedOnly);
    expect(exists(shared)).toBe(true);
    applySweep(planSweep({ home, identities: ["coral-reef", "dev"], processList: idle }));
    for (const target of [db, settings, shared]) expect(exists(target), target).toBe(false);
  });

  // Phase 2 finding 6: Caches/design.zeros.app can be installed Stable's only renderer state.
  it("keeps the legacy scheme's cache until Stable's profile has moved, even when named", () => {
    const home = temporary();
    const leveldb = file(L(home, "Caches", "design.zeros.app", "Local Storage", "leveldb", "000003.log"), "draft");
    const plan = planSweep({ home, only: ["legacy-scheme"], identities: ["design.zeros.app"], processList: idle });
    expect(rowFor(plan, L(home, "Caches", "design.zeros.app"))).toMatchObject({
      action: "skip", reason: "Stable's renderer profile has not moved yet; this may be its only copy" });
    applySweep(plan);
    expect(exists(leveldb)).toBe(true);
    file(L(home, "Application Support", "com.zeros", "electron", ".zeros-session-relocated"), "x");
    applySweep(planSweep({ home, only: ["legacy-scheme"], identities: ["design.zeros.app"], processList: idle }));
    expect(exists(leveldb)).toBe(false);
  });

  const legacyData = (home: string) => L(home, "Application Support/com.zeros.local.b123456789abcdef");
  const sharedStore = (home: string) => L(home, "Application Support/com.zeros.local/secrets.json");
  const marker = (home: string) =>
    `local-provider-migration:${createHash("sha256").update(path.join(legacyData(home), "secrets.json")).digest("hex")}`;

  it.each([
    ["a migration marker names it", (home: string) => JSON.stringify({ [marker(home)]: "enc" })],
    ["the store is unreadable", () => "{broken"],
    // Phase 2 finding 9: the app's reader rejects a store with a non-string entry.
    ["the app's reader would reject the store", () => JSON.stringify({ "anthropic-api-key": { nested: true } })],
  ])("keeps a named unregistered data dir the shared provider store may reference (%s)", (_label, store) => {
    const { home } = fixture();
    fs.writeFileSync(sharedStore(home), store(home));
    const plan = planSweep({ home, only: ["local-unregistered"], identities: ["b123456789abcdef"], processList: idle });
    expect(rowFor(plan, legacyData(home))).toMatchObject({ action: "skip", reason: "provider profiles referenced by the shared Local store" });
    expect(rowFor(plan, path.join(home, ".zeros-local/instances/b123456789abcdef"))).toMatchObject({ action: "skip" });
    applySweep(plan);
    expect(exists(path.join(legacyData(home), "data"))).toBe(true);
    expect(exists(L(home, "HTTPStorages/com.zeros.local.b123456789abcdef"))).toBe(false);
  });

  it("removes a named unregistered data dir the shared provider store does not reference", () => {
    const { home } = fixture();
    fs.writeFileSync(sharedStore(home), JSON.stringify({ "local-provider-migration:0000": "enc", "anthropic-api-key": "enc" }));
    applySweep(planSweep({ home, only: ["local-unregistered"], identities: ["b123456789abcdef"], processList: idle }));
    expect(exists(legacyData(home))).toBe(false);
  });

  // Phase 2 finding 2: apply re-validates each group against fresh evidence.
  it.each([
    ["it was registered", (home: string) => {
      fs.mkdirSync(path.join(home, "checkout"));
      upsertInstance(registryPath({ home, platform: "darwin", env: {} }), "b123456789abcdef",
        { kind: "checkout", name: "B", checkout: path.join(home, "checkout"), layout: "legacy" });
    }],
    ["the shared store gained its provider marker", (home: string) => fs.writeFileSync(sharedStore(home), JSON.stringify({ [marker(home)]: "enc" }))],
    ["its visible root gained a Design workspace", (home: string) =>
      file(path.join(home, "zeros-local-b123456789abcdef", "design workspaces", "site", "home", "index.html"), "<p>")],
    ["its launcher started", (home: string) => lease(path.join(home, ".zeros-local", "instances", "b123456789abcdef"), launcher())],
  ])("keeps a planned identity whose evidence changed before apply (%s)", (_label, change) => {
    const { home } = fixture();
    const profile = file(path.join(legacyData(home), "provider-accounts", "claude", "1b4e28ba", "config.json"), "{}");
    const plan = planSweep({ home, only: ["local-unregistered"], identities: ["b123456789abcdef"], processList: idle });
    expect(rowFor(plan, legacyData(home))).toMatchObject({ action: "remove" });
    change(home);
    const outcome = applySweep(plan);
    expect(exists(profile)).toBe(true);
    expect(exists(path.join(home, ".zeros-local", "instances", "b123456789abcdef"))).toBe(true);
    expect(outcome.results.every((result: { outcome: string }) => result.outcome !== "removed")).toBe(true);
  });

  it("holds the identity's lease while it re-validates and removes it", () => {
    const { home } = fixture();
    const roots = { stateRoot: path.join(home, ".zeros-local", "instances", "b123456789abcdef") };
    const plan = planSweep({ home, only: ["local-unregistered"], identities: ["b123456789abcdef"], processList: idle });
    expect(rowFor(plan, legacyData(home))).toMatchObject({ action: "remove" });
    const attempts: string[] = [];
    applySweep(plan, { processList: () => {
      try {
        acquireLease(roots)();
        attempts.push("granted");
      } catch {
        attempts.push("refused");
      }
      return "";
    } });
    expect(attempts).toEqual(["refused"]);
    expect(exists(legacyData(home))).toBe(false);
    expect(exists(roots.stateRoot)).toBe(false);
  });

  it("reports allocated size and counts a hardlinked inode once", () => {
    const home = temporary(), caches = L(home, "Caches");
    const first = path.join(caches, "com.zeros.dev.a"), second = path.join(caches, "com.zeros.dev.b");
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "blob"), Buffer.alloc(64 * 1024, 1));
    fs.linkSync(path.join(first, "blob"), path.join(second, "blob"));
    fs.linkSync(path.join(first, "blob"), path.join(first, "again"));
    const plan = planSweep({ home, only: ["dev-desktop"], processList: idle });
    const total = plan.items.reduce((sum: number, item: Row) => sum + item.bytes, 0);
    const blob = fs.statSync(path.join(first, "blob"));
    const allocated = (target: string) => fs.lstatSync(target).blocks * 512;
    expect(total).toBe(blob.blocks * 512 + allocated(first) + allocated(second));
  });

  // Phase 2 finding 20: the total is what apply removed, and an upper bound when hardlinked.
  it("totals only what apply removed, as an upper bound when a removed file has another link", () => {
    const home = temporary();
    const base = file(path.join(home, "node_modules-base", "blob"), "");
    fs.writeFileSync(base, Buffer.alloc(64 * 1024, 1));
    const bundle = path.join(home, ".zeros-dev", "dev-instances", "x");
    fs.mkdirSync(bundle, { recursive: true });
    fs.linkSync(base, path.join(bundle, "blob"));
    const held = dir(L(home, "Caches", "com.zeros.local", "bundles", "g123456789abcdef"));
    upsertInstance(registryPath({ home, platform: "darwin", env: {} }), "other", { kind: "alpha", name: "x", checkout: null, layout: "v2" });
    const plan = planSweep({ home, processList: idle });
    expect(rowFor(plan, held)).toMatchObject({ action: "remove" });
    const outcome = applySweep(plan, { processList: () => `/bin/app ${held}` });
    expect(exists(held)).toBe(true);
    const removed = plan.items.filter((item: Row) => item.path === path.join(home, ".zeros-dev", "dev-instances"));
    const text = formatPlan(plan, outcome);
    expect(text).toContain("Total removed: ");
    expect(text).toContain("upper bound");
    expect(outcome.results.reduce((sum: number, result: { bytes: number }) => sum + result.bytes, 0)).toBe(removed[0].bytes);
    expect(text).toContain(`Total removed: ${(removed[0].bytes / 1024).toFixed(1)} KB (`);
    expect(fs.readFileSync(base).length).toBe(64 * 1024);
  });

  it("recognises exactly the engine's regenerable session entries", () => {
    expect([...REGENERABLE_ENTRIES].sort()).toEqual([...REGENERABLE_SESSION_ENTRIES].sort());
  });

  it("runs from a checkout with no node_modules", () => {
    const { home } = fixture();
    const checkout = temporary("zeros-sweep-checkout-");
    for (const relative of [
      "scripts/storage-sweep.mjs", "scripts/local-instance-registry.mjs", "scripts/local-instance-prune.mjs",
      "scripts/local-instance-lease.mjs", "scripts/storage-removal.mjs", "scripts/exclusive-file-lock.mjs",
      "apps/desktop/src/engine/db/local-development-paths.cjs",
      "apps/desktop/src/engine/db/contained-removal.cjs",
    ]) {
      fs.mkdirSync(path.dirname(path.join(checkout, relative)), { recursive: true });
      fs.copyFileSync(relative, path.join(checkout, relative));
    }
    const preload = path.join(checkout, "darwin.cjs");
    fs.writeFileSync(preload, "Object.defineProperty(process,'platform',{value:'darwin'});");
    const result = spawnSync(process.execPath, ["--require", preload, path.join(checkout, "scripts/storage-sweep.mjs")], {
      cwd: checkout, env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8", timeout: 30_000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dev-desktop:");
    expect(exists(L(home, "Application Support/com.zeros.dev"))).toBe(true);
  });
});
