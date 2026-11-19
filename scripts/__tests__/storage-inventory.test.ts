import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CATEGORIES, formatInventory, helpText, inventory, main, parseArguments } from "../storage-inventory.mjs";
import { registryPath, upsertInstance } from "../local-instance-registry.mjs";

const roots: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];
function temporary(prefix = "zeros-inventory-") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function file(target: string, contents = "x") {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}
const L = (home: string, ...parts: string[]) => path.join(home, "Library", ...parts);
const idle = () => "";
type Group = { category: string; identity: string; status: string | null; holds: string[]; unknown: string[]; inUse: string[];
  items: Array<{ path: string; bytes: number; readable: boolean }> };
const find = (groups: Group[], category: string, identity: string) => groups.find((g) => g.category === category && g.identity === identity);

/** Every path, its type, bytes and mtime, so a run can be proved read-only. */
function snapshot(root: string) {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const target = path.join(dir, name);
      const stat = fs.lstatSync(target);
      out[path.relative(root, target)] = stat.isSymbolicLink() ? `link:${fs.readlinkSync(target)}`
        : stat.isDirectory() ? `dir:${stat.mtimeMs}` : `file:${stat.mtimeMs}:${fs.readFileSync(target).toString("base64")}`;
      if (stat.isDirectory()) walk(target);
    }
  };
  walk(root);
  return out;
}

function fixture() {
  const home = temporary();
  file(L(home, "Application Support", "com.zeros.dev.coral-reef", "zeros.db"));
  file(L(home, "Application Support", "Zeros — Coral Reef", "app-settings.json"), "{}");
  file(L(home, "Application Support", "com.zeros.dev", "secrets.json"), "{}");
  file(path.join(home, "zeros-dev-coral-reef", "workspaces", "repo", "ws", "README.md"));
  file(path.join(home, ".zeros-dev", "worktrees", "repo", "ws_1", "notes.md"), "only copy");
  file(L(home, "Caches", "design.zeros.beta", "Local Storage", "leveldb", "000003.log"), "draft");
  file(path.join(home, ".zeros-beta", "worktrees", "repo", "ws_7", "draft.md"));
  file(L(home, "Caches", "design.zeros.app", "Local Storage", "leveldb", "000003.log"), "draft");
  const registry = registryPath({ home, platform: "darwin", env: {} });
  upsertInstance(registry, "a123456789abcdef", { kind: "checkout", name: "A", checkout: path.join(home, "gone"), layout: "v2" });
  upsertInstance(registry, "alpha", { kind: "alpha", name: "Zeros Local Alpha", checkout: null, layout: "v2" });
  file(L(home, "Application Support", "com.zeros.local", "instances", "a123456789abcdef", "zeros.db"));
  file(L(home, "Application Support", "com.zeros.local.b123456789abcdef", "provider-accounts", "claude", "u", "config.json"), "{}");
  file(path.join(home, "zeros-local-b123456789abcdef", "design workspaces", "site", "home", "index.html"), "<p>");
  file(path.join(home, ".zeros-local", "instances", "c123456789abcdef", "worktrees", "repo", "ws", "f.txt"));
  file(L(home, "Caches", "com.zeros.local", "bundles", "design-qual-0011aabb", "Zeros.app", "x"));
  file(path.join(home, "zeros-local", "d123456789abcdef", "workspaces", "repo", "ws", "pre-merge.txt"));
  file(L(home, "Application Support", "com.zeros.local", "instances", "alpha", "secrets.json"), "{}");
  return { home, registry };
}

