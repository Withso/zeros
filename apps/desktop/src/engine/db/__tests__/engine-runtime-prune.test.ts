import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENGINE_BUSY_FRESH_MS,
  ENGINE_RUNTIME_STALE_MS,
  profileOwnedByParent,
  pruneEngineRuntimeDirs,
} from "../engine-runtime-prune";
import { repoKey } from "../paths";

const roots: string[] = [];
function scratch() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zeros-engines-")));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const DEAD = 2 ** 22 + 4321;
const DAY = 24 * 60 * 60 * 1000;
const exists = (file: string) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

function fixture() {
  const home = scratch(), dataDir = path.join(home, "data"), engines = path.join(dataDir, "engines");
  fs.mkdirSync(engines, { recursive: true });
  const old = new Date(Date.now() - ENGINE_RUNTIME_STALE_MS - DAY);
  const entry = (name: string, { manifest, busy, mtime }: { manifest?: Record<string, unknown> | string; busy?: Date; mtime?: Date } = {}) => {
    const dir = path.join(engines, name);
    fs.mkdirSync(dir);
    if (manifest !== undefined)
      fs.writeFileSync(path.join(dir, "engine.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    if (busy) {
      fs.writeFileSync(path.join(dir, "busy"), "1");
      fs.utimesSync(path.join(dir, "busy"), busy, busy);
    }
    if (mtime) {
      for (const file of fs.readdirSync(dir)) if (file !== "busy") fs.utimesSync(path.join(dir, file), mtime, mtime);
      fs.utimesSync(dir, mtime, mtime);
    }
    return dir;
  };
  return { home, dataDir, engines, old, entry, own: path.join(home, "current-repo") };
}
const run = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) =>
  pruneEngineRuntimeDirs({ dataDir: f.dataDir, ownRoot: f.own, profileOwned: () => true, ...extra });

describe("engine runtime prune", () => {
  it("removes an entry whose recorded root is gone and keeps one whose root exists", async () => {
    const f = fixture();
    const present = path.join(f.home, "present");
    fs.mkdirSync(present);
    const gone = f.entry("gone-aaaaaaaaaaaa", { manifest: { pid: DEAD, root: path.join(f.home, "deleted") } });
    const kept = f.entry("present-bbbbbbbbbbbb", { manifest: { pid: DEAD, root: present }, mtime: f.old });
    const result = await run(f);
    expect(result.status).toBe("done");
    expect(exists(gone)).toBe(false);
    expect(exists(kept)).toBe(true);
  });

  it("removes an old entry with no recorded root, keeps a recent one", async () => {
    const f = fixture();
    const oldEmpty = f.entry("worktree-cccccccccccc", { mtime: f.old });
    const recent = f.entry("worktree-dddddddddddd", { mtime: new Date(Date.now() - DAY) });
    await run(f);
    expect(exists(oldEmpty)).toBe(false);
    expect(exists(recent)).toBe(true);
  });

  it("never touches a live engine, its own entry, a fresh heartbeat, or an unparsable manifest", async () => {
    const f = fixture();
    const live = f.entry("live-eeeeeeeeeeee", { manifest: { pid: process.pid, root: path.join(f.home, "deleted") }, mtime: f.old });
    const own = f.entry(repoKey(f.own), { mtime: f.old });
    const busy = f.entry("busy-ffffffffffff", { manifest: { pid: DEAD, root: path.join(f.home, "deleted") }, busy: new Date(Date.now() - ENGINE_BUSY_FRESH_MS / 2) });
    const torn = f.entry("torn-111111111111", { manifest: "{not json", mtime: f.old });
    const result = await run(f);
    expect(result.removed).toEqual([]);
    for (const dir of [live, own, busy, torn]) expect(exists(dir), dir).toBe(true);
  });

  it("refuses symlinked entries and a symlinked store, and never follows them", async () => {
    const f = fixture(), outside = scratch();
    fs.mkdirSync(path.join(outside, "victim-222222222222"));
    fs.writeFileSync(path.join(outside, "victim-222222222222", "keep"), "x");
    const link = path.join(f.engines, "linked-333333333333");
    fs.symlinkSync(path.join(outside, "victim-222222222222"), link);
    fs.utimesSync(path.join(outside, "victim-222222222222"), f.old, f.old);
    fs.utimesSync(path.join(outside, "victim-222222222222", "keep"), f.old, f.old);
    fs.lutimesSync(link, f.old, f.old);
    await run(f);
    expect(exists(link)).toBe(true);
    expect(exists(path.join(outside, "victim-222222222222", "keep"))).toBe(true);

    const g = fixture();
    fs.rmSync(g.engines, { recursive: true });
    fs.mkdirSync(path.join(outside, "elsewhere-444444444444"));
    fs.utimesSync(path.join(outside, "elsewhere-444444444444"), g.old, g.old);
    fs.symlinkSync(outside, g.engines);
    expect((await run(g)).status).toBe("refused");
    expect(exists(path.join(outside, "elsewhere-444444444444"))).toBe(true);
  });

  it("skips entries that are not engine keys or cannot be read, and continues with the rest", async () => {
    const f = fixture();
    const stranger = path.join(f.engines, "Not An Engine");
    fs.mkdirSync(stranger);
    fs.utimesSync(stranger, f.old, f.old);
    // Permission bits are not enforced in every CI sandbox; a manifest that is
    // not a regular file is unreadable everywhere.
    const notAFile = f.entry("locked-555555555555", { mtime: f.old });
    fs.mkdirSync(path.join(notAFile, "engine.json"));
    const fifo = f.entry("fifo-888888888888", { mtime: f.old });
    execFileSync("mkfifo", [path.join(fifo, "engine.json")]);
    const removable = f.entry("gone-666666666666", { manifest: { pid: DEAD, root: path.join(f.home, "deleted") } });
    const result = await run(f);
    expect(exists(stranger)).toBe(true);
    expect(exists(removable)).toBe(false);
    expect(exists(path.join(notAFile, "engine.json"))).toBe(true);
    expect(exists(path.join(fifo, "engine.json"))).toBe(true);
    expect(result.status).toBe("done");
  });

  it("stops cleanly at its count and time budgets", async () => {
    const f = fixture();
    for (let i = 0; i < 6; i++) f.entry(`worktree-${String(i).repeat(12)}`, { mtime: f.old });
    const counted = await run(f, { maxRemovals: 2 });
    expect(counted.status).toBe("budget");
    expect(counted.removed).toHaveLength(2);
    let now = 0;
    const timed = await run(f, { budgetMs: 10, clock: () => (now += 6) });
    expect(timed.status).toBe("budget");
    expect(fs.readdirSync(f.engines).length).toBeGreaterThan(0);
    const controller = new AbortController();
    controller.abort();
    expect((await run(f, { signal: controller.signal })).removed).toEqual([]);
  });

  it("does nothing when the profile's single-instance owner cannot be established", async () => {
    const f = fixture();
    const gone = f.entry("gone-777777777777", { manifest: { pid: DEAD, root: path.join(f.home, "deleted") } });
    expect((await pruneEngineRuntimeDirs({ dataDir: f.dataDir, ownRoot: f.own, profileOwned: () => false })).status).toBe("skipped");
    expect(exists(gone)).toBe(true);
  });

  it("leaves design-storage and git-promotion-journal alone, however old", async () => {
    const f = fixture();
    const siblings = ["design-storage/0123456789abcdef0123456789abcdef/metadata-aa.json", "git-promotion-journal/entry.json"]
      .map((relative) => path.join(f.dataDir, relative));
    for (const file of siblings) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{}");
      fs.utimesSync(file, f.old, f.old);
      fs.utimesSync(path.dirname(file), f.old, f.old);
    }
    f.entry("gone-999999999999", { manifest: { pid: DEAD, root: path.join(f.home, "deleted") } });
    await run(f);
    for (const file of siblings) expect(exists(file), file).toBe(true);
  });

  it("never throws, even when the store is missing", async () => {
    const f = fixture();
    fs.rmSync(f.engines, { recursive: true });
    await expect(run(f)).resolves.toMatchObject({ status: "done", removed: [] });
  });
});

