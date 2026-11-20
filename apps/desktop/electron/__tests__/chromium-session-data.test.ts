import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { chooseRendererProfile } from "../renderer-profile-location";

// Runs main.ts's real relocateChromiumCache() against a scratch cache root.
// Installed channels must keep main's session location, legacy hop and marker;
// the development family only creates its own session folder.
const roots: string[] = [];
function scratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-session-data-")));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function relocate({
  cacheRoot,
  identity,
  local = false,
  localSession = null,
  channel,
  slug = "",
  platform,
  dataDir = "",
  dataDirOverride,
  lock = true,
  tmpdir = os.tmpdir(),
}: {
  cacheRoot: string;
  identity: string;
  local?: boolean;
  localSession?: string | null;
  channel: string;
  slug?: string;
  platform?: string;
  dataDir?: string;
  dataDirOverride?: string;
  lock?: boolean;
  tmpdir?: string;
}) {
  const source = fs.readFileSync(process.env.ZEROS_MAIN_UNDER_TEST ?? "apps/desktop/electron/main.ts", "utf8");
  const start = source.indexOf("function relocateChromiumCache");
  const end = source.indexOf("relocateChromiumCache();", start);
  if (start < 0 || end < 0) throw new Error("relocateChromiumCache() markers moved");
  const set: Record<string, string> = {};
  const switches: string[][] = [];
  const chooser = { calls: 0, lockCalls: 0 };
  const diagnostics: string[] = [];
  vm.runInNewContext(`${transformSync(source.slice(start, end), { loader: "ts" }).code}\nrelocateChromiumCache();`, {
    app: {
      commandLine: { appendSwitch: (...args: string[]) => switches.push(args) },
      getPath: (name: string) => (name === "cache" ? cacheRoot : ""),
      setPath: (name: string, value: string) => { set[name] = value; },
    },
    appIdentity: () => identity,
    zerosLocalSessionDataDir: () => localSession,
    IS_LOCAL_DEVELOPMENT: local,
    INSTANCE_SLUG: slug,
    process: { platform, env: { ZEROS_CHANNEL: channel, ...(dataDirOverride ? { ZEROS_DATA_DIR: dataDirOverride } : {}) } },
    chooseRendererProfile: (inputs: Parameters<typeof chooseRendererProfile>[0]) => {
      chooser.calls++;
      return chooseRendererProfile(inputs);
    },
    holdSingleInstanceLock: () => {
      chooser.lockCalls++;
      return lock;
    },
    zerosRendererProfileDir: () => path.join(dataDir, "electron"),
    rendererProfileDiagnostics: diagnostics,
    fs,
    os: { tmpdir: () => tmpdir },
    path,
    console: { log() {}, error() {}, warn() {} },
  });
  return { sessionData: set.sessionData, switches, chooser, diagnostics };
}

