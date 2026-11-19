import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySweep, main, neverTouch, parseArguments, planSweep } from "../storage-sweep.mjs";
import { readRegistry, registryPath, upsertInstance } from "../local-instance-registry.mjs";

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
  return { home, residue: { ...residue, "local-orphaned": orphaned }, keep, orphan };
}

const idle = () => "";
const quietly = () => vi.spyOn(console, "log").mockImplementation(() => {});

describe("pnpm storage:sweep", () => {
  it("is a dry run by default that lists every category with sizes and deletes nothing", () => {
    const { home, residue, keep } = fixture();
    const log = quietly();
    expect(main([], { platform: "darwin", home, processList: idle })).toBe(0);
    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    for (const category of Object.keys(residue)) expect(output).toContain(`${category}:`);
    expect(output).toContain("would remove");
    expect(output).toMatch(/Total removable: .* \(dry run; pass --apply to delete\)/);
    for (const target of [...Object.values(residue).flat(), ...keep]) expect(exists(target), target).toBe(true);
  });

  it("applies every category and never touches the protected list", () => {
    const { home, residue, keep, orphan } = fixture();
    quietly();
    expect(main(["--apply"], { platform: "darwin", home, processList: idle })).toBe(0);
    for (const [category, targets] of Object.entries(residue))
      for (const target of targets) expect(exists(target), `${category}: ${target}`).toBe(false);
    for (const target of keep) expect(exists(target), target).toBe(true);
    const registry = readRegistry(registryPath({ home, platform: "darwin", env: {} }));
    expect(Object.keys(registry.instances)).toEqual(["alpha"]);
    expect(registry.instances[orphan]).toBeUndefined();
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

  it("narrows to --only categories", () => {
    const { home, residue } = fixture();
    const plan = planSweep({ home, only: ["beta"], processList: idle });
    expect(new Set(plan.items.map((item: { category: string }) => item.category))).toEqual(new Set(["beta"]));
    applySweep(plan);
    for (const target of residue.beta) expect(exists(target)).toBe(false);
    for (const target of residue["dev-desktop"]) expect(exists(target)).toBe(true);
    expect(() => parseArguments(["--only", "beta,production"])).toThrow(/--only/);
  });

  it("skips an identity whose visible root has workspaces unless it is named", () => {
    const { home } = fixture();
    const data = path.join(home, "Library/Application Support/com.zeros.dev.coralline-ebf2");
    const work = path.join(home, "zeros-dev-coralline-ebf2", "workspaces", "repo", "ws");
    fs.mkdirSync(work, { recursive: true });
    const plan = planSweep({ home, processList: idle });
    const rows = plan.items.filter((item: { identity: string; category: string }) => item.category === "dev-desktop" && item.identity === "coralline-ebf2");
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(row).toMatchObject({ action: "skip", reason: "has workspaces" });
    applySweep(plan);
    expect(exists(work)).toBe(true);
    expect(exists(data)).toBe(true);
    const named = planSweep({ home, identity: "coralline-ebf2", processList: idle });
    expect(new Set(named.items.map((item: { identity: string }) => item.identity))).toEqual(new Set(["coralline-ebf2"]));
    applySweep(named);
    expect(exists(work)).toBe(false);
    expect(exists(data)).toBe(false);
  });

  it("treats a registered checkout's remaining work as orphaned but protected", () => {
    const { home, orphan } = fixture();
    const work = path.join(home, "zeros-local", orphan, "workspaces", "repo");
    fs.mkdirSync(work, { recursive: true });
    const plan = planSweep({ home, only: ["local-orphaned"], processList: idle });
    expect(plan.items.every((item: { reason: string }) => item.reason === "has workspaces")).toBe(true);
    applySweep(plan);
    expect(exists(work)).toBe(true);
    expect(readRegistry(registryPath({ home, platform: "darwin", env: {} })).instances[orphan]).toBeDefined();
  });

  it("refuses symlinks and never follows them", () => {
    const { home } = fixture();
    const outside = temporary("zeros-sweep-outside-");
    dir(path.join(outside, "precious"));
    fs.symlinkSync(path.join(outside, "precious"), path.join(home, "Library/Caches/com.zeros.dev.evil"));
    fs.symlinkSync(outside, path.join(home, "zeros-dev-linked"));
    const plan = planSweep({ home, processList: idle });
    for (const name of ["Library/Caches/com.zeros.dev.evil", "zeros-dev-linked"])
      expect(plan.items.find((item: { path: string }) => item.path === path.join(home, name))).toMatchObject({ action: "skip", reason: "symlink" });
    applySweep(plan);
    expect(exists(path.join(outside, "precious", "data"))).toBe(true);
    expect(exists(path.join(home, "Library/Caches/com.zeros.dev.evil"))).toBe(true);
  });

  it("refuses a residue folder reached through a symlinked Library folder", () => {
    const home = temporary(), outside = temporary("zeros-sweep-outside-");
    dir(path.join(outside, "com.zeros.dev"));
    fs.mkdirSync(path.join(home, "Library"));
    fs.symlinkSync(outside, path.join(home, "Library", "Caches"));
    const plan = planSweep({ home, processList: idle });
    expect(plan.items.find((item: { path: string }) => item.path.endsWith("com.zeros.dev"))).toMatchObject({ action: "skip", reason: "symlink" });
    applySweep(plan);
    expect(exists(path.join(outside, "com.zeros.dev", "data"))).toBe(true);
  });

  it("skips anything a running process uses, and everything when processes are unknown", () => {
    const { home } = fixture();
    const live = path.join(home, "Library/Application Support/com.zeros.dev.coralline-ebf2");
    const helper = `/x/Electron Helper --type=renderer --user-data-dir=${live}`;
    const plan = planSweep({ home, processList: () => helper });
    for (const row of plan.items.filter((item: { identity: string; category: string }) => item.category === "dev-desktop" && item.identity === "coralline-ebf2"))
      expect(row.reason).toBe("in use by a running process");
    expect(planSweep({ home, processList: () => null }).items.every((item: { action: string }) => item.action === "skip")).toBe(true);
  });

  it("reports Safe Storage items without reading them and removes them only with --apply", () => {
    const { home } = fixture();
    const calls: string[][] = [];
    const security = (args: string[]) => {
      calls.push(args);
      if (args[0] === "find-generic-password") return args[2] === "Zeros Dev Safe Storage";
      return calls.filter((call) => call[0] === "delete-generic-password").length === 1;
    };
    const plan = planSweep({ home, keychain: true, security, processList: idle, only: [] });
    expect(plan.keychain).toEqual([
      { service: "Zeros Dev Safe Storage", present: true },
      { service: "Zeros Beta Safe Storage", present: false },
    ]);
    expect(calls.every((args) => !args.includes("-w") && !args.includes("-g"))).toBe(true);
    expect(calls.some((args) => args[0] === "delete-generic-password")).toBe(false);
    expect(applySweep(plan, { security }).keychain).toEqual([{ service: "Zeros Dev Safe Storage", removed: 1 }]);
  });

  const legacyData = (home: string) => path.join(home, "Library/Application Support/com.zeros.local.b123456789abcdef");
  const sharedStore = (home: string) => path.join(home, "Library/Application Support/com.zeros.local/secrets.json");
  const rowFor = (plan: { items: Array<{ path: string; action: string; reason: string | null }> }, target: string) =>
    plan.items.find((item) => item.path === target);

  it.each([
    ["a migration marker names it", (home: string) => JSON.stringify({
      [`local-provider-migration:${createHash("sha256").update(path.join(legacyData(home), "secrets.json")).digest("hex")}`]: "enc" })],
    ["the store is unreadable", () => "{broken"],
  ])("keeps an unregistered data dir the shared provider store may reference (%s)", (_label, store) => {
    const { home } = fixture();
    fs.writeFileSync(sharedStore(home), store(home));
    const plan = planSweep({ home, only: ["local-unregistered"], processList: idle });
    expect(rowFor(plan, legacyData(home))).toMatchObject({ action: "skip", reason: "provider profiles referenced by the shared Local store" });
    expect(rowFor(plan, path.join(home, ".zeros-local/instances/b123456789abcdef"))).toMatchObject({ action: "skip" });
    applySweep(plan);
    expect(exists(path.join(legacyData(home), "data"))).toBe(true);
    expect(exists(path.join(home, "Library/Caches/com.zeros.local.b123456789abcdef"))).toBe(false);
    expect(exists(path.join(home, "Library/HTTPStorages/com.zeros.local.b123456789abcdef"))).toBe(false);
  });

  it("removes an unregistered data dir the shared provider store does not reference", () => {
    const { home } = fixture();
    fs.writeFileSync(sharedStore(home), JSON.stringify({ "local-provider-migration:0000": "enc", "anthropic-api-key": "enc" }));
    applySweep(planSweep({ home, only: ["local-unregistered"], processList: idle }));
    expect(exists(legacyData(home))).toBe(false);
  });

  it.each([
    ["zeros.db", 13, "skip"],
    ["zeros.db-wal", 13, "skip"],
    ["zeros.db", 15, "remove"],
  ])("treats an unregistered checkout whose %s changed %i days ago as used recently or not", (name, days, action) => {
    const { home } = fixture();
    for (const data of [legacyData(home), path.join(home, "Library/Application Support/com.zeros.local/instances/d123456789abcdef")]) {
      fs.mkdirSync(data, { recursive: true });
      const db = path.join(data, name);
      fs.writeFileSync(db, "db");
      const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      fs.utimesSync(db, when, when);
    }
    const plan = planSweep({ home, only: ["local-unregistered"], processList: idle });
    for (const identity of ["b123456789abcdef", "d123456789abcdef"]) {
      const rows = plan.items.filter((item: { identity: string }) => item.identity === identity);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.action, `${identity} ${row.path}`).toBe(action);
        if (action === "skip") expect(row.reason).toBe("used recently; launch it once to register it, or pass --identity");
      }
    }
    if (action === "skip") {
      const named = planSweep({ home, only: ["local-unregistered"], identity: "b123456789abcdef", processList: idle });
      expect(named.items.every((item: { action: string }) => item.action === "remove")).toBe(true);
    }
  });

  it("reports allocated size and counts a hardlinked inode once", () => {
    const home = temporary(), caches = path.join(home, "Library", "Caches");
    const first = path.join(caches, "com.zeros.dev.a"), second = path.join(caches, "com.zeros.dev.b");
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "blob"), Buffer.alloc(64 * 1024, 1));
    fs.linkSync(path.join(first, "blob"), path.join(second, "blob"));
    fs.linkSync(path.join(first, "blob"), path.join(first, "again"));
    const plan = planSweep({ home, only: ["dev-desktop"], processList: idle });
    const total = plan.items.reduce((sum: number, item: { bytes: number }) => sum + item.bytes, 0);
    const blob = fs.statSync(path.join(first, "blob"));
    const allocated = (target: string) => { const stat = fs.lstatSync(target); return stat.blocks * 512; };
    expect(total).toBe(blob.blocks * 512 + allocated(first) + allocated(second));
  });

  it("re-checks a visible root for new work immediately before removing it", () => {
    const { home } = fixture();
    const visible = path.join(home, "zeros-dev-coralline-ebf2");
    const data = path.join(home, "Library/Application Support/com.zeros.dev.coralline-ebf2");
    const plan = planSweep({ home, only: ["dev-desktop"], processList: idle });
    expect(rowFor(plan, visible)).toMatchObject({ action: "remove" });
    fs.mkdirSync(path.join(visible, "workspaces", "repo", "new-ws"), { recursive: true });
    const outcome = applySweep(plan);
    expect(outcome.results.find((result: { path: string }) => result.path === visible)).toMatchObject({ outcome: "has workspaces" });
    expect(exists(path.join(visible, "workspaces", "repo", "new-ws"))).toBe(true);
    expect(exists(data)).toBe(true);
    expect(exists(path.join(home, "Library/Application Support/com.zeros.dev"))).toBe(false);
  });

  it("runs from a checkout with no node_modules", () => {
    const { home } = fixture();
    const checkout = temporary("zeros-sweep-checkout-");
    for (const relative of [
      "scripts/storage-sweep.mjs", "scripts/local-instance-registry.mjs", "scripts/local-instance-prune.mjs",
      "scripts/storage-removal.mjs", "scripts/exclusive-file-lock.mjs",
      "apps/desktop/src/engine/db/local-development-paths.cjs",
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
    expect(exists(path.join(home, "Library/Application Support/com.zeros.dev"))).toBe(true);
  });
});