describe("engine runtime prune at the owner's profile size", () => {
  // The owner's Production profile: 1,248 entries, most for roots that are gone.
  function ownerSized() {
    const f = fixture();
    for (let i = 0; i < 1_248; i++) {
      const name = `worktree-${i.toString(16).padStart(12, "0")}`;
      if (i < 800) f.entry(name, { manifest: { pid: DEAD, root: path.join(f.home, "deleted", String(i)), port: 1 } });
      else if (i < 1_100) f.entry(name, { mtime: f.old });
      else f.entry(name, { mtime: new Date() });
    }
    return f;
  }

  it("makes no sync filesystem call", async () => {
    const f = ownerSized();
    const spies = ["lstatSync", "statSync", "readdirSync", "rmSync", "openSync", "readFileSync", "fstatSync", "readlinkSync"]
      .map((name) => vi.spyOn(fs, name as "lstatSync"));
    const result = await run(f);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(result.removed).toHaveLength(200);
  });

  it("keeps the event loop responsive while it drains the profile over several launches", async () => {
    const f = ownerSized();
    const delay = monitorEventLoopDelay({ resolution: 1 });
    const runs: string[] = [];
    let removed = 0;
    delay.enable();
    const started = performance.now();
    for (let launch = 0; launch < 10; launch++) {
      const result = await pruneEngineRuntimeDirs({ dataDir: f.dataDir, ownRoot: f.own, profileOwned: () => true });
      removed += result.removed.length;
      runs.push(result.status);
      if (result.status === "done") break;
    }
    const elapsed = performance.now() - started;
    delay.disable();
    const ms = (ns: number) => Math.round(ns / 1e4) / 100;
    const measured = { p50: ms(delay.percentile(50)), p99: ms(delay.percentile(99)), max: ms(delay.max), runs: runs.length, elapsedMs: Math.round(elapsed) };
    console.log(`[engine-runtime-prune] event-loop delay ${JSON.stringify(measured)}`);
    expect(removed).toBe(1_100);
    expect(runs.at(-1)).toBe("done");
    expect(fs.readdirSync(f.engines)).toHaveLength(148);
    expect(measured.max).toBeLessThan(50);
  }, 60_000);
});

describe("profile ownership", () => {
  it("is established only by the parent Electron's SingletonLock", async () => {
    const dataDir = scratch();
    const env = { ZEROS_PARENT_PID: "4242" };
    expect(await profileOwnedByParent({ dataDir, env, ppid: 4242, alive: () => true })).toBe(false);
    fs.symlinkSync("mac.local-4242", path.join(dataDir, "SingletonLock"));
    expect(await profileOwnedByParent({ dataDir, env, ppid: 4242, alive: () => true })).toBe(true);
    expect(await profileOwnedByParent({ dataDir, env, ppid: 1, alive: () => true })).toBe(false);
    expect(await profileOwnedByParent({ dataDir, env: {}, ppid: 4242, alive: () => true })).toBe(false);
    expect(await profileOwnedByParent({ dataDir, env, ppid: 4242, alive: () => false })).toBe(false);
    fs.rmSync(path.join(dataDir, "SingletonLock"));
    fs.symlinkSync("mac.local-9999", path.join(dataDir, "SingletonLock"));
    expect(await profileOwnedByParent({ dataDir, env, ppid: 4242, alive: () => true })).toBe(false);
  });
});
