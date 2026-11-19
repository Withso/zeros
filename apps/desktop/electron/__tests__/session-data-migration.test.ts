import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_MIGRATION_MARKER,
  codeCachePathFor,
  migrateSessionData,
  sessionMigrationSources,
} from "../session-data-migration";
import { REGENERABLE_SESSION_ENTRIES } from "../../src/engine/db/session-entries";

const roots: string[] = [];
function scratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-session-")));
  roots.push(root);
  return root;
}
afterEach(() => {
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

/** A Chromium profile in the old cache location: durable, regenerable and unknown entries. */
function legacyProfile(dir: string) {
  const write = (relative: string, contents: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), contents);
  };
  write("Local Storage/leveldb/000003.log", "drafts");
  write("IndexedDB/http_localhost_0.indexeddb.leveldb/CURRENT", "idb");
  write("Session Storage/MANIFEST-000001", "session");
  write("Cookies", "cookie-db");
  write("Preferences", "{}");
  write("Mystery Store/data", "unknown is durable");
  write("Cache/Cache_Data/index", "http cache");
  write("GPUCache/data_0", "gpu");
  write("Code Cache/js/index", "code cache");
  write(".zeros-session-migrated", "older hop");
}
const DURABLE = ["Local Storage", "IndexedDB", "Session Storage", "Cookies", "Preferences", "Mystery Store"];
// Regenerable but not relocatable: they move with the profile and stay warm.
const CACHES = ["Cache", "GPUCache"];

function layout() {
  const root = scratch();
  return { root, cache: path.join(root, "Caches", "com.zeros"), destination: path.join(root, "Application Support", "com.zeros", "electron") };
}
const sourcesFor = (cache: string) => [{ dir: cache, keep: ["Code Cache"], regenerables: "move" as const }];