describe("Chromium session data before ready", () => {
  it.each([["stable", "com.zeros"], ["alpha", "com.zeros.alpha"]])(
    "keeps %s's session at Caches/<id> and copies main's durable stores from design.zeros.app once",
    (channel, id) => {
      const cacheRoot = scratch();
      const old = path.join(cacheRoot, "design.zeros.app");
      fs.mkdirSync(path.join(old, "Local Storage", "leveldb"), { recursive: true });
      fs.writeFileSync(path.join(old, "Local Storage", "leveldb", "000003.log"), "draft");
      fs.mkdirSync(path.join(old, "GPUCache"));
      const first = relocate({ cacheRoot, identity: id, channel });
      const target = path.join(cacheRoot, id);
      expect(first.sessionData).toBe(target);
      expect(first.switches).toEqual([["disk-cache-size", String(250 * 1024 * 1024)]]);
      expect(fs.readFileSync(path.join(target, "Local Storage", "leveldb", "000003.log"), "utf8")).toBe("draft");
      expect(fs.existsSync(path.join(target, ".zeros-session-migrated"))).toBe(true);
      expect(fs.readFileSync(path.join(old, "Local Storage", "leveldb", "000003.log"), "utf8")).toBe("draft");
      fs.writeFileSync(path.join(old, "Local Storage", "leveldb", "000003.log"), "newer");
      relocate({ cacheRoot, identity: id, channel });
      expect(fs.readFileSync(path.join(target, "Local Storage", "leveldb", "000003.log"), "utf8")).toBe("draft");
    },
  );

  // Final review: hosted development keeps main's session and its old hop.
  it.each([["", "com.zeros.dev", "design.zeros.app.dev"], ["feature", "com.zeros.dev.feature", "design.zeros.app.dev.feature"]])(
    "keeps hosted Dev's session at Caches/<id> and main's hop from its old folder (instance '%s')",
    (slug, id, oldName) => {
      const cacheRoot = scratch();
      fs.mkdirSync(path.join(cacheRoot, oldName, "Local Storage"), { recursive: true });
      fs.writeFileSync(path.join(cacheRoot, oldName, "Local Storage", "x"), "draft");
      expect(relocate({ cacheRoot, identity: id, channel: "dev", slug }).sessionData).toBe(path.join(cacheRoot, id));
      expect(fs.readFileSync(path.join(cacheRoot, id, "Local Storage", "x"), "utf8")).toBe("draft");
    },
  );

  it("gives a new Local identity <data>/electron, and a legacy one its cache folder, moving nothing", () => {
    const cacheRoot = scratch();
    const localSession = path.join(scratch(), "instances", "a123456789abcdef", "electron");
    fs.mkdirSync(path.join(cacheRoot, "design.zeros.app", "Local Storage"), { recursive: true });
    const id = "com.zeros.local.a123456789abcdef";
    expect(relocate({ cacheRoot, identity: id, channel: "dev", local: true, localSession }).sessionData).toBe(localSession);
    expect(fs.readdirSync(localSession)).toEqual([]);
    expect(relocate({ cacheRoot, identity: id, channel: "dev", local: true }).sessionData).toBe(path.join(cacheRoot, id));
    expect(fs.readdirSync(cacheRoot).sort()).toEqual([id, "design.zeros.app"].sort());
  });

  describe("macOS profile beside the data folder", () => {
    function installed() {
      const home = scratch();
      const cacheRoot = path.join(home, "Library", "Caches");
      const dataDir = path.join(home, "Library", "Application Support", "com.zeros");
      fs.mkdirSync(cacheRoot, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });
      const cache = path.join(cacheRoot, "com.zeros");
      fs.mkdirSync(path.join(cache, "Local Storage", "leveldb"), { recursive: true });
      fs.writeFileSync(path.join(cache, "Local Storage", "leveldb", "000003.log"), "draft");
      fs.writeFileSync(path.join(cache, ".zeros-session-migrated"), "older hop done");
      return { cacheRoot, dataDir, cache, electron: path.join(dataDir, "electron") };
    }

    it("selects <data dir>/electron and runs none of main's Caches code", () => {
      const at = installed();
      const result = relocate({ cacheRoot: at.cacheRoot, identity: "com.zeros", channel: "stable", platform: "darwin", dataDir: at.dataDir });
      expect(result.sessionData).toBe(at.electron);
      expect(result.switches).toEqual([["disk-cache-size", String(250 * 1024 * 1024)]]);
      expect(fs.existsSync(at.cache)).toBe(false);
      expect(fs.readFileSync(path.join(at.electron, ".zeros-session-migrated"), "utf8")).toBe("older hop done");
      expect(fs.readFileSync(path.join(at.electron, "Local Storage", "leveldb", "000003.log"), "utf8")).toBe("draft");
      expect(result.diagnostics.join("\n")).toMatch(/moved from/);
      const again = relocate({ cacheRoot: at.cacheRoot, identity: "com.zeros", channel: "stable", platform: "darwin", dataDir: at.dataDir });
      expect(again.sessionData).toBe(at.electron);
      expect(again.chooser.lockCalls).toBe(1);
      expect(fs.existsSync(at.cache)).toBe(false);
    });

    it("keeps hosted Dev's per-instance identity on its own data folder", () => {
      const home = scratch();
      const cacheRoot = path.join(home, "Library", "Caches");
      const dataDir = path.join(home, "Library", "Application Support", "com.zeros.dev.feature");
      fs.mkdirSync(path.join(cacheRoot, "com.zeros.dev.feature", "GPUCache"), { recursive: true });
      fs.writeFileSync(path.join(cacheRoot, "com.zeros.dev.feature", ".zeros-session-migrated"), "x");
      fs.mkdirSync(dataDir, { recursive: true });
      const result = relocate({ cacheRoot, identity: "com.zeros.dev.feature", channel: "dev", slug: "feature", platform: "darwin", dataDir });
      expect(result.sessionData).toBe(path.join(dataDir, "electron"));
      expect(fs.existsSync(path.join(dataDir, "electron", "GPUCache"))).toBe(true);
    });

    it.each([false, true])("without the lock runs on a new temp folder and touches neither profile (moved before: %s)", (moved) => {
      const at = installed();
      if (moved) relocate({ cacheRoot: at.cacheRoot, identity: "com.zeros", channel: "stable", platform: "darwin", dataDir: at.dataDir });
      const profile = moved ? at.electron : at.cache;
      const before = fs.readdirSync(profile).sort();
      const mtime = fs.statSync(profile).mtimeMs;
      const tmpdir = scratch();
      const result = relocate({ cacheRoot: at.cacheRoot, identity: "com.zeros", channel: "stable", platform: "darwin", dataDir: at.dataDir, lock: false, tmpdir });
      expect(path.dirname(result.sessionData)).toBe(tmpdir);
      expect(path.basename(result.sessionData)).toMatch(/^zeros-second-instance-/);
      expect(fs.readdirSync(result.sessionData)).toEqual([]);
      expect(fs.readdirSync(profile).sort()).toEqual(before);
      expect(fs.statSync(profile).mtimeMs).toBe(mtime);
      expect(fs.existsSync(moved ? at.cache : at.electron)).toBe(false);
    });

    it("lets main's older hop fill Caches first, then moves on the next launch", () => {
      const home = scratch();
      const cacheRoot = path.join(home, "Library", "Caches");
      const dataDir = path.join(home, "Library", "Application Support", "com.zeros");
      fs.mkdirSync(path.join(cacheRoot, "design.zeros.app", "Local Storage"), { recursive: true });
      fs.writeFileSync(path.join(cacheRoot, "design.zeros.app", "Local Storage", "x"), "oldest draft");
      fs.mkdirSync(dataDir, { recursive: true });
      const first = relocate({ cacheRoot, identity: "com.zeros", channel: "stable", platform: "darwin", dataDir });
      expect(first.sessionData).toBe(path.join(cacheRoot, "com.zeros"));
      expect(fs.readFileSync(path.join(cacheRoot, "com.zeros", "Local Storage", "x"), "utf8")).toBe("oldest draft");
      const second = relocate({ cacheRoot, identity: "com.zeros", channel: "stable", platform: "darwin", dataDir });
      expect(second.sessionData).toBe(path.join(dataDir, "electron"));
      expect(fs.readFileSync(path.join(dataDir, "electron", "Local Storage", "x"), "utf8")).toBe("oldest draft");
    });

    it.each([
      ["linux", undefined],
      ["win32", undefined],
      ["darwin", "override"],
    ])("on %s with override %s runs main's code unchanged", (platform, override) => {
      const at = installed();
      const dataDirOverride = override ? scratch() : undefined;
      const before = fs.statSync(path.join(at.cache, ".zeros-session-migrated")).mtimeMs;
      const result = relocate({ cacheRoot: at.cacheRoot, identity: "com.zeros", channel: "stable", platform, dataDir: at.dataDir, dataDirOverride });
      expect(result.sessionData).toBe(at.cache);
      expect(result.chooser).toEqual({ calls: 0, lockCalls: 0 });
      expect(fs.existsSync(at.electron)).toBe(false);
      expect(fs.statSync(path.join(at.cache, ".zeros-session-migrated")).mtimeMs).toBeGreaterThanOrEqual(before);
      expect(fs.readFileSync(path.join(at.cache, ".zeros-session-migrated"), "utf8")).not.toBe("older hop done");
    });
  });
});