describe("pnpm storage:inventory", () => {
  it("changes nothing on disk and calls no writing or removing fs function", () => {
    const { home } = fixture();
    const before = snapshot(home);
    const writers = ["rmSync", "rmdirSync", "unlinkSync", "renameSync", "writeFileSync", "mkdirSync", "copyFileSync", "cpSync",
      "symlinkSync", "linkSync", "truncateSync", "appendFileSync", "chmodSync", "utimesSync"] as const;
    const spies = writers.map((name) => vi.spyOn(fs, name));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(["--keychain"], { platform: "darwin", home, processList: idle, security: () => false })).toBe(0);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(snapshot(home)).toEqual(before);
    const output = log.mock.calls.join("\n");
    expect(output).toContain("Read-only: nothing was changed.");
    expect(output).not.toMatch(/\brm\b|--apply|sudo|security delete/);
  });

  it("reports each category with what it holds and its status", () => {
    const { home } = fixture();
    const report = inventory({ home, platform: "darwin", processList: idle });
    const groups = report.groups as Group[];
    expect(new Set(groups.map((g) => g.category))).toEqual(new Set(CATEGORIES));
    expect(find(groups, "dev-desktop", "coral-reef")?.holds).toEqual(expect.arrayContaining(["a database", "workspaces"]));
    expect(find(groups, "dev-desktop", "dev")?.holds).toEqual(expect.arrayContaining(["a secrets file", "worktrees"]));
    expect(find(groups, "beta", "beta")?.holds).toEqual(expect.arrayContaining(["a renderer profile", "worktrees"]));
    expect(find(groups, "legacy-scheme", "design.zeros.app")?.holds).toContain("a renderer profile");
    expect(find(groups, "development", "a123456789abcdef")).toMatchObject({ status: expect.stringMatching(/checkout gone/) });
    expect(find(groups, "development", "a123456789abcdef")?.holds).toContain("a database");
    expect(find(groups, "development", "b123456789abcdef")).toMatchObject({ status: "checkout, not registered" });
    expect(find(groups, "development", "b123456789abcdef")?.holds).toEqual(expect.arrayContaining(["provider profiles", "workspaces"]));
    expect(find(groups, "development", "c123456789abcdef")?.holds).toContain("worktrees");
    expect(find(groups, "development", "design-qual-0011aabb")).toMatchObject({ status: "test or hosted identity, not registered", holds: [] });
    expect(find(groups, "development", "d123456789abcdef")?.holds).toContain("workspaces");
    expect(find(groups, "development", "alpha")).toMatchObject({ status: "registered (hosted alpha)" });
    expect(find(groups, "development", "alpha")?.holds).toContain("a secrets file");
    expect(report.registry).toBe("read");
    expect(formatInventory(report)).toMatch(/coral-reef — holds a database/);
  });

  it("reports a provider-store reference and an inconsistent registry entry without trusting it", () => {
    const { home, registry } = fixture();
    const data = L(home, "Application Support", "com.zeros.local.b123456789abcdef");
    const marker = `local-provider-migration:${createHash("sha256").update(path.join(data, "secrets.json")).digest("hex")}`;
    file(L(home, "Application Support", "com.zeros.local", "secrets.json"), JSON.stringify({ [marker]: "enc" }));
    const doc = JSON.parse(fs.readFileSync(registry, "utf8"));
    doc.instances.default = { kind: "ephemeral", ownerPid: 1 };
    fs.writeFileSync(registry, JSON.stringify(doc));
    file(L(home, "Application Support", "com.zeros.local", "instances", "default", "zeros.db"));
    const groups = inventory({ home, platform: "darwin", processList: idle }).groups as Group[];
    expect(find(groups, "development", "b123456789abcdef")?.holds).toContain("a reference from the shared Local provider store");
    expect(find(groups, "development", "default")).toMatchObject({ status: "registry entry inconsistent" });
  });

  it("reports what looks in use: launcher locks, the app's SingletonLock and running processes", () => {
    const { home } = fixture();
    const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)", "scripts/dev-environment/launcher.mjs"], { stdio: "ignore" });
    children.push(live);
    file(path.join(home, ".zeros-local", "instances", "alpha", "launcher.lock"), JSON.stringify({ pid: live.pid, token: "t" }));
    fs.symlinkSync(`${os.hostname()}-${live.pid}`, L(home, "Application Support", "com.zeros.dev.coral-reef", "SingletonLock"));
    const beta = L(home, "Caches", "design.zeros.beta");
    const groups = inventory({ home, platform: "darwin", processList: () => `/x/Electron --user-data-dir=${beta}` }).groups as Group[];
    expect(find(groups, "development", "alpha")?.inUse).toContain("a launcher holds it");
    expect(find(groups, "dev-desktop", "coral-reef")?.inUse).toContain("its app is running");
    expect(find(groups, "beta", "beta")?.inUse).toContain("a running process names it");
    expect(find(groups, "legacy-scheme", "design.zeros.app")?.inUse).toEqual([]);
    const unknown = inventory({ home, platform: "darwin", processList: () => null }).groups as Group[];
    expect(unknown.every((g) => g.inUse.includes("the process list is unavailable"))).toBe(true);
  });

  it("never reads below a linked folder, the registry included, and refuses a linked home", () => {
    const { home } = fixture();
    const outside = temporary("zeros-inventory-outside-");
    file(path.join(outside, "com.zeros.dev.elsewhere", "zeros.db"));
    fs.renameSync(L(home, "Caches"), path.join(outside, "real-caches"));
    fs.symlinkSync(outside, L(home, "Caches"));
    const support = L(home, "Application Support", "com.zeros.local");
    fs.renameSync(support, path.join(outside, "com.zeros.local"));
    fs.symlinkSync(path.join(outside, "com.zeros.local"), support);
    const opened = vi.spyOn(fs, "openSync");
    const listed = vi.spyOn(fs, "readdirSync");
    const report = inventory({ home, platform: "darwin", processList: idle });
    const below = (calls: unknown[][], root: string) => calls.some(([target]) => String(target).startsWith(`${root}${path.sep}`));
    expect(below(opened.mock.calls, support)).toBe(false);
    expect(below(listed.mock.calls, L(home, "Caches"))).toBe(false);
    expect(below(listed.mock.calls, support)).toBe(false);
    expect(report.registry).toBe("not read (reached through a link)");
    expect((report.groups as Group[]).some((g) => g.identity === "elsewhere")).toBe(false);
    expect(report.unlisted).toContain(L(home, "Caches"));

    const realHome = temporary(), linkedHome = path.join(temporary(), "home");
    fs.symlinkSync(realHome, linkedHome);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main([], { platform: "darwin", home: linkedHome, processList: idle })).toBe(2);
    expect(log.mock.calls.join("\n")).toContain("Nothing read: the home folder is missing, not a folder, or reached through a symlink.");
  });

  it("does not block on a FIFO at the registry path", () => {
    const home = temporary();
    const registry = registryPath({ home, platform: "darwin", env: {} });
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    expect(spawnSync("mkfifo", [registry]).status).toBe(0);
    const script = `import { inventory } from ${JSON.stringify(path.resolve("scripts/storage-inventory.mjs"))};
      const report = inventory({ home: ${JSON.stringify(home)}, platform: "darwin", processList: () => "" });
      console.log(report.registry);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 3_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("unreadable");
  });

  it("only reports: no --apply, no deletion options, and help names every category", () => {
    for (const argv of [["--apply"], ["--identity", "x"], ["--delete"]]) expect(() => parseArguments(argv)).toThrow(/only reports/);
    for (const category of CATEGORIES) expect(helpText()).toContain(category);
    expect(parseArguments(["--only", "beta,development", "--json"])).toMatchObject({ only: ["beta", "development"], json: true });
  });

  it("looks up the two Safe Storage items without reading or changing them", () => {
    const home = temporary();
    const calls: string[][] = [];
    const report = inventory({ home, platform: "darwin", processList: idle, keychain: true,
      security: (args: string[]) => { calls.push(args); return args[2] === "Zeros Beta Safe Storage"; } });
    expect(report.keychain).toEqual([
      { category: "dev-desktop", service: "Zeros Dev Safe Storage", present: false },
      { category: "beta", service: "Zeros Beta Safe Storage", present: true },
    ]);
    expect(calls).toEqual([["find-generic-password", "-s", "Zeros Dev Safe Storage"], ["find-generic-password", "-s", "Zeros Beta Safe Storage"]]);
  });

  it("reports allocated size, counting a hardlinked inode once and saying the total is an upper bound", () => {
    const home = temporary();
    const first = L(home, "Caches", "com.zeros.dev.a"), second = L(home, "Caches", "com.zeros.dev.b");
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "blob"), Buffer.alloc(64 * 1024, 1));
    fs.linkSync(path.join(first, "blob"), path.join(second, "blob"));
    const report = inventory({ home, platform: "darwin", processList: idle, only: ["dev-desktop"] });
    const total = (report.groups as Group[]).flatMap((g) => g.items).reduce((sum, item) => sum + item.bytes, 0);
    const allocated = (target: string) => fs.lstatSync(target).blocks * 512;
    expect(total).toBe(allocated(path.join(first, "blob")) + allocated(first) + allocated(second));
    expect(formatInventory(report)).toContain("upper bound");
  });

  it("runs from a checkout with no node_modules", () => {
    const { home } = fixture();
    const checkout = temporary("zeros-inventory-checkout-");
    for (const relative of ["scripts/storage-inventory.mjs", "scripts/local-instance-registry.mjs", "scripts/exclusive-file-lock.mjs",
      "apps/desktop/src/engine/db/local-development-paths.cjs"]) {
      fs.mkdirSync(path.dirname(path.join(checkout, relative)), { recursive: true });
      fs.copyFileSync(relative, path.join(checkout, relative));
    }
    const result = spawnSync(process.execPath, [path.join(checkout, "scripts/storage-inventory.mjs")], {
      cwd: checkout, env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8", timeout: 30_000,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Read-only: nothing was changed.");
  });
});
