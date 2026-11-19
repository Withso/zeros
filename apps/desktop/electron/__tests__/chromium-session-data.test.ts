import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

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
}: {
  cacheRoot: string;
  identity: string;
  local?: boolean;
  localSession?: string | null;
  channel: string;
  slug?: string;
}) {
  const source = fs.readFileSync("apps/desktop/electron/main.ts", "utf8");
  const start = source.indexOf("function relocateChromiumCache");
  const end = source.indexOf("relocateChromiumCache();", start);
  if (start < 0 || end < 0) throw new Error("relocateChromiumCache() markers moved");
  const set: Record<string, string> = {};
  const switches: string[][] = [];
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
    process: { env: { ZEROS_CHANNEL: channel } },
    fs,
    path,
    console: { log() {}, error() {}, warn() {} },
  });
  return { sessionData: set.sessionData, switches };
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
});
