import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  chooseRendererProfile,
  RENDERER_PROFILE_MARKER,
  type RendererProfileFs,
} from "../renderer-profile-location";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) nodeFs.rmSync(root, { recursive: true, force: true });
});

function layout() {
  const home = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), "zeros-renderer-profile-")));
  roots.push(home);
  const userData = path.join(home, "Library", "Application Support", "com.zeros");
  const caches = path.join(home, "Library", "Caches");
  nodeFs.mkdirSync(userData, { recursive: true });
  nodeFs.mkdirSync(caches, { recursive: true });
  return {
    home,
    userData,
    cache: path.join(caches, "com.zeros"),
    data: path.join(userData, "electron"),
    hop: path.join(caches, "design.zeros.app"),
  };
}
type Layout = ReturnType<typeof layout>;

function seedProfile(dir: string, draft = "draft") {
  nodeFs.mkdirSync(path.join(dir, "Local Storage", "leveldb"), { recursive: true });
  nodeFs.writeFileSync(path.join(dir, "Local Storage", "leveldb", "000003.log"), draft);
  nodeFs.mkdirSync(path.join(dir, "GPUCache"), { recursive: true });
  nodeFs.writeFileSync(path.join(dir, "GPUCache", "data_0"), "shader");
  nodeFs.writeFileSync(path.join(dir, ".zeros-session-migrated"), "older hop done");
}
const draftIn = (dir: string) => nodeFs.readFileSync(path.join(dir, "Local Storage", "leveldb", "000003.log"), "utf8");
const marked = (l: Layout) => nodeFs.existsSync(path.join(l.data, RENDERER_PROFILE_MARKER));

/** Every fs call the chooser makes, in order, through the real filesystem
 *  unless a test overrides one. */