describe("session data migration", () => {
  it("starts a fresh install with an empty profile and a marker", () => {
    const { cache, destination } = layout();
    expect(migrateSessionData({ destination, sources: sourcesFor(cache) }).status).toBe("migrated");
    expect(fs.readdirSync(destination)).toEqual([SESSION_MIGRATION_MARKER]);
  });

  it("moves durable, unknown and non-relocatable cache entries, and leaves the relocated code cache", () => {
    const { cache, destination } = layout();
    legacyProfile(cache);
    const result = migrateSessionData({ destination, sources: sourcesFor(cache) });
    expect(result.status).toBe("migrated");
    expect(result.moved.sort()).toEqual([...DURABLE].sort());
    expect(result.cachesMoved.sort()).toEqual([...CACHES].sort());
    expect(fs.readdirSync(destination).sort()).toEqual([...DURABLE, ...CACHES, SESSION_MIGRATION_MARKER].sort());
    expect(fs.readFileSync(path.join(destination, "Cache/Cache_Data/index"), "utf8")).toBe("http cache");
    expect(fs.readFileSync(path.join(destination, "Local Storage/leveldb/000003.log"), "utf8")).toBe("drafts");
    expect(fs.readFileSync(path.join(destination, "Mystery Store/data"), "utf8")).toBe("unknown is durable");
    expect(fs.readdirSync(cache).sort()).toEqual([".zeros-session-migrated", "Code Cache"]);
    expect(fs.readFileSync(path.join(cache, "Code Cache/js/index"), "utf8")).toBe("code cache");
  });

  it("deletes nothing recursively before ready", () => {
    const { cache, destination } = layout();
    legacyProfile(cache);
    const removals: string[] = [];
    const watched = { ...fs, rmSync: ((target: fs.PathLike, options?: fs.RmOptions) => {
      removals.push(String(target));
      fs.rmSync(target, options);
    }) as typeof fs.rmSync };
    migrateSessionData({ destination, sources: sourcesFor(cache), fs: watched });
    expect(removals).toEqual([]);
  });

  it("leaves a cache it cannot move behind without failing the run", () => {
    const { cache, destination } = layout();
    legacyProfile(cache);
    const stuck = { ...fs, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).endsWith(`${path.sep}Cache`)) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      fs.renameSync(from, to);
    } };
    const result = migrateSessionData({ destination, sources: sourcesFor(cache), fs: stuck });
    expect(result.status).toBe("migrated");
    expect(result.cachesLeft).toEqual(["Cache"]);
    expect(exists(path.join(cache, "Cache/Cache_Data/index"))).toBe(true);
    expect(exists(path.join(destination, SESSION_MIGRATION_MARKER))).toBe(true);
  });

  it("never overwrites an existing destination entry and leaves that source in place", () => {
    const { cache, destination } = layout();
    legacyProfile(cache);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "Cookies"), "newer");
    fs.mkdirSync(path.join(destination, "Local Storage"));
    fs.writeFileSync(path.join(destination, "Local Storage", "kept"), "newer");
    const result = migrateSessionData({ destination, sources: sourcesFor(cache) });
    expect(result.kept.sort()).toEqual(["Cookies", "Local Storage"]);
    expect(fs.readFileSync(path.join(destination, "Cookies"), "utf8")).toBe("newer");
    expect(fs.readdirSync(path.join(destination, "Local Storage"))).toEqual(["kept"]);
    expect(fs.readFileSync(path.join(cache, "Cookies"), "utf8")).toBe("cookie-db");
    expect(exists(path.join(cache, "Local Storage/leveldb/000003.log"))).toBe(true);
    expect(exists(path.join(destination, SESSION_MIGRATION_MARKER))).toBe(true);
  });

  it("finishes an interrupted run without duplicating or losing anything", () => {
    const { cache, destination } = layout();
    legacyProfile(cache);
    // The process dies while moving a durable entry, after others moved.
    const dies = (from: fs.PathLike) => String(from).endsWith(`${path.sep}Session Storage`);
    const crashing = {
      ...fs,
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (dies(from)) throw Object.assign(new Error("killed"), { code: "SIGKILL" });
        fs.renameSync(from, to);
      },
    };
    expect(migrateSessionData({ destination, sources: sourcesFor(cache), fs: crashing }).status).toBe("incomplete");
    expect(exists(path.join(destination, SESSION_MIGRATION_MARKER))).toBe(false);
    // A copy interrupted before it was published leaves only a private temporary.
    fs.mkdirSync(path.join(destination, "IndexedDB.zeros-partial-4194399-0"), { recursive: true });
    expect(migrateSessionData({ destination, sources: sourcesFor(cache) }).status).toBe("migrated");
    expect(fs.readdirSync(destination).sort()).toEqual([...DURABLE, ...CACHES, SESSION_MIGRATION_MARKER].sort());
    for (const name of [...DURABLE, ...CACHES]) expect(exists(path.join(cache, name)), name).toBe(false);
  });

  it("is a no-op once the marker exists", () => {
    const { cache, destination } = layout();
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, SESSION_MIGRATION_MARKER), "done");
    legacyProfile(cache);
    expect(migrateSessionData({ destination, sources: sourcesFor(cache) }).status).toBe("done");
    expect(fs.readdirSync(destination)).toEqual([SESSION_MIGRATION_MARKER]);
    expect(exists(path.join(cache, "Cache"))).toBe(true);
  });

  it("copies and verifies durable entries across volumes, never copies caches, and keeps the source", () => {
    const exdev = () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); };
    const crossVolume = { ...fs, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).includes("Caches")) exdev();
      fs.renameSync(from, to);
    }, linkSync: exdev };
    const good = layout();
    legacyProfile(good.cache);
    expect(migrateSessionData({ destination: good.destination, sources: sourcesFor(good.cache), fs: crossVolume }).status).toBe("migrated");
    expect(fs.readFileSync(path.join(good.destination, "IndexedDB/http_localhost_0.indexeddb.leveldb/CURRENT"), "utf8")).toBe("idb");
    expect(fs.readFileSync(path.join(good.destination, "Cookies"), "utf8")).toBe("cookie-db");
    // Removing the source would be a recursive delete before ready; it stays in
    // the purgeable cache folder.
    for (const name of DURABLE) expect(exists(path.join(good.cache, name)), name).toBe(true);
    for (const name of CACHES) {
      expect(exists(path.join(good.cache, name)), name).toBe(true);
      expect(exists(path.join(good.destination, name)), name).toBe(false);
    }

    const bad = layout();
    legacyProfile(bad.cache);
    const corrupting = { ...crossVolume, cpSync: ((from: string, to: string, options?: fs.CopySyncOptions) => {
      fs.cpSync(from, to, options);
      if (from.endsWith("IndexedDB")) fs.writeFileSync(path.join(to, "http_localhost_0.indexeddb.leveldb/CURRENT"), "torn");
    }) as typeof fs.cpSync };
    const result = migrateSessionData({ destination: bad.destination, sources: sourcesFor(bad.cache), fs: corrupting });
    expect(result.status).toBe("incomplete");
    expect(result.failed).toEqual(["IndexedDB"]);
    expect(fs.readFileSync(path.join(bad.cache, "IndexedDB/http_localhost_0.indexeddb.leveldb/CURRENT"), "utf8")).toBe("idb");
    expect(fs.readdirSync(bad.destination).filter((name) => name.startsWith("IndexedDB"))).toEqual([]);
    expect(exists(path.join(bad.destination, SESSION_MIGRATION_MARKER))).toBe(false);
  });

  it("never throws into startup when the source cannot be read, and logs once", () => {
    const { cache, destination } = layout();
    legacyProfile(cache);
    const lines: string[] = [];
    const unreadable = { ...fs, readdirSync: ((target: fs.PathLike, options?: unknown) => {
      if (String(target) === cache) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return fs.readdirSync(target, options as undefined);
    }) as typeof fs.readdirSync };
    const result = migrateSessionData({ destination, sources: sourcesFor(cache), fs: unreadable, log: (line) => lines.push(line) });
    expect(result.status).toBe("incomplete");
    expect(lines).toHaveLength(1);
    expect(exists(destination)).toBe(true);
    expect(exists(path.join(destination, SESSION_MIGRATION_MARKER))).toBe(false);
    const broken = { ...fs, mkdirSync: () => { throw Object.assign(new Error("read-only"), { code: "EROFS" }); } };
    expect(() => migrateSessionData({ destination: path.join(cache, "x", "electron"), sources: sourcesFor(cache), fs: broken as unknown as typeof fs })).not.toThrow();
  });

  it.each([1, 2, 4])("keeps exactly one copy when a second process runs after the first's move %i", (after) => {
    const { cache, destination } = layout();
    legacyProfile(cache);
    let moves = 0, second: ReturnType<typeof migrateSessionData> | undefined;
    const interleaved = { ...fs };
    for (const name of ["renameSync", "linkSync"] as const) {
      interleaved[name] = ((from: fs.PathLike, to: fs.PathLike) => {
        (fs[name] as (a: fs.PathLike, b: fs.PathLike) => void)(from, to);
        if (++moves === after) second = migrateSessionData({ destination, sources: sourcesFor(cache) });
      }) as never;
    }
    const first = migrateSessionData({ destination, sources: sourcesFor(cache), fs: interleaved });
    expect(second?.status).toBe("migrated");
    expect(["migrated", "done"]).toContain(first.status);
    expect([...first.moved, ...second!.moved].sort()).toEqual([...DURABLE].sort());
    expect([...first.cachesMoved, ...second!.cachesMoved].sort()).toEqual([...CACHES].sort());
    expect(fs.readdirSync(destination).sort()).toEqual([...DURABLE, ...CACHES, SESSION_MIGRATION_MARKER].sort());
    expect(fs.readFileSync(path.join(destination, "Cookies"), "utf8")).toBe("cookie-db");
    for (const name of [...DURABLE, ...CACHES]) expect(exists(path.join(cache, name)), name).toBe(false);
  });

  it("takes later sources only for entries the earlier ones lack", () => {
    const { root, cache, destination } = layout();
    const older = path.join(root, "Caches", "design.zeros.app");
    legacyProfile(cache);
    fs.mkdirSync(path.join(older, "Local Storage"), { recursive: true });
    fs.writeFileSync(path.join(older, "Local Storage", "old"), "older");
    fs.mkdirSync(path.join(older, "WebStorage"));
    fs.writeFileSync(path.join(older, "WebStorage", "w"), "only here");
    fs.mkdirSync(path.join(older, "ShaderCache"));
    migrateSessionData({ destination, sources: [...sourcesFor(cache), { dir: older, keep: [], regenerables: "leave" }] });
    expect(fs.readFileSync(path.join(destination, "Local Storage/leveldb/000003.log"), "utf8")).toBe("drafts");
    expect(fs.readFileSync(path.join(destination, "WebStorage", "w"), "utf8")).toBe("only here");
    expect(exists(path.join(older, "Local Storage", "old"))).toBe(true);
    expect(exists(path.join(older, "ShaderCache"))).toBe(true);
    expect(exists(path.join(destination, "ShaderCache"))).toBe(false);
  });

  it("refuses a source that is a symlink", () => {
    const { root, cache, destination } = layout();
    const elsewhere = path.join(root, "elsewhere");
    legacyProfile(elsewhere);
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.symlinkSync(elsewhere, cache);
    expect(migrateSessionData({ destination, sources: sourcesFor(cache) }).moved).toEqual([]);
    expect(exists(path.join(elsewhere, "Cookies"))).toBe(true);
  });
});

