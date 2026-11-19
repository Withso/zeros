import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_MOVED_MARKER, chooseSessionDataDir } from "../session-location";

interface Database {
  exec(sql: string): void;
  prepare(sql: string): { get(): unknown };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (file: string) => Database };

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
/** Every file under `dir` with its bytes, to prove nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[]) {
    const file = path.join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) out[path.relative(dir, file)] = `-> ${fs.readlinkSync(file)}`;
    else if (stat.isFile()) out[path.relative(dir, file)] = fs.readFileSync(file).toString("base64");
  }
  return out;
}

function layout() {
  const root = scratch();
  const dataDir = path.join(root, "Application Support", "com.zeros");
  const old = path.join(root, "Caches", "com.zeros");
  fs.mkdirSync(dataDir, { recursive: true });
  return { root, dataDir, old, target: path.join(dataDir, "electron") };
}
function profile(dir: string) {
  const write = (relative: string, contents: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), contents);
  };
  write("Local Storage/leveldb/000003.log", "drafts");
  write("IndexedDB/http_localhost_0.indexeddb.leveldb/CURRENT", "idb");
  write("Cookies", "cookie-db");
  write("Cache/Cache_Data/index", "http cache");
  write("GPUCache/data_0", "gpu");
  write("Code Cache/js/index", "code cache");
  write("Partitions/team/Code Cache/js/index", "partition code");
  write("Notes.zeros-partial-4194399-backup/kept", "an unknown store");
}
const run = (l: ReturnType<typeof layout>, extra: Record<string, unknown> = {}) => {
  const lines: string[] = [];
  const choice = chooseSessionDataDir({ target: l.target, old: l.old, userDataDir: l.dataDir, log: (line) => lines.push(line), ...extra });
  return { ...choice, lines };
};
const lockTo = (dataDir: string, pid: number, host = os.hostname()) =>
  fs.symlinkSync(`${host}-${pid}`, path.join(dataDir, "SingletonLock"));
const DEAD = 2 ** 22 + 777;

describe("choosing the session data dir", () => {
  it("creates a marked electron/ on a fresh install", () => {
    const l = layout();
    expect(run(l)).toMatchObject({ dir: l.target, outcome: "fresh" });
    expect(fs.readdirSync(l.target)).toEqual([SESSION_MOVED_MARKER]);
  });

  it("moves a closed, safe old profile in one rename with every entry and byte", () => {
    const l = layout();
    profile(l.old);
    const before = snapshot(l.old);
    const inode = fs.lstatSync(l.old).ino;
    expect(run(l)).toMatchObject({ dir: l.target, outcome: "moved" });
    expect(exists(l.old)).toBe(false);
    expect(fs.lstatSync(l.target).ino).toBe(inode);
    const after = snapshot(l.target);
    delete after[SESSION_MOVED_MARKER];
    expect(after).toEqual(before);
  });

  it("does one lstat and nothing else once the marker exists", () => {
    const l = layout();
    fs.mkdirSync(l.target);
    fs.writeFileSync(path.join(l.target, SESSION_MOVED_MARKER), "done");
    profile(l.old);
    const calls: string[] = [];
    const counting = new Proxy(fs, { get: (target, key) => {
      const value = Reflect.get(target, key);
      return typeof value === "function" ? (...args: unknown[]) => { calls.push(String(key)); return value.apply(target, args); } : value;
    } });
    expect(run(l, { fs: counting })).toMatchObject({ dir: l.target, outcome: "marked" });
    expect(calls).toEqual(["lstatSync"]);
    expect(exists(path.join(l.old, "Cookies"))).toBe(true);
  });

  it.each([
    ["a live foreign owner", (l: ReturnType<typeof layout>) => lockTo(l.dataDir, process.ppid)],
    ["an owner on another host", (l: ReturnType<typeof layout>) => lockTo(l.dataDir, DEAD, "another-host.local")],
    ["an unparsable lock", (l: ReturnType<typeof layout>) => fs.symlinkSync("garbage", path.join(l.dataDir, "SingletonLock"))],
    ["a lock that is not a link", (l: ReturnType<typeof layout>) => fs.writeFileSync(path.join(l.dataDir, "SingletonLock"), "x")],
    ["a non-empty electron/ without a marker", (l: ReturnType<typeof layout>) => { fs.mkdirSync(l.target); fs.writeFileSync(path.join(l.target, "Local State"), "{}"); }],
    ["electron/ as a file", (l: ReturnType<typeof layout>) => fs.writeFileSync(l.target, "x")],
    ["a symlinked electron/", (l: ReturnType<typeof layout>) => fs.symlinkSync(scratch(), l.target)],
    ["a dangling marker link", (l: ReturnType<typeof layout>) => { fs.mkdirSync(l.target); fs.symlinkSync("nowhere", path.join(l.target, SESSION_MOVED_MARKER)); fs.writeFileSync(path.join(l.target, "x"), "x"); }],
    // Phase 3 review: a relative link such as `Local Storage -> ../offloaded`
    // would point somewhere else once the profile sits under another parent.
    ["an offloaded store linked from the profile", (l: ReturnType<typeof layout>) => {
      fs.mkdirSync(path.join(path.dirname(l.old), "offloaded", "leveldb"), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(l.old), "offloaded", "leveldb", "000003.log"), "offloaded drafts");
      fs.rmSync(path.join(l.old, "Local Storage"), { recursive: true });
      fs.symlinkSync("../offloaded", path.join(l.old, "Local Storage"));
    }],
  ])("uses the old location and touches nothing for %s", (_label, arrange) => {
    const l = layout();
    profile(l.old);
    arrange(l);
    const before = snapshot(l.old);
    const choice = run(l);
    expect(choice).toMatchObject({ dir: l.old, outcome: "kept-old" });
    expect(snapshot(l.old)).toEqual(before);
    expect(choice.lines).toHaveLength(1);
  });

  it("moves when the recorded owner is dead", () => {
    const l = layout();
    profile(l.old);
    lockTo(l.dataDir, DEAD);
    expect(run(l)).toMatchObject({ dir: l.target, outcome: "moved" });
  });

  it("uses the old location, untouched, across devices", () => {
    const l = layout();
    profile(l.old);
    const before = snapshot(l.old);
    const realLstat = fs.lstatSync;
    const twoDevices = { ...fs, lstatSync: ((file: fs.PathLike, options?: fs.StatOptions) => {
      const stat = realLstat(file, options as undefined);
      return String(file) === l.old ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1 }) : stat;
    }) as typeof fs.lstatSync };
    expect(run(l, { fs: twoDevices })).toMatchObject({ dir: l.old, outcome: "kept-old" });
    expect(snapshot(l.old)).toEqual(before);
    expect(exists(l.target)).toBe(false);
  });

  it("uses the old location, untouched, when rename itself fails across devices", () => {
    const l = layout();
    profile(l.old);
    const exdev = { ...fs, renameSync: () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); } };
    expect(run(l, { fs: exdev })).toMatchObject({ dir: l.old, outcome: "kept-old" });
    expect(exists(path.join(l.old, "Cookies"))).toBe(true);
    expect(exists(path.join(l.target, SESSION_MOVED_MARKER))).toBe(false);
  });

  it.each(["old root", "ancestor"])("uses the old location, untouched, through a symlinked %s", (which) => {
    const l = layout();
    const real = path.join(l.root, "real-profile");
    profile(real);
    if (which === "old root") {
      fs.mkdirSync(path.dirname(l.old), { recursive: true });
      fs.symlinkSync(real, l.old);
    } else {
      fs.mkdirSync(path.join(real, "..", "real-caches"), { recursive: true });
      fs.renameSync(real, path.join(l.root, "real-caches", "com.zeros"));
      fs.symlinkSync(path.join(l.root, "real-caches"), path.dirname(l.old));
    }
    const before = snapshot(fs.realpathSync(l.old));
    expect(run(l)).toMatchObject({ dir: l.old, outcome: "kept-old" });
    expect(snapshot(fs.realpathSync(l.old))).toEqual(before);
    expect(exists(l.target)).toBe(false);
  });

  it("leaves overlapping roots alone (Windows keeps its location)", () => {
    const l = layout();
    profile(l.dataDir);
    fs.writeFileSync(path.join(l.dataDir, "zeros.db"), "db");
    const before = snapshot(l.dataDir);
    const choice = chooseSessionDataDir({ target: path.join(l.dataDir, "electron"), old: l.dataDir, userDataDir: l.dataDir, log: () => {} });
    expect(choice.outcome).toBe("kept-old");
    expect(snapshot(l.dataDir)).toEqual(before);
    expect(chooseSessionDataDir({ target: l.dataDir, old: null, userDataDir: l.dataDir, log: () => {} })).toMatchObject({ dir: l.dataDir, outcome: "unchanged" });
  });

  it("imports nothing when there is no old profile to move (overrides)", () => {
    const l = layout();
    profile(l.old);
    expect(chooseSessionDataDir({ target: path.join(l.root, "fixture", "electron"), old: null, userDataDir: path.join(l.root, "fixture"), log: () => {} }))
      .toMatchObject({ dir: path.join(l.root, "fixture", "electron"), outcome: "unchanged" });
    expect(exists(path.join(l.old, "Cookies"))).toBe(true);
  });

  it("selects the old profile explicitly when electron/ cannot be created", () => {
    const l = layout();
    const broken = { ...fs, mkdirSync: () => { throw Object.assign(new Error("read-only"), { code: "EROFS" }); } };
    expect(run(l, { fs: broken })).toMatchObject({ dir: l.old, outcome: "kept-old" });
  });

  it("finishes the move another process already made", () => {
    const l = layout();
    profile(l.old);
    const raced = { ...fs, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      fs.renameSync(from, to);
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    } };
    expect(run(l, { fs: raced })).toMatchObject({ dir: l.target });
    expect(exists(path.join(l.target, SESSION_MOVED_MARKER))).toBe(true);
    expect(exists(path.join(l.target, "Cookies"))).toBe(true);
  });

  it("keeps a SQLite database coherent with its WAL sidecars", () => {
    const l = layout();
    fs.mkdirSync(path.join(l.old, "WebStorage"), { recursive: true });
    const file = path.join(l.old, "SharedStorage");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('current');");
    db.exec("PRAGMA wal_autocheckpoint=0; UPDATE t SET v = 'latest';");
    expect(exists(`${file}-wal`)).toBe(true);
    // Copy the files as a closed process would leave them, then move.
    const closed = path.join(l.root, "closed");
    fs.mkdirSync(closed);
    for (const name of fs.readdirSync(l.old)) fs.cpSync(path.join(l.old, name), path.join(closed, name), { recursive: true });
    db.close();
    fs.rmSync(l.old, { recursive: true });
    fs.renameSync(closed, l.old);
    expect(run(l).outcome).toBe("moved");
    const reopened = new DatabaseSync(path.join(l.target, "SharedStorage"));
    expect(reopened.prepare("SELECT v FROM t").get()).toEqual({ v: "latest" });
    reopened.close();
  });

  it("moves Stable's older design.zeros.app profile when it is the only one", () => {
    const l = layout();
    const older = path.join(l.root, "Caches", "design.zeros.app");
    profile(older);
    expect(chooseSessionDataDir({ target: l.target, old: older, userDataDir: l.dataDir, log: () => {} }).outcome).toBe("moved");
    expect(fs.readFileSync(path.join(l.target, "Cookies"), "utf8")).toBe("cookie-db");
  });
});