function recordingFs(overrides: Partial<Record<keyof RendererProfileFs, (...args: never[]) => unknown>> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const fs = new Proxy(nodeFs, {
    get(target, name: string) {
      const real = (overrides as Record<string, unknown>)[name] ?? Reflect.get(target, name);
      if (typeof real !== "function") return real;
      return (...args: unknown[]) => {
        calls.push({ name, args });
        return (real as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as RendererProfileFs;
  return { fs, calls };
}
/** Where a process without the lock runs; the chooser only names it. */
const throwaway = (l: Layout) => path.join(l.home, "tmp", "zeros-second-instance-x");
const MUTATING = new Set(["renameSync", "mkdirSync", "writeFileSync", "rmSync", "rmdirSync", "unlinkSync", "cpSync", "copyFileSync", "symlinkSync", "linkSync", "truncateSync", "appendFileSync", "chmodSync", "utimesSync"]);

function choose(l: Layout, { lock = true, fs }: { lock?: boolean; fs?: RendererProfileFs } = {}) {
  const recorder = fs ? { fs, calls: [] } : recordingFs();
  const logs: string[] = [];
  let lockCalls = 0;
  const choice = chooseRendererProfile({
    cacheProfile: l.cache,
    dataProfile: l.data,
    olderHopSource: l.hop,
    holdsLock: () => {
      lockCalls++;
      return lock;
    },
    throwawayProfile: () => throwaway(l),
    fs: recorder.fs,
    log: (line) => logs.push(line),
  });
  const mutations = recorder.calls.filter((call) => MUTATING.has(call.name));
  return { choice, logs, lockCalls, calls: recorder.calls, mutations };
}

/** Only one rename of the whole profile, mkdir and one exclusive marker write
 *  may ever occur. */
function expectOnlyAllowedMutations(l: Layout, mutations: { name: string; args: unknown[] }[]) {
  for (const { name, args } of mutations) {
    if (name === "renameSync") expect(args).toEqual([l.cache, l.data]);
    else if (name === "writeFileSync") {
      expect(args[0]).toBe(path.join(l.data, RENDERER_PROFILE_MARKER));
      expect((args[2] as { flag?: string }).flag).toBe("wx");
    } else expect(name).toBe("mkdirSync");
  }
  expect(mutations.filter((call) => call.name === "renameSync").length).toBeLessThanOrEqual(1);
  expect(mutations.filter((call) => call.name === "writeFileSync").length).toBeLessThanOrEqual(1);
}

function statWith(stat: nodeFs.Stats, patch: Partial<nodeFs.Stats>): nodeFs.Stats {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, patch);
}
const fail = (code: string) => {
  throw Object.assign(new Error(code), { code });
};

describe("renderer profile location", () => {
  it("moves a closed profile from Caches in one rename and marks it", () => {
    const l = layout();
    seedProfile(l.cache);
    const { choice, mutations, lockCalls } = choose(l);
    expect(choice).toEqual({ dir: l.data, outcome: "moved" });
    expect(lockCalls).toBe(1);
    expect(nodeFs.existsSync(l.cache)).toBe(false);
    expect(draftIn(l.data)).toBe("draft");
    expect(nodeFs.readFileSync(path.join(l.data, "GPUCache", "data_0"), "utf8")).toBe("shader");
    expect(marked(l)).toBe(true);
    expect(mutations.map((call) => call.name)).toEqual(["renameSync", "writeFileSync"]);
    expectOnlyAllowedMutations(l, mutations);
  });

  it("moves into an empty real data folder", () => {
    const l = layout();
    seedProfile(l.cache);
    nodeFs.mkdirSync(l.data);
    expect(choose(l).choice.outcome).toBe("moved");
    expect(draftIn(l.data)).toBe("draft");
  });

  it("reopens a marked profile with one lock request, two lstat calls and no writes", () => {
    const l = layout();
    seedProfile(l.cache);
    choose(l);
    const { choice, calls, lockCalls } = choose(l);
    expect(choice).toEqual({ dir: l.data, outcome: "marked" });
    expect(calls.map((call) => call.name)).toEqual(["lstatSync", "lstatSync"]);
    expect(lockCalls).toBe(1);
  });

  it("converges after a crash between the rename and the marker", () => {
    const l = layout();
    seedProfile(l.cache);
    nodeFs.renameSync(l.cache, l.data);
    const { choice, mutations } = choose(l);
    expect(choice).toEqual({ dir: l.data, outcome: "repaired" });
    expect(mutations.map((call) => call.name)).toEqual(["writeFileSync"]);
    expect(marked(l)).toBe(true);
    expect(choose(l).choice.outcome).toBe("marked");
  });

  it("converges after a crash before the rename: the profile is still whole in Caches", () => {
    const l = layout();
    seedProfile(l.cache);
    // A crash here leaves at most the data folder's parent created.
    expect(choose(l, { lock: false }).choice).toEqual({ dir: throwaway(l), outcome: "unlocked" });
    expect(choose(l).choice.outcome).toBe("moved");
    expect(draftIn(l.data)).toBe("draft");
  });

  it("keeps a marker write failure recoverable on the next launch", () => {
    const l = layout();
    seedProfile(l.cache);
    const { fs } = recordingFs({ writeFileSync: () => fail("EIO") });
    const first = choose(l, { fs });
    expect(first.choice.outcome).toBe("moved");
    expect(first.logs.join("\n")).toMatch(/marker not written \(EIO\)/);
    expect(choose(l).choice.outcome).toBe("repaired");
  });

  it("creates a marked empty profile when neither location exists", () => {
    const l = layout();
    const { choice, mutations } = choose(l);
    expect(choice).toEqual({ dir: l.data, outcome: "created" });
    expect(nodeFs.readdirSync(l.data)).toEqual([RENDERER_PROFILE_MARKER]);
    expect(nodeFs.existsSync(l.cache)).toBe(false);
    expectOnlyAllowedMutations(l, mutations);
  });

  it("treats an empty unmarked data folder with no Caches profile as neither", () => {
    const l = layout();
    nodeFs.mkdirSync(l.data);
    expect(choose(l).choice.outcome).toBe("created");
  });

  it("keeps main's path while the older design.zeros.app hop is pending and nothing exists", () => {
    const l = layout();
    seedProfile(l.hop);
    const { choice, mutations } = choose(l);
    expect(choice).toMatchObject({ dir: null, outcome: "kept", reason: expect.stringMatching(/older design\.zeros\.app hop/) });
    expect(mutations).toEqual([]);
    expect(nodeFs.existsSync(l.data)).toBe(false);
  });

  it("keeps main's path while the older hop is still pending into an existing Caches profile", () => {
    const l = layout();
    seedProfile(l.hop);
    nodeFs.mkdirSync(path.join(l.cache, "GPUCache"), { recursive: true });
    expect(choose(l).choice.outcome).toBe("kept");
    expect(nodeFs.existsSync(l.cache)).toBe(true);
    nodeFs.writeFileSync(path.join(l.cache, ".zeros-session-migrated"), "done");
    expect(choose(l).choice.outcome).toBe("moved");
  });

  it("keeps main's userData fallback profile visible", () => {
    const l = layout();
    nodeFs.mkdirSync(path.join(l.userData, "Local Storage"));
    const { choice, mutations } = choose(l);
    expect(choice).toMatchObject({ dir: null, outcome: "kept", reason: expect.stringMatching(/userData holds a renderer profile/) });
    expect(mutations).toEqual([]);
  });

  it("is ambiguous when Caches and a filled unmarked data folder both exist", () => {
    const l = layout();
    seedProfile(l.cache, "cache");
    seedProfile(l.data, "data");
    const { choice, mutations, logs } = choose(l);
    expect(choice).toMatchObject({ dir: null, outcome: "kept" });
    expect(mutations).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(draftIn(l.cache)).toBe("cache");
    expect(draftIn(l.data)).toBe("data");
  });

  it("leaves a Caches profile recreated by an older build alone once the data folder is marked", () => {
    const l = layout();
    seedProfile(l.cache, "before downgrade");
    choose(l);
    seedProfile(l.cache, "older build");
    const { choice, mutations } = choose(l);
    expect(choice.outcome).toBe("marked");
    expect(mutations).toEqual([]);
    expect(draftIn(l.cache)).toBe("older build");
    expect(draftIn(l.data)).toBe("before downgrade");
  });

  it("looks again after taking the lock: a previous holder may have just finished the move", () => {
    const l = layout();
    seedProfile(l.cache, "moved by the previous holder");
    const logs: string[] = [];
    const choice = chooseRendererProfile({
      cacheProfile: l.cache,
      dataProfile: l.data,
      olderHopSource: l.hop,
      holdsLock: () => {
        nodeFs.renameSync(l.cache, l.data);
        nodeFs.writeFileSync(path.join(l.data, RENDERER_PROFILE_MARKER), "x");
        seedProfile(l.cache, "recreated by an older build");
        return true;
      },
      throwawayProfile: () => throwaway(l),
      log: (line) => logs.push(line),
    });
    expect(choice).toEqual({ dir: l.data, outcome: "marked" });
    expect(logs).toEqual([]);
    expect(draftIn(l.data)).toBe("moved by the previous holder");
  });

  // Electron can grant the lock to two processes started together: a process
  // that reads the first one's SingletonLock before its socket exists treats it
  // as orphaned (IsChromeProcess fails on the app's executable name) and takes
  // the lock too. The rename arbitrates; the other must join E, never recreate C.
  describe("when two processes both hold the lock", () => {
    const peerMoves = (l: Layout) => {
      nodeFs.renameSync(l.cache, l.data);
      nodeFs.writeFileSync(path.join(l.data, RENDERER_PROFILE_MARKER), "peer");
    };
    const interleavings: [string, (l: Layout) => Partial<Record<keyof RendererProfileFs, (...args: never[]) => unknown>>][] = [
      ["before the listing", (l) => ({ readdirSync: ((dir: string, options: never) => (dir === l.cache && peerMoves(l), nodeFs.readdirSync(dir, options))) as never })],
      ["before the rename", (l) => ({ renameSync: ((from: string, to: string) => (peerMoves(l), nodeFs.renameSync(from, to))) as never })],
      ["before the older-hop check", (l) => ({ existsSync: ((file: string) => (file.startsWith(l.cache) && nodeFs.existsSync(l.cache) && peerMoves(l), nodeFs.existsSync(file))) as never })],
      ["between looking at E and at C", (l) => {
        let first = true;
        return { lstatSync: ((file: string) => (file === l.cache && first && ((first = false), peerMoves(l)), nodeFs.lstatSync(file))) as never };
      }],
    ];
    it.each(interleavings)("joins the peer's moved profile when it moves %s", (_name, overrides) => {
      const l = layout();
      seedProfile(l.cache, "the one profile");
      seedProfile(l.hop, "older hop source");
      nodeFs.rmSync(path.join(l.hop, ".zeros-session-migrated"));
      const { fs } = recordingFs(overrides(l));
      const { choice, mutations } = choose(l, { fs });
      expect(choice.dir).toBe(l.data);
      expect(nodeFs.existsSync(l.cache)).toBe(false);
      expect(draftIn(l.data)).toBe("the one profile");
      expect(marked(l)).toBe(true);
      expect(mutations.filter((call) => call.name === "renameSync" && !nodeFs.existsSync(l.cache)).length).toBeLessThanOrEqual(1);
    });
  });

  describe("without the single-instance lock", () => {
    // The losing process still reaches `ready` before it quits, and its Chromium
    // writes into whatever sessionData it was given: that must be neither C nor E.
    const states: [string, (l: Layout) => void][] = [
      ["a Caches profile", (l) => seedProfile(l.cache)],
      ["a marked data folder", (l) => (seedProfile(l.data), nodeFs.writeFileSync(path.join(l.data, RENDERER_PROFILE_MARKER), "x"))],
      ["a moved but unmarked data folder", (l) => seedProfile(l.data)],
      ["neither", () => {}],
      ["a regular file at the Caches path", (l) => nodeFs.writeFileSync(l.cache, "not a folder")],
      ["both, ambiguous", (l) => (seedProfile(l.cache), seedProfile(l.data))],
    ];
    it.each(states)("runs on a throwaway folder with %s, touching nothing", (_name, prepare) => {
      const l = layout();
      prepare(l);
      const before = [nodeFs.existsSync(l.cache), nodeFs.existsSync(l.data), marked(l)];
      const { choice, calls, lockCalls } = choose(l, { lock: false });
      expect(choice).toEqual({ dir: throwaway(l), outcome: "unlocked" });
      expect(lockCalls).toBe(1);
      expect(calls).toEqual([]);
      expect([nodeFs.existsSync(l.cache), nodeFs.existsSync(l.data), marked(l)]).toEqual(before);
      expect(nodeFs.existsSync(throwaway(l))).toBe(false);
    });

    it("lets only the process holding the lock move, whichever starts first", () => {
      const l = layout();
      seedProfile(l.cache);
      const loser = choose(l, { lock: false });
      const winner = choose(l, { lock: true });
      expect([loser.choice.outcome, winner.choice.outcome]).toEqual(["unlocked", "moved"]);
      expect(loser.calls).toEqual([]);
      expect(choose(l, { lock: false }).choice).toEqual({ dir: throwaway(l), outcome: "unlocked" });
      expect(choose(l).choice).toEqual({ dir: l.data, outcome: "marked" });
    });
  });

  describe("checks before the move fail closed", () => {
    it("keeps Caches when it is on a different volume", () => {
      const l = layout();
      seedProfile(l.cache);
      const { fs } = recordingFs({
        lstatSync: ((file: string) => {
          const stat = nodeFs.lstatSync(file);
          return file === l.cache ? statWith(stat, { dev: stat.dev + 1 }) : stat;
        }) as never,
      });
      const { choice, mutations } = choose(l, { fs });
      expect(choice).toMatchObject({ outcome: "kept", reason: expect.stringMatching(/different volume/) });
      expect(mutations).toEqual([]);
      expect(draftIn(l.cache)).toBe("draft");
    });

    it("keeps Caches when the rename reports EXDEV", () => {
      const l = layout();
      seedProfile(l.cache);
      const { fs } = recordingFs({ renameSync: () => fail("EXDEV") });
      expect(choose(l, { fs }).choice).toMatchObject({ outcome: "kept", reason: expect.stringMatching(/EXDEV/) });
      expect(draftIn(l.cache)).toBe("draft");
      expect(nodeFs.existsSync(l.data)).toBe(false);
    });

    it("recognises a rename that happened although it reported an error", () => {
      const l = layout();
      seedProfile(l.cache);
      const { fs } = recordingFs({
        renameSync: ((from: string, to: string) => {
          nodeFs.renameSync(from, to);
          fail("EIO");
        }) as never,
      });
      // Whether this process or a peer renamed it, the profile is now E.
      expect(choose(l, { fs }).choice).toEqual({ dir: l.data, outcome: "joined" });
      expect(marked(l)).toBe(true);
    });

    it("keeps Caches when it is a symlink", () => {
      const l = layout();
      const real = path.join(l.home, "elsewhere");
      seedProfile(real);
      nodeFs.symlinkSync(real, l.cache);
      const { choice, mutations } = choose(l);
      expect(choice).toMatchObject({ outcome: "kept", reason: expect.stringMatching(/not a real folder/) });
      expect(mutations).toEqual([]);
    });

    it("never opens or marks a data folder that is a symlink to another profile", () => {
      const l = layout();
      seedProfile(l.cache, "mine");
      const other = path.join(l.home, "other-profile");
      seedProfile(other, "other");
      nodeFs.writeFileSync(path.join(other, RENDERER_PROFILE_MARKER), "x");
      nodeFs.symlinkSync(other, l.data);
      expect(choose(l).choice).toMatchObject({ dir: null, outcome: "kept" });
      expect(choose(l, { lock: false }).choice).toEqual({ dir: throwaway(l), outcome: "unlocked" });
      nodeFs.rmSync(l.cache, { recursive: true });
      const fresh = choose(l);
      expect(fresh.choice).toMatchObject({ dir: null, outcome: "kept" });
      expect(fresh.mutations).toEqual([]);
      expect(draftIn(other)).toBe("other");
    });

    it("keeps Caches when an ancestor of either location is a symlink", () => {
      for (const linked of ["Caches", "Application Support"]) {
        const l = layout();
        const library = path.join(l.home, "Library");
        const moved = path.join(l.home, `real-${linked.replace(" ", "-")}`);
        nodeFs.renameSync(path.join(library, linked), moved);
        nodeFs.symlinkSync(moved, path.join(library, linked));
        seedProfile(l.cache);
        const { choice, mutations } = choose(l);
        expect(choice).toMatchObject({ outcome: "kept", reason: expect.stringMatching(/symlink/) });
        expect(mutations).toEqual([]);
      }
    });

    it("keeps Caches when a top-level entry is a symlink", () => {
      const l = layout();
      seedProfile(l.cache);
      nodeFs.mkdirSync(path.join(l.home, "offloaded"));
      nodeFs.symlinkSync("../../offloaded", path.join(l.cache, "IndexedDB"));
      const { choice, mutations } = choose(l);
      expect(choice).toMatchObject({ outcome: "kept", reason: expect.stringMatching(/links to a store outside/) });
      expect(mutations).toEqual([]);
    });

    it("keeps Caches when the data folder is a file", () => {
      const l = layout();
      seedProfile(l.cache);
      nodeFs.writeFileSync(l.data, "not a folder");
      expect(choose(l).choice).toMatchObject({ outcome: "kept", reason: expect.stringMatching(/not a folder/) });
      expect(nodeFs.readFileSync(l.data, "utf8")).toBe("not a folder");
      nodeFs.rmSync(l.cache, { recursive: true });
      expect(choose(l).choice).toMatchObject({ dir: null, outcome: "kept" });
    });

    it("never treats an unreadable location as missing", () => {
      for (const target of ["cache", "data"] as const) {
        const l = layout();
        seedProfile(l.cache);
        seedProfile(path.join(l.home, "unused"));
        const { fs } = recordingFs({
          lstatSync: ((file: string) => (file === l[target] ? fail("EIO") : nodeFs.lstatSync(file))) as never,
        });
        const { choice, mutations } = choose(l, { fs });
        expect(choice).toMatchObject({ dir: null, outcome: "kept" });
        expect(mutations).toEqual([]);
      }
    });

    it("keeps Caches when the two locations overlap", () => {
      const l = layout();
      seedProfile(l.cache);
      const inside = { ...l, data: path.join(l.cache, "electron") };
      expect(choose(inside).choice).toMatchObject({ outcome: "kept" });
      expect(draftIn(l.cache)).toBe("draft");
    });

    it("runs the profile listing last and only once", () => {
      const l = layout();
      seedProfile(l.cache);
      const { calls } = choose(l);
      const listings = calls.filter((call) => call.name === "readdirSync");
      expect(listings).toHaveLength(1);
      expect(listings[0].args[0]).toBe(l.cache);
      expect(calls.findIndex((call) => call.name === "readdirSync")).toBe(calls.findIndex((call) => call.name === "renameSync") - 1);
    });
  });

  it("keeps a constant number of calls per refused launch, independent of the profile size", () => {
    const counts = [10, 2000].map((entries) => {
      const l = layout();
      seedProfile(l.cache);
      for (let i = 0; i < entries; i++) nodeFs.writeFileSync(path.join(l.cache, `entry-${i}`), "");
      nodeFs.symlinkSync("GPUCache", path.join(l.cache, "zz-link"));
      return [choose(l).calls.length, choose(l).calls.length];
    });
    expect(counts[0]).toEqual(counts[1]);
    expect(counts[0][0]).toBe(counts[0][1]);
  });

  it("moves a real SQLite database with its WAL sidecars intact", () => {
    const l = layout();
    seedProfile(l.cache);
    const live = path.join(l.home, "live");
    nodeFs.mkdirSync(live);
    const db = new Database(path.join(live, "Cookies"));
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.exec("CREATE TABLE cookies(name TEXT, value TEXT)");
    db.exec("INSERT INTO cookies VALUES ('session', 'committed-in-wal')");
    // A closed profile can carry uncheckpointed sidecars after a crash.
    for (const suffix of ["", "-wal", "-shm"]) nodeFs.copyFileSync(path.join(live, `Cookies${suffix}`), path.join(l.cache, `Cookies${suffix}`));
    db.close();
    expect(nodeFs.statSync(path.join(l.cache, "Cookies-wal")).size).toBeGreaterThan(0);
    expect(choose(l).choice.outcome).toBe("moved");
    for (const suffix of ["", "-wal", "-shm"]) expect(nodeFs.existsSync(path.join(l.data, `Cookies${suffix}`))).toBe(true);
    const moved = new Database(path.join(l.data, "Cookies"));
    expect(moved.prepare("SELECT value FROM cookies").all()).toEqual([{ value: "committed-in-wal" }]);
    expect(moved.pragma("integrity_check", { simple: true })).toBe("ok");
    moved.close();
  });

  it("only ever renames the profile, creates folders and writes one exclusive marker", () => {
    const states: ((l: Layout) => void)[] = [
      (l) => seedProfile(l.cache),
      () => {},
      (l) => seedProfile(l.data),
      (l) => (seedProfile(l.cache), seedProfile(l.data)),
      (l) => (seedProfile(l.cache), nodeFs.writeFileSync(l.data, "")),
      (l) => (seedProfile(l.cache), nodeFs.symlinkSync("GPUCache", path.join(l.cache, "x"))),
      (l) => seedProfile(l.hop),
      (l) => nodeFs.mkdirSync(path.join(l.userData, "IndexedDB")),
    ];
    for (const prepare of states)
      for (const lock of [true, false]) {
        const l = layout();
        prepare(l);
        const first = choose(l, { lock });
        expectOnlyAllowedMutations(l, first.mutations);
        if (!lock) expect(first.calls).toEqual([]);
        expectOnlyAllowedMutations(l, choose(l, { lock }).mutations);
      }
  });
});