describe("migration sources", () => {
  const base = { cacheRoot: "/c", cacheDir: "/c/com.zeros", sessionDataDir: "/a/com.zeros/electron", dataDirOverridden: false };
  it("folds the older design.zeros.app hop for stable only, and only while that hop never ran", () => {
    expect(sessionMigrationSources({ ...base, family: "installed", channel: "stable", exists: () => false }))
      .toEqual([{ dir: "/c/com.zeros", keep: ["Code Cache"], regenerables: "move" }, { dir: "/c/design.zeros.app", keep: [], regenerables: "leave" }]);
    expect(sessionMigrationSources({ ...base, family: "installed", channel: "stable", exists: (p) => p === "/c/com.zeros/.zeros-session-migrated" }))
      .toEqual([{ dir: "/c/com.zeros", keep: ["Code Cache"], regenerables: "move" }]);
    expect(sessionMigrationSources({ ...base, cacheDir: "/c/com.zeros.alpha", family: "installed", channel: "alpha", exists: () => false }))
      .toEqual([{ dir: "/c/com.zeros.alpha", keep: ["Code Cache"], regenerables: "move" }]);
  });
  it("moves a v2 development identity from its cache dir and leaves legacy and overridden runs alone", () => {
    const dev = { ...base, family: "development" as const, channel: "dev" as const, exists: () => false,
      cacheDir: "/c/com.zeros.local/instances/a", sessionDataDir: "/a/com.zeros.local/instances/a/electron" };
    expect(sessionMigrationSources(dev)).toEqual([{ dir: "/c/com.zeros.local/instances/a", keep: ["Code Cache"], regenerables: "move" }]);
    expect(sessionMigrationSources({ ...dev, sessionDataDir: dev.cacheDir })).toEqual([]);
    expect(sessionMigrationSources({ ...dev, dataDirOverridden: true })).toEqual([]);
  });
});

