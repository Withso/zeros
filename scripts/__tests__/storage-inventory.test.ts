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

/** Every path, its type, bytes and mtime, so a run can be proved read-only.
 * Each entry is read through the one descriptor it was opened as. */
function snapshot(root: string) {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const target = path.join(dir, name);
      const key = path.relative(root, target);
      let fd: number;
      try {
        fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
        out[key] = `link:${fs.readlinkSync(target)}`;
        continue;
      }
      let directory = false;
      try {
        const stat = fs.fstatSync(fd);
        directory = stat.isDirectory();
        out[key] = directory ? `dir:${stat.mtimeMs}`
          : stat.isFile() ? `file:${stat.mtimeMs}:${fs.readFileSync(fd).toString("base64")}`
          : `other:${stat.mode}:${stat.mtimeMs}`;
      } finally {
        fs.closeSync(fd);
      }
      if (directory) walk(target);
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
  // A pre-release build of this branch registered a hosted `alpha` here.
  const doc = JSON.parse(fs.readFileSync(registry, "utf8"));
  doc.instances.alpha = { kind: "alpha", name: "Zeros Local Alpha", checkout: null, layout: "v2" };
  fs.writeFileSync(registry, JSON.stringify(doc));
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
    expect(main(["--keychain"], { platform: "darwin", home, processList: idle, security: () => 44 })).toBe(0);
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
    expect(find(groups, "dev-worktrees", "coral-reef")?.holds).toEqual(expect.arrayContaining(["a database", "workspaces"]));
    expect(find(groups, "hosted-dev", "dev")).toMatchObject({ status: expect.stringMatching(/live hosted Dev profile/) });
    expect(find(groups, "hosted-dev", "dev")?.holds).toEqual(expect.arrayContaining(["a secrets file", "worktrees"]));
    expect(find(groups, "beta", "beta")?.holds).toEqual(expect.arrayContaining(["a renderer profile", "worktrees"]));
    expect(find(groups, "legacy-scheme", "design.zeros.app")?.holds).toContain("a renderer profile");
    expect(find(groups, "local", "a123456789abcdef")).toMatchObject({ status: expect.stringMatching(/checkout gone/) });
    expect(find(groups, "local", "a123456789abcdef")?.holds).toContain("a database");
    expect(find(groups, "local", "b123456789abcdef")).toMatchObject({ status: "checkout, not registered" });
    expect(find(groups, "local", "b123456789abcdef")?.holds).toEqual(expect.arrayContaining(["provider profiles", "workspaces"]));
    expect(find(groups, "local", "c123456789abcdef")?.holds).toContain("worktrees");
    expect(find(groups, "local", "design-qual-0011aabb")).toMatchObject({ status: "not a Local checkout id (left by a pre-release build)", holds: [] });
    expect(find(groups, "local", "d123456789abcdef")?.holds).toContain("workspaces");
    expect(find(groups, "local", "alpha")).toMatchObject({ status: "not a Local checkout id (left by a pre-release build)" });
    expect(find(groups, "local", "alpha")?.holds).toContain("a secrets file");
    expect(report.registry).toBe("read");
    expect(formatInventory(report)).toMatch(/coral-reef — per-worktree hosted Dev profile[^\n]*; holds a database/);
  });

  it("reports a provider-store reference and an inconsistent registry entry without trusting it", () => {
    const { home, registry } = fixture();
    const data = L(home, "Application Support", "com.zeros.local.b123456789abcdef");
    const marker = `local-provider-migration:${createHash("sha256").update(path.join(data, "secrets.json")).digest("hex")}`;
    file(L(home, "Application Support", "com.zeros.local", "secrets.json"), JSON.stringify({ [marker]: "enc" }));
    const doc = JSON.parse(fs.readFileSync(registry, "utf8"));
    doc.instances.default = { kind: "checkout", checkout: "/x" };
    fs.writeFileSync(registry, JSON.stringify(doc));
    file(L(home, "Application Support", "com.zeros.local", "instances", "default", "zeros.db"));
    const groups = inventory({ home, platform: "darwin", processList: idle }).groups as Group[];
    expect(find(groups, "local", "b123456789abcdef")?.holds).toContain("a reference from the shared Local provider store");
    expect(find(groups, "local", "default")).toMatchObject({ status: "registry entry inconsistent" });
  });

  it("reports what looks in use: launcher locks, the app's SingletonLock and running processes", () => {
    const { home } = fixture();
    const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)", "scripts/dev-environment/launcher.mjs"], { stdio: "ignore" });
    children.push(live);
    file(path.join(home, ".zeros-local", "instances", "alpha", "launcher.lock"), JSON.stringify({ pid: live.pid, token: "t" }));
    fs.symlinkSync(`${os.hostname()}-${live.pid}`, L(home, "Application Support", "com.zeros.dev.coral-reef", "SingletonLock"));
    const beta = L(home, "Caches", "design.zeros.beta");
    const groups = inventory({ home, platform: "darwin", processList: () => `/x/Electron --user-data-dir=${beta}` }).groups as Group[];
    expect(find(groups, "local", "alpha")?.inUse).toContain("a launcher holds it");
    expect(find(groups, "dev-worktrees", "coral-reef")?.inUse).toContain("its app is running");
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

  // Final review: the report must never present data as disposable.
  it("never says an identity holds nothing, reports Design storage, and says what is not inspected", () => {
    const home = temporary();
    file(L(home, "Application Support", "com.zeros.dev.old-ws", "design-storage", "journal", "rename.json"), "{}");
    file(L(home, "Application Support", "com.zeros.dev.other-ws", "git-promotion-journal", "x.json"), "{}");
    fs.mkdirSync(L(home, "Application Support", "com.zeros.dev.empty-ws"), { recursive: true });
    const report = inventory({ home, platform: "darwin", processList: idle });
    const groups = report.groups as Group[];
    expect(find(groups, "dev-worktrees", "old-ws")?.holds).toContain("Design storage (recovery journals, drafts, thumbnails)");
    expect(find(groups, "dev-worktrees", "other-ws")?.holds).toContain("a Git promotion journal");
    const text = formatInventory(report);
    expect(text).not.toMatch(/holds nothing/);
    expect(text).toMatch(/empty-ws — .*none of the kinds this report recognises/);
    expect(text).toContain("not evidence that anything is safe to delete");
    expect(helpText()).toContain("not evidence that anything is safe to delete");
  });

  it("marks a size it could not finish, and its identity, as unknown", () => {
    const home = temporary();
    const blocked = L(home, "Application Support", "com.zeros.dev.locked", "IndexedDB");
    file(path.join(blocked, "x.ldb"));
    const real = fs.readdirSync.bind(fs);
    vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === blocked) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return (real as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readdirSync);
    const owner = find(inventory({ home, platform: "darwin", processList: idle }).groups as Group[], "dev-worktrees", "locked");
    expect(owner?.items[0]).toMatchObject({ complete: false });
    expect(owner?.unknown.join(" ")).toMatch(/size/);
  });

  it.each([[0, true], [44, false], [1, "unknown"], [null, "unknown"]] as const)(
    "reports a Keychain lookup that exits %s as %s", (status, present) => {
      const home = temporary();
      const report = inventory({ home, platform: "darwin", processList: idle, keychain: true, only: ["beta"], security: () => status });
      expect(report.keychain).toEqual([{ category: "beta", service: "Zeros Beta Safe Storage", present }]);
    },
  );

  it("treats the hosted Dev profile as live and per-worktree Dev profiles as residue", () => {
    const home = temporary();
    file(L(home, "Application Support", "com.zeros.dev", "zeros.db"));
    file(path.join(home, ".zeros-dev", "settings.toml"));
    file(path.join(home, "zeros-dev", "workspaces", "repo", "ws", "a.txt"));
    file(L(home, "Application Support", "com.zeros.dev.feature-1a2b", "zeros.db"));
    const groups = inventory({ home, platform: "darwin", processList: idle }).groups as Group[];
    expect(find(groups, "hosted-dev", "dev")).toMatchObject({ status: expect.stringMatching(/live hosted Dev profile/) });
    expect(find(groups, "hosted-dev", "dev")?.items.map((item) => path.relative(home, item.path)).sort()).toEqual(
      [".zeros-dev", "Library/Application Support/com.zeros.dev", "zeros-dev"].sort());
    expect(find(groups, "dev-worktrees", "feature-1a2b")).toMatchObject({ status: expect.stringMatching(/per-worktree/) });
  });

  it("only reports: no --apply, no deletion options, and help names every category", () => {
    for (const argv of [["--apply"], ["--identity", "x"], ["--delete"]]) expect(() => parseArguments(argv)).toThrow(/only reports/);
    for (const category of CATEGORIES) expect(helpText()).toContain(category);
    expect(parseArguments(["--only", "beta,local", "--json"])).toMatchObject({ only: ["beta", "local"], json: true });
  });

  it("looks up the two Safe Storage items without reading or changing them", () => {
    const home = temporary();
    const calls: string[][] = [];
    const report = inventory({ home, platform: "darwin", processList: idle, keychain: true,
      security: (args: string[]) => { calls.push(args); return args[2] === "Zeros Beta Safe Storage" ? 0 : 44; } });
    expect(report.keychain).toEqual([
      { category: "hosted-dev", service: "Zeros Dev Safe Storage", present: false },
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
    const report = inventory({ home, platform: "darwin", processList: idle, only: ["dev-worktrees"] });
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