describe("relocated code cache", () => {
  it("follows each persistent session into the cache dir and skips in-memory ones", () => {
    const dirs = { sessionDataDir: "/a/electron", cacheDir: "/c/com.zeros" };
    expect(codeCachePathFor("/a/electron", dirs)).toBe("/c/com.zeros/Code Cache");
    expect(codeCachePathFor("/a/electron/Partitions/proto", dirs)).toBe("/c/com.zeros/Partitions/proto/Code Cache");
    expect(codeCachePathFor(null, dirs)).toBeNull();
    expect(codeCachePathFor("/elsewhere", dirs)).toBeNull();
    expect(codeCachePathFor("/c/com.zeros", { sessionDataDir: "/c/com.zeros", cacheDir: "/c/com.zeros" })).toBeNull();
  });
  it("keeps every relocated cache name on the regenerable allowlist", () => {
    for (const name of ["Cache", "Code Cache", "GPUCache", "DawnWebGPUCache", "DawnGraphiteCache", "Shared Dictionary", "Dictionaries"])
      expect(REGENERABLE_SESSION_ENTRIES).toContain(name);
    for (const name of ["Local Storage", "IndexedDB", "Cookies", "Session Storage", "Partitions", "Service Worker"])
      expect(REGENERABLE_SESSION_ENTRIES).not.toContain(name);
  });
});
